/// SQLite-backed persistent storage for Kademlia DHT records.
///
/// Replaces the default `MemoryStore` so that routing state (community peer
/// registrations) survive app restarts. This eliminates cold-start bootstrap
/// delays that previously required multi-minute reconnection via IPFS nodes.
///
/// DHT records are public information (peer IDs + multiaddrs), so this store
/// uses an **unencrypted** SQLite database separate from the main encrypted DB.
use libp2p::kad;
use libp2p::kad::store::{Error as StoreError, RecordStore, Result as StoreResult};
use libp2p::PeerId;
use rusqlite::Connection;
use std::borrow::Cow;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tracing::error;

pub struct SqliteDhtStore {
    conn: Mutex<Connection>,
    local_key: kad::KBucketKey<PeerId>,
    /// Records we are providing — tracked in-memory for fast iteration.
    provided: Mutex<HashSet<kad::RecordKey>>,
}

impl SqliteDhtStore {
    /// Open (or create) the DHT store database at the given path.
    pub fn new(app_data_dir: PathBuf, local_peer_id: PeerId) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&app_data_dir)?;
        let db_path = app_data_dir.join("dht_store.db");
        let conn = Connection::open(db_path)?;

        // Enable WAL for concurrent reads
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;

        // Create table
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS dht_records (
                key BLOB PRIMARY KEY,
                value BLOB NOT NULL,
                publisher TEXT,
                expires_at INTEGER,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );",
        )?;

        // Purge expired records on startup
        conn.execute(
            "DELETE FROM dht_records WHERE expires_at IS NOT NULL AND expires_at < strftime('%s', 'now')",
            [],
        )?;

        Ok(Self {
            conn: Mutex::new(conn),
            local_key: kad::KBucketKey::from(local_peer_id),
            provided: Mutex::new(HashSet::new()),
        })
    }

    /// Remove records older than the TTL.
    #[allow(dead_code)]
    pub fn gc_expired(&self) {
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute(
                "DELETE FROM dht_records WHERE expires_at IS NOT NULL AND expires_at < strftime('%s', 'now')",
                [],
            );
        }
    }
}

impl RecordStore for SqliteDhtStore {
    type RecordsIter<'a> = std::vec::IntoIter<Cow<'a, kad::Record>>;
    type ProvidedIter<'a> = std::vec::IntoIter<Cow<'a, kad::ProviderRecord>>;

    fn get(&self, k: &kad::RecordKey) -> Option<Cow<'_, kad::Record>> {
        let conn = self.conn.lock().ok()?;
        let mut stmt = conn
            .prepare(
                "SELECT key, value, publisher, expires_at FROM dht_records
                 WHERE key = ?1 AND (expires_at IS NULL OR expires_at >= strftime('%s', 'now'))",
            )
            .ok()?;
        stmt.query_row(rusqlite::params![k.as_ref()], |row| {
            let key_bytes: Vec<u8> = row.get(0)?;
            let value: Vec<u8> = row.get(1)?;
            let publisher_str: Option<String> = row.get(2)?;
            let expires_epoch: Option<i64> = row.get(3)?;

            let publisher = publisher_str.and_then(|s| s.parse::<PeerId>().ok());
            let expires = expires_epoch.map(|epoch| {
                let now_epoch = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                let remaining = (epoch - now_epoch).max(0) as u64;
                Instant::now() + Duration::from_secs(remaining)
            });

            Ok(Cow::Owned(kad::Record {
                key: kad::RecordKey::new(&key_bytes),
                value,
                publisher,
                expires,
            }))
        })
        .ok()
    }

    fn put(&mut self, r: kad::Record) -> StoreResult<()> {
        let conn = self.conn.lock().map_err(|_| StoreError::MaxRecords)?;
        let publisher_str = r.publisher.map(|p| p.to_string());
        let expires_epoch: Option<i64> = r.expires.map(|instant| {
            let remaining = instant.saturating_duration_since(Instant::now());
            let now_epoch = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            now_epoch + remaining.as_secs() as i64
        });

        conn.execute(
            "INSERT INTO dht_records (key, value, publisher, expires_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                publisher = excluded.publisher,
                expires_at = excluded.expires_at",
            rusqlite::params![r.key.as_ref(), r.value, publisher_str, expires_epoch],
        )
        .map_err(|e| {
            error!("DHT store put failed: {}", e);
            StoreError::MaxRecords
        })?;
        Ok(())
    }

    fn remove(&mut self, k: &kad::RecordKey) {
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute(
                "DELETE FROM dht_records WHERE key = ?1",
                rusqlite::params![k.as_ref()],
            );
        }
    }

    fn records(&self) -> Self::RecordsIter<'_> {
        let records: Vec<Cow<'_, kad::Record>> = self
            .conn
            .lock()
            .ok()
            .and_then(|conn| {
                let mut stmt = conn
                    .prepare(
                        "SELECT key, value, publisher, expires_at FROM dht_records
                         WHERE expires_at IS NULL OR expires_at >= strftime('%s', 'now')",
                    )
                    .ok()?;
                let rows = stmt
                    .query_map([], |row| {
                        let key_bytes: Vec<u8> = row.get(0)?;
                        let value: Vec<u8> = row.get(1)?;
                        let publisher_str: Option<String> = row.get(2)?;
                        let expires_epoch: Option<i64> = row.get(3)?;

                        let publisher = publisher_str.and_then(|s| s.parse::<PeerId>().ok());
                        let expires = expires_epoch.map(|epoch| {
                            let now_epoch = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs() as i64;
                            let remaining = (epoch - now_epoch).max(0) as u64;
                            Instant::now() + Duration::from_secs(remaining)
                        });

                        Ok(Cow::Owned(kad::Record {
                            key: kad::RecordKey::new(&key_bytes),
                            value,
                            publisher,
                            expires,
                        }))
                    })
                    .ok()?;
                Some(rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
            })
            .unwrap_or_default();
        records.into_iter()
    }

    fn add_provider(&mut self, record: kad::ProviderRecord) -> StoreResult<()> {
        if let Ok(mut provided) = self.provided.lock() {
            provided.insert(record.key);
        }
        Ok(())
    }

    fn providers(&self, key: &kad::RecordKey) -> Vec<kad::ProviderRecord> {
        let is_provided = self
            .provided
            .lock()
            .map(|provided| provided.contains(key))
            .unwrap_or(false);

        if is_provided {
            let peer_id = self.local_key.into_preimage();
            return vec![kad::ProviderRecord {
                key: key.clone(),
                provider: peer_id,
                expires: None,
                addresses: vec![],
            }];
        }
        vec![]
    }

    fn provided(&self) -> Self::ProvidedIter<'_> {
        let records: Vec<Cow<'_, kad::ProviderRecord>> = self
            .provided
            .lock()
            .ok()
            .map(|provided| {
                let peer_id = self.local_key.into_preimage();
                provided
                    .iter()
                    .map(|key| {
                        Cow::Owned(kad::ProviderRecord {
                            key: key.clone(),
                            provider: peer_id,
                            expires: None,
                            addresses: vec![],
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        records.into_iter()
    }

    fn remove_provider(&mut self, key: &kad::RecordKey, _provider: &PeerId) {
        if let Ok(mut provided) = self.provided.lock() {
            provided.remove(key);
        }
    }
}
