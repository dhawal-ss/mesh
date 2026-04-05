use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::crypto::identity::Identity;
use crate::network::envelope::{EnvelopeBuilder, VoiceMembershipPayload, VoiceSignalPayload};
use crate::network::events::NetworkCommand;
use crate::state::voice_state::{
    VoiceSessionEvent, VoiceSessionRef, VoiceSessionSnapshot, VOICE_HEARTBEAT_INTERVAL,
};
use crate::state::AppState;
use crate::storage::Database;

use super::error::CommandError;

#[tauri::command]
pub async fn join_voice(
    community_id: String,
    channel_id: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<VoiceSessionSnapshot, CommandError> {
    let (author_public_key, author_private_key_bytes, source_peer_id) = {
        let identity_guard = state.identity.read().await;
        let identity = identity_guard.as_ref().ok_or(CommandError::Identity("No identity loaded".into()))?;
        (
            identity.public_key_b64.clone(),
            identity.private_key_bytes(),
            local_peer_id(identity).map_err(|e| CommandError::Other(e.to_string()))?,
        )
    };

    let author_public_key_c = author_public_key.clone();
    let profile = db
        .run_blocking(move |db| db.get_local_profile(&author_public_key_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    let display_name = profile
        .as_ref()
        .map(|profile| profile.display_name.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| short_peer_label(&author_public_key));
    let avatar_color = profile
        .as_ref()
        .map(|profile| profile.avatar_color.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "#c8b89a".to_string());

    let session = state
        .voice
        .record_join(
            &community_id,
            &channel_id,
            &author_public_key,
            true,
            Some(display_name.clone()),
            Some(avatar_color.clone()),
        )
        .await?;
    state
        .voice
        .set_current_session(Some(VoiceSessionRef::new(&community_id, &channel_id)))
        .await;

    emit_voice_session_event(&app_handle, &session);

    let envelope = EnvelopeBuilder::new("voice_join", &author_public_key, &community_id)
        .channel_id(&channel_id)
        .payload_typed(&VoiceMembershipPayload {
            epoch: session.snapshot.session_epoch,
            source_peer_id: Some(source_peer_id.clone()),
            display_name: Some(display_name),
            avatar_color: Some(avatar_color),
        })
        .sign(&author_private_key_bytes);

    if let Some(ref net) = *state.network.read().await {
        if let Err(e) = net
            .send_command(NetworkCommand::SubscribeTopic {
                topic: voice_topic(&community_id, &channel_id),
            })
            .await
        {
            tracing::warn!("network subscribe to voice topic failed: {}", e);
        }
        let data = serde_json::to_vec(&envelope).map_err(|e| CommandError::Other(e.to_string()))?;
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: voice_topic(&community_id, &channel_id),
                data,
            })
            .await
        {
            tracing::warn!("network publish voice join failed: {}", e);
        }
    }

    schedule_voice_heartbeat(
        app_handle.clone(),
        state.voice.clone(),
        state.network.clone(),
        community_id.clone(),
        channel_id.clone(),
        author_public_key,
        source_peer_id,
        author_private_key_bytes,
    )
    .await;

    Ok(session.snapshot)
}

#[tauri::command]
pub async fn leave_voice(
    community_id: String,
    channel_id: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let (author_public_key, author_private_key_bytes, source_peer_id) = {
        let identity_guard = state.identity.read().await;
        let identity = identity_guard.as_ref().ok_or(CommandError::Identity("No identity loaded".into()))?;
        (
            identity.public_key_b64.clone(),
            identity.private_key_bytes(),
            local_peer_id(identity).map_err(|e| CommandError::Other(e.to_string()))?,
        )
    };

    let session = state
        .voice
        .record_leave(&community_id, &channel_id, &author_public_key)
        .await;

    if let Some(current) = state.voice.current_session.read().await.clone() {
        if current.community_id == community_id && current.channel_id == channel_id {
            state.voice.set_current_session(None).await;
        }
    }
    state
        .voice
        .stop_heartbeat_task(&community_id, &channel_id)
        .await;

    if let Some(event) = session.as_ref() {
        emit_voice_session_event(&app_handle, event);
    }

    let epoch = session
        .as_ref()
        .map(|event| event.snapshot.session_epoch)
        .unwrap_or(0);
    let envelope = EnvelopeBuilder::new("voice_leave", &author_public_key, &community_id)
        .channel_id(&channel_id)
        .payload_typed(&VoiceMembershipPayload {
            epoch,
            source_peer_id: Some(source_peer_id),
            display_name: None,
            avatar_color: None,
        })
        .sign(&author_private_key_bytes);

    if let Some(ref net) = *state.network.read().await {
        let data = serde_json::to_vec(&envelope).map_err(|e| CommandError::Other(e.to_string()))?;
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: voice_topic(&community_id, &channel_id),
                data,
            })
            .await
        {
            tracing::warn!("network publish voice leave failed: {}", e);
        }

        if let Err(e) = net
            .send_command(NetworkCommand::UnsubscribeTopic {
                topic: voice_topic(&community_id, &channel_id),
            })
            .await
        {
            tracing::warn!("network unsubscribe from voice topic failed: {}", e);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn set_muted(_muted: bool) -> Result<(), CommandError> {
    // Mute state is purely frontend via MediaStreamTrack
    Ok(())
}

#[tauri::command]
pub async fn set_deafened(_deafened: bool) -> Result<(), CommandError> {
    // Deafen state is purely frontend
    Ok(())
}

#[tauri::command]
pub async fn send_voice_signal(
    peer_id: String,
    signal: Value,
    community_id: String,
    channel_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let (author_public_key, author_private_key_bytes) = {
        let identity_guard = state.identity.read().await;
        let identity = identity_guard.as_ref().ok_or(CommandError::Identity("No identity loaded".into()))?;
        (
            identity.public_key_b64.clone(),
            identity.private_key_bytes(),
        )
    };

    let epoch = state
        .voice
        .current_epoch(&community_id, &channel_id)
        .await
        .unwrap_or(0);

    let envelope = EnvelopeBuilder::new("voice_signal", &author_public_key, &community_id)
        .channel_id(&channel_id)
        .payload_typed(&VoiceSignalPayload {
            target_peer: peer_id,
            signal,
            epoch,
        })
        .sign(&author_private_key_bytes);

    let network = state.network.read().await;
    if let Some(ref net) = *network {
        let data = serde_json::to_vec(&envelope).map_err(|e| CommandError::Other(e.to_string()))?;
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: voice_topic(&community_id, &channel_id),
                data,
            })
            .await
        {
            tracing::warn!("network publish voice signal failed: {}", e);
        }
    }

    Ok(())
}

