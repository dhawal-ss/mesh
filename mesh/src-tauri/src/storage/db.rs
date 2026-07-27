use hkdf::Hkdf;
use rand::RngCore;
use rusqlite::Connection;
use sha2::Sha256;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::crypto::keychain;
use crate::storage::schema;

/// Core database wrapper — holds a Mutex-protected SQLite connection.
/// All blocking DB operations should be dispatched via `run_blocking()`
/// to avoid starving the tokio async runtime.
pub struct Database {
    pub conn: Arc<Mutex<Connection>>,
}

impl Database {
    /// Run a blocking database closure on a dedicated thread pool so we
    /// don't block the tokio async runtime. This wraps `tokio::task::spawn_blocking`.
    ///
    /// The closure receives a `Database` that shares the same underlying
    /// connection via `Arc<Mutex<Connection>>`. This avoids the previous
    /// unsound `unsafe` pointer transmute — the `Arc` clone is `'static`
    /// and `Send`, satisfying `spawn_blocking`'s bounds.
    ///
    /// Usage:
    /// ```ignore
    /// let result = db.run_blocking(|db| db.get_messages(...)).await?;
    /// ```
    pub async fn run_blocking<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&Database) -> R + Send + 'static,
        R: Send + 'static,
    {
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || {
            let db = Database { conn };
            f(&db)
        })
        .await
        .expect("database blocking task panicked")
    }
}

impl Database {
    /// Open (or create) the SQLite database at the given app data directory.
    pub fn new(app_data_dir: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&app_data_dir)?;
        let db_path = app_data_dir.join("mesh.db");
        let key_hex = derive_database_key_hex()?;
        migrate_plaintext_database_if_needed(&db_path, &key_hex)?;
        let conn = open_encrypted_connection(&db_path, &key_hex)?;

        // Enable WAL mode for better concurrent read performance
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;

        let db = Database {
            conn: Arc::new(Mutex::new(conn)),
        };

        // Run migrations
        db.run_migrations()?;

