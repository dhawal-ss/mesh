use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ts_rs::TS;

/// A Matrix timeline event that was received but could not be decrypted.
///
/// The event identity is kept separately from the display message so the
/// renderer can explain the gap without exposing encrypted payload data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UndecryptableMessageDto {
    pub event_id: String,
    pub sender: String,
    #[ts(type = "number")]
    pub origin_server_ts: u64,
    pub reason: UndecryptableMessageReason,
}

/// Stable, product-facing categories for Matrix decryption failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum UndecryptableMessageReason {
    SentBeforeDevice,
    KeysNotShared,
    WaitingForKeys,
    CouldNotDecrypt,
}

/// A message draft with optional standards-compatible formatted content.
///
/// The renderer uses the formatted content only to recover validated mention
/// anchors. It is never injected into the application DOM.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ComposerDraftDto {
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub formatted_body: Option<String>,
}

/// Message DTO sent over IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub id: String,
    pub channel_id: String,
    pub author_public_key: String,
    pub author_display_name: String,
    pub author_avatar_color: String,
    /// The author's profile picture as an `mxc://` URI, when they have one.
    ///
    /// Read from the room's member state as the message is projected rather
    /// than stored alongside it, exactly like `author_display_name`, so
    /// replacing or clearing a picture takes effect everywhere at once instead
    /// of leaving the old address on old messages. `author_avatar_color` stays
    /// the fallback and is always present.
    ///
    /// The renderer cannot put this in an `img` element: the content security
    /// policy allows no `mxc://` and the media endpoint needs the access token.
    /// `Avatar` resolves it through `matrix_load_profile_avatar`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub author_avatar_url: Option<String>,
    pub content: String,
    /// Explicit notification recipients carried by the standard m.mentions field.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<String>,
    /// Whether this message notified the whole room, from the standard
    /// `m.mentions.room` flag.
    ///
    /// This is per-message and not a room capability, which is the whole point:
    /// only the sender's power level at the time of sending decides whether a
    /// room-wide mention took effect, so a member who lacks it and writes
    /// `@room` anyway produces a message where this is `false`. The renderer
    /// highlights the token only when this is set, so what a reader sees agrees
    /// with who was actually notified rather than with what was typed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mentions_room: bool,
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
    /// Matrix thread root event for replies sent with `rel_type: m.thread`.
    /// Ordinary replies leave this empty and continue using `reply_to_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub thread_root_id: Option<String>,
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
    /// Present only when Matrix received an event but the SDK could not
    /// decrypt its message content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "UndecryptableMessageDto | null")]
    pub undecryptable: Option<UndecryptableMessageDto>,
}

/// Structured, optional filters applied to a message search alongside the
/// free-text query. Every active predicate is ANDed with the others and with
/// the text match. Received from the renderer; never sent back to it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MessageSearchFilters {
    /// Author display-name / user-id substring, or the literal `"me"`.
    pub from: Option<String>,
    /// Inclusive lower bound (epoch ms): keep messages with `timestamp >= after_ms`.
    pub after_ms: Option<i64>,
    /// Exclusive upper bound (epoch ms): keep messages with `timestamp < before_ms`.
    pub before_ms: Option<i64>,
    /// Content-type requirements, any of `"attachment"`, `"image"`, `"link"`.
    pub has: Vec<String>,
    /// Mention user-id substring, or the literal `"me"`.
    pub mentions: Option<String>,
}

/// A bounded, server-backed view of one standard Matrix thread.
///
/// `unread_state_available` is false when the user's receipt privacy mode is
/// off. In that mode Mesh must not invent cross-device unread state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixThreadContextDto {
    pub root: MessageDto,
    pub replies: Vec<MessageDto>,
    pub unread_count: u32,
    pub unread_mentions: u32,
    pub unread_state_available: bool,
    pub has_more: bool,
}

/// One row in a room's "My threads" list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListItemDto {
    pub root: MessageDto,
    pub reply_count: u32,
    pub participant_count: u32,
    pub last_activity: String,
    pub unread_count: u32,
    pub unread_mentions: u32,
}

/// A bounded, server-backed "My threads" list for one room: threads this
/// account authored or replied to, per the standard Matrix `Participated`
/// thread filter. `has_more` reflects the server's own thread-list
/// pagination, not per-thread reply truncation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixThreadListDto {
    pub items: Vec<ThreadListItemDto>,
    pub has_more: bool,
}

/// What a cross-community message search actually covered, so the UI can
/// state it truthfully instead of inferring it. A single deadline and result
/// budget are shared across every community in the walk, so a large account
/// can have some communities fully scanned and others not reached at all;
/// `truncated` says so when that happens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixSearchScopeDto {
    pub communities_searched: u32,
    pub communities_total: u32,
    pub rooms_searched: u32,
    pub rooms_total: u32,
    pub truncated: bool,
}

/// Result of a message search that walks every community the account has
/// joined, rather than one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCrossCommunitySearchResultDto {
    pub results: Vec<MessageDto>,
    pub scope: MatrixSearchScopeDto,
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
