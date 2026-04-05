use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use std::collections::HashSet;
use tauri::{AppHandle, State};

use crate::commands::control;
use crate::commands::error::CommandError;
use crate::commands::permissions::require_community_permission;
use crate::crypto::community_key::CommunityKey;
use crate::crypto::encryption;
use crate::network::discovery;
use crate::network::envelope::{EnvelopeBuilder, PresencePayload};
use crate::network::events::NetworkCommand;
use crate::network::gossip::community_meta_topic;
use crate::state::app_state::PendingInviteJoin;
use crate::state::rate_limits::RateLimitBucket;
use crate::state::AppState;
use crate::storage::Database;
use crate::types::community::{ChannelDto, CommunityDto};

#[tauri::command]
pub async fn create_community(
    name: String,
    description: String,
    _app_handle: AppHandle,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<CommunityDto, CommandError> {
    let community_key = CommunityKey::generate();
    let owner_public_key = BASE64.encode(community_key.verifying_key.as_bytes());
    let group_key_b64 = encryption::group_key_to_b64(&encryption::generate_group_key());

    let community_id = community_key.community_id.clone();
    let name_c = name.clone();
    let description_c = description.clone();
    let private_key_b64 = community_key.private_key_b64.clone();
    let group_key_b64_c = group_key_b64.clone();
    let owner_public_key_c = owner_public_key.clone();
    db.run_blocking(move |db| {
        db.create_community(
            &community_id,
            &name_c,
            &description_c,
            Some(&private_key_b64),
            Some(&group_key_b64_c),
            Some(&owner_public_key_c),
        )
    })
    .await
    .map_err(|e| CommandError::Other(e.to_string()))?;

    let channel_id = uuid::Uuid::new_v4().to_string();
    let channel_id_c = channel_id.clone();
    let community_id_c = community_key.community_id.clone();
    db.run_blocking(move |db| db.create_channel(&channel_id_c, &community_id_c, "general", "text"))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    // Register the owner as the first member
    {
        let identity = state.identity.read().await;
        if let Some(id) = identity.as_ref() {
            let x25519_pub = BASE64.encode(id.x25519_public_key().as_bytes());
            let community_id_c = community_key.community_id.clone();
            let pub_key_c = id.public_key_b64.clone();
            let name_c = name.clone();
            let x25519_pub_c = x25519_pub.clone();
            if let Err(e) = db
                .run_blocking(move |db| {
                    db.upsert_member(
                        &community_id_c,
                        &pub_key_c,
                        &name_c,
                        "#c8b89a",
                        "owner",
                        Some(&x25519_pub_c),
                    )
                })
                .await
            {
                tracing::warn!("Failed to register owner as community member: {}", e);
            }
            if let Err(e) = state.membership.add_member(
                &community_key.community_id,
                crate::storage::db::MemberRow {
                    public_key: id.public_key_b64.clone(),
                    display_name: name.clone(),
                    avatar_color: "#c8b89a".into(),
                    role: "owner".into(),
                    join_status: "joined".into(),
                    ban_status: "none".into(),
                    x25519_public_key: Some(x25519_pub),
                    last_seen: Some(chrono::Utc::now().to_rfc3339()),
                },
            ) {
                tracing::warn!("Failed to add owner to in-memory membership state: {}", e);
            }
        }
    }

    let network = state.network.read().await;
    if let Some(ref net) = *network {
        // Subscribe to the new meta topic for control events
        if let Err(e) = net
            .send_command(NetworkCommand::SubscribeTopic {
                topic: community_meta_topic(&community_key.community_id),
            })
            .await
        {
            tracing::warn!("network subscribe to meta topic failed: {}", e);
        }

        // Backward compat: keep subscribing to the legacy community-wide topic
        if let Err(e) = net
            .send_command(NetworkCommand::SubscribeTopic {
                topic: format!("mesh/community/{}/messages", community_key.community_id),
            })
            .await
        {
            tracing::warn!("network subscribe to legacy topic failed: {}", e);
        }

        if let Err(e) = net
            .send_command(NetworkCommand::SubscribeTopic {
                topic: format!("mesh/community/{}/presence", community_key.community_id),
            })
            .await
        {
            tracing::warn!("network subscribe to presence topic failed: {}", e);
        }

        if let Err(e) = net
            .send_command(NetworkCommand::RegisterInDHT {
                community_id: community_key.community_id.clone(),
            })
            .await
        {
            tracing::warn!("network register in DHT failed: {}", e);
        }

        announce_presence(&state, &db, net, &community_key.community_id).await?;
    }

    Ok(CommunityDto {
        id: community_key.community_id,
        name,
        description,
        role: "owner".into(),
        member_count: 1,
        joined_at: Some(chrono::Utc::now().to_rfc3339()),
    })
}

#[tauri::command]
pub async fn get_communities(db: State<'_, Database>) -> Result<Vec<CommunityDto>, CommandError> {
    db.run_blocking(move |db| {
        let mut communities = db.get_communities()?;
        for community in &mut communities {
            community.member_count = db.member_count(&community.id).unwrap_or(0);
        }
        Ok(communities)
    })
    .await
    .map_err(|e: anyhow::Error| CommandError::Other(e.to_string()))
}

#[tauri::command]
pub async fn get_channels(
    community_id: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<Vec<ChannelDto>, CommandError> {
    let identity_public_key = state
        .identity
        .read()
        .await
        .as_ref()
        .map(|identity| identity.public_key_b64.clone());

    db.run_blocking(move |db| {
        let mut channels = db.get_channels(&community_id)?;
        if let Some(identity_public_key) = identity_public_key {
            for channel in &mut channels {
                channel.unread_count = db
                    .get_unread_count(&channel.id, &identity_public_key)
                    .unwrap_or(0);
            }
        }
        Ok(channels)
    })
    .await
    .map_err(|e: anyhow::Error| CommandError::Other(e.to_string()))
}

#[tauri::command]
pub async fn sync_local_channel(
    community_id: String,
    channel_id: String,
    name: String,
    channel_type: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<(), CommandError> {
    let channel_id_c = channel_id.clone();
    let community_id_c = community_id.clone();
    let name_c = name.clone();
    let channel_type_c = channel_type.clone();
    let created = db
        .run_blocking(move |db| db.upsert_local_channel(&channel_id_c, &community_id_c, &name_c, &channel_type_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    if created {
        let channel_id_c = channel_id.clone();
        let cursor = db
            .run_blocking(move |db| db.get_latest_message_cursor(&channel_id_c))
            .await
            .map_err(|e| CommandError::Other(e.to_string()))?;
        let our_public_key = {
            let identity = state.identity.read().await;
            identity.as_ref().map(|id| id.public_key_b64.clone()).unwrap_or_default()
        };
        let network = state.network.read().await;
        if let Some(ref net) = *network {
            if let Err(e) = net
                .send_command(NetworkCommand::RequestMessageHistory {
                    peer_id: None,
                    channel_id,
                    since_timestamp: cursor.as_ref().map(|(timestamp, _)| timestamp.clone()),
                    since_id: cursor.as_ref().map(|(_, id)| id.clone()),
                    limit: 100,
                    requester_public_key: our_public_key,
                })
                .await
            {
                tracing::warn!("network request message history failed: {}", e);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn create_channel(
    community_id: String,
    name: String,
    channel_type: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<ChannelDto, CommandError> {
    let caller_public_key =
        require_community_permission(&state, &db, &community_id, "admin").await?;
    let identity = state.identity.read().await;
    let identity = identity.as_ref().ok_or(CommandError::Identity("No identity loaded".into()))?;
    if identity.public_key_b64 != caller_public_key {
        return Err(CommandError::Validation("Loaded identity does not match caller permission state".into()));
    }
    let community_id_c = community_id.clone();
    let community_key = db
        .run_blocking(move |db| db.get_community_keypair(&community_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    let channel_id = uuid::Uuid::new_v4().to_string();

    // Owners keep using the community key; admins use their member identity.
    let event_payload = serde_json::json!({
        "channelId": channel_id,
        "name": name,
        "channelType": channel_type,
    });
    let community_id_c = community_id.clone();
    let owner_public_key = db
        .run_blocking(move |db| db.get_community_owner_public_key(&community_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?
        .ok_or(CommandError::NotFound("Community owner key missing".into()))?;
    let event = if let Some(community_key) = community_key.as_ref() {
        control::create_control_event(
            &community_id,
            "channel_create",
            event_payload,
            community_key,
        )
    } else {
        control::create_identity_control_event(
            &community_id,
            "channel_create",
            event_payload,
            identity,
        )
    };

    // Apply locally (creates the channel in SQLite + emits to frontend)
    // Note: apply_control_event is a synchronous function that accesses the DB
    // internally via conn.lock(). It also requires &AppHandle which is not Send.
    control::apply_control_event(&app_handle, &db, &event, &owner_public_key)
        .map_err(|e| CommandError::Other(e.to_string()))?;

    // Broadcast the control event to the network (meta topic + legacy)
    let network = state.network.read().await;
    if let Some(ref net) = *network {
        let control_envelope = serde_json::to_vec(&event).map_err(|e| CommandError::Other(e.to_string()))?;
        let community_id_c = community_id.clone();
        let aad = encryption::build_community_aad(&community_id, "");
        let data = db
            .run_blocking(move |db| db.encrypt_community_payload(&community_id_c, &control_envelope, &aad))
            .await
            .map_err(|e| CommandError::Other(e.to_string()))?;
        // Publish to the meta topic for control events
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: community_meta_topic(&community_id),
                data: data.clone(),
            })
            .await
        {
            tracing::warn!("network publish channel create to meta topic failed: {}", e);
        }
        // Backward compat: also publish to the legacy community-wide topic
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: format!("mesh/community/{}/messages", community_id),
                data,
            })
            .await
        {
            tracing::warn!("network publish channel create to legacy topic failed: {}", e);
        }
    }

    Ok(ChannelDto {
        id: channel_id,
        community_id,
        name,
        channel_type,
        unread_count: 0,
    })
}

#[tauri::command]
pub async fn update_community_metadata(
    community_id: String,
    name: String,
    description: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<(), CommandError> {
    let caller_public_key =
        require_community_permission(&state, &db, &community_id, "admin").await?;
    let identity = state.identity.read().await;
    let identity = identity.as_ref().ok_or(CommandError::Identity("No identity loaded".into()))?;
    if identity.public_key_b64 != caller_public_key {
        return Err(CommandError::Validation("Loaded identity does not match caller permission state".into()));
    }
    let community_id_c = community_id.clone();
    let community_key = db
        .run_blocking(move |db| db.get_community_keypair(&community_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    let community_id_c = community_id.clone();
    let owner_public_key = db
        .run_blocking(move |db| db.get_community_owner_public_key(&community_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?
        .ok_or(CommandError::NotFound("Community owner key missing".into()))?;
    let event_payload = serde_json::json!({
        "name": name,
        "description": description,
    });
    let event = if let Some(community_key) = community_key.as_ref() {
        control::create_control_event(
            &community_id,
            "community_update",
            event_payload,
            community_key,
        )
    } else {
        control::create_identity_control_event(
            &community_id,
            "community_update",
            event_payload,
            identity,
        )
    };

    control::apply_control_event(&app_handle, &db, &event, &owner_public_key)
        .map_err(|e| CommandError::Other(e.to_string()))?;

    let network = state.network.read().await;
    if let Some(ref net) = *network {
        let control_envelope = serde_json::to_vec(&event).map_err(|e| CommandError::Other(e.to_string()))?;
        let community_id_c = community_id.clone();
        let aad = encryption::build_community_aad(&community_id, "");
        let data = db
            .run_blocking(move |db| db.encrypt_community_payload(&community_id_c, &control_envelope, &aad))
            .await
            .map_err(|e| CommandError::Other(e.to_string()))?;
        // Publish to the meta topic for control events
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: community_meta_topic(&community_id),
                data: data.clone(),
            })
            .await
        {
            tracing::warn!("network publish community update to meta topic failed: {}", e);
        }
        // Backward compat: also publish to the legacy community-wide topic
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: format!("mesh/community/{}/messages", community_id),
                data,
            })
            .await
        {
            tracing::warn!("network publish community update to legacy topic failed: {}", e);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn join_community(
    invite_link: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<CommunityDto, CommandError> {
    let parsed = parse_invite_link(&invite_link).map_err(|e| CommandError::Other(e.to_string()))?;
    if parsed.version == 2 && parsed.group_key.is_none() {
        tracing::info!(
            "Joined via v2 invite for {} with invite token present: {}",
            parsed.community_id,
            parsed
                .invite_secret
                .as_deref()
                .map(|token| !token.is_empty())
                .unwrap_or(false)
        );
        let invite_secret = parsed
            .invite_secret
            .clone()
            .ok_or(CommandError::Validation("Missing invite token in v2 invite".into()))?;
        state.pending_invites.lock().await.insert(
            parsed.community_id.clone(),
            PendingInviteJoin {
                invite_secret,
                owner_public_key: parsed.owner_public_key.clone(),
                attempted_peers: HashSet::new(),
                created_at: std::time::Instant::now(),
            },
        );
    }

    let community_id_c = parsed.community_id.clone();
    let group_key_c = parsed.group_key.clone();
    let owner_key_c = parsed.owner_public_key.clone();
    db.run_blocking(move |db| {
        db.create_community(
            &community_id_c,
            "Loading...",
            "",
            None,
            group_key_c.as_deref(),
            owner_key_c.as_deref(),
        )
    })
    .await
    .map_err(|e| CommandError::Other(e.to_string()))?;

    let mut dial_addrs = parsed.bootstrap_addrs.clone();
    dial_addrs.extend(parsed.peer_addrs.iter().cloned());

    let network = state.network.read().await;
    if let Some(ref net) = *network {
        for peer_addr in &dial_addrs {
            if let Err(e) = net
                .send_command(NetworkCommand::ConnectPeer {
                    addr: peer_addr.clone(),
                })
                .await
            {
                tracing::warn!("network connect to peer {} failed: {}", peer_addr, e);
            }
        }

        // Subscribe to the new meta topic for control events
        if let Err(e) = net
            .send_command(NetworkCommand::SubscribeTopic {
                topic: community_meta_topic(&parsed.community_id),
            })
            .await
        {
            tracing::warn!("network subscribe to meta topic failed: {}", e);
        }

        // Backward compat: keep subscribing to the legacy community-wide topic
        if let Err(e) = net
            .send_command(NetworkCommand::SubscribeTopic {
                topic: format!("mesh/community/{}/messages", parsed.community_id),
            })
            .await
        {
            tracing::warn!("network subscribe to legacy topic failed: {}", e);
        }

        if let Err(e) = net
            .send_command(NetworkCommand::SubscribeTopic {
                topic: format!("mesh/community/{}/presence", parsed.community_id),
            })
            .await
        {
            tracing::warn!("network subscribe to presence topic failed: {}", e);
        }

        if let Err(e) = net
            .send_command(NetworkCommand::FindPeers {
                community_id: parsed.community_id.clone(),
            })
            .await
        {
            tracing::warn!("network find peers failed: {}", e);
        }

        // Skip presence announcement for v2 invites without a group key — the
        // key hasn't been received yet (it arrives via the invite challenge-response
        // flow). Presence will be announced after the join completes successfully.
        if parsed.group_key.is_some() {
            announce_presence(&state, &db, net, &parsed.community_id).await?;
        }
    }

    Ok(CommunityDto {
        id: parsed.community_id,
        name: "Loading...".into(),
        description: "".into(),
        role: "member".into(),
        member_count: 0,
        joined_at: Some(chrono::Utc::now().to_rfc3339()),
    })
}

#[tauri::command]
pub async fn leave_community(
    community_id: String,
    _app_handle: AppHandle,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<(), CommandError> {
    let leave_event = {
        let identity = state.identity.read().await;
        let identity = identity.as_ref().ok_or(CommandError::Identity("No identity loaded".into()))?;

        state.membership.load_community(&db, &community_id)?;
        if state
            .membership
            .has_permission(&community_id, &identity.public_key_b64, "owner")?
        {
            return Err(CommandError::Validation("Owner cannot leave community without transferring ownership".into()));
        }

        control::create_identity_control_event(
            &community_id,
            "member_leave",
            serde_json::json!({
                "publicKey": identity.public_key_b64,
            }),
            identity,
        )
    };

    let network = state.network.read().await;
    if let Some(ref net) = *network {
        let plaintext = serde_json::to_vec(&leave_event).map_err(|e| CommandError::Other(e.to_string()))?;
        let community_id_c = community_id.clone();
        let aad = encryption::build_community_aad(&community_id, "");
        let encrypt_result = db
            .run_blocking(move |db| db.encrypt_community_payload(&community_id_c, &plaintext, &aad))
            .await;
        if let Ok(data) = encrypt_result {
            // Publish leave to both meta and legacy topics
            if let Err(e) = net
                .send_command(NetworkCommand::PublishMessage {
                    topic: community_meta_topic(&community_id),
                    data: data.clone(),
                })
                .await
            {
                tracing::warn!("network publish leave to meta topic failed: {}", e);
            }
            if let Err(e) = net
                .send_command(NetworkCommand::PublishMessage {
                    topic: format!("mesh/community/{}/messages", community_id),
                    data,
                })
                .await
            {
                tracing::warn!("network publish leave to legacy topic failed: {}", e);
            }
        }

        if let Err(e) = net
            .send_command(NetworkCommand::UnsubscribeTopic {
                topic: community_meta_topic(&community_id),
            })
            .await
        {
            tracing::warn!("network unsubscribe from meta topic failed: {}", e);
        }
        if let Err(e) = net
            .send_command(NetworkCommand::UnsubscribeTopic {
                topic: format!("mesh/community/{}/messages", community_id),
            })
            .await
        {
            tracing::warn!("network unsubscribe from legacy topic failed: {}", e);
        }
        if let Err(e) = net
            .send_command(NetworkCommand::UnsubscribeTopic {
                topic: format!("mesh/community/{}/presence", community_id),
            })
            .await
        {
            tracing::warn!("network unsubscribe from presence topic failed: {}", e);
        }
    }

    let community_id_c = community_id.clone();
    db.run_blocking(move |db| db.delete_community(&community_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub async fn delete_community(
    community_id: String,
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
        .ok_or(CommandError::PermissionDenied("Only the community owner can delete this community".into()))?;
    let owner_public_key = BASE64.encode(community_key.verifying_key.as_bytes());
    let delete_event = control::create_control_event(
        &community_id,
        "community_delete",
        serde_json::json!({}),
        &community_key,
    );

    let network = state.network.read().await;
    if let Some(ref net) = *network {
        let plaintext = serde_json::to_vec(&delete_event).map_err(|e| CommandError::Other(e.to_string()))?;
        let community_id_c = community_id.clone();
        let aad = encryption::build_community_aad(&community_id, "");
        let data = db
            .run_blocking(move |db| db.encrypt_community_payload(&community_id_c, &plaintext, &aad))
            .await
            .map_err(|e| CommandError::Other(e.to_string()))?;
        // Publish to both meta and legacy topics
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: community_meta_topic(&community_id),
                data: data.clone(),
            })
            .await
        {
            tracing::warn!("network publish community delete to meta topic failed: {}", e);
        }
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: format!("mesh/community/{}/messages", community_id),
                data,
            })
            .await
        {
            tracing::warn!("network publish community delete to legacy topic failed: {}", e);
        }
    }

    control::apply_control_event(&app_handle, &db, &delete_event, &owner_public_key)?;

    if let Some(ref net) = *network {
        if let Err(e) = net
            .send_command(NetworkCommand::UnsubscribeTopic {
                topic: community_meta_topic(&community_id),
            })
            .await
        {
            tracing::warn!("network unsubscribe from meta topic failed: {}", e);
        }
        if let Err(e) = net
            .send_command(NetworkCommand::UnsubscribeTopic {
                topic: format!("mesh/community/{}/messages", community_id),
            })
            .await
        {
            tracing::warn!("network unsubscribe from legacy topic failed: {}", e);
        }
        if let Err(e) = net
            .send_command(NetworkCommand::UnsubscribeTopic {
                topic: format!("mesh/community/{}/presence", community_id),
            })
            .await
        {
            tracing::warn!("network unsubscribe from presence topic failed: {}", e);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn generate_invite_link(
    community_id: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<String, CommandError> {
    let created_by = require_community_permission(&state, &db, &community_id, "owner").await?;
    // Generate a v2 invite — no group key in the URL
    let community_id_c = community_id.clone();
    let owner_public_key = db
        .run_blocking(move |db| db.get_community_owner_public_key(&community_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?
        .unwrap_or_default();
    let bootstrap_peers = discovery::default_bootstrap_peers();

    // Create a one-time invite secret
    let invite_secret = nanoid::nanoid!(32);
    let community_id_c = community_id.clone();
    let invite_secret_c = invite_secret.clone();
    let created_by_c = created_by.clone();
    db.run_blocking(move |db| db.create_invite(&community_id_c, &invite_secret_c, &created_by_c, Some(1), None))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("v", "2");
    serializer.append_pair("c", &community_id);
    if !owner_public_key.is_empty() {
        serializer.append_pair("o", &owner_public_key);
    }
    if !bootstrap_peers.is_empty() {
        serializer.append_pair("b", &bootstrap_peers.join(","));
    }
    serializer.append_pair("t", &invite_secret);

    Ok(format!("mesh://join?{}", serializer.finish()))
}

struct ParsedInvite {
    version: u8,
    community_id: String,
    peer_addrs: Vec<String>,
    bootstrap_addrs: Vec<String>,
    group_key: Option<String>,
    owner_public_key: Option<String>,
    invite_secret: Option<String>,
}

async fn announce_presence(
    state: &AppState,
    db: &Database,
    net: &crate::network::events::NetworkHandle,
    community_id: &str,
) -> Result<(), CommandError> {
    let identity = state.identity.read().await;
    let Some(id) = identity.as_ref() else {
        return Ok(());
    };

    let presence = EnvelopeBuilder::new("presence", &id.public_key_b64, community_id)
        .payload_typed(&PresencePayload {
            status: "online".into(),
        })
        .sign(&id.private_key_bytes());
    if !state
        .rate_limits
        .allow(RateLimitBucket::Presence, community_id, &id.public_key_b64)
        .await
    {
        return Ok(());
    }
    let plaintext = serde_json::to_vec(&presence).map_err(|e| CommandError::Other(e.to_string()))?;
    let community_id_c = community_id.to_string();
    let aad = encryption::build_community_aad(community_id, "");
    let data = db
        .run_blocking(move |db| db.encrypt_community_payload(&community_id_c, &plaintext, &aad))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    if let Err(e) = net
        .send_command(NetworkCommand::PublishMessage {
            topic: format!("mesh/community/{}/presence", community_id),
            data,
        })
        .await
    {
        tracing::warn!("network publish presence failed: {}", e);
    }

    Ok(())
}

fn parse_invite_link(link: &str) -> anyhow::Result<ParsedInvite> {
    let normalized = link.replace("mesh://", "https://mesh.app/");
    let url =
        url::Url::parse(&normalized).map_err(|_| anyhow::anyhow!("Invalid invite link format"))?;

    let community_id = url
        .query_pairs()
        .find(|(k, _)| k == "c")
        .map(|(_, v)| v.to_string())
        .ok_or_else(|| anyhow::anyhow!("Missing community ID in invite"))?;

    let peer_addrs = split_query_list(&url, "peers");
    let bootstrap_addrs = split_query_list(&url, "b");
    let version = url
        .query_pairs()
        .find(|(k, _)| k == "v")
        .and_then(|(_, v)| v.parse::<u8>().ok())
        .unwrap_or(1);
    let group_key = url
        .query_pairs()
        .find(|(k, _)| k == "k")
        .map(|(_, v)| v.to_string());
    let owner_public_key = url
        .query_pairs()
        .find(|(k, _)| k == "o")
        .map(|(_, v)| v.to_string());
    let invite_secret = url
        .query_pairs()
        .find(|(k, _)| k == "t")
        .map(|(_, v)| v.to_string());

    if version == 1 {
        // V1 invite links leak the group key directly in the URL. This is a
        // security risk: anyone who sees the link can decrypt all community
        // messages. Reject V1 invites entirely — only V2 (token-based) invites
        // are accepted.
        tracing::error!(
            "Rejecting insecure v1 invite for community {} — v1 invites leak the group key in the URL and are no longer accepted",
            community_id
        );
        return Err(anyhow::anyhow!(
            "This invite link uses the legacy v1 format which is no longer accepted for security reasons. Please ask the community owner to generate a new invite link."
        ));
    }

    Ok(ParsedInvite {
        version,
        community_id,
        peer_addrs,
        bootstrap_addrs,
        group_key,
        owner_public_key,
        invite_secret,
    })
}

fn split_query_list(url: &url::Url, key: &str) -> Vec<String> {
    url.query_pairs()
        .find(|(current_key, _)| current_key == key)
        .map(|(_, value)| value.to_string())
        .unwrap_or_default()
        .split(',')
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .collect()
}

/// Subscribe to a per-channel gossipsub topic. Called by the frontend when
/// the user opens/views a channel.
#[tauri::command]
pub async fn subscribe_channel(
    community_id: String,
    channel_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let network = state.network.read().await;
    if let Some(ref net) = *network {
        if let Err(e) = net
            .send_command(NetworkCommand::SubscribeChannel {
                community_id,
                channel_id,
            })
            .await
        {
            tracing::warn!("network subscribe to channel failed: {}", e);
        }
    }
    Ok(())
}

/// Unsubscribe from a per-channel gossipsub topic. Called by the frontend
/// when the user navigates away from a channel.
#[tauri::command]
pub async fn unsubscribe_channel(
    community_id: String,
    channel_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let network = state.network.read().await;
    if let Some(ref net) = *network {
        if let Err(e) = net
            .send_command(NetworkCommand::UnsubscribeChannel {
                community_id,
                channel_id,
            })
            .await
        {
            tracing::warn!("network unsubscribe from channel failed: {}", e);
        }
    }
    Ok(())
}
