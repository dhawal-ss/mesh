//! System diagnostics command.
//!
//! Exposes an aggregated health snapshot so the UI can surface "system health"
//! at a glance. This is the single endpoint field support would use to answer
//! "is the app working?" without having to parse log files.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::download_scheduler::SchedulerStats;
use crate::state::AppState;
use crate::storage::Database;

use super::error::CommandError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDiagnostics {
    pub network_connected: bool,
    pub network_peer_count: u32,
    pub identity_loaded: bool,
    pub community_count: u32,
    pub member_count: u32,
    pub active_download_count: u32,
    pub download_stats: Vec<SchedulerStats>,
    pub active_voice_sessions: u32,
    pub ice_server_status: IceServerHealth,
    pub pending_message_count: u32,
    pub version: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServerHealth {
    pub stun_configured: bool,
    pub turn_configured: bool,
    pub custom_servers: bool,
}

/// Get a full diagnostics snapshot of the running system.
/// Returns peer count, active downloads, voice state, TURN status, and warnings.
#[tauri::command]
pub async fn get_diagnostics(
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<SystemDiagnostics, CommandError> {
    let mut warnings: Vec<String> = Vec::new();

    // ─── Identity ────────────────────────────────────
    let identity_loaded = state.identity.read().await.is_some();
    if !identity_loaded {
        warnings
            .push("No identity loaded — complete onboarding or import an identity bundle".into());
    }

    // ─── Network ─────────────────────────────────────
    //
    // IMPORTANT: the user IS a peer. When `network_peer_count` is 0 it
    // means "no OTHER peers are connected to me" — it does NOT mean
    // "the app is broken". The user can still:
    //   - send messages (they land in their local DB and appear instantly)
    //   - create communities and channels
    //   - queue messages for gossip re-delivery when other peers arrive
    //
    // What they can't do alone:
    //   - receive messages from other people
    //   - make a voice call
    //   - download a file that lives on another peer
    //
    // We surface three distinct states:
    //   - network_started: swarm task exists (NetworkHandle present)
    //   - network_ready:   swarm has fired NetworkReady
    //   - network_connected: at least one OTHER peer is connected
    // The UI translates network_connected into user-friendly language.
    let network_started = state.network.read().await.is_some();
    let network_ready = state.connectivity.is_ready();
    let network_peer_count = state.connectivity.get_peer_count();
    let network_connected = network_peer_count > 0;

    if !network_started {
        warnings.push(
            "Network not started — check logs for startup errors (target: mesh::startup)".into(),
        );
    } else if !network_ready {
        warnings.push("Network starting — waiting for swarm to become ready".into());
    }
    // Running solo (network_ready && peer_count == 0) is NOT a warning.
    // It's a valid working state. The user is a peer; the mesh size is 1.
    // We surface it gently in the UI instead of shouting about it in
    // the diagnostics warnings list.

    // ─── Communities & members ──────────────────────
    let community_count: u32 = db
        .run_blocking(|db| db.get_communities().map(|c| c.len() as u32).unwrap_or(0))
        .await;

    let member_count: u32 = db
        .run_blocking(|db| {
            let communities = db.get_communities().unwrap_or_default();
            let mut total: u32 = 0;
            for community in communities {
                total += db.member_count(&community.id).unwrap_or(0);
            }
            total
        })
        .await;

    // ─── Downloads ───────────────────────────────────
    let (active_download_count, download_stats) = {
        let schedulers = state.schedulers.lock().await;
        let stats: Vec<SchedulerStats> = schedulers.values().map(|s| s.stats()).collect();
        let count = stats.len() as u32;
        let stalled = stats.iter().filter(|s| s.is_stalled).count();
        let failed = stats.iter().filter(|s| s.is_failed).count();
        if stalled > 0 {
            warnings.push(format!(
                "{} download(s) stalled — no seeders available, waiting for peers to come online",
                stalled
            ));
        }
        if failed > 0 {
            warnings.push(format!(
                "{} download(s) failed — all retries exhausted; user can manually retry from the UI",
                failed
            ));
        }
        (count, stats)
    };

    // ─── Voice ───────────────────────────────────────
    let active_voice_sessions = state.voice.session_count().await;

    // ─── ICE / TURN ──────────────────────────────────
    let ice_custom: Option<String> = db
        .run_blocking(|db| db.get_kv("ice_servers").unwrap_or(None))
        .await;

    let (stun_configured, turn_configured, custom_servers) = match ice_custom.as_deref() {
        Some(json) => {
            match serde_json::from_str::<Vec<serde_json::Value>>(json) {
                Ok(servers) if !servers.is_empty() => {
                    let mut stun = false;
                    let mut turn = false;
                    for server in &servers {
                        if let Some(urls) = server.get("urls").and_then(|v| v.as_array()) {
                            for url in urls {
                                if let Some(url_str) = url.as_str() {
                                    if url_str.starts_with("stun:") || url_str.starts_with("stuns:")
                                    {
                                        stun = true;
                                    }
                                    if url_str.starts_with("turn:") || url_str.starts_with("turns:")
                                    {
                                        turn = true;
                                    }
                                }
                            }
                        }
                    }
                    (stun, turn, true)
                }
                _ => (true, false, false), // default STUN-only
            }
        }
        None => (true, false, false),
    };

    if !turn_configured {
        warnings.push(
            "No TURN server configured — voice may fail behind strict NATs. \
             Configure a TURN server in Settings → Voice & Audio."
                .into(),
        );
    }

    // ─── Pending messages (offline queue) ───────────
    let pending_message_count: u32 = db
        .run_blocking(|db| {
            db.get_pending_messages()
                .map(|msgs| msgs.len() as u32)
                .unwrap_or(0)
        })
        .await;

    // The pending_messages queue holds messages whose initial gossipsub
    // publish didn't find any peers to relay through. These messages ARE
    // stored locally and visible to the sender — the queue just tracks the
    // gossipsub retry that'll re-broadcast them when a peer joins.
    //
    // This is NOT a failure state when running solo. Don't alarm the user.
    if pending_message_count > 0 && network_peer_count > 0 {
        // Only flag as a warning if we have peers but still can't publish,
        // which suggests a real problem (rate limiting, network glitch, etc.)
        warnings.push(format!(
            "{} message(s) queued for retry — will re-broadcast automatically",
            pending_message_count
        ));
    }

    Ok(SystemDiagnostics {
        network_connected,
        network_peer_count,
        identity_loaded,
        community_count,
        member_count,
        active_download_count,
        download_stats,
        active_voice_sessions,
        ice_server_status: IceServerHealth {
            stun_configured,
            turn_configured,
            custom_servers,
        },
        pending_message_count,
        version: env!("CARGO_PKG_VERSION").to_string(),
        warnings,
    })
}
