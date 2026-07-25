use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Community DTO sent over IPC.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommunityDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub member_count: u32,
    #[ts(type = "\"owner\" | \"admin\" | \"member\"")]
    pub role: String,
    pub joined_at: Option<String>,
}

/// Channel DTO sent over IPC.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDto {
    pub id: String,
    pub community_id: String,
    pub name: String,
    #[ts(type = "\"text\" | \"voice\"")]
    pub channel_type: String,
    pub unread_count: u32,
}
