use libp2p::{
    connection_limits, dcutr,
    gossipsub::{self, Message as GossipMessage, MessageAuthenticity, MessageId},
    identify, kad, mdns, noise, ping, request_response,
    swarm::SwarmEvent,
    tcp, yamux, Multiaddr, PeerId, SwarmBuilder,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::network::behaviour::{MeshBehaviour, MeshBehaviourEvent, MessageHistoryRequest};
use crate::network::dht::community_dht_key;
use crate::network::dht_store::SqliteDhtStore;
use crate::network::events::{NetworkCommand, NetworkEvent, NetworkHandle};
use crate::state::file_downloads::CHUNK_SIZE_BYTES;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CommunityDhtRegistration {
    peer_id: String,
    addrs: Vec<String>,
}

/// Start the libp2p network in a background Tokio task.
/// Returns a NetworkHandle for sending commands.
pub async fn start_network(
    private_key_bytes: [u8; 32],
    bootstrap_peers: Vec<String>,
    event_tx: mpsc::Sender<NetworkEvent>,
    app_data_dir: PathBuf,
) -> anyhow::Result<NetworkHandle> {
    let (command_tx, mut command_rx) = mpsc::channel::<NetworkCommand>(256);

    tokio::spawn(async move {
        let mut registered_communities = HashSet::new();
        let mut swarm = match build_swarm(private_key_bytes, app_data_dir).await {
            Ok(s) => s,
            Err(e) => {
                error!("Failed to build swarm: {}", e);
                return;
            }
        };

        // SAFETY: These multiaddr strings are compile-time constants with well-known
        // valid format. The parse cannot fail for these fixed strings.
        if let Err(e) = swarm.listen_on(
            "/ip4/0.0.0.0/tcp/0"
                .parse()
                .expect("BUG: invalid compile-time multiaddr constant"),
        ) {
            warn!("Failed to listen on TCP: {}", e);
        }
        if let Err(e) = swarm.listen_on(
            "/ip4/0.0.0.0/udp/0/quic-v1"
                .parse()
                .expect("BUG: invalid compile-time multiaddr constant"),
        ) {
            warn!("Failed to listen on QUIC: {}", e);
        }

        // Bootstrap into DHT
        for peer_addr_str in &bootstrap_peers {
            if let Ok(addr) = peer_addr_str.parse::<Multiaddr>() {
                if let Err(e) = swarm.dial(addr.clone()) {
                    warn!("Failed to dial bootstrap peer {}: {}", peer_addr_str, e);
                } else {
                    info!("Dialing bootstrap peer: {}", peer_addr_str);
                }
            }
        }

        let _ = event_tx.send(NetworkEvent::NetworkReady).await;

        let mut file_paths: HashMap<String, (std::path::PathBuf, String)> = HashMap::new();
        let mut community_members: HashMap<String, HashSet<String>> = HashMap::new();

        // Re-publish DHT registrations every 2 hours so records don't expire
        let mut dht_refresh_interval = tokio::time::interval(Duration::from_secs(2 * 3600));
        // The first tick completes immediately; skip it since we register on join
        dht_refresh_interval.tick().await;

        loop {
            tokio::select! {
                event = swarm.select_next_some() => {
                    handle_swarm_event(
                        &mut swarm,
                        event,
                        &event_tx,
                        &file_paths,
                        &registered_communities,
                        &community_members,
                    )
                    .await;
                }
                command = command_rx.recv() => {
                    match command {
                        Some(cmd) => handle_command(
                            &mut swarm,
                            cmd,
                            &event_tx,
                            &mut file_paths,
                            &mut registered_communities,
                            &mut community_members,
                        )
                        .await,
                        None => break, // Channel closed, shutdown
                    }
                }
                _ = dht_refresh_interval.tick() => {
                    info!("Re-publishing DHT registrations for {} communities", registered_communities.len());
                    for community_id in registered_communities.iter() {
                        register_community_in_dht(&mut swarm, community_id);
                    }
                }
            }
        }
    });

    Ok(NetworkHandle { command_tx })
}

async fn build_swarm(
    private_key_bytes: [u8; 32],
    app_data_dir: PathBuf,
) -> anyhow::Result<libp2p::Swarm<MeshBehaviour>> {
    // We persist the raw 32-byte Ed25519 secret in the keychain, so promote that
    // into a libp2p keypair instead of trying to decode a 64-byte keypair blob.
    let ed25519_secret = libp2p::identity::ed25519::SecretKey::try_from_bytes(private_key_bytes)?;
    let ed25519_keypair = libp2p::identity::ed25519::Keypair::from(ed25519_secret);
    let keypair = libp2p::identity::Keypair::from(ed25519_keypair);
    let peer_id = PeerId::from_public_key(&keypair.public());

    info!("Local PeerId: {}", peer_id);

    // Gossipsub config — tuned for community messaging
    let gossipsub_config = gossipsub::ConfigBuilder::default()
        .heartbeat_interval(Duration::from_secs(10))
        .validation_mode(gossipsub::ValidationMode::Strict)
        .message_id_fn(|msg: &GossipMessage| {
            let source = msg
                .source
                .map(|peer| peer.to_string())
                .unwrap_or_else(|| "unknown".to_string());
            let seqno = msg
                .sequence_number
                .map(|seq| seq.to_string())
                .unwrap_or_else(|| "no-seq".to_string());
            MessageId::from(format!("{source}:{seqno}"))
        })
        .max_transmit_size(512 * 1024) // 512KB max message
        .build()
        .map_err(|e| anyhow::anyhow!(e))?;

    let mut gossipsub = gossipsub::Behaviour::new(
        MessageAuthenticity::Signed(keypair.clone()),
        gossipsub_config,
    )
    .map_err(|e| anyhow::anyhow!(e))?;

    // Peer scoring — penalise misbehaving peers (spam, sybil, slow delivery)
    let peer_score_params = gossipsub::PeerScoreParams {
        decay_interval: Duration::from_secs(60),
        decay_to_zero: 0.01,
        retain_score: Duration::from_secs(3600),
        ..Default::default()
    };
    let peer_score_thresholds = gossipsub::PeerScoreThresholds {
        gossip_threshold: -100.0,
        publish_threshold: -200.0,
        graylist_threshold: -300.0,
        opportunistic_graft_threshold: 5.0,
        ..Default::default()
    };
    gossipsub
        .with_peer_score(peer_score_params, peer_score_thresholds)
        .map_err(|e| anyhow::anyhow!(e))?;

    // Kademlia DHT — persistent SQLite-backed store so routing state
    // survives app restarts, eliminating cold-start bootstrap delays.
    let dht_store = SqliteDhtStore::new(app_data_dir, peer_id)?;
    let mut kademlia = kad::Behaviour::new(peer_id, dht_store);
    kademlia.set_mode(Some(kad::Mode::Server));

    let swarm = SwarmBuilder::with_existing_identity(keypair.clone())
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )?
        .with_quic()
        .with_relay_client(noise::Config::new, yamux::Config::default)?
        .with_behaviour(|key, relay_client| {
            Ok(MeshBehaviour {
                gossipsub,
                kademlia,
                mdns: mdns::tokio::Behaviour::new(
                    mdns::Config::default(),
                    key.public().to_peer_id(),
                )?,
                identify: identify::Behaviour::new(identify::Config::new(
                    "/mesh/1.0.0".to_string(),
                    key.public(),
                )),
                ping: ping::Behaviour::new(ping::Config::new()),
                file_sharing: request_response::cbor::Behaviour::new(
                    [(
                        libp2p::StreamProtocol::new("/mesh/file/1.0.0"),
                        request_response::ProtocolSupport::Full,
                    )],
                    request_response::Config::default()
                        .with_request_timeout(Duration::from_secs(60)),
                ),
                message_history: request_response::cbor::Behaviour::new(
                    [(
                        libp2p::StreamProtocol::new("/mesh/history/1.0.0"),
                        request_response::ProtocolSupport::Full,
                    )],
                    request_response::Config::default()
                        .with_request_timeout(Duration::from_secs(45)),
                ),
                control_log: request_response::cbor::Behaviour::new(
                    [(
                        libp2p::StreamProtocol::new("/mesh/control/1.0.0"),
                        request_response::ProtocolSupport::Full,
                    )],
                    request_response::Config::default()
                        .with_request_timeout(Duration::from_secs(45)),
                ),
                relay_client,
                dcutr: dcutr::Behaviour::new(key.public().to_peer_id()),
                connection_limits: connection_limits::Behaviour::new(
                    connection_limits::ConnectionLimits::default()
                        .with_max_established_incoming(Some(128))
                        .with_max_established_outgoing(Some(128))
                        .with_max_pending_incoming(Some(32))
                        .with_max_pending_outgoing(Some(32)),
                ),
            })
        })?
        .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(300)))
        .build();

    Ok(swarm)
}

