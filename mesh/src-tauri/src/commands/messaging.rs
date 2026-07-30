use std::collections::HashMap;

use tauri::State;

use crate::network::envelope::{
    AttachmentPayload, EnvelopeBuilder, MessageDeletePayload, MessageEditPayload, MessagePayload,
    ReactionPayload,
};
use crate::network::events::NetworkCommand;
use crate::state::rate_limits::RateLimitBucket;
use crate::state::AppState;
use crate::storage::Database;
use crate::types::message::{AttachmentDto, MessageDto};

use super::error::CommandError;
use super::publish::encrypt_and_publish;

#[tauri::command]
pub async fn send_message(
    channel_id: String,
    content: String,
    attachments: Vec<AttachmentDto>,
    reply_to_id: Option<String>,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<MessageDto, CommandError> {
    let (public_key, private_key_bytes) = {
        let guard = state.identity.read().await;
        let id = guard
            .as_ref()
            .ok_or(CommandError::Validation("No identity loaded".into()))?;
        (id.public_key_b64.clone(), id.private_key_bytes())
    };

    let channel_id_c = channel_id.clone();
    let community_id = db
        .run_blocking(move |db| db.get_community_for_channel(&channel_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    let community_id_c = community_id.clone();
    let public_key_c = public_key.clone();
    let is_banned = db
        .run_blocking(move |db| db.is_banned(&community_id_c, &public_key_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    if is_banned {
        return Err(CommandError::Banned);
    }

    if !state
        .rate_limits
        .allow(RateLimitBucket::Message, &community_id, &public_key)
        .await
    {
        return Err(CommandError::RateLimited);
    }

    let public_key_c = public_key.clone();
    let profile = db
        .run_blocking(move |db| db.get_local_profile(&public_key_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?
        .ok_or(CommandError::NotFound("No profile found".into()))?;

    let payload = MessagePayload {
        content: content.clone(),
        attachments: attachments
            .iter()
            .map(|attachment| AttachmentPayload {
                file_hash: attachment.file_hash.clone(),
                filename: attachment.filename.clone(),
                size: attachment.size,
                chunks: attachment.chunks,
                source_peer_id: attachment.source_peer_id.clone(),
            })
            .collect(),
        author_display_name: profile.display_name.clone(),
        author_avatar_color: profile.avatar_color.clone(),
        reply_to_id: reply_to_id.clone(),
    };

    let envelope = EnvelopeBuilder::new("message", &public_key, &community_id)
        .channel_id(&channel_id)
        .payload_typed(&payload)
        .sign(&private_key_bytes);

    let msg_dto = MessageDto {
        id: envelope.id.clone(),
        channel_id: channel_id.clone(),
        author_public_key: public_key.clone(),
        author_display_name: profile.display_name.clone(),
        author_avatar_color: profile.avatar_color.clone(),
        content: content.clone(),
        attachments,
        reactions: HashMap::new(),
        timestamp: envelope.timestamp.clone(),
        signature: envelope.signature.clone(),
        edited_at: None,
        deleted_at: None,
        reply_to_id,
        transaction_id: None,
        client_request_id: None,
        delivery_status: None,
        undecryptable: None,
    };

    let msg_dto_c = msg_dto.clone();
    db.run_blocking(move |db| db.insert_message(&msg_dto_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    let network = state.network.read().await;
    if let Some(ref net) = *network {
        encrypt_and_publish(&db, net, &envelope, &community_id, &channel_id).await?;
    }

    Ok(msg_dto)
}

#[tauri::command]
pub async fn edit_message(
    message_id: String,
    content: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<MessageDto, CommandError> {
    let (public_key, private_key_bytes) = {
        let guard = state.identity.read().await;
        let id = guard
            .as_ref()
            .ok_or(CommandError::Validation("No identity loaded".into()))?;
        (id.public_key_b64.clone(), id.private_key_bytes())
    };

    let message_id_c = message_id.clone();
    let (channel_id, community_id) = db
        .run_blocking(move |db| db.get_channel_and_community_for_message(&message_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    let community_id_c = community_id.clone();
    let public_key_c = public_key.clone();
    let is_banned = db
        .run_blocking(move |db| db.is_banned(&community_id_c, &public_key_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    if is_banned {
        return Err(CommandError::Banned);
    }

    // Only the author can edit their own message
    let message_id_c = message_id.clone();
    let existing = db
        .run_blocking(move |db| db.get_message_by_id(&message_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?
        .ok_or(CommandError::NotFound("Message not found".into()))?;
    if existing.author_public_key != public_key {
        return Err(CommandError::PermissionDenied(
            "You can only edit your own messages".into(),
        ));
    }

    let edit_timestamp = chrono::Utc::now().to_rfc3339();

    let message_id_c = message_id.clone();
    let content_c = content.clone();
    let public_key_c = public_key.clone();
    let edit_timestamp_c = edit_timestamp.clone();
    db.run_blocking(move |db| {
        db.update_message_content(&message_id_c, &content_c, &public_key_c, &edit_timestamp_c)
    })
    .await
    .map_err(|e| CommandError::Other(e.to_string()))?;

    let payload = MessageEditPayload {
        message_id: message_id.clone(),
        content: content.clone(),
    };
    let envelope = EnvelopeBuilder::new("message_edit", &public_key, &community_id)
        .channel_id(&channel_id)
        .payload_typed(&payload)
        .sign(&private_key_bytes);

    let network = state.network.read().await;
    if let Some(ref net) = *network {
        encrypt_and_publish(&db, net, &envelope, &community_id, &channel_id).await?;
    }

    let message_id_c = message_id.clone();
    db.run_blocking(move |db| db.get_message_by_id(&message_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?
        .ok_or(CommandError::NotFound(
            "Message not found after edit".into(),
        ))
}

#[tauri::command]
pub async fn delete_message(
    message_id: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<(), CommandError> {
    let (public_key, private_key_bytes) = {
        let guard = state.identity.read().await;
        let id = guard
            .as_ref()
            .ok_or(CommandError::Validation("No identity loaded".into()))?;
        (id.public_key_b64.clone(), id.private_key_bytes())
    };

    let message_id_c = message_id.clone();
    let (channel_id, community_id) = db
        .run_blocking(move |db| db.get_channel_and_community_for_message(&message_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    let community_id_c = community_id.clone();
    let public_key_c = public_key.clone();
    let is_banned = db
        .run_blocking(move |db| db.is_banned(&community_id_c, &public_key_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    if is_banned {
        return Err(CommandError::Banned);
    }

    // Allow author OR admin/owner to delete the message
    let message_id_c = message_id.clone();
    let existing = db
        .run_blocking(move |db| db.get_message_by_id(&message_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?
        .ok_or(CommandError::NotFound("Message not found".into()))?;
    let is_author = existing.author_public_key == public_key;
    if !is_author {
        let has_mod_rights = state
            .membership
            .has_permission(&community_id, &public_key, "admin")
            .unwrap_or(false);
        if !has_mod_rights {
            return Err(CommandError::PermissionDenied(
                "You can only delete your own messages".into(),
            ));
        }
    }

    if is_author {
        let message_id_c = message_id.clone();
        let public_key_c = public_key.clone();
        db.run_blocking(move |db| db.soft_delete_message(&message_id_c, &public_key_c))
            .await
            .map_err(|e| CommandError::Other(e.to_string()))?;
    } else {
        let message_id_c = message_id.clone();
        db.run_blocking(move |db| db.moderator_delete_message(&message_id_c))
            .await
            .map_err(|e| CommandError::Other(e.to_string()))?;
    }

    let payload = MessageDeletePayload {
        message_id: message_id.clone(),
    };
    let envelope = EnvelopeBuilder::new("message_delete", &public_key, &community_id)
        .channel_id(&channel_id)
        .payload_typed(&payload)
        .sign(&private_key_bytes);

    let network = state.network.read().await;
    if let Some(ref net) = *network {
        encrypt_and_publish(&db, net, &envelope, &community_id, &channel_id).await?;
    }

    Ok(())
}

#[tauri::command]
pub async fn get_messages(
    channel_id: String,
    limit: u32,
    before_timestamp: Option<String>,
    before_id: Option<String>,
    db: State<'_, Database>,
) -> Result<Vec<MessageDto>, CommandError> {
    db.run_blocking(move |db| {
        db.get_messages(
            &channel_id,
            limit,
            before_timestamp.as_deref(),
            before_id.as_deref(),
        )
    })
    .await
    .map_err(|e| CommandError::Other(e.to_string()))
}

#[tauri::command]
pub async fn mark_channel_read(
    channel_id: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<(), CommandError> {
    let public_key = {
        let guard = state.identity.read().await;
        let id = guard
            .as_ref()
            .ok_or(CommandError::Validation("No identity loaded".into()))?;
        id.public_key_b64.clone()
    };

    let channel_id_c = channel_id.clone();
    let community_id = db
        .run_blocking(move |db| db.get_community_for_channel(&channel_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    let channel_id_c = channel_id.clone();
    let cursor = db
        .run_blocking(move |db| db.get_latest_message_cursor(&channel_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    if let Some((timestamp, message_id)) = cursor {
        let community_id_c = community_id.clone();
        let channel_id_c = channel_id.clone();
        let public_key_c = public_key.clone();
        db.run_blocking(move |db| {
            db.set_last_read(
                &community_id_c,
                &channel_id_c,
                &public_key_c,
                &message_id,
                &timestamp,
            )
        })
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn request_message_history(
    channel_id: String,
    peer_id: Option<String>,
    limit: Option<u32>,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<(), CommandError> {
    let channel_id_c = channel_id.clone();
    let cursor = db
        .run_blocking(move |db| db.get_latest_message_cursor(&channel_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    // Look up local latest event sequence for this channel.
    // Used for diagnostics and will be included in future
    // event-based history request protocol messages.
    let channel_id_c = channel_id.clone();
    let local_seq = db
        .run_blocking(move |db| db.get_channel_sequence(&channel_id_c).unwrap_or(0))
        .await;
    tracing::debug!(
        "request_message_history: channel={} local_seq={} cursor={:?}",
        channel_id,
        local_seq,
        cursor.as_ref().map(|(ts, _)| ts.as_str()),
    );

    let (our_public_key, request_signature, request_timestamp) = {
        let identity = state.identity.read().await;
        match identity.as_ref() {
            Some(id) => {
                let pk = id.public_key_b64.clone();
                let ts = chrono::Utc::now().to_rfc3339();
                let signable = format!("history-req:{}:{}:{}", channel_id, pk, ts);
                let sig = id.sign(signable.as_bytes());
                (pk, sig, ts)
            }
            None => (String::new(), String::new(), String::new()),
        }
    };
    let network = state.network.read().await;

    if let Some(ref net) = *network {
        if let Err(e) = net
            .send_command(NetworkCommand::RequestMessageHistory {
                peer_id,
                channel_id,
                since_timestamp: cursor.as_ref().map(|(timestamp, _)| timestamp.clone()),
                since_id: cursor.as_ref().map(|(_, id)| id.clone()),
                limit: limit.unwrap_or(100),
                requester_public_key: our_public_key,
                request_signature,
                request_timestamp,
            })
            .await
        {
            tracing::warn!("network request_message_history failed: {}", e);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn add_reaction(
    message_id: String,
    emoji: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<String, CommandError> {
    let (public_key, private_key_bytes) = {
        let guard = state.identity.read().await;
        let id = guard
            .as_ref()
            .ok_or(CommandError::Validation("No identity loaded".into()))?;
        (id.public_key_b64.clone(), id.private_key_bytes())
    };

    let message_id_c = message_id.clone();
    let (channel_id, community_id) = db
        .run_blocking(move |db| db.get_channel_and_community_for_message(&message_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    let community_id_c = community_id.clone();
    let public_key_c = public_key.clone();
    let is_banned = db
        .run_blocking(move |db| db.is_banned(&community_id_c, &public_key_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    if is_banned {
        return Err(CommandError::Banned);
    }

    if !state
        .rate_limits
        .allow(RateLimitBucket::Reaction, &community_id, &public_key)
        .await
    {
        return Err(CommandError::RateLimited);
    }

    let message_id_c = message_id.clone();
    let emoji_c = emoji.clone();
    let public_key_c = public_key.clone();
    let verb = db
        .run_blocking(move |db| db.add_reaction(&message_id_c, &emoji_c, &public_key_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    let payload = ReactionPayload {
        message_id: message_id.clone(),
        emoji: emoji.clone(),
        verb: verb.clone(),
    };
    let envelope = EnvelopeBuilder::new("reaction", &public_key, &community_id)
        .channel_id(&channel_id)
        .payload_typed(&payload)
        .sign(&private_key_bytes);

    let network = state.network.read().await;
    if let Some(ref net) = *network {
        encrypt_and_publish(&db, net, &envelope, &community_id, &channel_id).await?;
    }

    Ok(verb)
}

#[tauri::command]
pub async fn broadcast_typing(
    channel_id: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<(), CommandError> {
    let (public_key, private_key_bytes) = {
        let guard = state.identity.read().await;
        let id = guard
            .as_ref()
            .ok_or(CommandError::Validation("No identity loaded".into()))?;
        (id.public_key_b64.clone(), id.private_key_bytes())
    };

    let channel_id_c = channel_id.clone();
    let community_id = db
        .run_blocking(move |db| db.get_community_for_channel(&channel_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    let public_key_c = public_key.clone();
    let profile = db
        .run_blocking(move |db| db.get_local_profile(&public_key_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?
        .ok_or(CommandError::NotFound("No profile found".into()))?;

    let payload = serde_json::json!({
        "author_display_name": profile.display_name,
        "author_avatar_color": profile.avatar_color,
    });

    let envelope = EnvelopeBuilder::new("typing", &public_key, &community_id)
        .channel_id(&channel_id)
        .payload(payload)
        .sign(&private_key_bytes);

    let network = state.network.read().await;
    if let Some(ref net) = *network {
        encrypt_and_publish(&db, net, &envelope, &community_id, &channel_id).await?;
    }

    Ok(())
}

#[tauri::command]
pub async fn search_messages(
    query: String,
    community_id: String,
    limit: Option<u32>,
    db: State<'_, Database>,
) -> Result<Vec<MessageDto>, CommandError> {
    let limit = limit.unwrap_or(50);
    db.run_blocking(move |db| db.search_messages(&query, &community_id, limit))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))
}

#[tauri::command]
pub async fn get_channel_event_log(
    channel_id: String,
    since_sequence: i64,
    limit: Option<u32>,
    db: State<'_, Database>,
) -> Result<serde_json::Value, CommandError> {
    let limit = limit.unwrap_or(500);
    let channel_id_c = channel_id.clone();
    let events = db
        .run_blocking(move |db| db.get_channel_events(&channel_id_c, since_sequence, limit))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    let channel_id_c2 = channel_id.clone();
    let latest_seq = db
        .run_blocking(move |db| db.get_channel_sequence(&channel_id_c2))
        .await
        .unwrap_or(0);

    Ok(serde_json::json!({
        "channelId": channel_id,
        "events": events,
        "latestSequence": latest_seq,
    }))
}
