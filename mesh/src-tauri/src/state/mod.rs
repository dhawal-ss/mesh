#![deny(clippy::unwrap_used)]

pub mod app_state;
#[cfg(feature = "legacy-p2p")]
pub mod download_scheduler;
#[cfg(feature = "legacy-p2p")]
pub mod file_downloads;
#[cfg(feature = "legacy-p2p")]
pub mod membership;
#[cfg(feature = "legacy-p2p")]
pub mod rate_limits;
#[cfg(feature = "legacy-p2p")]
pub mod voice_state;

pub use app_state::AppState;
