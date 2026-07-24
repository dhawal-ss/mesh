use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Message DTO sent over IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub id: String,
    pub channel_id: String,
    pub author_public_key: String,
    pub author_display_name: String,
    pub author_avatar_color: String,
    pub content: String,
    pub attachments: Vec<AttachmentDto>,
    pub reactions: HashMap<String, Vec<String>>,
    pub timestamp: String,
    pub signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_id: Option<String>,
    /// Delivery status: "sent", "pending", or "failed". None = sent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_status: Option<String>,
}

/// File attachment metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDto {
    pub file_hash: String,
    pub filename: String,
    pub size: u64,
    pub chunks: u32,
    #[serde(default)]
    pub source_peer_id: String,
    /// Matrix encrypted-file metadata. Kept opaque at the product boundary so
    /// the SDK remains the authority for key, IV, and ciphertext validation.
    #[serde(default)]
    pub media_source: Option<serde_json::Value>,
    #[serde(default)]
    pub content_type: Option<String>,
}
