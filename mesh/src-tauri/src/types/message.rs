use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ts_rs::TS;

/// Message DTO sent over IPC.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub id: String,
    pub channel_id: String,
    pub author_public_key: String,
    pub author_display_name: String,
    pub author_avatar_color: String,
    pub content: String,
    pub attachments: Vec<AttachmentDto>,
    #[ts(type = "Record<string, string[]>")]
    pub reactions: HashMap<String, Vec<String>>,
    pub timestamp: String,
    pub signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub edited_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub deleted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub reply_to_id: Option<String>,
    /// Delivery status: "sent", "pending", or "failed". None = sent.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"sent\" | \"pending\" | \"failed\" | null")]
    pub delivery_status: Option<String>,
}

/// File attachment metadata.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDto {
    pub file_hash: String,
    pub filename: String,
    #[ts(type = "number")]
    pub size: u64,
    pub chunks: u32,
    #[serde(default)]
    pub source_peer_id: String,
    /// Matrix encrypted-file metadata. Kept opaque at the product boundary so
    /// the SDK remains the authority for key, IV, and ciphertext validation.
    #[serde(default)]
    #[ts(optional, type = "Record<string, unknown> | null")]
    pub media_source: Option<serde_json::Value>,
    #[serde(default)]
    #[ts(optional, type = "string | null")]
    pub content_type: Option<String>,
    /// Encrypted Matrix thumbnail metadata. Mesh does not decrypt this across
    /// renderer IPC until the sandboxed preview boundary is implemented.
    #[serde(default)]
    #[ts(optional, type = "AttachmentThumbnailDto | null")]
    pub thumbnail: Option<AttachmentThumbnailDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentThumbnailDto {
    pub file_hash: String,
    #[ts(type = "number")]
    pub size: u64,
    pub width: u32,
    pub height: u32,
    pub content_type: String,
    /// Opaque Matrix encrypted-file metadata used only by the Rust backend.
    #[ts(type = "Record<string, unknown>")]
    pub media_source: serde_json::Value,
}
