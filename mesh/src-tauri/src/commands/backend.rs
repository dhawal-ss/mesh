//! Typed Tauri IPC for the backend boundary and Matrix architecture spike.

use std::{collections::HashSet, sync::Arc};

use futures::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::backend::{
    BackendError, BackendKind, BackendStatus, CommunityAccessResult, CommunityAccessSettings,
    CommunityApplication, CommunityDirectoryEntry, CommunityMemberPage, CommunityModerationResult,
    CommunityPermissionProjection, CustomEmoji, MatrixAccount, MatrixAttachmentSendRequest,
    MatrixDevice, MatrixLogin, MatrixOidcStatus, MatrixPersonalDataExport, MatrixProfile,
    MatrixRecoveryHealth, MatrixRecoverySetupResult, MatrixRegistration,
    MatrixRoomNotificationMode, MatrixRoomPins, MatrixRoomUpgrade, MatrixRtcJoinResult,
    MatrixRtcMediaKey, MatrixRtcMediaKeyLease, MatrixRtcMember, MatrixServiceCapabilities,
    MatrixTransferObserver, MatrixTransferProgressCallback, MatrixVerificationSession,
    ModerationAuditEntry, TypingUser, UserPreferences, MATRIX_TRANSFER_PROGRESS_EVENT,
};
use crate::state::{
    destructive_actions::{DestructiveAction, DestructiveActionScope, GrantError},
    native_requests::{
        NativeAccountMutationGuard, NativeAccountTransitionGuard, NativeRequestError,
        NativeUiInteractionGuard,
    },
    AppState,
};
use crate::types::{
    community::{ChannelDto, CommunityDto},
    dm::{
        BlockedAccountDto, BlockedAccountPageDto, DirectMessageDto, DmConversationDto, DmRequestDto,
    },
    message::MessageDto,
};

use super::{attachments::AttachmentGrantStore, error::CommandError};

pub(super) fn map_error(error: BackendError) -> CommandError {
    match error {
        BackendError::NotAuthenticated => CommandError::NotAuthenticated,
        BackendError::Network(_) => CommandError::Network(error.to_string()),
        BackendError::RateLimited(_) => CommandError::RateLimited,
        BackendError::PermissionDenied(_) => CommandError::PermissionDenied(error.to_string()),
        BackendError::NotFound(_) => CommandError::NotFound(error.to_string()),
        BackendError::Crypto(_) => CommandError::Crypto(error.to_string()),
        BackendError::Serialization(_) => CommandError::Serialization(error.to_string()),
        BackendError::NotEncrypted(_) => CommandError::NotEncrypted(error.to_string()),
        BackendError::DecryptionFailed(_) => CommandError::DecryptionFailed(error.to_string()),
        BackendError::Cancelled(_) => CommandError::Cancelled(error.to_string()),
        BackendError::InvalidInput(_) => CommandError::Validation(error.to_string()),
        BackendError::InvalidConfiguration(_) => CommandError::Validation(error.to_string()),
        BackendError::CommunityHomeserverUnconfigured => {
            CommandError::CommunityHomeserverUnconfigured
        }
        BackendError::UsernameUnavailable => CommandError::UsernameUnavailable,
        BackendError::RegistrationTermsRequired => CommandError::RegistrationTermsRequired,
        BackendError::RegistrationAdditionalAuthRequired => {
            CommandError::RegistrationAdditionalAuthRequired
        }
        BackendError::RegistrationInvitationRequired => {
            CommandError::RegistrationInvitationRequired
        }
        BackendError::RegistrationInvitationInvalid => CommandError::RegistrationInvitationInvalid,
        BackendError::RegistrationTimedOut(_) => CommandError::RegistrationTimedOut,
        BackendError::Unsupported(_) => CommandError::Unsupported(error.to_string()),
        BackendError::Other(_) => CommandError::Other(error.to_string()),
        BackendError::LoginCancelled => CommandError::LoginCancelled,
        BackendError::LoginTimedOut(_) => CommandError::LoginTimedOut,
    }
}

pub(super) fn require_matrix(state: &State<'_, AppState>) -> Result<(), CommandError> {
    if state.backend.kind() != BackendKind::Matrix {
        return Err(CommandError::Validation(
            "Matrix operation requested while MESH_BACKEND=legacy-p2p".into(),
        ));
    }
    Ok(())
}

fn map_grant_error(error: GrantError) -> CommandError {
    match error {
        GrantError::InvalidGrant | GrantError::ScopeMismatch => CommandError::PermissionDenied(
            "Confirm this action again in the native Mesh prompt.".into(),
        ),
        GrantError::Capacity | GrantError::Unavailable => {
            CommandError::Other("Native confirmation is unavailable. Try again.".into())
        }
    }
}

fn clear_destructive_action_grants(state: &State<'_, AppState>) -> Result<(), CommandError> {
    state
        .destructive_action_grants
        .clear()
        .map_err(map_grant_error)
}

