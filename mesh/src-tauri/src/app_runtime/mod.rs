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
use crate::storage::Database;

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

    // Resume incomplete downloads from previous sessions
    resume_incomplete_downloads(&app_handle, &identity_state, &network_state).await;

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

async fn resume_incomplete_downloads(
    app_handle: &AppHandle,
    _identity_state: &Arc<RwLock<Option<Identity>>>,
    _network_state: &Arc<RwLock<Option<NetworkHandle>>>,
) {
    let Some(db) = app_handle.try_state::<Database>() else {
        return;
    };
    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };
    let sessions = db.get_incomplete_download_sessions().unwrap_or_default();
    if sessions.is_empty() {
        return;
    }

    for session in sessions {
        if session.missing_chunks.is_empty() {
            continue;
        }
        tracing::info!(
            "Resuming download: {} ({} chunks remaining)",
            session.filename,
            session.missing_chunks.len()
        );

        // Look up all known seeders for this file
        let seeders = db.get_file_seeders(&session.file_hash).unwrap_or_default();

        let mut all_seeders: Vec<String> = Vec::new();
        if let Some(ref source) = session.source_peer_id {
            all_seeders.push(source.clone());
        }
        for (peer_id, _) in &seeders {
            if !all_seeders.contains(peer_id) {
                all_seeders.push(peer_id.clone());
            }
        }

        if all_seeders.is_empty() {
            tracing::warn!(
                "No seeders available for resuming download {}",
                session.file_hash
            );
            continue;
        }

        // Build the set of already-received chunks
        let already_received: std::collections::HashSet<u32> =
            session.received_chunks.iter().copied().collect();

        let community_id = session.community_id.clone().unwrap_or_default();

        // Create a scheduler for this resumed download
        let scheduler = crate::state::download_scheduler::DownloadScheduler::new(
            session.file_hash.clone(),
            community_id,
            session.total_chunks,
            all_seeders,
            already_received,
        );

        // Store the scheduler
        state
            .schedulers
            .lock()
            .await
            .insert(session.file_hash.clone(), scheduler);

        // Send the initial bounded batch
        crate::commands::files::send_scheduler_batch(app_handle, &session.file_hash).await;
    }
}

/// Periodically check for timed-out chunk requests across all active downloads
/// and re-fill the concurrency window. This ensures downloads make progress
/// even if chunk-received events stop arriving (e.g. a seeder went offline).
pub fn spawn_download_timeout_checker(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = interval(std::time::Duration::from_secs(10));
        loop {
            ticker.tick().await;
            let Some(state) = app_handle.try_state::<AppState>() else {
                continue;
            };

            // Collect file hashes that have active schedulers
            let file_hashes: Vec<String> = {
                let schedulers = state.schedulers.lock().await;
                schedulers.keys().cloned().collect()
            };

            // For each active download, drive the scheduler to check timeouts
            // and re-fill the request window
            for file_hash in file_hashes {
                // Check for stalled/failed downloads
                {
                    let schedulers = state.schedulers.lock().await;
                    if let Some(scheduler) = schedulers.get(&file_hash) {
                        if scheduler.is_failed() {
                            tracing::error!(
                                "Download {} has failed — all retries exhausted",
                                file_hash
                            );
                            let _ = app_handle.emit(
                                "file:download-failed",
                                &serde_json::json!({
                                    "fileHash": file_hash,
                                    "reason": "All seeders exhausted and retries failed",
                                }),
                            );
                        } else if scheduler.is_stalled() {
                            tracing::warn!(
                                "Download {} is stalled — no available seeders",
                                file_hash
                            );
                        }
                    }
                }
                crate::commands::files::send_scheduler_batch(&app_handle, &file_hash).await;
            }
        }
    });
}

