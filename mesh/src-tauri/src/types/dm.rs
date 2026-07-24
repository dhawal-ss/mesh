use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::message::AttachmentDto;

/// A DM conversation summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmConversationDto {
    pub id: String,
    pub peer_public_key: String,
    pub peer_display_name: String,
    pub peer_avatar_color: String,
    pub last_message_at: Option<String>,
    pub unread_count: i64,
    pub created_at: String,
}

/// A direct message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectMessageDto {
    pub id: String,
    pub conversation_id: String,
    pub author_public_key: String,
    pub author_display_name: String,
    pub author_avatar_color: String,
    pub content: String,
    pub timestamp: String,
    pub signature: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentDto>,
    #[serde(default)]
    pub reactions: HashMap<String, Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_status: Option<String>,
}
