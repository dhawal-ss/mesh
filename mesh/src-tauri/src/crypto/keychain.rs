/// Helpers for reading/writing secrets to the OS keychain.
/// Wraps the `keyring` crate for mesh-specific key names.
use keyring::Entry;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};

const SERVICE: &str = "mesh";

#[derive(Debug, PartialEq, Eq)]
pub enum SecretLookup {
    Found(Vec<u8>),
    Missing,
}

/// Store a secret in the OS keychain.
pub fn store_secret(key_name: &str, secret: &[u8]) -> anyhow::Result<()> {
    let entry = Entry::new(SERVICE, key_name)?;
    entry.set_password(&BASE64.encode(secret))?;

    #[cfg(target_os = "linux")]
    tracing::warn!(
        "Secret '{}' stored via OS keyring — ensure a keyring daemon (gnome-keyring, kwallet) \
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
}
