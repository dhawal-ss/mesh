use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

pub const CHUNK_SIZE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadState {
    Downloading,
    Completed,
    Failed,
}

impl DownloadState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Downloading => "downloading",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDownloadProgress {
    pub file_hash: String,
    pub received_chunks: u32,
    pub total_chunks: u32,
    pub received_bytes: u64,
    pub total_bytes: u64,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAvailableEvent {
    pub file_hash: String,
    pub local_path: String,
}

#[derive(Debug, Clone)]
pub struct DownloadSession {
    pub file_hash: String,
    pub filename: String,
    pub total_bytes: u64,
    pub total_chunks: u32,
    pub temp_path: PathBuf,
    pub final_path: PathBuf,
    pub received_chunks: HashSet<u32>,
    pub received_bytes: u64,
    pub state: DownloadState,
    /// Per-chunk SHA-256 hashes for Merkle verification.
    /// If present, each chunk is verified against its expected hash on arrival.
    pub chunk_hashes: Option<Vec<String>>,
}

impl DownloadSession {
    fn progress(&self) -> FileDownloadProgress {
        FileDownloadProgress {
            file_hash: self.file_hash.clone(),
            received_chunks: self.received_chunks.len() as u32,
            total_chunks: self.total_chunks,
            received_bytes: self.received_bytes,
            total_bytes: self.total_bytes,
            state: self.state.as_str().to_string(),
        }
    }

    /// Serialize the set of received chunk indices as a JSON array string.
    pub fn received_chunks_json(&self) -> String {
        let chunks: Vec<u32> = self.received_chunks.iter().copied().collect();
        serde_json::to_string(&chunks).unwrap_or_else(|_| "[]".to_string())
    }
}

#[derive(Debug, Clone)]
pub struct DownloadCompletion {
    pub progress: FileDownloadProgress,
    pub local_path: PathBuf,
}

#[derive(Debug, Clone)]
pub enum DownloadUpdate {
    Progress(FileDownloadProgress),
    Completed(DownloadCompletion),
    Failed(FileDownloadProgress),
}

#[derive(Default)]
pub struct DownloadManager {
    sessions: HashMap<String, DownloadSession>,
}

impl DownloadManager {
    pub fn start_download(
        &mut self,
        file_hash: String,
        filename: String,
        total_bytes: u64,
        total_chunks: u32,
        downloads_root: &Path,
        chunk_hashes: Option<Vec<String>>,
    ) -> anyhow::Result<FileDownloadProgress> {
        fs::create_dir_all(downloads_root)?;

        if let Some(existing) = self.sessions.get(&file_hash) {
            match existing.state {
                DownloadState::Downloading => return Ok(existing.progress()),
                DownloadState::Completed if existing.final_path.exists() => {
                    return Ok(existing.progress())
                }
                DownloadState::Completed | DownloadState::Failed => {
                    let temp_path = existing.temp_path.clone();
                    let _ = fs::remove_file(temp_path);
                }
            }
        }

        self.sessions.remove(&file_hash);

        let final_path = unique_download_path(downloads_root, &filename);
        let temp_path = part_path_for(&final_path);

        let part_file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .read(true)
            .open(&temp_path)?;
        part_file.set_len(total_bytes)?;

        let session = DownloadSession {
            file_hash: file_hash.clone(),
            filename,
            total_bytes,
            total_chunks,
            temp_path,
            final_path,
            received_chunks: HashSet::new(),
            received_bytes: 0,
            state: DownloadState::Downloading,
            chunk_hashes,
        };

        let progress = session.progress();
        self.sessions.insert(file_hash, session);
        Ok(progress)
    }

    /// Get a snapshot of a session for persistence purposes.
    pub fn get_session(&self, file_hash: &str) -> Option<&DownloadSession> {
        self.sessions.get(file_hash)
    }

    pub fn mark_failed(&mut self, file_hash: &str) -> Option<FileDownloadProgress> {
        let session = self.sessions.get_mut(file_hash)?;
        session.state = DownloadState::Failed;
        Some(session.progress())
    }

