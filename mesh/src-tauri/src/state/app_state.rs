#[cfg(feature = "legacy-p2p")]
use std::collections::{HashMap, HashSet};
#[cfg(feature = "legacy-p2p")]
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
#[cfg(feature = "legacy-p2p")]
use tokio::sync::RwLock;

use crate::backend::BackendManager;
#[cfg(feature = "legacy-p2p")]
use crate::crypto::identity::Identity;
#[cfg(feature = "legacy-p2p")]
use crate::network::events::NetworkHandle;
use crate::state::destructive_actions::DestructiveActionGrantStore;
#[cfg(feature = "legacy-p2p")]
use crate::state::download_scheduler::DownloadScheduler;
#[cfg(feature = "legacy-p2p")]
use crate::state::membership::MembershipState;
use crate::state::native_requests::NativeRequestRegistry;
#[cfg(feature = "legacy-p2p")]
use crate::state::rate_limits::RateLimitState;
#[cfg(feature = "legacy-p2p")]
use crate::state::voice_state::VoiceState;

/// Live connectivity metrics maintained by the network event bridge.
///
/// The swarm task periodically emits `NetworkEvent::PeerCount { count, using_relay }`
/// and the event router updates these atomics so any Tauri command (including
/// get_diagnostics) can read the real current state without waiting for an
/// asynchronous event round-trip.
///
/// Before this existed, diagnostics treated "NetworkHandle exists" as
/// "connected" and hardcoded `network_peer_count: 0` — the UI therefore
/// showed "Connected" even when the app was completely isolated.
#[cfg(feature = "legacy-p2p")]
pub struct ConnectivityMetrics {
    /// Last reported peer count from the swarm task. Zero until the first
    /// NetworkEvent::PeerCount arrives.
    pub peer_count: AtomicU32,
    /// Whether any currently-connected peer is going through a relay.
    pub using_relay: AtomicBool,
    /// Whether the swarm task has fired NetworkEvent::NetworkReady.
    pub network_ready: AtomicBool,
}

#[cfg(feature = "legacy-p2p")]
impl ConnectivityMetrics {
    pub fn new() -> Self {
        Self {
            peer_count: AtomicU32::new(0),
            using_relay: AtomicBool::new(false),
            network_ready: AtomicBool::new(false),
        }
    }

    pub fn set_peer_count(&self, count: u32, using_relay: bool) {
        self.peer_count.store(count, Ordering::Relaxed);
        self.using_relay.store(using_relay, Ordering::Relaxed);
    }

    pub fn get_peer_count(&self) -> u32 {
        self.peer_count.load(Ordering::Relaxed)
    }

    pub fn mark_ready(&self) {
        self.network_ready.store(true, Ordering::Relaxed);
    }

    pub fn is_ready(&self) -> bool {
        self.network_ready.load(Ordering::Relaxed)
    }
}

#[cfg(feature = "legacy-p2p")]
impl Default for ConnectivityMetrics {
    fn default() -> Self {
        Self::new()
    }
}

/// Root application state, shared across all Tauri command handlers.
/// All fields are wrapped in Arc<RwLock<>> for safe concurrent access
/// from the multithreaded Tokio runtime.
pub struct AppState {
    /// Selected communication backend. Matrix is the production default;
    /// legacy libp2p must be explicitly selected with `MESH_BACKEND=legacy-p2p`.
    pub backend: BackendManager,
    /// Account-scoped native read scheduling and cancellation acknowledgement.
    pub native_requests: Arc<NativeRequestRegistry>,
    /// One-use, short-lived grants created only after a native confirmation.
    pub destructive_action_grants: Arc<DestructiveActionGrantStore>,
    #[cfg(feature = "legacy-p2p")]
    pub identity: Arc<RwLock<Option<Identity>>>,
    #[cfg(feature = "legacy-p2p")]
    pub network: Arc<RwLock<Option<NetworkHandle>>>,
    #[cfg(feature = "legacy-p2p")]
    pub downloads: Arc<tokio::sync::Mutex<crate::state::file_downloads::DownloadManager>>,
    #[cfg(feature = "legacy-p2p")]
    pub voice: Arc<VoiceState>,
    #[cfg(feature = "legacy-p2p")]
    pub membership: Arc<MembershipState>,
    #[cfg(feature = "legacy-p2p")]
    pub rate_limits: Arc<RateLimitState>,
    #[cfg(feature = "legacy-p2p")]
    pub pending_invites: Arc<tokio::sync::Mutex<HashMap<String, PendingInviteJoin>>>,
    /// Active download schedulers, keyed by file hash. Each scheduler manages
    /// bounded concurrency, adaptive seeder selection, and retry logic for a
    /// single file download.
    #[cfg(feature = "legacy-p2p")]
    pub schedulers: Arc<tokio::sync::Mutex<HashMap<String, DownloadScheduler>>>,
    /// Live connectivity metrics updated by the network event bridge.
    /// Used by get_diagnostics to report the TRUE current state, not
    /// "NetworkHandle exists therefore connected".
    #[cfg(feature = "legacy-p2p")]
    pub connectivity: Arc<ConnectivityMetrics>,
}

impl AppState {
    pub fn new() -> Self {
        Self::with_data_dir(std::env::temp_dir().join("mesh-test-state"))
    }

    pub fn with_data_dir(app_data_dir: impl Into<std::path::PathBuf>) -> Self {
        Self {
            backend: BackendManager::from_environment(app_data_dir.into()),
            native_requests: Arc::new(NativeRequestRegistry::default()),
            destructive_action_grants: Arc::new(DestructiveActionGrantStore::default()),
            #[cfg(feature = "legacy-p2p")]
            identity: Arc::new(RwLock::new(None)),
            #[cfg(feature = "legacy-p2p")]
            network: Arc::new(RwLock::new(None)),
            #[cfg(feature = "legacy-p2p")]
            downloads: Arc::new(tokio::sync::Mutex::new(
                crate::state::file_downloads::DownloadManager::default(),
            )),
            #[cfg(feature = "legacy-p2p")]
            voice: Arc::new(VoiceState::default()),
            #[cfg(feature = "legacy-p2p")]
            membership: Arc::new(MembershipState::new()),
            #[cfg(feature = "legacy-p2p")]
            rate_limits: Arc::new(RateLimitState::new()),
            #[cfg(feature = "legacy-p2p")]
            pending_invites: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            #[cfg(feature = "legacy-p2p")]
            schedulers: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            #[cfg(feature = "legacy-p2p")]
            connectivity: Arc::new(ConnectivityMetrics::new()),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "legacy-p2p")]
#[derive(Debug, Clone)]
pub struct PendingInviteJoin {
    pub invite_secret: String,
    pub owner_public_key: Option<String>,
    pub attempted_peers: HashSet<String>,
    pub created_at: std::time::Instant,
}
