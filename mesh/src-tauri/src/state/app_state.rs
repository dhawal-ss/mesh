use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::crypto::identity::Identity;
use crate::network::events::NetworkHandle;
use crate::state::membership::MembershipState;
use crate::state::rate_limits::RateLimitState;
use crate::state::voice_state::VoiceState;

/// Root application state, shared across all Tauri command handlers.
/// All fields are wrapped in Arc<RwLock<>> for safe concurrent access
/// from the multithreaded Tokio runtime.
pub struct AppState {
    pub identity: Arc<RwLock<Option<Identity>>>,
    pub network: Arc<RwLock<Option<NetworkHandle>>>,
    pub downloads: Arc<tokio::sync::Mutex<crate::state::file_downloads::DownloadManager>>,
    pub voice: Arc<VoiceState>,
    pub membership: Arc<MembershipState>,
    pub rate_limits: Arc<RateLimitState>,
    pub pending_invites: Arc<tokio::sync::Mutex<HashMap<String, PendingInviteJoin>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            identity: Arc::new(RwLock::new(None)),
            network: Arc::new(RwLock::new(None)),
            downloads: Arc::new(tokio::sync::Mutex::new(
                crate::state::file_downloads::DownloadManager::default(),
            )),
            voice: Arc::new(VoiceState::default()),
            membership: Arc::new(MembershipState::new()),
            rate_limits: Arc::new(RateLimitState::new()),
            pending_invites: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct PendingInviteJoin {
    pub invite_secret: String,
    pub owner_public_key: Option<String>,
    pub attempted_peers: HashSet<String>,
    pub created_at: std::time::Instant,
}
