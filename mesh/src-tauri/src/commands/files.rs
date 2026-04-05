use std::path::PathBuf;

use libp2p::PeerId;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::app_runtime;
use crate::crypto::encryption;
use crate::crypto::identity::Identity;
use crate::network::envelope::{EnvelopeBuilder, FileAnnouncedPayload};
use crate::network::events::NetworkCommand;
use crate::network::gossip::channel_messages_topic;
use crate::state::file_downloads::CHUNK_SIZE_BYTES;
use crate::state::rate_limits::RateLimitBucket;
use crate::state::AppState;
use crate::storage::Database;

use super::error::CommandError;

/// Maximum allowed file size for uploads (100 MB).
const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024;

/// File extensions that are blocked from upload.
const BLOCKED_EXTENSIONS: &[&str] = &[
    "exe", "bat", "cmd", "com", "msi", "scr", "pif", "vbs", "vbe",
    "js", "jse", "wsf", "wsh", "ps1", "ps1xml", "ps2", "ps2xml",
    "psc1", "psc2", "msh", "msh1", "msh2", "inf", "reg", "rgs",
    "sct", "shb", "shs", "ws", "wsc", "cpl", "dll", "sys",
];

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
    let size = std::fs::metadata(&path).map_err(|e| CommandError::Other(e.to_string()))?.len();

    // S6: File size validation
    if size > MAX_FILE_SIZE {
        return Err(CommandError::Validation(format!(
            "File too large ({:.1} MB). Maximum allowed size is {:.0} MB.",
            size as f64 / (1024.0 * 1024.0),
            MAX_FILE_SIZE as f64 / (1024.0 * 1024.0)
        )));
    }

    // S6: Blocked file type validation
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if BLOCKED_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
            return Err(CommandError::Validation(format!(
                "File type '.{}' is not allowed for security reasons.",
                ext
            )));
        }
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
        let n = file.read(&mut buffer).map_err(|e| CommandError::Other(e.to_string()))?;
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
        let id = guard.as_ref().ok_or(CommandError::Identity("No identity loaded".into()))?;
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
        let plaintext = serde_json::to_vec(&envelope).map_err(|e| CommandError::Other(e.to_string()))?;
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
            tracing::warn!("network publish file announcement to channel topic failed: {}", e);
        }
        // Backward compat: also publish to the legacy community-wide topic
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: format!("mesh/community/{}/messages", community_id),
                data,
            })
            .await
        {
            tracing::warn!("network publish file announcement to legacy topic failed: {}", e);
        }
    }

    Ok(announced_hash)
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
) -> Result<(), CommandError> {
    let target_peer_id = source_peer_id
        .or(peer_id)
        .ok_or(CommandError::Validation("No source peer id provided".into()))?;
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
        return Err(CommandError::Validation("No chunks available for this attachment".into()));
    }

    let progress = {
        let mut downloads = state.downloads.lock().await;
        downloads
            .start_download(file_hash.clone(), filename, size, chunks, &downloads_root(), None)
            .map_err(|e| CommandError::Other(e.to_string()))?
    };
    let _ = app_handle.emit("file:download-progress", &progress);

    let network = state.network.read().await;
    if let Some(ref net) = *network {
        for chunk_index in 0..chunks {
            if let Err(e) = net
                .send_command(NetworkCommand::RequestFileChunk {
                    peer_id: target_peer_id.clone(),
                    file_hash: file_hash.clone(),
                    chunk_index,
                    community_id: community_id.clone().unwrap_or_default(),
                })
                .await
            {
                tracing::warn!("network request file chunk {} failed: {}", chunk_index, e);
            }
        }
    } else {
        let failed = {
            let mut downloads = state.downloads.lock().await;
            downloads.mark_failed(&file_hash)
        };
        if let Some(progress) = failed {
            let _ = app_handle.emit("file:download-progress", &progress);
        }
        return Err(CommandError::Network("Network unavailable".into()));
    }
    Ok(())
}

fn local_peer_id(identity: &Identity) -> anyhow::Result<String> {
    let secret_bytes = identity.private_key_bytes();
    let secret = libp2p::identity::ed25519::SecretKey::try_from_bytes(secret_bytes)?;
    let keypair = libp2p::identity::Keypair::from(libp2p::identity::ed25519::Keypair::from(secret));
    Ok(PeerId::from_public_key(&keypair.public()).to_string())
}

fn downloads_root() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    home.join("Downloads").join("Mesh")
}
