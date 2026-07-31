/// Versioned, signed network envelopes for Mesh.
///
/// Every message on the wire is a `SignedEnvelope` with version 2.
/// The signature covers the canonical JSON of the inner payload plus
/// the envelope metadata (author, community_id, timestamp, msg_type, id).
///
/// This module also defines typed payload variants for each message kind.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

use crate::crypto::identity::{verify_signature, Identity};

// ─── Envelope ────────────────────────────────────────

/// The top-level network envelope. Every gossipsub message and
/// control-log event is serialized as one of these.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedEnvelope {
    /// Protocol version — always 2 for the secure-alpha wire format.
    pub v: u8,
    /// Discriminator: "message", "reaction", "file_announced", "presence",
    /// "voice_join", "voice_leave", "voice_heartbeat", "voice_signal",
    /// "ban", "community_control", "key_rotation", "history_response".
    #[serde(rename = "type")]
    pub msg_type: String,
    /// Unique envelope ID (nanoid).
    pub id: String,
    /// Author's base64-encoded Ed25519 public key.
    pub author: String,
    /// Community scope — may be empty for cross-community messages.
    #[serde(default)]
    pub community_id: String,
    /// ISO-8601 timestamp.
    pub timestamp: String,
    /// The typed inner payload (JSON value).
    pub payload: serde_json::Value,
    /// Base64-encoded Ed25519 signature over the signable bytes.
    pub signature: String,
    /// Optional: for owner-signed events, the community key that signed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_by: Option<String>,
    /// Optional: channel scope for messages/reactions/voice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
}

#[allow(dead_code)]
impl SignedEnvelope {
    pub fn sign<T: Serialize>(
        identity: &Identity,
        msg_type: &str,
        community_id: &str,
        channel_id: Option<&str>,
        payload: &T,
    ) -> anyhow::Result<Self> {
        let mut builder = EnvelopeBuilder::new(msg_type, &identity.public_key_b64, community_id);
        if let Some(channel_id) = channel_id {
            builder = builder.channel_id(channel_id);
        }

        Ok(builder
            .payload_typed(payload)
            .sign(&identity.private_key_bytes()))
    }

    /// Compute the canonical bytes that are signed.
    ///
    /// For author-signed envelopes (messages, reactions, presence, voice, files):
    ///   JSON of { id, type, author, community_id, channel_id, timestamp, payload }
    ///
    /// For owner-signed envelopes (bans, community_control, key_rotation):
    ///   JSON of { id, type, signed_by, community_id, timestamp, payload }
    pub fn signable_bytes(&self) -> Vec<u8> {
        // Use BTreeMap to guarantee deterministic (alphabetical) key ordering.
        // serde_json::json!() relies on implementation-defined key ordering
        // which is not guaranteed by the JSON spec and could change across
        // serde_json versions or compilation settings, breaking signatures.
        let mut map = BTreeMap::<&str, serde_json::Value>::new();
        if self.signed_by.is_some() {
            map.insert(
                "community_id",
                serde_json::Value::String(self.community_id.clone()),
            );
            map.insert("id", serde_json::Value::String(self.id.clone()));
            map.insert("payload", self.payload.clone());
            map.insert(
                "signed_by",
                serde_json::to_value(&self.signed_by).unwrap_or_default(),
            );
            map.insert(
                "timestamp",
                serde_json::Value::String(self.timestamp.clone()),
            );
            map.insert("type", serde_json::Value::String(self.msg_type.clone()));
        } else {
            map.insert("author", serde_json::Value::String(self.author.clone()));
            map.insert(
                "channel_id",
                serde_json::to_value(&self.channel_id).unwrap_or_default(),
            );
            map.insert(
                "community_id",
                serde_json::Value::String(self.community_id.clone()),
            );
            map.insert("id", serde_json::Value::String(self.id.clone()));
            map.insert("payload", self.payload.clone());
            map.insert(
                "timestamp",
                serde_json::Value::String(self.timestamp.clone()),
            );
            map.insert("type", serde_json::Value::String(self.msg_type.clone()));
        }
        serde_json::to_string(&map)
            .expect("BTreeMap<&str, Value> serialization is infallible")
            .into_bytes()
    }

    /// Verify the envelope signature.
    ///
    /// For owner-signed envelopes, `signer_key` must be the community owner's
    /// public key. For author-signed envelopes, the author field is used.
    pub fn verify(&self) -> Result<bool, anyhow::Error> {
        let signable = self.signable_bytes();
        let signer = self.signed_by.as_deref().unwrap_or(&self.author);
        verify_signature(signer, &signable, &self.signature)
    }

    /// Quick check: is this envelope version 2?
    pub fn is_v2(&self) -> bool {
        self.v == 2
    }