fn emit_voice_session_event(app_handle: &AppHandle, event: &VoiceSessionEvent) {
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

async fn schedule_voice_heartbeat(
    app_handle: AppHandle,
    voice_state: std::sync::Arc<crate::state::voice_state::VoiceState>,
    network_state: std::sync::Arc<
        tokio::sync::RwLock<Option<crate::network::events::NetworkHandle>>,
    >,
    community_id: String,
    channel_id: String,
    author_public_key: String,
    source_peer_id: String,
    author_private_key_bytes: [u8; 32],
) {
    let community_id_for_task = community_id.clone();
    let channel_id_for_task = channel_id.clone();
    let source_peer_id_for_task = source_peer_id.clone();
    let voice_state_for_task = voice_state.clone();
    let heartbeat_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(VOICE_HEARTBEAT_INTERVAL);
        interval.tick().await;

        loop {
            interval.tick().await;

            let current_session = voice_state_for_task.current_session.read().await.clone();
            if current_session.as_ref().map(|session| {
                session.community_id == community_id_for_task
                    && session.channel_id == channel_id_for_task
            }) != Some(true)
            {
                break;
            }

            let epoch = voice_state_for_task
                .current_epoch(&community_id_for_task, &channel_id_for_task)
                .await
                .unwrap_or(0);

            if let Some(event) = voice_state_for_task
                .record_heartbeat(
                    &community_id_for_task,
                    &channel_id_for_task,
                    &author_public_key,
                    true,
                    None,
                    None,
                )
                .await
            {
                emit_voice_session_event(&app_handle, &event);
            }

            let envelope = EnvelopeBuilder::new(
                "voice_heartbeat",
                &author_public_key,
                &community_id_for_task,
            )
            .channel_id(&channel_id_for_task)
            .payload_typed(&VoiceMembershipPayload {
                epoch,
                source_peer_id: Some(source_peer_id_for_task.clone()),
                display_name: None,
                avatar_color: None,
            })
            .sign(&author_private_key_bytes);

            let network = network_state.read().await;
            if let Some(ref net) = *network {
                let Ok(data) = serde_json::to_vec(&envelope) else {
                    tracing::error!("Failed to serialize voice heartbeat envelope");
                    continue;
                };
                if let Err(e) = net
                    .send_command(NetworkCommand::PublishMessage {
                        topic: voice_topic(&community_id_for_task, &channel_id_for_task),
                        data,
                    })
                    .await
                {
                    tracing::warn!("network publish voice heartbeat failed: {}", e);
                }
            }
        }
    });

    voice_state
        .start_heartbeat_task(community_id, channel_id, heartbeat_handle)
        .await;
}

fn voice_topic(community_id: &str, channel_id: &str) -> String {
    format!(
        "mesh/community/{}/voice/{}/signal",
        community_id, channel_id
    )
}

fn local_peer_id(identity: &Identity) -> anyhow::Result<String> {
    let secret_bytes = identity.private_key_bytes();
    let secret = libp2p::identity::ed25519::SecretKey::try_from_bytes(secret_bytes)?;
    let keypair = libp2p::identity::Keypair::from(libp2p::identity::ed25519::Keypair::from(secret));
    Ok(libp2p::PeerId::from_public_key(&keypair.public()).to_string())
}

fn short_peer_label(public_key: &str) -> String {
    let short = public_key.chars().take(4).collect::<String>();
    if short.is_empty() {
        "Peer".into()
    } else {
        format!("Peer {short}")
    }
}
