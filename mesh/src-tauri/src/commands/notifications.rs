use std::{
    collections::{HashMap, HashSet},
    sync::RwLock,
};

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image, plugin::PermissionState, tray::TrayIconBuilder, App, AppHandle, Emitter, Manager,
    State, WebviewWindow,
};
use tauri_plugin_notification::NotificationExt;

use crate::backend::{
    MatrixBackendEvent, MatrixNotification, MatrixUnreadUpdate, NotificationPresentationContext,
    MATRIX_IGNORED_USERS_CHANGED_EVENT, MATRIX_NOTIFICATION_EVENT,
    MATRIX_PERMISSION_STATE_CHANGED_EVENT, MATRIX_QUEUED_MESSAGE_EVENT, MATRIX_ROOM_PINS_EVENT,
    MATRIX_RTC_MEDIA_KEY_EVENT, MATRIX_RTC_MEDIA_KEY_FAILURE_EVENT,
    MATRIX_RTC_MEDIA_KEY_PAUSE_EVENT, MATRIX_RTC_MEMBERSHIP_EVENT, MATRIX_UNREAD_UPDATE_EVENT,
};
use crate::state::{native_requests::NativeAccountMutationGuard, AppState};

use super::error::CommandError;

const TRAY_ID: &str = "mesh-main";
const MAX_NOTIFICATION_SENDER_CHARS: usize = 80;
const MAX_NOTIFICATION_PREVIEW_CHARS: usize = 180;
const PRIVATE_NOTIFICATION_BODY: &str = "New message";

#[derive(Debug, Clone, Copy, Default)]
struct UnreadSnapshot {
    messages: u64,
    mentions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAccountScope {
    pub account_generation: u64,
    pub user_id: String,
}

#[derive(Default)]
struct NotificationRuntime {
    scope: Option<NotificationAccountScope>,
    context: NotificationPresentationContext,
    unread_by_room: HashMap<String, UnreadSnapshot>,
}

impl NotificationPresentationContext {
    fn normalized(mut self) -> Self {
        self.muted_room_ids.sort();
        self.muted_room_ids.dedup();
        self
    }

    fn presentation_enabled(&self) -> bool {
        self.notifications_enabled && !self.do_not_disturb && !self.quiet_hours_active
    }

    fn is_room_muted(&self, room_id: &str) -> bool {
        self.muted_room_ids
            .binary_search_by(|candidate| candidate.as_str().cmp(room_id))
            .is_ok()
    }
}

#[derive(Default)]
pub struct NotificationRuntimeState {
    // The derived context starts with notifications_enabled=false. This is
    // intentional: presentation stays fail-closed until persisted settings
    // are restored through `set_notification_context`.
    runtime: RwLock<NotificationRuntime>,
}

impl NotificationRuntimeState {
    fn close_and_invalidate<T, E>(
        &self,
        close_account_admission: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        let mut runtime = self
            .runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let transition = close_account_admission()?;
        *runtime = NotificationRuntime::default();
        Ok(transition)
    }

    fn commit_context<R>(
        &self,
        scope: NotificationAccountScope,
        context: NotificationPresentationContext,
        current_generation: impl FnOnce() -> u64,
        publish: impl FnOnce(u64) -> R,
    ) -> Option<R> {
        let mut runtime = self
            .runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current_generation() != scope.account_generation {
            return None;
        }
        if runtime.scope.as_ref() != Some(&scope) {
            runtime.unread_by_room.clear();
        }
        runtime.scope = Some(scope);
        runtime.context = context.normalized();
        let unread = Self::visible_unread_total_locked(
            &runtime,
            runtime
                .scope
                .as_ref()
                .map(|scope| scope.account_generation)
                .unwrap_or_default(),
        );
        Some(publish(unread))
    }

    #[cfg(test)]
    fn set_context(
        &self,
        scope: NotificationAccountScope,
        context: NotificationPresentationContext,
    ) {
        let account_generation = scope.account_generation;
        let _ = self.commit_context(scope, context, || account_generation, |_| ());
    }

    #[cfg(test)]
    fn invalidate(&self) {
        let _ = self.close_and_invalidate(|| Ok::<_, ()>(()));
    }