use futures::StreamExt;

async fn handle_swarm_event(
    swarm: &mut libp2p::Swarm<MeshBehaviour>,
    event: SwarmEvent<MeshBehaviourEvent>,
    event_tx: &mpsc::Sender<NetworkEvent>,
    file_paths: &HashMap<String, (std::path::PathBuf, String)>,
    registered_communities: &HashSet<String>,
    community_members: &HashMap<String, HashSet<String>>,
) {
    match event {
        SwarmEvent::Behaviour(MeshBehaviourEvent::Gossipsub(gossipsub::Event::Message {
            propagation_source,
            message,
            ..
        })) => {
            let topic = message.topic.to_string();
            let from = propagation_source.to_string();
            let _ = event_tx
                .send(NetworkEvent::GossipMessage {
                    topic,
                    data: message.data,
                    from,
                })
                .await;
        }
        SwarmEvent::Behaviour(MeshBehaviourEvent::Kademlia(event)) => {
            handle_kademlia_event(swarm, event, event_tx).await;
        }
        SwarmEvent::Behaviour(MeshBehaviourEvent::Mdns(mdns::Event::Discovered(list))) => {
            for (peer_id, addr) in list {
                info!("mDNS discovered: {} at {}", peer_id, addr);
                swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                swarm
                    .behaviour_mut()
                    .kademlia
                    .add_address(&peer_id, addr.clone());
                let _ = event_tx
                    .send(NetworkEvent::PeerDiscovered {
                        peer_id: peer_id.to_string(),
                        addrs: vec![addr.to_string()],
                        community_id: None,
                    })
                    .await;
            }
        }
        SwarmEvent::Behaviour(MeshBehaviourEvent::Mdns(mdns::Event::Expired(list))) => {
            for (peer_id, _addr) in list {
                info!("mDNS expired: {}", peer_id);
                swarm
                    .behaviour_mut()
                    .gossipsub
                    .remove_explicit_peer(&peer_id);
            }
        }
        SwarmEvent::ConnectionEstablished { peer_id, .. } => {
            info!("Connected to: {}", peer_id);
            let _ = event_tx
                .send(NetworkEvent::PeerConnected {
                    peer_id: peer_id.to_string(),
                })
                .await;
        }
        SwarmEvent::ConnectionClosed { peer_id, .. } => {
            info!("Disconnected from: {}", peer_id);
            let _ = event_tx
                .send(NetworkEvent::PeerDisconnected {
                    peer_id: peer_id.to_string(),
                })
                .await;
        }
        SwarmEvent::NewListenAddr { address, .. } => {
            info!("Listening on: {}", address);
            for community_id in registered_communities {
                register_community_in_dht(swarm, community_id);
            }
        }
        SwarmEvent::ExternalAddrConfirmed { address } => {
            info!("External address confirmed: {}", address);
            for community_id in registered_communities {
                register_community_in_dht(swarm, community_id);
            }
        }
        SwarmEvent::Behaviour(MeshBehaviourEvent::FileSharing(event)) => {
            match event {
                libp2p::request_response::Event::Message { peer, message } => {
                    match message {
                        libp2p::request_response::Message::Request {
                            request, channel, ..
                        } => {
                            let mut data = vec![];

                            // S4: Authenticate file chunk requests.
                            // Verify the request includes a community_id, that we
                            // serve the file for that community, and that the community
                            // matches the file's owning community. Without a full
                            // membership roster in the swarm task we cannot do per-user
                            // membership checks here, but we reject requests with
                            // missing or mismatched community_id.
                            let mut rejected = false;
                            if request.community_id.is_empty() {
                                warn!(
                                    "Rejecting file chunk request from {} for {} — missing community_id",
                                    peer, request.file_hash
                                );
                                rejected = true;
                            } else if !registered_communities.contains(&request.community_id) {
                                warn!(
                                    "Rejecting file chunk request from {} for {} — we are not in community {}",
                                    peer, request.file_hash, request.community_id
                                );
                                rejected = true;
                            }

                            // Require signed file requests
                            if !rejected {
                                if request.requester_public_key.is_empty()
                                    || request.request_signature.is_empty()
                                {
                                    warn!("Rejecting unsigned file request from {}", peer);
                                    rejected = true;
                                } else {
                                    let signable = format!(
                                        "file-req:{}:{}:{}",
                                        request.file_hash,
                                        request.chunk_index,
                                        request.requester_public_key
                                    );
                                    if !crate::crypto::identity::verify_signature(
                                        &request.requester_public_key,
                                        signable.as_bytes(),
                                        &request.request_signature,
                                    )
                                    .unwrap_or(false)
                                    {
                                        warn!(
                                            "Rejecting file request — invalid signature from {}",
                                            peer
                                        );
                                        rejected = true;
                                    }
                                }
                            }

                            // Verify requester is an active member of the community.
                            // Fail-closed: if no roster is cached, reject the request.
                            // Rosters are synced on startup and on membership changes,
                            // so an uncached roster means we haven't finished init yet.
                            if !rejected && !request.requester_public_key.is_empty() {
                                match community_members.get(&request.community_id) {
                                    Some(members) => {
                                        if !members.contains(&request.requester_public_key) {
                                            warn!(
                                                "Rejecting file request from non-member {} for community {}",
                                                request.requester_public_key, request.community_id
                                            );
                                            rejected = true;
                                        }
                                    }
                                    None => {
                                        warn!(
                                            "Rejecting file request for community {} — membership roster not yet cached",
                                            request.community_id
                                        );
                                        rejected = true;
                                    }
                                }
                            }

                            if !rejected {
                                if let Some((path, file_community_id)) =
                                    file_paths.get(&request.file_hash)
                                {
                                    if *file_community_id != request.community_id {
                                        warn!(
                                            "Rejecting file chunk request from {} for {} — community_id mismatch (expected {}, got {})",
                                            peer, request.file_hash, file_community_id, request.community_id
                                        );
                                    } else if let Ok(mut f) = std::fs::File::open(path) {
                                        use std::io::{Read, Seek};
                                        let offset =
                                            (request.chunk_index as u64) * CHUNK_SIZE_BYTES;
                                        if f.seek(std::io::SeekFrom::Start(offset)).is_ok() {
                                            let mut buffer = vec![0; CHUNK_SIZE_BYTES as usize];
                                            if let Ok(n) = f.read(&mut buffer) {
                                                buffer.truncate(n);
                                                data = buffer;
                                            }
                                        }
                                    }
                                }
                            }

                            let _ = swarm.behaviour_mut().file_sharing.send_response(
                                channel,
                                crate::network::behaviour::FileResponse {
                                    file_hash: request.file_hash,
                                    chunk_index: request.chunk_index,
                                    data,
                                },
                            );
                        }
                        libp2p::request_response::Message::Response {
                            request_id: _,
                            response,
                        } => {
                            // Forward chunk up to app
                            let _ = event_tx
                                .send(NetworkEvent::FileChunkReceived {
                                    file_hash: response.file_hash,
                                    chunk_index: response.chunk_index,
                                    data: response.data,
                                })
                                .await;
                        }
                    }
                }
                request_response::Event::OutboundFailure {
                    request_id, error, ..
                } => {
                    warn!("File sharing request {} failed: {}", request_id, error);
                    let _ = event_tx
                        .send(NetworkEvent::RequestFailed {
                            protocol: "file_sharing".to_string(),
                            reason: error.to_string(),
                        })
                        .await;
                }
                request_response::Event::InboundFailure { error, .. } => {
                    warn!("File sharing inbound request failed: {}", error);
                }
                event => {
                    tracing::debug!("Unhandled file sharing event: {:?}", event);
                }
            }
        }
        SwarmEvent::Behaviour(MeshBehaviourEvent::MessageHistory(event)) => match event {
            libp2p::request_response::Event::Message { peer, message } => match message {
                libp2p::request_response::Message::Request {
                    request, channel, ..
                } => {
                    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                    let _ = event_tx
                        .send(NetworkEvent::MessageHistoryRequested {
                            peer_id: peer.to_string(),
                            request,
                            reply: reply_tx,
                        })
                        .await;

                    match reply_rx.await {
                        Ok(response) => {
                            let _ = swarm
                                .behaviour_mut()
                                .message_history
                                .send_response(channel, response);
                        }
                        Err(error) => {
                            warn!(
                                "Failed to build message history response for {}: {}",
                                peer, error
                            );
                        }
                    }
                }
                libp2p::request_response::Message::Response { response, .. } => {
                    let _ = event_tx
                        .send(NetworkEvent::MessageHistoryReceived {
                            peer_id: peer.to_string(),
                            response,
                        })
                        .await;
                }
            },
            request_response::Event::OutboundFailure {
                request_id, error, ..
            } => {
                warn!("Message history request {} failed: {}", request_id, error);
                let _ = event_tx
                    .send(NetworkEvent::RequestFailed {
                        protocol: "message_history".to_string(),
                        reason: error.to_string(),
                    })
                    .await;
            }
            request_response::Event::InboundFailure { error, .. } => {
                warn!("Message history inbound request failed: {}", error);
            }
            event => {
                tracing::debug!("Unhandled message history event: {:?}", event);
            }
        },
        SwarmEvent::Behaviour(MeshBehaviourEvent::ControlLog(event)) => match event {
            libp2p::request_response::Event::Message { peer, message } => match message {
                libp2p::request_response::Message::Request {
                    request, channel, ..
                } => {
                    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                    let _ = event_tx
                        .send(NetworkEvent::ControlRequestReceived {
                            peer_id: peer.to_string(),
                            request,
                            reply: reply_tx,
                        })
                        .await;

                    match reply_rx.await {
                        Ok(response) => {
                            let _ = swarm
                                .behaviour_mut()
                                .control_log
                                .send_response(channel, response);
                        }
                        Err(error) => {
                            warn!("Failed to build control response for {}: {}", peer, error);
                        }
                    }
                }
                libp2p::request_response::Message::Response { response, .. } => {
                    let _ = event_tx
                        .send(NetworkEvent::ControlResponseReceived {
                            peer_id: peer.to_string(),
                            response,
                        })
                        .await;
                }
            },
            request_response::Event::OutboundFailure {
                request_id, error, ..
            } => {
                warn!("Control log request {} failed: {}", request_id, error);
                let _ = event_tx
                    .send(NetworkEvent::RequestFailed {
                        protocol: "control_log".to_string(),
                        reason: error.to_string(),
                    })
                    .await;
            }
            request_response::Event::InboundFailure { error, .. } => {
                warn!("Control log inbound request failed: {}", error);
            }
            event => {
                tracing::debug!("Unhandled control log event: {:?}", event);
            }
        },
        event => {
            tracing::debug!("Unhandled swarm event: {:?}", event);
        }
    }
}

