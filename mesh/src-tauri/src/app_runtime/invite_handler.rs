use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::control::ControlEvent;
use crate::crypto::encryption;
use crate::crypto::identity::verify_signature;
use crate::network::behaviour::{
    ChannelSnapshot, ControlRequest, ControlResponse, InviteChallengeRequest,
    InviteChallengeResponse, InviteJoinRequest, InviteJoinResponse,
};
use crate::network::events::NetworkCommand;
use crate::state::AppState;
use crate::storage::Database;

use super::helpers;
use super::security;

pub(super) async fn request_pending_invite_join(
    app_handle: &AppHandle,
    community_id: &str,
    peer_id: &str,
) {
    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };
    let Some(db) = app_handle.try_state::<Database>() else {
        return;
    };

    const INVITE_PENDING_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

    let (invite_secret, owner_public_key) = {
        let mut pending = state.pending_invites.lock().await;
        let Some(entry) = pending.get_mut(community_id) else {
            return;
        };
        if entry.created_at.elapsed() > INVITE_PENDING_TTL {
            tracing::info!(
                "Removing expired pending invite for community {}",
                community_id
            );
            pending.remove(community_id);
            return;
        }
        if !entry.attempted_peers.insert(peer_id.to_string()) {
            return;
        }
        (entry.invite_secret.clone(), entry.owner_public_key.clone())
    };

    let identity_guard = state.identity.read().await;
    let Some(identity) = identity_guard.as_ref() else {
        return;
    };
    let profile = db
        .get_local_profile(&identity.public_key_b64)
        .ok()
        .flatten();
    let display_name = profile
        .as_ref()
        .map(|profile| profile.display_name.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| helpers::short_peer_label(&identity.public_key_b64));
    let avatar_color = profile
        .as_ref()
        .map(|profile| profile.avatar_color.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "#c8b89a".to_string());

    // Encrypt the invite_secret to the owner's X25519 key so it is not
    // visible in plaintext on the wire.
    let encrypted_invite_secret = owner_public_key
        .as_deref()
        .and_then(|owner_pk| crate::crypto::identity::ed25519_pub_to_x25519(owner_pk).ok())
        .map(|owner_x25519| {
            encryption::encrypt_for_recipient(&owner_x25519, invite_secret.as_bytes(), community_id)
        });

    if encrypted_invite_secret.is_none() {
        tracing::warn!(
            "Aborting invite for community {}: owner X25519 public key unavailable, refusing to send plaintext invite secret",
            community_id,
        );
        return;
    }

    let request = InviteChallengeRequest {
        community_id: community_id.to_string(),
        // Never send the invite secret in plaintext on the wire.
        invite_secret: String::new(),
        joiner_public_key: identity.public_key_b64.clone(),
        joiner_x25519_public_key: BASE64.encode(identity.x25519_public_key().as_bytes()),
        display_name,
        avatar_color,
        timestamp: chrono::Utc::now().to_rfc3339(),
        encrypted_invite_secret,
    };

    tracing::info!(
        "Requesting v2 invite challenge for {} from peer {} (expected owner: {}, secret encrypted: {})",
        community_id,
        peer_id,
        owner_public_key.as_deref().unwrap_or("unknown"),
        request.encrypted_invite_secret.is_some(),
    );

    let network = state.network.read().await;
    if let Some(net) = network.as_ref() {
        let _ = net
            .send_command(NetworkCommand::RequestControl {
                peer_id: Some(peer_id.to_string()),
                request: ControlRequest::InviteChallenge(request),
            })
            .await;
    }
}

pub(super) async fn request_control_logs_for_known_communities(
    app_handle: &AppHandle,
    peer_id: Option<&str>,
) {
    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };
    let Some(db) = app_handle.try_state::<Database>() else {
        return;
    };
    let communities = match db.get_communities() {
        Ok(communities) => communities,
        Err(error) => {
            tracing::warn!(
                "Failed to enumerate communities for control-log sync: {}",
                error
            );
            return;
        }
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

    for community in communities {
        let since_timestamp = db
            .get_latest_control_event_timestamp(&community.id)
            .ok()
            .flatten();
        let request_timestamp = chrono::Utc::now().to_rfc3339();
        let signable = format!(
            "control-log-req:{}:{}:{}",
            community.id, our_public_key, request_timestamp
        );
        let request_signature = identity.sign(signable.as_bytes());
        let _ = net
            .send_command(NetworkCommand::RequestControl {
                peer_id: peer_id.map(ToString::to_string),
                request: ControlRequest::ControlLog(crate::network::behaviour::ControlLogRequest {
                    community_id: community.id,
                    since_timestamp,
                    requester_public_key: our_public_key.clone(),
                    request_signature,
                    request_timestamp,
                }),
            })
            .await;
    }
}

