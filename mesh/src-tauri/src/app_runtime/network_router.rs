use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::commands::control::ControlEvent;
use crate::crypto::encryption;
use crate::network::envelope::SignedEnvelope;
use crate::network::events::{NetworkCommand, NetworkEvent};
use crate::state::file_downloads::{DownloadUpdate, FileAvailableEvent};
use crate::state::AppState;
use crate::storage::Database;

use super::history;
use super::invite_handler;
use super::message_handler;
use super::security;
use super::voice_handler;

pub(super) fn spawn_network_event_bridge(
    app_handle: AppHandle,
    mut event_rx: mpsc::Receiver<NetworkEvent>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            route_network_event(&app_handle, event).await;
        }
    });
}

async fn route_network_event(app_handle: &AppHandle, event: NetworkEvent) {
    match event {
        NetworkEvent::GossipMessage { topic, data, .. } => {
            // ── DM decryption layer ──
            // DM topics use per-recipient ECDH encryption, not community group keys.
            if topic.starts_with("mesh/dm/") {
                let plaintext = match try_decrypt_dm_payload(app_handle, &data) {
                    Some(bytes) => bytes,
                    None => {
                        tracing::debug!("Could not decrypt DM on topic {} — not for us", topic);
                        return;
                    }
                };
                if let Some(envelope) = SignedEnvelope::from_bytes(&plaintext) {
                    validate_and_route(app_handle, envelope).await;
                } else {
                    tracing::warn!("DM on topic {} decrypted but is not a valid envelope", topic);
                }
                return;
            }

            // ── Community decryption layer: strict decrypt-or-reject ──
            // If a community has a stored group key, any message that
            // fails decryption is REJECTED — never parsed as plaintext.
            let community_has_key = security::community_has_group_key(app_handle, &topic);
            let decrypted = security::try_decrypt_community_payload(app_handle, &topic, &data);

            let plaintext = match (community_has_key, &decrypted) {
                (true, None) => {
                    // Community key exists but decryption failed → reject
                    tracing::warn!(
                        "Rejecting message on topic {} — decryption failed for encrypted community",
                        topic
                    );
                    return;
                }
                (true, Some(bytes)) => bytes.as_slice(),
                (false, Some(bytes)) => bytes.as_slice(),
                (false, None) => &data,
            };

            if let Some(envelope) = SignedEnvelope::from_bytes(plaintext) {
                validate_and_route(app_handle, envelope).await;
                return;
            }

            if let Ok(control_event) = serde_json::from_slice::<ControlEvent>(plaintext) {
                if let Some(owner_public_key) =
                    security::trusted_owner_public_key(app_handle, &control_event.community_id)
                {
                    if let Some(db) = app_handle.try_state::<Database>() {
                        let _ = crate::commands::control::apply_control_event(
                            app_handle,
                            &db,
                            &control_event,
                            &owner_public_key,
                        );
                    }
                }
                return;
            }

            tracing::warn!(
                "Dropping unsupported network payload on topic {} because it is neither a signed envelope nor a control event",
                topic
            );
            return;
        }
        NetworkEvent::FileChunkReceived {
            file_hash,
            chunk_index,
            data,
        } => {
            if let Some(state) = app_handle.try_state::<crate::state::AppState>() {
                let update = {
                    let mut downloads = state.downloads.lock().await;
                    match downloads.record_chunk(&file_hash, chunk_index, &data) {
                        Ok(update) => update,
                        Err(error) => {
                            tracing::error!(
                                "Failed to persist file chunk {}:{}: {}",
                                file_hash,
                                chunk_index,
                                error
                            );
                            downloads
                                .mark_failed(&file_hash)
                                .map(DownloadUpdate::Failed)
                        }
                    }
                };

                if let Some(update) = update {
                    match update {
                        DownloadUpdate::Progress(progress) | DownloadUpdate::Failed(progress) => {
                            let _ = app_handle.emit("file:download-progress", &progress);
                        }
                        DownloadUpdate::Completed(completed) => {
                            let _ = app_handle.emit("file:download-progress", &completed.progress);
                            let _ = app_handle.emit(
                                "file:available",
                                &FileAvailableEvent {
                                    file_hash: completed.progress.file_hash,
                                    local_path: completed.local_path.to_string_lossy().to_string(),
                                },
                            );
                        }
                    }
                }
            }
        }
        NetworkEvent::MessageHistoryRequested { request, reply, .. } => {
            if let Some(db) = app_handle.try_state::<Database>() {
                // Verify the channel belongs to a community we have locally.
                // This prevents serving history for channels we don't own/belong to.
                let channel_id_check = request.channel_id.clone();
                let community_id_opt: Option<String> = db
                    .run_blocking(move |db| {
                        let community_id = db.get_community_for_channel(&channel_id_check).ok()?;
                        // Verify the community is actually known (has an owner key)
                        db.get_community_owner_public_key(&community_id).ok()?.as_ref()?;
                        Some(community_id)
                    })
                    .await;

                let Some(community_id) = community_id_opt else {
                    tracing::warn!(
                        "Refusing history request for channel {} — community not found locally",
                        request.channel_id
                    );
                    let _ = reply.send(crate::network::behaviour::MessageHistoryResponse {
                        channel_id: request.channel_id,
                        messages: vec![],
                    });
                    return;
                };

                // Verify the requester is a member of this community
                if !request.requester_public_key.is_empty() {
                    if let Some(false) = security::is_active_member(app_handle, &community_id, &request.requester_public_key) {
                        tracing::warn!(
                            "Refusing history request for channel {} — requester {} is not a member",
                            request.channel_id,
                            request.requester_public_key,
                        );
                        let _ = reply.send(crate::network::behaviour::MessageHistoryResponse {
                            channel_id: request.channel_id,
                            messages: vec![],
                        });
                        return;
                    }
                }

                let channel_id = request.channel_id.clone();
                let since_ts = request.since_timestamp.clone();
                let since_id = request.since_id.clone();
                let limit = request.limit;
                let messages = db
                    .run_blocking(move |db| {
                        db.get_messages_after(
                            &channel_id,
                            since_ts.as_deref(),
                            since_id.as_deref(),
                            limit,
                        )
                        .unwrap_or_default()
                    })
                    .await;
                let _ = reply.send(crate::network::behaviour::MessageHistoryResponse {
                    channel_id: request.channel_id,
                    messages,
                });
            }
        }
        NetworkEvent::MessageHistoryReceived { response, .. } => {
            // ── History responses are UNTRUSTED — apply the same verification
            // pipeline as live gossipsub messages (ban check + signature). ──
            if let Some(db) = app_handle.try_state::<Database>() {
                for message in response.messages {
                    let channel_id = message.channel_id.clone();
                    let community_id = db
                        .run_blocking(move |db| {
                            db.get_community_for_channel(&channel_id)
                                .unwrap_or_default()
                        })
                        .await;
                    if !history::validate_history_message(&message, &community_id) {
                        tracing::warn!(
                            "Dropping history message {} with invalid signature",
                            message.id
                        );
                        continue;
                    }
                    validate_and_route(
                        app_handle,
                        history::history_message_to_envelope(&message, &community_id),
                    )
                    .await;
                }
            }
        }
        NetworkEvent::PeerDiscovered {
            peer_id,
            addrs,
            community_id,
        } => {
            if let (Some(db), Some(community_id)) =
                (app_handle.try_state::<Database>(), community_id.as_deref())
            {
                let peer_id_c = peer_id.clone();
                let community_id_c = community_id.to_string();
                let addrs_c = addrs.clone();
                let _ = db
                    .run_blocking(move |db| db.cache_discovery(&peer_id_c, &community_id_c, &addrs_c))
                    .await;
            }
            if let Some(community_id) = community_id.as_deref() {
                invite_handler::request_pending_invite_join(app_handle, community_id, &peer_id).await;
            }
            let _ = app_handle.emit(
                "peer:discovered",
                &serde_json::json!({
                    "peerId": peer_id,
                    "addrs": addrs,
                    "communityId": community_id,
                }),
            );
        }
        NetworkEvent::PeerConnected { peer_id } => {
            history::request_history_for_known_channels(app_handle, Some(peer_id.as_str())).await;
            invite_handler::request_control_logs_for_known_communities(app_handle, Some(peer_id.as_str())).await;
            // ── Replay pending messages on reconnect ──
            replay_pending_messages(app_handle).await;
            let _ = app_handle.emit("peer:joined", &serde_json::json!({ "peerId": peer_id }));
        }
        NetworkEvent::ControlRequestReceived { request, reply, .. } => {
            let _ = reply.send(invite_handler::build_control_response(app_handle, request).await);
        }
        NetworkEvent::ControlResponseReceived { peer_id, response } => {
            invite_handler::handle_control_response(app_handle, &peer_id, response).await;
        }
        NetworkEvent::PeerDisconnected { peer_id } => {
            let _ = app_handle.emit("peer:left", &serde_json::json!({ "peerId": peer_id }));
        }
        NetworkEvent::PeerCount { count } => {
            let _ = app_handle.emit(
                "network:status",
                &serde_json::json!({
                    "connected": count > 0,
                    "peerCount": count,
                    "averageLatency": 0,
                    "usingRelay": false,
                }),
            );
        }
        NetworkEvent::PublishFailed { topic, data } => {
            // Queue failed publish for retry on reconnect
            if let Some(db) = app_handle.try_state::<Database>() {
                let id = nanoid::nanoid!();
                let topic_c = topic.clone();
                let id_c = id.clone();
                let result = db
                    .run_blocking(move |db| db.queue_pending_message(&id_c, &topic_c, &data))
                    .await;
                if let Err(e) = result {
                    tracing::error!("Failed to queue pending message: {}", e);
                } else {
                    tracing::info!("Queued pending message {} for topic {}", id, topic);
                }
            }
        }
        event => { tracing::debug!("Unhandled network event: {:?}", event); }
    }
}

