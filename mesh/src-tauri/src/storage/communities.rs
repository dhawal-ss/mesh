use crate::crypto::community_key::CommunityKey;
use crate::crypto::encryption;
use crate::storage::Database;
use crate::types::community::{ChannelDto, CommunityDto};
use crate::types::identity::LocalProfile;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use rusqlite::params;

impl Database {
    // ─── Profile ────────────────────────────────────────

    /// Create or update the local user profile.
    pub fn set_local_profile(
        &self,
        public_key: &str,
        display_name: &str,
        avatar_color: &str,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "INSERT OR REPLACE INTO local_profile (public_key, display_name, avatar_color) VALUES (?1, ?2, ?3)",
            params![public_key, display_name, avatar_color],
        )?;
        Ok(())
    }

    /// Get the local user profile.
    pub fn get_local_profile(&self, public_key: &str) -> anyhow::Result<Option<LocalProfile>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT public_key, display_name, avatar_color FROM local_profile WHERE public_key = ?1",
        )?;
        let result = stmt.query_row(params![public_key], |row| {
            Ok(LocalProfile {
                public_key: row.get(0)?,
                display_name: row.get(1)?,
                avatar_color: row.get(2)?,
            })
        });
        match result {
            Ok(profile) => Ok(Some(profile)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    // ─── Communities ────────────────────────────────────

    /// Create a new community in the local database.
    /// If the user is the owner, the private key is stored in the OS keychain.
    pub fn create_community(
        &self,
        id: &str,
        name: &str,
        description: &str,
        community_private_key: Option<&str>,
        group_key: Option<&str>,
        owner_public_key: Option<&str>,
    ) -> anyhow::Result<()> {
        // Store private key in OS keychain instead of SQLite
        if let Some(private_key_b64) = community_private_key {
            let private_key_bytes = BASE64.decode(private_key_b64)?;
            crate::crypto::keychain::store_secret(
                &format!("community_key_{}", id),
                &private_key_bytes,
            )?;
            tracing::info!(community_id = %id, "Stored community private key in OS keychain");
        }

        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let role = if community_private_key.is_some() {
            "owner"
        } else {
            "member"
        };
        // Store NULL for community_private_key in DB — key lives in keychain
        conn.execute(
            "INSERT OR REPLACE INTO communities (id, name, description, community_private_key, our_role, group_key, owner_public_key) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6)",
            params![id, name, description, role, group_key, owner_public_key],
        )?;
        Ok(())
    }

    /// Retrieve the group encryption key for a community.
    pub fn get_group_key(&self, community_id: &str) -> anyhow::Result<Option<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let result: Result<Option<String>, rusqlite::Error> = conn.query_row(
            "SELECT group_key FROM communities WHERE id = ?1",
            params![community_id],
            |row| row.get(0),
        );
        match result {
            Ok(key) => Ok(key),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn set_group_key(&self, community_id: &str, group_key: &str) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "UPDATE communities SET group_key = ?2 WHERE id = ?1",
            params![community_id, group_key],
        )?;
        Ok(())
    }

    /// Get the current group key epoch for a community.
    /// Returns None if no epoch has been stored yet (first rotation).
    pub fn get_group_key_epoch(&self, community_id: &str) -> anyhow::Result<Option<u64>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let result: Result<Option<i64>, rusqlite::Error> = conn.query_row(
            "SELECT group_key_epoch FROM communities WHERE id = ?1",
            params![community_id],
            |row| row.get(0),
        );
        match result {
            Ok(Some(epoch)) => Ok(Some(epoch as u64)),
            Ok(None) => Ok(None),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Set the group key epoch for a community.
    pub fn set_group_key_epoch(&self, community_id: &str, epoch: u64) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "UPDATE communities SET group_key_epoch = ?2 WHERE id = ?1",
            params![community_id, epoch as i64],
        )?;
        Ok(())
    }

    pub fn update_joined_community_snapshot(
        &self,
        community_id: &str,
        name: &str,
        description: &str,
        owner_public_key: &str,
        group_key: &str,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "UPDATE communities
             SET name = ?2,
                 description = ?3,
                 owner_public_key = ?4,
                 group_key = ?5
             WHERE id = ?1",
            params![community_id, name, description, owner_public_key, group_key],
        )?;
        Ok(())
    }

    pub fn replace_channels_for_community(
        &self,
        community_id: &str,
        channels: &[crate::types::community::ChannelDto],
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "DELETE FROM channels WHERE community_id = ?1",
            params![community_id],
        )?;
        for channel in channels {
            conn.execute(
                "INSERT INTO channels (id, community_id, name, channel_type) VALUES (?1, ?2, ?3, ?4)",
                params![channel.id, community_id, channel.name, channel.channel_type],
            )?;
        }
        Ok(())
    }

    pub fn get_community_snapshot(
        &self,
        community_id: &str,
    ) -> anyhow::Result<Option<(CommunityDto, Vec<ChannelDto>)>> {
        let community = {
            let conn = self
                .conn
                .lock()
                .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
            let result = conn.query_row(
                "SELECT id, name, description, our_role, joined_at FROM communities WHERE id = ?1",
                params![community_id],
                |row| {
                    Ok(CommunityDto {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        role: row.get(3)?,
                        joined_at: row.get(4)?,
                        member_count: 0,
                    })
                },
            );
            match result {
                Ok(community) => Some(community),
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(error) => return Err(error.into()),
            }
        };

        let Some(mut community) = community else {
            return Ok(None);
        };
        community.member_count = self.member_count(community_id).unwrap_or(0);
        let channels = self.get_channels(community_id)?;
        Ok(Some((community, channels)))
    }

    pub fn encrypt_community_payload(
        &self,
        community_id: &str,
        plaintext: &[u8],
        aad: &[u8],
    ) -> anyhow::Result<Vec<u8>> {
        let key_b64 = self
            .get_group_key(community_id)?
            .ok_or_else(|| anyhow::anyhow!("missing group key for community {}", community_id))?;
        let group_key = encryption::group_key_from_b64(&key_b64)?;
        encryption::encrypt_community_payload(&group_key, plaintext, aad)
    }

    pub fn get_community_owner_public_key(
        &self,
        community_id: &str,
    ) -> anyhow::Result<Option<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let result: Result<(Option<String>, Option<String>), rusqlite::Error> = conn.query_row(
            "SELECT owner_public_key, community_private_key FROM communities WHERE id = ?1",
            params![community_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        );

        match result {
            Ok((Some(owner_public_key), _)) => Ok(Some(owner_public_key)),
            Ok((None, Some(private_key_b64))) => {
                let community_key = CommunityKey::from_private_key_b64(&private_key_b64)?;
                Ok(Some(BASE64.encode(community_key.verifying_key.as_bytes())))
            }
            Ok((None, None)) | Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Get the community private key.
    /// Checks OS keychain first, falls back to SQLite column for legacy migration.
    pub fn get_community_private_key(&self, community_id: &str) -> anyhow::Result<Option<String>> {
        // 1. Try keychain first (preferred location)
        let keychain_key = format!("community_key_{}", community_id);
        if let Ok(secret_bytes) = crate::crypto::keychain::load_secret(&keychain_key) {
            return Ok(Some(BASE64.encode(&secret_bytes)));
        }

        // 2. Fall back to SQLite column (legacy, pre-migration)
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let result: Result<Option<String>, rusqlite::Error> = conn.query_row(
            "SELECT community_private_key FROM communities WHERE id = ?1",
            params![community_id],
            |row| row.get(0),
        );

        match result {
            Ok(Some(private_key)) => {
                // Auto-migrate: move key from DB to keychain
                if let Ok(key_bytes) = BASE64.decode(&private_key) {
                    if crate::crypto::keychain::store_secret(&keychain_key, &key_bytes).is_ok() {
                        // Clear from DB after successful keychain store
                        let _ = conn.execute(
                            "UPDATE communities SET community_private_key = NULL WHERE id = ?1",
                            params![community_id],
                        );
                        tracing::info!(community_id = %community_id, "Auto-migrated community key to OS keychain");
                    }
                }
                Ok(Some(private_key))
            }
            Ok(None) => Ok(None),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn get_community_keypair(
        &self,
        community_id: &str,
    ) -> anyhow::Result<Option<CommunityKey>> {
        let Some(private_key_b64) = self.get_community_private_key(community_id)? else {
            return Ok(None);
        };

        CommunityKey::from_private_key_b64(&private_key_b64).map(Some)
    }

    /// Get all communities.
    pub fn get_communities(&self) -> anyhow::Result<Vec<CommunityDto>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut stmt =
            conn.prepare("SELECT id, name, description, our_role, joined_at FROM communities")?;
        let rows = stmt.query_map([], |row| {
            Ok(CommunityDto {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                role: row.get(3)?,
                joined_at: row.get(4)?,
                member_count: 0, // populated from the authoritative membership table
            })
        })?;
        let mut communities = Vec::new();
        for row in rows {
            communities.push(row?);
        }
        Ok(communities)
    }

    /// Delete a community.
    pub fn delete_community(&self, id: &str) -> anyhow::Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE community_id = ?1)",
            params![id],
        )?;
        tx.execute("DELETE FROM channels WHERE community_id = ?1", params![id])?;
        tx.execute("DELETE FROM peers WHERE community_id = ?1", params![id])?;
        tx.execute("DELETE FROM ban_list WHERE community_id = ?1", params![id])?;
        tx.execute("DELETE FROM members WHERE community_id = ?1", params![id])?;
        tx.execute(
            "DELETE FROM control_log WHERE community_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM last_read WHERE community_id = ?1", params![id])?;
        tx.execute("DELETE FROM invites WHERE community_id = ?1", params![id])?;
        tx.execute(
            "DELETE FROM discovery_cache WHERE community_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM communities WHERE id = ?1", params![id])?;
        tx.commit()?;

        // Clean up keychain entry
        let keychain_key = format!("community_key_{}", id);
        let _ = crate::crypto::keychain::delete_secret(&keychain_key);

        Ok(())
    }

    // ─── Channels ───────────────────────────────────────

    /// Create a new channel in a community.
    pub fn create_channel(
        &self,
        id: &str,
        community_id: &str,
        name: &str,
        channel_type: &str,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "INSERT INTO channels (id, community_id, name, channel_type) VALUES (?1, ?2, ?3, ?4)",
            params![id, community_id, name, channel_type],
        )?;
        Ok(())
    }

    pub fn upsert_local_channel(
        &self,
        id: &str,
        community_id: &str,
        name: &str,
        channel_type: &str,
    ) -> anyhow::Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let exists = conn
            .query_row("SELECT 1 FROM channels WHERE id = ?1", params![id], |_| {
                Ok(())
            })
            .is_ok();
        conn.execute(
            "INSERT INTO channels (id, community_id, name, channel_type)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                community_id = excluded.community_id,
                name = excluded.name,
                channel_type = excluded.channel_type",
            params![id, community_id, name, channel_type],
        )?;
        Ok(!exists)
    }

    /// Get channels for a community.
    pub fn get_channels(&self, community_id: &str) -> anyhow::Result<Vec<ChannelDto>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT id, community_id, name, channel_type FROM channels WHERE community_id = ?1",
        )?;
        let rows = stmt.query_map(params![community_id], |row| {
            Ok(ChannelDto {
                id: row.get(0)?,
                community_id: row.get(1)?,
                name: row.get(2)?,
                channel_type: row.get(3)?,
                unread_count: 0,
            })
        })?;
        let mut channels = Vec::new();
        for row in rows {
            channels.push(row?);
        }
        Ok(channels)
    }

    pub fn get_all_channel_ids(&self) -> anyhow::Result<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut stmt = conn.prepare("SELECT id FROM channels")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut channel_ids = Vec::new();
        for row in rows {
            channel_ids.push(row?);
        }
        Ok(channel_ids)
    }

    /// Look up which community a channel belongs to.
    #[allow(dead_code)]
    pub fn get_channel_community_id(&self, channel_id: &str) -> anyhow::Result<Option<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let result: Result<String, _> = conn.query_row(
            "SELECT community_id FROM channels WHERE id = ?1",
            params![channel_id],
            |row| row.get(0),
        );
        match result {
            Ok(community_id) => Ok(Some(community_id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
}