pub(super) async fn build_control_response(
    app_handle: &AppHandle,
    request: ControlRequest,
) -> ControlResponse {
    match request {
        ControlRequest::InviteChallenge(request) => {
            build_invite_challenge_response(app_handle, request).await
        }
        ControlRequest::InviteJoin(request) => {
            build_invite_join_response(app_handle, request).await
        }
        ControlRequest::ControlLog(request) => {
            let Some(db) = app_handle.try_state::<Database>() else {
                return ControlResponse::Error {
                    message: "database unavailable".into(),
                };
            };
            // Verify the community exists locally before serving the control log.
            // This prevents leaking control events for communities we don't belong to.
            let community_known = db
                .get_community_owner_public_key(&request.community_id)
                .ok()
                .flatten()
                .is_some();
            if !community_known {
                return ControlResponse::Error {
                    message: "community not found".into(),
                };
            }

            // Require signed requests — reject unsigned requests
            if request.request_signature.is_empty() || request.requester_public_key.is_empty() {
                tracing::warn!(
                    "Refusing unsigned control log request for community {}",
                    request.community_id,
                );
                return ControlResponse::Error {
                    message: "unsigned requests are not accepted".into(),
                };
            }

            // Verify the signature
            let signable = format!(
                "control-log-req:{}:{}:{}",
                request.community_id, request.requester_public_key, request.request_timestamp
            );
            if !crate::crypto::identity::verify_signature(
                &request.requester_public_key,
                signable.as_bytes(),
                &request.request_signature,
            )
            .unwrap_or(false)
            {
                tracing::warn!(
                    "Refusing control log for community {} — invalid signature",
                    request.community_id,
                );
                return ControlResponse::Error {
                    message: "invalid request signature".into(),
                };
            }

            // Verify the requester is a member of this community
            {
                if let Some(false) = security::is_active_member(
                    app_handle,
                    &request.community_id,
                    &request.requester_public_key,
                ) {
                    tracing::warn!(
                        "Refusing control log for community {} — requester {} is not a member",
                        request.community_id,
                        request.requester_public_key,
                    );
                    return ControlResponse::Error {
                        message: "not a member".into(),
                    };
                }
            }

            match db
                .get_control_events_since(&request.community_id, request.since_timestamp.as_deref())
            {
                Ok(events) => match events
                    .into_iter()
                    .map(|event_json| serde_json::from_str::<ControlEvent>(&event_json))
                    .collect::<Result<Vec<_>, _>>()
                {
                    Ok(events) => {
                        ControlResponse::ControlLog(crate::network::behaviour::ControlLogResponse {
                            community_id: request.community_id,
                            events,
                        })
                    }
                    Err(error) => ControlResponse::Error {
                        message: format!("invalid control log row: {error}"),
                    },
                },
                Err(error) => ControlResponse::Error {
                    message: error.to_string(),
                },
            }
        }
    }
}

