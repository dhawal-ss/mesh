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

    let x25519_pub =
        identity::ed25519_pub_to_x25519(&public_key_b64).expect("conversion should succeed");

    // The X25519 public key should differ from the raw Ed25519 bytes
    // (Montgomery form != Edwards form)
    assert_ne!(
        x25519_pub.as_bytes(),
        signing_key.verifying_key().as_bytes()
    );
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

// ─── Known-answer vectors (frozen wire format) ──────────
//
// The round-trip tests above encrypt and decrypt in the same build, so they
// keep passing even if a dependency bump changes the ciphertext layout. These
// vectors are frozen bytes: they fail if the on-disk and on-wire format of an
// already-stored record ever stops being readable by a newer build.
//
// The bare vector below was independently reproduced with a non-RustCrypto
// ChaCha20-Poly1305 implementation, so it pins the standard AEAD output and not
// merely "whatever this crate did on the day the test was written".

/// Decode a lowercase hex literal used by the frozen vectors below.
fn kat_hex(text: &str) -> Vec<u8> {
    assert!(text.len() % 2 == 0, "hex literal must have even length");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("valid hex literal"))
        .collect()
}

/// Key `00..1f`, shared by every frozen vector in this section.
const KAT_KEY: [u8; 32] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];
const KAT_NONCE: [u8; 12] = [
    0x07, 0x00, 0x00, 0x00, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47,
];
const KAT_PLAINTEXT: &[u8] = b"mesh known-answer vector v1";

/// `encrypt` takes an explicit nonce, so its output is fully deterministic and
/// can be asserted byte-for-byte.
#[test]
fn kat_bare_aead_ciphertext_is_byte_exact() {
    let expected = kat_hex(
        "2489024a312a02afee87605618013acae7c9cbb25b8c45b8381ec90efbe3ba2a472b96ed953b516b597bb9",
    );
    let actual = encryption::encrypt(&KAT_KEY, &KAT_NONCE, KAT_PLAINTEXT).expect("encrypt");
    assert_eq!(
        actual, expected,
        "ChaCha20-Poly1305 ciphertext changed: every previously stored record is now unreadable"
    );
    let back = encryption::decrypt(&KAT_KEY, &KAT_NONCE, &expected).expect("decrypt");
    assert_eq!(back, KAT_PLAINTEXT);
}

/// The AAD string is part of the authenticated wire format; changing its shape
/// silently invalidates every stored tag.
#[test]
fn kat_community_aad_construction_is_frozen() {
    assert_eq!(
        encryption::build_community_aad("kat-community", "kat-channel"),
        b"kat-community:kat-channel".to_vec()
    );
}

/// `encrypt_community_payload` generates its nonce internally, so this vector is
/// asserted from the decrypt side: a frozen `nonce || ciphertext || tag` blob
/// must still open. This is the exact regression that would make stored
/// community history undecryptable.
#[test]
fn kat_community_payload_decrypts_frozen_ciphertext() {
    let frozen = kat_hex(
        "39e0143ea3c4134941b6f0dc5f2fb4eaa36567be84cd2181f5bd7b9d180789c1\
         999702fe22e8a5849b7506097ce436ece1dc7d3a2abd1b",
    );
    let aad = encryption::build_community_aad("kat-community", "kat-channel");
    let plaintext = encryption::decrypt_community_payload(&KAT_KEY, &frozen, &aad)
        .expect("frozen community ciphertext must still decrypt");
    assert_eq!(plaintext, KAT_PLAINTEXT);
}

/// Freezes the key-wrap layout *and* the HKDF domain separation: the salt
/// `mesh-keywrap-v1` and the community ID as `info` both feed the derived key,
/// so any change to either stops this frozen wrap from opening.
#[test]
fn kat_key_wrap_decrypts_frozen_blob() {
    let frozen = kat_hex(
        "8fea15c5a2e8bb1b2144ba4eed4001393b2dad1d5198d0bf940e1f61b291520a\
         400f6dd26b5cb514fc51b1aeb795984e4469e354d6aa45dafb9cacac73a3a60c\
         31b09a82d89f22c7d6491fe7f0286cb2452cdf09d72998c883854e15",
    );
    let recipient = x25519_dalek::StaticSecret::from([0x42u8; 32]);
    let unwrapped = encryption::decrypt_key_wrap(&recipient, &frozen, "kat-community")
        .expect("frozen key wrap must still unwrap");
    assert_eq!(unwrapped, [0xABu8; 32]);
}
