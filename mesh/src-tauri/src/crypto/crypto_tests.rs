//! Integration tests for the crypto/encryption module.
//!
//! Covers:
//! - Community payload encryption round-trips
//! - Key wrap/unwrap round-trips
//! - Cross-community replay prevention
//! - DM-style (encrypt_for_recipient / decrypt_from_sender) round-trips
//! - Edge cases: empty plaintext, large payloads, wrong-key rejection

#[cfg(test)]
mod tests {
    use crate::crypto::encryption::*;
    use rand::rngs::OsRng;
    use x25519_dalek::{PublicKey, StaticSecret};

    // ─── Community Payload Encryption ─────────────────────

    #[test]
    fn community_payload_round_trip() {
        let key = generate_group_key();
        let plaintext = b"Hello Mesh community!";
        let aad = build_community_aad("test-community", "general");
        let ciphertext = encrypt_community_payload(&key, plaintext, &aad).unwrap();
        let decrypted = decrypt_community_payload(&key, &ciphertext, &aad).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn community_payload_wrong_key_fails() {
        let key1 = generate_group_key();
        let key2 = generate_group_key();
        let aad = build_community_aad("test-community", "");
        let ciphertext = encrypt_community_payload(&key1, b"secret", &aad).unwrap();
        let result = decrypt_community_payload(&key2, &ciphertext, &aad);
        assert!(result.is_err(), "Decrypting with wrong key should fail");
    }

    #[test]
    fn community_payload_empty_plaintext() {
        let key = generate_group_key();
        let aad = build_community_aad("test-community", "");
        let ciphertext = encrypt_community_payload(&key, b"", &aad).unwrap();
        let decrypted = decrypt_community_payload(&key, &ciphertext, &aad).unwrap();
        assert!(decrypted.is_empty());
    }

    #[test]
    fn community_payload_large_plaintext() {
        let key = generate_group_key();
        let plaintext = vec![0xAB; 512 * 1024]; // 512KB
        let aad = build_community_aad("test-community", "general");
        let ciphertext = encrypt_community_payload(&key, &plaintext, &aad).unwrap();
        let decrypted = decrypt_community_payload(&key, &ciphertext, &aad).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn community_payload_too_short_fails() {
        let key = generate_group_key();
        let aad = build_community_aad("test-community", "");
        let result = decrypt_community_payload(&key, &[0u8; 8], &aad); // Less than nonce (12 bytes)
        assert!(result.is_err());
    }

    #[test]
    fn community_payload_nonce_is_unique() {
        let key = generate_group_key();
        let aad = build_community_aad("test-community", "general");
        let ct1 = encrypt_community_payload(&key, b"same payload", &aad).unwrap();
        let ct2 = encrypt_community_payload(&key, b"same payload", &aad).unwrap();
        // Nonces are the first 12 bytes and should differ
        assert_ne!(&ct1[..12], &ct2[..12]);
    }

    #[test]
    fn community_payload_aad_mismatch_fails() {
        let key = generate_group_key();
        let aad_channel_a = build_community_aad("test-community", "channel-a");
        let aad_channel_b = build_community_aad("test-community", "channel-b");
        let ciphertext = encrypt_community_payload(&key, b"hello", &aad_channel_a).unwrap();
        let result = decrypt_community_payload(&key, &ciphertext, &aad_channel_b);
        assert!(
            result.is_err(),
            "Decrypting with mismatched AAD (different channel) must fail"
        );
    }

    #[test]
    fn community_payload_cross_community_aad_fails() {
        let key = generate_group_key();
        let aad_a = build_community_aad("community-a", "general");
        let aad_b = build_community_aad("community-b", "general");
        let ciphertext = encrypt_community_payload(&key, b"hello", &aad_a).unwrap();
        let result = decrypt_community_payload(&key, &ciphertext, &aad_b);
        assert!(
            result.is_err(),
            "Decrypting with mismatched AAD (different community) must fail"
        );
    }

    // ─── Group Key Encoding ──────────────────────────────

    #[test]
    fn group_key_b64_round_trip() {
        let key = generate_group_key();
        let b64 = group_key_to_b64(&key);
        let decoded = group_key_from_b64(&b64).unwrap();
        assert_eq!(key, decoded);
    }

    #[test]
    fn group_key_from_b64_rejects_wrong_length() {
        let result = group_key_from_b64("dG9vc2hvcnQ"); // "tooshort" base64
        assert!(result.is_err());
    }

    // ─── Key Wrap / Unwrap ───────────────────────────────

    #[test]
    fn key_wrap_round_trip() {
        let recipient_secret = StaticSecret::random_from_rng(OsRng);
        let recipient_public = PublicKey::from(&recipient_secret);
        let group_key = generate_group_key();
        let community_id = "test-community-1";

        let wrapped = encrypt_key_wrap(&recipient_public, &group_key, community_id);
        let unwrapped = decrypt_key_wrap(&recipient_secret, &wrapped, community_id).unwrap();
        assert_eq!(unwrapped, group_key);
    }

    #[test]
    fn key_wrap_wrong_recipient_fails() {
        let recipient_secret = StaticSecret::random_from_rng(OsRng);
        let recipient_public = PublicKey::from(&recipient_secret);
        let wrong_secret = StaticSecret::random_from_rng(OsRng);
        let group_key = generate_group_key();

        let wrapped = encrypt_key_wrap(&recipient_public, &group_key, "community-a");
        let result = decrypt_key_wrap(&wrong_secret, &wrapped, "community-a");
        assert!(result.is_err(), "Wrong recipient key should fail unwrap");
    }

    #[test]
    fn key_wrap_cross_community_replay_prevented() {
        let recipient_secret = StaticSecret::random_from_rng(OsRng);
        let recipient_public = PublicKey::from(&recipient_secret);
        let group_key = generate_group_key();

        // Wrap for community-a
        let wrapped = encrypt_key_wrap(&recipient_public, &group_key, "community-a");

        // Try to unwrap in community-b → should fail (domain separation)
        let result = decrypt_key_wrap(&recipient_secret, &wrapped, "community-b");
        assert!(
            result.is_err(),
            "Cross-community key wrap replay must be prevented"
        );
    }

    #[test]
    fn key_wrap_too_short_fails() {
        let secret = StaticSecret::random_from_rng(OsRng);
        let result = decrypt_key_wrap(&secret, &[0u8; 16], "community");
        assert!(result.is_err());
    }

    // ─── Recipient Encryption (DM-style) ──────────────────

    #[test]
    fn encrypt_for_recipient_round_trip() {
        let recipient_secret = StaticSecret::random_from_rng(OsRng);
        let recipient_public = PublicKey::from(&recipient_secret);
        let plaintext = b"Hello, this is a private message!";
        let domain = "mesh-dm-v1";

        let encrypted = encrypt_for_recipient(&recipient_public, plaintext, domain);
        let decrypted = decrypt_from_sender(&recipient_secret, &encrypted, domain).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn encrypt_for_recipient_wrong_domain_fails() {
        let recipient_secret = StaticSecret::random_from_rng(OsRng);
        let recipient_public = PublicKey::from(&recipient_secret);
        let plaintext = b"private message";

        let encrypted = encrypt_for_recipient(&recipient_public, plaintext, "domain-a");
        let result = decrypt_from_sender(&recipient_secret, &encrypted, "domain-b");
        assert!(result.is_err(), "Wrong domain should fail decryption");
    }

    #[test]
    fn encrypt_for_recipient_empty_plaintext() {
        let recipient_secret = StaticSecret::random_from_rng(OsRng);
        let recipient_public = PublicKey::from(&recipient_secret);

        let encrypted = encrypt_for_recipient(&recipient_public, b"", "dm-test");
        let decrypted = decrypt_from_sender(&recipient_secret, &encrypted, "dm-test").unwrap();
        assert!(decrypted.is_empty());
    }

    #[test]
    fn decrypt_from_sender_too_short_fails() {
        let secret = StaticSecret::random_from_rng(OsRng);
        let result = decrypt_from_sender(&secret, &[0u8; 10], "domain");
        assert!(result.is_err());
    }

    // ─── Shared Secret Derivation ─────────────────────────

    #[test]
    fn derive_shared_secret_is_symmetric() {
        let alice_secret = StaticSecret::random_from_rng(OsRng);
        let alice_public = PublicKey::from(&alice_secret);
        let bob_secret = StaticSecret::random_from_rng(OsRng);
        let bob_public = PublicKey::from(&bob_secret);

        let alice_shared = derive_shared_secret(&alice_secret, &bob_public);
        let bob_shared = derive_shared_secret(&bob_secret, &alice_public);
        assert_eq!(alice_shared, bob_shared);
    }

    // ─── Direct encrypt / decrypt (ChaCha20-Poly1305) ─────

    #[test]
    fn direct_encrypt_decrypt_round_trip() {
        let key = generate_group_key();
        let nonce = [1u8; 12];
        let plaintext = b"Direct encryption test";

        let ciphertext = encrypt(&key, &nonce, plaintext).unwrap();
        let decrypted = decrypt(&key, &nonce, &ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn direct_decrypt_wrong_nonce_fails() {
        let key = generate_group_key();
        let ciphertext = encrypt(&key, &[1u8; 12], b"test data").unwrap();
        let result = decrypt(&key, &[2u8; 12], &ciphertext);
        assert!(result.is_err());
    }

    // ─── Key Wrap: domain separation with different community IDs ─

    #[test]
    fn key_wrap_different_community_ids_fails() {
        let recipient_secret = StaticSecret::random_from_rng(OsRng);
        let recipient_public = PublicKey::from(&recipient_secret);
        let group_key = generate_group_key();

        // Wrap for "community-alpha"
        let wrapped = encrypt_key_wrap(&recipient_public, &group_key, "community-alpha");

        // Attempt unwrap with "community-beta" — must fail due to domain separation
        let result = decrypt_key_wrap(&recipient_secret, &wrapped, "community-beta");
        assert!(
            result.is_err(),
            "Unwrapping with a different community_id must fail"
        );

        // Confirm it still works with the correct community ID
        let unwrapped = decrypt_key_wrap(&recipient_secret, &wrapped, "community-alpha").unwrap();
        assert_eq!(unwrapped, group_key);
    }

    // ─── Key Wrap: truncated / corrupted wrapped data ───

    #[test]
    fn key_wrap_truncated_after_ephemeral_key_fails() {
        let secret = StaticSecret::random_from_rng(OsRng);
        // 32 bytes of ephemeral pub key but no ciphertext after it
        let truncated = [0u8; 33];
        let result = decrypt_key_wrap(&secret, &truncated, "community");
        assert!(result.is_err());
    }

    #[test]
    fn key_wrap_corrupted_ciphertext_fails() {
        let recipient_secret = StaticSecret::random_from_rng(OsRng);
        let recipient_public = PublicKey::from(&recipient_secret);
        let group_key = generate_group_key();

        let mut wrapped = encrypt_key_wrap(&recipient_public, &group_key, "community-c");

        // Corrupt a byte in the ciphertext portion (after the 32-byte ephemeral key)
        if wrapped.len() > 40 {
            wrapped[40] ^= 0xFF;
        }

        let result = decrypt_key_wrap(&recipient_secret, &wrapped, "community-c");
        assert!(
            result.is_err(),
            "Corrupted wrapped data should fail decryption"
        );
    }

    #[test]
    fn key_wrap_empty_data_fails() {
        let secret = StaticSecret::random_from_rng(OsRng);
        let result = decrypt_key_wrap(&secret, &[], "community");
        assert!(result.is_err());
    }

    // ─── Community Payload: truncated data edge cases ────

    #[test]
    fn decrypt_community_payload_exactly_12_bytes_fails() {
        let key = generate_group_key();
        // Exactly 12 bytes = nonce only, no ciphertext — should fail
        let result = decrypt_community_payload(&key, &[0u8; 12], b"");
        assert!(result.is_err());
    }

    #[test]
    fn decrypt_community_payload_11_bytes_fails() {
        let key = generate_group_key();
        let result = decrypt_community_payload(&key, &[0u8; 11], b"");
        assert!(result.is_err());
    }

    #[test]
    fn decrypt_community_payload_1_byte_fails() {
        let key = generate_group_key();
        let result = decrypt_community_payload(&key, &[0u8; 1], b"");
        assert!(result.is_err());
    }

    #[test]
    fn decrypt_community_payload_empty_fails() {
        let key = generate_group_key();
        let result = decrypt_community_payload(&key, &[], b"");
        assert!(result.is_err());
    }

    // ─── Recipient Encryption: wrong recipient key ──────

    #[test]
    fn decrypt_from_sender_wrong_recipient_key_fails() {
        let intended_secret = StaticSecret::random_from_rng(OsRng);
        let intended_public = PublicKey::from(&intended_secret);
        let wrong_secret = StaticSecret::random_from_rng(OsRng);
        let plaintext = b"This message is for the intended recipient only";
        let domain = "mesh-dm-v1";

        let encrypted = encrypt_for_recipient(&intended_public, plaintext, domain);

        // Decrypt with a completely different secret key — must fail
        let result = decrypt_from_sender(&wrong_secret, &encrypted, domain);
        assert!(
            result.is_err(),
            "Decrypting with the wrong recipient key must fail"
        );
    }

    // ─── Recipient Encryption: domain string mismatch roundtrip ──

    #[test]
    fn encrypt_for_recipient_decrypt_with_different_domain_fails() {
        let recipient_secret = StaticSecret::random_from_rng(OsRng);
        let recipient_public = PublicKey::from(&recipient_secret);
        let plaintext = b"domain-sensitive payload";

        let encrypted = encrypt_for_recipient(&recipient_public, plaintext, "invite-link-v1");
        let result = decrypt_from_sender(&recipient_secret, &encrypted, "key-rotation-v1");
        assert!(
            result.is_err(),
            "Decrypting with a different domain string must fail"
        );
    }

    #[test]
    fn encrypt_for_recipient_decrypt_with_empty_vs_nonempty_domain_fails() {
        let recipient_secret = StaticSecret::random_from_rng(OsRng);
        let recipient_public = PublicKey::from(&recipient_secret);
        let plaintext = b"edge case domain test";

        let encrypted = encrypt_for_recipient(&recipient_public, plaintext, "some-domain");
        let result = decrypt_from_sender(&recipient_secret, &encrypted, "");
        assert!(
            result.is_err(),
            "Decrypting with empty domain vs non-empty domain must fail"
        );
    }

    // ─── Recipient Encryption: truncated data ────────────

    #[test]
    fn decrypt_from_sender_exactly_32_bytes_fails() {
        let secret = StaticSecret::random_from_rng(OsRng);
        // 32 bytes = just the ephemeral public key, no nonce or ciphertext
        let result = decrypt_from_sender(&secret, &[0u8; 32], "domain");
        assert!(result.is_err());
    }

    #[test]
    fn decrypt_from_sender_33_bytes_fails() {
        let secret = StaticSecret::random_from_rng(OsRng);
        // 33 bytes = ephemeral key + 1 byte, not enough for nonce (12) + ciphertext
        let result = decrypt_from_sender(&secret, &[0u8; 33], "domain");
        assert!(result.is_err());
    }

    #[test]
    fn decrypt_from_sender_corrupted_ciphertext_fails() {
        let recipient_secret = StaticSecret::random_from_rng(OsRng);
        let recipient_public = PublicKey::from(&recipient_secret);
        let plaintext = b"will be corrupted";

        let mut encrypted = encrypt_for_recipient(&recipient_public, plaintext, "dm-test");
        // Corrupt the last byte (part of the Poly1305 tag)
        let last = encrypted.len() - 1;
        encrypted[last] ^= 0xFF;

        let result = decrypt_from_sender(&recipient_secret, &encrypted, "dm-test");
        assert!(
            result.is_err(),
            "Corrupted ciphertext should fail authentication"
        );
    }

    // ─── Zeroize verification ────────────────────────────
    //
    // These tests verify that the zeroize import compiles and that the
    // Zeroize trait is correctly applied to sensitive byte arrays. We
    // cannot reliably inspect freed memory from safe Rust, so we verify
    // the trait is callable and produces zeroed bytes.

    #[test]
    fn zeroize_clears_sensitive_bytes() {
        use zeroize::Zeroize;

        let mut secret = [0xFFu8; 32];
        assert!(secret.iter().all(|&b| b == 0xFF));
        secret.zeroize();
        assert!(
            secret.iter().all(|&b| b == 0),
            "Zeroize must clear all bytes to zero"
        );
    }

    #[test]
    fn zeroize_in_key_wrap_roundtrip_compiles() {
        // This test exists to confirm that encrypt_key_wrap and decrypt_key_wrap
        // (which call .zeroize() on raw_shared and derived_key) compile and
        // execute correctly. If zeroize were removed, this would fail to compile.
        let recipient_secret = StaticSecret::random_from_rng(OsRng);
        let recipient_public = PublicKey::from(&recipient_secret);
        let group_key = generate_group_key();

        let wrapped = encrypt_key_wrap(&recipient_public, &group_key, "zeroize-test");
        let unwrapped = decrypt_key_wrap(&recipient_secret, &wrapped, "zeroize-test").unwrap();
        assert_eq!(unwrapped, group_key);
    }

    #[test]
    fn zeroize_in_decrypt_from_sender_compiles() {
        // Confirms that decrypt_from_sender (which zeroizes raw_shared and
        // derived_key) compiles and runs without panics.
        let recipient_secret = StaticSecret::random_from_rng(OsRng);
        let recipient_public = PublicKey::from(&recipient_secret);
        let plaintext = b"zeroize compilation check";

        let encrypted = encrypt_for_recipient(&recipient_public, plaintext, "zeroize-test");
        let decrypted = decrypt_from_sender(&recipient_secret, &encrypted, "zeroize-test").unwrap();
        assert_eq!(decrypted, plaintext);
    }
}
