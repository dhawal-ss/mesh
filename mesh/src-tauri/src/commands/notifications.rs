use std::{
    collections::{HashMap, HashSet},
    sync::RwLock,
};

use tauri::{
    image::Image, plugin::PermissionState, tray::TrayIconBuilder, App, AppHandle, Emitter, Manager,
    State, WebviewWindow,
};
use tauri_plugin_notification::NotificationExt;

use crate::backend::{
    MatrixBackendEvent, MatrixNotification, MatrixUnreadUpdate, NotificationPresentationContext,
    MATRIX_NOTIFICATION_EVENT, MATRIX_QUEUED_MESSAGE_EVENT, MATRIX_RTC_MEDIA_KEY_EVENT,
    MATRIX_RTC_MEDIA_KEY_FAILURE_EVENT, MATRIX_RTC_MEDIA_KEY_PAUSE_EVENT,
    MATRIX_RTC_MEMBERSHIP_EVENT, MATRIX_UNREAD_UPDATE_EVENT,
};

use super::error::CommandError;

const TRAY_ID: &str = "mesh-main";

#[derive(Debug, Clone, Copy, Default)]
struct UnreadSnapshot {
    messages: u64,
    mentions: u64,
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
    context: RwLock<NotificationPresentationContext>,
    unread_by_room: RwLock<HashMap<String, UnreadSnapshot>>,
}

impl NotificationRuntimeState {
    fn set_context(&self, context: NotificationPresentationContext) {
        if let Ok(mut current) = self.context.write() {
            *current = context.normalized();
        }
    }

    fn should_present(&self, room_id: &str, window_focused: bool) -> bool {
        let Ok(context) = self.context.read() else {
            return false;
        };
        context.presentation_enabled()
            && !context.is_room_muted(room_id)
            && !(window_focused && context.active_room_id.as_deref() == Some(room_id))
    }

    fn record_unread(&self, update: &MatrixUnreadUpdate) {
        if let Ok(mut unread_by_room) = self.unread_by_room.write() {
            let snapshot = UnreadSnapshot {
                messages: update.unread_messages.max(0) as u64,
                mentions: update.unread_mentions.max(0) as u64,
            };
            if snapshot.messages == 0 && snapshot.mentions == 0 {
                unread_by_room.remove(&update.room_id);
            } else {
                unread_by_room.insert(update.room_id.clone(), snapshot);
            }
        }
    }

    fn visible_unread_total(&self) -> u64 {
        let Ok(context) = self.context.read() else {
            return 0;
        };
        if !context.presentation_enabled() {
            return 0;
        }
        let muted = context
            .muted_room_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        self.unread_by_room
            .read()
            .map(|rooms| {
                rooms
                    .iter()
                    .filter(|(room_id, _)| !muted.contains(room_id.as_str()))
                    // A mention count can briefly outlive the message count
                    // while the SDK reconciles read markers. Keep the badge
                    // visible until both are clear.
                    .map(|(_, snapshot)| snapshot.messages.max(snapshot.mentions))
                    .fold(0_u64, u64::saturating_add)
            })
            .unwrap_or_default()
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

fn update_unread_indicators(app: &AppHandle, state: &NotificationRuntimeState) {
    let unread = state.visible_unread_total();
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
    match event {
        MatrixBackendEvent::Notification(notification) => {
            let focused = app
                .get_webview_window("main")
                .and_then(|window| window.is_focused().ok())
                .unwrap_or(false);
            if !state.should_present(&notification.room_id, focused) {
                return;
            }
            if let Err(error) = app.emit(MATRIX_NOTIFICATION_EVENT, &notification) {
                tracing::warn!(
                    target: "mesh::notifications",
                    "Could not emit Matrix notification event: {error}"
                );
            }
            show_native_notification(app, &notification);
        }
        MatrixBackendEvent::UnreadUpdate(update) => {
            state.record_unread(&update);
            if let Err(error) = app.emit(MATRIX_UNREAD_UPDATE_EVENT, &update) {
                tracing::warn!(
                    target: "mesh::notifications",
                    "Could not emit Matrix unread update: {error}"
                );
            }
            update_unread_indicators(app, &state);
        }
        MatrixBackendEvent::QueuedMessage(update) => {
            if let Err(error) = app.emit(MATRIX_QUEUED_MESSAGE_EVENT, &update) {
                tracing::warn!(
                    target: "mesh::matrix",
                    "Could not emit queued-message update: {error}"
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
        .title(&notification.display_name)
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

#[tauri::command]
pub fn set_notification_context(
    context: NotificationPresentationContext,
    app: AppHandle,
    state: State<'_, NotificationRuntimeState>,
) {
    state.set_context(context);
    update_unread_indicators(&app, &state);
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

    #[test]
    fn startup_policy_fails_closed_until_renderer_restores_preferences() {
        let state = NotificationRuntimeState::default();
        assert!(!state.should_present("!room:example.org", false));
        assert_eq!(state.visible_unread_total(), 0);
    }

    #[test]
    fn active_focused_room_and_policy_suppress_presentations() {
        let state = NotificationRuntimeState::default();
        state.set_context(NotificationPresentationContext {
            active_room_id: Some("!active:example.org".into()),
            notifications_enabled: true,
            do_not_disturb: false,
            quiet_hours_active: false,
            muted_room_ids: vec!["!muted:example.org".into()],
        });

        assert!(!state.should_present("!active:example.org", true));
        assert!(state.should_present("!active:example.org", false));
        assert!(!state.should_present("!muted:example.org", false));
        assert!(state.should_present("!other:example.org", true));
    }

    #[test]
    fn visible_unread_total_excludes_muted_rooms() {
        let state = NotificationRuntimeState::default();
        state.record_unread(&MatrixUnreadUpdate {
            room_id: "!shown:example.org".into(),
            unread_messages: 3,
            unread_mentions: 0,
        });
        state.record_unread(&MatrixUnreadUpdate {
            room_id: "!muted:example.org".into(),
            unread_messages: 7,
            unread_mentions: 2,
        });
        state.set_context(NotificationPresentationContext {
            notifications_enabled: true,
            muted_room_ids: vec!["!muted:example.org".into()],
            ..NotificationPresentationContext::default()
        });

        assert_eq!(state.visible_unread_total(), 3);
    }

    #[test]
    fn mention_only_unread_updates_keep_the_badge_until_both_counts_clear() {
        let state = NotificationRuntimeState::default();
        state.set_context(NotificationPresentationContext {
            notifications_enabled: true,
            ..NotificationPresentationContext::default()
        });

        state.record_unread(&MatrixUnreadUpdate {
            room_id: "!room:example.org".into(),
            unread_messages: 0,
            unread_mentions: 2,
        });
        assert_eq!(state.visible_unread_total(), 2);

        state.record_unread(&MatrixUnreadUpdate {
            room_id: "!room:example.org".into(),
            unread_messages: 0,
            unread_mentions: 0,
        });
        assert_eq!(state.visible_unread_total(), 0);
    }
}
