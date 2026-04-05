/// DHT operations for peer and community discovery.
/// Mesh uses Kademlia DHT to:
/// 1. Register communities so new peers can find existing members
/// 2. Look up peers for a community when joining via invite link

/// DHT key for a community's peer registration.
pub fn community_dht_key(community_id: &str) -> String {
    format!("mesh/community/{}", community_id)
}

/// DHT key for public community discovery.
#[allow(dead_code)]
pub fn discovery_dht_key() -> &'static str {
    "mesh/discovery/public"
}
