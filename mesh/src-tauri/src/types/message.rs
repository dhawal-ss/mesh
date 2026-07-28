use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ts_rs::TS;

/// Message DTO sent over IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
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
    /// SDK transaction ID used to reconcile a durable local echo with the
    /// eventual server event. This is internal delivery metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub transaction_id: Option<String>,
    /// Renderer request ID retained inside the encrypted event so a lost IPC
    /// response can be retried without publishing a duplicate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub client_request_id: Option<String>,
    /// Delivery status: "sent", "pending", or "failed". None = sent.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"sent\" | \"pending\" | \"failed\" | null")]
    pub delivery_status: Option<String>,
}

/// File attachment metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDto {
    pub file_hash: String,
    pub filename: String,
    #[ts(type = "number")]
    pub size: u64,
    pub chunks: u32,
    #[serde(default)]
    pub source_peer_id: String,
    #[serde(default)]
    #[ts(optional, type = "string | null")]
    pub content_type: Option<String>,
    /// Bounded display metadata for a protected inline preview. Encryption
    /// keys, IVs, and media locations remain Rust-only.
    #[serde(default)]
    #[ts(optional, type = "AttachmentThumbnailDto | null")]
    pub thumbnail: Option<AttachmentThumbnailDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentThumbnailDto {
    pub file_hash: String,
    #[ts(type = "number")]
    pub size: u64,
    pub width: u32,
    pub height: u32,
    pub content_type: String,
}
