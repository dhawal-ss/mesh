/// Helpers for reading/writing secrets to the OS keychain.
/// Wraps the `keyring` crate for mesh-specific key names.
use keyring::Entry;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};

const SERVICE: &str = "mesh";

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

/// Retrieve a secret from the OS keychain.
pub fn load_secret(key_name: &str) -> anyhow::Result<Vec<u8>> {
    let entry = Entry::new(SERVICE, key_name)?;
    let secret_b64 = entry.get_password()?;
    let secret = BASE64.decode(secret_b64)?;
    Ok(secret)
}

/// Check if a secret exists in the keychain.
pub fn secret_exists(key_name: &str) -> bool {
    try_secret_exists(key_name).unwrap_or(false)
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
