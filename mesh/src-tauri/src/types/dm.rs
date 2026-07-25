use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::message::AttachmentDto;

/// A DM conversation summary.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DmConversationDto {
    pub id: String,
    pub peer_public_key: String,
    pub peer_display_name: String,
    pub peer_avatar_color: String,
    pub last_message_at: Option<String>,
    #[ts(type = "number")]
    pub unread_count: i64,
    pub created_at: String,
}

/// A direct message.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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
    #[ts(type = "Record<string, string[]>")]
    pub reactions: HashMap<String, Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub edited_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub deleted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub reply_to_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"sent\" | \"pending\" | \"failed\" | null")]
    pub delivery_status: Option<String>,
}
