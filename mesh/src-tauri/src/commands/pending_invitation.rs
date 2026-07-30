use tauri::State;

use crate::backend::PendingInvitationMetadata;
use crate::state::AppState;

use super::{backend, error::CommandError};

/// Store an invitation in the encrypted native pending-invitation store.
///
/// The URL is accepted only as an IPC argument and is never returned to the
/// renderer by this command. The backend owns its encrypted persistence and
/// keychain key.
#[tauri::command]
pub async fn store_pending_invitation(
    invite_link: String,
    state: State<'_, AppState>,
) -> Result<PendingInvitationMetadata, CommandError> {
    backend::require_matrix(&state)?;
    state
        .backend
        .backend()
        .store_pending_invitation(invite_link)
        .await
        .map_err(backend::map_error)
}

/// Read the pending invitation for an immediate join attempt.
///
/// The native store retains the invitation until the join succeeds or the user
/// explicitly discards it, so a process crash cannot lose the invitation.
#[tauri::command]
pub async fn read_pending_invitation(
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    backend::require_matrix(&state)?;
    state
        .backend
        .backend()
        .read_pending_invitation()
        .await
        .map_err(backend::map_error)
}

/// Consume and return the pending invitation exactly once.
#[tauri::command]
pub async fn take_pending_invitation(
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    backend::require_matrix(&state)?;
    state
        .backend
        .backend()
        .take_pending_invitation()
        .await
        .map_err(backend::map_error)
}

/// Read non-secret invitation metadata without exposing the invitation URL.
#[tauri::command]
pub async fn peek_pending_invitation(
    state: State<'_, AppState>,
) -> Result<Option<PendingInvitationMetadata>, CommandError> {
    backend::require_matrix(&state)?;
    state
        .backend
        .backend()
        .peek_pending_invitation()
        .await
        .map_err(backend::map_error)
}

/// Resolve the stored invitation for onboarding without consuming it.
#[tauri::command]
pub async fn resolve_pending_invitation(
    state: State<'_, AppState>,
) -> Result<Option<crate::backend::MatrixCommunityAdmission>, CommandError> {
    backend::require_matrix(&state)?;
    state
        .backend
        .backend()
        .resolve_pending_invitation()
        .await
        .map_err(backend::map_error)
}

/// Discard the pending invitation after explicit user action.
#[tauri::command]
pub async fn clear_pending_invitation(state: State<'_, AppState>) -> Result<(), CommandError> {
    backend::require_matrix(&state)?;
    state
        .backend
        .backend()
        .clear_pending_invitation()
        .await
        .map_err(backend::map_error)
}
