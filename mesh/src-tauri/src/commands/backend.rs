//! Typed Tauri IPC for the backend boundary and Matrix architecture spike.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

use crate::backend::{
    BackendError, BackendKind, BackendStatus, CommunityAccessResult, CommunityAccessSettings,
    CommunityApplication, CommunityDirectoryEntry, CommunityMember, CommunityModerationResult,
    CommunityPermissionProjection, CustomEmoji, MatrixAccount, MatrixAttachmentSendRequest,
    MatrixDevice, MatrixLogin, MatrixOidcStatus, MatrixPersonalDataExport, MatrixProfile,
    MatrixRecoveryHealth, MatrixRecoverySetupResult, MatrixRegistration,
    MatrixRoomNotificationMode, MatrixRoomPins, MatrixRoomUpgrade, MatrixRtcJoinResult,
    MatrixRtcMediaKey, MatrixRtcMediaKeyLease, MatrixRtcMember, MatrixServiceCapabilities,
    MatrixTransferObserver, MatrixTransferProgressCallback, MatrixVerificationSession,
    ModerationAuditEntry, TypingUser, UserPreferences, MATRIX_TRANSFER_PROGRESS_EVENT,
};
use crate::state::AppState;
use crate::types::{
    community::{ChannelDto, CommunityDto},
    dm::{DirectMessageDto, DmConversationDto},
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
pub async fn get_backend_status(state: State<'_, AppState>) -> Result<BackendStatus, CommandError> {
    Ok(state.backend.backend().status().await)
}

#[tauri::command]
pub async fn matrix_room_is_encrypted(
    room_id: String,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .matrix_room_is_encrypted(room_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_room_upgrade(
    room_id: String,
    state: State<'_, AppState>,
) -> Result<Option<MatrixRoomUpgrade>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .matrix_room_upgrade(room_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_get_room_notification_mode(
    room_id: String,
    state: State<'_, AppState>,
) -> Result<MatrixRoomNotificationMode, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .matrix_room_notification_mode(room_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_set_room_notification_mode(
    room_id: String,
    mode: MatrixRoomNotificationMode,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .matrix_set_room_notification_mode(room_id, mode)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_login(
    request: MatrixLogin,
    state: State<'_, AppState>,
) -> Result<BackendStatus, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .login(request)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn register_account(
    request: MatrixRegistration,
    state: State<'_, AppState>,
) -> Result<BackendStatus, CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .check_username_available(homeserver, username)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_service_capabilities(
    homeserver: String,
    state: State<'_, AppState>,
) -> Result<MatrixServiceCapabilities, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .service_capabilities(homeserver)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_oidc_status(
    homeserver: String,
    state: State<'_, AppState>,
) -> Result<MatrixOidcStatus, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .oidc_status(homeserver)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_start_oidc_login(
    homeserver: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .start_oidc_login(homeserver)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_cancel_login(state: State<'_, AppState>) -> Result<(), CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .cancel_login()
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_restore_session(
    state: State<'_, AppState>,
) -> Result<BackendStatus, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .restore_session()
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_logout(state: State<'_, AppState>) -> Result<(), CommandError> {
    require_matrix(&state)?;
    state.backend.backend().logout().await.map_err(map_error)
}

#[tauri::command]
pub async fn matrix_devices(state: State<'_, AppState>) -> Result<Vec<MatrixDevice>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .list_devices()
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_revoke_device(
    device_id: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .revoke_device(device_id, password)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_remove_local_account(state: State<'_, AppState>) -> Result<(), CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .remove_local_account()
        .await
        .map_err(map_error)
}

/// Export to a folder selected by the trusted native picker. The renderer
/// never supplies or controls a filesystem path for this operation.
#[tauri::command]
pub async fn matrix_export_personal_data(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<MatrixPersonalDataExport>, CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .deactivate_account(password, true)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_accounts(
    state: State<'_, AppState>,
) -> Result<Vec<MatrixAccount>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .list_accounts()
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_get_profile(state: State<'_, AppState>) -> Result<MatrixProfile, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .get_profile()
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_update_profile_display_name(
    display_name: String,
    state: State<'_, AppState>,
) -> Result<MatrixProfile, CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<BackendStatus, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .switch_account(profile_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_recovery_health(
    state: State<'_, AppState>,
) -> Result<MatrixRecoveryHealth, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .recovery_health()
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_test_recovery(
    recovery_key_or_passphrase: String,
    state: State<'_, AppState>,
) -> Result<MatrixRecoveryHealth, CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<MatrixVerificationSession, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .device_verification_status(verification_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_select_device_verification_method(
    verification_id: String,
    method: String,
    state: State<'_, AppState>,
) -> Result<MatrixVerificationSession, CommandError> {
    require_matrix(&state)?;
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
    state
        .backend
        .backend()
        .cancel_device_verification(verification_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_user_preferences(
    state: State<'_, AppState>,
) -> Result<Option<UserPreferences>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .user_preferences()
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_update_user_preferences(
    preferences: UserPreferences,
    state: State<'_, AppState>,
) -> Result<UserPreferences, CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<crate::backend::EntityList<CommunityDto>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .list_communities()
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_list_channels(
    community_id: String,
    state: State<'_, AppState>,
) -> Result<crate::backend::EntityList<ChannelDto>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .list_channels(community_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_create_channel(
    community_id: String,
    name: String,
    channel_type: String,
    state: State<'_, AppState>,
) -> Result<ChannelDto, CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<Vec<CustomEmoji>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .list_custom_emoji(community_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_upload_custom_emoji(
    community_id: String,
    shortcode: String,
    filename: String,
    content_type: String,
    bytes: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<CustomEmoji, CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .load_custom_emoji_image(community_id, shortcode)
        .await
        .map(tauri::ipc::Response::new)
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_rtc_join(
    room_id: String,
    state: State<'_, AppState>,
) -> Result<MatrixRtcJoinResult, CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<Vec<MatrixRtcMember>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .matrix_rtc_members(room_id)
        .await
        .map_err(map_error)
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
    state
        .backend
        .backend()
        .send_message(room_id, body, reply_to_id, thread_root_id, transaction_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_queued_messages(
    state: State<'_, AppState>,
) -> Result<Vec<MessageDto>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .queued_messages()
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_retry_queued_message(
    room_id: String,
    transaction_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .load_composer_draft(room_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_clear_composer_draft(
    room_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
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
    let claimed = grants
        .claim_to_staging(&attachment_grant, &super::attachments::staging_root(&app)?)
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
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .load_attachment_image(room_id, event_id, attachment_index)
        .await
        .map(tauri::ipc::Response::new)
        .map_err(map_error)
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
    state: State<'_, AppState>,
) -> Result<crate::backend::EntityList<DmConversationDto>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .dm_conversations()
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_ensure_dm(
    recipient_user_id: String,
    state: State<'_, AppState>,
) -> Result<DmConversationDto, CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<Vec<DirectMessageDto>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .dm_messages(conversation_id, limit, before_timestamp, before_id)
        .await
        .map_err(map_error)
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
    let claimed = grants
        .claim_to_staging(&attachment_grant, &super::attachments::staging_root(&app)?)
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
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .dm_blocked(recipient_user_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_get_messages(
    room_id: String,
    limit: u32,
    before_timestamp: Option<String>,
    before_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<MessageDto>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .messages(room_id, limit, before_timestamp, before_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_edit_message(
    room_id: String,
    event_id: String,
    body: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<MatrixRoomPins, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .room_pins(room_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_toggle_room_pin(
    room_id: String,
    event_id: String,
    state: State<'_, AppState>,
) -> Result<MatrixRoomPins, CommandError> {
    require_matrix(&state)?;
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
    state
        .backend
        .backend()
        .mark_read(room_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_set_typing(
    room_id: String,
    typing: bool,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<Vec<TypingUser>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .typing_users(room_id)
        .await
        .map_err(map_error)
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
    state
        .backend
        .backend()
        .search_messages(community_id, query, limit, request_id, deadline_ms)
        .await
        .map_err(map_error)
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
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .wait_for_room_update(room_id, timeout_ms)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_list_members(
    community_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CommunityMember>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .list_members(community_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_get_community_permission_projection(
    community_id: String,
    subject_user_id: String,
    state: State<'_, AppState>,
) -> Result<CommunityPermissionProjection, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .community_permission_projection(community_id, subject_user_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_invite_to_community(
    community_id: String,
    username: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<CommunityAccessSettings, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .community_access_settings(community_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_update_community_access(
    community_id: String,
    alias: Option<String>,
    discoverable: bool,
    state: State<'_, AppState>,
) -> Result<CommunityAccessSettings, CommandError> {
    require_matrix(&state)?;
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
    state
        .backend
        .backend()
        .search_community_directory(query, server, limit, request_id, deadline_ms)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_knock_community(
    room_or_alias: String,
    reason: Option<String>,
    via: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<CommunityAccessResult, CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<Vec<CommunityApplication>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .list_community_applications(community_id)
        .await
        .map_err(map_error)
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
    state
        .backend
        .backend()
        .update_community(community_id, name, description)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_update_member_role(
    community_id: String,
    user_id: String,
    role: String,
    state: State<'_, AppState>,
) -> Result<CommunityModerationResult, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .update_member_role(community_id, user_id, role)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_kick_member(
    community_id: String,
    user_id: String,
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<CommunityModerationResult, CommandError> {
    require_matrix(&state)?;
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
    state: State<'_, AppState>,
) -> Result<Vec<ModerationAuditEntry>, CommandError> {
    require_matrix(&state)?;
    state
        .backend
        .backend()
        .list_moderation_audit(community_id, limit)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn matrix_sync_once(state: State<'_, AppState>) -> Result<(), CommandError> {
    require_matrix(&state)?;
    state.backend.backend().sync_once().await.map_err(map_error)
}

#[tauri::command]
pub async fn matrix_enable_recovery(
    passphrase: Option<String>,
    state: State<'_, AppState>,
) -> Result<MatrixRecoverySetupResult, CommandError> {
    require_matrix(&state)?;
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
    state
        .backend
        .backend()
        .recover(recovery_key_or_passphrase)
        .await
        .map_err(map_error)
}
