/// Control-log event processor.
///
/// All authoritative community mutations (channels, membership, bans, roles,
/// key rotation) flow through signed control-log events rather than CRDT
/// updates. This module processes incoming events, verifies their signatures,
/// and applies the mutations to the local database + in-memory state.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::crypto::encryption;
use crate::crypto::identity::{verify_signature, Identity};
use crate::crypto::key_rotation::{self, KeyRotationEvent};
use crate::network::behaviour::ControlLogRequest;
use crate::network::events::NetworkCommand;
use crate::state::membership::MembershipState;
use crate::state::AppState;
use crate::storage::db::MemberRow;
use crate::storage::Database;

use super::error::CommandError;

/// A signed control-log event received from the network.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlEvent {
    pub id: String,
    pub community_id: String,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub signed_by: String,
    pub signature: String,
    pub timestamp: String,
}

/// Result of applying a control event — forwarded to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlEventResult {
    pub community_id: String,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub applied: bool,
}

impl ControlEvent {
    /// Verify the signature on this control event.
    /// The signable JSON includes `signed_by` to prevent signer impersonation.
    pub fn verify(&self) -> bool {
        let signable = serde_json::json!({
            "id": self.id,
            "community_id": self.community_id,
            "event_type": self.event_type,
            "payload": self.payload,
            "signed_by": self.signed_by,
            "timestamp": self.timestamp,
        });
        verify_signature(
            &self.signed_by,
            signable.to_string().as_bytes(),
            &self.signature,
        )
        .unwrap_or(false)
    }
}

