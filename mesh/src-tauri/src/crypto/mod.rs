#![deny(clippy::unwrap_used)]

#[cfg(feature = "legacy-p2p")]
pub mod community_key;
#[cfg(any(feature = "legacy-p2p", feature = "matrix-backend"))]
pub mod encryption;
#[cfg(feature = "legacy-p2p")]
pub mod identity;
#[cfg(feature = "legacy-p2p")]
pub mod key_rotation;
pub mod keychain;

#[cfg(all(test, feature = "legacy-p2p"))]
#[allow(clippy::unwrap_used)]
mod crypto_tests;

#[cfg(all(test, feature = "legacy-p2p"))]
#[allow(clippy::unwrap_used)]
mod identity_tests;
