use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
/// Community-level group encryption (ChaCha20-Poly1305 with per-community symmetric keys)
/// and future home of Double Ratchet session management for DMs.
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Nonce,
};
use hkdf::Hkdf;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

/// Build the Associated Authenticated Data (AAD) bytes for community
/// encryption.
///
/// Format: `community_id:channel_id` (or `community_id:` when there is no
/// channel context).  Both encrypt and decrypt sides must use the same AAD
/// for the Poly1305 tag to verify.
pub fn build_community_aad(community_id: &str, channel_id: &str) -> Vec<u8> {
    format!("{}:{}", community_id, channel_id).into_bytes()
}

/// Generate a random 32-byte symmetric group key for a community.
pub fn generate_group_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    key
}

/// Encrypt a plaintext payload for community broadcast.
/// Prepends a random 12-byte nonce to the ciphertext.
///
/// `aad` is Associated Authenticated Data that is authenticated by the
/// Poly1305 tag but **not** encrypted.  Pass the community/channel context
/// (e.g. `b"community_id:channel_id"`) so that ciphertext is bound to its
/// intended topic and cannot be replayed on a different channel.
pub fn encrypt_community_payload(
    group_key: &[u8; 32],
    plaintext: &[u8],
    aad: &[u8],
) -> anyhow::Result<Vec<u8>> {
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);

    let cipher = ChaCha20Poly1305::new(group_key.into());
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|e| anyhow::anyhow!("encryption failed: {}", e))?;

    // nonce || ciphertext
    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt a community payload. Expects nonce || ciphertext.
///
/// `aad` must match the Associated Authenticated Data that was supplied
/// during encryption, otherwise the Poly1305 tag verification will fail.
pub fn decrypt_community_payload(
    group_key: &[u8; 32],
    data: &[u8],
    aad: &[u8],
) -> anyhow::Result<Vec<u8>> {
    if data.len() < 12 {
        return Err(anyhow::anyhow!("ciphertext too short"));
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher = ChaCha20Poly1305::new(group_key.into());
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|e| anyhow::anyhow!("decryption failed: {}", e))
}

/// Encode a group key as URL-safe base64.
pub fn group_key_to_b64(key: &[u8; 32]) -> String {
    BASE64.encode(key)
}

/// Decode a group key from URL-safe base64.
pub fn group_key_from_b64(b64: &str) -> anyhow::Result<[u8; 32]> {
    let bytes = BASE64.decode(b64)?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid group key length"))
}

// ─── DM-level ECDH primitives (future Double Ratchet) ──

/// Perform an ECDH key exchange and derive a shared secret.
pub fn derive_shared_secret(our_secret: &StaticSecret, their_public: &PublicKey) -> [u8; 32] {
    let shared = our_secret.diffie_hellman(their_public);
    *shared.as_bytes()
}

/// Derive a domain-separated symmetric key from a raw ECDH shared secret.
///
/// Uses HKDF-SHA256 with a domain tag and the community ID as info material,
/// ensuring that a key wrap produced for one community cannot be replayed in another.
fn derive_keywrap_key(raw_shared_secret: &[u8; 32], community_id: &str) -> [u8; 32] {
    let salt = b"mesh-keywrap-v1";
    let info = community_id.as_bytes();
    let hk = Hkdf::<Sha256>::new(Some(salt), raw_shared_secret);
    let mut okm = [0u8; 32];
    // SAFETY: HKDF-SHA256 max output is 255 * 32 = 8160 bytes; requesting
    // 32 bytes is always within bounds. This expand call is mathematically
    // infallible per RFC 5869.
    hk.expand(info, &mut okm)
        .expect("HKDF-SHA256 expand for 32 bytes is infallible per RFC 5869");
    // Note: caller is responsible for zeroizing okm after use
    okm
}

/// Wrap a 32-byte group key for a recipient using X25519 ECDH.
/// Uses HKDF domain separation with `community_id` so wraps are non-transferable
/// across communities. The output is ephemeral_pub || nonce || ciphertext.
pub fn encrypt_key_wrap(
    recipient_x25519_pub: &PublicKey,
    group_key: &[u8; 32],
    community_id: &str,
) -> Vec<u8> {
    let ephemeral_secret = StaticSecret::random_from_rng(OsRng);
    let ephemeral_public = PublicKey::from(&ephemeral_secret);
    let mut raw_shared = derive_shared_secret(&ephemeral_secret, recipient_x25519_pub);
    let mut derived_key = derive_keywrap_key(&raw_shared, community_id);
    // SAFETY: ChaCha20-Poly1305 encryption with a valid 32-byte key and
    // 12-byte nonce cannot fail — the only error path is an invalid key/nonce
    // size, which is impossible here since both are compile-time fixed.
    // AAD is empty here because HKDF domain separation already binds the
    // ciphertext to the community context.
    let encrypted = encrypt_community_payload(&derived_key, group_key, b"")
        .expect("ChaCha20-Poly1305 encryption with valid key/nonce is infallible");
    derived_key.zeroize();
    raw_shared.zeroize();

    let mut wrapped = Vec::with_capacity(32 + encrypted.len());
    wrapped.extend_from_slice(ephemeral_public.as_bytes());
    wrapped.extend_from_slice(&encrypted);
    wrapped
}