async fn build_invite_challenge_response(
    app_handle: &AppHandle,
    mut request: InviteChallengeRequest,
) -> ControlResponse {
    let Some(db) = app_handle.try_state::<Database>() else {
        return ControlResponse::Error {
            message: "database unavailable".into(),
        };
    };
    let Some(state) = app_handle.try_state::<AppState>() else {
        return ControlResponse::Error {
            message: "state unavailable".into(),
        };
    };

    // Rate-limit invite challenge requests to prevent spam/Sybil attacks.
    if !state
        .rate_limits
        .allow(
            crate::state::rate_limits::RateLimitBucket::InviteChallenge,
            &request.community_id,
            &request.joiner_public_key,
        )
        .await
    {
        tracing::warn!(
            "Rate-limiting invite challenge from {} for community {}",
            request.joiner_public_key,
            request.community_id,
        );
        return ControlResponse::Error {
            message: "rate limited — too many invite requests".into(),
        };
    }

    // Reject plaintext invite secrets — only encrypted form is accepted.
    if request.encrypted_invite_secret.is_none() && !request.invite_secret.is_empty() {
        tracing::warn!(
            "Rejecting invite challenge for community {}: plaintext invite secret provided without encryption",
            request.community_id,
        );
        return ControlResponse::Error {
            message: "plaintext invite secrets are not accepted — encryption is required".into(),
        };
    }

    // Decrypt the invite secret if it was encrypted by the sender.
    if let Some(encrypted) = request.encrypted_invite_secret.take() {
        let identity_guard = state.identity.read().await;
        if let Some(identity) = identity_guard.as_ref() {
            match encryption::decrypt_from_sender(
                &identity.x25519_static_secret(),
                &encrypted,
                &request.community_id,
            ) {
                Ok(plaintext) => {
                    request.invite_secret = String::from_utf8(plaintext).unwrap_or_default();
                }
                Err(err) => {
                    tracing::warn!(
                        "Failed to decrypt encrypted_invite_secret for {}: {}",
                        request.community_id,
                        err
                    );
                }
            }
        }
    }

    // After decryption, if the invite secret is still empty, we have no valid secret to work with.
    if request.invite_secret.is_empty() {
        return ControlResponse::Error {
            message: "no valid invite secret provided".into(),
        };
    }

    let Ok(Some(community_key)) = db.get_community_keypair(&request.community_id) else {
        return ControlResponse::InviteChallenge(InviteChallengeResponse {
            accepted: false,
            reason: Some("community owner key unavailable".into()),
            community_id: request.community_id,
            joiner_public_key: request.joiner_public_key,
            joiner_x25519_public_key: request.joiner_x25519_public_key,
            challenge_nonce: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
            signed_by: None,
            signature: None,
        });
    };

    let owner_public_key = BASE64.encode(community_key.verifying_key.as_bytes());
    let challenge_nonce = uuid::Uuid::new_v4().to_string();
    let mut response = InviteChallengeResponse {
        accepted: true,
        reason: None,
        community_id: request.community_id,
        joiner_public_key: request.joiner_public_key,
        joiner_x25519_public_key: request.joiner_x25519_public_key,
        challenge_nonce: Some(challenge_nonce),
        timestamp: chrono::Utc::now().to_rfc3339(),
        signed_by: Some(owner_public_key),
        signature: None,
    };
    response.signature = Some(community_key.sign(&invite_challenge_response_signable(&response)));
    ControlResponse::InviteChallenge(response)
}