/// Process a control event: verify, persist, apply side effects, and emit to frontend.
pub fn apply_control_event(
    app_handle: &AppHandle,
    db: &Database,
    event: &ControlEvent,
    trusted_owner_key: &str,
) -> Result<ControlEventResult, CommandError> {
    let membership: Option<Arc<MembershipState>> = app_handle
        .try_state::<AppState>()
        .map(|state| state.membership.clone());
    let local_public_key = local_identity_public_key(app_handle);

    // 1. Verify the cryptographic signature.
    if !event.verify() {
        return Err(CommandError::Crypto(
            "Control event has invalid signature".into(),
        ));
    }

    // 2. Verify the signer is allowed to issue this control event.
    authorize_control_signer(db, membership.as_ref(), event, trusted_owner_key)?;

    // 3. Persist to control_log (idempotent — rejects duplicates)
    let is_new = db
        .insert_control_event(
            &event.id,
            &event.community_id,
            &event.event_type,
            &event.payload.to_string(),
            &event.signed_by,
            &event.signature,
            &event.timestamp,
        )
        .map_err(|e| CommandError::Other(e.to_string()))?;

    if !is_new {
        return Ok(ControlEventResult {
            community_id: event.community_id.clone(),
            event_type: event.event_type.clone(),
            payload: event.payload.clone(),
            applied: false,
        });
    }

    // 4. Apply the mutation
    let mut mutation_ok = true;
    match event.event_type.as_str() {
        "channel_create" => {
            let channel_id = event.payload["channelId"].as_str().unwrap_or_default();
            let name = event.payload["name"].as_str().unwrap_or("untitled");
            let channel_type = event.payload["channelType"].as_str().unwrap_or("text");
            if let Err(e) = db.create_channel(channel_id, &event.community_id, name, channel_type) {
                tracing::error!(
                    "Failed to create channel for control event {}: {}",
                    event.id,
                    e
                );
                mutation_ok = false;
            }
        }
        "channel_delete" => {
            let channel_id = event.payload["channelId"].as_str().unwrap_or_default();
            if !channel_id.is_empty() {
                let conn = db
                    .conn
                    .lock()
                    .map_err(|e| CommandError::Other(e.to_string()))?;
                if let Err(e) = conn.execute(
                    "DELETE FROM channels WHERE id = ?1 AND community_id = ?2",
                    rusqlite::params![channel_id, event.community_id],
                ) {
                    tracing::error!(
                        "Failed to delete channel for control event {}: {}",
                        event.id,
                        e
                    );
                    mutation_ok = false;
                }
            }
        }
        "member_join" => {
            let public_key = event.payload["publicKey"].as_str().unwrap_or_default();
            let display_name = event.payload["displayName"].as_str().unwrap_or("Unknown");
            let avatar_color = event.payload["avatarColor"].as_str().unwrap_or("#c8b89a");
            let role = event.payload["role"].as_str().unwrap_or("member");
            let x25519_key = event.payload["x25519PublicKey"].as_str();
            if let Err(e) = db.upsert_member(
                &event.community_id,
                public_key,
                display_name,
                avatar_color,
                role,
                x25519_key,
            ) {
                tracing::error!(
                    "Failed to upsert member for control event {}: {}",
                    event.id,
                    e
                );
                mutation_ok = false;
            }
            if let Some(membership) = &membership {
                if let Err(e) = membership.add_member(
                    &event.community_id,
                    MemberRow {
                        public_key: public_key.to_string(),
                        display_name: display_name.to_string(),
                        avatar_color: avatar_color.to_string(),
                        role: role.to_string(),
                        join_status: "joined".into(),
                        ban_status: "none".into(),
                        x25519_public_key: x25519_key.map(ToString::to_string),
                        last_seen: Some(event.timestamp.clone()),
                    },
                ) {
                    tracing::warn!("Failed to add member to in-memory state: {}", e);
                }
            }
        }
        "member_leave" => {
            let public_key = event.payload["publicKey"].as_str().unwrap_or_default();
            if !public_key.is_empty() {
                {
                    let conn = db
                        .conn
                        .lock()
                        .map_err(|e| CommandError::Other(e.to_string()))?;
                    if let Err(e) = conn.execute(
                        "UPDATE members SET join_status = 'left' WHERE community_id = ?1 AND public_key = ?2",
                        rusqlite::params![event.community_id, public_key],
                    ) {
                        tracing::error!("Failed to update member_leave for control event {}: {}", event.id, e);
                        mutation_ok = false;
                    }
                }
                if let Some(membership) = &membership {
                    if let Err(e) = membership.remove_member(&event.community_id, public_key) {
                        tracing::warn!("Failed to remove member from in-memory state: {}", e);
                    }
                }
                if local_public_key.as_deref() == Some(public_key) {
                    db.delete_community(&event.community_id)
                        .map_err(|error| CommandError::Other(error.to_string()))?;
                    if let Some(membership) = &membership {
                        if let Err(e) = membership.clear_community(&event.community_id) {
                            tracing::warn!("Failed to clear community from in-memory state: {}", e);
                        }
                    }
                } else {
                    maybe_rotate_group_key_after_member_leave(
                        app_handle,
                        db,
                        &event.community_id,
                        public_key,
                        trusted_owner_key,
                    )?;
                }
            }
        }
        "member_ban" => {
            let public_key = event.payload["publicKey"].as_str().unwrap_or_default();
            if !public_key.is_empty() {
                if let Err(e) = db.ban_member(&event.community_id, public_key) {
                    tracing::error!("Failed to ban member for control event {}: {}", event.id, e);
                    mutation_ok = false;
                }
                // Also add to ban_list for backward compatibility
                {
                    let conn = db
                        .conn
                        .lock()
                        .map_err(|e| CommandError::Other(e.to_string()))?;
                    if let Err(e) = conn.execute(
                        "INSERT OR IGNORE INTO ban_list (community_id, public_key, banned_at, signed_by, signature)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        rusqlite::params![
                            event.community_id,
                            public_key,
                            event.timestamp,
                            event.signed_by,
                            event.signature,
                        ],
                    ) {
                        tracing::warn!("Failed to insert into ban_list for control event {}: {}", event.id, e);
                    }
                }
                // Prune reactions by banned user
                if let Err(e) = db.remove_reactions_by_author(&event.community_id, public_key) {
                    tracing::warn!(
                        "Failed to prune reactions by banned user {}: {}",
                        public_key,
                        e
                    );
                }
                if let Some(membership) = &membership {
                    if let Err(e) = membership.ban_member(&event.community_id, public_key) {
                        tracing::warn!("Failed to ban member in in-memory state: {}", e);
                    }
                }
                if local_public_key.as_deref() == Some(public_key) {
                    db.delete_community(&event.community_id)
                        .map_err(|error| CommandError::Other(error.to_string()))?;
                    if let Some(membership) = &membership {
                        if let Err(e) = membership.clear_community(&event.community_id) {
                            tracing::warn!("Failed to clear community from in-memory state: {}", e);
                        }
                    }
                }
            }
        }
        "role_change" => {
            let public_key = event.payload["publicKey"].as_str().unwrap_or_default();
            let new_role = event.payload["role"].as_str().unwrap_or("member");
            if !public_key.is_empty() {
                if let Err(e) = db.update_member_role(&event.community_id, public_key, new_role) {
                    tracing::error!(
                        "Failed to update member role for control event {}: {}",
                        event.id,
                        e
                    );
                    mutation_ok = false;
                }
                if let Some(membership) = &membership {
                    if let Err(e) =
                        membership.update_role(&event.community_id, public_key, new_role)
                    {
                        tracing::warn!("Failed to update role in in-memory state: {}", e);
                    }
                }
            }
        }
        "community_delete" => {
            db.delete_community(&event.community_id)
                .map_err(|error| CommandError::Other(error.to_string()))?;
            if let Some(membership) = &membership {
                if let Err(e) = membership.clear_community(&event.community_id) {
                    tracing::warn!("Failed to clear community from in-memory state: {}", e);
                }
            }
        }
        "key_rotation" => {
            let rotation = KeyRotationEvent::from_control_payload(
                event.community_id.clone(),
                event.signed_by.clone(),
                event.signature.clone(),
                event.timestamp.clone(),
                &event.payload,
            )
            .map_err(|error| CommandError::Other(error.to_string()))?;

            // Enforce epoch monotonicity: reject replayed or stale rotation events
            if let Ok(Some(current_epoch)) = db.get_group_key_epoch(&event.community_id) {
                if let Err(e) =
                    key_rotation::validate_epoch_monotonicity(rotation.epoch, current_epoch)
                {
                    tracing::warn!(
                        "Rejecting key_rotation for community {} — {}",
                        event.community_id,
                        e,
                    );
                    return Err(CommandError::Crypto(e));
                }
                // If stored_epoch is None, this is the first rotation — accept it
            }

            let Some(local_public_key) = local_public_key.clone() else {
                return Ok(ControlEventResult {
                    community_id: event.community_id.clone(),
                    event_type: event.event_type.clone(),
                    payload: event.payload.clone(),
                    applied: false,
                });
            };
            if !rotation.new_key_wraps.contains_key(&local_public_key) {
                return Ok(ControlEventResult {
                    community_id: event.community_id.clone(),
                    event_type: event.event_type.clone(),
                    payload: event.payload.clone(),
                    applied: false,
                });
            }
            let identity =
                Identity::load().map_err(|error| CommandError::Other(error.to_string()))?;
            let next_group_key = crate::crypto::key_rotation::unwrap_for_self(
                &rotation,
                &local_public_key,
                &identity.x25519_static_secret(),
            )
            .map_err(|error| CommandError::Other(error.to_string()))?;
            let next_group_key_b64 = encryption::group_key_to_b64(&next_group_key);
            db.set_group_key(&event.community_id, &next_group_key_b64)
                .map_err(|error| CommandError::Other(error.to_string()))?;
            db.set_group_key_epoch(&event.community_id, rotation.epoch)
                .map_err(|error| CommandError::Other(error.to_string()))?;
        }
        "community_update" => {
            let name = event.payload["name"].as_str();
            let description = event.payload["description"].as_str();
            if name.is_some() || description.is_some() {
                let conn = db
                    .conn
                    .lock()
                    .map_err(|e| CommandError::Other(e.to_string()))?;
                if let Some(name) = name {
                    if let Err(e) = conn.execute(
                        "UPDATE communities SET name = ?1 WHERE id = ?2",
                        rusqlite::params![name, event.community_id],
                    ) {
                        tracing::error!(
                            "Failed to update community name for control event {}: {}",
                            event.id,
                            e
                        );
                        mutation_ok = false;
                    }
                }
                if let Some(desc) = description {
                    if let Err(e) = conn.execute(
                        "UPDATE communities SET description = ?1 WHERE id = ?2",
                        rusqlite::params![desc, event.community_id],
                    ) {
                        tracing::error!(
                            "Failed to update community description for control event {}: {}",
                            event.id,
                            e
                        );
                        mutation_ok = false;
                    }
                }
            }
        }
        _ => {
            tracing::warn!("Unknown control event type: {}", event.event_type);
        }
    }

    // 5. Emit to the frontend
    let result = ControlEventResult {
        community_id: event.community_id.clone(),
        event_type: event.event_type.clone(),
        payload: event.payload.clone(),
        applied: mutation_ok,
    };
    let _ = app_handle.emit("control:event", &result);
    if let Ok(Some((mut community, _))) = db.get_community_snapshot(&event.community_id) {
        community.member_count = db.member_count(&event.community_id).unwrap_or(0);
        let _ = app_handle.emit("community:updated", &community);
    }

    Ok(result)
}

