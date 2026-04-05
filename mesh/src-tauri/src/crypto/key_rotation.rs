use std::collections::{BTreeMap, HashMap};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use x25519_dalek::StaticSecret;

use crate::crypto::community_key::CommunityKey;
use crate::crypto::encryption;
use crate::crypto::identity::verify_signature;
use crate::storage::db::MemberRow;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyRotationEvent {
    pub community_id: String,
    pub epoch: u64,
    pub new_key_wraps: HashMap<String, Vec<u8>>,
    pub signed_by: String,
    pub signature: String,
    pub timestamp: String,
}

impl KeyRotationEvent {
    pub fn to_control_payload(&self) -> serde_json::Value {
        let key_wraps = self
            .new_key_wraps
            .iter()
            .map(|(public_key, wrapped)| {
                (
                    public_key.clone(),
                    serde_json::Value::String(BASE64.encode(wrapped)),
                )
            })
            .collect::<serde_json::Map<String, serde_json::Value>>();

        serde_json::json!({
            "epoch": self.epoch,
            "keyWraps": key_wraps,
        })
    }

    pub fn from_control_payload(
        community_id: impl Into<String>,
        signed_by: impl Into<String>,
        signature: impl Into<String>,
        timestamp: impl Into<String>,
        payload: &serde_json::Value,
    ) -> anyhow::Result<Self> {
        let epoch = payload
            .get("epoch")
            .and_then(|value| value.as_u64())
            .ok_or_else(|| anyhow::anyhow!("key rotation payload missing epoch"))?;
        let wraps = payload
            .get("keyWraps")
            .or_else(|| payload.get("key_wraps"))
            .and_then(|value| value.as_object())
            .ok_or_else(|| anyhow::anyhow!("key rotation payload missing keyWraps"))?;

        let mut new_key_wraps = HashMap::with_capacity(wraps.len());
        for (public_key, wrapped) in wraps {
            let wrapped = wrapped
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("key wrap for {public_key} is not a string"))?;
            new_key_wraps.insert(public_key.clone(), BASE64.decode(wrapped)?);
        }

        Ok(Self {
            community_id: community_id.into(),
            epoch,
            new_key_wraps,
            signed_by: signed_by.into(),
            signature: signature.into(),
            timestamp: timestamp.into(),
        })
    }
}

pub fn generate_rotation(
    community_key: &CommunityKey,
    members: &[MemberRow],
    new_group_key: &[u8; 32],
) -> anyhow::Result<KeyRotationEvent> {
    let signed_by = BASE64.encode(community_key.verifying_key.as_bytes());
    let epoch = chrono::Utc::now().timestamp_millis() as u64;
    let timestamp = chrono::Utc::now().to_rfc3339();
    let mut new_key_wraps = HashMap::new();

    for member in members.iter().filter(|member| {
        member.join_status == "joined"
            && member.ban_status == "none"
            && member.x25519_public_key.is_some()
    }) {
        let recipient_key = decode_x25519_public(
            member
                .x25519_public_key
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("missing x25519 key"))?,
        )?;
        let wrapped = encryption::encrypt_key_wrap(
            &recipient_key,
            new_group_key,
            &community_key.community_id,
        );
        new_key_wraps.insert(member.public_key.clone(), wrapped);
    }

    let mut event = KeyRotationEvent {
        community_id: community_key.community_id.clone(),
        epoch,
        new_key_wraps,
        signed_by,
        signature: String::new(),
        timestamp,
    };
    event.signature = community_key.sign(&signable_bytes(&event));

    Ok(event)
}

#[allow(dead_code)]
pub fn verify_rotation(event: &KeyRotationEvent, owner_public_key: &str) -> bool {
    if event.signed_by != owner_public_key {
        return false;
    }

    verify_signature(owner_public_key, &signable_bytes(event), &event.signature).unwrap_or(false)
}

pub fn unwrap_for_self(
    event: &KeyRotationEvent,
    our_public_key: &str,
    our_x25519_secret: &StaticSecret,
) -> anyhow::Result<[u8; 32]> {
    let wrapped = event
        .new_key_wraps
        .get(our_public_key)
        .ok_or_else(|| anyhow::anyhow!("no wrapped group key for recipient"))?;
    encryption::decrypt_key_wrap(our_x25519_secret, wrapped, &event.community_id)
}

