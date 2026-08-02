use crate::storage::Database;
use rusqlite::params;

type PeerRecord = (String, String, String, Vec<String>);

impl Database {
    /// Upsert a known peer into the address book.
    #[allow(dead_code)]
    pub fn upsert_peer(
        &self,
        public_key: &str,
        display_name: &str,
        avatar_color: &str,
        addrs: &[String],
        community_id: Option<&str>,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let addrs_json = serde_json::to_string(addrs)?;
        conn.execute(
            "INSERT OR REPLACE INTO peers (public_key, display_name, avatar_color, last_known_addrs, last_seen, community_id)
             VALUES (?1, ?2, ?3, ?4, datetime('now'), ?5)",
            params![public_key, display_name, avatar_color, addrs_json, community_id],
        )?;
        Ok(())
    }

    /// Get known peers for a community.
    #[allow(dead_code)]
    pub fn get_peers_for_community(&self, community_id: &str) -> anyhow::Result<Vec<PeerRecord>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT public_key, display_name, avatar_color, last_known_addrs FROM peers WHERE community_id = ?1",
        )?;
        let rows = stmt.query_map(params![community_id], |row| {
            let addrs_json: String = row.get(3)?;
            let addrs: Vec<String> = serde_json::from_str(&addrs_json).unwrap_or_default();
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, addrs))
        })?;
        let mut peers = Vec::new();
        for row in rows {
            peers.push(row?);
        }
        Ok(peers)
    }
}
