/// Helpers for reading/writing secrets to the OS keychain.
/// Wraps the `keyring` crate for mesh-specific key names.
use keyring::Entry;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use std::{error::Error, fmt};

const SERVICE: &str = "mesh";
const WINDOWS_CREDENTIAL_BLOB_LIMIT_BYTES: usize = 2_560;

/// Windows Credential Manager stores the password as UTF-16 bytes. Mesh first
/// encodes secrets as URL-safe Base64, so 960 raw bytes is the largest payload
/// that can fit in the 2,560-byte credential blob.
#[derive(Debug, PartialEq, Eq)]
pub struct CredentialBlobTooLarge {
    encoded_blob_bytes: usize,
}

impl fmt::Display for CredentialBlobTooLarge {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "encoded secret requires {} bytes, exceeding the Windows Credential Manager limit of {} bytes",
            self.encoded_blob_bytes, WINDOWS_CREDENTIAL_BLOB_LIMIT_BYTES
        )
    }
}

impl Error for CredentialBlobTooLarge {}

#[derive(Debug, PartialEq, Eq)]
pub enum SecretLookup {
    Found(Vec<u8>),
    Missing,
}

/// The 2,560-byte cap is specific to the Windows Credential Manager blob. macOS
/// Keychain and the Linux Secret Service accept far larger secrets, so the guard
/// is enforced only on Windows; other platforms store the secret as-is. Applying
/// the Windows limit everywhere would wrongly reject legitimate secrets there
/// (for example an account registry or trusted-device list that has grown).
fn validate_credential_blob_size(encoded_secret: &str) -> anyhow::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let encoded_blob_bytes =
            encoded_secret
                .len()
                .checked_mul(2)
                .ok_or(CredentialBlobTooLarge {
                    encoded_blob_bytes: usize::MAX,
                })?;
        if encoded_blob_bytes > WINDOWS_CREDENTIAL_BLOB_LIMIT_BYTES {
            return Err(CredentialBlobTooLarge { encoded_blob_bytes }.into());
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = encoded_secret;
    Ok(())
}

/// Store a secret in the OS keychain.
pub fn store_secret(key_name: &str, secret: &[u8]) -> anyhow::Result<()> {
    let encoded_secret = BASE64.encode(secret);
    validate_credential_blob_size(&encoded_secret)?;
    let entry = Entry::new(SERVICE, key_name)?;
    entry.set_password(&encoded_secret)?;

    #[cfg(target_os = "linux")]
    tracing::warn!(
        "Secret '{}' stored via OS keyring; ensure a keyring daemon (gnome-keyring, kwallet) \
         is running to avoid plaintext fallback",
        key_name
    );

    Ok(())
}

fn decode_lookup(result: keyring::Result<String>) -> anyhow::Result<SecretLookup> {
    match result {
        Ok(secret_b64) => Ok(SecretLookup::Found(BASE64.decode(secret_b64)?)),
        Err(keyring::Error::NoEntry) => Ok(SecretLookup::Missing),
        Err(error) => Err(error.into()),
    }
}

/// Retrieve a secret while preserving the difference between an absent entry
/// and an unavailable or corrupt credential store.
pub fn lookup_secret(key_name: &str) -> anyhow::Result<SecretLookup> {
    let entry = Entry::new(SERVICE, key_name)?;
    decode_lookup(entry.get_password())
}

/// Retrieve a secret that the caller already knows must exist.
pub fn load_secret(key_name: &str) -> anyhow::Result<Vec<u8>> {
    match lookup_secret(key_name)? {
        SecretLookup::Found(secret) => Ok(secret),
        SecretLookup::Missing => Err(anyhow::anyhow!("required secure-storage entry is missing")),
    }
}

/// Check whether a secret exists without treating keychain access failures as
/// an absent entry.
///
/// Destructive account cleanup must use this fallible form so it cannot report
/// success when the operating-system credential store was unavailable.
pub fn try_secret_exists(key_name: &str) -> anyhow::Result<bool> {
    let entry = Entry::new(SERVICE, key_name)?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// Delete a secret from the keychain.
#[allow(dead_code)]
pub fn delete_secret(key_name: &str) -> anyhow::Result<()> {
    let entry = Entry::new(SERVICE, key_name)?;
    entry.delete_password()?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn lookup_decodes_found_secret() {
        let secret = b"mesh-secret".to_vec();
        assert_eq!(
            decode_lookup(Ok(BASE64.encode(&secret))).expect("valid encoded secret"),
            SecretLookup::Found(secret)
        );
    }

    #[test]
    fn lookup_distinguishes_missing_secret() {
        assert_eq!(
            decode_lookup(Err(keyring::Error::NoEntry)).expect("missing is not a failure"),
            SecretLookup::Missing
        );
    }

    #[test]
    fn lookup_propagates_unavailable_secure_store() {
        let error = keyring::Error::NoStorageAccess(Box::new(std::io::Error::other(
            "credential store is locked",
        )));
        let result = decode_lookup(Err(error));

        assert!(result.is_err());
        assert!(result
            .expect_err("unavailable secure storage must fail closed")
            .to_string()
            .contains("Couldn't access platform secure storage"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_credential_blob_guard_accepts_exact_raw_boundary() {
        let encoded = BASE64.encode(vec![0_u8; 960]);

        assert_eq!(encoded.len() * 2, WINDOWS_CREDENTIAL_BLOB_LIMIT_BYTES);
        assert!(validate_credential_blob_size(&encoded).is_ok());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_credential_blob_guard_rejects_one_byte_over_raw_boundary() {
        let encoded = BASE64.encode(vec![0_u8; 961]);
        let error = validate_credential_blob_size(&encoded)
            .expect_err("oversized secure-store values must fail before the OS call");

        assert!(error.downcast_ref::<CredentialBlobTooLarge>().is_some());
        assert!(error
            .to_string()
            .contains("Windows Credential Manager limit"));
    }
}