    /// Return the content-preview policy from the same locked snapshot that
    /// authorizes presentation, so a context update cannot race private
    /// content into a notification.
    #[cfg(test)]
    fn presentation_policy(
        &self,
        account_generation: u64,
        room_id: &str,
        window_focused: bool,
    ) -> Option<bool> {
        self.with_presentation_policy(account_generation, room_id, window_focused, Some)
            .flatten()
    }

    fn with_presentation_policy<R>(
        &self,
        account_generation: u64,
        room_id: &str,
        window_focused: bool,
        present: impl FnOnce(bool) -> R,
    ) -> Option<R> {
        let runtime = self
            .runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if runtime.scope.as_ref().map(|scope| scope.account_generation) != Some(account_generation)
        {
            return None;
        }
        let should_present = runtime.context.presentation_enabled()
            && !runtime.context.is_room_muted(room_id)
            && !(window_focused && runtime.context.active_room_id.as_deref() == Some(room_id));
        should_present.then(|| present(runtime.context.show_message_content))
    }

    #[cfg(test)]
    fn record_unread(&self, account_generation: u64, update: &MatrixUnreadUpdate) -> bool {
        self.with_unread_update(account_generation, update, |_| ())
            .is_some()
    }

    fn with_unread_update<R>(
        &self,
        account_generation: u64,
        update: &MatrixUnreadUpdate,
        publish: impl FnOnce(u64) -> R,
    ) -> Option<R> {
        let mut runtime = self
            .runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if runtime.scope.as_ref().map(|scope| scope.account_generation) != Some(account_generation)
        {
            return None;
        }
        let snapshot = UnreadSnapshot {
            messages: update.unread_messages.max(0) as u64,
            mentions: update.unread_mentions.max(0) as u64,
        };
        if snapshot.messages == 0 && snapshot.mentions == 0 {
            runtime.unread_by_room.remove(&update.room_id);
        } else {
            runtime
                .unread_by_room
                .insert(update.room_id.clone(), snapshot);
        }
        let unread = Self::visible_unread_total_locked(&runtime, account_generation);
        Some(publish(unread))
    }

    #[cfg(test)]
    fn visible_unread_total(&self, account_generation: u64) -> u64 {
        let runtime = self
            .runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Self::visible_unread_total_locked(&runtime, account_generation)
    }

    fn visible_unread_total_locked(runtime: &NotificationRuntime, account_generation: u64) -> u64 {
        if runtime.scope.as_ref().map(|scope| scope.account_generation) != Some(account_generation)
            || !runtime.context.presentation_enabled()
        {
            return 0;
        }
        let muted = runtime
            .context
            .muted_room_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        runtime
            .unread_by_room
            .iter()
            .filter(|(room_id, _)| !muted.contains(room_id.as_str()))
            // A mention count can briefly outlive the message count while the
            // SDK reconciles read markers. Keep the badge visible until both
            // are clear.
            .map(|(_, snapshot)| snapshot.messages.max(snapshot.mentions))
            .fold(0_u64, u64::saturating_add)
    }
}

fn unread_indicator_image() -> Image<'static> {
    const SIZE: u32 = 16;
    let mut rgba = vec![0_u8; (SIZE * SIZE * 4) as usize];
    let center = (SIZE as f32 - 1.0) / 2.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            if dx * dx + dy * dy <= 43.0 {
                let offset = ((y * SIZE + x) * 4) as usize;
                rgba[offset..offset + 4].copy_from_slice(&[237, 66, 69, 255]);
            }
        }
    }
    Image::new_owned(rgba, SIZE, SIZE)
}

