use serde::{Deserialize, Serialize};

/// Community DTO sent over IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub member_count: u32,
    pub role: String,
    pub joined_at: Option<String>,
}

/// Channel DTO sent over IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDto {
    pub id: String,
    pub community_id: String,
    pub name: String,
    pub channel_type: String,
    pub unread_count: u32,
}