async fn build_invite_join_response(
    app_handle: &AppHandle,
    mut request: InviteJoinRequest,
) -> ControlResponse {
    let Some(db) = app_handle.try_state::<Database>() else {
        return ControlResponse::Error {
            message: "database unavailable".into(),
        };
    };
    let Some(state) = app_handle.try_state::<AppState>() else {
        return ControlResponse::Error {
            message: "state unavailable".into(),
        };
    };

    // Reject plaintext invite secrets — only encrypted form is accepted (mirrors step 1).
    if request.encrypted_invite_secret.is_none() && !request.invite_secret.is_empty() {
        tracing::warn!(
            "Rejecting InviteJoinRequest for community {}: plaintext invite secret provided without encryption",
            request.community_id,
        );
        return ControlResponse::Error {
            message: "plaintext invite secrets are not accepted — encryption is required".into(),
        };
    }

    let Ok(Some(community_key)) = db.get_community_keypair(&request.community_id) else {
        return ControlResponse::Error {
            message: "community owner key unavailable".into(),
        };
    };
    let owner_public_key = BASE64.encode(community_key.verifying_key.as_bytes());
    if !verify_signature(
        &owner_public_key,
        &invite_join_owner_challenge_signable(
            &request.community_id,
            &request.joiner_public_key,
            &request.joiner_x25519_public_key,
            &request.challenge_nonce,
            &request.challenge_issued_at,
            &owner_public_key,
        ),
        &request.challenge_token,
    )
    .unwrap_or(false)
    {
        return ControlResponse::InviteJoin(InviteJoinResponse {
            accepted: false,
            reason: Some("invalid challenge token".into()),
            community_id: request.community_id,
            community_name: None,
            community_description: None,
            owner_public_key: None,
            wrapped_group_key: None,
            channels: vec![],
            member_role: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
            signed_by: None,
            signature: None,
        });
    }
    // Verify the joiner's signature over the wire-format fields BEFORE
    // decrypting invite_secret (it is empty/absent on the wire).
    if !verify_signature(
        &request.joiner_public_key,
        &invite_join_request_signable(&request),
        &request.challenge_signature,
    )
    .unwrap_or(false)
    {
        return ControlResponse::InviteJoin(InviteJoinResponse {
            accepted: false,
            reason: Some("invalid challenge signature".into()),
            community_id: request.community_id,
            community_name: None,
            community_description: None,
            owner_public_key: None,
            wrapped_group_key: None,
            channels: vec![],
            member_role: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
            signed_by: None,
            signature: None,
        });
    }

    // Decrypt the invite secret after signature verification.
    if let Some(encrypted) = request.encrypted_invite_secret.take() {
        let identity_guard = state.identity.read().await;
        if let Some(identity) = identity_guard.as_ref() {
            match encryption::decrypt_from_sender(
                &identity.x25519_static_secret(),
                &encrypted,
                &request.community_id,
            ) {
                Ok(plaintext) => {
                    request.invite_secret = String::from_utf8(plaintext).unwrap_or_default();
                }
                Err(err) => {
                    tracing::warn!(
                        "Failed to decrypt encrypted_invite_secret in InviteJoinRequest for {}: {}",
                        request.community_id,
                        err
                    );
                }
            }
        }
    }

    // After decryption, if the invite secret is still empty, we have no valid secret.
    if request.invite_secret.is_empty() {
        return ControlResponse::Error {
            message: "no valid invite secret provided".into(),
        };
    }

    match db.consume_invite(&request.invite_secret) {
        Ok(Some(community_id)) if community_id == request.community_id => {}
        Ok(_) => {
            return ControlResponse::InviteJoin(InviteJoinResponse {
                accepted: false,
                reason: Some("invite rejected".into()),
                community_id: request.community_id,
                community_name: None,
                community_description: None,
                owner_public_key: None,
                wrapped_group_key: None,
                channels: vec![],
                member_role: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
                signed_by: None,
                signature: None,
            });
        }
        Err(error) => {
            return ControlResponse::Error {
                message: error.to_string(),
            };
        }
    }

    let Ok(Some(group_key_b64)) = db.get_group_key(&request.community_id) else {
        return ControlResponse::Error {
            message: "community group key unavailable".into(),
        };
    };
    let Ok(group_key) = encryption::group_key_from_b64(&group_key_b64) else {
        return ControlResponse::Error {
            message: "community group key invalid".into(),
        };
    };
    let Ok(joiner_x25519_bytes) = BASE64
        .decode(&request.joiner_x25519_public_key)
        .map_err(|error| error.to_string())
    else {
        return ControlResponse::Error {
            message: "joiner x25519 key invalid".into(),
        };
    };
    let Ok(joiner_x25519_key) = <[u8; 32]>::try_from(joiner_x25519_bytes.as_slice()) else {
        return ControlResponse::Error {
            message: "joiner x25519 key length invalid".into(),
        };
    };

    let wrapped_group_key = encryption::encrypt_key_wrap(
        &x25519_dalek::PublicKey::from(joiner_x25519_key),
        &group_key,
        &request.community_id,
    );

    {
        let event = crate::commands::control::create_control_event(
            &request.community_id,
            "member_join",
            serde_json::json!({
                "publicKey": request.joiner_public_key,
                "displayName": request.display_name,
                "avatarColor": request.avatar_color,
                "role": "member",
                "x25519PublicKey": request.joiner_x25519_public_key,
            }),
            &community_key,
        );
        let _ = crate::commands::control::apply_control_event(
            app_handle,
            &db,
            &event,
            &owner_public_key,
        );
        // Sync updated membership roster to the swarm task for file serving authorization.
        super::network_router::sync_community_members_to_swarm(
            app_handle,
            &db,
            &request.community_id,
        )
        .await;
        if let Some(state) = app_handle.try_state::<AppState>() {
            let network = state.network.read().await;
            if let Some(net) = network.as_ref() {
                if let Ok(plaintext) = serde_json::to_vec(&event) {
                    let aad = encryption::build_community_aad(&request.community_id, "");
                    if let Ok(data) =
                        db.encrypt_community_payload(&request.community_id, &plaintext, &aad)
                    {
                        // Publish member_join to the meta topic
                        let _ = net
                            .send_command(NetworkCommand::PublishMessage {
                                topic: crate::network::gossip::community_meta_topic(
                                    &request.community_id,
                                ),
                                data: data.clone(),
                            })
                            .await;
                        // Backward compat: also publish to the legacy community-wide topic
                        let _ = net
                            .send_command(NetworkCommand::PublishMessage {
                                topic: format!(
                                    "mesh/community/{}/messages",
                                    request.community_id
                                ),
                                data,
                            })
                            .await;
                    }
                }
            }
        }
    }

    let (community, channels) = match db.get_community_snapshot(&request.community_id) {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => {
            return ControlResponse::Error {
                message: "community not found".into(),
            };
        }
        Err(error) => {
            return ControlResponse::Error {
                message: error.to_string(),
            };
        }
    };

    let mut response = InviteJoinResponse {
        accepted: true,
        reason: None,
        community_id: request.community_id,
        community_name: Some(community.name),
        community_description: Some(community.description),
        owner_public_key: Some(owner_public_key.clone()),
        wrapped_group_key: Some(wrapped_group_key),
        channels: channels
            .into_iter()
            .map(|channel| ChannelSnapshot {
                id: channel.id,
                name: channel.name,
                channel_type: channel.channel_type,
            })
            .collect(),
        member_role: Some("member".into()),
        timestamp: chrono::Utc::now().to_rfc3339(),
        signed_by: Some(owner_public_key.clone()),
        signature: None,
    };
    response.signature = Some(community_key.sign(&invite_join_response_signable(&response)));

    ControlResponse::InviteJoin(response)
}

