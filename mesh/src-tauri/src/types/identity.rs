use serde::{Deserialize, Serialize};

/// The wire-format identity DTO sent across the IPC boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityDto {
    pub public_key: String,
    pub display_name: String,
    pub avatar_color: String,
}

/// Local profile row stored in SQLite.
#[derive(Debug, Clone)]
pub struct LocalProfile {
    pub public_key: String,
    pub display_name: String,
    pub avatar_color: String,
}
