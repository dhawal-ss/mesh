mod helpers;
mod history;
mod invite_handler;
mod message_handler;
mod network_router;
mod security;
mod voice_handler;

pub use helpers::signed_file_announcement_to_message;

use std::sync::Arc;

use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::time::interval;

use crate::crypto::identity::Identity;
use crate::network::discovery;
use crate::network::events::NetworkHandle;
use crate::network::swarm;
use crate::state::voice_state::VOICE_HEARTBEAT_INTERVAL;
use crate::state::AppState;

static NETWORK_START_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

pub async fn ensure_network_started(
    app_handle: AppHandle,
    identity_state: Arc<RwLock<Option<Identity>>>,
    network_state: Arc<RwLock<Option<NetworkHandle>>>,
) -> Result<bool, String> {
    let _guard = NETWORK_START_LOCK.lock().await;

    if network_state.read().await.is_some() {
        return Ok(false);
    }

    let private_key_bytes = {
        let identity = identity_state.read().await;
        let identity = identity.as_ref().ok_or("No identity loaded")?;
        identity.private_key_bytes()
    };

    let bootstrap_peers = discovery::default_bootstrap_peers();
    let (event_tx, event_rx) = mpsc::channel(1024);

    // Resolve the app data directory so the DHT store can persist records.
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;

    let handle = swarm::start_network(private_key_bytes, bootstrap_peers, event_tx, app_data_dir)
        .await
        .map_err(|e| e.to_string())?;

    history::seed_network_from_cache_and_local_communities(&app_handle, &handle).await;
    *network_state.write().await = Some(handle);
    let _ = app_handle.emit(
        "network:status",
        &serde_json::json!({
            "connected": false,
            "peerCount": 0,
            "averageLatency": 0,
            "usingRelay": false,
        }),
    );
    network_router::spawn_network_event_bridge(app_handle, event_rx);

    Ok(true)
}

pub fn spawn_voice_sweeper(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = interval(VOICE_HEARTBEAT_INTERVAL);
        loop {
            ticker.tick().await;
            let Some(state) = app_handle.try_state::<AppState>() else {
                continue;
            };

            let events = state.voice.sweep_expired().await;
            for event in events {
                voice_handler::emit_voice_session_event(&app_handle, &event);
            }

            // Sweep expired pending invites
            {
                let mut pending = state.pending_invites.lock().await;
                let expired: Vec<String> = pending
                    .iter()
                    .filter(|(_, entry)| entry.created_at.elapsed() > std::time::Duration::from_secs(5 * 60))
                    .map(|(community_id, _)| community_id.clone())
                    .collect();
                for community_id in expired {
                    tracing::info!("Sweeping expired pending invite for {}", community_id);
                    pending.remove(&community_id);
                }
            }
        }
    });
}
