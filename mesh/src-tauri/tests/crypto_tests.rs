//! Integration tests for the Mesh crypto layer.
//!
//! These tests exercise the public API of the crypto and network::envelope
//! modules, covering identity generation, symmetric encryption, HKDF domain
//! separation, envelope signing/verification, and key wrap/unwrap.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;

use mesh_lib::crypto::encryption;
use mesh_lib::crypto::identity;
use mesh_lib::network::envelope::{EnvelopeBuilder, MessagePayload, SignedEnvelope};

// ─── Ed25519 identity & key derivation ──────────────────

#[test]
fn ed25519_keypair_produces_valid_public_key() {
    // Generate a raw signing key (bypassing the OS keychain that Identity::generate uses)
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let public_key_b64 = BASE64.encode(verifying_key.as_bytes());

    // The public key should be 32 bytes, base64-encoded
    let decoded = BASE64.decode(&public_key_b64).expect("valid base64");
    assert_eq!(decoded.len(), 32);
}

#[test]
fn ed25519_to_x25519_conversion_produces_distinct_key() {
    let signing_key = SigningKey::generate(&mut OsRng);
    let public_key_b64 = BASE64.encode(signing_key.verifying_key().as_bytes());

    let x25519_pub = identity::ed25519_pub_to_x25519(&public_key_b64)
        .expect("conversion should succeed");

    // The X25519 public key should differ from the raw Ed25519 bytes
    // (Montgomery form != Edwards form)
    assert_ne!(x25519_pub.as_bytes(), signing_key.verifying_key().as_bytes());
}

#[test]
fn x25519_dh_shared_secret_is_symmetric() {
    let alice_signing = SigningKey::generate(&mut OsRng);
    let bob_signing = SigningKey::generate(&mut OsRng);

    let alice_pub_b64 = BASE64.encode(alice_signing.verifying_key().as_bytes());
    let bob_pub_b64 = BASE64.encode(bob_signing.verifying_key().as_bytes());

    // Derive X25519 secrets via the same path Identity uses
    let alice_x_secret = {
        use sha2::{Digest, Sha512};
        let hash = Sha512::digest(alice_signing.as_bytes());
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&hash[..32]);
        bytes[0] &= 248;
        bytes[31] &= 127;
        bytes[31] |= 64;
        x25519_dalek::StaticSecret::from(bytes)
    };

    let bob_x_secret = {
        use sha2::{Digest, Sha512};
        let hash = Sha512::digest(bob_signing.as_bytes());
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&hash[..32]);
        bytes[0] &= 248;
        bytes[31] &= 127;
        bytes[31] |= 64;
        x25519_dalek::StaticSecret::from(bytes)
    };

    let alice_x_pub = identity::ed25519_pub_to_x25519(&alice_pub_b64).unwrap();
    let bob_x_pub = identity::ed25519_pub_to_x25519(&bob_pub_b64).unwrap();

    let shared_ab = encryption::derive_shared_secret(&alice_x_secret, &bob_x_pub);
    let shared_ba = encryption::derive_shared_secret(&bob_x_secret, &alice_x_pub);

    assert_eq!(shared_ab, shared_ba);
}

// ─── ChaCha20-Poly1305 community encryption ─────────────

#[test]
fn community_encrypt_decrypt_roundtrip() {
    let key = encryption::generate_group_key();
    let plaintext = b"Hello, Mesh!";
    let aad = encryption::build_community_aad("test-community", "general");

    let ciphertext = encryption::encrypt_community_payload(&key, plaintext, &aad)
        .expect("encryption should succeed");

    // Ciphertext should be longer than plaintext (nonce + auth tag)
    assert!(ciphertext.len() > plaintext.len());

    let decrypted = encryption::decrypt_community_payload(&key, &ciphertext, &aad)
        .expect("decryption should succeed");

    assert_eq!(decrypted, plaintext);
}