async fn active_account_id(state: &State<'_, AppState>) -> Result<String, CommandError> {
    state
        .backend
        .backend()
        .active_user_id()
        .await
        .filter(|user_id| !user_id.trim().is_empty())
        .ok_or(CommandError::NotAuthenticated)
}

fn validate_reauthentication_secret(secret: &str) -> Result<(), CommandError> {
    if secret.is_empty() || secret.chars().count() > 4096 {
        return Err(CommandError::Validation(
            "Enter your account password to confirm this action.".into(),
        ));
    }
    Ok(())
}

async fn begin_native_account_transition(
    app: &AppHandle,
    state: &State<'_, AppState>,
    notifications: &State<'_, super::notifications::NotificationRuntimeState>,
) -> Result<NativeAccountTransitionGuard, CommandError> {
    let transition = super::notifications::close_account_admission_and_invalidate(
        app,
        notifications,
        || state.native_requests.close_account_admission(),
    )
        .map_err(|_| {
            CommandError::Other(
                "Mesh is still finishing activity for this account. Try changing accounts again in a moment."
                    .into(),
            )
        })?;

    // Native admission is closed before backend-owned cancellation begins, so
    // no new export can enter the old account generation through a TOCTOU gap.
    state
        .backend
        .backend()
        .cancel_personal_data_export()
        .await
        .map_err(map_error)?;
    state
        .native_requests
        .finish_account_transition(transition)
        .await
        .map_err(|_| {
            CommandError::Other(
                "Mesh is still finishing activity for this account. Try changing accounts again in a moment."
                    .into(),
            )
        })
}

fn begin_native_account_mutation(
    state: &State<'_, AppState>,
    account_generation: u64,
) -> Result<NativeAccountMutationGuard, CommandError> {
    match state
        .native_requests
        .begin_account_mutation(account_generation)
    {
        Ok(guard) => Ok(guard),
        Err(NativeRequestError::CapacityExceeded) => Err(CommandError::RateLimited),
        Err(_) => Err(CommandError::Cancelled(
            "Your account changed before Mesh could finish that action. Try again.".into(),
        )),
    }
}

fn begin_current_account_mutation(
    state: &State<'_, AppState>,
) -> Result<NativeAccountMutationGuard, CommandError> {
    begin_native_account_mutation(state, state.native_requests.account_generation())
}

fn begin_native_ui_interaction(
    state: &State<'_, AppState>,
    account_generation: u64,
) -> Result<NativeUiInteractionGuard, CommandError> {
    match state
        .native_requests
        .begin_native_ui_interaction(account_generation)
    {
        Ok(guard) => Ok(guard),
        Err(NativeRequestError::CapacityExceeded) => Err(CommandError::RateLimited),
        Err(_) => Err(CommandError::Cancelled(
            "Your account changed before Mesh could open that confirmation. Try again.".into(),
        )),
    }
}

#[tauri::command]
pub async fn request_destructive_action_grant(
    action: DestructiveAction,
    target_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    require_matrix(&state)?;
    let account_generation = state.native_requests.account_generation();
    let _native_ui = begin_native_ui_interaction(&state, account_generation)?;
    let account_id = active_account_id(&state).await?;
    let target = action.validate_target(target_id).map_err(map_grant_error)?;
    let (title, message, confirm_label) = action.dialog_copy(&target);
    let confirmed = tokio::task::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                confirm_label.to_owned(),
                "Cancel".to_owned(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|_| CommandError::Other("Native confirmation closed unexpectedly.".into()))?;
    if !confirmed {
        return Ok(None);
    }

    state
        .destructive_action_grants
        .issue(DestructiveActionScope::new(account_id, action, target))
        .map(Some)
        .map_err(map_grant_error)
}

async fn run_native_read<T, F>(
    state: &State<'_, AppState>,
    request_id: String,
    deadline_ms: u64,
    operation: impl Into<String>,
    future: F,
) -> Result<T, CommandError>
where
    F: std::future::Future<Output = Result<T, CommandError>>,
{
    let account_generation = state.native_requests.account_generation();
    // Admission must happen before the first await. Generation is a stronger
    // scope than a remotely supplied account identifier and bounds even tasks
    // waiting to inspect backend status.
    let account_scope = format!("account-generation-{account_generation}");
    match state
        .native_requests
        .run(
            request_id,
            deadline_ms,
            account_generation,
            account_scope,
            operation,
            future,
        )
        .await
    {
        Ok(result) => result,
        Err(NativeRequestError::InvalidRequestId) => Err(CommandError::Validation(
            "invalid native request identifier".into(),
        )),
        Err(NativeRequestError::DuplicateRequestId) => Err(CommandError::Validation(
            "duplicate native request identifier".into(),
        )),
        Err(NativeRequestError::Cancelled) => {
            Err(CommandError::Cancelled("native read cancelled".into()))
        }
        // A native deadline is a completed, typed transient failure. It may be
        // retried sequentially by the renderer because no Rust work remains.
        Err(NativeRequestError::DeadlineExceeded) => Err(CommandError::Network(
            "native read deadline exceeded".into(),
        )),
        Err(NativeRequestError::CapacityExceeded) => Err(CommandError::RateLimited),
        Err(NativeRequestError::SchedulerClosed) => Err(CommandError::Other(
            "native read scheduler is unavailable".into(),
        )),
    }
}