fn update_window_badge(window: &WebviewWindow, unread: u64) {
    #[cfg(target_os = "windows")]
    if let Err(error) = window.set_overlay_icon((unread > 0).then(unread_indicator_image)) {
        tracing::warn!(target: "mesh::notifications", "Could not update taskbar overlay: {error}");
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if let Err(error) =
        window.set_badge_count((unread > 0).then_some(unread.min(i64::MAX as u64) as i64))
    {
        tracing::warn!(target: "mesh::notifications", "Could not update app badge: {error}");
    }
}

fn update_unread_indicators_for_count(app: &AppHandle, unread: u64) {
    if let Some(window) = app.get_webview_window("main") {
        update_window_badge(&window, unread);
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let tooltip = if unread == 0 {
            "Mesh".to_owned()
        } else {
            format!("Mesh — {unread} unread")
        };
        if let Err(error) = tray.set_tooltip(Some(tooltip)) {
            tracing::warn!(target: "mesh::notifications", "Could not update tray tooltip: {error}");
        }
        let icon = if unread > 0 {
            Some(unread_indicator_image())
        } else {
            app.default_window_icon().cloned()
        };
        if let Err(error) = tray.set_icon(icon) {
            tracing::warn!(target: "mesh::notifications", "Could not update tray icon: {error}");
        }
    }
}

/// Serialize admission closure with notification delivery, then revoke
/// presentation consent and unread UI before backend replacement can start.
pub fn close_account_admission_and_invalidate<T, E>(
    app: &AppHandle,
    state: &NotificationRuntimeState,
    close_account_admission: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let transition = state.close_and_invalidate(close_account_admission)?;
    update_unread_indicators_for_count(app, 0);
    Ok(transition)
}

fn safe_notification_sender(display_name: &str) -> String {
    let normalized = display_name
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '\u{061c}'
                        | '\u{200b}'..='\u{200f}'
                        | '\u{202a}'..='\u{202e}'
                        | '\u{2060}'..='\u{206f}'
                        | '\u{feff}'
                )
            {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let bounded = normalized
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_NOTIFICATION_SENDER_CHARS)
        .collect::<String>();
    if bounded.is_empty() {
        "Someone".into()
    } else {
        bounded
    }
}

fn safe_notification_preview(preview: &str) -> String {
    let normalized = preview
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '\u{061c}'
                        | '\u{200b}'..='\u{200f}'
                        | '\u{202a}'..='\u{202e}'
                        | '\u{2060}'..='\u{206f}'
                        | '\u{feff}'
                )
            {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let bounded = normalized
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_NOTIFICATION_PREVIEW_CHARS)
        .collect::<String>();
    if bounded.is_empty() {
        PRIVATE_NOTIFICATION_BODY.into()
    } else {
        bounded
    }
}

fn presentation_notification(
    mut notification: MatrixNotification,
    show_message_content: bool,
) -> MatrixNotification {
    notification.display_name = safe_notification_sender(&notification.display_name);
    notification.preview = if show_message_content {
        safe_notification_preview(&notification.preview)
    } else {
        PRIVATE_NOTIFICATION_BODY.into()
    };
    notification.avatar_url = None;
    notification
}

fn private_notification_title(display_name: &str) -> String {
    format!(
        "New message from {}",
        safe_notification_sender(display_name)
    )
}

pub fn configure_tray(app: &mut App) {
    let Some(icon) = app.default_window_icon().cloned() else {
        tracing::warn!(
            target: "mesh::notifications",
            "No application icon was available for the tray"
        );
        return;
    };
    if let Err(error) = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Mesh")
        .build(app)
    {
        tracing::warn!(target: "mesh::notifications", "Could not create tray icon: {error}");
    }
}

