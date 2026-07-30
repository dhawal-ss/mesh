use tauri::{AppHandle, Emitter, Manager};

use crate::network::envelope::{
    FileAnnouncedPayload, MessageDeletePayload, MessageEditPayload, MessagePayload,
    ReactionPayload, SignedEnvelope,
};
use crate::state::rate_limits::RateLimitBucket;
use crate::state::AppState;
use crate::storage::Database;
use crate::types::message::{AttachmentDto, MessageDto};

use super::helpers;
use super::security;

/// Truncate a string to at most `max_bytes` bytes without splitting a
/// multi-byte UTF-8 character, appending "…" when truncation occurs.
pub(super) fn truncate_preview(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

pub(super) async fn route_signed_message(app_handle: &AppHandle, envelope: &SignedEnvelope) {
    let Ok(payload) = serde_json::from_value::<MessagePayload>(envelope.payload.clone()) else {
        tracing::warn!("Dropping malformed message payload {}", envelope.id);
        return;
    };
    let Some(channel_id) = envelope.channel_id.clone() else {
        tracing::warn!("Dropping message {} without channel_id", envelope.id);
        return;
    };

    if !security::enforce_rate_limit(
        app_handle,
        RateLimitBucket::Message,
        &envelope.community_id,
        &envelope.author,
    )
    .await
    {
        return;
    }

    let attachments = payload
        .attachments
        .into_iter()
        .map(|attachment| AttachmentDto {
            file_hash: attachment.file_hash,
            filename: attachment.filename,
            size: attachment.size,
            chunks: attachment.chunks,
            source_peer_id: attachment.source_peer_id,
            content_type: None,
            thumbnail: None,
        })
        .collect();
    let message = MessageDto {
        id: envelope.id.clone(),
        channel_id,
        author_public_key: envelope.author.clone(),
        author_display_name: envelope.display_name(),
        author_avatar_color: envelope.avatar_color(),
        content: payload.content,
        attachments,
        reactions: Default::default(),
        timestamp: envelope.timestamp.clone(),
        signature: envelope.signature.clone(),
        edited_at: None,
        deleted_at: None,
        reply_to_id: payload.reply_to_id,
        transaction_id: None,
        client_request_id: None,
        delivery_status: None,
        undecryptable: None,
    };

    if let Some(db) = app_handle.try_state::<Database>() {
        let should_emit = helpers::insert_message_if_new(&db, &message);
        if should_emit {
            // Append to immutable event log
            let _ = db.append_channel_event(
                &message.channel_id,
                "message",
                &message.id,
                None,
                &message.author_public_key,
                &serde_json::to_string(&serde_json::json!({
                    "content": &message.content,
                    "attachments": &message.attachments,
                    "replyToId": &message.reply_to_id,
                }))
                .unwrap_or_default(),
                &message.signature,
                &message.timestamp,
            );
            let _ = app_handle.emit("message:received", &message);

            // Send desktop notification for messages from other users
            let is_own_message = app_handle
                .try_state::<AppState>()
                .and_then(|state| {
                    let identity = state.identity.blocking_read();
                    identity
                        .as_ref()
                        .map(|id| id.public_key_b64 == message.author_public_key)
                })
                .unwrap_or(false);

            let window_focused = app_handle
                .get_webview_window("main")
                .map(|w| w.is_focused().unwrap_or(false))
                .unwrap_or(false);

            if !is_own_message && !window_focused {
                // Check if the channel is muted via kv_store
                let is_muted = app_handle
                    .try_state::<Database>()
                    .and_then(|db| {
                        let conn = db.conn.lock().ok()?;
                        let json: String = conn
                            .query_row(
                                "SELECT value FROM kv_store WHERE key = 'muted_channels'",
                                [],
                                |row| row.get(0),
                            )
                            .ok()?;
                        serde_json::from_str::<Vec<String>>(&json).ok()
                    })
                    .map(|muted| muted.contains(&message.channel_id))
                    .unwrap_or(false);

                if !is_muted {
                    let preview = truncate_preview(&message.content, 100);
                    let _ = tauri_plugin_notification::NotificationExt::notification(app_handle)
                        .builder()
                        .title(&message.author_display_name)
                        .body(&preview)
                        .show();
                }
            }
        }
    }
}

pub(super) async fn route_signed_message_edit(app_handle: &AppHandle, envelope: &SignedEnvelope) {
    let Ok(payload) = serde_json::from_value::<MessageEditPayload>(envelope.payload.clone()) else {
        tracing::warn!("Dropping malformed message_edit payload {}", envelope.id);
        return;
    };
    let channel_id = envelope.channel_id.clone().unwrap_or_default();

    if !security::enforce_rate_limit(
        app_handle,
        RateLimitBucket::MessageEdit,
        &envelope.community_id,
        &envelope.author,
    )
    .await
    {
        tracing::warn!(
            "Rate-limited message_edit {} from {}",
            envelope.id,
            envelope.author,
        );
        return;
    }

    if let Some(db) = app_handle.try_state::<Database>() {
        // Verify the envelope author matches the original message author
        if let Ok(Some(existing)) = db.get_message_by_id(&payload.message_id) {
            if existing.author_public_key != envelope.author {
                tracing::warn!("Dropping message_edit {} — author mismatch", envelope.id);
                return;
            }
        } else {
            tracing::debug!(
                "Received edit for unknown message {}, applying anyway",
                payload.message_id
            );
        }

        if let Err(e) = db.update_message_content(
            &payload.message_id,
            &payload.content,
            &envelope.author,
            &envelope.timestamp,
        ) {
            tracing::warn!("Failed to apply message edit: {}", e);
            return;
        }

        // Append edit to immutable event log
        let _ = db.append_channel_event(
            &channel_id,
            "edit",
            &envelope.id,
            Some(&payload.message_id),
            &envelope.author,
            &serde_json::to_string(&serde_json::json!({ "content": payload.content }))
                .unwrap_or_default(),
            &envelope.signature,
            &envelope.timestamp,
        );

        let _ = app_handle.emit(
            "message:edited",
            serde_json::json!({
                "messageId": payload.message_id,
                "channelId": channel_id,
                "content": payload.content,
                "editedAt": chrono::Utc::now().to_rfc3339(),
            }),
        );
    }
}

pub(super) async fn route_signed_message_delete(app_handle: &AppHandle, envelope: &SignedEnvelope) {
    let Ok(payload) = serde_json::from_value::<MessageDeletePayload>(envelope.payload.clone())
    else {
        tracing::warn!("Dropping malformed message_delete payload {}", envelope.id);
        return;
    };
    let channel_id = envelope.channel_id.clone().unwrap_or_default();

    if !security::enforce_rate_limit(
        app_handle,
        RateLimitBucket::MessageEdit,
        &envelope.community_id,
        &envelope.author,
    )
    .await
    {
        tracing::warn!(
            "Rate-limited message_delete {} from {}",
            envelope.id,
            envelope.author,
        );
        return;
    }

    if let Some(db) = app_handle.try_state::<Database>() {
        // Verify the envelope author matches the original message author, or has mod rights
        if let Ok(Some(existing)) = db.get_message_by_id(&payload.message_id) {
            if existing.author_public_key != envelope.author {
                // Allow admin/owner to delete any message
                let has_mod_rights = app_handle
                    .try_state::<crate::state::AppState>()
                    .map(|state| {
                        state
                            .membership
                            .has_permission(&envelope.community_id, &envelope.author, "admin")
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
                if !has_mod_rights {
                    tracing::warn!(
                        "Dropping message_delete {} — author mismatch and no mod rights",
                        envelope.id,
                    );
                    return;
                }
            }
        }

        if let Err(e) = db.moderator_delete_message(&payload.message_id) {
            tracing::warn!("Failed to apply message delete: {}", e);
            return;
        }

        // Append delete to immutable event log
        let _ = db.append_channel_event(
            &channel_id,
            "delete",
            &envelope.id,
            Some(&payload.message_id),
            &envelope.author,
            "{}",
            &envelope.signature,
            &envelope.timestamp,
        );

        let _ = app_handle.emit(
            "message:deleted",
            serde_json::json!({
                "messageId": payload.message_id,
                "channelId": channel_id,
            }),
        );
    }
}

pub(super) async fn route_signed_reaction(app_handle: &AppHandle, envelope: &SignedEnvelope) {
    let Ok(payload) = serde_json::from_value::<ReactionPayload>(envelope.payload.clone()) else {
        tracing::warn!("Dropping malformed reaction payload {}", envelope.id);
        return;
    };
    let Some(channel_id) = envelope.channel_id.clone() else {
        tracing::warn!("Dropping reaction {} without channel_id", envelope.id);
        return;
    };

    if !security::enforce_rate_limit(
        app_handle,
        RateLimitBucket::Reaction,
        &envelope.community_id,
        &envelope.author,
    )
    .await
    {
        return;
    }

    // Verify the target message belongs to the envelope's community and channel
    if let Some(db) = app_handle.try_state::<Database>() {
        match db.get_channel_and_community_for_message(&payload.message_id) {
            Ok((msg_channel_id, msg_community_id)) => {
                if msg_community_id != envelope.community_id || msg_channel_id != channel_id {
                    tracing::warn!(
                        "Dropping cross-scope reaction {} — target message {} is in {}/{} not {}/{}",
                        envelope.id,
                        payload.message_id,
                        msg_community_id,
                        msg_channel_id,
                        envelope.community_id,
                        channel_id,
                    );
                    return;
                }
            }
            Err(_) => {
                // Message not found locally — apply optimistically
                // (the message may arrive later via history sync)
            }
        }
    }

    if let Some(db) = app_handle.try_state::<Database>() {
        match payload.verb.as_str() {
            "remove" => {
                let _ = db.remove_reaction_idempotent(
                    &payload.message_id,
                    &payload.emoji,
                    &envelope.author,
                );
            }
            _ => {
                let _ = db.add_reaction_idempotent(
                    &payload.message_id,
                    &payload.emoji,
                    &envelope.author,
                );
            }
        }

        // Append reaction to the immutable event log for convergence
        let event_type = match payload.verb.as_str() {
            "remove" => "reaction_remove",
            _ => "reaction_add",
        };
        let _ = db.append_channel_event(
            &channel_id,
            event_type,
            &envelope.id,
            Some(&payload.message_id),
            &envelope.author,
            &serde_json::to_string(&serde_json::json!({
                "emoji": &payload.emoji,
                "verb": &payload.verb,
            }))
            .unwrap_or_default(),
            &envelope.signature,
            &envelope.timestamp,
        );
    }

    let _ = app_handle.emit(
        "reaction:received",
        &serde_json::json!({
            "messageId": payload.message_id,
            "channelId": channel_id,
            "emoji": payload.emoji,
            "author": envelope.author,
            "verb": payload.verb,
        }),
    );
}

pub(super) async fn route_signed_presence(app_handle: &AppHandle, envelope: &SignedEnvelope) {
    let status = envelope
        .payload
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("online");

    if !security::enforce_rate_limit(
        app_handle,
        RateLimitBucket::Presence,
        &envelope.community_id,
        &envelope.author,
    )
    .await
    {
        return;
    }

    if let Some(db) = app_handle.try_state::<Database>() {
        if !envelope.community_id.is_empty() {
            let _ = db.touch_member(&envelope.community_id, &envelope.author);
            if let Some(state) = app_handle.try_state::<AppState>() {
                let _ = state.membership.touch_member(
                    &envelope.community_id,
                    &envelope.author,
                    chrono::Utc::now().to_rfc3339(),
                );
            }
        }
    }

    let _ = app_handle.emit(
        "presence:update",
        serde_json::json!({
            "author": envelope.author,
            "communityId": envelope.community_id,
            "status": status,
        }),
    );
}

pub(super) async fn route_signed_file_announcement(
    app_handle: &AppHandle,
    envelope: &SignedEnvelope,
) {
    let Ok(payload) = serde_json::from_value::<FileAnnouncedPayload>(envelope.payload.clone())
    else {
        tracing::warn!("Dropping malformed file announcement {}", envelope.id);
        return;
    };

    if !security::enforce_rate_limit(
        app_handle,
        RateLimitBucket::FileAnnouncement,
        &envelope.community_id,
        &envelope.author,
    )
    .await
    {
        return;
    }

    // Record the seeder in the file_availability table
    if let Some(db) = app_handle.try_state::<Database>() {
        let _ = db.record_file_availability(
            &payload.file_hash,
            &payload.source_peer_id,
            &payload.file_name,
            payload.size as i64,
        );
    }

    if let Some(message) = helpers::signed_file_announcement_to_message(envelope, &payload) {
        let should_emit = if let Some(db) = app_handle.try_state::<Database>() {
            helpers::insert_message_if_new(&db, &message)
        } else {
            true
        };
        if should_emit {
            let _ = app_handle.emit("message:received", &message);
        }
    }
}

pub(super) fn route_signed_ban(app_handle: &AppHandle, envelope: &SignedEnvelope) {
    let Some(signed_by) = envelope.signed_by.as_deref() else {
        tracing::warn!("Dropping ban {} without signer", envelope.id);
        return;
    };
    let Some(owner_public_key) =
        security::trusted_owner_public_key(app_handle, &envelope.community_id)
    else {
        tracing::warn!(
            "Dropping ban {} without trusted owner key for {}",
            envelope.id,
            envelope.community_id
        );
        return;
    };
    if signed_by != owner_public_key {
        tracing::warn!(
            "Dropping ban {} signed by unexpected key {}",
            envelope.id,
            signed_by
        );
        return;
    }

    let banned_public_key = envelope
        .payload
        .get("banned_public_key")
        .or_else(|| envelope.payload.get("bannedPublicKey"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if banned_public_key.is_empty() {
        return;
    }

    // Check if this ban is already applied (prevent replay side effects)
    if let Some(db) = app_handle.try_state::<Database>() {
        if db
            .is_banned(&envelope.community_id, banned_public_key)
            .unwrap_or(false)
        {
            tracing::debug!(
                "Ban for {} in {} already applied, skipping",
                banned_public_key,
                envelope.community_id
            );
            return;
        }
    }

    if let Some(db) = app_handle.try_state::<Database>() {
        if let Ok(conn) = db.conn.lock() {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO ban_list (community_id, public_key, banned_at, signed_by, signature) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    envelope.community_id,
                    banned_public_key,
                    envelope.timestamp,
                    signed_by,
                    envelope.signature
                ],
            );
        }
        let _ = db.remove_reactions_by_author(&envelope.community_id, banned_public_key);
        let _ = app_handle.emit("ban_received", envelope);
    }
}