/// Create a signed control event from the community owner.
pub fn create_control_event(
    community_id: &str,
    event_type: &str,
    payload: serde_json::Value,
    community_key: &crate::crypto::community_key::CommunityKey,
) -> ControlEvent {
    let id = nanoid::nanoid!();
    let timestamp = chrono::Utc::now().to_rfc3339();
    let signed_by = BASE64.encode(community_key.verifying_key.as_bytes());

    let signable = serde_json::json!({
        "id": id,
        "community_id": community_id,
        "event_type": event_type,
        "payload": payload,
        "signed_by": signed_by,
        "timestamp": timestamp,
    });

    let signature = community_key.sign(signable.to_string().as_bytes());

    ControlEvent {
        id,
        community_id: community_id.to_string(),
        event_type: event_type.to_string(),
        payload,
        signed_by,
        signature,
        timestamp,
    }
}

/// Create a signed control event from a member identity.
pub fn create_identity_control_event(
    community_id: &str,
    event_type: &str,
    payload: serde_json::Value,
    identity: &Identity,
) -> ControlEvent {
    let id = nanoid::nanoid!();
    let timestamp = chrono::Utc::now().to_rfc3339();
    let signed_by = identity.public_key_b64.clone();

    let signable = serde_json::json!({
        "id": id,
        "community_id": community_id,
        "event_type": event_type,
        "payload": payload,
        "signed_by": signed_by,
        "timestamp": timestamp,
    });

    ControlEvent {
        id,
        community_id: community_id.to_string(),
        event_type: event_type.to_string(),
        payload,
        signed_by,
        signature: identity.sign(signable.to_string().as_bytes()),
        timestamp,
    }
}

