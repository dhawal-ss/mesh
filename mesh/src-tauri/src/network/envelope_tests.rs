//! Robustness tests for SignedEnvelope::from_bytes.
//!
//! Ensures malformed, truncated, or adversarial network input never causes
//! panics — only clean None returns or failed verification.

#[cfg(test)]
mod tests {
    use crate::network::envelope::{EnvelopeBuilder, MessagePayload, SignedEnvelope};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    // ─── from_bytes robustness ───────────────────────────

    #[test]
    fn from_bytes_empty_returns_none() {
        assert!(SignedEnvelope::from_bytes(&[]).is_none());
    }

    #[test]
    fn from_bytes_garbage_returns_none() {
        assert!(SignedEnvelope::from_bytes(b"not json at all!!!").is_none());
    }

    #[test]
    fn from_bytes_truncated_json_returns_none() {
        assert!(SignedEnvelope::from_bytes(b"{\"v\":2,\"type\":\"me").is_none());
    }

    #[test]
    fn from_bytes_wrong_version_returns_none() {
        let json = serde_json::json!({
            "v": 1,
            "type": "message",
            "id": "test-id",
            "author": "test-author",
            "community_id": "test-community",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": {},
            "signature": "test-sig"
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        assert!(SignedEnvelope::from_bytes(&bytes).is_none());
    }

    #[test]
    fn from_bytes_missing_required_fields_returns_none() {
        // Missing 'type' field
        let json = serde_json::json!({
            "v": 2,
            "id": "test-id",
            "author": "test-author",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": {},
            "signature": "test-sig"
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        assert!(SignedEnvelope::from_bytes(&bytes).is_none());
    }

    #[test]
    fn from_bytes_null_payload_parses() {
        let json = serde_json::json!({
            "v": 2,
            "type": "message",
            "id": "test-id",
            "author": "test-author",
            "community_id": "test-community",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": null,
            "signature": "test-sig"
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        let envelope = SignedEnvelope::from_bytes(&bytes);
        assert!(envelope.is_some());
    }

    #[test]
    fn from_bytes_random_bytes_never_panics() {
        let mut rng = OsRng;
        for _ in 0..100 {
            let len = (rand::Rng::gen_range(&mut rng, 0..=512_usize)).min(512);
            let mut buf = vec![0u8; len];
            rand::RngCore::fill_bytes(&mut rng, &mut buf);
            // Must not panic, just return None
            let _ = SignedEnvelope::from_bytes(&buf);
        }
    }

    // ─── Signature verification ──────────────────────────

    #[test]
    fn valid_envelope_verifies() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());
        let private_bytes = signing_key.to_bytes();

        let payload = MessagePayload {
            content: "test message".into(),
            attachments: vec![],
            author_display_name: "Tester".into(),
            author_avatar_color: "#ff0000".into(),
            reply_to_id: None,
        };

        let envelope = EnvelopeBuilder::new("message", &public_key, "community-1")
            .channel_id("channel-1")
            .payload_typed(&payload)
            .sign(&private_bytes);

        assert!(envelope.verify().unwrap());
    }

    #[test]
    fn tampered_author_fails_verification() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());

        let mut envelope = EnvelopeBuilder::new("message", &public_key, "community-1")
            .payload(serde_json::json!({"content": "hello"}))
            .sign(&signing_key.to_bytes());

        // Tamper with the author field
        let other_key = SigningKey::generate(&mut OsRng);
        envelope.author = BASE64.encode(other_key.verifying_key().as_bytes());
        assert!(!envelope.verify().unwrap());
    }

    #[test]
    fn tampered_community_id_fails_verification() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());

        let mut envelope = EnvelopeBuilder::new("message", &public_key, "community-1")
            .payload(serde_json::json!({"content": "hello"}))
            .sign(&signing_key.to_bytes());

        envelope.community_id = "community-2".into();
        assert!(!envelope.verify().unwrap());
    }