/// Periodically emit network health metrics to the frontend for observability.
/// Fires every 30 seconds with peer count, relay status, and mesh quality.
pub fn spawn_network_health_monitor(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = interval(std::time::Duration::from_secs(30));
        ticker.tick().await; // skip first immediate tick
        loop {
            ticker.tick().await;
            let Some(state) = app_handle.try_state::<AppState>() else {
                continue;
            };

            let network = state.network.read().await;
            if let Some(ref net) = *network {
                // Request current peer count from swarm
                let _ = net
                    .send_command(crate::network::events::NetworkCommand::GetPeerCount)
                    .await;
            }

            // Log active download count for observability
            let active_downloads = state.schedulers.lock().await.len();
            if active_downloads > 0 {
                tracing::info!(
                    target: "mesh::metrics",
                    "Active downloads: {}",
                    active_downloads
                );
            }
        }
    });
}

/// Attempt to reconnect the network if peer count drops to zero.
/// Checks every 60 seconds, re-dials bootstrap peers if no peers connected.
pub fn spawn_reconnect_watchdog(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = interval(std::time::Duration::from_secs(60));
        ticker.tick().await; // skip first immediate tick
        let mut consecutive_zero_count = 0u32;
        loop {
            ticker.tick().await;
            let Some(state) = app_handle.try_state::<AppState>() else {
                continue;
            };

            let network = state.network.read().await;
            let Some(ref net) = *network else {
                continue;
            };

            // Check if we have any connected peers by sending GetPeerCount
            // and checking the last emitted peer count.
            // For now, use the bootstrap re-dial as a proactive measure.
            let bootstrap_peers = discovery::default_bootstrap_peers();
            if bootstrap_peers.is_empty() {
                continue;
            }

            // If we've seen zero peers for multiple consecutive checks, re-dial bootstrap
            // This is a simple heuristic — a proper implementation would track
            // actual peer count from the swarm events.
            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel::<Vec<String>>();
            let _ = net
                .send_command(crate::network::events::NetworkCommand::GetExternalAddrs {
                    reply: reply_tx,
                })
                .await;

            // If we can't even get our own addresses, network might be down
            match tokio::time::timeout(std::time::Duration::from_secs(5), reply_rx).await {
                Ok(Ok(addrs)) if addrs.is_empty() => {
                    consecutive_zero_count += 1;
                    if consecutive_zero_count >= 3 {
                        tracing::warn!(
                            "Network appears isolated (no external addresses for {} checks). Re-dialing bootstrap peers.",
                            consecutive_zero_count
                        );
                        for peer_addr in &bootstrap_peers {
                            let _ = net
                                .send_command(crate::network::events::NetworkCommand::ConnectPeer {
                                    addr: peer_addr.clone(),
                                })
                                .await;
                        }
                        consecutive_zero_count = 0;
                    }
                }
                Ok(Ok(_)) => {
                    consecutive_zero_count = 0;
                }
                _ => {
                    consecutive_zero_count += 1;
                }
            }
        }
    });
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
                    .filter(|(_, entry)| {
                        entry.created_at.elapsed() > std::time::Duration::from_secs(5 * 60)
                    })
                    .map(|(community_id, _)| community_id.clone())
                    .collect();
                for community_id in expired {
                    tracing::info!("Sweeping expired pending invite for {}", community_id);
                    pending.remove(&community_id);
                }
            }

            // GC stale rate limit entries to prevent unbounded memory growth
            state.rate_limits.gc_stale_entries().await;

            // Sweep stale file seeders every 5 minutes (60 ticks at 5 seconds each)
            static SEEDER_SWEEP_COUNTER: std::sync::atomic::AtomicU32 =
                std::sync::atomic::AtomicU32::new(0);
            let tick_count =
                SEEDER_SWEEP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if tick_count.is_multiple_of(60) {
                if let Some(db) = app_handle.try_state::<Database>() {
                    match db.sweep_stale_file_seeders(15) {
                        // 15 minutes
                        Ok(deleted) if deleted > 0 => {
                            tracing::info!("Swept {} stale file seeder records", deleted);
                        }
                        Err(e) => {
                            tracing::warn!("Failed to sweep stale file seeders: {}", e);
                        }
                        _ => {}
                    }
                }
            }
        }
    });
}
