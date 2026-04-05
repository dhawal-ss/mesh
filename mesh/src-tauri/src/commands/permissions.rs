use tauri::State;

use crate::state::AppState;
use crate::storage::Database;

use super::error::CommandError;

pub async fn require_community_permission(
    state: &State<'_, AppState>,
    db: &Database,
    community_id: &str,
    required_role: &str,
) -> Result<String, CommandError> {
    let public_key = {
        let identity = state.identity.read().await;
        let identity = identity
            .as_ref()
            .ok_or(CommandError::Identity("No identity loaded".into()))?;
        identity.public_key_b64.clone()
    };

    state.membership.load_community(db, community_id)?;

    if !state
        .membership
        .has_permission(community_id, &public_key, required_role)?
    {
        return Err(CommandError::PermissionDenied(match required_role {
            "owner" => "Owner permission required".into(),
            "admin" => "Admin permission required".into(),
            _ => "Insufficient community permission".into(),
        }));
    }

    Ok(public_key)
}
