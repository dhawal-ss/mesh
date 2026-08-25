use zeroize::Zeroize;

use crate::crypto::encryption;
use crate::network::envelope::SignedEnvelope;
use crate::network::events::{NetworkCommand, NetworkHandle};
use crate::network::gossip::channel_messages_topic;
use crate::storage::Database;

use super::error::CommandError;

/// Serialize, encrypt, and publish a signed envelope to both the per-channel
/// topic and the legacy community-wide topic.
///
/// This consolidates the repeated encrypt+publish pattern used across
/// `send_message`, `edit_message`, `delete_message`, `add_reaction`, etc.
pub async fn encrypt_and_publish(
    db: &Database,
    net: &NetworkHandle,
    envelope: &SignedEnvelope,
    community_id: &str,
    channel_id: &str,
) -> Result<(), CommandError> {
    let mut plaintext =
        serde_json::to_vec(envelope).map_err(|e| CommandError::Other(e.to_string()))?;

    let community_id_owned = community_id.to_string();
    let plaintext_copy = plaintext.clone();
    let aad = encryption::build_community_aad(community_id, channel_id);
    let data = db
        .run_blocking(move |db| {
            db.encrypt_community_payload(&community_id_owned, &plaintext_copy, &aad)
        })
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    plaintext.zeroize();

    // Publish to per-channel topic
    if let Err(e) = net
        .send_command(NetworkCommand::PublishMessage {
            topic: channel_messages_topic(community_id, channel_id),
            data: data.clone(),
        })
        .await
    {
        tracing::warn!(
            "network publish to channel topic failed (community={}, channel={}): {}",
            community_id,
            channel_id,
            e
        );
    }

    // Backward compat: also publish to the legacy community-wide topic
    if let Err(e) = net
        .send_command(NetworkCommand::PublishMessage {
            topic: format!("mesh/community/{}/messages", community_id),
            data,
        })
        .await
    {
        tracing::warn!(
            "network publish to legacy topic failed (community={}): {}",
            community_id,
            e
        );
    }

    Ok(())
}