        Ok(db)
    }

    /// Run all SQL migrations in order, tracked via the `schema_version` table.
    fn run_migrations(&self) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        schema::run_migrations(&conn)?;
        Ok(())
    }

    // ─── Key-Value Store ─────────────────────────────

    /// Get a value from the kv_store table.
    pub fn get_kv(&self, key: &str) -> anyhow::Result<Option<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let result: Result<String, _> = conn.query_row(
            "SELECT value FROM kv_store WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get(0),
        );
        match result {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Set a value in the kv_store table (upsert).
    pub fn set_kv(&self, key: &str, value: &str) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "INSERT INTO kv_store (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

    // ─── Membership helpers ──────────────────────────

    /// Get the member count for a community from the members table.
    pub fn member_count(&self, community_id: &str) -> anyhow::Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let count: u32 = conn.query_row(
            "SELECT COUNT(1) FROM members WHERE community_id = ?1 AND join_status = 'joined' AND ban_status = 'none'",
            rusqlite::params![community_id],
            |row| row.get(0),
        ).unwrap_or(0);
        Ok(count)
    }

    /// Upsert a member record.
    pub fn upsert_member(
        &self,
        community_id: &str,
        public_key: &str,
        display_name: &str,
        avatar_color: &str,
        role: &str,
        x25519_public_key: Option<&str>,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "INSERT INTO members (community_id, public_key, display_name, avatar_color, role, x25519_public_key, join_status, ban_status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'joined', 'none')
             ON CONFLICT(community_id, public_key) DO UPDATE SET
                display_name = excluded.display_name,
                avatar_color = excluded.avatar_color,
                role = CASE WHEN excluded.role != 'member' THEN excluded.role ELSE members.role END,
                x25519_public_key = COALESCE(excluded.x25519_public_key, members.x25519_public_key),
                join_status = 'joined',
                last_seen = datetime('now')",
            rusqlite::params![community_id, public_key, display_name, avatar_color, role, x25519_public_key],
        )?;
        Ok(())
    }

    /// Update the last_seen timestamp for a member.
    pub fn touch_member(&self, community_id: &str, public_key: &str) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "UPDATE members SET last_seen = datetime('now') WHERE community_id = ?1 AND public_key = ?2",
            rusqlite::params![community_id, public_key],
        )?;
        Ok(())
    }

    /// Ban a member.
    pub fn ban_member(&self, community_id: &str, public_key: &str) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "UPDATE members SET ban_status = 'banned', join_status = 'left' WHERE community_id = ?1 AND public_key = ?2",
            rusqlite::params![community_id, public_key],
        )?;
        Ok(())
    }

    /// Change a member's role.
    pub fn update_member_role(
        &self,
        community_id: &str,
        public_key: &str,
        role: &str,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "UPDATE members SET role = ?3 WHERE community_id = ?1 AND public_key = ?2",
            rusqlite::params![community_id, public_key, role],
        )?;
        Ok(())
    }

    /// Get all joined, non-banned members for a community.
    pub fn get_members(&self, community_id: &str) -> anyhow::Result<Vec<MemberRow>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT public_key, display_name, avatar_color, role, join_status, ban_status, x25519_public_key, last_seen
             FROM members WHERE community_id = ?1 AND join_status = 'joined' AND ban_status = 'none'
             ORDER BY role ASC, display_name ASC",
        )?;
        let rows = stmt.query_map(rusqlite::params![community_id], |row| {
            Ok(MemberRow {
                public_key: row.get(0)?,
                display_name: row.get(1)?,
                avatar_color: row.get(2)?,
                role: row.get(3)?,
                join_status: row.get(4)?,
                ban_status: row.get(5)?,
                x25519_public_key: row.get(6)?,
                last_seen: row.get(7)?,
            })
        })?;
        let mut members = Vec::new();
        for row in rows {
            members.push(row?);
        }
        Ok(members)
    }

    /// Get all member rows for a community, including left and banned members.
    pub fn get_all_member_rows(&self, community_id: &str) -> anyhow::Result<Vec<MemberRow>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT public_key, display_name, avatar_color, role, join_status, ban_status, x25519_public_key, last_seen
             FROM members WHERE community_id = ?1
             ORDER BY role ASC, display_name ASC",
        )?;
        let rows = stmt.query_map(rusqlite::params![community_id], |row| {
            Ok(MemberRow {
                public_key: row.get(0)?,
                display_name: row.get(1)?,
                avatar_color: row.get(2)?,
                role: row.get(3)?,
                join_status: row.get(4)?,
                ban_status: row.get(5)?,
                x25519_public_key: row.get(6)?,
                last_seen: row.get(7)?,
            })
        })?;
        let mut members = Vec::new();
        for row in rows {
            members.push(row?);
        }
        Ok(members)
    }

    // ─── Control Log ─────────────────────────────────

    /// Insert a control-log event.
    pub fn insert_control_event(
        &self,
        id: &str,
        community_id: &str,
        event_type: &str,
        payload: &str,
        signed_by: &str,
        signature: &str,
        timestamp: &str,
    ) -> anyhow::Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let already_exists: bool = conn
            .query_row(
                "SELECT 1 FROM control_log WHERE id = ?1",
                rusqlite::params![id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if already_exists {
            return Ok(false);
        }
        conn.execute(
            "INSERT INTO control_log (id, community_id, event_type, payload, signed_by, signature, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![id, community_id, event_type, payload, signed_by, signature, timestamp],
        )?;
        Ok(true)
    }

    pub fn get_control_events_since(
        &self,
        community_id: &str,
        since_timestamp: Option<&str>,
    ) -> anyhow::Result<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let sql = if since_timestamp.is_some() {
            "SELECT id, community_id, event_type, payload, signed_by, signature, timestamp
             FROM control_log
             WHERE community_id = ?1 AND timestamp > ?2
             ORDER BY timestamp ASC"
        } else {
            "SELECT id, community_id, event_type, payload, signed_by, signature, timestamp
             FROM control_log
             WHERE community_id = ?1
             ORDER BY timestamp ASC"
        };
        let mut events = Vec::new();
        let mut stmt = conn.prepare(sql)?;
        if let Some(since_timestamp) = since_timestamp {
            let rows = stmt.query_map(rusqlite::params![community_id, since_timestamp], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "community_id": row.get::<_, String>(1)?,
                    "event_type": row.get::<_, String>(2)?,
                    "payload": serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(3)?).unwrap_or_default(),
                    "signed_by": row.get::<_, String>(4)?,
                    "signature": row.get::<_, String>(5)?,
                    "timestamp": row.get::<_, String>(6)?,
                })
                .to_string())
            })?;
            for row in rows {
                events.push(row?);
            }
        } else {
            let rows = stmt.query_map(rusqlite::params![community_id], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "community_id": row.get::<_, String>(1)?,
                    "event_type": row.get::<_, String>(2)?,
                    "payload": serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(3)?).unwrap_or_default(),
                    "signed_by": row.get::<_, String>(4)?,
                    "signature": row.get::<_, String>(5)?,
                    "timestamp": row.get::<_, String>(6)?,
                })
                .to_string())
            })?;
            for row in rows {
                events.push(row?);
            }
        }
        Ok(events)
    }

    pub fn get_latest_control_event_timestamp(
        &self,
        community_id: &str,
    ) -> anyhow::Result<Option<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let result: Result<String, rusqlite::Error> = conn.query_row(
            "SELECT timestamp
             FROM control_log
             WHERE community_id = ?1
             ORDER BY timestamp DESC
             LIMIT 1",
            rusqlite::params![community_id],
            |row| row.get(0),
        );
        match result {
            Ok(timestamp) => Ok(Some(timestamp)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    // ─── Last Read ───────────────────────────────────

    /// Update the last-read marker for a user in a channel.
    pub fn set_last_read(
        &self,
        community_id: &str,
        channel_id: &str,
        public_key: &str,
        message_id: &str,
        timestamp: &str,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "INSERT INTO last_read (community_id, channel_id, public_key, message_id, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(community_id, channel_id, public_key) DO UPDATE SET
                message_id = excluded.message_id,
                timestamp = excluded.timestamp",
            rusqlite::params![community_id, channel_id, public_key, message_id, timestamp],
        )?;
        Ok(())
    }

    /// Get unread count for a channel based on last-read marker.
    pub fn get_unread_count(&self, channel_id: &str, public_key: &str) -> anyhow::Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let result: Result<String, _> = conn.query_row(
            "SELECT timestamp FROM last_read WHERE channel_id = ?1 AND public_key = ?2",
            rusqlite::params![channel_id, public_key],
            |row| row.get(0),
        );
        match result {
            Ok(last_ts) => {
                let count: u32 = conn.query_row(
                    "SELECT COUNT(1) FROM messages WHERE channel_id = ?1 AND timestamp > ?2 AND deleted_at IS NULL",
                    rusqlite::params![channel_id, last_ts],
                    |row| row.get(0),
                )?;
                Ok(count)
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                // Never read — all messages are unread
                let count: u32 = conn.query_row(
                    "SELECT COUNT(1) FROM messages WHERE channel_id = ?1 AND deleted_at IS NULL",
                    rusqlite::params![channel_id],
                    |row| row.get(0),
                )?;
                Ok(count)
            }
            Err(e) => Err(e.into()),
        }
    }

    // ─── Invites ─────────────────────────────────────

    /// Create an invite token.
    pub fn create_invite(
        &self,
        community_id: &str,
        invite_secret: &str,
        created_by: &str,
        uses_remaining: Option<i64>,
        expires_at: Option<&str>,
    ) -> anyhow::Result<String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let id = nanoid::nanoid!();
        conn.execute(
            "INSERT INTO invites (id, community_id, invite_secret, created_by, uses_remaining, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, community_id, invite_secret, created_by, uses_remaining, expires_at],
        )?;
        Ok(id)
    }

    /// Validate and consume an invite secret. Returns the community_id if valid.
    pub fn consume_invite(&self, invite_secret: &str) -> anyhow::Result<Option<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let result: Result<(String, String, Option<i64>, Option<String>), _> = conn.query_row(
            "SELECT id, community_id, uses_remaining, expires_at FROM invites WHERE invite_secret = ?1",
            rusqlite::params![invite_secret],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        );
        match result {
            Ok((invite_id, community_id, uses_remaining, expires_at)) => {
                // Check expiry
                if let Some(expires) = &expires_at {
                    let now = chrono::Utc::now().to_rfc3339();
                    if *expires < now {
                        return Ok(None);
                    }
                }
                // Decrement uses
                if let Some(uses) = uses_remaining {
                    if uses <= 0 {
                        return Ok(None);
                    }
                    conn.execute(
                        "UPDATE invites SET uses_remaining = uses_remaining - 1 WHERE id = ?1",
                        rusqlite::params![invite_id],
                    )?;
                }
                Ok(Some(community_id))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    // ─── Discovery Cache ─────────────────────────────

    /// Cache a discovered peer's addresses.
    pub fn cache_discovery(
        &self,
        peer_id: &str,
        community_id: &str,
        addrs: &[String],
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let addrs_json = serde_json::to_string(addrs)?;
        conn.execute(
            "INSERT INTO discovery_cache (peer_id, community_id, addrs, last_seen)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(peer_id, community_id) DO UPDATE SET
                addrs = excluded.addrs,
                last_seen = datetime('now')",
            rusqlite::params![peer_id, community_id, addrs_json],
        )?;
        Ok(())
    }

    /// Load cached discovery records for a community.
    pub fn get_cached_discoveries(
        &self,
        community_id: &str,
    ) -> anyhow::Result<Vec<(String, Vec<String>)>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT peer_id, addrs FROM discovery_cache WHERE community_id = ?1 ORDER BY last_seen DESC LIMIT 50",
        )?;
        let rows = stmt.query_map(rusqlite::params![community_id], |row| {
            let peer_id: String = row.get(0)?;
            let addrs_json: String = row.get(1)?;
            Ok((peer_id, addrs_json))
        })?;
        let mut results = Vec::new();
        for row in rows {
            let (peer_id, addrs_json) = row?;
            let addrs: Vec<String> = serde_json::from_str(&addrs_json).unwrap_or_default();
            results.push((peer_id, addrs));
        }
        Ok(results)
    }
    // ─── Pending Message Queue (Offline Support) ─────

    /// Queue a message that failed to publish for later retry.
    pub fn queue_pending_message(&self, id: &str, topic: &str, data: &[u8]) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "INSERT OR IGNORE INTO pending_messages (id, topic, data, status)
             VALUES (?1, ?2, ?3, 'pending')",
            rusqlite::params![id, topic, data],
        )?;
        Ok(())
    }

    /// Get all pending messages ready for retry.
    pub fn get_pending_messages(&self) -> anyhow::Result<Vec<(String, String, Vec<u8>)>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT id, topic, data FROM pending_messages
             WHERE status = 'pending' AND retry_count < 10
             ORDER BY created_at ASC LIMIT 100",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Mark a pending message as sent (remove from queue).
    pub fn mark_pending_sent(&self, id: &str) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "DELETE FROM pending_messages WHERE id = ?1",
            rusqlite::params![id],
        )?;
        Ok(())
    }

    /// Increment retry count for a pending message.
    pub fn increment_pending_retry(&self, id: &str) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "UPDATE pending_messages SET retry_count = retry_count + 1 WHERE id = ?1",
            rusqlite::params![id],
        )?;
        Ok(())
    }

    /// Clear the entire pending_messages queue. Used on startup to drop
    /// stale entries from the previous InsufficientPeers queueing bug —
    /// those messages are already in the main messages table, so the
    /// pending entry is a dead retry slot.
    ///
    /// Safe to call unconditionally because:
    ///   - If the user's messages really did fail to publish, they're
    ///     already in the local DB (send_message inserts first, then
    ///     publishes), so they're visible to the sender.
    ///   - Late-joining peers discover state via the message history
    ///     request-response protocol, not via gossip replay of the
    ///     pending queue.
    ///
    /// Returns the number of rows deleted.
    pub fn clear_pending_messages(&self) -> anyhow::Result<usize> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let deleted = conn.execute("DELETE FROM pending_messages", [])?;
        Ok(deleted)
    }

    // ─── Channel Event Log ──────────────────────────────

    /// Append an event to the channel's immutable log. Returns the assigned sequence number.
    pub fn append_channel_event(
        &self,
        channel_id: &str,
        event_type: &str,
        event_id: &str,
        target_id: Option<&str>,
        author_public_key: &str,
        payload: &str,
        signature: &str,
        timestamp: &str,
    ) -> anyhow::Result<i64> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;

        // Wrap in explicit transaction to ensure atomicity of sequence assignment
        conn.execute_batch("BEGIN IMMEDIATE;")?;

        let result = (|| -> anyhow::Result<i64> {
            conn.execute(
                "INSERT OR IGNORE INTO channel_sequence (channel_id, latest_sequence) VALUES (?1, 0)",
                rusqlite::params![channel_id],
            )?;
            conn.execute(
                "UPDATE channel_sequence SET latest_sequence = latest_sequence + 1 WHERE channel_id = ?1",
                rusqlite::params![channel_id],
            )?;
            let seq: i64 = conn.query_row(
                "SELECT latest_sequence FROM channel_sequence WHERE channel_id = ?1",
                rusqlite::params![channel_id],
                |row| row.get(0),
            )?;

            conn.execute(
                "INSERT OR IGNORE INTO channel_events (sequence, channel_id, event_type, event_id, target_id, author_public_key, payload, signature, timestamp)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![seq, channel_id, event_type, event_id, target_id, author_public_key, payload, signature, timestamp],
            )?;

            Ok(seq)
        })();

        match result {
            Ok(seq) => {
                conn.execute_batch("COMMIT;")?;
                Ok(seq)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(e)
            }
        }
    }

    /// Find the sequence number of the event closest to (but not after) a given timestamp.
    /// Used to translate timestamp-based history cursors into sequence-based ones.
    pub fn get_sequence_for_timestamp(
        &self,
        channel_id: &str,
        timestamp: &str,
    ) -> anyhow::Result<i64> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let seq: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sequence), 0) FROM channel_events WHERE channel_id = ?1 AND timestamp <= ?2",
            rusqlite::params![channel_id, timestamp],
            |row| row.get(0),
        ).unwrap_or(0);
        Ok(seq)
    }

    /// Get the latest sequence number for a channel.
    pub fn get_channel_sequence(&self, channel_id: &str) -> anyhow::Result<i64> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let seq = conn
            .query_row(
                "SELECT latest_sequence FROM channel_sequence WHERE channel_id = ?1",
                rusqlite::params![channel_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok(seq)
    }

    /// Remove file availability records older than the given threshold.
    /// Returns the number of records removed.
    pub fn sweep_stale_file_seeders(&self, max_age_minutes: i64) -> anyhow::Result<u64> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let deleted = conn.execute(
            "DELETE FROM file_availability WHERE last_seen < datetime('now', ?1)",
            rusqlite::params![format!("-{} minutes", max_age_minutes)],
        )?;
        Ok(deleted as u64)
    }

    /// Get events in a sequence range for history sync.
    pub fn get_channel_events(
        &self,
        channel_id: &str,
        since_sequence: i64,
        limit: u32,
    ) -> anyhow::Result<Vec<serde_json::Value>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT sequence, event_type, event_id, target_id, author_public_key, payload, signature, timestamp
             FROM channel_events
             WHERE channel_id = ?1 AND sequence > ?2
             ORDER BY sequence ASC
             LIMIT ?3"
        )?;
        let rows = stmt.query_map(
            rusqlite::params![channel_id, since_sequence, limit],
            |row| {
                Ok(serde_json::json!({
                    "sequence": row.get::<_, i64>(0)?,
                    "eventType": row.get::<_, String>(1)?,
                    "eventId": row.get::<_, String>(2)?,
                    "targetId": row.get::<_, Option<String>>(3)?,
                    "authorPublicKey": row.get::<_, String>(4)?,
                    "payload": row.get::<_, String>(5)?,
                    "signature": row.get::<_, String>(6)?,
                    "timestamp": row.get::<_, String>(7)?,
                }))
            },
        )?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }
}