    pub fn record_chunk(
        &mut self,
        file_hash: &str,
        chunk_index: u32,
        data: &[u8],
    ) -> anyhow::Result<Option<DownloadUpdate>> {
        let Some(session) = self.sessions.get_mut(file_hash) else {
            return Ok(None);
        };

        if session.state != DownloadState::Downloading {
            return Ok(Some(DownloadUpdate::Progress(session.progress())));
        }

        if !session.received_chunks.insert(chunk_index) {
            return Ok(Some(DownloadUpdate::Progress(session.progress())));
        }

        // Per-chunk Merkle hash verification (S2)
        if let Some(ref hashes) = session.chunk_hashes {
            if let Some(expected_hash) = hashes.get(chunk_index as usize) {
                let mut chunk_hasher = Sha256::new();
                chunk_hasher.update(data);
                let computed = format!("{:x}", chunk_hasher.finalize());
                if computed != *expected_hash {
                    tracing::warn!(
                        file_hash = %file_hash,
                        chunk_index = chunk_index,
                        expected = %expected_hash,
                        computed = %computed,
                        "Chunk hash mismatch — rejecting corrupt chunk"
                    );
                    session.received_chunks.remove(&chunk_index);
                    return Ok(Some(DownloadUpdate::Progress(session.progress())));
                }
            }
        }

        // Validate chunk size — reject oversized chunks that could corrupt adjacent data
        let max_chunk_size = CHUNK_SIZE_BYTES as usize;
        if data.len() > max_chunk_size {
            tracing::warn!(
                file_hash = %file_hash,
                chunk_index = chunk_index,
                chunk_size = data.len(),
                max_size = max_chunk_size,
                "Rejecting oversized chunk"
            );
            session.received_chunks.remove(&chunk_index);
            return Ok(Some(DownloadUpdate::Progress(session.progress())));
        }

        let mut part_file = OpenOptions::new()
            .write(true)
            .read(true)
            .open(&session.temp_path)?;
        let offset = (chunk_index as u64) * CHUNK_SIZE_BYTES;
        part_file.seek(SeekFrom::Start(offset))?;
        part_file.write_all(data)?;
        part_file.flush()?;

        session.received_bytes = session.received_bytes.saturating_add(data.len() as u64);

        if session.received_chunks.len() as u32 == session.total_chunks {
            let mut final_path = session.final_path.clone();
            if final_path.exists() {
                final_path = unique_download_path(
                    final_path.parent().unwrap_or_else(|| Path::new(".")),
                    &session.filename,
                );
            }
            fs::rename(&session.temp_path, &final_path)?;

            // ── SHA-256 hash verification ──
            // Verify the assembled file matches the declared hash.
            // If it doesn't match, delete the file and mark download as failed.
            let computed_hash = compute_file_sha256(&final_path)?;
            if computed_hash != session.file_hash {
                tracing::warn!(
                    "File hash mismatch for {}: expected {}, got {}. Deleting corrupted file.",
                    session.filename,
                    session.file_hash,
                    computed_hash
                );
                let _ = fs::remove_file(&final_path);
                session.state = DownloadState::Failed;
                return Ok(Some(DownloadUpdate::Failed(session.progress())));
            }

            session.final_path = final_path.clone();
            session.state = DownloadState::Completed;

            return Ok(Some(DownloadUpdate::Completed(DownloadCompletion {
                progress: session.progress(),
                local_path: final_path,
            })));
        }

        Ok(Some(DownloadUpdate::Progress(session.progress())))
    }
}

fn part_path_for(final_path: &Path) -> PathBuf {
    let file_name = final_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    final_path.with_file_name(format!("{file_name}.part"))
}

fn unique_download_path(downloads_root: &Path, filename: &str) -> PathBuf {
    let requested = sanitize_filename(filename);
    let stem = Path::new(&requested)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let ext = Path::new(&requested)
        .extension()
        .and_then(|value| value.to_str());

    let mut candidate = downloads_root.join(&requested);
    let mut suffix = 1;
    while candidate.exists() || part_path_for(&candidate).exists() {
        let numbered = match ext {
            Some(ext) if !ext.is_empty() => format!("{stem} ({suffix}).{ext}"),
            _ => format!("{stem} ({suffix})"),
        };
        candidate = downloads_root.join(numbered);
        suffix += 1;
    }
    candidate
}

fn sanitize_filename(filename: &str) -> String {
    let trimmed = filename.trim();
    let fallback = if trimmed.is_empty() {
        "download"
    } else {
        trimmed
    };
    fallback
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => ch,
        })
        .collect()
}

