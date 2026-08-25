use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rand::rngs::OsRng;

/// A community keypair. The owner holds the private key;
/// the public key serves as the community's unique identity.
pub struct CommunityKey {
    pub signing_key: SigningKey,
    pub verifying_key: VerifyingKey,
    pub community_id: String,
    pub private_key_b64: String,
}

impl CommunityKey {
    /// Generate a new community keypair.
    /// The community_id is the first 16 bytes of the public key, base64-encoded.
    pub fn generate() -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let community_id = BASE64.encode(&verifying_key.as_bytes()[..16]);
        let private_key_b64 = BASE64.encode(signing_key.as_bytes());

        CommunityKey {
            signing_key,
            verifying_key,
            community_id,
            private_key_b64,
        }
    }

    /// Reconstruct a community key from a stored base64 private key.
    pub fn from_private_key_b64(private_key_b64: &str) -> anyhow::Result<Self> {
        let bytes: [u8; 32] = BASE64
            .decode(private_key_b64)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid community key length"))?;
        let signing_key = SigningKey::from_bytes(&bytes);
        let verifying_key = signing_key.verifying_key();
        let community_id = BASE64.encode(&verifying_key.as_bytes()[..16]);

        Ok(CommunityKey {
            signing_key,
            verifying_key,
            community_id,
            private_key_b64: private_key_b64.to_string(),
        })
    }

    /// Sign data with the community key (for admin actions like bans, role changes).
    pub fn sign(&self, payload: &[u8]) -> String {
        let signature = self.signing_key.sign(payload);
        BASE64.encode(signature.to_bytes())
    }
}