/// Replay all pending messages from the offline queue.
async fn replay_pending_messages(app_handle: &AppHandle) {
    let Some(db) = app_handle.try_state::<Database>() else {
        return;
    };
    let Some(state) = app_handle.try_state::<crate::state::AppState>() else {
        return;
    };
    let pending = match db.run_blocking(|db| db.get_pending_messages()).await {
        Ok(pending) => pending,
        Err(e) => {
            tracing::error!("Failed to load pending messages: {}", e);
            return;
        }
    };
    if pending.is_empty() {
        return;
    }
    tracing::info!("Replaying {} pending messages", pending.len());
    let network = state.network.read().await;
    let Some(ref net) = *network else {
        return;
    };
    for (id, topic, data) in pending {
        match net.send_command(NetworkCommand::PublishMessage {
            topic: topic.clone(),
            data,
        }).await {
            Ok(()) => {
                let id_c = id.clone();
                let _ = db.run_blocking(move |db| db.mark_pending_sent(&id_c)).await;
                tracing::info!("Replayed pending message {} to {}", id, topic);
            }
            Err(e) => {
                let id_c = id.clone();
                let _ = db.run_blocking(move |db| db.increment_pending_retry(&id_c)).await;
                tracing::warn!("Failed to replay pending message {}: {}", id, e);
            }
        }
    }
}

