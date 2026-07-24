#[cfg(feature = "legacy-p2p")]
pub mod community_key;
#[cfg(feature = "legacy-p2p")]
pub mod encryption;
#[cfg(feature = "legacy-p2p")]
pub mod identity;
#[cfg(feature = "legacy-p2p")]
pub mod key_rotation;
pub mod keychain;

#[cfg(all(test, feature = "legacy-p2p"))]
mod crypto_tests;

#[cfg(all(test, feature = "legacy-p2p"))]
mod identity_tests;