    /// Try to parse raw bytes into a SignedEnvelope.
    /// Returns None if the bytes are not valid JSON or not a v2 envelope.
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        let envelope = serde_json::from_slice::<Self>(data).ok()?;
        envelope.is_v2().then_some(envelope)
    }

    /// Extract the author display name, falling back to a short key label.
    pub fn display_name(&self) -> String {
        self.payload
            .get("author_display_name")
            .and_then(|value| value.as_str())
            .or_else(|| {
                self.payload
                    .get("authorDisplayName")
                    .and_then(|value| value.as_str())
            })
            .filter(|s| !s.trim().is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| short_key_label(&self.author))
    }

    /// Extract the author avatar color, falling back to a default.
    pub fn avatar_color(&self) -> String {
        self.payload
            .get("author_avatar_color")
            .and_then(|value| value.as_str())
            .or_else(|| {
                self.payload
                    .get("authorAvatarColor")
                    .and_then(|value| value.as_str())
            })
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("#7a7570")
            .to_string()
    }

    #[allow(dead_code)]
    pub fn source_peer_id(&self) -> Option<String> {
        self.payload
            .get("source_peer_id")
            .and_then(|value| value.as_str())
            .or_else(|| {
                self.payload
                    .get("sourcePeerId")
                    .and_then(|value| value.as_str())
            })
            .filter(|value| !value.trim().is_empty())
            .map(ToString::to_string)
    }
}

fn short_key_label(key: &str) -> String {
    let short: String = key.chars().take(6).collect();
    if short.is_empty() {
        "Peer".into()
    } else {
        format!("Peer {short}")
    }
}

// ─── Typed Payloads ──────────────────────────────────

/// Payload for `type = "message"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagePayload {
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentPayload>,
    #[serde(default)]
    pub author_display_name: String,
    #[serde(default)]
    pub author_avatar_color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_id: Option<String>,
}

/// A file attachment embedded in a message payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentPayload {
    pub file_hash: String,
    pub filename: String,
    pub size: u64,
    pub chunks: u32,
    pub source_peer_id: String,
}

/// Payload for `type = "reaction"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionPayload {
    pub message_id: String,
    pub emoji: String,
    #[serde(default = "default_verb")]
    pub verb: String,
}

fn default_verb() -> String {
    "add".into()
}

/// Payload for `type = "file_announced"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileAnnouncedPayload {
    pub file_hash: String,
    pub file_name: String,
    pub size: u64,
    pub chunks: u32,
    pub source_peer_id: String,
    #[serde(default)]
    pub author_display_name: String,
    #[serde(default)]
    pub author_avatar_color: String,
}

/// Payload for `type = "presence"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresencePayload {
    #[serde(default = "default_status")]
    pub status: String,
}

fn default_status() -> String {
    "online".into()
}

/// Payload for `type = "voice_join"`, `"voice_leave"`, `"voice_heartbeat"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceMembershipPayload {
    #[serde(default)]
    pub epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_peer_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_color: Option<String>,
}

/// Payload for `type = "voice_signal"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceSignalPayload {
    pub target_peer: String,
    pub signal: serde_json::Value,
    #[serde(default)]
    pub epoch: u64,
}

/// Payload for `type = "ban"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct BanPayload {
    pub banned_public_key: String,
}

/// Payload for `type = "community_control"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct CommunityControlPayload {
    pub event_type: String,
    pub data: serde_json::Value,
}

/// Payload for `type = "key_rotation"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct KeyRotationPayload {
    pub epoch: u64,
    /// Per-member wrapped keys: public_key → base64-encoded encrypted group key.
    pub key_wraps: HashMap<String, String>,
}

/// Payload for `type = "history_response"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct HistoryResponsePayload {
    pub channel_id: String,
    pub messages: Vec<MessagePayload>,
}

/// Payload for `type = "message_edit"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEditPayload {
    pub message_id: String,
    pub content: String,
}

/// Payload for `type = "message_delete"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageDeletePayload {
    pub message_id: String,
}

// ─── Envelope Builder ────────────────────────────────

/// Builder for constructing and signing envelopes.
pub struct EnvelopeBuilder {
    msg_type: String,
    author: String,
    community_id: String,
    channel_id: Option<String>,
    signed_by: Option<String>,
    payload: serde_json::Value,
}

impl EnvelopeBuilder {
    pub fn new(msg_type: &str, author: &str, community_id: &str) -> Self {
        Self {
            msg_type: msg_type.to_string(),
            author: author.to_string(),
            community_id: community_id.to_string(),
            channel_id: None,
            signed_by: None,
            payload: serde_json::Value::Null,
        }
    }

    pub fn channel_id(mut self, channel_id: &str) -> Self {
        self.channel_id = Some(channel_id.to_string());
        self
    }

    #[allow(dead_code)]
    pub fn signed_by(mut self, key: &str) -> Self {
        self.signed_by = Some(key.to_string());
        self
    }

    #[allow(dead_code)]
    pub fn payload(mut self, payload: serde_json::Value) -> Self {
        self.payload = payload;
        self
    }

