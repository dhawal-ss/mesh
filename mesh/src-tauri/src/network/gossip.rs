/// Gossip topic naming conventions for Mesh.
/// Every community uses exactly these topic patterns:

/// Topic for all signed community message traffic in a community.
/// DEPRECATED: Retained for backward compatibility during the transition to
/// per-channel topics. New code should use `community_meta_topic` for control
/// events and `channel_messages_topic` for chat messages.
#[allow(dead_code)]
pub fn community_messages_topic(community_id: &str) -> String {
    format!("mesh/community/{}/messages", community_id)
}

/// Meta topic for control events, presence, bans, key rotation, member
/// join/leave. All community members are always subscribed to this topic.
#[allow(dead_code)]
pub fn community_meta_topic(community_id: &str) -> String {
    format!("mesh/community/{}/meta", community_id)
}

/// Per-channel topic for chat messages, reactions, and file announcements.
/// Peers subscribe only when actively viewing the channel.
#[allow(dead_code)]
pub fn channel_messages_topic(community_id: &str, channel_id: &str) -> String {
    format!(
        "mesh/community/{}/channel/{}/messages",
        community_id, channel_id
    )
}

/// Topic for online/offline presence announcements.
#[allow(dead_code)]
pub fn community_presence_topic(community_id: &str) -> String {
    format!("mesh/community/{}/presence", community_id)
}

/// Topic for WebRTC signaling in a voice channel, scoped by community.
#[allow(dead_code)]
pub fn voice_signal_topic(community_id: &str, channel_id: &str) -> String {
    format!(
        "mesh/community/{}/voice/{}/signal",
        community_id, channel_id
    )
}
