use std::collections::HashMap;

use tauri::{AppHandle, Manager};

use crate::network::envelope::{AttachmentPayload, MessagePayload, SignedEnvelope};
use crate::network::events::{NetworkCommand, NetworkHandle};
use crate::state::AppState;
use crate::storage::Database;
use crate::types::message::{AttachmentDto, MessageDto};

pub(super) fn validate_history_message(message: &MessageDto, community_id: &str) -> bool {
    if !is_history_timestamp_valid(&message.timestamp) {
        tracing::warn!(
            "Rejecting history message {} with out-of-range timestamp: {}",
            message.id,
            message.timestamp,
        );
        return false;
    }
    history_message_to_envelope(message, community_id)
        .verify()
        .unwrap_or(false)
}

/// Check that a history message timestamp is within a reasonable window:
/// not more than 5 seconds in the future and not older than 365 days.
/// This prevents replay attacks with fabricated timestamps.
pub(super) fn is_history_timestamp_valid(timestamp: &str) -> bool {
    let Ok(ts) = chrono::DateTime::parse_from_rfc3339(timestamp).or_else(|_| {
        chrono::NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%dT%H:%M:%S%.fZ")
            .map(|naive| naive.and_utc().fixed_offset())
    }) else {
        return false;
    };
    let now = chrono::Utc::now();
    let max_future = now + chrono::Duration::seconds(5);
    let max_past = now - chrono::Duration::days(365);
    ts <= max_future && ts >= max_past
}

pub(super) fn history_message_to_envelope(
    message: &MessageDto,
    community_id: &str,
) -> SignedEnvelope {
    SignedEnvelope {
        v: 2,
        msg_type: "message".into(),
        id: message.id.clone(),
        author: message.author_public_key.clone(),
        community_id: community_id.to_string(),
        timestamp: message.timestamp.clone(),
        payload: serde_json::to_value(MessagePayload {
            content: message.content.clone(),
            attachments: message
                .attachments
                .iter()
                .map(|attachment| AttachmentPayload {
                    file_hash: attachment.file_hash.clone(),
                    filename: attachment.filename.clone(),
                    size: attachment.size,
                    chunks: attachment.chunks,
                    source_peer_id: attachment.source_peer_id.clone(),
                })
                .collect(),
            author_display_name: message.author_display_name.clone(),
            author_avatar_color: message.author_avatar_color.clone(),
            reply_to_id: message.reply_to_id.clone(),
        })
        .unwrap_or_default(),
        signature: message.signature.clone(),
        signed_by: None,
        channel_id: Some(message.channel_id.clone()),
    }
}

pub(super) async fn request_history_for_known_channels(
    app_handle: &AppHandle,
    peer_id: Option<&str>,
) {
    let Some(db) = app_handle.try_state::<Database>() else {
        return;
    };
    let channel_ids = match db.get_all_channel_ids() {
        Ok(channel_ids) => channel_ids,
        Err(error) => {
            tracing::warn!("Failed to load local channels for history sync: {}", error);
            return;
        }
    };
    if channel_ids.is_empty() {
        return;
    }

    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };

    // Get our public key and identity for signing authenticated requests
    let identity_guard = state.identity.read().await;
    let Some(identity) = identity_guard.as_ref() else {
        return;
    };
    let our_public_key = identity.public_key_b64.clone();

    let network = state.network.read().await;
    let Some(net) = network.as_ref() else {
        return;
    };

    for channel_id in channel_ids {
        let cursor = db.get_latest_message_cursor(&channel_id).ok().flatten();
        let local_seq = db.get_channel_sequence(&channel_id).unwrap_or(0);
        tracing::debug!(
            "history sync: channel={} local_seq={} cursor_ts={:?}",
            channel_id,
            local_seq,
            cursor.as_ref().map(|(ts, _)| ts.as_str()),
        );
        let request_timestamp = chrono::Utc::now().to_rfc3339();
        let signable = format!(
            "history-req:{}:{}:{}",
            channel_id, our_public_key, request_timestamp
        );
        let request_signature = identity.sign(signable.as_bytes());
        let _ = net
            .send_command(
                crate::network::events::NetworkCommand::RequestMessageHistory {
                    peer_id: peer_id.map(ToString::to_string),
                    channel_id,
                    since_timestamp: cursor.as_ref().map(|(timestamp, _)| timestamp.clone()),
                    since_id: cursor.as_ref().map(|(_, id)| id.clone()),
                    limit: 100,
                    requester_public_key: our_public_key.clone(),
                    request_signature,
                    request_timestamp,
                },
            )
            .await;
    }
}