pub(super) async fn handle_control_response(
    app_handle: &AppHandle,
    peer_id: &str,
    response: ControlResponse,
) {
    match response {
        ControlResponse::InviteChallenge(response) => {
            complete_pending_invite_join(app_handle, peer_id, response).await;
        }
        ControlResponse::InviteJoin(response) => {
            apply_invite_join_response(app_handle, response).await;
        }
        ControlResponse::ControlLog(response) => {
            let Some(db) = app_handle.try_state::<Database>() else {
                return;
            };
            let owner_public_key = db
                .get_community_owner_public_key(&response.community_id)
                .ok()
                .flatten();
            let Some(owner_public_key) = owner_public_key else {
                return;
            };

            let mut had_membership_event = false;
            for event in &response.events {
                let result = crate::commands::control::apply_control_event(
                    app_handle,
                    &db,
                    event,
                    &owner_public_key,
                );
                if result.as_ref().map(|r| r.applied).unwrap_or(false) {
                    if matches!(
                        event.event_type.as_str(),
                        "member_join" | "member_leave" | "member_ban" | "community_delete"
                    ) {
                        had_membership_event = true;
                    }
                }
            }
            // Sync membership roster to swarm once after all events are applied.
            if had_membership_event {
                super::network_router::sync_community_members_to_swarm(
                    app_handle,
                    &db,
                    &response.community_id,
                )
                .await;
            }
        }
        ControlResponse::Error { message } => {
            tracing::warn!("Control response error: {}", message);
        }
    }
}