/// Compute the hex-encoded SHA-256 hash of a file.
fn compute_file_sha256(path: &Path) -> anyhow::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let hash = hasher.finalize();
    Ok(hash.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::{DownloadManager, DownloadUpdate, CHUNK_SIZE_BYTES};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::PathBuf;

    fn temp_downloads_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mesh-file-tests-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sha256_hex(parts: &[&[u8]]) -> String {
        let mut hasher = Sha256::new();
        for part in parts {
            hasher.update(part);
        }
        format!("{:x}", hasher.finalize())
    }

    #[test]
    fn writes_chunks_out_of_order_and_completes() {
        let dir = temp_downloads_dir("out-of-order");
        let mut manager = DownloadManager::default();
        let first_chunk = vec![b'W'; CHUNK_SIZE_BYTES as usize];
        let second_chunk = b"orld";
        let expected_hash = sha256_hex(&[first_chunk.as_slice(), second_chunk]);
        manager
            .start_download(
                expected_hash.clone(),
                "voice.txt".into(),
                CHUNK_SIZE_BYTES + second_chunk.len() as u64,
                2,
                &dir,
                None,
            )
            .unwrap();

        let update = manager
            .record_chunk(&expected_hash, 1, second_chunk)
            .unwrap()
            .unwrap();
        assert!(matches!(update, DownloadUpdate::Progress(_)));

        let update = manager
            .record_chunk(&expected_hash, 0, &first_chunk)
            .unwrap()
            .unwrap();
        let DownloadUpdate::Completed(completed) = update else {
            panic!("expected completion");
        };
        assert_eq!(completed.progress.received_chunks, 2);
        assert_eq!(completed.progress.state, "completed");
        assert!(completed.local_path.exists());
    }

    #[test]
    fn duplicate_chunks_do_not_double_count_progress() {
        let dir = temp_downloads_dir("duplicates");
        let mut manager = DownloadManager::default();
        manager
            .start_download("hash-b".into(), "notes.txt".into(), 5, 2, &dir, None)
            .unwrap();

        let first = manager.record_chunk("hash-b", 0, b"he").unwrap().unwrap();
        let second = manager.record_chunk("hash-b", 0, b"he").unwrap().unwrap();

        let DownloadUpdate::Progress(first) = first else {
            panic!("expected progress");
        };
        let DownloadUpdate::Progress(second) = second else {
            panic!("expected progress");
        };

        assert_eq!(first.received_chunks, 1);
        assert_eq!(second.received_chunks, 1);
        assert_eq!(second.received_bytes, 2);
    }

    #[test]
    fn incomplete_download_does_not_complete() {
        let dir = temp_downloads_dir("incomplete");
        let mut manager = DownloadManager::default();
        manager
            .start_download("hash-c".into(), "draft.md".into(), 8, 3, &dir, None)
            .unwrap();

        let update = manager.record_chunk("hash-c", 0, b"abc").unwrap().unwrap();
        assert!(matches!(update, DownloadUpdate::Progress(_)));
    }

    #[test]
    fn existing_target_filename_gets_unique_suffix() {
        let dir = temp_downloads_dir("collision");
        fs::write(dir.join("report.txt"), b"existing").unwrap();

        let mut manager = DownloadManager::default();
        let expected_hash = sha256_hex(&[b"next"]);
        manager
            .start_download(expected_hash.clone(), "report.txt".into(), 4, 1, &dir, None)
            .unwrap();

        let update = manager
            .record_chunk(&expected_hash, 0, b"next")
            .unwrap()
            .unwrap();
        let DownloadUpdate::Completed(completed) = update else {
            panic!("expected completion");
        };
        assert_ne!(completed.local_path, dir.join("report.txt"));
        assert!(completed.local_path.exists());
    }
}
