use crate::storage::Database;

impl Database {
    /// Record that a peer has a copy of a file (seeder tracking).
    pub fn record_file_availability(
        &self,
        file_hash: &str,
        peer_id: &str,
        filename: &str,
        size: i64,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "INSERT INTO file_availability (file_hash, peer_id, filename, size, last_seen)
             VALUES (?1, ?2, ?3, ?4, datetime('now'))
             ON CONFLICT(file_hash, peer_id) DO UPDATE SET
                last_seen = datetime('now'),
                filename = excluded.filename,
                size = excluded.size",
            rusqlite::params![file_hash, peer_id, filename, size],
        )?;
        Ok(())
    }

    /// Get all known seeders for a given file hash.
    /// Returns a list of (peer_id, last_seen) tuples.
    pub fn get_file_seeders(&self, file_hash: &str) -> anyhow::Result<Vec<(String, String)>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT peer_id, last_seen FROM file_availability
             WHERE file_hash = ?1
             ORDER BY last_seen DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params![file_hash], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Upsert a download session to persist progress across restarts.
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_download_session(
        &self,
        file_hash: &str,
        filename: &str,
        total_bytes: u64,
        total_chunks: u32,
        received_chunks_json: &str,
        temp_path: &str,
        status: &str,
        source_peer_id: Option<&str>,
        community_id: Option<&str>,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "INSERT INTO download_sessions (file_hash, filename, total_bytes, total_chunks, received_chunks_json, temp_path, status, source_peer_id, community_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(file_hash) DO UPDATE SET
                received_chunks_json = excluded.received_chunks_json,
                status = excluded.status,
                updated_at = datetime('now')",
            rusqlite::params![
                file_hash,
                filename,
                total_bytes as i64,
                total_chunks as i64,
                received_chunks_json,
                temp_path,
                status,
                source_peer_id,
                community_id,
            ],
        )?;
        Ok(())
    }

    /// Get all download sessions that are not yet completed (status = 'active').
    pub fn get_incomplete_download_sessions(
        &self,
    ) -> anyhow::Result<Vec<IncompleteDownloadSession>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT file_hash, filename, total_bytes, total_chunks, received_chunks_json, temp_path, source_peer_id, community_id
             FROM download_sessions
             WHERE status = 'active'
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let received_json: String = row.get(4)?;
            let received: Vec<u32> = serde_json::from_str(&received_json).unwrap_or_default();
            let total_chunks: u32 = row.get::<_, i64>(3)? as u32;
            let all_chunks: std::collections::HashSet<u32> = (0..total_chunks).collect();
            let received_set: std::collections::HashSet<u32> = received.into_iter().collect();
            let missing: Vec<u32> = all_chunks.difference(&received_set).copied().collect();
            Ok(IncompleteDownloadSession {
                file_hash: row.get(0)?,
                filename: row.get(1)?,
                total_bytes: row.get::<_, i64>(2)? as u64,
                total_chunks,
                received_chunks: received_set.into_iter().collect(),
                missing_chunks: missing,
                temp_path: row.get(5)?,
                source_peer_id: row.get(6)?,
                community_id: row.get(7)?,
            })
        })?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Mark a download session as completed.
    pub fn complete_download_session(&self, file_hash: &str) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "UPDATE download_sessions SET status = 'completed', updated_at = datetime('now') WHERE file_hash = ?1",
            rusqlite::params![file_hash],
        )?;
        Ok(())
    }

    /// Mark a download session as failed.
    pub fn fail_download_session(&self, file_hash: &str) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "UPDATE download_sessions SET status = 'failed', updated_at = datetime('now') WHERE file_hash = ?1",
            rusqlite::params![file_hash],
        )?;
        Ok(())
    }

    /// Get all files available in a community by cross-referencing file_availability
    /// with message attachments in that community's channels.
    pub fn get_community_file_list(
        &self,
        community_id: &str,
    ) -> anyhow::Result<Vec<serde_json::Value>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT fa.file_hash, fa.filename, fa.size, COUNT(DISTINCT fa.peer_id) as seeder_count, MAX(fa.last_seen) as last_seen
             FROM file_availability fa
             WHERE fa.file_hash IN (
                 SELECT DISTINCT json_extract(value, '$.fileHash')
                 FROM messages, json_each(messages.attachments)
                 WHERE messages.channel_id IN (SELECT id FROM channels WHERE community_id = ?1)
             )
             GROUP BY fa.file_hash
             ORDER BY last_seen DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params![community_id], |row| {
            Ok(serde_json::json!({
                "fileHash": row.get::<_, String>(0)?,
                "filename": row.get::<_, String>(1)?,
                "size": row.get::<_, i64>(2)?,
                "seederCount": row.get::<_, i64>(3)?,
                "lastSeen": row.get::<_, String>(4)?,
            }))
        })?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }
}

/// Represents an incomplete download that can be resumed.
#[derive(Debug, Clone)]
pub struct IncompleteDownloadSession {
    pub file_hash: String,
    pub filename: String,
    pub total_bytes: u64,
    pub total_chunks: u32,
    pub received_chunks: Vec<u32>,
    pub missing_chunks: Vec<u32>,
    pub temp_path: String,
    pub source_peer_id: Option<String>,
    pub community_id: Option<String>,
}
