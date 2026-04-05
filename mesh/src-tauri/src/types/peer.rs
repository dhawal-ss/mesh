use serde::{Deserialize, Serialize};

/// Peer DTO sent over IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct PeerDto {
    pub public_key: String,
    pub display_name: String,
    pub avatar_color: String,
    pub peer_id: String,
    pub latency: u64,
}

/// Network status DTO emitted to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct NetworkStatusDto {
    pub connected: bool,
    pub peer_count: usize,
    pub average_latency: u64,
    pub using_relay: bool,
}
