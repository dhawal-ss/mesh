use tauri::State;

use crate::backend::PendingInvitationMetadata;
use crate::state::AppState;
use crate::types::community::CommunityDto;

use super::{backend, error::CommandError};

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

/// Resolve, claim, and join only after explicit confirmation of the opaque
/// handle. The native store consumes the secret only after a successful join.
#[tauri::command]
pub async fn join_pending_invitation(
    handle: String,
    state: State<'_, AppState>,
) -> Result<CommunityDto, CommandError> {
    backend::require_matrix(&state)?;
    state
        .backend
        .backend()
        .join_pending_invitation(handle)
        .await
        .map_err(backend::map_error)
}

/// Discard the pending invitation after explicit user action.
#[tauri::command]
pub async fn clear_pending_invitation(
    handle: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    backend::require_matrix(&state)?;
    state
        .backend
        .backend()
        .clear_pending_invitation(handle)
        .await
        .map_err(backend::map_error)
}
