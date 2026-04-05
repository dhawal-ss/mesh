use argon2::{Argon2, Params, Version, Algorithm};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256, Sha512};

/// Represents a user's cryptographic identity.
/// The signing key (private) is stored in the OS keychain.
/// The verifying key (public) is shared with peers.
pub struct Identity {
    pub signing_key: SigningKey,
    pub verifying_key: VerifyingKey,
    pub public_key_b64: String,
}

impl Identity {
    /// Generate a new Ed25519 keypair and store the private key in the OS keychain.
    /// Called only on first launch.
    pub fn generate() -> anyhow::Result<Self> {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let public_key_b64 = BASE64.encode(verifying_key.as_bytes());

        // Store private key in OS secure enclave
        crate::crypto::keychain::store_secret("identity_private_key", signing_key.as_bytes())?;

        Ok(Identity {
            signing_key,
            verifying_key,
            public_key_b64,
        })
    }

    /// Load an existing keypair from the OS keychain.
    pub fn load() -> anyhow::Result<Self> {
        let secret_bytes = crate::crypto::keychain::load_secret("identity_private_key")?;
        let bytes: [u8; 32] = secret_bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid key length"))?;
        let signing_key = SigningKey::from_bytes(&bytes);
        let verifying_key = signing_key.verifying_key();
        let public_key_b64 = BASE64.encode(verifying_key.as_bytes());

        Ok(Identity {
            signing_key,
            verifying_key,
            public_key_b64,
        })
    }

    /// Sign a message payload. Returns base64-encoded signature.
    pub fn sign(&self, payload: &[u8]) -> String {
        let signature = self.signing_key.sign(payload);
        BASE64.encode(signature.to_bytes())
    }

    /// Check if a keypair already exists in the keychain.
    pub fn exists() -> bool {
        crate::crypto::keychain::secret_exists("identity_private_key")
    }

    /// Get the raw private key bytes (for seeding the libp2p keypair).
    pub fn private_key_bytes(&self) -> [u8; 32] {
        self.signing_key.to_bytes()
    }

    /// Derive an X25519 static secret from the Ed25519 private key.
    ///
    /// This uses the standard Ed25519→X25519 conversion: hash the Ed25519
    /// secret with SHA-512, take the first 32 bytes and clamp.
    pub fn x25519_static_secret(&self) -> x25519_dalek::StaticSecret {
        let hash = Sha512::digest(self.signing_key.as_bytes());
        let mut secret_bytes = [0u8; 32];
        secret_bytes.copy_from_slice(&hash[..32]);
        // Clamp per RFC 7748
        secret_bytes[0] &= 248;
        secret_bytes[31] &= 127;
        secret_bytes[31] |= 64;
        x25519_dalek::StaticSecret::from(secret_bytes)
    }

    /// Derive the X25519 public key corresponding to our X25519 secret.
    pub fn x25519_public_key(&self) -> x25519_dalek::PublicKey {
        x25519_dalek::PublicKey::from(&self.x25519_static_secret())
    }

    /// Export the identity as a passphrase-encrypted bundle.
    ///
    /// Output format (v2): `[0x02] || salt (16 bytes) || nonce (12 bytes) || ciphertext`
    ///
    /// The encryption key is derived from the passphrase via Argon2id with a
    /// random 16-byte salt. The 64-byte plaintext (private + public key) is
    /// encrypted using ChaCha20-Poly1305.
    pub fn export_bundle(&self, passphrase: &str) -> anyhow::Result<Vec<u8>> {
        let mut plaintext = Vec::with_capacity(64);
        plaintext.extend_from_slice(self.signing_key.as_bytes());
        plaintext.extend_from_slice(self.verifying_key.as_bytes());

        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);

        let derived_key = derive_export_key(passphrase, &salt)?;
        let encrypted = crate::crypto::encryption::encrypt_community_payload(
            &derived_key,
            &plaintext,
            b"", // no community context for identity export
        )?;

