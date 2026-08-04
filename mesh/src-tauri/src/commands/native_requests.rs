use tauri::State;

use crate::state::{native_requests::NativeCancellationStatus, AppState};

use super::error::CommandError;

/// Cancel one renderer-owned read and wait until Rust has dropped its future.
/// `Completed` is also returned for a recently completed request so timeout and
/// completion races never tempt the renderer to start overlapping work.
#[tauri::command]
pub async fn cancel_native_request(
    request_id: String,
    state: State<'_, AppState>,
) -> Result<NativeCancellationStatus, CommandError> {
    let status = state.native_requests.cancel(&request_id).await;
    Ok(status)
}