/// Unwrap a per-recipient key wrap produced by `encrypt_key_wrap`.
/// The same `community_id` used during wrapping must be supplied for decryption.
pub fn decrypt_key_wrap(
    our_secret: &StaticSecret,
    wrapped: &[u8],
    community_id: &str,
) -> anyhow::Result<[u8; 32]> {
    if wrapped.len() < 32 {
        return Err(anyhow::anyhow!("wrapped key too short"));
    }

    let ephemeral_public_bytes: [u8; 32] = wrapped[..32]
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid ephemeral public key"))?;
    let ephemeral_public = PublicKey::from(ephemeral_public_bytes);
    let mut raw_shared = derive_shared_secret(our_secret, &ephemeral_public);
    let mut derived_key = derive_keywrap_key(&raw_shared, community_id);
    let plaintext = decrypt_community_payload(&derived_key, &wrapped[32..], b"");
    derived_key.zeroize();
    raw_shared.zeroize();
    plaintext?
        .try_into()
        .map_err(|_| anyhow::anyhow!("unwrapped key has wrong length"))
}

/// Encrypt an arbitrary-length payload for a specific recipient using ephemeral
/// ECDH with HKDF domain separation. Output: ephemeral_pub (32) || nonce (12) || ciphertext.
///
/// This is the variable-length counterpart of `encrypt_key_wrap` which only
/// handles 32-byte payloads.
pub fn encrypt_for_recipient(
    recipient_x25519_pub: &PublicKey,
    plaintext: &[u8],
    domain: &str,
) -> Vec<u8> {
    let ephemeral_secret = StaticSecret::random_from_rng(OsRng);
    let ephemeral_public = PublicKey::from(&ephemeral_secret);
    let mut raw_shared = derive_shared_secret(&ephemeral_secret, recipient_x25519_pub);
    let mut derived_key = derive_keywrap_key(&raw_shared, domain);
    // SAFETY: Same as encrypt_key_wrap — ChaCha20-Poly1305 with valid
    // key/nonce cannot fail.
    // AAD is empty here because HKDF domain separation already binds the
    // ciphertext to its intended domain.
    let encrypted = encrypt_community_payload(&derived_key, plaintext, b"")
        .expect("ChaCha20-Poly1305 encryption with valid key/nonce is infallible");
    derived_key.zeroize();
    raw_shared.zeroize();

    let mut out = Vec::with_capacity(32 + encrypted.len());
    out.extend_from_slice(ephemeral_public.as_bytes());
    out.extend_from_slice(&encrypted);
    out
}

/// Decrypt a payload produced by `encrypt_for_recipient`.
pub fn decrypt_from_sender(
    our_secret: &StaticSecret,
    data: &[u8],
    domain: &str,
) -> anyhow::Result<Vec<u8>> {
    if data.len() < 32 {
        return Err(anyhow::anyhow!("encrypted payload too short"));
    }
    let ephemeral_public_bytes: [u8; 32] = data[..32]
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid ephemeral public key"))?;
    let ephemeral_public = PublicKey::from(ephemeral_public_bytes);
    let mut raw_shared = derive_shared_secret(our_secret, &ephemeral_public);
    let mut derived_key = derive_keywrap_key(&raw_shared, domain);
    let result = decrypt_community_payload(&derived_key, &data[32..], b"");
    derived_key.zeroize();
    raw_shared.zeroize();
    result
}

/// Encrypt a plaintext message using ChaCha20-Poly1305 with a shared key.
#[allow(dead_code)]
pub fn encrypt(
    key: &[u8; 32],
    nonce_bytes: &[u8; 12],
    plaintext: &[u8],
) -> anyhow::Result<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(key.into());
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| anyhow::anyhow!("encryption failed: {}", e))
}

/// Decrypt a ciphertext using ChaCha20-Poly1305 with a shared key.
#[allow(dead_code)]
pub fn decrypt(
    key: &[u8; 32],
    nonce_bytes: &[u8; 12],
    ciphertext: &[u8],
) -> anyhow::Result<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(key.into());
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| anyhow::anyhow!("decryption failed: {}", e))
}