fn authorize_control_signer(
    db: &Database,
    membership: Option<&Arc<MembershipState>>,
    event: &ControlEvent,
    trusted_owner_key: &str,
) -> Result<(), CommandError> {
    if event.event_type == "member_leave" {
        let leaving_public_key = event.payload["publicKey"].as_str().unwrap_or_default();
        if leaving_public_key == event.signed_by
            && member_has_role(db, &event.community_id, &event.signed_by, "owner")?
        {
            return Err(CommandError::Validation(
                "Owner cannot leave community without transferring ownership".into(),
            ));
        }
    }

    if event.signed_by == trusted_owner_key {
        return Ok(());
    }

    let required_role = required_role_for_control_event(&event.event_type);
    if required_role.is_empty() {
        return Err(CommandError::Validation(format!(
            "Unsupported control event type for signer authorization: {}",
            event.event_type
        )));
    }

    if event.event_type == "member_leave" {
        let leaving_public_key = event.payload["publicKey"].as_str().unwrap_or_default();
        if leaving_public_key == event.signed_by
            && signer_has_permission(
                db,
                membership,
                &event.community_id,
                &event.signed_by,
                "member",
            )?
        {
            return Ok(());
        }
    }

    if signer_has_permission(
        db,
        membership,
        &event.community_id,
        &event.signed_by,
        required_role,
    )? {
        return Ok(());
    }

    Err(CommandError::PermissionDenied(format!(
        "Control event {} signed by unauthorized member {}",
        event.event_type, event.signed_by
    )))
}

fn required_role_for_control_event(event_type: &str) -> &'static str {
    match event_type {
        "channel_create" | "channel_delete" | "member_ban" | "community_update" => "admin",
        "key_rotation" | "community_delete" => "owner",
        "member_join" | "role_change" => "owner",
        "member_leave" => "member",
        _ => "",
    }
}

fn signer_has_permission(
    db: &Database,
    membership: Option<&Arc<MembershipState>>,
    community_id: &str,
    signer_public_key: &str,
    required_role: &str,
) -> Result<bool, CommandError> {
    if let Some(membership) = membership {
        membership.load_community(db, community_id)?;
        return Ok(membership.has_permission(community_id, signer_public_key, required_role)?);
    }

    let members = db
        .get_all_member_rows(community_id)
        .map_err(|error| CommandError::Other(error.to_string()))?;
    let Some(member) = members
        .into_iter()
        .find(|member| member.public_key == signer_public_key)
    else {
        return Ok(false);
    };

    Ok(member.join_status == "joined"
        && member.ban_status == "none"
        && role_rank(&member.role) >= role_rank(required_role))
}

fn role_rank(role: &str) -> u8 {
    match role {
        "owner" => 3,
        "admin" => 2,
        _ => 1,
    }
}

fn member_has_role(
    db: &Database,
    community_id: &str,
    public_key: &str,
    expected_role: &str,
) -> Result<bool, CommandError> {
    let members = db
        .get_all_member_rows(community_id)
        .map_err(|error| CommandError::Other(error.to_string()))?;
    Ok(members.into_iter().any(|member| {
        member.public_key == public_key
            && member.join_status == "joined"
            && member.ban_status == "none"
            && member.role == expected_role
    }))
}

