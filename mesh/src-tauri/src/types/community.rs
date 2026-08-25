use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Community DTO sent over IPC.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommunityDto {
    pub id: String,
    pub name: String,
    pub description: String,
    /// This community's icon as an MXC URI, or `None` when it has none and the
    /// generated mark stands in. The renderer cannot fetch an MXC URI, so it
    /// resolves this through `matrix_load_profile_avatar` rather than putting it
    /// in an `img` element; `Avatar` does that on its behalf.
    pub avatar_url: Option<String>,
    pub member_count: u32,
    #[ts(type = "\"owner\" | \"admin\" | \"member\"")]
    pub role: String,
    pub joined_at: Option<String>,
}

/// An invitation for this account to join a community (a Matrix Space),
/// projected from the invited-rooms set. Direct-message invitations are a
/// separate surface (`DmRequestDto`); this type never carries them.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommunityInviteDto {
    pub room_id: String,
    pub name: String,
    pub inviter_user_id: String,
    pub inviter_display_name: String,
    pub inviter_avatar_color: String,
    /// False when the space is not end-to-end encrypted. Mesh requires
    /// encryption before it will join, so the invitation can only be declined.
    pub can_accept: bool,
}

/// Channel DTO sent over IPC.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDto {
    pub id: String,
    pub community_id: String,
    pub name: String,
    /// What this room is for, from the standard `m.room.topic` state event.
    /// Empty when the room has none, matching `CommunityDto::description`, which
    /// surfaces the same Matrix field for a space.
    pub topic: String,
    #[ts(type = "\"text\" | \"voice\"")]
    pub channel_type: String,
    pub unread_count: u32,
    /// Whether this account is a member of the room, as opposed to a room it is
    /// allowed to join and has not.
    ///
    /// A community's rooms are created so that any member of the community may
    /// join them, but nothing joins an existing member to a room created after
    /// they arrived. Those rooms used to be dropped from this listing and
    /// reported as unopenable, which described a permission problem that did not
    /// exist. They are listed here instead, and `false` is the whole reason a
    /// caller must offer to join rather than open: no timeline, no unread count,
    /// and no read receipt is available for a room this account is not in.
    ///
    /// A room this account joined and later left reads the same as one it was
    /// never in, and that is deliberate. Both are rooms the community still
    /// lists and still admits this account to, so both can be rejoined on the
    /// same terms; before this they were both reported as rooms Mesh could not
    /// open. Somebody who does not want to see one again hides the row, which is
    /// local and does not need a membership to express.
    pub joined: bool,
}