/// Try to decrypt an incoming DM payload using our X25519 secret.
/// Returns None if decryption fails (message is not addressed to us).
fn try_decrypt_dm_payload(app_handle: &AppHandle, data: &[u8]) -> Option<Vec<u8>> {
    let state = app_handle.try_state::<AppState>()?;
    let identity = state.identity.blocking_read();
    let identity = identity.as_ref()?;
    let our_secret = identity.x25519_static_secret();
    encryption::decrypt_from_sender(&our_secret, data, "mesh-dm-v1").ok()
}

async fn validate_and_route(app_handle: &AppHandle, envelope: SignedEnvelope) {
    // ── Timestamp validation (before signature check to reject garbage early) ──
    if !is_timestamp_valid(&envelope.timestamp) {
        tracing::warn!(
            "Dropping {} {} with out-of-range timestamp {} from {}",
            envelope.msg_type,
            envelope.id,
            envelope.timestamp,
            envelope.author,
        );
        return;
    }

    let community_id = envelope.community_id.clone();
    if !envelope.author.is_empty()
        && !community_id.is_empty()
        && security::is_banned(app_handle, &community_id, &envelope.author)
    {
        tracing::warn!(
            "Dropping {} from banned user {} in community {}",
            envelope.msg_type,
            envelope.author,
            community_id
        );
        return;
    }

    if !envelope.verify().unwrap_or(false) {
        tracing::warn!(
            "Dropping {} {} with invalid signature from {}",
            envelope.msg_type,
            envelope.id,
            envelope.author
        );
        return;
    }

    // ── Membership enforcement for content envelopes ──
    // For message types that carry content or mutate state, verify the
    // author is an active member. Skip for DMs (no community context)
    // and ban envelopes (handled separately with owner verification).
    if !community_id.is_empty() {
        let needs_membership = matches!(
            envelope.msg_type.as_str(),
            "message" | "message_edit" | "message_delete" | "reaction" | "file_announced" | "voice_signal" | "voice_join" | "voice_leave" | "voice_heartbeat"
        );
        if needs_membership {
            if let Some(false) = security::is_active_member(app_handle, &community_id, &envelope.author) {
                tracing::warn!(
                    "Dropping {} from non-member {} in community {}",
                    envelope.msg_type,
                    envelope.author,
                    community_id
                );
                return;
            }
        }
    }

    match envelope.msg_type.as_str() {
        "message" => message_handler::route_signed_message(app_handle, &envelope).await,
        "message_edit" => message_handler::route_signed_message_edit(app_handle, &envelope).await,
        "message_delete" => message_handler::route_signed_message_delete(app_handle, &envelope).await,
        "reaction" => message_handler::route_signed_reaction(app_handle, &envelope).await,
        "presence" => message_handler::route_signed_presence(app_handle, &envelope).await,
        "file_announced" => message_handler::route_signed_file_announcement(app_handle, &envelope).await,
        "ban" => message_handler::route_signed_ban(app_handle, &envelope),
        "dm" => route_incoming_dm(app_handle, &envelope).await,
        "voice_signal" => voice_handler::handle_signed_voice_signal(app_handle, &envelope).await,
        "voice_join" | "voice_leave" | "voice_heartbeat" => {
            voice_handler::handle_signed_voice_membership_event(app_handle, &envelope).await
        }
        msg_type => { tracing::debug!("Unhandled envelope msg_type: {}", msg_type); }
    }
}