/// Validate that a new key rotation epoch is strictly greater than the
/// currently stored epoch. Rejects replayed or stale rotation events.
///
/// Returns `Ok(())` if the new epoch is valid, or `Err` with a descriptive
/// message if it is not.
pub fn validate_epoch_monotonicity(new_epoch: u64, stored_epoch: u64) -> Result<(), String> {
    if new_epoch <= stored_epoch {
        return Err(format!(
            "Stale key rotation epoch {} <= current epoch {}",
            new_epoch, stored_epoch,
        ));
    }
    Ok(())
}

pub fn decode_x25519_public(b64: &str) -> anyhow::Result<x25519_dalek::PublicKey> {
    let bytes: [u8; 32] = BASE64
        .decode(b64)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid x25519 key length"))?;
    Ok(x25519_dalek::PublicKey::from(bytes))
}

fn signable_bytes(event: &KeyRotationEvent) -> Vec<u8> {
    let wraps = event
        .new_key_wraps
        .iter()
        .map(|(public_key, wrapped)| (public_key.clone(), BASE64.encode(wrapped)))
        .collect::<BTreeMap<String, String>>();

    serde_json::json!({
        "community_id": event.community_id,
        "epoch": event.epoch,
        "new_key_wraps": wraps,
        "signed_by": event.signed_by,
        "timestamp": event.timestamp,
    })
    .to_string()
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    use super::*;
    use crate::crypto::community_key::CommunityKey;
    use crate::crypto::identity::Identity;

    fn identity() -> Identity {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        Identity {
            signing_key,
            verifying_key,
            public_key_b64: BASE64.encode(verifying_key.as_bytes()),
        }
    }

    fn member_from_identity(identity: &Identity, role: &str) -> MemberRow {
        MemberRow {
            public_key: identity.public_key_b64.clone(),
            display_name: "member".into(),
            avatar_color: "#c8b89a".into(),
            role: role.into(),
            join_status: "joined".into(),
            ban_status: "none".into(),
            x25519_public_key: Some(BASE64.encode(identity.x25519_public_key().as_bytes())),
            last_seen: None,
        }
    }

    #[test]
    fn generated_rotation_verifies_and_unwraps() {
        let community_key = CommunityKey::generate();
        let owner = identity();
        let member = identity();
        let members = vec![
            member_from_identity(&owner, "owner"),
            member_from_identity(&member, "member"),
        ];
        let group_key = encryption::generate_group_key();

        let event = generate_rotation(&community_key, &members, &group_key).unwrap();
        let owner_public_key = BASE64.encode(community_key.verifying_key.as_bytes());

        assert!(verify_rotation(&event, &owner_public_key));
        assert_eq!(
            unwrap_for_self(&event, &member.public_key_b64, &member.x25519_static_secret())
                .unwrap(),
            group_key
        );
    }

    // ─── Epoch Monotonicity ─────────────────────────────

    #[test]
    fn epoch_monotonicity_accepts_strictly_greater() {
        assert!(validate_epoch_monotonicity(10, 5).is_ok());
        assert!(validate_epoch_monotonicity(2, 1).is_ok());
        assert!(validate_epoch_monotonicity(u64::MAX, u64::MAX - 1).is_ok());
    }

    #[test]
    fn epoch_monotonicity_rejects_equal() {
        let result = validate_epoch_monotonicity(5, 5);
        assert!(result.is_err(), "Equal epoch must be rejected");
        assert!(result.unwrap_err().contains("Stale key rotation epoch"));
    }

    #[test]
    fn epoch_monotonicity_rejects_lesser() {
        let result = validate_epoch_monotonicity(3, 10);
        assert!(result.is_err(), "Lesser epoch must be rejected");
    }

    #[test]
    fn epoch_monotonicity_rejects_zero_replay() {
        let result = validate_epoch_monotonicity(0, 0);
        assert!(result.is_err(), "Epoch 0 replayed against stored 0 must be rejected");
    }

    #[test]
    fn control_payload_roundtrip_preserves_wraps() {
        let community_key = CommunityKey::generate();
        let member = identity();
        let members = vec![member_from_identity(&member, "member")];
        let group_key = encryption::generate_group_key();
        let event = generate_rotation(&community_key, &members, &group_key).unwrap();

        let payload = event.to_control_payload();
        let roundtrip = KeyRotationEvent::from_control_payload(
            event.community_id.clone(),
            event.signed_by.clone(),
            event.signature.clone(),
            event.timestamp.clone(),
            &payload,
        )
        .unwrap();

        assert_eq!(roundtrip.epoch, event.epoch);
        assert_eq!(
            unwrap_for_self(
                &roundtrip,
                &member.public_key_b64,
                &member.x25519_static_secret()
            )
            .unwrap(),
            group_key
        );
    }
}