fn derive_database_key_hex() -> anyhow::Result<String> {
    const DB_MASTER_SECRET_NAME: &str = "mesh_db_master_secret";

    let master_secret = match keychain::lookup_secret(DB_MASTER_SECRET_NAME)? {
        keychain::SecretLookup::Found(secret) => secret,
        keychain::SecretLookup::Missing => {
            let mut secret = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut secret);
            keychain::store_secret(DB_MASTER_SECRET_NAME, &secret)?;
            secret.to_vec()
        }
    };

    let hk = Hkdf::<Sha256>::new(Some(b"mesh-db-salt"), &master_secret);
    let mut derived = [0u8; 32];
    hk.expand(b"mesh/db/sqlcipher", &mut derived)
        .map_err(|_| anyhow::anyhow!("failed to derive database key"))?;

    Ok(hex_encode(&derived))
}

fn open_encrypted_connection(db_path: &Path, key_hex: &str) -> anyhow::Result<Connection> {
    let conn = Connection::open(db_path)?;
    apply_sqlcipher_key(&conn, key_hex)?;
    Ok(conn)
}

fn apply_sqlcipher_key(conn: &Connection, key_hex: &str) -> anyhow::Result<()> {
    conn.execute_batch(&format!(
        "PRAGMA key = \"x'{}'\"; PRAGMA cipher_compatibility = 4;",
        key_hex
    ))?;

    // Force an early read so bad keys fail during startup rather than later.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_row| Ok(()))?;
    Ok(())
}

