//! Integration tests for the crypto/identity module.
//!
//! Covers:
//! - verify_signature with valid, tampered, and wrong-key inputs
//! - ed25519_pub_to_x25519 conversion and ECDH interop
//! - Argon2id-based identity export/import roundtrip (v2 format)

#[cfg(test)]
mod tests {
    use crate::crypto::identity::{ed25519_pub_to_x25519, verify_signature};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;
    use rand::RngCore;
    use sha2::{Digest, Sha512};
    use x25519_dalek::{PublicKey, StaticSecret};

    // ─── verify_signature ────────────────────────────────

    #[test]
    fn verify_signature_with_valid_signature() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let public_key_b64 = BASE64.encode(verifying_key.as_bytes());

        let payload = b"Hello, Mesh identity test!";
        let signature = signing_key.sign(payload);
        let signature_b64 = BASE64.encode(signature.to_bytes());

        let result = verify_signature(&public_key_b64, payload, &signature_b64).unwrap();
        assert!(result, "Valid signature should verify successfully");
    }

    #[test]
    fn verify_signature_with_tampered_payload_returns_false() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let public_key_b64 = BASE64.encode(verifying_key.as_bytes());

        let original_payload = b"original message";
        let signature = signing_key.sign(original_payload.as_slice());
        let signature_b64 = BASE64.encode(signature.to_bytes());

        let tampered_payload = b"tampered message";
        let result =
            verify_signature(&public_key_b64, tampered_payload, &signature_b64).unwrap();
        assert!(
            !result,
            "Signature must not verify with tampered payload"
        );
    }

    #[test]
    fn verify_signature_with_wrong_public_key_returns_false() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let wrong_key = SigningKey::generate(&mut OsRng);
        let wrong_public_b64 = BASE64.encode(wrong_key.verifying_key().as_bytes());

        let payload = b"signed by original key";
        let signature = signing_key.sign(payload.as_slice());
        let signature_b64 = BASE64.encode(signature.to_bytes());

        let result = verify_signature(&wrong_public_b64, payload, &signature_b64).unwrap();
        assert!(
            !result,
            "Signature must not verify with wrong public key"
        );
    }

    #[test]
    fn verify_signature_with_invalid_base64_key_returns_error() {
        let result = verify_signature("not-valid-base64!!!", b"payload", "not-valid-sig!!!");
        assert!(result.is_err(), "Invalid base64 should return an error");
    }

    #[test]
    fn verify_signature_with_wrong_length_key_returns_error() {
        // Valid base64 but wrong length for an Ed25519 key (not 32 bytes)
        let short_key = BASE64.encode(&[0u8; 16]);
        let sig = BASE64.encode(&[0u8; 64]);
        let result = verify_signature(&short_key, b"payload", &sig);
        assert!(
            result.is_err(),
            "Wrong-length key should return an error"
        );
    }

    #[test]
    fn verify_signature_with_empty_payload() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let public_key_b64 = BASE64.encode(signing_key.verifying_key().as_bytes());

        let payload = b"";
        let signature = signing_key.sign(payload.as_slice());
        let signature_b64 = BASE64.encode(signature.to_bytes());

        let result = verify_signature(&public_key_b64, payload, &signature_b64).unwrap();
        assert!(result, "Empty payload should still verify correctly");
    }

    // ─── ed25519_pub_to_x25519 ──────────────────────────

    #[test]
    fn ed25519_pub_to_x25519_produces_valid_key_for_ecdh() {
        // Generate an Ed25519 keypair
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let public_key_b64 = BASE64.encode(verifying_key.as_bytes());

        // Derive the X25519 public key via the module function
        let x25519_pub = ed25519_pub_to_x25519(&public_key_b64).unwrap();

        // Derive the X25519 secret key from the Ed25519 private key
        // (same derivation as Identity::x25519_static_secret)
        let hash = Sha512::digest(signing_key.as_bytes());
        let mut secret_bytes = [0u8; 32];
        secret_bytes.copy_from_slice(&hash[..32]);
        secret_bytes[0] &= 248;
        secret_bytes[31] &= 127;
        secret_bytes[31] |= 64;
        let x25519_secret = StaticSecret::from(secret_bytes);

        // The public key derived from the secret should match
        let x25519_pub_from_secret = PublicKey::from(&x25519_secret);
        assert_eq!(
            x25519_pub.as_bytes(),
            x25519_pub_from_secret.as_bytes(),
            "X25519 public key from ed25519_pub_to_x25519 must match the one derived from the secret"
        );
    }

    #[test]
    fn ed25519_pub_to_x25519_ecdh_roundtrip() {
        // Alice: Ed25519 keypair, derive X25519
        let alice_signing = SigningKey::generate(&mut OsRng);
        let alice_pub_b64 = BASE64.encode(alice_signing.verifying_key().as_bytes());
        let alice_x25519_pub = ed25519_pub_to_x25519(&alice_pub_b64).unwrap();

        let alice_hash = Sha512::digest(alice_signing.as_bytes());
        let mut alice_x_bytes = [0u8; 32];
        alice_x_bytes.copy_from_slice(&alice_hash[..32]);
        alice_x_bytes[0] &= 248;
        alice_x_bytes[31] &= 127;
        alice_x_bytes[31] |= 64;
        let alice_x25519_secret = StaticSecret::from(alice_x_bytes);

        // Bob: ephemeral X25519 keypair
        let bob_secret = StaticSecret::random_from_rng(OsRng);
        let bob_public = PublicKey::from(&bob_secret);

        // ECDH from both sides
        let alice_shared = alice_x25519_secret.diffie_hellman(&bob_public);
        let bob_shared = bob_secret.diffie_hellman(&alice_x25519_pub);

        assert_eq!(
            alice_shared.as_bytes(),
            bob_shared.as_bytes(),
            "ECDH shared secret must match from both sides when using ed25519_pub_to_x25519"
        );
    }

    #[test]
    fn ed25519_pub_to_x25519_with_invalid_key_returns_error() {
        // Wrong length
        let short_key = BASE64.encode(&[0u8; 16]);
        assert!(ed25519_pub_to_x25519(&short_key).is_err());
    }

    #[test]
    fn ed25519_pub_to_x25519_with_invalid_base64_returns_error() {
        assert!(ed25519_pub_to_x25519("not-valid!!!").is_err());
    }

    // ─── Argon2id export/import roundtrip (v2 format) ────
    //
    // These tests exercise the v2 bundle format (Argon2id key derivation)
    // without touching the OS keychain, by manually constructing the same
    // byte layout that Identity::export_bundle / import_bundle use.

    #[test]
    fn argon2id_export_import_roundtrip_v2() {
        use argon2::{Algorithm, Argon2, Params, Version};
        use crate::crypto::encryption;

        let passphrase = "correct horse battery staple";
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();

        // Build the 64-byte plaintext (private + public key)
        let mut plaintext = Vec::with_capacity(64);
        plaintext.extend_from_slice(signing_key.as_bytes());
        plaintext.extend_from_slice(verifying_key.as_bytes());

        // Derive key with Argon2id (same params as identity.rs)
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);

        let params = Params::new(65_536, 3, 4, Some(32)).unwrap();
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut derived_key = [0u8; 32];
        argon2
            .hash_password_into(passphrase.as_bytes(), &salt, &mut derived_key)
            .unwrap();

        // Encrypt with ChaCha20-Poly1305 (same as export_bundle)
        let encrypted =
            encryption::encrypt_community_payload(&derived_key, &plaintext, b"").unwrap();

        // Assemble v2 bundle: [0x02] || salt (16) || nonce (12) || ciphertext
        let mut bundle = Vec::with_capacity(1 + 16 + encrypted.len());
        bundle.push(0x02);
        bundle.extend_from_slice(&salt);
        bundle.extend_from_slice(&encrypted);

        // --- Import side ---
        assert_eq!(bundle[0], 0x02);
        let imported_salt = &bundle[1..17];
        assert_eq!(imported_salt, &salt);

        // Re-derive key from passphrase + salt
        let mut imported_key = [0u8; 32];
        let params2 = Params::new(65_536, 3, 4, Some(32)).unwrap();
        let argon2_import = Argon2::new(Algorithm::Argon2id, Version::V0x13, params2);
        argon2_import
            .hash_password_into(passphrase.as_bytes(), imported_salt, &mut imported_key)
            .unwrap();

        // Decrypt
        let decrypted =
            encryption::decrypt_community_payload(&imported_key, &bundle[17..], b"").unwrap();

        assert_eq!(decrypted.len(), 64);
        assert_eq!(&decrypted[..32], signing_key.as_bytes());
        assert_eq!(&decrypted[32..], verifying_key.as_bytes());
    }

    #[test]
    fn argon2id_wrong_passphrase_fails_import() {
        use argon2::{Algorithm, Argon2, Params, Version};
        use crate::crypto::encryption;

        let passphrase = "real passphrase";
        let wrong_passphrase = "wrong passphrase";
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();

        let mut plaintext = Vec::with_capacity(64);
        plaintext.extend_from_slice(signing_key.as_bytes());
        plaintext.extend_from_slice(verifying_key.as_bytes());

        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);

        let params = Params::new(65_536, 3, 4, Some(32)).unwrap();
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut derived_key = [0u8; 32];
        argon2
            .hash_password_into(passphrase.as_bytes(), &salt, &mut derived_key)
            .unwrap();

        let encrypted =
            encryption::encrypt_community_payload(&derived_key, &plaintext, b"").unwrap();

        let mut bundle = Vec::with_capacity(1 + 16 + encrypted.len());
        bundle.push(0x02);
        bundle.extend_from_slice(&salt);
        bundle.extend_from_slice(&encrypted);

        // Attempt decryption with the wrong passphrase
        let mut wrong_key = [0u8; 32];
        let params2 = Params::new(65_536, 3, 4, Some(32)).unwrap();
        let argon2_wrong = Argon2::new(Algorithm::Argon2id, Version::V0x13, params2);
        argon2_wrong
            .hash_password_into(wrong_passphrase.as_bytes(), &salt, &mut wrong_key)
            .unwrap();

        let result = encryption::decrypt_community_payload(&wrong_key, &bundle[17..], b"");
        assert!(
            result.is_err(),
            "Decryption with the wrong passphrase must fail"
        );
    }

    #[test]
    fn argon2id_v2_bundle_version_byte_is_correct() {
        // Ensure the v2 format starts with 0x02 and has at least
        // 1 (version) + 16 (salt) + 12 (nonce) + 16 (Poly1305 tag) = 45 bytes
        use argon2::{Algorithm, Argon2, Params, Version};
        use crate::crypto::encryption;

        let passphrase = "test";
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);

        let params = Params::new(65_536, 3, 4, Some(32)).unwrap();
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut key = [0u8; 32];
        argon2
            .hash_password_into(passphrase.as_bytes(), &salt, &mut key)
            .unwrap();

        let encrypted = encryption::encrypt_community_payload(&key, &[0u8; 64], b"").unwrap();

        let mut bundle = vec![0x02];
        bundle.extend_from_slice(&salt);
        bundle.extend_from_slice(&encrypted);

        assert_eq!(bundle[0], 0x02, "v2 bundle must start with version byte 0x02");
        assert!(
            bundle.len() >= 1 + 16 + 12 + 16,
            "v2 bundle must be at least 45 bytes (version + salt + nonce + tag)"
        );
    }
}
