use rusqlite::params;

use crate::types::dm::{DirectMessageDto, DmConversationDto};

use super::Database;

impl Database {
    /// Get or create a DM conversation for a peer.
    pub fn get_or_create_dm_conversation(
        &self,
        peer_public_key: &str,
        peer_display_name: &str,
        peer_avatar_color: &str,
    ) -> anyhow::Result<DmConversationDto> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;

        // Try to find existing conversation
        let existing = conn
            .prepare(
                "SELECT id, peer_public_key, peer_display_name, peer_avatar_color,
                        last_message_at, unread_count, created_at
                 FROM dm_conversations WHERE peer_public_key = ?1",
            )?
            .query_row(params![peer_public_key], |row| {
                Ok(DmConversationDto {
                    id: row.get(0)?,
                    peer_public_key: row.get(1)?,
                    peer_display_name: row.get(2)?,
                    peer_avatar_color: row.get(3)?,
                    last_message_at: row.get(4)?,
                    unread_count: row.get(5)?,
                    created_at: row.get(6)?,
                })
            });

        if let Ok(conv) = existing {
            return Ok(conv);
        }

        // Create new conversation
        let id = nanoid::nanoid!();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO dm_conversations (id, peer_public_key, peer_display_name, peer_avatar_color, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, peer_public_key, peer_display_name, peer_avatar_color, now],
        )?;

        Ok(DmConversationDto {
            id,
            peer_public_key: peer_public_key.to_string(),
            peer_display_name: peer_display_name.to_string(),
            peer_avatar_color: peer_avatar_color.to_string(),
            last_message_at: None,
            unread_count: 0,
            created_at: now,
        })
    }

    /// Get all DM conversations ordered by most recent message.
    pub fn get_dm_conversations(&self) -> anyhow::Result<Vec<DmConversationDto>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;

        let mut stmt = conn.prepare(
            "SELECT id, peer_public_key, peer_display_name, peer_avatar_color,
                    last_message_at, unread_count, created_at
             FROM dm_conversations
             ORDER BY COALESCE(last_message_at, created_at) DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(DmConversationDto {
                id: row.get(0)?,
                peer_public_key: row.get(1)?,
                peer_display_name: row.get(2)?,
                peer_avatar_color: row.get(3)?,
                last_message_at: row.get(4)?,
                unread_count: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    /// Insert a direct message and update conversation metadata.
    pub fn insert_dm(
        &self,
        msg: &DirectMessageDto,
        conversation_id: &str,
        is_incoming: bool,
    ) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;

        // Check for duplicates
        let exists: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM direct_messages WHERE id = ?1",
            params![msg.id],
            |row| row.get(0),
        )?;
        if exists {
            return Ok(());
        }

        conn.execute(
            "INSERT INTO direct_messages (id, conversation_id, author_public_key, author_display_name, author_avatar_color, content, timestamp, signature)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                msg.id,
                conversation_id,
                msg.author_public_key,
                msg.author_display_name,
                msg.author_avatar_color,
                msg.content,
                msg.timestamp,
                msg.signature,
            ],
        )?;

        // Update conversation last_message_at and unread count
        if is_incoming {
            conn.execute(
                "UPDATE dm_conversations SET last_message_at = ?1, unread_count = unread_count + 1 WHERE id = ?2",
                params![msg.timestamp, conversation_id],
            )?;
        } else {
            conn.execute(
                "UPDATE dm_conversations SET last_message_at = ?1 WHERE id = ?2",
                params![msg.timestamp, conversation_id],
            )?;
        }

        Ok(())
    }

    /// Get paginated DM messages for a conversation.
    pub fn get_dm_messages(
        &self,
        conversation_id: &str,
        limit: u32,
        before_timestamp: Option<&str>,
        before_id: Option<&str>,
    ) -> anyhow::Result<Vec<DirectMessageDto>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;

        let (sql, params_vec): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = match (
            before_timestamp,
            before_id,
        ) {
            (Some(ts), Some(id)) => (
                "SELECT id, conversation_id, author_public_key, author_display_name, author_avatar_color, content, timestamp, signature, edited_at, deleted_at
                 FROM direct_messages
                 WHERE conversation_id = ?1
                 AND (timestamp < ?2 OR (timestamp = ?2 AND id < ?3))
                 ORDER BY timestamp DESC, id DESC
                 LIMIT ?4".to_string(),
                vec![
                    Box::new(conversation_id.to_string()) as Box<dyn rusqlite::types::ToSql>,
                    Box::new(ts.to_string()),
                    Box::new(id.to_string()),
                    Box::new(limit),
                ],
            ),
            _ => (
                "SELECT id, conversation_id, author_public_key, author_display_name, author_avatar_color, content, timestamp, signature, edited_at, deleted_at
                 FROM direct_messages
                 WHERE conversation_id = ?1
                 ORDER BY timestamp DESC, id DESC
                 LIMIT ?2".to_string(),
                vec![
                    Box::new(conversation_id.to_string()) as Box<dyn rusqlite::types::ToSql>,
                    Box::new(limit),
                ],
            ),
        };

        let params_refs: Vec<&dyn rusqlite::types::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            Ok(DirectMessageDto {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                author_public_key: row.get(2)?,
                author_display_name: row.get(3)?,
                author_avatar_color: row.get(4)?,
                content: row.get(5)?,
                timestamp: row.get(6)?,
                signature: row.get(7)?,
                attachments: Vec::new(),
                reactions: std::collections::HashMap::new(),
                seen_by: None,
                edited_at: row.get(8)?,
                deleted_at: row.get(9)?,
                reply_to_id: None,
                delivery_status: Some("sent".into()),
            })
        })?;

        let mut result: Vec<DirectMessageDto> = Vec::new();
        for row in rows {
            result.push(row?);
        }
        result.reverse(); // Return oldest-first
        Ok(result)
    }

    /// Mark a DM conversation as read.
    pub fn mark_dm_read(&self, conversation_id: &str) -> anyhow::Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock: {}", e))?;
        conn.execute(
            "UPDATE dm_conversations SET unread_count = 0 WHERE id = ?1",
            params![conversation_id],
        )?;
        Ok(())
    }
}