pub(super) async fn complete_pending_invite_join(
    app_handle: &AppHandle,
    peer_id: &str,
    response: InviteChallengeResponse,
) {
    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };
    let Some(db) = app_handle.try_state::<Database>() else {
        return;
    };

    if !response.accepted {
        state
            .pending_invites
            .lock()
            .await
            .remove(&response.community_id);
        let _ = app_handle.emit(
            "community:join_failed",
            serde_json::json!({
                "communityId": response.community_id,
                "reason": response.reason.unwrap_or_else(|| "join challenge rejected".into()),
            }),
        );
        return;
    }

    let pending = state
        .pending_invites
        .lock()
        .await
        .get(&response.community_id)
        .cloned();
    let Some(pending) = pending else {
        return;
    };
    let signed_by = response.signed_by.clone().unwrap_or_default();
    let signature = response.signature.clone().unwrap_or_default();
    if let Some(expected_owner) = pending.owner_public_key.as_deref() {
        if expected_owner != signed_by {
            tracing::warn!(
                "Dropping invite challenge for {} from unexpected signer {}",
                response.community_id,
                signed_by
            );
            return;
        }
    }
    if !verify_signature(
        &signed_by,
        &invite_challenge_response_signable(&response),
        &signature,
    )
    .unwrap_or(false)
    {
        tracing::warn!(
            "Dropping invite challenge for {} with invalid signature",
            response.community_id
        );
        return;
    }

    let Some(challenge_nonce) = response.challenge_nonce.clone() else {
        return;
    };

    let identity_guard = state.identity.read().await;
    let Some(identity) = identity_guard.as_ref() else {
        return;
    };
    let profile = db
        .get_local_profile(&identity.public_key_b64)
        .ok()
        .flatten();
    let display_name = profile
        .as_ref()
        .map(|profile| profile.display_name.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| helpers::short_peer_label(&identity.public_key_b64));
    let avatar_color = profile
        .as_ref()
        .map(|profile| profile.avatar_color.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "#c8b89a".to_string());

    // Encrypt the invite_secret to the owner's X25519 key so it is not
    // visible in plaintext on the wire (mirrors the step 1 encryption).
    let owner_pk_b64 = response.signed_by.clone().unwrap_or_default();
    let encrypted_invite_secret = crate::crypto::identity::ed25519_pub_to_x25519(&owner_pk_b64)
        .ok()
        .map(|owner_x25519| {
            encryption::encrypt_for_recipient(
                &owner_x25519,
                pending.invite_secret.as_bytes(),
                &response.community_id,
            )
        });

    if encrypted_invite_secret.is_none() {
        tracing::warn!(
            "Aborting InviteJoinRequest for community {}: owner X25519 key unavailable, refusing to send plaintext invite secret",
            response.community_id,
        );
        return;
    }

    let mut request = InviteJoinRequest {
        community_id: response.community_id.clone(),
        // Never send the invite secret in plaintext on the wire.
        invite_secret: String::new(),
        joiner_public_key: identity.public_key_b64.clone(),
        joiner_x25519_public_key: BASE64.encode(identity.x25519_public_key().as_bytes()),
        display_name,
        avatar_color,
        challenge_nonce,
        challenge_issued_at: response.timestamp.clone(),
        challenge_token: signature,
        timestamp: chrono::Utc::now().to_rfc3339(),
        challenge_signature: String::new(),
        encrypted_invite_secret,
    };
    request.challenge_signature = identity.sign(&invite_join_request_signable(&request));

    let network = state.network.read().await;
    if let Some(net) = network.as_ref() {
        let _ = net
            .send_command(NetworkCommand::RequestControl {
                peer_id: Some(peer_id.to_string()),
                request: ControlRequest::InviteJoin(request),
            })
            .await;
    }
}