pub fn handle_matrix_backend_event(app: &AppHandle, event: MatrixBackendEvent) {
    let state = app.state::<NotificationRuntimeState>();
    let account_generation = app.state::<AppState>().native_requests.account_generation();
    match event {
        MatrixBackendEvent::Notification(notification) => {
            let focused = app
                .get_webview_window("main")
                .and_then(|window| window.is_focused().ok())
                .unwrap_or(false);
            let room_id = notification.room_id.clone();
            state.with_presentation_policy(
                account_generation,
                &room_id,
                focused,
                |show_message_content| {
                    let notification =
                        presentation_notification(notification, show_message_content);
                    if let Err(error) = app.emit(MATRIX_NOTIFICATION_EVENT, &notification) {
                        tracing::warn!(
                            target: "mesh::notifications",
                            "Could not emit Matrix notification event: {error}"
                        );
                    }
                    show_native_notification(app, &notification);
                },
            );
        }
        MatrixBackendEvent::UnreadUpdate(update) => {
            state.with_unread_update(account_generation, &update, |unread| {
                if let Err(error) = app.emit(MATRIX_UNREAD_UPDATE_EVENT, &update) {
                    tracing::warn!(
                        target: "mesh::notifications",
                        "Could not emit Matrix unread update: {error}"
                    );
                }
                update_unread_indicators_for_count(app, unread);
            });
        }
        MatrixBackendEvent::IgnoredUsersChanged(change) => {
            if let Err(error) = app.emit(MATRIX_IGNORED_USERS_CHANGED_EVENT, &change) {
                tracing::warn!(
                    target: "mesh::matrix",
                    "Could not emit ignored-account update: {error}"
                );
            }
        }
        MatrixBackendEvent::QueuedMessage(update) => {
            if let Err(error) = app.emit(MATRIX_QUEUED_MESSAGE_EVENT, &update) {
                tracing::warn!(
                    target: "mesh::matrix",
                    "Could not emit queued-message update: {error}"
                );
            }
        }
        MatrixBackendEvent::RoomPins(update) => {
            if let Err(error) = app.emit(MATRIX_ROOM_PINS_EVENT, &update) {
                tracing::warn!(
                    target: "mesh::matrix",
                    "Could not emit room-pin update: {error}"
                );
            }
        }
        MatrixBackendEvent::RtcMembership(update) => {
            if let Err(error) = app.emit(MATRIX_RTC_MEMBERSHIP_EVENT, &update) {
                tracing::warn!(
                    target: "mesh::matrixrtc",
                    "Could not emit MatrixRTC membership update: {error}"
                );
            }
        }
        MatrixBackendEvent::RtcMediaKey(key) => {
            if let Err(error) = app.emit(MATRIX_RTC_MEDIA_KEY_EVENT, &key) {
                tracing::warn!(
                    target: "mesh::matrixrtc",
                    "Could not emit ephemeral MatrixRTC media key: {error}"
                );
            }
        }
        MatrixBackendEvent::RtcMediaKeyFailure(failure) => {
            if let Err(error) = app.emit(MATRIX_RTC_MEDIA_KEY_FAILURE_EVENT, &failure) {
                tracing::warn!(
                    target: "mesh::matrixrtc",
                    "Could not emit MatrixRTC media key failure: {error}"
                );
            }
        }
        MatrixBackendEvent::RtcMediaKeyPause(pause) => {
            if let Err(error) = app.emit(MATRIX_RTC_MEDIA_KEY_PAUSE_EVENT, &pause) {
                tracing::warn!(
                    target: "mesh::matrixrtc",
                    "Could not emit MatrixRTC media key pause request: {error}"
                );
            }
        }
        MatrixBackendEvent::PermissionStateChanged(change) => {
            if let Err(error) = app.emit(MATRIX_PERMISSION_STATE_CHANGED_EVENT, &change) {
                tracing::warn!(
                    target: "mesh::matrix",
                    "Could not emit Matrix permission-state update: {error}"
                );
            }
        }
    }
}

fn show_native_notification(app: &AppHandle, notification: &MatrixNotification) {
    if let Err(error) = ensure_notification_permission(app) {
        tracing::warn!(
            target: "mesh::notifications",
            room_id = notification.room_id,
            event_id = notification.event_id,
            "Native notification permission is unavailable: {error}"
        );
        return;
    }
    if let Err(error) = app
        .notification()
        .builder()
        .title(private_notification_title(&notification.display_name))
        .body(&notification.preview)
        .show()
    {
        tracing::warn!(
            target: "mesh::notifications",
            room_id = notification.room_id,
            event_id = notification.event_id,
            "Could not show native notification: {error}"
        );
    }
}

fn ensure_notification_permission(app: &AppHandle) -> Result<(), String> {
    let notifications = app.notification();
    let state = notifications
        .permission_state()
        .map_err(|error| error.to_string())?;
    let state = match state {
        PermissionState::Granted => return Ok(()),
        PermissionState::Denied => PermissionState::Denied,
        PermissionState::Prompt | PermissionState::PromptWithRationale => notifications
            .request_permission()
            .map_err(|error| error.to_string())?,
    };
    match state {
        PermissionState::Granted => Ok(()),
        PermissionState::Denied
        | PermissionState::Prompt
        | PermissionState::PromptWithRationale => {
            Err("notification permission was not granted".into())
        }
    }
}