    #[test]
    fn tampered_timestamp_fails_verification() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());

        let mut envelope = EnvelopeBuilder::new("message", &public_key, "community-1")
            .payload(serde_json::json!({"content": "hello"}))
            .sign(&signing_key.to_bytes());

        envelope.timestamp = "1999-01-01T00:00:00Z".into();
        assert!(!envelope.verify().unwrap());
    }

    #[test]
    fn verify_with_invalid_signature_b64_returns_error() {
        let json = serde_json::json!({
            "v": 2,
            "type": "message",
            "id": "test-id",
            "author": "not-a-real-key",
            "community_id": "test",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": {},
            "signature": "not-valid-base64!!!"
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        let envelope = SignedEnvelope::from_bytes(&bytes).unwrap();
        // Should return Err, not panic
        assert!(envelope.verify().is_err());
    }

    // ─── Display name / avatar fallbacks ─────────────────

    #[test]
    fn display_name_falls_back_to_short_key_label() {
        let json = serde_json::json!({
            "v": 2,
            "type": "message",
            "id": "test-id",
            "author": "ABCDEF123456",
            "community_id": "test",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": {},
            "signature": "sig"
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        let envelope = SignedEnvelope::from_bytes(&bytes).unwrap();
        assert_eq!(envelope.display_name(), "Peer ABCDEF");
    }

    #[test]
    fn avatar_color_falls_back_to_default() {
        let json = serde_json::json!({
            "v": 2,
            "type": "message",
            "id": "test-id",
            "author": "XYZ",
            "community_id": "test",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": {},
            "signature": "sig"
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        let envelope = SignedEnvelope::from_bytes(&bytes).unwrap();
        assert_eq!(envelope.avatar_color(), "#7a7570");
    }

    // ─── Additional from_bytes robustness ─────────────────

    #[test]
    fn from_bytes_random_binary_256_bytes_returns_none() {
        // Pure random binary data that is very unlikely to be valid JSON
        let mut rng = OsRng;
        let mut buf = vec![0u8; 256];
        rand::RngCore::fill_bytes(&mut rng, &mut buf);
        assert!(SignedEnvelope::from_bytes(&buf).is_none());
    }

    #[test]
    fn from_bytes_valid_json_missing_v_field_returns_none() {
        // Valid JSON object but missing `v` — serde will default to 0, which is not v2
        let json = serde_json::json!({
            "type": "message",
            "id": "test-id",
            "author": "test-author",
            "community_id": "test-community",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": {},
            "signature": "test-sig"
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        // `v` is not optional with a default in the struct, so this should fail deserialization
        // or produce v=0 which is not v2 → None
        assert!(SignedEnvelope::from_bytes(&bytes).is_none());
    }

    #[test]
    fn from_bytes_valid_json_missing_signature_returns_none() {
        let json = serde_json::json!({
            "v": 2,
            "type": "message",
            "id": "test-id",
            "author": "test-author",
            "community_id": "test-community",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": {}
            // no "signature" field
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        assert!(SignedEnvelope::from_bytes(&bytes).is_none());
    }

    #[test]
    fn from_bytes_valid_json_missing_id_returns_none() {
        let json = serde_json::json!({
            "v": 2,
            "type": "message",
            "author": "test-author",
            "community_id": "test-community",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": {},
            "signature": "test-sig"
            // no "id" field
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        assert!(SignedEnvelope::from_bytes(&bytes).is_none());
    }

    #[test]
    fn from_bytes_v1_envelope_returns_none() {
        let json = serde_json::json!({
            "v": 1,
            "type": "message",
            "id": "msg-001",
            "author": "author-key",
            "community_id": "community-1",
            "timestamp": "2024-06-15T12:00:00Z",
            "payload": { "content": "Hello from v1" },
            "signature": "some-sig"
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        assert!(
            SignedEnvelope::from_bytes(&bytes).is_none(),
            "v1 envelopes must be rejected by from_bytes"
        );
    }

    #[test]
    fn from_bytes_v0_envelope_returns_none() {
        let json = serde_json::json!({
            "v": 0,
            "type": "message",
            "id": "msg-002",
            "author": "author-key",
            "community_id": "community-1",
            "timestamp": "2024-06-15T12:00:00Z",
            "payload": {},
            "signature": "sig"
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        assert!(SignedEnvelope::from_bytes(&bytes).is_none());
    }

    #[test]
    fn from_bytes_v255_envelope_returns_none() {
        let json = serde_json::json!({
            "v": 255,
            "type": "message",
            "id": "msg-003",
            "author": "author-key",
            "community_id": "community-1",
            "timestamp": "2024-06-15T12:00:00Z",
            "payload": {},
            "signature": "sig"
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        assert!(SignedEnvelope::from_bytes(&bytes).is_none());
    }

    #[test]
    fn from_bytes_large_payload_does_not_panic() {
        // 1MB+ payload inside a valid v2 envelope
        let large_content = "x".repeat(1_100_000);
        let json = serde_json::json!({
            "v": 2,
            "type": "message",
            "id": "msg-large",
            "author": "author-key",
            "community_id": "community-large",
            "timestamp": "2024-06-15T12:00:00Z",
            "payload": { "content": large_content },
            "signature": "sig"
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        // Should parse successfully (it's valid v2 JSON)
        let envelope = SignedEnvelope::from_bytes(&bytes);
        assert!(
            envelope.is_some(),
            "large payload should parse without panic"
        );
        let envelope = envelope.unwrap();
        assert_eq!(envelope.v, 2);
    }

    #[test]
    fn from_bytes_json_array_returns_none() {
        // Valid JSON but not an object
        let bytes = b"[1, 2, 3]";
        assert!(SignedEnvelope::from_bytes(bytes).is_none());
    }

    #[test]
    fn from_bytes_json_string_returns_none() {
        let bytes = b"\"just a string\"";
        assert!(SignedEnvelope::from_bytes(bytes).is_none());
    }

    #[test]
    fn from_bytes_json_number_returns_none() {
        let bytes = b"42";
        assert!(SignedEnvelope::from_bytes(bytes).is_none());
    }

    // ─── Serialization round-trip ────────────────────────

    #[test]
    fn serialize_deserialize_preserves_all_fields() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());

        let envelope = EnvelopeBuilder::new("reaction", &public_key, "community-42")
            .channel_id("channel-7")
            .payload(serde_json::json!({"message_id": "msg-1", "emoji": "🎉"}))
            .sign(&signing_key.to_bytes());

        let bytes = serde_json::to_vec(&envelope).unwrap();
        let parsed = SignedEnvelope::from_bytes(&bytes).unwrap();

        assert_eq!(parsed.v, 2);
        assert_eq!(parsed.msg_type, "reaction");
        assert_eq!(parsed.author, public_key);
        assert_eq!(parsed.community_id, "community-42");
        assert_eq!(parsed.channel_id.as_deref(), Some("channel-7"));
        assert!(parsed.verify().unwrap());
    }
}
