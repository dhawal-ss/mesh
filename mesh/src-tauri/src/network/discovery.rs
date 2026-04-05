/// Peer discovery mechanisms.
/// Mesh uses three complementary discovery methods:
///
/// 1. **mDNS** — Finds peers on the local network automatically.
///    Zero-configuration, works instantly on the same WiFi/LAN.
///
/// 2. **DHT (Kademlia)** — Finds peers across the internet.
///    Requires at least one bootstrap seed node to join the DHT.
///    Once connected, peers can find each other globally.
///
/// 3. **Relay (libp2p Circuit Relay v2)** — For peers behind strict NAT.
///    Relay nodes provide temporary connectivity until DCUtR hole-punching
///    establishes a direct connection.
///
/// Both methods feed discovered peers into gossipsub and kademlia routing tables.
/// The swarm event handler in `swarm.rs` handles both discovery event types.

/// Default public IPFS bootstrap peers.
/// These are well-known, stable nodes that participate in the
/// public Kademlia DHT. Mesh uses them as initial entry points
/// for DHT routing until dedicated Mesh bootstrap nodes are deployed.
const DEFAULT_BOOTSTRAP_PEERS: &[&str] = &[
    // IPFS bootstrap nodes (maintained by Protocol Labs)
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
];

/// Default bootstrap seed nodes for the DHT.
/// Prefers environment variable overrides, then falls back to
/// hardcoded public bootstrap nodes.
pub fn default_bootstrap_peers() -> Vec<String> {
    let mut peers = std::env::var("MESH_BOOTSTRAP_PEERS")
        .ok()
        .map(parse_bootstrap_peers)
        .unwrap_or_default();

    if peers.is_empty() {
        if let Ok(peer) = std::env::var("MESH_BOOTSTRAP_PEER") {
            let peer = peer.trim();
            if !peer.is_empty() {
                peers.push(peer.to_string());
            }
        }
    }

    // Fall back to hardcoded defaults if no env vars are set
    if peers.is_empty() {
        peers.extend(DEFAULT_BOOTSTRAP_PEERS.iter().map(|s| s.to_string()));
    }

    peers
}

/// Default relay nodes for NAT traversal.
/// Returns environment-configured relay nodes or empty list
/// (relay support is opt-in until dedicated relay infra is deployed).
#[allow(dead_code)]
pub fn default_relay_nodes() -> Vec<String> {
    std::env::var("MESH_RELAY_NODES")
        .ok()
        .map(parse_bootstrap_peers)
        .unwrap_or_default()
}

fn parse_bootstrap_peers(value: String) -> Vec<String> {
    value
        .split(|c: char| c == ',' || c == ';' || c.is_whitespace())
        .map(str::trim)
        .filter(|peer| !peer.is_empty())
        .map(str::to_string)
        .collect()
}