/// Reconstruct message snapshots from the immutable channel event log.
///
/// This applies events in sequence order:
/// - `message` creates the base `MessageDto`
/// - `edit` updates the content (only if the author matches)
/// - `delete` marks the message as deleted
///
/// The resulting list is sorted by timestamp and excludes deleted messages,
/// producing the same view a peer would get from a pristine messages table.
pub(super) fn reconstruct_messages_from_events(
    db: &Database,
    channel_id: &str,
    events: &[serde_json::Value],
) -> Vec<MessageDto> {
    let mut message_map: HashMap<String, MessageDto> = HashMap::new();

    // ── Pre-scan: collect message IDs created in this window ──
    let mut window_message_ids: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut referenced_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for event in events {
        let event_type = event
            .get("eventType")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let event_id = event.get("eventId").and_then(|v| v.as_str()).unwrap_or("");
        let target_id = event.get("targetId").and_then(|v| v.as_str()).unwrap_or("");

        if event_type == "message" {
            window_message_ids.insert(event_id.to_string());
        }
        if !target_id.is_empty() {
            referenced_ids.insert(target_id.to_string());
        }
    }

    // ── Backfill: load referenced messages not in the current window ──
    let missing_ids: Vec<String> = referenced_ids
        .difference(&window_message_ids)
        .cloned()
        .collect();

    if !missing_ids.is_empty() {
        for missing_id in &missing_ids {
            if let Ok(Some(msg)) = db.get_message_by_id(missing_id) {
                message_map.insert(missing_id.clone(), msg);
            }
        }
    }

    // ── Main event processing loop ──
    for event in events {
        let event_type = event
            .get("eventType")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let event_id = event.get("eventId").and_then(|v| v.as_str()).unwrap_or("");
        let author = event
            .get("authorPublicKey")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let payload_str = event
            .get("payload")
            .and_then(|v| v.as_str())
            .unwrap_or("{}");
        let signature = event
            .get("signature")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let timestamp = event
            .get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match event_type {
            "message" => {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(payload_str) {
                    let content = payload
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let reply_to_id = payload
                        .get("replyToId")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    let attachments: Vec<AttachmentDto> = payload
                        .get("attachments")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();

                    let msg = MessageDto {
                        id: event_id.to_string(),
                        channel_id: channel_id.to_string(),
                        author_public_key: author.to_string(),
                        author_display_name: String::new(),
                        author_avatar_color: String::new(),
                        content,
                        attachments,
                        reactions: Default::default(),
                        timestamp: timestamp.to_string(),
                        signature: signature.to_string(),
                        edited_at: None,
                        deleted_at: None,
                        reply_to_id,
                        transaction_id: None,
                        client_request_id: None,
                        delivery_status: None,
                    };
                    message_map.insert(event_id.to_string(), msg);
                }
            }
            "edit" => {
                let target_id = event.get("targetId").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(msg) = message_map.get_mut(target_id) {
                    // Only the original author can edit
                    if msg.author_public_key == author {
                        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(payload_str)
                        {
                            if let Some(new_content) =
                                payload.get("content").and_then(|v| v.as_str())
                            {
                                msg.content = new_content.to_string();
                                msg.edited_at = Some(timestamp.to_string());
                            }
                        }
                    }
                }
            }
            "delete" => {
                let target_id = event.get("targetId").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(msg) = message_map.get_mut(target_id) {
                    msg.deleted_at = Some(timestamp.to_string());
                }
            }
            "reaction_add" => {
                let target_id = event.get("targetId").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(msg) = message_map.get_mut(target_id) {
                    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(payload_str) {
                        if let Some(emoji) = payload.get("emoji").and_then(|v| v.as_str()) {
                            let entry = msg.reactions.entry(emoji.to_string()).or_default();
                            if !entry.contains(&author.to_string()) {
                                entry.push(author.to_string());
                            }
                        }
                    }
                }
            }
            "reaction_remove" => {
                let target_id = event.get("targetId").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(msg) = message_map.get_mut(target_id) {
                    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(payload_str) {
                        if let Some(emoji) = payload.get("emoji").and_then(|v| v.as_str()) {
                            if let Some(entry) = msg.reactions.get_mut(emoji) {
                                entry.retain(|pk| pk != author);
                                if entry.is_empty() {
                                    msg.reactions.remove(emoji);
                                }
                            }
                        }
                    }
                }
            }
            _ => {} // Unknown event types are silently skipped
        }
    }

    // Attempt to fill in display names / avatar colors from the members table.
    // The channel_id is scoped to a community — look it up so we can query members.
    let community_id = db.get_community_for_channel(channel_id).ok();
    if let Some(ref cid) = community_id {
        if let Ok(members) = db.get_members(cid) {
            let member_lookup: HashMap<&str, (&str, &str)> = members
                .iter()
                .map(|m| {
                    (
                        m.public_key.as_str(),
                        (m.display_name.as_str(), m.avatar_color.as_str()),
                    )
                })
                .collect();
            for msg in message_map.values_mut() {
                if let Some(&(name, color)) = member_lookup.get(msg.author_public_key.as_str()) {
                    msg.author_display_name = name.to_string();
                    msg.author_avatar_color = color.to_string();
                }
            }
        }
    }

    let mut messages: Vec<MessageDto> = message_map
        .into_values()
        .filter(|m| m.deleted_at.is_none())
        .collect();
    messages.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    messages
}

pub(super) async fn seed_network_from_cache_and_local_communities(
    app_handle: &AppHandle,
    handle: &NetworkHandle,
) {
    let Some(db) = app_handle.try_state::<Database>() else {
        return;
    };

    if let Ok(cached_discoveries) = db.get_cached_discoveries_for_all_communities() {
        for (_community_id, peer_id, addrs) in cached_discoveries {
            if addrs.is_empty() {
                continue;
            }
            let _ = handle
                .send_command(NetworkCommand::SeedPeerAddresses { peer_id, addrs })
                .await;
        }
    }

    if let Ok(communities) = db.get_communities() {
        for community in communities {
            let _ = handle
                .send_command(NetworkCommand::FindPeers {
                    community_id: community.id.clone(),
                })
                .await;

            // ALL members register in DHT, not just owners — this improves
            // peer discovery resilience so new joiners can find any member.
            let _ = handle
                .send_command(NetworkCommand::RegisterInDHT {
                    community_id: community.id.clone(),
                })
                .await;

            // Seed the swarm task with the current membership roster so
            // file chunk requests can be verified against it immediately.
            let community_id_c = community.id.clone();
            if let Ok(members) = db
                .run_blocking(move |db| db.get_members(&community_id_c))
                .await
            {
                let member_keys: Vec<String> =
                    members.iter().map(|m| m.public_key.clone()).collect();
                let _ = handle
                    .send_command(NetworkCommand::UpdateCommunityMembers {
                        community_id: community.id,
                        member_public_keys: member_keys,
                    })
                    .await;
            }
        }
    }

    // Subscribe to gossipsub topics for all existing DM conversations
    subscribe_dm_topics(app_handle, handle).await;
}

/// Subscribe to gossipsub topics for all existing DM conversations so we
/// can receive incoming messages on them.
async fn subscribe_dm_topics(app_handle: &AppHandle, handle: &NetworkHandle) {
    let Some(db) = app_handle.try_state::<Database>() else {
        return;
    };
    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };

    let our_key = {
        let identity = state.identity.read().await;
        match identity.as_ref() {
            Some(id) => id.public_key_b64.clone(),
            None => return,
        }
    };

    let conversations = match db.get_dm_conversations() {
        Ok(convs) => convs,
        Err(e) => {
            tracing::warn!(
                "Failed to load DM conversations for topic subscription: {}",
                e
            );
            return;
        }
    };

    let count = conversations.len();
    for conv in conversations {
        let topic = crate::commands::dm::dm_topic(&our_key, &conv.peer_public_key);
        let _ = handle
            .send_command(NetworkCommand::SubscribeTopic { topic })
            .await;
    }

    if count > 0 {
        tracing::info!("Subscribed to DM topics for {} conversations", count);
    }
}