async fn handle_command(
    swarm: &mut libp2p::Swarm<MeshBehaviour>,
    cmd: NetworkCommand,
    event_tx: &mpsc::Sender<NetworkEvent>,
    file_paths: &mut HashMap<String, (std::path::PathBuf, String)>,
    registered_communities: &mut HashSet<String>,
    community_members: &mut HashMap<String, HashSet<String>>,
) {
    match cmd {
        NetworkCommand::SubscribeTopic { topic } => {
            let topic_hash = gossipsub::IdentTopic::new(&topic);
            if let Err(e) = swarm.behaviour_mut().gossipsub.subscribe(&topic_hash) {
                warn!("Failed to subscribe to topic {}: {}", topic, e);
            } else {
                // S15: Apply per-topic score params so topic-level spam detection is active.
                let _ = swarm
                    .behaviour_mut()
                    .gossipsub
                    .set_topic_params(topic_hash, mesh_topic_score_params());
                info!("Subscribed to topic: {}", topic);
            }
        }
        NetworkCommand::UnsubscribeTopic { topic } => {
            let topic_hash = gossipsub::IdentTopic::new(&topic);
            if let Err(e) = swarm.behaviour_mut().gossipsub.unsubscribe(&topic_hash) {
                warn!("Failed to unsubscribe from topic {}: {}", topic, e);
            }
        }
        NetworkCommand::SubscribeChannel {
            community_id,
            channel_id,
        } => {
            let topic = crate::network::gossip::channel_messages_topic(&community_id, &channel_id);
            let topic_hash = gossipsub::IdentTopic::new(&topic);
            if let Err(e) = swarm.behaviour_mut().gossipsub.subscribe(&topic_hash) {
                warn!("Failed to subscribe to channel topic {}: {}", topic, e);
            } else {
                // S15: Apply per-topic score params so topic-level spam detection is active.
                let _ = swarm
                    .behaviour_mut()
                    .gossipsub
                    .set_topic_params(topic_hash, mesh_topic_score_params());
                info!("Subscribed to channel topic: {}", topic);
            }
        }
        NetworkCommand::UnsubscribeChannel {
            community_id,
            channel_id,
        } => {
            let topic = crate::network::gossip::channel_messages_topic(&community_id, &channel_id);
            let topic_hash = gossipsub::IdentTopic::new(&topic);
            if let Err(e) = swarm.behaviour_mut().gossipsub.unsubscribe(&topic_hash) {
                warn!("Failed to unsubscribe from channel topic {}: {}", topic, e);
            } else {
                info!("Unsubscribed from channel topic: {}", topic);
            }
        }
        NetworkCommand::PublishMessage { topic, data } => {
            let topic_hash = gossipsub::IdentTopic::new(&topic);
            match swarm
                .behaviour_mut()
                .gossipsub
                .publish(topic_hash, data.clone())
            {
                Ok(_) => {
                    // Published successfully to at least one peer
                }
                Err(gossipsub::PublishError::InsufficientPeers) => {
                    // Running solo — we're the only subscriber. The message
                    // is already stored in our local DB by send_message, so
                    // the user sees it. We silently drop the gossip publish
                    // because there's no one to propagate to. When another
                    // peer subscribes and connects, they'll pick up this
                    // message via the message history request-response
                    // protocol, not via gossip re-play.
                    //
                    // NOTE: we deliberately do NOT queue as "pending". The
                    // pending queue is for real publish failures (transient
                    // mesh glitches, rate limit, etc.), not the normal
                    // solo-peer case. Queueing solo sends would make every
                    // local user see a scary "N messages pending" counter.
                    tracing::debug!(
                        target: "mesh::gossip",
                        topic = %topic,
                        "Solo publish — no other subscribers, message stored locally only"
                    );
                }
                Err(e) => {
                    warn!(
                        "Failed to publish message to {}: {} — queuing for retry",
                        topic, e
                    );
                    let _ = event_tx
                        .send(NetworkEvent::PublishFailed { topic, data })
                        .await;
                }
            }
        }
        NetworkCommand::ConnectPeer { addr } => {
            if let Ok(multiaddr) = addr.parse::<Multiaddr>() {
                if let Err(e) = swarm.dial(multiaddr) {
                    warn!("Failed to dial {}: {}", addr, e);
                }
            }
        }
        NetworkCommand::SeedPeerAddresses { peer_id, addrs } => {
            let Ok(peer_id) = peer_id.parse::<PeerId>() else {
                warn!("Ignoring cached discovery with invalid peer id");
                return;
            };
            for addr in addrs {
                match addr.parse::<Multiaddr>() {
                    Ok(addr) => {
                        swarm
                            .behaviour_mut()
                            .kademlia
                            .add_address(&peer_id, addr.clone());
                        let _ = swarm.dial(addr);
                    }
                    Err(error) => {
                        warn!("Ignoring invalid cached address {}: {}", addr, error);
                    }
                }
            }
        }
        NetworkCommand::RegisterInDHT { community_id } => {
            registered_communities.insert(community_id.clone());
            register_community_in_dht(swarm, &community_id);
        }
        NetworkCommand::UnregisterFromDHT { community_id } => {
            registered_communities.remove(&community_id);
            info!(
                "Stopped DHT registration refresh for community {}",
                community_id
            );
        }
        NetworkCommand::FindPeers { community_id } => {
            let key = kad::RecordKey::new(&community_dht_key(&community_id));
            swarm.behaviour_mut().kademlia.get_record(key);
        }
        NetworkCommand::GetPeerCount => {
            let count = swarm.connected_peers().count();
            let _ = event_tx.send(NetworkEvent::PeerCount { count }).await;
        }
        NetworkCommand::GetExternalAddrs { reply } => {
            let addrs: Vec<String> = swarm
                .external_addresses()
                .map(|addr: &Multiaddr| addr.to_string())
                .collect();
            let _ = reply.send(addrs);
        }
        NetworkCommand::RequestFileChunk {
            peer_id,
            file_hash,
            chunk_index,
            community_id,
            requester_public_key,
            request_signature,
        } => {
            if let Ok(peer) = peer_id.parse::<PeerId>() {
                swarm.behaviour_mut().file_sharing.send_request(
                    &peer,
                    crate::network::behaviour::FileRequest {
                        file_hash,
                        chunk_index,
                        community_id,
                        requester_public_key,
                        request_signature,
                    },
                );
            }
        }
        NetworkCommand::RequestMessageHistory {
            peer_id,
            channel_id,
            since_timestamp,
            since_id,
            limit,
            requester_public_key,
            request_signature,
            request_timestamp,
        } => {
            if let Some(explicit_peer) = peer_id.and_then(|id| id.parse::<PeerId>().ok()) {
                // Explicit peer requested — send to that peer only.
                swarm.behaviour_mut().message_history.send_request(
                    &explicit_peer,
                    MessageHistoryRequest {
                        channel_id,
                        since_timestamp,
                        since_id,
                        limit,
                        requester_public_key,
                        request_signature,
                        request_timestamp,
                    },
                );
            } else {
                // No specific peer requested — pick from connected peers.
                // Request from up to 2 peers to mitigate single-peer censorship.
                let peers: Vec<PeerId> = swarm.connected_peers().take(2).cloned().collect();
                if peers.is_empty() {
                    warn!(
                        "Skipping message history request for {}: no connected peers",
                        channel_id
                    );
                    return;
                }
                if peers.len() == 1 {
                    warn!(
                        "History sync for channel {} is using only 1 peer ({}). \
                         A single peer can censor messages — connect to more peers for reliability.",
                        channel_id, peers[0]
                    );
                }
                for (i, target_peer) in peers.iter().enumerate() {
                    info!(
                        "Requesting message history for {} from peer {}/{}: {}",
                        channel_id,
                        i + 1,
                        peers.len(),
                        target_peer,
                    );
                    swarm.behaviour_mut().message_history.send_request(
                        target_peer,
                        MessageHistoryRequest {
                            channel_id: channel_id.clone(),
                            since_timestamp: since_timestamp.clone(),
                            since_id: since_id.clone(),
                            limit,
                            requester_public_key: requester_public_key.clone(),
                            request_signature: request_signature.clone(),
                            request_timestamp: request_timestamp.clone(),
                        },
                    );
                }
            }
        }
        NetworkCommand::RequestControl { peer_id, request } => {
            let target_peer = peer_id
                .and_then(|peer_id| peer_id.parse::<PeerId>().ok())
                .or_else(|| swarm.connected_peers().next().cloned());

            let Some(target_peer) = target_peer else {
                warn!("Skipping control request: no connected peers");
                return;
            };

            swarm
                .behaviour_mut()
                .control_log
                .send_request(&target_peer, request);
        }
        NetworkCommand::ServeFile {
            file_hash,
            path,
            community_id,
        } => {
            file_paths.insert(file_hash, (path, community_id));
        }
        NetworkCommand::UpdateCommunityMembers {
            community_id,
            member_public_keys,
        } => {
            info!(
                "Updated membership roster for community {} ({} members)",
                community_id,
                member_public_keys.len()
            );
            community_members.insert(community_id, member_public_keys.into_iter().collect());
        }
    }
}