    pub fn payload_typed<T: Serialize>(mut self, payload: &T) -> Self {
        // SAFETY: serde_json::to_value only fails for types that cannot be
        // represented as JSON (e.g., maps with non-string keys). All our
        // payload types are plain structs with #[derive(Serialize)], so
        // this conversion is infallible in practice.
        self.payload =
            serde_json::to_value(payload).expect("envelope payload must be JSON-serializable");
        self
    }

    /// Build the envelope and sign it with the given private key bytes.
    pub fn sign(self, private_key_bytes: &[u8; 32]) -> SignedEnvelope {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
        use ed25519_dalek::{Signer, SigningKey};

        let id = nanoid::nanoid!();
        let timestamp = chrono::Utc::now().to_rfc3339();

        let mut envelope = SignedEnvelope {
            v: 2,
            msg_type: self.msg_type,
            id,
            author: self.author,
            community_id: self.community_id,
            timestamp,
            payload: self.payload,
            signature: String::new(),
            signed_by: self.signed_by,
            channel_id: self.channel_id,
        };

        let signable = envelope.signable_bytes();
        let signing_key = SigningKey::from_bytes(private_key_bytes);
        let signature = signing_key.sign(&signable);
        envelope.signature = BASE64.encode(signature.to_bytes());

        envelope
    }
}

// ─── Legacy v1 Compatibility ─────────────────────────

/// Try to parse a v1-style loose JSON envelope and extract fields
/// needed for routing (community_id, author, type).
/// Used during the transition period while v1 messages may still arrive.
#[allow(dead_code)]
pub fn extract_v1_routing(data: &[u8]) -> Option<V1RoutingInfo> {
    let value: serde_json::Value = serde_json::from_slice(data).ok()?;
    let msg_type = value.get("type")?.as_str()?.to_string();
    let author = value
        .get("author")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let community_id = value
        .get("community_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Some(V1RoutingInfo {
        msg_type,
        author,
        community_id,
        raw: value,
    })
}

/// Routing info extracted from a v1 envelope for backward compatibility.
#[allow(dead_code)]
pub struct V1RoutingInfo {
    pub msg_type: String,
    pub author: String,
    pub community_id: String,
    pub raw: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_roundtrip_and_verify() {
        // Generate a test identity
        // We can't use Identity::generate() in tests easily because it
        // touches the OS keychain, so we manually create a signing key.
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
        use ed25519_dalek::SigningKey;
        use rand::rngs::OsRng;

        let signing_key = SigningKey::generate(&mut OsRng);
        let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());
        let private_bytes = signing_key.to_bytes();

        let payload = MessagePayload {
            content: "Hello, world!".into(),
            attachments: vec![],
            author_display_name: "Test User".into(),
            author_avatar_color: "#ff0000".into(),
            reply_to_id: None,
        };

        let envelope = EnvelopeBuilder::new("message", &public_key, "test-community")
            .channel_id("test-channel")
            .payload_typed(&payload)
            .sign(&private_bytes);

        assert_eq!(envelope.v, 2);
        assert_eq!(envelope.msg_type, "message");
        assert!(envelope.verify().unwrap());

        // Serialize + deserialize roundtrip
        let bytes = serde_json::to_vec(&envelope).unwrap();
        let parsed = SignedEnvelope::from_bytes(&bytes).unwrap();
        assert!(parsed.verify().unwrap());
        assert_eq!(parsed.display_name(), "Test User");
        assert_eq!(parsed.avatar_color(), "#ff0000");
    }

    #[test]
    fn tampered_envelope_fails_verification() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
        use ed25519_dalek::SigningKey;
        use rand::rngs::OsRng;

        let signing_key = SigningKey::generate(&mut OsRng);
        let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());
        let private_bytes = signing_key.to_bytes();

        let mut envelope = EnvelopeBuilder::new("message", &public_key, "test-community")
            .payload(serde_json::json!({"content": "original"}))
            .sign(&private_bytes);

        // Tamper with the payload
        envelope.payload = serde_json::json!({"content": "tampered"});
        assert!(!envelope.verify().unwrap());
    }

    #[test]
    fn owner_signed_envelope_verify() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
        use ed25519_dalek::SigningKey;
        use rand::rngs::OsRng;

        let owner_key = SigningKey::generate(&mut OsRng);
        let owner_public = BASE64.encode(owner_key.verifying_key().as_bytes());
        let user_key = SigningKey::generate(&mut OsRng);
        let user_public = BASE64.encode(user_key.verifying_key().as_bytes());

        let envelope = EnvelopeBuilder::new("ban", &user_public, "test-community")
            .signed_by(&owner_public)
            .payload(serde_json::json!({"banned_public_key": "some-key"}))
            .sign(&owner_key.to_bytes());

        assert!(envelope.verify().unwrap());
    }
}
