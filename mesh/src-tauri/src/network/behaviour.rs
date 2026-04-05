use libp2p::{connection_limits, dcutr, gossipsub, identify, kad, mdns, ping, relay, request_response, swarm::NetworkBehaviour};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteChallengeRequest {
    pub community_id: String,
    /// Plaintext invite secret — left empty when `encrypted_invite_secret` is set.
    #[serde(default)]
    pub invite_secret: String,
    pub joiner_public_key: String,
    pub joiner_x25519_public_key: String,
    pub display_name: String,
    pub avatar_color: String,
    pub timestamp: String,
    /// Invite secret encrypted via `encrypt_key_wrap` to the community owner's
    /// X25519 public key, so it is not visible in transit. The receiver decrypts
    /// with their X25519 static secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_invite_secret: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteChallengeResponse {
    pub accepted: bool,
    pub reason: Option<String>,
    pub community_id: String,
    pub joiner_public_key: String,
    pub joiner_x25519_public_key: String,
    pub challenge_nonce: Option<String>,
    pub timestamp: String,
    pub signed_by: Option<String>,
    pub signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteJoinRequest {
    pub community_id: String,
    /// Plaintext invite secret — left empty when `encrypted_invite_secret` is set.
    #[serde(default)]
    pub invite_secret: String,
    pub joiner_public_key: String,
    pub joiner_x25519_public_key: String,
    pub display_name: String,
    pub avatar_color: String,
    pub challenge_nonce: String,
    pub challenge_issued_at: String,
    pub challenge_token: String,
    pub timestamp: String,
    pub challenge_signature: String,
    /// Invite secret encrypted via `encrypt_for_recipient` to the community
    /// owner's X25519 public key, mirroring step 1 (InviteChallengeRequest).
    /// The receiver decrypts with their X25519 static secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_invite_secret: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelSnapshot {
    pub id: String,
    pub name: String,
    pub channel_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteJoinResponse {
    pub accepted: bool,
    pub reason: Option<String>,
    pub community_id: String,
    pub community_name: Option<String>,
    pub community_description: Option<String>,
    pub owner_public_key: Option<String>,
    pub wrapped_group_key: Option<Vec<u8>>,
    pub channels: Vec<ChannelSnapshot>,
    pub member_role: Option<String>,
    pub timestamp: String,
    pub signed_by: Option<String>,
    pub signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlLogRequest {
    pub community_id: String,
    pub since_timestamp: Option<String>,
    #[serde(default)]
    pub requester_public_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlLogResponse {
    pub community_id: String,
    pub events: Vec<crate::commands::control::ControlEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ControlRequest {
    InviteChallenge(InviteChallengeRequest),
    InviteJoin(InviteJoinRequest),
    ControlLog(ControlLogRequest),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ControlResponse {
    InviteChallenge(InviteChallengeResponse),
    InviteJoin(InviteJoinResponse),
    ControlLog(ControlLogResponse),
    Error { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRequest {
    pub file_hash: String,
    pub chunk_index: u32,
    /// Community that owns this file. The serving peer verifies
    /// that it belongs to this community before sending chunks.
    #[serde(default)]
    pub community_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileResponse {
    pub file_hash: String,
    pub chunk_index: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageHistoryRequest {
    pub channel_id: String,
    pub since_timestamp: Option<String>,
    pub since_id: Option<String>,
    pub limit: u32,
    #[serde(default)]
    pub requester_public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageHistoryResponse {
    pub channel_id: String,
    pub messages: Vec<crate::types::message::MessageDto>,
}

/// The combined network behaviour for Mesh.
/// - gossipsub: pub/sub messaging for communities
/// - kademlia: DHT for peer and community discovery
/// - mdns: local network peer discovery
/// - identify: protocol identification handshake
/// - ping: connection keepalive
/// - request_response: direct p2p stream for file chunk sharing
#[derive(NetworkBehaviour)]
pub struct MeshBehaviour {
    pub gossipsub: gossipsub::Behaviour,
    pub kademlia: kad::Behaviour<crate::network::dht_store::SqliteDhtStore>,
    pub mdns: mdns::tokio::Behaviour,
    pub identify: identify::Behaviour,
    pub ping: ping::Behaviour,
    pub file_sharing: request_response::cbor::Behaviour<FileRequest, FileResponse>,
    pub message_history:
        request_response::cbor::Behaviour<MessageHistoryRequest, MessageHistoryResponse>,
    pub control_log: request_response::cbor::Behaviour<ControlRequest, ControlResponse>,
    pub relay_client: relay::client::Behaviour,
    pub dcutr: dcutr::Behaviour,
    pub connection_limits: connection_limits::Behaviour,
}