async fn verified_notification_scope(
    expected_scope: NotificationAccountScope,
    state: &State<'_, AppState>,
) -> Result<(NotificationAccountScope, NativeAccountMutationGuard), CommandError> {
    let account_guard = state
        .native_requests
        .begin_account_mutation(expected_scope.account_generation)
        .map_err(|_| {
            CommandError::Cancelled(
                "Your account changed before Mesh could update notifications. Try again.".into(),
            )
        })?;
    let status = state.backend.backend().status().await;
    if !status.authenticated || status.user_id.as_deref() != Some(expected_scope.user_id.as_str()) {
        return Err(CommandError::Cancelled(
            "Your account changed before Mesh could update notifications. Try again.".into(),
        ));
    }
    Ok((expected_scope, account_guard))
}

#[tauri::command]
pub async fn get_notification_account_scope(
    expected_user_id: String,
    state: State<'_, AppState>,
) -> Result<NotificationAccountScope, CommandError> {
    let scope = NotificationAccountScope {
        account_generation: state.native_requests.account_generation(),
        user_id: expected_user_id,
    };
    let (scope, _account_guard) = verified_notification_scope(scope, &state).await?;
    Ok(scope)
}

#[tauri::command]
pub async fn set_notification_context(
    scope: NotificationAccountScope,
    context: NotificationPresentationContext,
    app: AppHandle,
    app_state: State<'_, AppState>,
    notification_state: State<'_, NotificationRuntimeState>,
) -> Result<(), CommandError> {
    let (scope, _account_guard) = verified_notification_scope(scope, &app_state).await?;
    if notification_state
        .commit_context(
            scope,
            context,
            || app_state.native_requests.account_generation(),
            |unread| update_unread_indicators_for_count(&app, unread),
        )
        .is_none()
    {
        return Err(CommandError::Cancelled(
            "Your account changed before Mesh could update notifications. Try again.".into(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn send_test_notification(app: AppHandle) -> Result<(), CommandError> {
    ensure_notification_permission(&app).map_err(CommandError::PermissionDenied)?;
    app.notification()
        .builder()
        .title("Mesh notifications are ready")
        .body("Messages can reach you while Mesh is in the background.")
        .show()
        .map_err(|error| CommandError::Other(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(account_generation: u64, user_id: &str) -> NotificationAccountScope {
        NotificationAccountScope {
            account_generation,
            user_id: user_id.into(),
        }
    }

    #[test]
    fn startup_policy_fails_closed_until_renderer_restores_preferences() {
        let state = NotificationRuntimeState::default();
        assert_eq!(
            state.presentation_policy(1, "!room:example.org", false),
            None
        );
        assert_eq!(state.visible_unread_total(1), 0);
    }

    #[test]
    fn active_focused_room_and_policy_suppress_presentations() {
        let state = NotificationRuntimeState::default();
        state.set_context(
            scope(4, "@alice:example.org"),
            NotificationPresentationContext {
                active_room_id: Some("!active:example.org".into()),
                notifications_enabled: true,
                do_not_disturb: false,
                quiet_hours_active: false,
                show_message_content: false,
                muted_room_ids: vec!["!muted:example.org".into()],
            },
        );

        assert_eq!(
            state.presentation_policy(4, "!active:example.org", true),
            None
        );
        assert_eq!(
            state.presentation_policy(4, "!active:example.org", false),
            Some(false)
        );
        assert_eq!(
            state.presentation_policy(4, "!muted:example.org", false),
            None
        );
        assert_eq!(
            state.presentation_policy(4, "!other:example.org", true),
            Some(false)
        );
    }

    #[test]
    fn visible_unread_total_excludes_muted_rooms() {
        let state = NotificationRuntimeState::default();
        state.set_context(
            scope(8, "@alice:example.org"),
            NotificationPresentationContext {
                notifications_enabled: true,
                muted_room_ids: vec!["!muted:example.org".into()],
                ..NotificationPresentationContext::default()
            },
        );
        state.record_unread(
            8,
            &MatrixUnreadUpdate {
                room_id: "!shown:example.org".into(),
                unread_messages: 3,
                unread_mentions: 0,
            },
        );
        state.record_unread(
            8,
            &MatrixUnreadUpdate {
                room_id: "!muted:example.org".into(),
                unread_messages: 7,
                unread_mentions: 2,
            },
        );
        assert_eq!(state.visible_unread_total(8), 3);
    }

    #[test]
    fn mention_only_unread_updates_keep_the_badge_until_both_counts_clear() {
        let state = NotificationRuntimeState::default();
        state.set_context(
            scope(12, "@alice:example.org"),
            NotificationPresentationContext {
                notifications_enabled: true,
                ..NotificationPresentationContext::default()
            },
        );

        state.record_unread(
            12,
            &MatrixUnreadUpdate {
                room_id: "!room:example.org".into(),
                unread_messages: 0,
                unread_mentions: 2,
            },
        );
        assert_eq!(state.visible_unread_total(12), 2);

        state.record_unread(
            12,
            &MatrixUnreadUpdate {
                room_id: "!room:example.org".into(),
                unread_messages: 0,
                unread_mentions: 0,
            },
        );
        assert_eq!(state.visible_unread_total(12), 0);
    }

    #[test]
    fn notification_minimization_removes_content_and_remote_avatar_data() {
        let notification = presentation_notification(
            MatrixNotification {
                room_id: "!room:example.invalid".into(),
                event_id: "$event".into(),
                sender: "@sender:example.invalid".into(),
                display_name: "  Example\nSender\t".into(),
                preview: "private fixture phrase attachment-name.pdf".into(),
                is_mention: false,
                is_dm: true,
                avatar_url: Some("mxc://example.invalid/private-avatar".into()),
            },
            false,
        );

        assert_eq!(notification.display_name, "Example Sender");
        assert_eq!(notification.preview, PRIVATE_NOTIFICATION_BODY);
        assert_eq!(
            private_notification_title(&notification.display_name),
            "New message from Example Sender"
        );
        assert_eq!(notification.avatar_url, None);
        assert!(!notification.preview.contains("private fixture phrase"));
        assert!(!notification.preview.contains("attachment-name.pdf"));
    }

    #[test]
    fn notification_content_requires_explicit_policy_and_stays_bounded() {
        let notification = presentation_notification(
            MatrixNotification {
                room_id: "!room:example.invalid".into(),
                event_id: "$event".into(),
                sender: "@sender:example.invalid".into(),
                display_name: "Example Sender".into(),
                preview: format!("  hello\u{202e}\nworld {}  ", "x".repeat(300)),
                is_mention: false,
                is_dm: true,
                avatar_url: Some("mxc://example.invalid/private-avatar".into()),
            },
            true,
        );

        assert!(notification.preview.starts_with("hello world "));
        assert_eq!(
            notification.preview.chars().count(),
            MAX_NOTIFICATION_PREVIEW_CHARS
        );
        assert!(!notification.preview.contains('\u{202e}'));
        assert_eq!(notification.avatar_url, None);

        let state = NotificationRuntimeState::default();
        state.set_context(
            scope(18, "@alice:example.org"),
            NotificationPresentationContext {
                notifications_enabled: true,
                show_message_content: true,
                ..NotificationPresentationContext::default()
            },
        );
        assert_eq!(
            state.presentation_policy(18, "!room:example.org", false),
            Some(true)
        );
    }

    #[test]
    fn account_transition_immediately_revokes_policy_and_unread_state() {
        let state = NotificationRuntimeState::default();
        state.set_context(
            scope(21, "@alice:example.org"),
            NotificationPresentationContext {
                notifications_enabled: true,
                show_message_content: true,
                ..NotificationPresentationContext::default()
            },
        );
        assert!(state.record_unread(
            21,
            &MatrixUnreadUpdate {
                room_id: "!private:example.org".into(),
                unread_messages: 5,
                unread_mentions: 1,
            }
        ));
        assert_eq!(
            state.presentation_policy(21, "!private:example.org", false),
            Some(true)
        );
        assert_eq!(state.visible_unread_total(21), 5);

        state.invalidate();

        assert_eq!(
            state.presentation_policy(22, "!private:example.org", false),
            None
        );
        assert_eq!(state.visible_unread_total(22), 0);
    }

    #[test]
    fn events_fail_closed_until_the_current_generation_restores_policy() {
        let state = NotificationRuntimeState::default();
        state.set_context(
            scope(30, "@alice:example.org"),
            NotificationPresentationContext {
                notifications_enabled: true,
                show_message_content: true,
                ..NotificationPresentationContext::default()
            },
        );
        let update = MatrixUnreadUpdate {
            room_id: "!private:example.org".into(),
            unread_messages: 2,
            unread_mentions: 0,
        };

        assert_eq!(
            state.presentation_policy(31, "!private:example.org", false),
            None
        );
        assert!(!state.record_unread(31, &update));
        assert_eq!(state.visible_unread_total(31), 0);

        state.set_context(
            scope(31, "@bob:example.org"),
            NotificationPresentationContext {
                notifications_enabled: true,
                show_message_content: false,
                ..NotificationPresentationContext::default()
            },
        );
        assert_eq!(
            state.presentation_policy(31, "!private:example.org", false),
            Some(false)
        );
    }

    #[test]
    fn delayed_old_unread_event_cannot_touch_the_current_account() {
        use std::cell::Cell;

        let state = NotificationRuntimeState::default();
        state.set_context(
            scope(81, "@bob:example.org"),
            NotificationPresentationContext {
                notifications_enabled: true,
                ..NotificationPresentationContext::default()
            },
        );
        assert!(state.record_unread(
            81,
            &MatrixUnreadUpdate {
                room_id: "!bob:example.org".into(),
                unread_messages: 4,
                unread_mentions: 0,
            }
        ));
        let published = Cell::new(false);

        let stale_result = state.with_unread_update(
            80,
            &MatrixUnreadUpdate {
                room_id: "!alice:example.org".into(),
                unread_messages: 9,
                unread_mentions: 2,
            },
            |_| published.set(true),
        );

        assert_eq!(stale_result, None);
        assert!(!published.get());
        assert_eq!(state.visible_unread_total(81), 4);
    }

    #[test]
    fn same_user_with_a_new_generation_cannot_reuse_old_preview_consent() {
        let state = NotificationRuntimeState::default();
        state.set_context(
            scope(40, "@alice:example.org"),
            NotificationPresentationContext {
                notifications_enabled: true,
                show_message_content: true,
                ..NotificationPresentationContext::default()
            },
        );

        assert_eq!(
            state.presentation_policy(41, "!private:example.org", false),
            None
        );
    }

    #[test]
    fn transition_cannot_close_admission_during_notification_delivery() {
        use std::{
            sync::{mpsc, Arc},
            time::Duration,
        };

        let state = Arc::new(NotificationRuntimeState::default());
        state.set_context(
            scope(50, "@alice:example.org"),
            NotificationPresentationContext {
                notifications_enabled: true,
                show_message_content: true,
                ..NotificationPresentationContext::default()
            },
        );
        let (delivery_started_tx, delivery_started_rx) = mpsc::channel();
        let (release_delivery_tx, release_delivery_rx) = mpsc::channel();
        let delivering_state = Arc::clone(&state);
        let delivering = std::thread::spawn(move || {
            assert_eq!(
                delivering_state.with_presentation_policy(
                    50,
                    "!private:example.org",
                    false,
                    |_| {
                        delivery_started_tx.send(()).unwrap();
                        release_delivery_rx.recv().unwrap();
                    },
                ),
                Some(())
            );
        });
        delivery_started_rx.recv().unwrap();

        let (admission_closed_tx, admission_closed_rx) = mpsc::channel();
        let transitioning_state = Arc::clone(&state);
        let transitioning = std::thread::spawn(move || {
            transitioning_state
                .close_and_invalidate(|| {
                    admission_closed_tx.send(()).unwrap();
                    Ok::<_, ()>(())
                })
                .unwrap();
        });
        assert!(
            admission_closed_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "account admission closed before authorized delivery completed"
        );

        release_delivery_tx.send(()).unwrap();
        delivering.join().unwrap();
        admission_closed_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        transitioning.join().unwrap();
        assert_eq!(
            state.presentation_policy(51, "!private:example.org", false),
            None
        );
    }

    #[test]
    fn transition_cannot_close_admission_during_unread_publication() {
        use std::{
            sync::{mpsc, Arc},
            time::Duration,
        };

        let state = Arc::new(NotificationRuntimeState::default());
        state.set_context(
            scope(60, "@alice:example.org"),
            NotificationPresentationContext {
                notifications_enabled: true,
                ..NotificationPresentationContext::default()
            },
        );
        let update = MatrixUnreadUpdate {
            room_id: "!private:example.org".into(),
            unread_messages: 3,
            unread_mentions: 0,
        };
        let (publication_started_tx, publication_started_rx) = mpsc::channel();
        let (release_publication_tx, release_publication_rx) = mpsc::channel();
        let publishing_state = Arc::clone(&state);
        let publishing = std::thread::spawn(move || {
            assert_eq!(
                publishing_state.with_unread_update(60, &update, |unread| {
                    assert_eq!(unread, 3);
                    publication_started_tx.send(()).unwrap();
                    release_publication_rx.recv().unwrap();
                }),
                Some(())
            );
        });
        publication_started_rx.recv().unwrap();

        let (admission_closed_tx, admission_closed_rx) = mpsc::channel();
        let transitioning_state = Arc::clone(&state);
        let transitioning = std::thread::spawn(move || {
            transitioning_state
                .close_and_invalidate(|| {
                    admission_closed_tx.send(()).unwrap();
                    Ok::<_, ()>(())
                })
                .unwrap();
        });
        assert!(
            admission_closed_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "account admission closed before unread publication completed"
        );

        release_publication_tx.send(()).unwrap();
        publishing.join().unwrap();
        admission_closed_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        transitioning.join().unwrap();
        assert_eq!(state.visible_unread_total(61), 0);
    }

    #[test]
    fn context_commit_and_transition_close_are_one_serialized_boundary() {
        use std::{
            sync::{mpsc, Arc},
            time::Duration,
        };

        let state = Arc::new(NotificationRuntimeState::default());
        let (commit_started_tx, commit_started_rx) = mpsc::channel();
        let (release_commit_tx, release_commit_rx) = mpsc::channel();
        let committing_state = Arc::clone(&state);
        let committing = std::thread::spawn(move || {
            assert_eq!(
                committing_state.commit_context(
                    scope(70, "@alice:example.org"),
                    NotificationPresentationContext {
                        notifications_enabled: true,
                        show_message_content: true,
                        ..NotificationPresentationContext::default()
                    },
                    || {
                        commit_started_tx.send(()).unwrap();
                        release_commit_rx.recv().unwrap();
                        70
                    },
                    |_| (),
                ),
                Some(())
            );
        });
        commit_started_rx.recv().unwrap();

        let (admission_closed_tx, admission_closed_rx) = mpsc::channel();
        let transitioning_state = Arc::clone(&state);
        let transitioning = std::thread::spawn(move || {
            transitioning_state
                .close_and_invalidate(|| {
                    admission_closed_tx.send(()).unwrap();
                    Ok::<_, ()>(())
                })
                .unwrap();
        });
        assert!(
            admission_closed_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "account admission closed during notification context commit"
        );

        release_commit_tx.send(()).unwrap();
        committing.join().unwrap();
        admission_closed_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        transitioning.join().unwrap();
        assert_eq!(
            state.presentation_policy(71, "!private:example.org", false),
            None
        );
    }

    #[test]
    fn notification_sender_is_bounded_and_has_a_safe_fallback() {
        assert_eq!(safe_notification_sender("\r\n\t"), "Someone");
        assert_eq!(
            safe_notification_sender("Example\u{202e}cod.exe"),
            "Example cod.exe"
        );
        assert_eq!(
            safe_notification_sender(&"x".repeat(MAX_NOTIFICATION_SENDER_CHARS + 20))
                .chars()
                .count(),
            MAX_NOTIFICATION_SENDER_CHARS
        );
    }
}