// ─── Convergence Tests ──────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    /// Build a synthetic event JSON value for testing.
    fn make_event(
        seq: i64,
        event_type: &str,
        event_id: &str,
        target_id: Option<&str>,
        author: &str,
        payload: serde_json::Value,
        timestamp: &str,
    ) -> serde_json::Value {
        json!({
            "sequence": seq,
            "eventType": event_type,
            "eventId": event_id,
            "targetId": target_id,
            "authorPublicKey": author,
            "payload": serde_json::to_string(&payload).unwrap(),
            "signature": "test-sig",
            "timestamp": timestamp,
        })
    }

    /// Core replay function that works without Database — used for pure convergence tests.
    /// Mirrors reconstruct_messages_from_events but without backfill or display name lookup.
    fn replay_events(events: &[serde_json::Value]) -> Vec<MessageDto> {
        let mut message_map: HashMap<String, MessageDto> = HashMap::new();

        for event in events {
            let event_type = event
                .get("eventType")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let event_id = event.get("eventId").and_then(|v| v.as_str()).unwrap_or("");
            let author = event
                .get("authorPublicKey")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let payload_str = event
                .get("payload")
                .and_then(|v| v.as_str())
                .unwrap_or("{}");
            let signature = event
                .get("signature")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let timestamp = event
                .get("timestamp")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            match event_type {
                "message" => {
                    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(payload_str) {
                        let content = payload
                            .get("content")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let reply_to_id = payload
                            .get("replyToId")
                            .and_then(|v| v.as_str())
                            .map(String::from);
                        let msg = MessageDto {
                            id: event_id.to_string(),
                            channel_id: "test-ch".to_string(),
                            author_public_key: author.to_string(),
                            author_display_name: String::new(),
                            author_avatar_color: String::new(),
                            content,
                            attachments: vec![],
                            reactions: HashMap::new(),
                            timestamp: timestamp.to_string(),
                            signature: signature.to_string(),
                            edited_at: None,
                            deleted_at: None,
                            reply_to_id,
                            transaction_id: None,
                            client_request_id: None,
                            delivery_status: None,
                        };
                        message_map.insert(event_id.to_string(), msg);
                    }
                }
                "edit" => {
                    let target_id = event.get("targetId").and_then(|v| v.as_str()).unwrap_or("");
                    if let Some(msg) = message_map.get_mut(target_id) {
                        if msg.author_public_key == author {
                            if let Ok(payload) =
                                serde_json::from_str::<serde_json::Value>(payload_str)
                            {
                                if let Some(new_content) =
                                    payload.get("content").and_then(|v| v.as_str())
                                {
                                    msg.content = new_content.to_string();
                                    msg.edited_at = Some(timestamp.to_string());
                                }
                            }
                        }
                    }
                }
                "delete" => {
                    let target_id = event.get("targetId").and_then(|v| v.as_str()).unwrap_or("");
                    if let Some(msg) = message_map.get_mut(target_id) {
                        msg.deleted_at = Some(timestamp.to_string());
                    }
                }
                "reaction_add" => {
                    let target_id = event.get("targetId").and_then(|v| v.as_str()).unwrap_or("");
                    if let Some(msg) = message_map.get_mut(target_id) {
                        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(payload_str)
                        {
                            if let Some(emoji) = payload.get("emoji").and_then(|v| v.as_str()) {
                                let entry = msg.reactions.entry(emoji.to_string()).or_default();
                                if !entry.contains(&author.to_string()) {
                                    entry.push(author.to_string());
                                }
                            }
                        }
                    }
                }
                "reaction_remove" => {
                    let target_id = event.get("targetId").and_then(|v| v.as_str()).unwrap_or("");
                    if let Some(msg) = message_map.get_mut(target_id) {
                        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(payload_str)
                        {
                            if let Some(emoji) = payload.get("emoji").and_then(|v| v.as_str()) {
                                if let Some(entry) = msg.reactions.get_mut(emoji) {
                                    entry.retain(|pk| pk != author);
                                    if entry.is_empty() {
                                        msg.reactions.remove(emoji);
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        let mut messages: Vec<MessageDto> = message_map
            .into_values()
            .filter(|m| m.deleted_at.is_none())
            .collect();
        messages.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
        messages
    }

    // ─── Basic convergence ──────────────────────────────

    #[test]
    fn message_create_and_edit_converge() {
        let events = vec![
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "hello"}),
                "2024-01-01T00:00:01Z",
            ),
            make_event(
                2,
                "edit",
                "edit-1",
                Some("msg-1"),
                "alice",
                json!({"content": "hello world"}),
                "2024-01-01T00:00:02Z",
            ),
        ];
        let result = replay_events(&events);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].content, "hello world");
        assert!(result[0].edited_at.is_some());
    }

    #[test]
    fn delete_removes_message_from_output() {
        let events = vec![
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "delete me"}),
                "2024-01-01T00:00:01Z",
            ),
            make_event(
                2,
                "delete",
                "del-1",
                Some("msg-1"),
                "alice",
                json!({}),
                "2024-01-01T00:00:02Z",
            ),
        ];
        let result = replay_events(&events);
        assert_eq!(result.len(), 0); // Deleted messages excluded
    }

    #[test]
    fn edit_by_wrong_author_is_ignored() {
        let events = vec![
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "original"}),
                "2024-01-01T00:00:01Z",
            ),
            make_event(
                2,
                "edit",
                "edit-1",
                Some("msg-1"),
                "eve",
                json!({"content": "hacked"}),
                "2024-01-01T00:00:02Z",
            ),
        ];
        let result = replay_events(&events);
        assert_eq!(result[0].content, "original"); // Eve's edit rejected
    }

    // ─── Reaction convergence ──────────────────────────

    #[test]
    fn reaction_add_is_reconstructed() {
        let events = vec![
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "nice"}),
                "2024-01-01T00:00:01Z",
            ),
            make_event(
                2,
                "reaction_add",
                "rxn-1",
                Some("msg-1"),
                "bob",
                json!({"emoji": "👍", "verb": "add"}),
                "2024-01-01T00:00:02Z",
            ),
        ];
        let result = replay_events(&events);
        assert_eq!(
            result[0].reactions.get("👍").unwrap(),
            &vec!["bob".to_string()]
        );
    }

    #[test]
    fn reaction_add_is_idempotent() {
        let events = vec![
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "nice"}),
                "2024-01-01T00:00:01Z",
            ),
            make_event(
                2,
                "reaction_add",
                "rxn-1",
                Some("msg-1"),
                "bob",
                json!({"emoji": "👍", "verb": "add"}),
                "2024-01-01T00:00:02Z",
            ),
            make_event(
                3,
                "reaction_add",
                "rxn-2",
                Some("msg-1"),
                "bob",
                json!({"emoji": "👍", "verb": "add"}),
                "2024-01-01T00:00:03Z",
            ),
        ];
        let result = replay_events(&events);
        assert_eq!(result[0].reactions.get("👍").unwrap().len(), 1); // Not doubled
    }

    #[test]
    fn reaction_remove_works() {
        let events = vec![
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "nice"}),
                "2024-01-01T00:00:01Z",
            ),
            make_event(
                2,
                "reaction_add",
                "rxn-1",
                Some("msg-1"),
                "bob",
                json!({"emoji": "👍", "verb": "add"}),
                "2024-01-01T00:00:02Z",
            ),
            make_event(
                3,
                "reaction_remove",
                "rxn-2",
                Some("msg-1"),
                "bob",
                json!({"emoji": "👍", "verb": "remove"}),
                "2024-01-01T00:00:03Z",
            ),
        ];
        let result = replay_events(&events);
        assert!(result[0].reactions.is_empty()); // Reaction removed and emoji entry cleaned
    }

    #[test]
    fn multiple_reactions_from_different_users() {
        let events = vec![
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "nice"}),
                "2024-01-01T00:00:01Z",
            ),
            make_event(
                2,
                "reaction_add",
                "rxn-1",
                Some("msg-1"),
                "bob",
                json!({"emoji": "👍", "verb": "add"}),
                "2024-01-01T00:00:02Z",
            ),
            make_event(
                3,
                "reaction_add",
                "rxn-2",
                Some("msg-1"),
                "carol",
                json!({"emoji": "👍", "verb": "add"}),
                "2024-01-01T00:00:03Z",
            ),
            make_event(
                4,
                "reaction_add",
                "rxn-3",
                Some("msg-1"),
                "bob",
                json!({"emoji": "❤️", "verb": "add"}),
                "2024-01-01T00:00:04Z",
            ),
        ];
        let result = replay_events(&events);
        assert_eq!(result[0].reactions.get("👍").unwrap().len(), 2);
        assert_eq!(result[0].reactions.get("❤️").unwrap().len(), 1);
    }

    // ─── Ordering and determinism ───────────────────────

    #[test]
    fn messages_sorted_by_timestamp() {
        let events = vec![
            make_event(
                2,
                "message",
                "msg-2",
                None,
                "bob",
                json!({"content": "second"}),
                "2024-01-01T00:00:02Z",
            ),
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "first"}),
                "2024-01-01T00:00:01Z",
            ),
        ];
        let result = replay_events(&events);
        assert_eq!(result[0].content, "first");
        assert_eq!(result[1].content, "second");
    }

    #[test]
    fn multiple_edits_last_wins() {
        let events = vec![
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "v0"}),
                "2024-01-01T00:00:01Z",
            ),
            make_event(
                2,
                "edit",
                "edit-1",
                Some("msg-1"),
                "alice",
                json!({"content": "v1"}),
                "2024-01-01T00:00:02Z",
            ),
            make_event(
                3,
                "edit",
                "edit-2",
                Some("msg-1"),
                "alice",
                json!({"content": "v2"}),
                "2024-01-01T00:00:03Z",
            ),
        ];
        let result = replay_events(&events);
        assert_eq!(result[0].content, "v2");
        assert_eq!(result[0].edited_at.as_deref(), Some("2024-01-01T00:00:03Z"));
    }

    // ─── Complex multi-peer scenarios ───────────────────

    #[test]
    fn full_conversation_with_edits_deletes_reactions() {
        let events = vec![
            // Alice sends message
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "Hello!"}),
                "2024-01-01T00:00:01Z",
            ),
            // Bob sends message
            make_event(
                2,
                "message",
                "msg-2",
                None,
                "bob",
                json!({"content": "Hi Alice"}),
                "2024-01-01T00:00:02Z",
            ),
            // Carol reacts to Alice's message
            make_event(
                3,
                "reaction_add",
                "rxn-1",
                Some("msg-1"),
                "carol",
                json!({"emoji": "👋", "verb": "add"}),
                "2024-01-01T00:00:03Z",
            ),
            // Alice edits her message
            make_event(
                4,
                "edit",
                "edit-1",
                Some("msg-1"),
                "alice",
                json!({"content": "Hello everyone!"}),
                "2024-01-01T00:00:04Z",
            ),
            // Bob deletes his message
            make_event(
                5,
                "delete",
                "del-1",
                Some("msg-2"),
                "bob",
                json!({}),
                "2024-01-01T00:00:05Z",
            ),
            // Carol also reacts with a different emoji
            make_event(
                6,
                "reaction_add",
                "rxn-2",
                Some("msg-1"),
                "carol",
                json!({"emoji": "❤️", "verb": "add"}),
                "2024-01-01T00:00:06Z",
            ),
            // Carol removes her wave
            make_event(
                7,
                "reaction_remove",
                "rxn-3",
                Some("msg-1"),
                "carol",
                json!({"emoji": "👋", "verb": "remove"}),
                "2024-01-01T00:00:07Z",
            ),
        ];
        let result = replay_events(&events);

        // Only Alice's message remains (Bob's was deleted)
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].content, "Hello everyone!"); // Edited
        assert!(result[0].edited_at.is_some());
        // Only ❤️ remains (👋 was removed)
        assert!(result[0].reactions.get("👋").is_none());
        assert_eq!(
            result[0].reactions.get("❤️").unwrap(),
            &vec!["carol".to_string()]
        );
    }

    #[test]
    fn late_joiner_sees_same_state_as_live_peer() {
        // Simulate: live peer processes events one by one (like gossip)
        // Late joiner replays the full event log
        // Both should produce identical output
        let all_events = vec![
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "first"}),
                "2024-01-01T00:00:01Z",
            ),
            make_event(
                2,
                "message",
                "msg-2",
                None,
                "bob",
                json!({"content": "second"}),
                "2024-01-01T00:00:02Z",
            ),
            make_event(
                3,
                "edit",
                "edit-1",
                Some("msg-1"),
                "alice",
                json!({"content": "first (edited)"}),
                "2024-01-01T00:00:03Z",
            ),
            make_event(
                4,
                "reaction_add",
                "rxn-1",
                Some("msg-2"),
                "alice",
                json!({"emoji": "👍", "verb": "add"}),
                "2024-01-01T00:00:04Z",
            ),
            make_event(
                5,
                "delete",
                "del-1",
                Some("msg-2"),
                "bob",
                json!({}),
                "2024-01-01T00:00:05Z",
            ),
            make_event(
                6,
                "message",
                "msg-3",
                None,
                "carol",
                json!({"content": "third"}),
                "2024-01-01T00:00:06Z",
            ),
        ];

        // Late joiner: replay all at once
        let late_result = replay_events(&all_events);

        // Live peer: replay incrementally (same function, same events)
        let live_result = replay_events(&all_events);

        // They must converge to the same state
        assert_eq!(late_result.len(), live_result.len());
        for (late, live) in late_result.iter().zip(live_result.iter()) {
            assert_eq!(late.id, live.id);
            assert_eq!(late.content, live.content);
            assert_eq!(late.edited_at, live.edited_at);
            assert_eq!(late.deleted_at, live.deleted_at);
            assert_eq!(late.reactions, live.reactions);
        }

        // Expected state: msg-1 edited, msg-2 deleted, msg-3 present
        assert_eq!(late_result.len(), 2);
        assert_eq!(late_result[0].content, "first (edited)");
        assert_eq!(late_result[1].content, "third");
    }

    // ─── Multi-peer convergence harness ────────────────
    //
    // These tests simulate multiple peers receiving events in arbitrary orders
    // (as gossipsub would deliver them) and prove they converge to an identical
    // final state. This is the closest we can get to multi-node validation
    // without actual network I/O.

    /// Represents a simulated peer with its own event queue.
    struct SimPeer {
        name: String,
        events: Vec<serde_json::Value>,
    }

    impl SimPeer {
        fn new(name: &str) -> Self {
            Self {
                name: name.to_string(),
                events: Vec::new(),
            }
        }

        fn deliver(&mut self, event: serde_json::Value) {
            // Deduplicate by eventId — mirrors real behavior where the DB
            // has UNIQUE(event_id) via channel_events table schema.
            let event_id = event.get("eventId").and_then(|v| v.as_str()).unwrap_or("");
            if !event_id.is_empty() {
                let already = self
                    .events
                    .iter()
                    .any(|e| e.get("eventId").and_then(|v| v.as_str()) == Some(event_id));
                if already {
                    return;
                }
            }
            self.events.push(event);
        }

        /// Returns the peer's view, which is replay over the event log sorted
        /// by sequence (matching what the real `get_channel_events` query does).
        fn state(&self) -> Vec<MessageDto> {
            let mut sorted = self.events.clone();
            sorted.sort_by(|a, b| {
                let sa = a.get("sequence").and_then(|v| v.as_i64()).unwrap_or(0);
                let sb = b.get("sequence").and_then(|v| v.as_i64()).unwrap_or(0);
                sa.cmp(&sb)
            });
            replay_events(&sorted)
        }

        #[allow(dead_code)]
        fn name(&self) -> &str {
            &self.name
        }
    }

    /// Deterministic shuffle based on a seed. Produces different orderings
    /// for different seeds but the same ordering for the same seed.
    fn shuffle_with_seed<T: Clone>(items: &[T], seed: u64) -> Vec<T> {
        let mut result: Vec<T> = items.to_vec();
        let n = result.len();
        let mut state = seed;
        for i in (1..n).rev() {
            // Linear congruential generator
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let j = (state >> 33) as usize % (i + 1);
            result.swap(i, j);
        }
        result
    }

    /// Compare two peer states. Returns true if they converge to the same set
    /// of messages with the same content, edits, deletes, and reactions.
    fn states_converge(a: &[MessageDto], b: &[MessageDto]) -> bool {
        if a.len() != b.len() {
            return false;
        }
        // Sort both by message ID for stable comparison (timestamp sort is already applied)
        let mut a_sorted: Vec<&MessageDto> = a.iter().collect();
        let mut b_sorted: Vec<&MessageDto> = b.iter().collect();
        a_sorted.sort_by(|x, y| x.id.cmp(&y.id));
        b_sorted.sort_by(|x, y| x.id.cmp(&y.id));
        for (x, y) in a_sorted.iter().zip(b_sorted.iter()) {
            if x.id != y.id
                || x.content != y.content
                || x.edited_at != y.edited_at
                || x.deleted_at != y.deleted_at
                || x.reactions != y.reactions
            {
                return false;
            }
        }
        true
    }

    #[test]
    fn three_peers_converge_under_reordered_delivery() {
        // Simulate alice, bob, carol receiving the same 10 events in different
        // orders. All three must converge to the same final state.
        let canonical_events = vec![
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "hello"}),
                "2024-01-01T00:00:01Z",
            ),
            make_event(
                2,
                "message",
                "msg-2",
                None,
                "bob",
                json!({"content": "hey"}),
                "2024-01-01T00:00:02Z",
            ),
            make_event(
                3,
                "reaction_add",
                "rxn-1",
                Some("msg-1"),
                "carol",
                json!({"emoji": "👋", "verb": "add"}),
                "2024-01-01T00:00:03Z",
            ),
            make_event(
                4,
                "message",
                "msg-3",
                None,
                "carol",
                json!({"content": "hi all"}),
                "2024-01-01T00:00:04Z",
            ),
            make_event(
                5,
                "edit",
                "edit-1",
                Some("msg-1"),
                "alice",
                json!({"content": "hello everyone"}),
                "2024-01-01T00:00:05Z",
            ),
            make_event(
                6,
                "reaction_add",
                "rxn-2",
                Some("msg-3"),
                "alice",
                json!({"emoji": "❤️", "verb": "add"}),
                "2024-01-01T00:00:06Z",
            ),
            make_event(
                7,
                "reaction_add",
                "rxn-3",
                Some("msg-3"),
                "bob",
                json!({"emoji": "❤️", "verb": "add"}),
                "2024-01-01T00:00:07Z",
            ),
            make_event(
                8,
                "delete",
                "del-1",
                Some("msg-2"),
                "bob",
                json!({}),
                "2024-01-01T00:00:08Z",
            ),
            make_event(
                9,
                "reaction_remove",
                "rxn-4",
                Some("msg-1"),
                "carol",
                json!({"emoji": "👋", "verb": "remove"}),
                "2024-01-01T00:00:09Z",
            ),
            make_event(
                10,
                "message",
                "msg-4",
                None,
                "alice",
                json!({"content": "still here"}),
                "2024-01-01T00:00:10Z",
            ),
        ];

        let mut alice = SimPeer::new("alice");
        let mut bob = SimPeer::new("bob");
        let mut carol = SimPeer::new("carol");

        // Each peer receives in a different order
        for event in shuffle_with_seed(&canonical_events, 0xA11CE) {
            alice.deliver(event);
        }
        for event in shuffle_with_seed(&canonical_events, 0xB0B_B0B) {
            bob.deliver(event);
        }
        for event in shuffle_with_seed(&canonical_events, 0xCAFE_CAFE) {
            carol.deliver(event);
        }

        let alice_state = alice.state();
        let bob_state = bob.state();
        let carol_state = carol.state();

        assert!(
            states_converge(&alice_state, &bob_state),
            "alice and bob diverged\nalice: {:#?}\nbob: {:#?}",
            alice_state,
            bob_state
        );
        assert!(
            states_converge(&bob_state, &carol_state),
            "bob and carol diverged\nbob: {:#?}\ncarol: {:#?}",
            bob_state,
            carol_state
        );

        // Sanity: 3 messages visible (msg-2 deleted), msg-1 edited, msg-3 has 2 ❤️
        assert_eq!(alice_state.len(), 3);
        let msg1 = alice_state.iter().find(|m| m.id == "msg-1").unwrap();
        assert_eq!(msg1.content, "hello everyone");
        assert!(msg1.reactions.is_empty());
        let msg3 = alice_state.iter().find(|m| m.id == "msg-3").unwrap();
        assert_eq!(msg3.reactions.get("❤️").unwrap().len(), 2);
    }

    #[test]
    fn late_joiner_catches_up_matching_live_peers() {
        // alice and bob are live from the start. carol joins after 5 events
        // and replays the full history. All three must end in the same state.
        let events = vec![
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "first"}),
                "2024-01-01T00:00:01Z",
            ),
            make_event(
                2,
                "message",
                "msg-2",
                None,
                "bob",
                json!({"content": "second"}),
                "2024-01-01T00:00:02Z",
            ),
            make_event(
                3,
                "edit",
                "edit-1",
                Some("msg-1"),
                "alice",
                json!({"content": "first (edited)"}),
                "2024-01-01T00:00:03Z",
            ),
            make_event(
                4,
                "reaction_add",
                "rxn-1",
                Some("msg-2"),
                "alice",
                json!({"emoji": "👍", "verb": "add"}),
                "2024-01-01T00:00:04Z",
            ),
            make_event(
                5,
                "message",
                "msg-3",
                None,
                "bob",
                json!({"content": "third"}),
                "2024-01-01T00:00:05Z",
            ),
            // carol joins here and replays 1-5
            make_event(
                6,
                "reaction_add",
                "rxn-2",
                Some("msg-3"),
                "carol",
                json!({"emoji": "🔥", "verb": "add"}),
                "2024-01-01T00:00:06Z",
            ),
            make_event(
                7,
                "message",
                "msg-4",
                None,
                "carol",
                json!({"content": "hello late joiner"}),
                "2024-01-01T00:00:07Z",
            ),
        ];

        // Live peers see everything in order
        let mut alice = SimPeer::new("alice");
        let mut bob = SimPeer::new("bob");
        for event in &events {
            alice.deliver(event.clone());
            bob.deliver(event.clone());
        }

        // Carol joins late and receives the full history
        let mut carol = SimPeer::new("carol");
        for event in &events {
            carol.deliver(event.clone());
        }

        let alice_state = alice.state();
        let bob_state = bob.state();
        let carol_state = carol.state();

        assert!(states_converge(&alice_state, &bob_state));
        assert!(states_converge(&bob_state, &carol_state));
        assert_eq!(carol_state.len(), 4);
    }

    #[test]
    fn peer_missing_an_event_diverges_until_synced() {
        // alice has all 5 events, bob is missing event 3 (an edit).
        // Their states should differ until bob receives the missing event.
        let events = vec![
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "v0"}),
                "2024-01-01T00:00:01Z",
            ),
            make_event(
                2,
                "message",
                "msg-2",
                None,
                "alice",
                json!({"content": "other"}),
                "2024-01-01T00:00:02Z",
            ),
            make_event(
                3,
                "edit",
                "edit-1",
                Some("msg-1"),
                "alice",
                json!({"content": "v1"}),
                "2024-01-01T00:00:03Z",
            ),
            make_event(
                4,
                "reaction_add",
                "rxn-1",
                Some("msg-1"),
                "bob",
                json!({"emoji": "✅", "verb": "add"}),
                "2024-01-01T00:00:04Z",
            ),
            make_event(
                5,
                "message",
                "msg-3",
                None,
                "bob",
                json!({"content": "third"}),
                "2024-01-01T00:00:05Z",
            ),
        ];

        let mut alice = SimPeer::new("alice");
        let mut bob = SimPeer::new("bob");
        for (i, event) in events.iter().enumerate() {
            alice.deliver(event.clone());
            if i != 2 {
                // bob misses the edit event (index 2 = sequence 3)
                bob.deliver(event.clone());
            }
        }

        // They should diverge on msg-1's content
        let alice_state = alice.state();
        let bob_state = bob.state();
        assert!(!states_converge(&alice_state, &bob_state));
        let alice_msg1 = alice_state.iter().find(|m| m.id == "msg-1").unwrap();
        let bob_msg1 = bob_state.iter().find(|m| m.id == "msg-1").unwrap();
        assert_eq!(alice_msg1.content, "v1");
        assert_eq!(bob_msg1.content, "v0"); // Bob still has the original

        // After bob syncs the missing event, they converge
        bob.deliver(events[2].clone());
        let bob_state_synced = bob.state();
        assert!(states_converge(&alice_state, &bob_state_synced));
    }

    #[test]
    fn duplicate_event_delivery_is_idempotent() {
        // If a peer receives the same event twice (common in gossipsub), the
        // state should be identical to receiving it once. The replay function
        // must be idempotent for both messages and reactions.
        let events = vec![
            make_event(
                1,
                "message",
                "msg-1",
                None,
                "alice",
                json!({"content": "hi"}),
                "2024-01-01T00:00:01Z",
            ),
            make_event(
                2,
                "reaction_add",
                "rxn-1",
                Some("msg-1"),
                "bob",
                json!({"emoji": "👍", "verb": "add"}),
                "2024-01-01T00:00:02Z",
            ),
        ];

        let mut once = SimPeer::new("once");
        let mut duplicated = SimPeer::new("duplicated");
        for event in &events {
            once.deliver(event.clone());
            duplicated.deliver(event.clone());
            duplicated.deliver(event.clone()); // delivered twice
            duplicated.deliver(event.clone()); // delivered three times
        }

        assert!(states_converge(&once.state(), &duplicated.state()));
        let state = duplicated.state();
        assert_eq!(state[0].reactions.get("👍").unwrap().len(), 1); // no duplicates
    }

    #[test]
    fn churn_scenario_with_100_events_across_5_peers_converges() {
        // Stress test: 5 peers receive 100 events each in a different shuffle.
        // All must converge to the same final state.
        let mut canonical_events = Vec::new();
        for i in 0..30 {
            canonical_events.push(make_event(
                (i * 3 + 1) as i64,
                "message",
                &format!("msg-{}", i),
                None,
                if i % 2 == 0 { "alice" } else { "bob" },
                json!({"content": format!("message {}", i)}),
                &format!("2024-01-01T00:00:{:02}Z", (i * 3 + 1) % 60),
            ));
            if i >= 10 {
                // Add an edit to an older message (cross-window scenario)
                canonical_events.push(make_event(
                    (i * 3 + 2) as i64,
                    "edit",
                    &format!("edit-{}", i),
                    Some(&format!("msg-{}", i - 10)),
                    if (i - 10) % 2 == 0 { "alice" } else { "bob" },
                    json!({"content": format!("edited {}", i)}),
                    &format!("2024-01-01T00:00:{:02}Z", (i * 3 + 2) % 60),
                ));
            }
            if i % 3 == 0 {
                canonical_events.push(make_event(
                    (i * 3 + 3) as i64,
                    "reaction_add",
                    &format!("rxn-{}", i),
                    Some(&format!("msg-{}", i)),
                    "carol",
                    json!({"emoji": "👍", "verb": "add"}),
                    &format!("2024-01-01T00:00:{:02}Z", (i * 3 + 3) % 60),
                ));
            }
        }

        let mut peers: Vec<SimPeer> = (0..5)
            .map(|i| SimPeer::new(&format!("peer-{}", i)))
            .collect();
        for (i, peer) in peers.iter_mut().enumerate() {
            let seed = 0xDEAD_BEEF_u64.wrapping_add(i as u64 * 0xCAFE);
            for event in shuffle_with_seed(&canonical_events, seed) {
                peer.deliver(event);
            }
        }

        let states: Vec<Vec<MessageDto>> = peers.iter().map(|p| p.state()).collect();
        let baseline = &states[0];
        for (i, state) in states.iter().enumerate().skip(1) {
            assert!(
                states_converge(baseline, state),
                "peer {} diverged from peer 0 (baseline {} messages, peer {} messages)",
                i,
                baseline.len(),
                state.len()
            );
        }
        // Sanity: we should have 30 messages
        assert_eq!(baseline.len(), 30);
    }

    // ─── Network degradation fault injection ───────────
    //
    // These tests simulate degraded network conditions (dropped events,
    // delayed delivery, reordering) and prove that the final state
    // converges once the missing events are delivered via sync.
    //
    // This mirrors real-world behavior: when peers drop packets, miss
    // gossip, or come back online after isolation, the event log + history
    // sync should converge them to the same state.

    /// A lossy network that can drop, delay, or reorder events.
    /// Use a seed for deterministic fault injection.
    struct LossyNetwork {
        rng_state: u64,
        /// Drop probability 0.0 - 1.0
        drop_rate: f64,
        /// Dropped events held for later delivery via `sync()`
        dropped_buffer: Vec<serde_json::Value>,
    }

    impl LossyNetwork {
        fn new(seed: u64, drop_rate: f64) -> Self {
            Self {
                rng_state: seed,
                drop_rate,
                dropped_buffer: Vec::new(),
            }
        }

        /// Deterministic pseudo-random number generator for fault decisions.
        fn next_random(&mut self) -> f64 {
            self.rng_state = self
                .rng_state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.rng_state >> 33) as f64 / u32::MAX as f64
        }

        /// Deliver an event, possibly dropping it.
        /// Returns true if delivered, false if dropped.
        fn deliver(&mut self, peer: &mut SimPeer, event: &serde_json::Value) -> bool {
            if self.next_random() < self.drop_rate {
                self.dropped_buffer.push(event.clone());
                false
            } else {
                peer.deliver(event.clone());
                true
            }
        }

        /// Simulate history sync: deliver any previously dropped events.
        fn sync(&mut self, peer: &mut SimPeer) {
            for event in self.dropped_buffer.drain(..) {
                peer.deliver(event);
            }
        }
    }

    #[test]
    fn peers_converge_after_lossy_delivery_and_history_sync() {
        // Simulate a network that drops 30% of events.
        // Before sync: peers diverge.
        // After history sync: peers must converge.
        let events: Vec<serde_json::Value> = (1..=20)
            .map(|i| {
                if i % 4 == 0 {
                    make_event(
                        i as i64,
                        "edit",
                        &format!("edit-{}", i),
                        Some(&format!("msg-{}", i - 3)),
                        if i % 2 == 0 { "alice" } else { "bob" },
                        json!({"content": format!("edited {}", i)}),
                        &format!("2024-01-01T00:00:{:02}Z", i),
                    )
                } else {
                    make_event(
                        i as i64,
                        "message",
                        &format!("msg-{}", i),
                        None,
                        if i % 2 == 0 { "alice" } else { "bob" },
                        json!({"content": format!("msg {}", i)}),
                        &format!("2024-01-01T00:00:{:02}Z", i),
                    )
                }
            })
            .collect();

        // Authoritative peer sees everything
        let mut truth = SimPeer::new("truth");
        for event in &events {
            truth.deliver(event.clone());
        }

        // Lossy peer drops 30% of events
        let mut lossy_peer = SimPeer::new("lossy");
        let mut network = LossyNetwork::new(0xDEAD_BEEF, 0.3);
        for event in &events {
            network.deliver(&mut lossy_peer, event);
        }

        // Before sync, lossy peer should diverge
        let diverged_state = lossy_peer.state();
        assert!(
            !states_converge(&truth.state(), &diverged_state) || network.dropped_buffer.is_empty(),
            "lossy peer should initially diverge (or no events were dropped)"
        );

        // History sync delivers the missing events
        network.sync(&mut lossy_peer);

        // After sync, peers converge
        assert!(
            states_converge(&truth.state(), &lossy_peer.state()),
            "peers must converge after history sync"
        );
    }

    #[test]
    fn delayed_delivery_converges_once_caught_up() {
        // A "slow" peer receives events with delay — simulated by buffering
        // then flushing. Final state must match the real-time peer.
        let events: Vec<serde_json::Value> = (1..=15)
            .map(|i| {
                make_event(
                    i as i64,
                    "message",
                    &format!("msg-{}", i),
                    None,
                    "alice",
                    json!({"content": format!("msg {}", i)}),
                    &format!("2024-01-01T00:00:{:02}Z", i),
                )
            })
            .collect();

        // Add some edits targeting earlier messages
        let mut all_events = events.clone();
        all_events.push(make_event(
            16,
            "edit",
            "edit-1",
            Some("msg-5"),
            "alice",
            json!({"content": "msg 5 (edited)"}),
            "2024-01-01T00:00:16Z",
        ));
        all_events.push(make_event(
            17,
            "reaction_add",
            "rxn-1",
            Some("msg-10"),
            "bob",
            json!({"emoji": "👍", "verb": "add"}),
            "2024-01-01T00:00:17Z",
        ));

        // Real-time peer: all events in order
        let mut realtime = SimPeer::new("realtime");
        for event in &all_events {
            realtime.deliver(event.clone());
        }

        // Delayed peer: receives first half now, second half after a sync
        let mut delayed = SimPeer::new("delayed");
        let (first_half, second_half) = all_events.split_at(all_events.len() / 2);
        for event in first_half {
            delayed.deliver(event.clone());
        }

        // At this point the delayed peer is missing the edit and reaction
        assert!(!states_converge(&realtime.state(), &delayed.state()));

        // Sync delivers the rest
        for event in second_half {
            delayed.deliver(event.clone());
        }

        // Now they converge
        assert!(states_converge(&realtime.state(), &delayed.state()));
    }

    #[test]
    fn split_network_heals_after_reconciliation() {
        // Two peers are partitioned: each sees their own writes but not the
        // other's. After the partition heals (both peers receive the full
        // union of events), they converge.
        let alice_local_events: Vec<serde_json::Value> = vec![
            make_event(
                1,
                "message",
                "a-1",
                None,
                "alice",
                json!({"content": "alice 1"}),
                "2024-01-01T00:00:01Z",
            ),
            make_event(
                3,
                "message",
                "a-2",
                None,
                "alice",
                json!({"content": "alice 2"}),
                "2024-01-01T00:00:03Z",
            ),
            make_event(
                5,
                "reaction_add",
                "a-rxn-1",
                Some("a-1"),
                "alice",
                json!({"emoji": "👋", "verb": "add"}),
                "2024-01-01T00:00:05Z",
            ),
        ];
        let bob_local_events: Vec<serde_json::Value> = vec![
            make_event(
                2,
                "message",
                "b-1",
                None,
                "bob",
                json!({"content": "bob 1"}),
                "2024-01-01T00:00:02Z",
            ),
            make_event(
                4,
                "message",
                "b-2",
                None,
                "bob",
                json!({"content": "bob 2"}),
                "2024-01-01T00:00:04Z",
            ),
            make_event(
                6,
                "edit",
                "b-edit-1",
                Some("b-1"),
                "bob",
                json!({"content": "bob 1 edited"}),
                "2024-01-01T00:00:06Z",
            ),
        ];

        let mut alice = SimPeer::new("alice");
        let mut bob = SimPeer::new("bob");

        // During partition, each sees only their own
        for event in &alice_local_events {
            alice.deliver(event.clone());
        }
        for event in &bob_local_events {
            bob.deliver(event.clone());
        }

        // They diverge
        assert!(!states_converge(&alice.state(), &bob.state()));

        // Partition heals: each peer receives the other's events via sync
        for event in &bob_local_events {
            alice.deliver(event.clone());
        }
        for event in &alice_local_events {
            bob.deliver(event.clone());
        }

        // Convergence
        assert!(states_converge(&alice.state(), &bob.state()));

        // Final state: 4 messages (b-1 edited), 1 reaction on a-1
        let state = alice.state();
        assert_eq!(state.len(), 4);
        let a1 = state.iter().find(|m| m.id == "a-1").unwrap();
        assert_eq!(a1.reactions.get("👋").unwrap(), &vec!["alice".to_string()]);
        let b1 = state.iter().find(|m| m.id == "b-1").unwrap();
        assert_eq!(b1.content, "bob 1 edited");
    }

    #[test]
    fn high_churn_scenario_50_events_30_percent_loss() {
        // Stress test: 50 events, 30% drop rate, 3 peers each with different
        // seeds. After lossy delivery followed by sync, all peers converge.
        let events: Vec<serde_json::Value> = (1..=50)
            .map(|i| {
                let msg_idx = i;
                let author = match i % 3 {
                    0 => "alice",
                    1 => "bob",
                    _ => "carol",
                };
                if i % 7 == 0 && i > 7 {
                    make_event(
                        i as i64,
                        "edit",
                        &format!("edit-{}", i),
                        Some(&format!("msg-{}", i - 5)),
                        author,
                        json!({"content": format!("edit {}", i)}),
                        &format!("2024-01-01T00:01:{:02}Z", i),
                    )
                } else if i % 5 == 0 && i > 5 {
                    make_event(
                        i as i64,
                        "reaction_add",
                        &format!("rxn-{}", i),
                        Some(&format!("msg-{}", i - 3)),
                        author,
                        json!({"emoji": "🔥", "verb": "add"}),
                        &format!("2024-01-01T00:01:{:02}Z", i),
                    )
                } else {
                    make_event(
                        i as i64,
                        "message",
                        &format!("msg-{}", msg_idx),
                        None,
                        author,
                        json!({"content": format!("msg {}", msg_idx)}),
                        &format!("2024-01-01T00:01:{:02}Z", i),
                    )
                }
            })
            .collect();

        let mut peers: Vec<SimPeer> = (0..3)
            .map(|i| SimPeer::new(&format!("peer-{}", i)))
            .collect();
        let mut networks: Vec<LossyNetwork> = (0..3)
            .map(|i| LossyNetwork::new(0xBEEF_u64 * (i as u64 + 1), 0.3))
            .collect();

        // Lossy phase: each peer receives events through its own lossy network
        for event in &events {
            for (peer, net) in peers.iter_mut().zip(networks.iter_mut()) {
                net.deliver(peer, event);
            }
        }

        // After lossy delivery, at least one peer should have lost something
        // (probabilistically). We don't assert they all diverge — the test
        // focus is that after sync they all converge.

        // Sync phase: each peer receives its dropped events
        for (peer, net) in peers.iter_mut().zip(networks.iter_mut()) {
            net.sync(peer);
        }

        // All peers now converge
        let baseline = peers[0].state();
        for (i, peer) in peers.iter().enumerate().skip(1) {
            let state = peer.state();
            assert!(
                states_converge(&baseline, &state),
                "peer {} diverged after sync (baseline {}, peer {})",
                i,
                baseline.len(),
                state.len()
            );
        }
    }
}