fn matrix_transfer_progress_emitter(app: AppHandle) -> MatrixTransferProgressCallback {
    Arc::new(move |progress| {
        let _ = app.emit(MATRIX_TRANSFER_PROGRESS_EVENT, progress);
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCreatedCommunity {
    community: CommunityDto,
    channel: ChannelDto,
}

#[tauri::command]
pub async fn get_backend_status(
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<BackendStatus, CommandError> {
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "get_backend_status",
        async move { Ok(backend.status().await) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_room_is_encrypted(
    room_id: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_room_is_encrypted",
        async move {
            backend
                .matrix_room_is_encrypted(room_id)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_room_upgrade(
    room_id: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Option<MatrixRoomUpgrade>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_room_upgrade",
        async move {
            backend
                .matrix_room_upgrade(room_id)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_get_room_notification_mode(
    room_id: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<MatrixRoomNotificationMode, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_get_room_notification_mode",
        async move {
            backend
                .matrix_room_notification_mode(room_id)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_set_room_notification_mode(
    room_id: String,
    mode: MatrixRoomNotificationMode,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .matrix_set_room_notification_mode(room_id, mode)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_reserve_login_attempt(
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .reserve_login_attempt()
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_login(
    request: MatrixLogin,
    attempt_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
    notifications: State<'_, super::notifications::NotificationRuntimeState>,
) -> Result<BackendStatus, CommandError> {
    require_matrix(&state)?;
    let _native_transition = begin_native_account_transition(&app, &state, &notifications).await?;
    clear_destructive_action_grants(&state)?;
    state
        .backend
        .backend()
        .login(request, attempt_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn register_account(
    request: MatrixRegistration,
    app: AppHandle,
    state: State<'_, AppState>,
    notifications: State<'_, super::notifications::NotificationRuntimeState>,
) -> Result<BackendStatus, CommandError> {
    require_matrix(&state)?;
    let _native_transition = begin_native_account_transition(&app, &state, &notifications).await?;
    clear_destructive_action_grants(&state)?;
    state
        .backend
        .backend()
        .register_account(request)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn check_username_available(
    homeserver: String,
    username: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "check_username_available",
        async move {
            backend
                .check_username_available(homeserver, username)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_service_capabilities(
    homeserver: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<MatrixServiceCapabilities, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_service_capabilities",
        async move {
            backend
                .service_capabilities(homeserver)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_oidc_status(
    homeserver: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<MatrixOidcStatus, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_oidc_status",
        async move { backend.oidc_status(homeserver).await.map_err(map_error) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_start_oidc_login(
    homeserver: String,
    attempt_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
    notifications: State<'_, super::notifications::NotificationRuntimeState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _native_transition = begin_native_account_transition(&app, &state, &notifications).await?;
    clear_destructive_action_grants(&state)?;
    state
        .backend
        .backend()
        .start_oidc_login(homeserver, attempt_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_cancel_login(
    attempt_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .cancel_login(attempt_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_restore_session(
    app: AppHandle,
    state: State<'_, AppState>,
    notifications: State<'_, super::notifications::NotificationRuntimeState>,
) -> Result<BackendStatus, CommandError> {
    require_matrix(&state)?;
    let _native_transition = begin_native_account_transition(&app, &state, &notifications).await?;
    clear_destructive_action_grants(&state)?;
    state
        .backend
        .backend()
        .restore_session()
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_logout(
    app: AppHandle,
    state: State<'_, AppState>,
    notifications: State<'_, super::notifications::NotificationRuntimeState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _native_transition = begin_native_account_transition(&app, &state, &notifications).await?;
    clear_destructive_action_grants(&state)?;
    state.backend.backend().logout().await.map_err(map_error)
}

#[tauri::command]
pub async fn matrix_devices(
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Vec<MatrixDevice>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_devices",
        async move { backend.list_devices().await.map_err(map_error) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_revoke_device(
    device_id: String,
    password: String,
    presence_grant: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    validate_reauthentication_secret(&password)?;
    let account_id = active_account_id(&state).await?;
    state
        .destructive_action_grants
        .consume(
            &presence_grant,
            &DestructiveActionScope::new(
                account_id,
                DestructiveAction::RevokeDevice,
                device_id.clone(),
            ),
        )
        .map_err(map_grant_error)?;
    state
        .backend
        .backend()
        .revoke_device(device_id, password)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_remove_local_account(
    presence_grant: String,
    app: AppHandle,
    state: State<'_, AppState>,
    notifications: State<'_, super::notifications::NotificationRuntimeState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _native_transition = begin_native_account_transition(&app, &state, &notifications).await?;
    let account_id = active_account_id(&state).await?;
    state
        .destructive_action_grants
        .consume(
            &presence_grant,
            &DestructiveActionScope::new(
                account_id,
                DestructiveAction::RemoveLocalAccount,
                String::new(),
            ),
        )
        .map_err(map_grant_error)?;
    let result = state
        .backend
        .backend()
        .remove_local_account()
        .await
        .map_err(map_error);
    if result.is_ok() {
        clear_destructive_action_grants(&state)?;
    }
    result
}

/// Export to a folder selected by the trusted native picker. The renderer
/// never supplies or controls a filesystem path for this operation.
#[tauri::command]
pub async fn matrix_export_personal_data(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<MatrixPersonalDataExport>, CommandError> {
    require_matrix(&state)?;
    let account_generation = state.native_requests.account_generation();
    let native_ui = begin_native_ui_interaction(&state, account_generation)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = sender.send(path);
    });
    let selected = receiver
        .await
        .map_err(|_| CommandError::Other("Native folder picker closed unexpectedly".into()))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let destination_root = selected
        .into_path()
        .map_err(|_| CommandError::Validation("Choose a local export folder".into()))?;
    drop(native_ui);
    let _account_guard = begin_native_account_mutation(&state, account_generation)?;
    state
        .backend
        .backend()
        .export_personal_data(destination_root)
        .await
        .map(Some)
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_cancel_personal_data_export(
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .cancel_personal_data_export()
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_deactivate_account(
    password: String,
    presence_grant: String,
    app: AppHandle,
    state: State<'_, AppState>,
    notifications: State<'_, super::notifications::NotificationRuntimeState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _native_transition = begin_native_account_transition(&app, &state, &notifications).await?;
    validate_reauthentication_secret(&password)?;
    let account_id = active_account_id(&state).await?;
    state
        .destructive_action_grants
        .consume(
            &presence_grant,
            &DestructiveActionScope::new(
                account_id,
                DestructiveAction::DeactivateAccount,
                String::new(),
            ),
        )
        .map_err(map_grant_error)?;
    let result = state
        .backend
        .backend()
        .deactivate_account(password, true)
        .await
        .map_err(map_error);
    if result.is_ok() {
        clear_destructive_action_grants(&state)?;
    }
    result
}

#[tauri::command]
pub async fn matrix_accounts(
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Vec<MatrixAccount>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_accounts",
        async move { backend.list_accounts().await.map_err(map_error) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_get_profile(
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<MatrixProfile, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_get_profile",
        async move { backend.get_profile().await.map_err(map_error) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_update_profile_display_name(
    display_name: String,
    state: State<'_, AppState>,
) -> Result<MatrixProfile, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .update_profile_display_name(display_name)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_switch_account(
    profile_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
    notifications: State<'_, super::notifications::NotificationRuntimeState>,
) -> Result<BackendStatus, CommandError> {
    require_matrix(&state)?;
    let _native_transition = begin_native_account_transition(&app, &state, &notifications).await?;
    clear_destructive_action_grants(&state)?;
    state
        .backend
        .backend()
        .switch_account(profile_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_recovery_health(
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<MatrixRecoveryHealth, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_recovery_health",
        async move { backend.recovery_health().await.map_err(map_error) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_test_recovery(
    recovery_key_or_passphrase: String,
    state: State<'_, AppState>,
) -> Result<MatrixRecoveryHealth, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .test_recovery(recovery_key_or_passphrase)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_test_stored_recovery(
    state: State<'_, AppState>,
) -> Result<MatrixRecoveryHealth, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .test_stored_recovery()
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_start_device_verification(
    device_id: String,
    state: State<'_, AppState>,
) -> Result<MatrixVerificationSession, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .start_device_verification(device_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_device_verification_status(
    verification_id: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<MatrixVerificationSession, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_device_verification_status",
        async move {
            backend
                .device_verification_status(verification_id)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_select_device_verification_method(
    verification_id: String,
    method: String,
    state: State<'_, AppState>,
) -> Result<MatrixVerificationSession, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .select_device_verification_method(verification_id, method)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_confirm_device_verification(
    verification_id: String,
    matches: bool,
    state: State<'_, AppState>,
) -> Result<MatrixVerificationSession, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .confirm_device_verification(verification_id, matches)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_cancel_device_verification(
    verification_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .cancel_device_verification(verification_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_user_preferences(
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Option<UserPreferences>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_user_preferences",
        async move { backend.user_preferences().await.map_err(map_error) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_update_user_preferences(
    preferences: UserPreferences,
    state: State<'_, AppState>,
) -> Result<UserPreferences, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .update_user_preferences(preferences)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_create_community(
    name: String,
    description: String,
    state: State<'_, AppState>,
) -> Result<MatrixCreatedCommunity, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    let created = state
        .backend
        .backend()
        .create_community(name.clone(), description.clone())
        .await
        .map_err(map_error)?;
    Ok(MatrixCreatedCommunity {
        community: CommunityDto {
            id: created.space_id.clone(),
            name,
            description,
            member_count: 1,
            role: "owner".into(),
            joined_at: Some(chrono::Utc::now().to_rfc3339()),
        },
        channel: ChannelDto {
            id: created.channel_id,
            community_id: created.space_id,
            name: "general".into(),
            channel_type: "text".into(),
            unread_count: 0,
        },
    })
}

#[tauri::command]
pub async fn matrix_list_communities(
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<crate::backend::EntityList<CommunityDto>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_list_communities",
        async move { backend.list_communities().await.map_err(map_error) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_list_channels(
    community_id: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<crate::backend::EntityList<ChannelDto>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_list_channels",
        async move { backend.list_channels(community_id).await.map_err(map_error) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_create_channel(
    community_id: String,
    name: String,
    channel_type: String,
    state: State<'_, AppState>,
) -> Result<ChannelDto, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .create_channel(community_id, name, channel_type)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_list_custom_emoji(
    community_id: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Vec<CustomEmoji>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_list_custom_emoji",
        async move {
            backend
                .list_custom_emoji(community_id)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_upload_custom_emoji(
    community_id: String,
    shortcode: String,
    grant: String,
    attachment_grants: State<'_, AttachmentGrantStore>,
    state: State<'_, AppState>,
) -> Result<CustomEmoji, CommandError> {
    require_matrix(&state)?;
    let account_generation = state.native_requests.account_generation();
    let _account_guard = begin_native_account_mutation(&state, account_generation)?;
    let user_id = state
        .backend
        .backend()
        .status()
        .await
        .user_id
        .ok_or(CommandError::NotAuthenticated)?;
    let (filename, content_type, bytes) = attachment_grants
        .claim_custom_emoji(&grant, &community_id, account_generation, &user_id)
        .await?;
    state
        .backend
        .backend()
        .upload_custom_emoji(community_id, shortcode, filename, content_type, bytes)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_remove_custom_emoji(
    community_id: String,
    shortcode: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .remove_custom_emoji(community_id, shortcode)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_load_custom_emoji_image(
    community_id: String,
    shortcode: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_load_custom_emoji_image",
        async move {
            backend
                .load_custom_emoji_image(community_id, shortcode)
                .await
                .map(tauri::ipc::Response::new)
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_rtc_join(
    room_id: String,
    state: State<'_, AppState>,
) -> Result<MatrixRtcJoinResult, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .matrix_rtc_join(room_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_rtc_refresh_membership(
    room_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MatrixRtcMember>, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .matrix_rtc_refresh_membership(room_id, session_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_rtc_ack_media_key_pause(
    room_id: String,
    session_id: String,
    member_id: String,
    activation_id: String,
    state: State<'_, AppState>,
) -> Result<MatrixRtcMediaKey, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .matrix_rtc_ack_media_key_pause(room_id, session_id, member_id, activation_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_rtc_ack_media_key(
    room_id: String,
    session_id: String,
    member_id: String,
    activation_id: String,
    key_index: u8,
    sent_ts: u64,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .matrix_rtc_ack_media_key(
            room_id,
            session_id,
            member_id,
            activation_id,
            key_index,
            sent_ts,
        )
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_rtc_renew_media_key_lease(
    room_id: String,
    session_id: String,
    member_id: String,
    state: State<'_, AppState>,
) -> Result<MatrixRtcMediaKeyLease, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .matrix_rtc_renew_media_key_lease(room_id, session_id, member_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_rtc_leave(
    room_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .matrix_rtc_leave(room_id, session_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_rtc_members(
    room_id: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Vec<MatrixRtcMember>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_rtc_members",
        async move { backend.matrix_rtc_members(room_id).await.map_err(map_error) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_send_message(
    room_id: String,
    body: String,
    reply_to_id: Option<String>,
    thread_root_id: Option<String>,
    transaction_id: String,
    state: State<'_, AppState>,
) -> Result<MessageDto, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .send_message(room_id, body, reply_to_id, thread_root_id, transaction_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_queued_messages(
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Vec<MessageDto>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_queued_messages",
        async move { backend.queued_messages().await.map_err(map_error) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_retry_queued_message(
    room_id: String,
    transaction_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .retry_queued_message(room_id, transaction_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_cancel_queued_message(
    room_id: String,
    transaction_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .cancel_queued_message(room_id, transaction_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_save_composer_draft(
    room_id: String,
    body: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .save_composer_draft(room_id, body)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_load_composer_draft(
    room_id: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_load_composer_draft",
        async move {
            backend
                .load_composer_draft(room_id)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_clear_composer_draft(
    room_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .clear_composer_draft(room_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn matrix_send_attachment(
    room_id: String,
    attachment_grant: String,
    body: String,
    reply_to_id: Option<String>,
    thread_root_id: Option<String>,
    transfer_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
    grants: State<'_, AttachmentGrantStore>,
) -> Result<MessageDto, CommandError> {
    require_matrix(&state)?;
    let account_generation = state.native_requests.account_generation();
    let _account_guard = begin_native_account_mutation(&state, account_generation)?;
    let account_id = active_account_id(&state).await?;
    let claimed = grants
        .claim_to_staging(
            &attachment_grant,
            &super::attachments::staging_root(&app)?,
            account_generation,
            &account_id,
        )
        .await?;
    let result = state
        .backend
        .backend()
        .send_attachment(
            room_id,
            MatrixAttachmentSendRequest {
                transaction_id: transfer_id.clone(),
                file_path: claimed.path(),
                filename: claimed.filename(),
                content_type: Some(claimed.content_type()),
                body,
                reply_to_id,
                thread_root_id,
            },
            MatrixTransferObserver {
                transfer_id,
                progress: matrix_transfer_progress_emitter(app),
            },
        )
        .await;
    match result {
        Ok(message) => {
            claimed.cleanup().await;
            Ok(message)
        }
        Err(error) => {
            grants.restore(claimed).await;
            Err(map_error(error))
        }
    }
}

#[tauri::command]
pub async fn matrix_cancel_attachment_upload(
    transfer_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .cancel_attachment_upload(transfer_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_download_attachment(
    room_id: String,
    event_id: String,
    attachment_index: u32,
    transfer_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .download_attachment(
            room_id,
            event_id,
            attachment_index,
            MatrixTransferObserver {
                transfer_id,
                progress: matrix_transfer_progress_emitter(app),
            },
        )
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_load_attachment_image(
    room_id: String,
    event_id: String,
    attachment_index: u32,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_load_attachment_image",
        async move {
            backend
                .load_attachment_image(room_id, event_id, attachment_index)
                .await
                .map(tauri::ipc::Response::new)
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_cancel_attachment_download(
    file_hash: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .cancel_attachment_download(file_hash)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_dm_conversations(
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<crate::backend::EntityList<DmConversationDto>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_dm_conversations",
        async move { backend.dm_conversations().await.map_err(map_error) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_dm_requests(
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Vec<DmRequestDto>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_dm_requests",
        async move { backend.dm_requests().await.map_err(map_error) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_blocked_accounts(
    after: Option<String>,
    limit: u32,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<BlockedAccountPageDto, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_blocked_accounts",
        async move {
            backend
                .blocked_accounts(after, limit)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_accept_dm_request(
    room_id: String,
    state: State<'_, AppState>,
) -> Result<DmConversationDto, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .accept_dm_request(room_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_decline_dm_request(
    room_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .decline_dm_request(room_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_block_dm_request(
    room_id: String,
    state: State<'_, AppState>,
) -> Result<BlockedAccountDto, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .block_dm_request(room_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_ensure_dm(
    recipient_user_id: String,
    state: State<'_, AppState>,
) -> Result<DmConversationDto, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .ensure_dm(recipient_user_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_dm_messages(
    conversation_id: String,
    limit: u32,
    before_timestamp: Option<String>,
    before_id: Option<String>,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Vec<DirectMessageDto>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_dm_messages",
        async move {
            backend
                .dm_messages(conversation_id, limit, before_timestamp, before_id)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_send_dm(
    recipient_user_id: String,
    body: String,
    reply_to_id: Option<String>,
    thread_root_id: Option<String>,
    transaction_id: String,
    state: State<'_, AppState>,
) -> Result<DirectMessageDto, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .send_dm(
            recipient_user_id,
            body,
            reply_to_id,
            thread_root_id,
            transaction_id,
        )
        .await
        .map_err(map_error)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn matrix_send_dm_attachment(
    recipient_user_id: String,
    attachment_grant: String,
    body: String,
    reply_to_id: Option<String>,
    thread_root_id: Option<String>,
    transfer_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
    grants: State<'_, AttachmentGrantStore>,
) -> Result<DirectMessageDto, CommandError> {
    require_matrix(&state)?;
    let account_generation = state.native_requests.account_generation();
    let _account_guard = begin_native_account_mutation(&state, account_generation)?;
    let account_id = active_account_id(&state).await?;
    let claimed = grants
        .claim_to_staging(
            &attachment_grant,
            &super::attachments::staging_root(&app)?,
            account_generation,
            &account_id,
        )
        .await?;
    let result = state
        .backend
        .backend()
        .send_dm_attachment(
            recipient_user_id,
            MatrixAttachmentSendRequest {
                transaction_id: transfer_id.clone(),
                file_path: claimed.path(),
                filename: claimed.filename(),
                content_type: Some(claimed.content_type()),
                body,
                reply_to_id,
                thread_root_id,
            },
            MatrixTransferObserver {
                transfer_id,
                progress: matrix_transfer_progress_emitter(app),
            },
        )
        .await;
    match result {
        Ok(message) => {
            claimed.cleanup().await;
            Ok(message)
        }
        Err(error) => {
            grants.restore(claimed).await;
            Err(map_error(error))
        }
    }
}

#[tauri::command]
pub async fn matrix_mark_dm_read(
    conversation_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .mark_dm_read(conversation_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_set_dm_blocked(
    recipient_user_id: String,
    blocked: bool,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .set_dm_blocked(recipient_user_id, blocked)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_dm_blocked(
    recipient_user_id: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_dm_blocked",
        async move {
            backend
                .dm_blocked(recipient_user_id)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_get_messages(
    room_id: String,
    limit: u32,
    before_timestamp: Option<String>,
    before_id: Option<String>,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Vec<MessageDto>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_get_messages",
        async move {
            backend
                .messages(room_id, limit, before_timestamp, before_id)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_edit_message(
    room_id: String,
    event_id: String,
    body: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .edit_message(room_id, event_id, body)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_redact_message(
    room_id: String,
    event_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .redact_message(room_id, event_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_report_message(
    room_id: String,
    event_id: String,
    reason: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .report_message(room_id, event_id, reason)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_toggle_reaction(
    room_id: String,
    event_id: String,
    key: String,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .toggle_reaction(room_id, event_id, key)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_room_pins(
    room_id: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<MatrixRoomPins, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_room_pins",
        async move { backend.room_pins(room_id).await.map_err(map_error) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_toggle_room_pin(
    room_id: String,
    event_id: String,
    state: State<'_, AppState>,
) -> Result<MatrixRoomPins, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .toggle_room_pin(room_id, event_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_mark_read(
    room_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .mark_read(room_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_mark_rooms_read(
    room_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, CommandError> {
    const MAX_ROOMS_PER_BATCH: usize = 100;

    require_matrix(&state)?;
    if room_ids.len() > MAX_ROOMS_PER_BATCH
        || room_ids
            .iter()
            .any(|room_id| room_id.is_empty() || room_id.len() > 255)
    {
        return Err(CommandError::Validation(
            "Choose up to 100 valid rooms to mark as read.".into(),
        ));
    }
    let _account_guard = begin_current_account_mutation(&state)?;
    let mut seen = HashSet::new();
    let room_ids = room_ids
        .into_iter()
        .filter(|room_id| seen.insert(room_id.clone()))
        .collect::<Vec<_>>();
    let backend = state.backend.backend();
    let failed = futures::stream::iter(room_ids.into_iter().map(|room_id| {
        let backend = Arc::clone(&backend);
        async move {
            backend
                .mark_read(room_id.clone())
                .await
                .err()
                .map(|_| room_id)
        }
    }))
    .buffer_unordered(4)
    .filter_map(|failed_room_id| async move { failed_room_id })
    .collect()
    .await;
    Ok(failed)
}

#[tauri::command]
pub async fn matrix_set_typing(
    room_id: String,
    typing: bool,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .set_typing(room_id, typing)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_typing_users(
    room_id: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Vec<TypingUser>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_typing_users",
        async move { backend.typing_users(room_id).await.map_err(map_error) },
    )
    .await
}

#[tauri::command]
pub async fn matrix_search_messages(
    community_id: String,
    query: String,
    limit: u32,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Vec<MessageDto>, CommandError> {
    require_matrix(&state)?;
    let operation = format!("matrix_search_messages:{community_id}");
    let native_request_id = request_id.clone();
    let backend = state.backend.backend();
    run_native_read(
        &state,
        native_request_id,
        deadline_ms,
        operation,
        async move {
            backend
                .search_messages(community_id, query, limit, request_id, deadline_ms)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_cancel_search(
    request_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .cancel_search(request_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_wait_for_room_update(
    room_id: String,
    timeout_ms: u64,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    require_matrix(&state)?;
    let operation = format!("matrix_wait_for_room_update:{room_id}");
    let backend = state.backend.backend();
    run_native_read(&state, request_id, deadline_ms, operation, async move {
        backend
            .wait_for_room_update(room_id, timeout_ms)
            .await
            .map_err(map_error)
    })
    .await
}

#[tauri::command]
pub async fn matrix_list_members(
    community_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<CommunityMemberPage, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_list_members",
        async move {
            backend
                .list_member_page(community_id, cursor, limit)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_get_community_permission_projection(
    community_id: String,
    subject_user_id: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<CommunityPermissionProjection, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_get_community_permission_projection",
        async move {
            backend
                .community_permission_projection(community_id, subject_user_id)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_invite_to_community(
    community_id: String,
    username: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .invite_to_community(community_id, username)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_create_community_invite(
    community_id: String,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .create_community_invite(community_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_community_access_settings(
    community_id: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<CommunityAccessSettings, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_community_access_settings",
        async move {
            backend
                .community_access_settings(community_id)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_update_community_access(
    community_id: String,
    alias: Option<String>,
    discoverable: bool,
    state: State<'_, AppState>,
) -> Result<CommunityAccessSettings, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .update_community_access(community_id, alias, discoverable)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_search_community_directory(
    query: String,
    server: Option<String>,
    limit: u32,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Vec<CommunityDirectoryEntry>, CommandError> {
    require_matrix(&state)?;
    let operation = format!(
        "matrix_search_community_directory:{}",
        server.as_deref().unwrap_or("account-service")
    );
    let native_request_id = request_id.clone();
    let backend = state.backend.backend();
    run_native_read(
        &state,
        native_request_id,
        deadline_ms,
        operation,
        async move {
            backend
                .search_community_directory(query, server, limit, request_id, deadline_ms)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_knock_community(
    room_or_alias: String,
    reason: Option<String>,
    via: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<CommunityAccessResult, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .knock_community(room_or_alias, reason, via.unwrap_or_default())
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_list_community_applications(
    community_id: String,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Vec<CommunityApplication>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_list_community_applications",
        async move {
            backend
                .list_community_applications(community_id)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_respond_community_application(
    community_id: String,
    user_id: String,
    accept: bool,
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .respond_community_application(community_id, user_id, accept, reason)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_join_community(
    room_or_alias: String,
    via: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<CommunityDto, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .join_community(room_or_alias, via.unwrap_or_default())
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_join_room(
    room_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .join_room(room_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_leave_community(
    community_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .leave_community(community_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_update_community(
    community_id: String,
    name: String,
    description: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .update_community(community_id, name, description)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_update_member_role(
    _community_id: String,
    _user_id: String,
    _role: String,
    state: State<'_, AppState>,
) -> Result<CommunityModerationResult, CommandError> {
    require_matrix(&state)?;
    Err(CommandError::Unsupported(
        "Changing administrator access is unavailable in this beta because the account service cannot yet re-confirm the change safely. Existing administrators keep their access."
            .into(),
    ))
}

#[tauri::command]
pub async fn matrix_kick_member(
    community_id: String,
    user_id: String,
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<CommunityModerationResult, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .kick_member(community_id, user_id, reason)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_ban_member(
    community_id: String,
    user_id: String,
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<CommunityModerationResult, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .ban_member(community_id, user_id, reason)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_list_moderation_audit(
    community_id: String,
    limit: u32,
    request_id: String,
    deadline_ms: u64,
    state: State<'_, AppState>,
) -> Result<Vec<ModerationAuditEntry>, CommandError> {
    require_matrix(&state)?;
    let backend = state.backend.backend();
    run_native_read(
        &state,
        request_id,
        deadline_ms,
        "matrix_list_moderation_audit",
        async move {
            backend
                .list_moderation_audit(community_id, limit)
                .await
                .map_err(map_error)
        },
    )
    .await
}

#[tauri::command]
pub async fn matrix_sync_once(state: State<'_, AppState>) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state.backend.backend().sync_once().await.map_err(map_error)
}

#[tauri::command]
pub async fn matrix_enable_recovery(
    passphrase: Option<String>,
    state: State<'_, AppState>,
) -> Result<MatrixRecoverySetupResult, CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .enable_recovery(passphrase)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_recover(
    recovery_key_or_passphrase: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    let _account_guard = begin_current_account_mutation(&state)?;
    state
        .backend
        .backend()
        .recover(recovery_key_or_passphrase)
        .await
        .map_err(map_error)
}

#[cfg(test)]
mod tests {
    #[test]
    fn security_boundary_room_and_dm_attachment_sends_claim_only_current_account_grants() {
        let source = include_str!("backend.rs");
        for (start, end) in [
            (
                "pub async fn matrix_send_attachment(",
                "pub async fn matrix_cancel_attachment_upload(",
            ),
            (
                "pub async fn matrix_send_dm_attachment(",
                "pub async fn matrix_mark_dm_read(",
            ),
        ] {
            let command = source
                .split(start)
                .nth(1)
                .unwrap()
                .split(end)
                .next()
                .unwrap();
            let generation = command.find("account_generation()").unwrap();
            let guard = command
                .find("begin_native_account_mutation(&state, account_generation)")
                .unwrap();
            let account = command.find("active_account_id(&state).await").unwrap();
            let claim = command.find(".claim_to_staging(").unwrap();
            assert!(generation < guard && guard < account && account < claim);
            let claim_arguments = command
                .split(".claim_to_staging(")
                .nth(1)
                .unwrap()
                .split(".await?;")
                .next()
                .unwrap();
            assert!(claim_arguments.contains("account_generation"));
            assert!(claim_arguments.contains("&account_id"));
            assert!(command.contains("grants.restore(claimed).await"));
        }
    }
}