fn register_community_in_dht(swarm: &mut libp2p::Swarm<MeshBehaviour>, community_id: &str) {
    let key = kad::RecordKey::new(&community_dht_key(community_id));
    let peer_id = *swarm.local_peer_id();
    let addrs = collect_dialable_addresses(swarm, peer_id);
    if addrs.is_empty() {
        warn!(
            "Skipping DHT registration for {} because no dialable addresses are available yet",
            community_id
        );
        return;
    }

    let registration = CommunityDhtRegistration {
        peer_id: peer_id.to_string(),
        addrs: addrs.iter().map(|addr| addr.to_string()).collect(),
    };
    let value = match serde_json::to_vec(&registration) {
        Ok(value) => value,
        Err(error) => {
            warn!(
                "Failed to serialize DHT registration for {}: {}",
                community_id, error
            );
            return;
        }
    };
    let record = kad::Record {
        key,
        value,
        publisher: Some(peer_id),
        expires: Some(std::time::Instant::now() + Duration::from_secs(4 * 3600)),
    };
    if let Err(error) = swarm
        .behaviour_mut()
        .kademlia
        .put_record(record, kad::Quorum::Majority)
    {
        warn!("Failed to register in DHT for {}: {}", community_id, error);
    }
}

async fn handle_kademlia_event(
    swarm: &mut libp2p::Swarm<MeshBehaviour>,
    event: kad::Event,
    event_tx: &mpsc::Sender<NetworkEvent>,
) {
    match event {
        kad::Event::OutboundQueryProgressed { result, .. } => match result {
            kad::QueryResult::GetRecord(Ok(kad::GetRecordOk::FoundRecord(peer_record))) => {
                let kad::PeerRecord { peer, record } = peer_record;
                let community_id = String::from_utf8(record.key.to_vec())
                    .ok()
                    .and_then(|value| value.rsplit('/').next().map(ToString::to_string));

                match serde_json::from_slice::<CommunityDhtRegistration>(&record.value) {
                    Ok(registration) => {
                        let peer_id = registration
                            .peer_id
                            .parse::<PeerId>()
                            .ok()
                            .or(peer)
                            .or(record.publisher);

                        let Some(peer_id) = peer_id else {
                            warn!("Ignoring DHT record without a valid peer ID");
                            return;
                        };
                        let peer_id_string = peer_id.to_string();
                        let mut addrs = Vec::new();
                        for addr_str in registration.addrs {
                            match addr_str.parse::<Multiaddr>() {
                                Ok(addr) => {
                                    swarm
                                        .behaviour_mut()
                                        .kademlia
                                        .add_address(&peer_id, addr.clone());
                                    if swarm.dial(addr.clone()).is_ok() {
                                        info!(
                                            "Dialing peer from DHT lookup: {} at {}",
                                            peer_id_string, addr
                                        );
                                    }
                                    addrs.push(addr.to_string());
                                }
                                Err(e) => {
                                    warn!(
                                        "Ignoring invalid DHT address for {}: {} ({})",
                                        peer_id_string, addr_str, e
                                    );
                                }
                            }
                        }

                        if !addrs.is_empty() {
                            let _ = event_tx
                                .send(NetworkEvent::PeerDiscovered {
                                    peer_id: peer_id_string,
                                    addrs,
                                    community_id: community_id.clone(),
                                })
                                .await;
                        }
                    }
                    Err(e) => {
                        warn!("Failed to decode DHT community record: {}", e);
                    }
                }
            }
            kad::QueryResult::GetRecord(Ok(kad::GetRecordOk::FinishedWithNoAdditionalRecord {
                cache_candidates,
            })) => {
                if !cache_candidates.is_empty() {
                    info!(
                        "DHT lookup completed without a record; cache candidates available: {}",
                        cache_candidates.len()
                    );
                }
            }
            kad::QueryResult::GetRecord(Err(e)) => {
                warn!("DHT community lookup failed: {}", e);
            }
            kad::QueryResult::PutRecord(Ok(_)) => {
                info!("DHT community registration stored successfully");
            }
            kad::QueryResult::PutRecord(Err(e)) => {
                warn!("DHT community registration failed: {}", e);
            }
            result => {
                tracing::debug!("Unhandled kademlia query result: {:?}", result);
            }
        },
        event => {
            tracing::debug!("Unhandled kademlia event: {:?}", event);
        }
    }
}

