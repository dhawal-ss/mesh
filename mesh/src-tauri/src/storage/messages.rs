use crate::storage::Database;
use crate::types::message::MessageDto;
use rusqlite::params;

/// Column list used in all message SELECT queries.
const MSG_COLS: &str = "m.id, m.channel_id, m.author_public_key, m.author_display_name, m.author_avatar_color, m.content, m.attachments, m.reactions, m.timestamp, m.signature, m.edited_at, m.deleted_at, m.reply_to_id";

impl Database {
    pub fn get_latest_message_cursor(
        &self,
        channel_id: &str,
    ) -> anyhow::Result<Option<(String, String)>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let result = conn.query_row(
            "SELECT timestamp, id FROM messages WHERE channel_id = ?1 ORDER BY timestamp DESC, id DESC LIMIT 1",
            params![channel_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        );

        match result {
            Ok(cursor) => Ok(Some(cursor)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Check whether a message already exists by id.
    pub fn message_exists(&self, message_id: &str) -> anyhow::Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(1) FROM messages WHERE id = ?1",
            params![message_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Insert a message into the local database.
    pub fn insert_message(&self, msg: &MessageDto) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "INSERT OR IGNORE INTO messages (id, channel_id, author_public_key, author_display_name, author_avatar_color, content, attachments, reactions, timestamp, signature, edited_at, deleted_at, reply_to_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                msg.id,
                msg.channel_id,
                msg.author_public_key,
                msg.author_display_name,
                msg.author_avatar_color,
                msg.content,
                serde_json::to_string(&msg.attachments)?,
                serde_json::to_string(&msg.reactions)?,
                msg.timestamp,
                msg.signature,
                msg.edited_at,
                msg.deleted_at,
                msg.reply_to_id,
            ],
        )?;
        Ok(())
    }

    /// Get messages for a channel, ordered by timestamp descending.
    pub fn get_messages(
        &self,
        channel_id: &str,
        limit: u32,
        before_timestamp: Option<&str>,
        before_id: Option<&str>,
    ) -> anyhow::Result<Vec<MessageDto>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;

        let mut messages = Vec::new();

        if let Some(before_ts) = before_timestamp {
            let sql = format!(
                "SELECT {MSG_COLS}
                 FROM messages m
                 JOIN channels c ON m.channel_id = c.id
                 WHERE m.channel_id = ?1
                 AND (
                    m.timestamp < ?2
                    OR (m.timestamp = ?2 AND (?3 IS NULL OR m.id < ?3))
                 )
                 AND m.author_public_key NOT IN (
                    SELECT public_key FROM ban_list WHERE community_id = c.community_id
                 )
                 ORDER BY m.timestamp DESC, m.id DESC LIMIT ?4"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![channel_id, before_ts, before_id, limit], |row| {
                Ok(Self::row_to_message(row))
            })?;
            for row in rows {
                messages.push(row??);
            }
        } else {
            let sql = format!(
                "SELECT {MSG_COLS}
                 FROM messages m
                 JOIN channels c ON m.channel_id = c.id
                 WHERE m.channel_id = ?1
                 AND m.author_public_key NOT IN (
                    SELECT public_key FROM ban_list WHERE community_id = c.community_id
                 )
                 ORDER BY m.timestamp DESC, m.id DESC LIMIT ?2"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![channel_id, limit], |row| {
                Ok(Self::row_to_message(row))
            })?;
            for row in rows {
                messages.push(row??);
            }
        }

        // Reverse so oldest is first in the returned array
        messages.reverse();
        Ok(messages)
    }

    pub fn get_messages_after(
        &self,
        channel_id: &str,
        since_timestamp: Option<&str>,
        since_id: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<MessageDto>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut messages = Vec::new();

        let mut stmt = match (since_timestamp, since_id) {
            (Some(_), Some(_)) => conn.prepare(&format!(
                "SELECT {MSG_COLS}
                 FROM messages m
                 LEFT JOIN channels c ON m.channel_id = c.id
                 WHERE m.channel_id = ?1
                   AND (m.timestamp > ?2 OR (m.timestamp = ?2 AND m.id > ?3))
                   AND (c.community_id IS NULL OR m.author_public_key NOT IN (
                        SELECT public_key FROM ban_list WHERE community_id = c.community_id
                   ))
                 ORDER BY m.timestamp ASC, m.id ASC
                 LIMIT ?4"
            ))?,
            (Some(_), None) => conn.prepare(&format!(
                "SELECT {MSG_COLS}
                 FROM messages m
                 LEFT JOIN channels c ON m.channel_id = c.id
                 WHERE m.channel_id = ?1
                   AND m.timestamp > ?2
                   AND (c.community_id IS NULL OR m.author_public_key NOT IN (
                        SELECT public_key FROM ban_list WHERE community_id = c.community_id
                   ))
                 ORDER BY m.timestamp ASC, m.id ASC
                 LIMIT ?3"
            ))?,
            _ => conn.prepare(&format!(
                "SELECT {MSG_COLS}
                 FROM messages m
                 LEFT JOIN channels c ON m.channel_id = c.id
                 WHERE m.channel_id = ?1
                   AND (c.community_id IS NULL OR m.author_public_key NOT IN (
                        SELECT public_key FROM ban_list WHERE community_id = c.community_id
                   ))
                 ORDER BY m.timestamp DESC, m.id DESC
                 LIMIT ?2"
            ))?,
        };

        match (since_timestamp, since_id) {
            (Some(timestamp), Some(message_id)) => {
                let rows = stmt
                    .query_map(params![channel_id, timestamp, message_id, limit], |row| {
                        Ok(Self::row_to_message(row))
                    })?;
                for row in rows {
                    messages.push(row??);
                }
            }
            (Some(timestamp), None) => {
                let rows = stmt.query_map(params![channel_id, timestamp, limit], |row| {
                    Ok(Self::row_to_message(row))
                })?;
                for row in rows {
                    messages.push(row??);
                }
            }
            _ => {
                let rows = stmt.query_map(params![channel_id, limit], |row| {
                    Ok(Self::row_to_message(row))
                })?;
                for row in rows {
                    messages.push(row??);
                }
            }
        }

        if since_timestamp.is_none() {
            messages.reverse();
        }

        Ok(messages)
    }

    fn row_to_message(row: &rusqlite::Row) -> anyhow::Result<MessageDto> {
        let attachments_json: String = row.get(6)?;
        let reactions_json: String = row.get(7)?;

        Ok(MessageDto {
            id: row.get(0)?,
            channel_id: row.get(1)?,
            author_public_key: row.get(2)?,
            author_display_name: row.get(3)?,
            author_avatar_color: row.get(4)?,
            content: row.get(5)?,
            attachments: serde_json::from_str(&attachments_json).unwrap_or_default(),
            reactions: serde_json::from_str(&reactions_json).unwrap_or_default(),
            timestamp: row.get(8)?,
            signature: row.get(9)?,
            edited_at: row.get(10)?,
            deleted_at: row.get(11)?,
            reply_to_id: row.get(12)?,
            delivery_status: None,
        })
    }

    /// Get a single message by ID.
    pub fn get_message_by_id(&self, message_id: &str) -> anyhow::Result<Option<MessageDto>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let sql = format!(
            "SELECT {MSG_COLS} FROM messages m WHERE m.id = ?1"
        );
        let result = conn.query_row(&sql, params![message_id], |row| {
            Ok(Self::row_to_message(row))
        });
        match result {
            Ok(msg) => Ok(Some(msg?)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Update a message's content and set edited_at. Verifies author matches.
    pub fn update_message_content(
        &self,
        message_id: &str,
        content: &str,
        author_public_key: &str,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let rows_affected = conn.execute(
            "UPDATE messages SET content = ?1, edited_at = datetime('now') WHERE id = ?2 AND author_public_key = ?3",
            params![content, message_id, author_public_key],
        )?;
        if rows_affected == 0 {
            anyhow::bail!("Message not found or not owned by caller");
        }
        Ok(())
    }

    /// Soft-delete a message: set deleted_at and clear content. Verifies author matches.
    pub fn soft_delete_message(
        &self,
        message_id: &str,
        author_public_key: &str,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let rows_affected = conn.execute(
            "UPDATE messages SET content = '', deleted_at = datetime('now') WHERE id = ?1 AND author_public_key = ?2",
            params![message_id, author_public_key],
        )?;
        if rows_affected == 0 {
            anyhow::bail!("Message not found or not owned by caller");
        }
        Ok(())
    }

    /// Moderator soft-delete: clear content and set deleted_at without checking author.
    pub fn moderator_delete_message(&self, message_id: &str) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let rows_affected = conn.execute(
            "UPDATE messages SET content = '', deleted_at = datetime('now') WHERE id = ?1",
            params![message_id],
        )?;
        if rows_affected == 0 {
            anyhow::bail!("Message not found");
        }
        Ok(())
    }

    /// Get the community_id for a given channel.
    pub fn get_community_for_channel(&self, channel_id: &str) -> anyhow::Result<String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let community_id: String = conn.query_row(
            "SELECT community_id FROM channels WHERE id = ?1",
            params![channel_id],
            |row| row.get(0),
        )?;
        Ok(community_id)
    }

    /// Get the channel_id and community_id for a given message.
    pub fn get_channel_and_community_for_message(
        &self,
        message_id: &str,
    ) -> anyhow::Result<(String, String)> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let result = conn.query_row(
            "SELECT m.channel_id, c.community_id FROM messages m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?1",
            params![message_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        Ok(result)
    }

    /// Toggle a reaction on a message. Returns the verb used ("add" or "remove").
    pub fn add_reaction(
        &self,
        message_id: &str,
        emoji: &str,
        public_key: &str,
    ) -> anyhow::Result<String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;

        let reactions_json: String = conn.query_row(
            "SELECT reactions FROM messages WHERE id = ?1",
            params![message_id],
            |row| row.get(0),
        )?;

        let reactions: std::collections::HashMap<String, Vec<String>> =
            serde_json::from_str(&reactions_json).unwrap_or_default();

        let already_reacted = reactions
            .get(emoji)
            .map(|authors| authors.contains(&public_key.to_string()))
            .unwrap_or(false);

        drop(conn);

        let verb = if already_reacted {
            self.remove_reaction_idempotent(message_id, emoji, public_key)?;
            "remove"
        } else {
            self.add_reaction_idempotent(message_id, emoji, public_key)?;
            "add"
        };

        Ok(verb.to_string())
    }

    /// Idempotent add: adds public_key to the emoji's author list only if not already present.
    pub fn add_reaction_idempotent(
        &self,
        message_id: &str,
        emoji: &str,
        public_key: &str,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;

        let reactions_json: String = conn.query_row(
            "SELECT reactions FROM messages WHERE id = ?1",
            params![message_id],
            |row| row.get(0),
        )?;

        let mut reactions: std::collections::HashMap<String, Vec<String>> =
            serde_json::from_str(&reactions_json).unwrap_or_default();

        let entry = reactions.entry(emoji.to_string()).or_default();
        if !entry.contains(&public_key.to_string()) {
            entry.push(public_key.to_string());

            let new_reactions_json = serde_json::to_string(&reactions)?;
            conn.execute(
                "UPDATE messages SET reactions = ?1 WHERE id = ?2",
                params![new_reactions_json, message_id],
            )?;
        }

        Ok(())
    }

    /// Idempotent remove: removes public_key from the emoji's author list only if present.
    pub fn remove_reaction_idempotent(
        &self,
        message_id: &str,
        emoji: &str,
        public_key: &str,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;

        let reactions_json: String = conn.query_row(
            "SELECT reactions FROM messages WHERE id = ?1",
            params![message_id],
            |row| row.get(0),
        )?;

        let mut reactions: std::collections::HashMap<String, Vec<String>> =
            serde_json::from_str(&reactions_json).unwrap_or_default();

        let mut changed = false;
        if let Some(entry) = reactions.get_mut(emoji) {
            if let Some(pos) = entry.iter().position(|pk| pk == public_key) {
                entry.remove(pos);
                changed = true;
                if entry.is_empty() {
                    reactions.remove(emoji);
                }
            }
        }

        if changed {
            let new_reactions_json = serde_json::to_string(&reactions)?;
            conn.execute(
                "UPDATE messages SET reactions = ?1 WHERE id = ?2",
                params![new_reactions_json, message_id],
            )?;
        }

        Ok(())
    }

    pub fn is_banned(&self, community_id: &str, public_key: &str) -> anyhow::Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(1) FROM ban_list WHERE community_id = ?1 AND public_key = ?2",
            params![community_id, public_key],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn remove_reactions_by_author(
        &self,
        community_id: &str,
        public_key: &str,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT m.id, m.reactions
             FROM messages m
             JOIN channels c ON m.channel_id = c.id
             WHERE c.community_id = ?1",
        )?;
        let rows = stmt.query_map(params![community_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;

        for row in rows {
            let (message_id, reactions_json) = row?;
            let mut reactions: std::collections::HashMap<String, Vec<String>> =
                serde_json::from_str(&reactions_json).unwrap_or_default();
            let original_json = serde_json::to_string(&reactions)?;

            reactions.retain(|_, authors| {
                authors.retain(|author| author != public_key);
                !authors.is_empty()
            });

            let updated_json = serde_json::to_string(&reactions)?;
            if updated_json != original_json {
                conn.execute(
                    "UPDATE messages SET reactions = ?1 WHERE id = ?2",
                    params![updated_json, message_id],
                )?;
            }
        }

        Ok(())
    }

    /// Full-text search messages using FTS5.
    /// Returns messages matching the query, scoped to a community.
    pub fn search_messages(
        &self,
        query: &str,
        community_id: &str,
        limit: u32,
    ) -> anyhow::Result<Vec<MessageDto>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;

        // Sanitize the query for FTS5: escape double quotes
        let sanitized = query.replace('"', "\"\"");
        let fts_query = format!("\"{}\"", sanitized);

        let sql = format!(
            "SELECT {MSG_COLS}
             FROM messages m
             JOIN channels c ON m.channel_id = c.id
             JOIN messages_fts fts ON fts.id = m.id
             WHERE c.community_id = ?1
             AND messages_fts MATCH ?2
             ORDER BY rank
             LIMIT ?3"
        );

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![community_id, fts_query, limit], |row| {
            Ok(Self::row_to_message(row))
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row??);
        }
        Ok(results)
    }
}
