use tokio::sync::{mpsc, oneshot};

use crate::network::behaviour::{
    ControlRequest, ControlResponse, MessageHistoryRequest, MessageHistoryResponse,
};

/// Commands sent FROM the application TO the network swarm task.
#[derive(Debug)]
#[allow(dead_code)]
pub enum NetworkCommand {
    SubscribeTopic {
        topic: String,
    },
    UnsubscribeTopic {
        topic: String,
    },
    /// Subscribe to a per-channel gossipsub topic for chat messages.
    SubscribeChannel {
        community_id: String,
        channel_id: String,
    },
    /// Unsubscribe from a per-channel gossipsub topic.
    UnsubscribeChannel {
        community_id: String,
        channel_id: String,
    },
    PublishMessage {
        topic: String,
        data: Vec<u8>,
    },
    FindPeers {
        community_id: String,
    },
    RegisterInDHT {
        community_id: String,
    },
    /// Stop refreshing our DHT record for a community (e.g. after leaving).
    UnregisterFromDHT {
        community_id: String,
    },
    ConnectPeer {
        addr: String,
    },
    SeedPeerAddresses {
        peer_id: String,
        addrs: Vec<String>,
    },
    GetPeerCount,
    GetExternalAddrs {
        reply: tokio::sync::oneshot::Sender<Vec<String>>,
    },
    RequestFileChunk {
        peer_id: String,
        file_hash: String,
        chunk_index: u32,
        community_id: String,
        requester_public_key: String,
        request_signature: String,
    },
    RequestMessageHistory {
        peer_id: Option<String>,
        channel_id: String,
        since_timestamp: Option<String>,
        since_id: Option<String>,
        limit: u32,
        requester_public_key: String,
        request_signature: String,
        request_timestamp: String,
    },
    RequestControl {
        peer_id: Option<String>,
        request: ControlRequest,
    },
    ServeFile {
        file_hash: String,
        path: std::path::PathBuf,
        community_id: String,
    },
    /// Sync the membership roster for a community into the swarm task so it
    /// can verify file chunk requesters are active members.
    UpdateCommunityMembers {
        community_id: String,
        member_public_keys: Vec<String>,
    },
}

/// Events sent FROM the network swarm task TO the application.
#[derive(Debug)]
#[allow(dead_code)]
pub enum NetworkEvent {
    GossipMessage {
        topic: String,
        data: Vec<u8>,
        from: String,
    },
    PeerDiscovered {
        peer_id: String,
        addrs: Vec<String>,
        community_id: Option<String>,
    },
    PeerConnected {
        peer_id: String,
    },
    PeerDisconnected {
        peer_id: String,
    },
    NetworkReady,
    PeerCount {
        count: usize,
    },
    FileChunkReceived {
        file_hash: String,
        chunk_index: u32,
        data: Vec<u8>,
    },
    MessageHistoryRequested {
        peer_id: String,
        request: MessageHistoryRequest,
        reply: oneshot::Sender<MessageHistoryResponse>,
    },
    MessageHistoryReceived {
        peer_id: String,
        response: MessageHistoryResponse,
    },
    ControlRequestReceived {
        peer_id: String,
        request: ControlRequest,
        reply: oneshot::Sender<ControlResponse>,
    },
    ControlResponseReceived {
        peer_id: String,
        response: ControlResponse,
    },
    PublishFailed {
        topic: String,
        data: Vec<u8>,
    },
    RequestFailed {
        protocol: String,
        reason: String,
    },
}

/// Handle for communicating with the network swarm task.
/// Held in AppState to send commands and receive events.
pub struct NetworkHandle {
    pub command_tx: mpsc::Sender<NetworkCommand>,
}

impl NetworkHandle {
    pub async fn send_command(&self, cmd: NetworkCommand) -> anyhow::Result<()> {
        self.command_tx
            .send(cmd)
            .await
            .map_err(|e| anyhow::anyhow!("failed to send network command: {}", e))
    }

    #[allow(dead_code)]
    pub async fn get_external_addrs(&self) -> anyhow::Result<Vec<String>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.send_command(NetworkCommand::GetExternalAddrs { reply: tx })
            .await?;
        rx.await
            .map_err(|e| anyhow::anyhow!("failed to get external addrs: {}", e))
    }
}