fn collect_dialable_addresses(
    swarm: &libp2p::Swarm<MeshBehaviour>,
    peer_id: PeerId,
) -> Vec<Multiaddr> {
    let mut seen = HashSet::new();
    let mut addrs: Vec<Multiaddr> = swarm.external_addresses().cloned().collect();

    if addrs.is_empty() {
        addrs.extend(
            swarm
                .listeners()
                .filter(|addr| !is_unspecified_addr(addr))
                .cloned(),
        );
    }

    addrs
        .into_iter()
        .map(|addr: Multiaddr| match addr.with_p2p(peer_id) {
            Ok(addr) => addr,
            Err(addr) => addr,
        })
        .filter(|addr: &Multiaddr| seen.insert(addr.to_string()))
        .collect()
}

fn is_unspecified_addr(addr: &Multiaddr) -> bool {
    let addr = addr.to_string();
    addr.contains("/ip4/0.0.0.0/")
        || addr.contains("/ip6/::/")
        || addr.ends_with("/ip4/0.0.0.0")
        || addr.ends_with("/ip6/::")
}

/// S15: Default per-topic GossipSub score parameters for Mesh topics.
///
/// Without explicit topic params, `PeerScoreParams::default()` has an empty
/// `topics` map, which makes topic-level spam detection (P1-P4) completely
/// inert. These params are applied to every topic on subscription.
fn mesh_topic_score_params() -> gossipsub::TopicScoreParams {
    gossipsub::TopicScoreParams {
        topic_weight: 1.0,
        // P1: time in mesh — small positive reward for stable mesh participation
        time_in_mesh_weight: 0.01,
        time_in_mesh_quantum: Duration::from_secs(1),
        time_in_mesh_cap: 3600.0,
        // P2: first message deliveries — reward peers that deliver new messages first
        first_message_deliveries_weight: 1.0,
        first_message_deliveries_decay: 0.97,
        first_message_deliveries_cap: 100.0,
        // P3: mesh message deliveries — disabled (weight 0) to avoid penalising
        // low-traffic community topics that legitimately have few messages
        mesh_message_deliveries_weight: 0.0,
        mesh_message_deliveries_decay: 0.97,
        mesh_message_deliveries_cap: 100.0,
        mesh_message_deliveries_threshold: 1.0,
        mesh_message_deliveries_window: Duration::from_millis(500),
        mesh_message_deliveries_activation: Duration::from_secs(60),
        // P3b: mesh failure penalty — disabled along with P3
        mesh_failure_penalty_weight: 0.0,
        mesh_failure_penalty_decay: 0.97,
        // P4: invalid messages — strong penalty for peers that deliver invalid messages
        invalid_message_deliveries_weight: -10.0,
        invalid_message_deliveries_decay: 0.3,
    }
}
