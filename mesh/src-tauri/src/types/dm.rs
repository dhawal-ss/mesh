use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::message::AttachmentDto;

/// One counterparty in a direct conversation.
///
/// A one-to-one DM has exactly one peer; a group DM has several. Modeled
/// per-member like `ReadReceiptDto` so the shape is identical whether there is
/// one peer or many, and a 1:1 is simply the `peers.len() == 1` case rather
/// than a separate type.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DmPeerDto {
    pub user_id: String,
    pub display_name: String,
    pub avatar_color: String,
    /// The peer's profile picture as an `mxc://` URI, when they have one, read
    /// from the direct room's member state beside their display name.
    /// `avatar_color` stays the fallback and is always present. The renderer
    /// resolves this through `matrix_load_profile_avatar`; see `MessageDto`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub avatar_url: Option<String>,
}

/// A DM conversation summary.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DmConversationDto {
    pub id: String,
    /// The other participants, never empty. Exactly one for a one-to-one DM.
    pub peers: Vec<DmPeerDto>,
    pub last_message_at: Option<String>,
    #[ts(type = "number")]
    pub unread_count: i64,
    pub created_at: String,
}

/// A quarantined incoming direct-message invitation. Message content is
/// deliberately unavailable until the user accepts the protected room.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DmRequestDto {
    pub room_id: String,
    pub inviter_user_id: String,
    pub inviter_display_name: String,
    pub inviter_avatar_color: String,
    pub can_accept: bool,
}

/// An account ignored through Matrix's standard account-wide block list.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlockedAccountDto {
    pub user_id: String,
}

/// A bounded, stable page of accounts from the account-wide block list.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlockedAccountPageDto {
    pub accounts: Vec<BlockedAccountDto>,
    pub next_cursor: Option<String>,
}

/// A person whose public Matrix read receipt covers a direct message.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReadReceiptDto {
    pub user_id: String,
    pub display_name: String,
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
    /// The author's profile picture, on the same terms as `MessageDto`: read
    /// from member state when the message is projected, never stored with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub author_avatar_url: Option<String>,
    pub content: String,
    pub timestamp: String,
    pub signature: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentDto>,
    #[serde(default)]
    #[ts(type = "Record<string, string[]>")]
    pub reactions: HashMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen_by: Option<Vec<ReadReceiptDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub edited_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub deleted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub reply_to_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub thread_root_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"sent\" | \"pending\" | \"failed\" | null")]
    pub delivery_status: Option<String>,
}
