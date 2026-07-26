use std::collections::HashSet;
use std::path::PathBuf;

use libp2p::PeerId;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_runtime;
use crate::crypto::encryption;
use crate::crypto::identity::Identity;
use crate::network::envelope::{EnvelopeBuilder, FileAnnouncedPayload};
use crate::network::events::NetworkCommand;
use crate::network::gossip::channel_messages_topic;
use crate::security::has_blocked_attachment_extension;
use crate::state::download_scheduler::DownloadScheduler;
use crate::state::file_downloads::CHUNK_SIZE_BYTES;
use crate::state::rate_limits::RateLimitBucket;
use crate::state::AppState;
use crate::storage::Database;

use super::error::CommandError;

/// Maximum allowed file size for uploads (100 MB).
const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024;

#[tauri::command]
pub async fn upload_file(
    channel_id: String,
    file_path: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<String, CommandError> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(CommandError::NotFound("File does not exist".into()));
    }

    let file_name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let size = std::fs::metadata(&path)
        .map_err(|e| CommandError::Other(e.to_string()))?
        .len();

    // S6: File size validation
    if size > MAX_FILE_SIZE {
        return Err(CommandError::Validation(format!(
            "File too large ({:.1} MB). Maximum allowed size is {:.0} MB.",
            size as f64 / (1024.0 * 1024.0),
            MAX_FILE_SIZE as f64 / (1024.0 * 1024.0)
        )));
    }

    // S6: Blocked file type validation
    if has_blocked_attachment_extension(&path) {
        return Err(CommandError::Validation(
            "This executable or script file type cannot be attached".into(),
        ));
    }

    // Compute SHA-256 content hash and per-chunk hashes in a single pass
    use std::io::Read;
    let mut file = std::fs::File::open(&path).map_err(|e| CommandError::Other(e.to_string()))?;
    let mut hasher = Sha256::new();
    let mut chunk_hashes: Vec<String> = Vec::new();
    let chunk_size = CHUNK_SIZE_BYTES as usize;
    let mut buffer = vec![0; chunk_size];
    let mut chunk_hasher = Sha256::new();
    let mut chunk_bytes_read: u64 = 0;
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| CommandError::Other(e.to_string()))?;
        if n == 0 {
            // Flush last partial chunk
            if chunk_bytes_read > 0 {
                chunk_hashes.push(format!("{:x}", chunk_hasher.finalize_reset()));
            }
            break;
        }
        hasher.update(&buffer[..n]);

        // Track per-chunk hash
        let mut remaining = &buffer[..n];
        while !remaining.is_empty() {
            let space_in_chunk = chunk_size - chunk_bytes_read as usize;
            let take = remaining.len().min(space_in_chunk);
            chunk_hasher.update(&remaining[..take]);
            chunk_bytes_read += take as u64;
            remaining = &remaining[take..];

            if chunk_bytes_read as usize >= chunk_size {
                chunk_hashes.push(format!("{:x}", chunk_hasher.finalize_reset()));
                chunk_bytes_read = 0;
            }
        }
    }
    let file_hash = format!("{:x}", hasher.finalize());

    let (public_key, private_key_bytes, local_peer_id) = {
        let guard = state.identity.read().await;
        let id = guard
            .as_ref()
            .ok_or(CommandError::Identity("No identity loaded".into()))?;
        let pk = id.public_key_b64.clone();
        let pkb = id.private_key_bytes();
        let lpid = local_peer_id(id).map_err(|e| CommandError::Other(e.to_string()))?;
        (pk, pkb, lpid)
    };

    let channel_id_c = channel_id.clone();
    let community_id = db
        .run_blocking(move |db| db.get_community_for_channel(&channel_id_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    let community_id_c = community_id.clone();
    let public_key_c = public_key.clone();
    let is_banned = db
        .run_blocking(move |db| db.is_banned(&community_id_c, &public_key_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    if is_banned {
        return Err(CommandError::Banned);
    }
    if !state
        .rate_limits
        .allow(
            RateLimitBucket::FileAnnouncement,
            &community_id,
            &public_key,
        )
        .await
    {
        return Err(CommandError::RateLimited);
    }

    let chunks = (size as f64 / CHUNK_SIZE_BYTES as f64).ceil() as u32;
    let public_key_c = public_key.clone();
    let profile = db
        .run_blocking(move |db| db.get_local_profile(&public_key_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    let display_name = profile
        .as_ref()
        .map(|profile| profile.display_name.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "You".to_string());
    let avatar_color = profile
        .as_ref()
        .map(|profile| profile.avatar_color.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "#c8b89a".to_string());
    let announced_hash = file_hash.clone();
    let envelope = EnvelopeBuilder::new("file_announced", &public_key, &community_id)
        .channel_id(&channel_id)
        .payload_typed(&FileAnnouncedPayload {
            file_hash: file_hash.clone(),
            file_name: file_name,
            size,
            chunks,
            source_peer_id: local_peer_id,
            author_display_name: display_name,
            author_avatar_color: avatar_color,
        })
        .sign(&private_key_bytes);

    let payload = serde_json::from_value::<FileAnnouncedPayload>(envelope.payload.clone())
        .map_err(|e| CommandError::Other(e.to_string()))?;
    if let Some(message) = app_runtime::signed_file_announcement_to_message(&envelope, &payload) {
        let message_c = message.clone();
        let _ = db
            .run_blocking(move |db| db.insert_message(&message_c))
            .await;
        let _ = app_handle.emit("message:received", &message);
    }

    let network = state.network.read().await;
    if let Some(ref net) = *network {
        // Cache the local path in the swarm
        if let Err(e) = net
            .send_command(NetworkCommand::ServeFile {
                file_hash: announced_hash.clone(),
                path: path.clone(),
                community_id: community_id.clone(),
            })
            .await
        {
            tracing::warn!("network serve file command failed: {}", e);
        }

        // Encrypt and broadcast to community topics
        let plaintext =
            serde_json::to_vec(&envelope).map_err(|e| CommandError::Other(e.to_string()))?;
        let community_id_c = community_id.clone();
        let aad = encryption::build_community_aad(&community_id, &channel_id);
        let data = db
            .run_blocking(move |db| db.encrypt_community_payload(&community_id_c, &plaintext, &aad))
            .await
            .map_err(|e| CommandError::Other(e.to_string()))?;
        // Publish to per-channel topic
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: channel_messages_topic(&community_id, &channel_id),
                data: data.clone(),
            })
            .await
        {
            tracing::warn!(
                "network publish file announcement to channel topic failed: {}",
                e
            );
        }
        // Backward compat: also publish to the legacy community-wide topic
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: format!("mesh/community/{}/messages", community_id),
                data,
            })
            .await
        {
            tracing::warn!(
                "network publish file announcement to legacy topic failed: {}",
                e
            );
        }
    }

    Ok(announced_hash)
}

/// Upload a file in a DM context (no community encryption, sent via DM topic).
#[tauri::command]
pub async fn upload_dm_file(
    conversation_id: String,
    file_path: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
    _db: State<'_, Database>,
) -> Result<String, CommandError> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(CommandError::NotFound("File does not exist".into()));
    }

    let file_name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let size = std::fs::metadata(&path)
        .map_err(|e| CommandError::Other(e.to_string()))?
        .len();

    if size > MAX_FILE_SIZE {
        return Err(CommandError::Validation(format!(
            "File too large ({:.1} MB). Maximum allowed size is {:.0} MB.",
            size as f64 / (1024.0 * 1024.0),
            MAX_FILE_SIZE as f64 / (1024.0 * 1024.0)
        )));
    }

    if has_blocked_attachment_extension(&path) {
        return Err(CommandError::Validation(
            "This executable or script file type cannot be attached".into(),
        ));
    }

    // Compute SHA-256 content hash
    use std::io::Read;
    let mut file = std::fs::File::open(&path).map_err(|e| CommandError::Other(e.to_string()))?;
    let mut hasher = Sha256::new();
    let chunk_size = CHUNK_SIZE_BYTES as usize;
    let mut buffer = vec![0; chunk_size];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| CommandError::Other(e.to_string()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let file_hash = format!("{:x}", hasher.finalize());

    let (public_key, _private_key_bytes, local_peer_id_str) = {
        let guard = state.identity.read().await;
        let id = guard
            .as_ref()
            .ok_or(CommandError::Identity("No identity loaded".into()))?;
        let pk = id.public_key_b64.clone();
        let pkb = id.private_key_bytes();
        let lpid = local_peer_id(id).map_err(|e| CommandError::Other(e.to_string()))?;
        (pk, pkb, lpid)
    };

    let chunks = (size as f64 / CHUNK_SIZE_BYTES as f64).ceil() as u32;

    // Serve the file locally so the peer can request chunks
    let network = state.network.read().await;
    if let Some(ref net) = *network {
        if let Err(e) = net
            .send_command(NetworkCommand::ServeFile {
                file_hash: file_hash.clone(),
                path: path.clone(),
                community_id: String::new(),
            })
            .await
        {
            tracing::warn!("network serve file command for DM failed: {}", e);
        }
    }

    // Emit a local event so the frontend can display the attachment
    let _ = app_handle.emit(
        "dm:file-uploaded",
        &serde_json::json!({
            "conversationId": conversation_id,
            "fileHash": file_hash,
            "fileName": file_name,
            "size": size,
            "chunks": chunks,
            "sourcePeerId": local_peer_id_str,
            "authorPublicKey": public_key,
        }),
    );

    Ok(file_hash)
}