fn migrate_plaintext_database_if_needed(db_path: &Path, key_hex: &str) -> anyhow::Result<()> {
    if !db_path.exists() {
        return Ok(());
    }

    let metadata = std::fs::metadata(db_path)?;
    if metadata.len() == 0 {
        return Ok(());
    }

    let probe = Connection::open(db_path)?;
    let plaintext_readable = probe
        .query_row("SELECT count(*) FROM sqlite_master", [], |_row| Ok(()))
        .is_ok();
    drop(probe);

    if !plaintext_readable {
        return Ok(());
    }

    let temp_path = db_path.with_extension("encrypted.tmp");
    let backup_path = db_path.with_extension("plaintext.bak");
    if temp_path.exists() {
        let _ = std::fs::remove_file(&temp_path);
    }
    if backup_path.exists() {
        let _ = std::fs::remove_file(&backup_path);
    }

    let plaintext_conn = Connection::open(db_path)?;
    let escaped_temp = temp_path.to_string_lossy().replace('\'', "''");
    plaintext_conn.execute_batch(&format!(
        "ATTACH DATABASE '{escaped_temp}' AS encrypted KEY \"x'{key_hex}'\";
         SELECT sqlcipher_export('encrypted');
         DETACH DATABASE encrypted;"
    ))?;
    drop(plaintext_conn);

    for sibling in [
        db_path.with_extension("db-wal"),
        db_path.with_extension("db-shm"),
    ] {
        if sibling.exists() {
            let _ = std::fs::remove_file(sibling);
        }
    }

    std::fs::rename(db_path, &backup_path)?;
    if let Err(error) = std::fs::rename(&temp_path, db_path) {
        let _ = std::fs::rename(&backup_path, db_path);
        return Err(error.into());
    }
    let _ = std::fs::remove_file(&backup_path);
    Ok(())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A row from the members table.
#[derive(Debug, Clone)]
pub struct MemberRow {
    pub public_key: String,
    pub display_name: String,
    pub avatar_color: String,
    pub role: String,
    pub join_status: String,
    pub ban_status: String,
    pub x25519_public_key: Option<String>,
    pub last_seen: Option<String>,
}