fn local_identity_public_key(app_handle: &AppHandle) -> Option<String> {
    app_handle
        .try_state::<AppState>()
        .and_then(|state| {
            state.identity.try_read().ok().and_then(|guard| {
                guard
                    .as_ref()
                    .map(|identity| identity.public_key_b64.clone())
            })
        })
        .or_else(|| {
            Identity::load()
                .ok()
                .map(|identity| identity.public_key_b64)
        })
}

fn maybe_rotate_group_key_after_member_leave(
    app_handle: &AppHandle,
    db: &Database,
    community_id: &str,
    departed_public_key: &str,
    trusted_owner_key: &str,
) -> Result<(), CommandError> {
    let Some(community_key) = db
        .get_community_keypair(community_id)
        .map_err(|error| CommandError::Other(error.to_string()))?
    else {
        return Ok(());
    };

    if BASE64.encode(community_key.verifying_key.as_bytes()) != trusted_owner_key {
        return Ok(());
    }

    let old_group_key_b64 = db
        .get_group_key(community_id)
        .map_err(|error| CommandError::Other(error.to_string()))?
        .ok_or_else(|| format!("missing group key for community {community_id}"))?;
    let old_group_key = encryption::group_key_from_b64(&old_group_key_b64)
        .map_err(|error| CommandError::Other(error.to_string()))?;
    let members = db
        .get_members(community_id)
        .map_err(|error| CommandError::Other(error.to_string()))?;

    if members.is_empty()
        || members
            .iter()
            .any(|member| member.public_key == departed_public_key)
    {
        return Ok(());
    }

    let next_group_key = encryption::generate_group_key();
    let rotation_payload =
        crate::crypto::key_rotation::generate_rotation(&community_key, &members, &next_group_key)
            .map_err(|error| CommandError::Other(error.to_string()))?
            .to_control_payload();
    let rotation_event = create_control_event(
        community_id,
        "key_rotation",
        rotation_payload,
        &community_key,
    );

    apply_control_event(app_handle, db, &rotation_event, trusted_owner_key)?;

    let app_handle = app_handle.clone();
    let community_id = community_id.to_string();
    let rotation_plaintext = serde_json::to_vec(&rotation_event)
        .map_err(|error| CommandError::Other(error.to_string()))?;
    tauri::async_runtime::spawn(async move {
        let Some(state) = app_handle.try_state::<AppState>() else {
            return;
        };
        let network = state.network.read().await;
        let Some(net) = network.as_ref() else {
            return;
        };
        let aad = encryption::build_community_aad(&community_id, "");
        let Ok(data) =
            encryption::encrypt_community_payload(&old_group_key, &rotation_plaintext, &aad)
        else {
            return;
        };
        // Publish key rotation to the meta topic for control events
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: crate::network::gossip::community_meta_topic(&community_id),
                data: data.clone(),
            })
            .await
        {
            tracing::warn!("network publish key rotation to meta topic failed: {}", e);
        }
        // Backward compat: also publish to the legacy community-wide topic
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: format!("mesh/community/{community_id}/messages"),
                data,
            })
            .await
        {
            tracing::warn!("network publish key rotation to legacy topic failed: {}", e);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn request_control_log_sync(
    community_id: String,
    db: State<'_, Database>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let network = state.network.read().await;
    let Some(net) = network.as_ref() else {
        return Ok(());
    };
    let community_id_c = community_id.clone();
    let since_timestamp = db
        .run_blocking(move |db| db.get_latest_control_event_timestamp(&community_id_c))
        .await
        .map_err(|error| CommandError::Other(error.to_string()))?;

    let (our_public_key, request_signature, request_timestamp) = {
        let identity = state.identity.read().await;
        match identity.as_ref() {
            Some(id) => {
                let pk = id.public_key_b64.clone();
                let ts = chrono::Utc::now().to_rfc3339();
                let signable = format!("control-log-req:{}:{}:{}", community_id, pk, ts);
                let sig = id.sign(signable.as_bytes());
                (pk, sig, ts)
            }
            None => (String::new(), String::new(), String::new()),
        }
    };

    net.send_command(NetworkCommand::RequestControl {
        peer_id: None,
        request: crate::network::behaviour::ControlRequest::ControlLog(ControlLogRequest {
            community_id,
            since_timestamp,
            requester_public_key: our_public_key,
            request_signature,
            request_timestamp,
        }),
    })
    .await
    .map_err(|error| CommandError::Network(error.to_string()))
}
