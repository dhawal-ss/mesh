use sha2::{Digest, Sha256};
use tauri::State;
use zeroize::Zeroize;

use crate::crypto::encryption;
use crate::crypto::identity::ed25519_pub_to_x25519;
use crate::network::envelope::EnvelopeBuilder;
use crate::network::events::NetworkCommand;
use crate::state::AppState;
use crate::storage::Database;
use crate::types::dm::{DirectMessageDto, DmConversationDto};

use super::error::CommandError;

/// Compute a deterministic DM topic from two public keys.
/// Uses a sorted hash so both parties derive the same topic.
pub(crate) fn dm_topic(key_a: &str, key_b: &str) -> String {
    let mut keys = [key_a, key_b];
    keys.sort();
    let mut hasher = Sha256::new();
    hasher.update(keys[0].as_bytes());
    hasher.update(b":");
    hasher.update(keys[1].as_bytes());
    let hash = hasher.finalize();
    let topic_id = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(&hash[..16]);
    format!("mesh/dm/{}", topic_id)
}

#[tauri::command]
pub async fn send_dm(
    recipient_public_key: String,
    content: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<DirectMessageDto, CommandError> {
    let (public_key, private_key_bytes) = {
        let guard = state.identity.read().await;
        let id = guard.as_ref().ok_or(CommandError::Identity("No identity loaded".into()))?;
        (id.public_key_b64.clone(), id.private_key_bytes())
    };

    let public_key_c = public_key.clone();
    let profile = db
        .run_blocking(move |db| db.get_local_profile(&public_key_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?
        .ok_or(CommandError::NotFound("No profile found".into()))?;

    // Get or create conversation
    let recipient_c = recipient_public_key.clone();
    let short_name = recipient_public_key[..6.min(recipient_public_key.len())].to_string();
    let conversation = db
        .run_blocking(move |db| {
            db.get_or_create_dm_conversation(
                &recipient_c,
                &short_name,
                "#7a7570",
            )
        })
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    // Build the signed envelope (DM type, no community_id scope)
    let payload = serde_json::json!({
        "content": content,
        "author_display_name": profile.display_name,
        "author_avatar_color": profile.avatar_color,
    });

    let envelope = EnvelopeBuilder::new("dm", &public_key, "")
        .payload(payload)
        .sign(&private_key_bytes);

    let msg_dto = DirectMessageDto {
        id: envelope.id.clone(),
        conversation_id: conversation.id.clone(),
        author_public_key: public_key.clone(),
        author_display_name: profile.display_name.clone(),
        author_avatar_color: profile.avatar_color.clone(),
        content: content.clone(),
        timestamp: envelope.timestamp.clone(),
        signature: envelope.signature.clone(),
        edited_at: None,
        deleted_at: None,
    };

    // Store locally
    let msg_dto_c = msg_dto.clone();
    let conversation_id_c = conversation.id.clone();
    db.run_blocking(move |db| db.insert_dm(&msg_dto_c, &conversation_id_c, false))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    // Encrypt for recipient using X25519 ECDH
    let recipient_x25519 = ed25519_pub_to_x25519(&recipient_public_key)
        .map_err(|e| CommandError::Crypto(format!("Invalid recipient key: {}", e)))?;
    let mut plaintext = serde_json::to_vec(&envelope).map_err(|e| CommandError::Other(e.to_string()))?;
    let encrypted = encryption::encrypt_for_recipient(
        &recipient_x25519,
        &plaintext,
        "mesh-dm-v1",
    );
    plaintext.zeroize();

    // Subscribe to and publish on the deterministic DM topic
    let topic = dm_topic(&public_key, &recipient_public_key);
    let network = state.network.read().await;
    if let Some(ref net) = *network {
        // Ensure we are subscribed so we can receive replies
        if let Err(e) = net
            .send_command(NetworkCommand::SubscribeTopic {
                topic: topic.clone(),
            })
            .await
        {
            tracing::warn!("network subscribe to DM topic failed: {}", e);
        }
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic,
                data: encrypted,
            })
            .await
        {
            tracing::warn!("network publish DM failed: {}", e);
        }
    }

    Ok(msg_dto)
}

#[tauri::command]
pub async fn get_dm_conversations(
    db: State<'_, Database>,
) -> Result<Vec<DmConversationDto>, CommandError> {
    db.run_blocking(move |db| db.get_dm_conversations())
        .await
        .map_err(|e| CommandError::Other(e.to_string()))
}

#[tauri::command]
pub async fn get_dm_messages(
    conversation_id: String,
    limit: u32,
    before_timestamp: Option<String>,
    before_id: Option<String>,
    db: State<'_, Database>,
) -> Result<Vec<DirectMessageDto>, CommandError> {
    db.run_blocking(move |db| {
        db.get_dm_messages(
            &conversation_id,
            limit,
            before_timestamp.as_deref(),
            before_id.as_deref(),
        )
    })
    .await
    .map_err(|e| CommandError::Other(e.to_string()))
}

#[tauri::command]
pub async fn mark_dm_read(
    conversation_id: String,
    db: State<'_, Database>,
) -> Result<(), CommandError> {
    db.run_blocking(move |db| db.mark_dm_read(&conversation_id))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))
}

use base64::Engine;