        // Version byte || salt || nonce || ciphertext
        let mut out = Vec::with_capacity(1 + 16 + encrypted.len());
        out.push(0x02); // version byte — Argon2id key derivation
        out.extend_from_slice(&salt);
        out.extend_from_slice(&encrypted);
        Ok(out)
    }

    /// Import an identity from a previously exported bundle.
    /// Stores the private key in the OS keychain.
    ///
    /// Supports three formats:
    /// - **v2** (0x02): Argon2id key derivation — `0x02 || salt(16) || nonce(12) || ciphertext`
    /// - **v1** (0x01): Legacy HKDF-SHA256 key derivation — `0x01 || nonce(12) || ciphertext`
    /// - **v0**: Legacy unencrypted — raw 64 bytes (private + public key)
    pub fn import_bundle(data: &[u8], passphrase: &str) -> anyhow::Result<Self> {
        let plaintext = if data.first() == Some(&0x02) {
            // v2 format: [0x02] || salt (16) || nonce (12) || ciphertext
            if data.len() < 1 + 16 + 12 + 16 {
                return Err(anyhow::anyhow!("encrypted identity bundle too short"));
            }
            let salt = &data[1..17];
            let derived_key = derive_export_key(passphrase, salt)?;
            crate::crypto::encryption::decrypt_community_payload(
                &derived_key,
                &data[17..], // remainder is nonce || ciphertext
                b"", // no community context for identity import
            )?
        } else if data.first() == Some(&0x01) {
            // v1 format (legacy HKDF): [0x01] || nonce (12) || ciphertext
            tracing::warn!(
                "Importing identity bundle using legacy v1 (HKDF) key derivation. \
                 Re-export with a passphrase to upgrade to Argon2id."
            );
            if data.len() < 1 + 12 + 16 {
                return Err(anyhow::anyhow!("encrypted identity bundle too short"));
            }
            let derived_key = derive_export_key_legacy_v1(passphrase);
            crate::crypto::encryption::decrypt_community_payload(
                &derived_key,
                &data[1..], // skip version byte; remainder is nonce || ciphertext
                b"", // no community context for identity import
            )?
        } else {
            // Legacy unencrypted format: raw 64 bytes (private + public key)
            data.to_vec()
        };

        if plaintext.len() < 32 {
            return Err(anyhow::anyhow!("identity bundle too short"));
        }
        let mut key_bytes = [0u8; 32];
        key_bytes.copy_from_slice(&plaintext[..32]);
        let signing_key = SigningKey::from_bytes(&key_bytes);
        let verifying_key = signing_key.verifying_key();
        let public_key_b64 = BASE64.encode(verifying_key.as_bytes());

        // Store in keychain
        crate::crypto::keychain::store_secret("identity_private_key", signing_key.as_bytes())?;

        Ok(Identity {
            signing_key,
            verifying_key,
            public_key_b64,
        })
    }
}

/// Derive a 32-byte encryption key from a user passphrase using Argon2id.
///
/// Argon2id is a memory-hard password hashing function that is resistant to both
/// GPU/ASIC attacks (via memory hardness) and side-channel attacks (via the hybrid
/// Argon2i+Argon2d approach). This makes it far more suitable than HKDF for
/// deriving keys from potentially weak user-chosen passphrases.
///
/// Parameters:
/// - `m_cost`: 65536 KiB (64 MB) — memory usage per hash
/// - `t_cost`: 3 — number of iterations
/// - `p_cost`: 4 — degree of parallelism
/// - `output_len`: 32 bytes
///
/// The caller must provide a random 16-byte salt (generated via `OsRng` during
/// export and stored in the bundle for import).
fn derive_export_key(passphrase: &str, salt: &[u8]) -> anyhow::Result<[u8; 32]> {
    let params = Params::new(
        65_536, // m_cost: 64 MB
        3,      // t_cost: 3 iterations
        4,      // p_cost: 4 parallel lanes
        Some(32),
    )
    .map_err(|e| anyhow::anyhow!("invalid Argon2 params: {}", e))?;

    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut okm = [0u8; 32];
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, &mut okm)
        .map_err(|e| anyhow::anyhow!("Argon2id key derivation failed: {}", e))?;
    Ok(okm)
}

/// Legacy v1 key derivation using HKDF-SHA256 with a fixed salt.
///
/// **Deprecated**: HKDF is a key derivation function designed for already-strong
/// keying material, not human-chosen passphrases. It performs a single hash pass,
/// making it trivially brute-forceable for weak passphrases. Retained only for
/// backward-compatible import of v1 bundles.
fn derive_export_key_legacy_v1(passphrase: &str) -> [u8; 32] {
    let salt = b"mesh-identity-export-v1";
    let hk = Hkdf::<Sha256>::new(Some(salt), passphrase.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(b"", &mut okm)
        .expect("HKDF-SHA256 expand for 32 bytes is infallible per RFC 5869");
    okm
}

/// Verify a signature from any public key (not just ours).
pub fn verify_signature(
    public_key_b64: &str,
    payload: &[u8],
    signature_b64: &str,
) -> anyhow::Result<bool> {
    let pk_bytes: [u8; 32] = BASE64
        .decode(public_key_b64)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid key"))?;
    let sig_bytes: [u8; 64] = BASE64
        .decode(signature_b64)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid sig"))?;
    let vk = VerifyingKey::from_bytes(&pk_bytes)?;
    let sig = Signature::from_bytes(&sig_bytes);
    Ok(vk.verify(payload, &sig).is_ok())
}

/// Convert an Ed25519 public key (base64) to its X25519 (Montgomery) equivalent.
///
/// Uses the standard Edwards-to-Montgomery conversion so that we can encrypt
/// payloads to a peer whose Ed25519 public key we know without requiring them
/// to separately share an X25519 public key.
pub fn ed25519_pub_to_x25519(public_key_b64: &str) -> anyhow::Result<x25519_dalek::PublicKey> {
    let pk_bytes: [u8; 32] = BASE64
        .decode(public_key_b64)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid ed25519 public key length"))?;
    let vk = VerifyingKey::from_bytes(&pk_bytes)?;
    let montgomery = vk.to_montgomery();
    Ok(x25519_dalek::PublicKey::from(montgomery.to_bytes()))
}