#[test]
fn community_decrypt_with_wrong_key_fails() {
    let key1 = encryption::generate_group_key();
    let key2 = encryption::generate_group_key();
    let plaintext = b"secret data";
    let aad = encryption::build_community_aad("test-community", "");

    let ciphertext = encryption::encrypt_community_payload(&key1, plaintext, &aad)
        .expect("encryption should succeed");

    let result = encryption::decrypt_community_payload(&key2, &ciphertext, &aad);
    assert!(result.is_err());
}

#[test]
fn community_decrypt_rejects_truncated_ciphertext() {
    let key = encryption::generate_group_key();
    let short_data = [0u8; 5]; // Too short to contain a nonce
    let aad = encryption::build_community_aad("test-community", "");

    let result = encryption::decrypt_community_payload(&key, &short_data, &aad);
    assert!(result.is_err());
}

#[test]
fn community_aad_mismatch_rejects_cross_channel_replay() {
    let key = encryption::generate_group_key();
    let plaintext = b"secret message";
    let aad_a = encryption::build_community_aad("community", "channel-a");
    let aad_b = encryption::build_community_aad("community", "channel-b");

    let ciphertext = encryption::encrypt_community_payload(&key, plaintext, &aad_a)
        .expect("encryption should succeed");

    // Decrypting with the wrong channel AAD must fail
    let result = encryption::decrypt_community_payload(&key, &ciphertext, &aad_b);
    assert!(result.is_err(), "Cross-channel AAD replay must be rejected");

    // Decrypting with the correct AAD must succeed
    let decrypted = encryption::decrypt_community_payload(&key, &ciphertext, &aad_a)
        .expect("correct AAD should succeed");
    assert_eq!(decrypted, plaintext);
}

// ─── HKDF domain separation ─────────────────────────────

#[test]
fn hkdf_produces_different_keys_for_different_community_ids() {
    let group_key = encryption::generate_group_key();

    let bob_signing = SigningKey::generate(&mut OsRng);

    let bob_pub_b64 = BASE64.encode(bob_signing.verifying_key().as_bytes());

    let bob_x_pub = identity::ed25519_pub_to_x25519(&bob_pub_b64).unwrap();

    // Wrap the same group key for the same recipient but different communities
    let wrapped_a = encryption::encrypt_key_wrap(&bob_x_pub, &group_key, "community-alpha");
    let wrapped_b = encryption::encrypt_key_wrap(&bob_x_pub, &group_key, "community-beta");

    // The wrapped outputs should differ because of domain separation
    // (also because of ephemeral keys, but the point is the domain is baked in)
    assert_ne!(wrapped_a, wrapped_b);
}

// ─── Envelope signing & verification ─────────────────────

#[test]
fn envelope_sign_and_verify_roundtrip() {
    let signing_key = SigningKey::generate(&mut OsRng);
    let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());
    let private_bytes = signing_key.to_bytes();

    let payload = MessagePayload {
        content: "integration test message".into(),
        attachments: vec![],
        author_display_name: "Test User".into(),
        author_avatar_color: "#00ff00".into(),
        reply_to_id: None,
    };

    let envelope = EnvelopeBuilder::new("message", &public_key, "test-community")
        .channel_id("general")
        .payload_typed(&payload)
        .sign(&private_bytes);

    assert_eq!(envelope.v, 2);
    assert_eq!(envelope.msg_type, "message");
    assert_eq!(envelope.author, public_key);
    assert_eq!(envelope.community_id, "test-community");
    assert_eq!(envelope.channel_id.as_deref(), Some("general"));
    assert!(envelope.verify().expect("verify should not error"));
}

#[test]
fn envelope_serialize_deserialize_preserves_signature() {
    let signing_key = SigningKey::generate(&mut OsRng);
    let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());
    let private_bytes = signing_key.to_bytes();

    let envelope = EnvelopeBuilder::new("message", &public_key, "comm-1")
        .payload(serde_json::json!({"content": "roundtrip"}))
        .sign(&private_bytes);

    let bytes = serde_json::to_vec(&envelope).expect("serialize");
    let parsed = SignedEnvelope::from_bytes(&bytes).expect("deserialize");

    assert!(parsed.verify().expect("verify should not error"));
    assert_eq!(parsed.id, envelope.id);
}