#[tauri::command]
pub async fn request_file(
    file_hash: String,
    peer_id: Option<String>,
    source_peer_id: Option<String>,
    filename: Option<String>,
    size: Option<u64>,
    chunks: Option<u32>,
    community_id: Option<String>,
    app_handle: AppHandle,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<(), CommandError> {
    let target_peer_id = source_peer_id.or(peer_id).ok_or(CommandError::Validation(
        "No source peer id provided".into(),
    ))?;
    let filename = filename.unwrap_or_else(|| file_hash.clone());
    let chunks = chunks.unwrap_or_else(|| {
        if let Some(size) = size {
            (size as f64 / CHUNK_SIZE_BYTES as f64).ceil() as u32
        } else {
            0
        }
    });
    let size = size.unwrap_or_else(|| chunks as u64 * CHUNK_SIZE_BYTES);
    if chunks == 0 {
        return Err(CommandError::Validation(
            "No chunks available for this attachment".into(),
        ));
    }

    let progress = {
        let mut downloads = state.downloads.lock().await;
        downloads
            .start_download(
                file_hash.clone(),
                filename,
                size,
                chunks,
                &downloads_root(),
                None,
            )
            .map_err(|e| CommandError::Other(e.to_string()))?
    };
    let _ = app_handle.emit("file:download-progress", &progress);

    // Record all known seeders from file availability table
    let file_hash_c = file_hash.clone();
    let seeders = db
        .run_blocking(move |db| db.get_file_seeders(&file_hash_c).unwrap_or_default())
        .await;

    // Add the original source peer, then merge in any other known seeders
    let mut all_seeders = vec![target_peer_id.clone()];
    for (seeder_peer_id, _) in &seeders {
        if !all_seeders.contains(seeder_peer_id) {
            all_seeders.push(seeder_peer_id.clone());
        }
    }

    // Verify network is available before creating the scheduler
    {
        let network = state.network.read().await;
        if network.is_none() {
            let failed = {
                let mut downloads = state.downloads.lock().await;
                downloads.mark_failed(&file_hash)
            };
            if let Some(progress) = failed {
                let _ = app_handle.emit("file:download-progress", &progress);
            }
            return Err(CommandError::Network("Network unavailable".into()));
        }
    }

    // Create a bounded download scheduler instead of blasting all requests upfront
    let community_id_str = community_id.unwrap_or_default();
    let scheduler = DownloadScheduler::new(
        file_hash.clone(),
        community_id_str.clone(),
        chunks,
        all_seeders,
        HashSet::new(),
    );

    // Store the scheduler in app state
    state
        .schedulers
        .lock()
        .await
        .insert(file_hash.clone(), scheduler);

    // Send the initial bounded batch of chunk requests
    send_scheduler_batch(&app_handle, &file_hash).await;

    Ok(())
}

#[tauri::command]
pub async fn get_community_files(
    community_id: String,
    db: State<'_, Database>,
) -> Result<Vec<serde_json::Value>, CommandError> {
    let result = db
        .run_blocking(move |db| db.get_community_file_list(&community_id))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    Ok(result)
}

/// Drive the download scheduler for a file: pull the next batch of chunk requests
/// that fit within concurrency limits, sign them, and send them over the network.
///
/// Called both on initial download start and after each chunk is received (to refill
/// the window), providing natural backpressure.
pub async fn send_scheduler_batch(app_handle: &AppHandle, file_hash: &str) {
    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };

    // Collect the requests, stats, and community_id from the scheduler, then release
    // the lock before doing I/O (signing, network send).
    let (requests, community_id, stats_before) = {
        let mut schedulers = state.schedulers.lock().await;
        let Some(scheduler) = schedulers.get_mut(file_hash) else {
            return;
        };

        // Check for timed-out requests and move them to the retry queue
        let timed_out = scheduler.check_timeouts();
        if !timed_out.is_empty() {
            tracing::warn!(
                target: "mesh::downloads",
                file_hash = %file_hash,
                timed_out_count = timed_out.len(),
                "chunk request timeout — moved to retry queue"
            );
        }

        let reqs = scheduler.next_requests();
        let cid = scheduler.community_id().to_string();
        let stats = scheduler.stats();
        (reqs, cid, stats)
    };

    // Structured log on each scheduler drive for field observability.
    // Only log at debug by default to avoid noise, but always log if anything
    // looks unhealthy.
    if stats_before.is_stalled || stats_before.is_failed {
        tracing::warn!(
            target: "mesh::downloads",
            file_hash = %file_hash,
            received = stats_before.received_chunks,
            total = stats_before.total_chunks,
            seeders = stats_before.seeder_count,
            stalled = stats_before.is_stalled,
            failed = stats_before.is_failed,
            "scheduler drive on unhealthy download"
        );
    } else if !requests.is_empty() {
        tracing::debug!(
            target: "mesh::downloads",
            file_hash = %file_hash,
            batch_size = requests.len(),
            in_flight = stats_before.in_flight_chunks,
            received = stats_before.received_chunks,
            total = stats_before.total_chunks,
            "scheduler drive"
        );
    }

    if requests.is_empty() {
        return;
    }

    // Sign each request while holding the identity lock
    let identity_guard = state.identity.read().await;
    let (public_key, identity_ref) = match identity_guard.as_ref() {
        Some(id) => (id.public_key_b64.clone(), Some(id)),
        None => (String::new(), None),
    };

    let network = state.network.read().await;
    let Some(ref net) = *network else {
        return;
    };

    for (req, peer_id) in requests {
        let (requester_public_key, request_signature) = match identity_ref {
            Some(id) => {
                let signable = format!(
                    "file-req:{}:{}:{}",
                    req.file_hash, req.chunk_index, public_key
                );
                (public_key.clone(), id.sign(signable.as_bytes()))
            }
            None => (String::new(), String::new()),
        };

        if let Err(e) = net
            .send_command(NetworkCommand::RequestFileChunk {
                peer_id: peer_id.clone(),
                file_hash: req.file_hash,
                chunk_index: req.chunk_index,
                community_id: community_id.clone(),
                requester_public_key,
                request_signature,
            })
            .await
        {
            tracing::warn!(
                "network request file chunk {} from seeder {} failed: {}",
                req.chunk_index,
                peer_id,
                e
            );
        }
    }
}

fn local_peer_id(identity: &Identity) -> anyhow::Result<String> {
    let secret_bytes = identity.private_key_bytes();
    let secret = libp2p::identity::ed25519::SecretKey::try_from_bytes(secret_bytes)?;
    let keypair = libp2p::identity::Keypair::from(libp2p::identity::ed25519::Keypair::from(secret));
    Ok(PeerId::from_public_key(&keypair.public()).to_string())
}

pub(crate) fn downloads_root() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    home.join("Downloads").join("Mesh")
}
