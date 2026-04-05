use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use tauri::{AppHandle, State};

use crate::commands::control;
use crate::commands::error::CommandError;
use crate::commands::permissions::require_community_permission;
use crate::crypto::encryption;
use crate::crypto::key_rotation;
use crate::network::events::NetworkCommand;
use crate::state::AppState;
use crate::storage::Database;

#[tauri::command]
pub async fn ban_user(
    community_id: String,
    banned_public_key: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<(), CommandError> {
    let caller_public_key =
        require_community_permission(&state, &db, &community_id, "owner").await?;
    let identity = state.identity.read().await;
    let identity = identity.as_ref().ok_or(CommandError::Identity("No identity loaded".into()))?;
    if identity.public_key_b64 != caller_public_key {
        return Err(CommandError::Validation("Loaded identity does not match caller permission state".into()));
    }
    let community_id_c = community_id.clone();
    let community_key = db
        .run_blocking(move |db| db.get_community_keypair(&community_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?
        .ok_or(CommandError::PermissionDenied("Only the community owner can ban members".into()))?;
    let community_id_c = community_id.clone();
    let old_group_key_b64 = db
        .run_blocking(move |db| db.get_group_key(&community_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?
        .ok_or(CommandError::NotFound("Missing community group key".into()))?;
    let old_group_key =
        encryption::group_key_from_b64(&old_group_key_b64).map_err(|e| CommandError::Other(e.to_string()))?;

    // 1. Create and apply the ban control event
    let ban_payload = serde_json::json!({
        "publicKey": banned_public_key,
    });
    let community_id_c = community_id.clone();
    let owner_public_key = db
        .run_blocking(move |db| db.get_community_owner_public_key(&community_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?
        .ok_or(CommandError::NotFound("Community owner key missing".into()))?;
    let ban_event =
        control::create_control_event(&community_id, "member_ban", ban_payload, &community_key);
    control::apply_control_event(&app_handle, &db, &ban_event, &owner_public_key)
        .map_err(|e| CommandError::Other(e.to_string()))?;

    let new_group_key = encryption::generate_group_key();
    let community_id_c = community_id.clone();
    let members = db
        .run_blocking(move |db| db.get_members(&community_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    let rotation_payload = key_rotation::generate_rotation(&community_key, &members, &new_group_key)
        .map_err(|e| CommandError::Other(e.to_string()))?
        .to_control_payload();
    let rotation_event = control::create_control_event(
        &community_id,
        "key_rotation",
        rotation_payload,
        &community_key,
    );

    // 2. Broadcast the authoritative control events with the pre-rotation key.
    let network = state.network.read().await;
    if let Some(ref net) = *network {
        let control_envelope = serde_json::to_vec(&ban_event).map_err(|e| CommandError::Other(e.to_string()))?;
        let community_id_c = community_id.clone();
        let aad = encryption::build_community_aad(&community_id, "");
        let control_data = db
            .run_blocking(move |db| db.encrypt_community_payload(&community_id_c, &control_envelope, &aad))
            .await
            .map_err(|e| CommandError::Other(e.to_string()))?;
        // Publish ban to meta topic
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: crate::network::gossip::community_meta_topic(&community_id),
                data: control_data.clone(),
            })
            .await
        {
            tracing::warn!("network publish ban to meta topic failed: {}", e);
        }
        // Backward compat: also publish to the legacy community-wide topic
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: format!("mesh/community/{}/messages", community_id),
                data: control_data,
            })
            .await
        {
            tracing::warn!("network publish ban to legacy topic failed: {}", e);
        }

        let rotation_plaintext = serde_json::to_vec(&rotation_event).map_err(|e| CommandError::Other(e.to_string()))?;
        let aad_rotation = encryption::build_community_aad(&community_id, "");
        let rotation_data =
            encryption::encrypt_community_payload(&old_group_key, &rotation_plaintext, &aad_rotation)
                .map_err(|e| CommandError::Other(e.to_string()))?;
        // Publish key rotation to meta topic
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: crate::network::gossip::community_meta_topic(&community_id),
                data: rotation_data.clone(),
            })
            .await
        {
            tracing::warn!("network publish key rotation to meta topic failed: {}", e);
        }
        // Backward compat: also publish to the legacy community-wide topic
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: format!("mesh/community/{}/messages", community_id),
                data: rotation_data,
            })
            .await
        {
            tracing::warn!("network publish key rotation to legacy topic failed: {}", e);
        }
    }

    control::apply_control_event(&app_handle, &db, &rotation_event, &owner_public_key)
        .map_err(|e| CommandError::Other(e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub async fn update_member_role(
    community_id: String,
    public_key: String,
    role: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<(), CommandError> {
    let _ = require_community_permission(&state, &db, &community_id, "owner").await?;
    // Validate role value
    if !["admin", "member"].contains(&role.as_str()) {
        return Err(CommandError::Validation(format!(
            "Invalid role: {}. Must be admin or member. Ownership transfer is not implemented yet.",
            role
        )));
    }

    let community_id_c = community_id.clone();
    let community_key = db
        .run_blocking(move |db| db.get_community_keypair(&community_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?
        .ok_or(CommandError::PermissionDenied("Only the community owner can change member roles".into()))?;

    let owner_public_key = BASE64.encode(community_key.verifying_key.as_bytes());

    // Create and apply the role change control event
    let role_event = control::create_control_event(
        &community_id,
        "role_change",
        serde_json::json!({
            "publicKey": public_key,
            "role": role,
        }),
        &community_key,
    );

    control::apply_control_event(&app_handle, &db, &role_event, &owner_public_key)
        .map_err(|e| CommandError::Other(e.to_string()))?;

    // Broadcast the control event
    let network = state.network.read().await;
    if let Some(ref net) = *network {
        let control_envelope = serde_json::to_vec(&role_event).map_err(|e| CommandError::Other(e.to_string()))?;
        let community_id_c = community_id.clone();
        let aad = encryption::build_community_aad(&community_id, "");
        let data = db
            .run_blocking(move |db| db.encrypt_community_payload(&community_id_c, &control_envelope, &aad))
            .await
            .map_err(|e| CommandError::Other(e.to_string()))?;
        // Publish role change to meta topic
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: crate::network::gossip::community_meta_topic(&community_id),
                data: data.clone(),
            })
            .await
        {
            tracing::warn!("network publish role change to meta topic failed: {}", e);
        }
        // Backward compat: also publish to the legacy community-wide topic
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: format!("mesh/community/{}/messages", community_id),
                data,
            })
            .await
        {
            tracing::warn!("network publish role change to legacy topic failed: {}", e);
        }
    }

    Ok(())
}

/// Get the member roster for a community.
#[tauri::command]
pub async fn get_members(
    community_id: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<Vec<MemberDto>, CommandError> {
    let _ = state.membership.load_community(&db, &community_id);
    let community_id_c = community_id.clone();
    let members = db
        .run_blocking(move |db| db.get_all_member_rows(&community_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    Ok(members
        .into_iter()
        .map(|m| MemberDto {
            public_key: m.public_key,
            display_name: m.display_name,
            avatar_color: m.avatar_color,
            role: m.role,
            join_status: m.join_status,
            ban_status: m.ban_status,
            last_seen: m.last_seen,
        })
        .collect())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberDto {
    pub public_key: String,
    pub display_name: String,
    pub avatar_color: String,
    pub role: String,
    pub join_status: String,
    pub ban_status: String,
    pub last_seen: Option<String>,
}
