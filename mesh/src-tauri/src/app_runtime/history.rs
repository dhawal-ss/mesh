use tauri::{AppHandle, Manager};

use crate::network::envelope::{AttachmentPayload, MessagePayload, SignedEnvelope};
use crate::network::events::{NetworkCommand, NetworkHandle};
use crate::state::AppState;
use crate::storage::Database;
use crate::types::message::MessageDto;

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
fn is_history_timestamp_valid(timestamp: &str) -> bool {
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

    // Get our public key for authenticated requests
    let our_public_key = {
        let identity = state.identity.read().await;
        match identity.as_ref() {
            Some(id) => id.public_key_b64.clone(),
            None => return,
        }
    };

    let network = state.network.read().await;
    let Some(net) = network.as_ref() else {
        return;
    };

    for channel_id in channel_ids {
        let cursor = db.get_latest_message_cursor(&channel_id).ok().flatten();
        let _ = net
            .send_command(
                crate::network::events::NetworkCommand::RequestMessageHistory {
                    peer_id: peer_id.map(ToString::to_string),
                    channel_id,
                    since_timestamp: cursor.as_ref().map(|(timestamp, _)| timestamp.clone()),
                    since_id: cursor.as_ref().map(|(_, id)| id.clone()),
                    limit: 100,
                    requester_public_key: our_public_key.clone(),
                },
            )
            .await;
    }
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

            if community.role == "owner" {
                let _ = handle
                    .send_command(NetworkCommand::RegisterInDHT {
                        community_id: community.id,
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
            tracing::warn!("Failed to load DM conversations for topic subscription: {}", e);
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