/// Handle an incoming DM envelope: store it and emit to frontend.
async fn route_incoming_dm(app_handle: &AppHandle, envelope: &SignedEnvelope) {
    use crate::types::dm::DirectMessageDto;

    let Some(db) = app_handle.try_state::<Database>() else {
        return;
    };

    // Skip our own DMs (we already stored them on send)
    let is_own = app_handle
        .try_state::<crate::state::AppState>()
        .and_then(|state| {
            let identity = state.identity.blocking_read();
            identity.as_ref().map(|id| id.public_key_b64 == envelope.author)
        })
        .unwrap_or(false);
    if is_own {
        return;
    }

    let content = envelope
        .payload
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let display_name = envelope.display_name();
    let avatar_color = envelope.avatar_color();

    // Get or create the conversation for this sender
    let author_c = envelope.author.clone();
    let display_name_c = display_name.clone();
    let avatar_color_c = avatar_color.clone();
    let conversation = match db
        .run_blocking(move |db| {
            db.get_or_create_dm_conversation(&author_c, &display_name_c, &avatar_color_c)
        })
        .await
    {
        Ok(conv) => conv,
        Err(e) => {
            tracing::error!("Failed to get/create DM conversation: {}", e);
            return;
        }
    };

    let msg = DirectMessageDto {
        id: envelope.id.clone(),
        conversation_id: conversation.id.clone(),
        author_public_key: envelope.author.clone(),
        author_display_name: display_name.clone(),
        author_avatar_color: avatar_color.clone(),
        content: content.clone(),
        timestamp: envelope.timestamp.clone(),
        signature: envelope.signature.clone(),
        edited_at: None,
        deleted_at: None,
    };

    let msg_c = msg.clone();
    let conversation_id_c = conversation.id.clone();
    if let Err(e) = db
        .run_blocking(move |db| db.insert_dm(&msg_c, &conversation_id_c, true))
        .await
    {
        tracing::error!("Failed to store DM: {}", e);
        return;
    }

    let _ = app_handle.emit("dm:received", &msg);

    // Send desktop notification
    let preview = message_handler::truncate_preview(&content, 100);
    let _ = tauri_plugin_notification::NotificationExt::notification(app_handle)
        .builder()
        .title(&format!("DM from {}", display_name))
        .body(&preview)
        .show();
}

/// Check that a live gossip message timestamp is within a reasonable window:
/// not more than 5 seconds in the future and not older than 365 days.
/// This mirrors `is_history_timestamp_valid` in the history module, applied to
/// live gossip messages to prevent future-dated or backdated injection.
fn is_timestamp_valid(timestamp: &str) -> bool {
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