pub(super) async fn apply_invite_join_response(
    app_handle: &AppHandle,
    response: InviteJoinResponse,
) {
    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };
    let Some(db) = app_handle.try_state::<Database>() else {
        return;
    };

    if !response.accepted {
        state
            .pending_invites
            .lock()
            .await
            .remove(&response.community_id);
        let _ = app_handle.emit(
            "community:join_failed",
            serde_json::json!({
                "communityId": response.community_id,
                "reason": response.reason.unwrap_or_else(|| "join rejected".into()),
            }),
        );
        return;
    }

    let pending = state
        .pending_invites
        .lock()
        .await
        .get(&response.community_id)
        .cloned();
    let Some(pending) = pending else {
        return;
    };
    let expected_owner = pending
        .owner_public_key
        .or(response.owner_public_key.clone());
    let signed_by = response.signed_by.clone().unwrap_or_default();
    let signature = response.signature.clone().unwrap_or_default();
    if let Some(expected_owner) = expected_owner.as_deref() {
        if expected_owner != signed_by {
            tracing::warn!(
                "Dropping invite join response for {} from unexpected signer {}",
                response.community_id,
                signed_by
            );
            return;
        }
    }
    if !verify_signature(
        &signed_by,
        &invite_join_response_signable(&response),
        &signature,
    )
    .unwrap_or(false)
    {
        tracing::warn!(
            "Dropping invite join response for {} with invalid signature",
            response.community_id
        );
        return;
    }

    let identity_guard = state.identity.read().await;
    let Some(identity) = identity_guard.as_ref() else {
        return;
    };
    let Some(wrapped_group_key) = response.wrapped_group_key.as_deref() else {
        return;
    };
    let Ok(group_key) = encryption::decrypt_key_wrap(
        &identity.x25519_static_secret(),
        wrapped_group_key,
        &response.community_id,
    ) else {
        tracing::warn!("Failed to unwrap group key for {}", response.community_id);
        return;
    };

    let group_key_b64 = encryption::group_key_to_b64(&group_key);
    let name = response
        .community_name
        .clone()
        .unwrap_or_else(|| "Joined Community".into());
    let description = response.community_description.clone().unwrap_or_default();
    let owner_public_key = response
        .owner_public_key
        .clone()
        .unwrap_or(signed_by.clone());
    let _ = db.update_joined_community_snapshot(
        &response.community_id,
        &name,
        &description,
        &owner_public_key,
        &group_key_b64,
    );
    let channels: Vec<crate::types::community::ChannelDto> = response
        .channels
        .iter()
        .map(|channel| crate::types::community::ChannelDto {
            id: channel.id.clone(),
            community_id: response.community_id.clone(),
            name: channel.name.clone(),
            channel_type: channel.channel_type.clone(),
            unread_count: 0,
        })
        .collect();
    let _ = db.replace_channels_for_community(&response.community_id, &channels);

    let profile = db
        .get_local_profile(&identity.public_key_b64)
        .ok()
        .flatten();
    let display_name = profile
        .as_ref()
        .map(|profile| profile.display_name.as_str())
        .unwrap_or("You");
    let avatar_color = profile
        .as_ref()
        .map(|profile| profile.avatar_color.as_str())
        .unwrap_or("#c8b89a");
    let x25519_public_key = BASE64.encode(identity.x25519_public_key().as_bytes());
    let _ = db.upsert_member(
        &response.community_id,
        &identity.public_key_b64,
        display_name,
        avatar_color,
        response.member_role.as_deref().unwrap_or("member"),
        Some(&x25519_public_key),
    );
    let _ = state.membership.load_community(&db, &response.community_id);

    state
        .pending_invites
        .lock()
        .await
        .remove(&response.community_id);

    if let Ok(Some((community, _))) = db.get_community_snapshot(&response.community_id) {
        let _ = app_handle.emit("community:updated", &community);
    }
    for channel in channels {
        let _ = app_handle.emit(
            "control:event",
            serde_json::json!({
                "communityId": response.community_id,
                "eventType": "channel_create",
                "payload": {
                    "channelId": channel.id,
                    "name": channel.name,
                    "channelType": channel.channel_type,
                },
                "applied": true,
            }),
        );
    }
}

fn invite_join_request_signable(request: &InviteJoinRequest) -> Vec<u8> {
    serde_json::json!({
        "community_id": request.community_id,
        "invite_secret": request.invite_secret,
        "joiner_public_key": request.joiner_public_key,
        "joiner_x25519_public_key": request.joiner_x25519_public_key,
        "display_name": request.display_name,
        "avatar_color": request.avatar_color,
        "challenge_nonce": request.challenge_nonce,
        "challenge_issued_at": request.challenge_issued_at,
        "challenge_token": request.challenge_token,
        "timestamp": request.timestamp,
    })
    .to_string()
    .into_bytes()
}

fn invite_challenge_response_signable(response: &InviteChallengeResponse) -> Vec<u8> {
    invite_join_owner_challenge_signable(
        &response.community_id,
        &response.joiner_public_key,
        &response.joiner_x25519_public_key,
        response.challenge_nonce.as_deref().unwrap_or_default(),
        &response.timestamp,
        response.signed_by.as_deref().unwrap_or_default(),
    )
}

fn invite_join_owner_challenge_signable(
    community_id: &str,
    joiner_public_key: &str,
    joiner_x25519_public_key: &str,
    challenge_nonce: &str,
    timestamp: &str,
    signed_by: &str,
) -> Vec<u8> {
    serde_json::json!({
        "community_id": community_id,
        "joiner_public_key": joiner_public_key,
        "joiner_x25519_public_key": joiner_x25519_public_key,
        "challenge_nonce": challenge_nonce,
        "timestamp": timestamp,
        "signed_by": signed_by,
    })
    .to_string()
    .into_bytes()
}

fn invite_join_response_signable(response: &InviteJoinResponse) -> Vec<u8> {
    serde_json::json!({
        "accepted": response.accepted,
        "reason": response.reason,
        "community_id": response.community_id,
        "community_name": response.community_name,
        "community_description": response.community_description,
        "owner_public_key": response.owner_public_key,
        "wrapped_group_key": response.wrapped_group_key,
        "channels": response.channels,
        "member_role": response.member_role,
        "timestamp": response.timestamp,
        "signed_by": response.signed_by,
    })
    .to_string()
    .into_bytes()
}
