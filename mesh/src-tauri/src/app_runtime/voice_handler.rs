use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::network::envelope::{SignedEnvelope, VoiceMembershipPayload, VoiceSignalPayload};
use crate::state::voice_state::VoiceSessionEvent;
use crate::state::AppState;
use crate::storage::Database;

// ─── Frontend-facing event payloads (camelCase) ─────

/// Emitted on `voice:join` / `voice:leave` / `voice:heartbeat`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceMembershipEvent {
    author: String,
    community_id: String,
    channel_id: String,
}

/// Emitted on `voice:signal`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceSignalEvent {
    community_id: String,
    channel_id: String,
    source_public_key: String,
    target_peer: String,
    signal: serde_json::Value,
}

pub(super) fn emit_voice_session_event(app_handle: &AppHandle, event: &VoiceSessionEvent) {
    let _ = app_handle.emit("voice:session:event", event);
    let _ = app_handle.emit("voice:session:snapshot", &event.snapshot);
    if event.snapshot.relay.relay_required {
        let _ = app_handle.emit(
            "voice:relay:elected",
            serde_json::json!({
                "communityId": event.community_id,
                "channelId": event.channel_id,
                "sessionEpoch": event.snapshot.session_epoch,
                "memberCount": event.snapshot.member_count,
                "relayCandidatePublicKey": event.snapshot.relay.relay_candidate_public_key,
            }),
        );
    }
}

fn resolve_voice_member_profile(
    app_handle: &AppHandle,
    community_id: &str,
    public_key: &str,
    display_name: Option<String>,
    avatar_color: Option<String>,
) -> (Option<String>, Option<String>) {
    let mut resolved_display = display_name.filter(|value| !value.trim().is_empty());
    let mut resolved_avatar = avatar_color.filter(|value| !value.trim().is_empty());

    if resolved_display.is_some() && resolved_avatar.is_some() {
        return (resolved_display, resolved_avatar);
    }

    let Some(state) = app_handle.try_state::<AppState>() else {
        return (resolved_display, resolved_avatar);
    };
    let Some(db) = app_handle.try_state::<Database>() else {
        return (resolved_display, resolved_avatar);
    };
    let _ = state.membership.load_community(&db, community_id);
    if let Ok(roster) = state.membership.get_roster(community_id) {
        if let Some(member) = roster
            .into_iter()
            .find(|member| member.public_key == public_key)
        {
            if resolved_display.is_none() && !member.display_name.trim().is_empty() {
                resolved_display = Some(member.display_name);
            }
            if resolved_avatar.is_none() && !member.avatar_color.trim().is_empty() {
                resolved_avatar = Some(member.avatar_color);
            }
        }
    }

    (resolved_display, resolved_avatar)
}

pub(super) async fn handle_signed_voice_membership_event(
    app_handle: &AppHandle,
    envelope: &SignedEnvelope,
) {
    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };
    let community_id = envelope.community_id.as_str();
    if community_id.is_empty() {
        return;
    }
    let Some(channel_id) = envelope.channel_id.as_deref() else {
        return;
    };
    let author = envelope.author.as_str();
    let local_author = state
        .identity
        .read()
        .await
        .as_ref()
        .map(|identity| identity.public_key_b64.clone());
    let is_local = local_author.as_deref() == Some(author);
    let payload = serde_json::from_value::<VoiceMembershipPayload>(envelope.payload.clone()).ok();
    let (display_name, avatar_color) = resolve_voice_member_profile(
        app_handle,
        community_id,
        author,
        payload
            .as_ref()
            .and_then(|payload| payload.display_name.clone()),
        payload
            .as_ref()
            .and_then(|payload| payload.avatar_color.clone()),
    );

    let event = match envelope.msg_type.as_str() {
        "voice_join" => {
            if is_local {
                state
                    .voice
                    .set_current_session(Some(crate::state::voice_state::VoiceSessionRef::new(
                        community_id,
                        channel_id,
                    )))
                    .await;
            }
            match state
                .voice
                .record_join(
                    community_id,
                    channel_id,
                    author,
                    is_local,
                    display_name.clone(),
                    avatar_color.clone(),
                )
                .await
            {
                Ok(event) => Some(event),
                Err(error) => {
                    tracing::warn!(
                        "Rejecting voice join for community {} channel {}: {}",
                        community_id,
                        channel_id,
                        error
                    );
                    None
                }
            }
        }
        "voice_leave" => {
            if is_local {
                state
                    .voice
                    .stop_heartbeat_task(community_id, channel_id)
                    .await;
                state.voice.set_current_session(None).await;
            }
            state
                .voice
                .record_leave(community_id, channel_id, author)
                .await
        }
        "voice_heartbeat" => {
            if is_local {
                state
                    .voice
                    .set_current_session(Some(crate::state::voice_state::VoiceSessionRef::new(
                        community_id,
                        channel_id,
                    )))
                    .await;
            }
            state
                .voice
                .record_heartbeat(
                    community_id,
                    channel_id,
                    author,
                    is_local,
                    display_name,
                    avatar_color,
                )
                .await
        }
        _ => None,
    };

    if let Some(event) = event.as_ref() {
        emit_voice_session_event(app_handle, event);
    }

    let event_name = match envelope.msg_type.as_str() {
        "voice_join" => "voice:join",
        "voice_leave" => "voice:leave",
        "voice_heartbeat" => "voice:heartbeat",
        _ => return,
    };
    let _ = app_handle.emit(
        event_name,
        VoiceMembershipEvent {
            author: envelope.author.clone(),
            community_id: envelope.community_id.clone(),
            channel_id: envelope.channel_id.clone().unwrap_or_default(),
        },
    );
}

pub(super) async fn handle_signed_voice_signal(app_handle: &AppHandle, envelope: &SignedEnvelope) {
    if !voice_payload_matches_current_epoch_signed(app_handle, envelope).await {
        tracing::warn!(
            "Dropping stale voice signal for channel {}",
            envelope.channel_id.as_deref().unwrap_or_default()
        );
        return;
    }

    let signal_payload =
        serde_json::from_value::<VoiceSignalPayload>(envelope.payload.clone()).ok();
    let _ = app_handle.emit(
        "voice:signal",
        VoiceSignalEvent {
            community_id: envelope.community_id.clone(),
            channel_id: envelope.channel_id.clone().unwrap_or_default(),
            source_public_key: envelope.author.clone(),
            target_peer: signal_payload
                .as_ref()
                .map(|p| p.target_peer.clone())
                .unwrap_or_default(),
            signal: signal_payload
                .map(|p| p.signal)
                .unwrap_or(serde_json::Value::Null),
        },
    );
}

pub(super) async fn voice_payload_matches_current_epoch_signed(
    app_handle: &AppHandle,
    envelope: &SignedEnvelope,
) -> bool {
    let Some(state) = app_handle.try_state::<AppState>() else {
        return true;
    };
    let community_id = envelope.community_id.as_str();
    if community_id.is_empty() {
        return true;
    }
    let Some(channel_id) = envelope.channel_id.as_deref() else {
        return true;
    };
    let payload_epoch = serde_json::from_value::<VoiceMembershipPayload>(envelope.payload.clone())
        .map(|payload| payload.epoch)
        .or_else(|_| {
            serde_json::from_value::<VoiceSignalPayload>(envelope.payload.clone())
                .map(|payload| payload.epoch)
        })
        .ok();

    match (
        state.voice.current_epoch(community_id, channel_id).await,
        payload_epoch,
    ) {
        (Some(current_epoch), Some(payload_epoch)) => current_epoch == payload_epoch,
        _ => false,
    }
}