#[test]
fn envelope_verification_rejects_tampered_payload() {
    let signing_key = SigningKey::generate(&mut OsRng);
    let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());
    let private_bytes = signing_key.to_bytes();

    let mut envelope = EnvelopeBuilder::new("message", &public_key, "comm-1")
        .payload(serde_json::json!({"content": "original"}))
        .sign(&private_bytes);

    // Tamper with the payload after signing
    envelope.payload = serde_json::json!({"content": "tampered"});

    assert!(!envelope.verify().expect("verify should not error"));
}

#[test]
fn envelope_verification_rejects_wrong_signer() {
    let real_key = SigningKey::generate(&mut OsRng);
    let fake_key = SigningKey::generate(&mut OsRng);
    let real_pub = BASE64.encode(real_key.verifying_key().as_bytes());
    let fake_pub = BASE64.encode(fake_key.verifying_key().as_bytes());

    // Sign with real key but claim authorship from fake key
    let mut envelope = EnvelopeBuilder::new("message", &real_pub, "comm-1")
        .payload(serde_json::json!({"content": "impersonation"}))
        .sign(&real_key.to_bytes());

    // Replace the author field with a different key
    envelope.author = fake_pub;

    // Verification should fail: the signature was made by real_key,
    // but the envelope now claims fake_key as author
    assert!(!envelope.verify().expect("verify should not error"));
}

// ─── Key wrap / unwrap ───────────────────────────────────

#[test]
fn key_wrap_unwrap_roundtrip() {
    let bob_signing = SigningKey::generate(&mut OsRng);

    let bob_pub_b64 = BASE64.encode(bob_signing.verifying_key().as_bytes());
    let bob_x_pub = identity::ed25519_pub_to_x25519(&bob_pub_b64).unwrap();

    // Derive Bob's X25519 secret the same way Identity does
    let bob_x_secret = {
        use sha2::{Digest, Sha512};
        let hash = Sha512::digest(bob_signing.as_bytes());
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&hash[..32]);
        bytes[0] &= 248;
        bytes[31] &= 127;
        bytes[31] |= 64;
        x25519_dalek::StaticSecret::from(bytes)
    };

    let group_key = encryption::generate_group_key();
    let community_id = "test-community-123";

    let wrapped = encryption::encrypt_key_wrap(&bob_x_pub, &group_key, community_id);

    let unwrapped = encryption::decrypt_key_wrap(&bob_x_secret, &wrapped, community_id)
        .expect("unwrap should succeed");

    assert_eq!(unwrapped, group_key);
}

#[test]
fn key_wrap_unwrap_fails_with_wrong_community_id() {
    let bob_signing = SigningKey::generate(&mut OsRng);
    let bob_pub_b64 = BASE64.encode(bob_signing.verifying_key().as_bytes());
    let bob_x_pub = identity::ed25519_pub_to_x25519(&bob_pub_b64).unwrap();

    let bob_x_secret = {
        use sha2::{Digest, Sha512};
        let hash = Sha512::digest(bob_signing.as_bytes());
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&hash[..32]);
        bytes[0] &= 248;
        bytes[31] &= 127;
        bytes[31] |= 64;
        x25519_dalek::StaticSecret::from(bytes)
    };

    let group_key = encryption::generate_group_key();

    let wrapped = encryption::encrypt_key_wrap(&bob_x_pub, &group_key, "community-alpha");

    // Try to unwrap with a different community ID — should fail
    let result = encryption::decrypt_key_wrap(&bob_x_secret, &wrapped, "community-beta");
    assert!(result.is_err());
}

// ─── Group key base64 encode/decode ──────────────────────

#[test]
fn group_key_b64_roundtrip() {
    let key = encryption::generate_group_key();
    let encoded = encryption::group_key_to_b64(&key);
    let decoded = encryption::group_key_from_b64(&encoded).expect("decode should succeed");
    assert_eq!(decoded, key);
}
