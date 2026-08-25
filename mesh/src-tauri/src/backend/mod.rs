//! Durable communication backend boundary.
//!
//! The React application continues to use typed Tauri IPC while the Rust
//! backend can select Matrix (the production default) or the legacy libp2p
//! engine. Product code should depend on [`MeshBackend`], not on a transport.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::types::{
    community::{ChannelDto, CommunityDto, CommunityInviteDto},
    dm::{
        BlockedAccountDto, BlockedAccountPageDto, DirectMessageDto, DmConversationDto, DmRequestDto,
    },
    message::{
        ComposerDraftDto, MatrixCrossCommunitySearchResultDto, MatrixThreadContextDto,
        MatrixThreadListDto, MessageDto, MessageSearchFilters,
    },
};

pub const LEGACY_MATRIX_EVENT_TYPE: &str = "org.mesh.legacy_archive.v1";
pub const MATRIX_TRANSFER_PROGRESS_EVENT: &str = "matrix:transfer-progress";
pub const MATRIX_NOTIFICATION_EVENT: &str = "matrix:notification";
pub const MATRIX_UNREAD_UPDATE_EVENT: &str = "matrix:unread-update";
pub const MATRIX_TYPING_CHANGED_EVENT: &str = "matrix:typing-changed";
pub const MATRIX_IGNORED_USERS_CHANGED_EVENT: &str = "matrix:ignored-users-changed";
pub const MATRIX_QUEUED_MESSAGE_EVENT: &str = "matrix:queued-message";
pub const MATRIX_ROOM_PINS_EVENT: &str = "matrix:room-pins";
pub const MATRIX_RTC_MEMBERSHIP_EVENT: &str = "matrix:rtc-membership";
pub const MATRIX_RTC_MEDIA_KEY_EVENT: &str = "matrix:rtc-media-key";
pub const MATRIX_RTC_MEDIA_KEY_FAILURE_EVENT: &str = "matrix:rtc-media-key-failure";
pub const MATRIX_RTC_MEDIA_KEY_PAUSE_EVENT: &str = "matrix:rtc-media-key-pause";
pub const MATRIX_PERMISSION_STATE_CHANGED_EVENT: &str = "matrix:permission-state-changed";
/// Somebody clicked a Mesh notification. Carries the room the notification was
/// about, so the renderer can open it rather than only raising the window.
pub const MATRIX_NOTIFICATION_ACTIVATED_EVENT: &str = "matrix:notification-activated";
/// The set of communities this account belongs to changed: a space was joined,
/// left, or offered as an invitation, possibly from another device.
pub const MATRIX_COMMUNITIES_CHANGED_EVENT: &str = "matrix:communities-changed";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRtcMember {
    pub room_id: String,
    pub user_id: String,
    pub device_id: String,
    pub session_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    /// What this member is called inside the call itself.
    ///
    /// The SFU never learns a Matrix user ID: a participant is identified by a
    /// digest of user, device and membership, so nothing in the renderer can
    /// tell which LiveKit participant is which person from the participant list
    /// alone. Sending the same digest with the membership is what lets a call
    /// tile show a name and a picture. Derived exactly as
    /// `MatrixRtcMediaKey::participant_identity` is, which is the derivation
    /// end-to-end encrypted media already depends on matching.
    pub participant_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRtcMembershipUpdate {
    pub room_id: String,
    pub members: Vec<MatrixRtcMember>,
}

/// Ephemeral MatrixRTC publisher key delivered only after an Olm-authenticated
/// to-device event has been bound to a current room membership.
///
/// This DTO must never be persisted or logged. The renderer uses it to update
/// the in-memory LiveKit media encryption keyring for one publisher.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRtcMediaKey {
    pub room_id: String,
    pub user_id: String,
    pub device_id: String,
    pub member_id: String,
    pub session_id: Option<String>,
    pub activation_id: Option<String>,
    pub participant_identity: String,
    pub key_index: u8,
    pub key: String,
    #[ts(type = "number")]
    pub sent_ts: u64,
}

impl std::fmt::Debug for MatrixRtcMediaKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MatrixRtcMediaKey")
            .field("room_id", &self.room_id)
            .field("user_id", &self.user_id)
            .field("device_id", &self.device_id)
            .field("member_id", &self.member_id)
            .field("session_id", &self.session_id)
            .field("activation_id", &self.activation_id)
            .field("participant_identity", &self.participant_identity)
            .field("key_index", &self.key_index)
            .field("key", &"[REDACTED]")
            .field("sent_ts", &self.sent_ts)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRtcMediaKeyPause {
    pub room_id: String,
    pub session_id: String,
    pub member_id: String,
    pub activation_id: String,
    pub key_index: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRtcMediaKeyLease {
    pub room_id: String,
    pub session_id: String,
    pub member_id: String,
    pub key_index: u8,
    #[ts(type = "number")]
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRtcMediaKeyFailure {
    pub room_id: String,
    pub code: String,
}

/// Short-lived authorization material for joining one LiveKit room.
///
/// The JWT is intentionally returned only from the explicit join command. It
/// is never persisted in Matrix state, account data, environment variables, or
/// the SDK store.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRtcJoinResult {
    pub room_id: String,
    pub session_id: String,
    pub member_id: String,
    pub url: String,
    pub token: String,
    pub room_name: String,
    pub participant_identity: String,
    /// The client has the media-encryption worker and key material needed to
    /// attempt a protected call. This is not proof of a successful live call.
    pub media_e2ee_ready: bool,
    pub media_key: MatrixRtcMediaKey,
}

impl std::fmt::Debug for MatrixRtcJoinResult {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MatrixRtcJoinResult")
            .field("room_id", &self.room_id)
            .field("session_id", &self.session_id)
            .field("member_id", &self.member_id)
            .field("url", &self.url)
            .field("token", &"[REDACTED]")
            .field("room_name", &self.room_name)
            .field("participant_identity", &self.participant_identity)
            .field("media_e2ee_ready", &self.media_e2ee_ready)
            .field("media_key", &self.media_key)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixNotification {
    pub room_id: String,
    pub event_id: String,
    pub sender: String,
    pub display_name: String,
    pub preview: String,
    pub is_mention: bool,
    pub is_dm: bool,
    /// The sender's picture, as the backend read it, and always absent by the
    /// time anything outside the backend sees this.
    ///
    /// `presentation_notification` clears it before both the renderer event and
    /// the native notification, whatever the content policy says, because
    /// nothing presents it: the renderer only plays a sound for a notification,
    /// and a native notification image is a per-platform capability rather than
    /// something Mesh can show the same way on Windows, macOS and Linux. The
    /// field stays because that clearing is a privacy guarantee worth pinning a
    /// test to, and the tests need something to assert about.
    pub avatar_url: Option<String>,
}

/// The room a notification was about, so a click on it can open that room
/// rather than only raising the window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixNotificationActivation {
    pub room_id: String,
    pub event_id: String,
    pub is_dm: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixUnreadUpdate {
    pub room_id: String,
    #[ts(type = "number")]
    pub unread_messages: i64,
    #[ts(type = "number")]
    pub unread_mentions: i64,
    /// Whether this room carries the person's own explicit "mark as unread"
    /// marker (`m.marked_unread` room account data), independent of whether
    /// any message or mention is actually unread.
    pub unread_marked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixTypingChanged {
    pub room_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MatrixPermissionRoomStatus {
    Loaded,
    MatrixDefault,
    Inaccessible,
    Unsupported,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum CommunityPermissionAggregateStatus {
    GrantedEverywhere,
    GrantedSomeRooms,
    NotGranted,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CommunityPermissionId {
    Participate,
    Invite,
    Redact,
    Remove,
    Ban,
    RoomState,
    Roles,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRoomPowerLevelProjection {
    #[ts(type = "{ [key in string]?: number }")]
    pub users: std::collections::BTreeMap<String, i64>,
    #[ts(type = "number")]
    pub users_default: i64,
    #[ts(type = "{ [key in string]?: number }")]
    pub events: std::collections::BTreeMap<String, i64>,
    #[ts(type = "number")]
    pub events_default: i64,
    #[ts(type = "number")]
    pub state_default: i64,
    #[ts(type = "number")]
    pub ban: i64,
    #[ts(type = "number")]
    pub kick: i64,
    #[ts(type = "number")]
    pub invite: i64,
    #[ts(type = "number")]
    pub redact: i64,
    #[ts(type = "{ [key in string]?: number }")]
    pub notifications: std::collections::BTreeMap<String, i64>,
    pub creator_user_ids: Vec<String>,
    pub privileged_creator_user_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRoomPermissionProjection {
    pub room_id: String,
    pub room_name: String,
    #[ts(type = "\"space\" | \"room\"")]
    pub room_kind: String,
    pub status: MatrixPermissionRoomStatus,
    pub policy: Option<MatrixRoomPowerLevelProjection>,
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommunityPermissionAggregate {
    pub permission_id: CommunityPermissionId,
    pub status: CommunityPermissionAggregateStatus,
    pub granted_room_count: usize,
    pub verified_room_count: usize,
    pub total_room_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommunityPermissionProjection {
    pub community_id: String,
    pub subject_user_id: String,
    pub discovery_complete: bool,
    pub discovery_failure_reason: Option<String>,
    pub rooms: Vec<MatrixRoomPermissionProjection>,
    pub aggregate: Vec<CommunityPermissionAggregate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixPermissionStateChanged {
    pub room_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRoomUpgrade {
    pub room_id: String,
    pub replacement_room_id: Option<String>,
    pub predecessor_room_id: Option<String>,
    pub reason: Option<String>,
}

/// What actually changed in a room while the renderer was waiting.
///
/// The renderer used to be told only that *something* happened, so a read
/// receipt or a typing notification cost a full timeline refetch across the IPC
/// boundary, on both sides. Naming the change lets each caller refetch only
/// what it actually cares about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MatrixRoomUpdateKind {
    /// Nothing arrived before the wait timed out. Wait again.
    Idle,
    /// Timeline events arrived or changed. Messages need refetching.
    Timeline,
    /// Room state moved without the timeline: membership, name, topic, power
    /// levels, or the room being left, invited, or knocked on.
    State,
    /// Ephemeral or account data only: read receipts, typing, tags. Refetching
    /// the timeline for one of these is pure waste, which is the whole reason
    /// this type exists.
    Ephemeral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MatrixQueuedMessageState {
    Pending,
    Failed,
    Sent,
    Cancelled,
}

/// Why a queued message will never send, for the cases where retrying is not
/// the answer. Only carried on `Failed`, which the send queue reaches when the
/// error is unrecoverable, so every variant here means "do not offer a retry".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MatrixQueuedMessageFailure {
    /// The account may not post here: announcement-only power levels, a mute,
    /// a kick, or a ban.
    NotAllowed,
    /// The room no longer accepts events, typically because it was replaced by
    /// an upgrade.
    RoomUnavailable,
    /// Unrecoverable, but not for a reason Mesh can name honestly.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixQueuedMessageUpdate {
    pub room_id: String,
    pub transaction_id: String,
    pub state: MatrixQueuedMessageState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | null")]
    pub event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "MessageDto | null")]
    pub message: Option<MessageDto>,
    /// Set only when `state` is `Failed`. A failure the renderer can explain is
    /// the difference between "your connection dropped, try again" and "you are
    /// not allowed to post here", which no amount of retrying will change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "MatrixQueuedMessageFailure | null")]
    pub failure: Option<MatrixQueuedMessageFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixIgnoredUsersChanged {
    /// Newly ignored accounts that can be removed from bounded renderer caches
    /// without discarding unrelated conversations.
    pub blocked_user_ids: Vec<String>,
    /// The change was too large or the previous account state was unknown, so
    /// renderer message projections must be cleared and loaded again.
    pub reset_all: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatrixBackendEvent {
    Notification(MatrixNotification),
    UnreadUpdate(MatrixUnreadUpdate),
    TypingChanged(MatrixTypingChanged),
    IgnoredUsersChanged(MatrixIgnoredUsersChanged),
    QueuedMessage(Box<MatrixQueuedMessageUpdate>),
    RoomPins(MatrixRoomPinsUpdate),
    RtcMembership(MatrixRtcMembershipUpdate),
    RtcMediaKey(MatrixRtcMediaKey),
    RtcMediaKeyFailure(MatrixRtcMediaKeyFailure),
    RtcMediaKeyPause(MatrixRtcMediaKeyPause),
    PermissionStateChanged(MatrixPermissionStateChanged),
    /// Carries no payload: the renderer refetches the listing it already owns.
    CommunitiesChanged,
}

pub type MatrixBackendEventCallback = Arc<dyn Fn(MatrixBackendEvent) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MatrixRoomNotificationMode {
    #[serde(rename = "all")]
    All,
    #[serde(rename = "mentions")]
    Mentions,
    #[serde(rename = "nothing")]
    Nothing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRoomPins {
    pub room_id: String,
    pub event_ids: Vec<String>,
    pub messages: Vec<MessageDto>,
    pub unavailable_event_ids: Vec<String>,
    pub can_manage: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRoomPinsUpdate {
    pub room_id: String,
    pub event_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPresentationContext {
    pub active_room_id: Option<String>,
    pub notifications_enabled: bool,
    pub do_not_disturb: bool,
    pub quiet_hours_active: bool,
    /// Explicit account-scoped opt-in for showing bounded message text in
    /// native notifications. Missing values fail closed for older clients.
    #[serde(default)]
    pub show_message_content: bool,
    #[serde(default)]
    pub muted_room_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MatrixTransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MatrixTransferState {
    Queued,
    Encrypting,
    Uploading,
    Publishing,
    Downloading,
    Validating,
    Writing,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MatrixTransferRetryMode {
    RestartFromZero,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixTransferResult {
    pub event_id: Option<String>,
    pub local_path: Option<String>,
}

/// Progress for one attachment upload or download, emitted repeatedly over the
/// life of a transfer.
///
/// Every optional field is present on the wire as `null` rather than omitted,
/// so the renderer never has to distinguish "no retry mode" from "field
/// missing".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixTransferProgress {
    pub transfer_id: String,
    pub direction: MatrixTransferDirection,
    #[ts(type = "number")]
    pub transferred_bytes: u64,
    #[ts(type = "number | null")]
    pub total_bytes: Option<u64>,
    pub state: MatrixTransferState,
    pub retryable: bool,
    pub retry_mode: Option<MatrixTransferRetryMode>,
    pub result: Option<MatrixTransferResult>,
    pub error: Option<String>,
}

pub type MatrixTransferProgressCallback = Arc<dyn Fn(MatrixTransferProgress) + Send + Sync>;

#[derive(Clone)]
pub struct MatrixTransferObserver {
    pub transfer_id: String,
    pub progress: MatrixTransferProgressCallback,
}

pub struct MatrixAttachmentSendRequest {
    pub transaction_id: String,
    pub file_path: String,
    pub filename: String,
    pub content_type: Option<String>,
    pub body: String,
    pub mentions: Vec<String>,
    pub reply_to_id: Option<String>,
    pub thread_root_id: Option<String>,
}

#[cfg(feature = "legacy-p2p")]
mod legacy;
#[cfg(feature = "matrix-backend")]
mod matrix;

#[cfg(feature = "legacy-p2p")]
pub use legacy::LegacyP2pBackend;
#[cfg(feature = "matrix-backend")]
pub use matrix::MatrixBackend;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum BackendKind {
    Matrix,
    LegacyP2p,
}

impl BackendKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Matrix => "matrix",
            Self::LegacyP2p => "legacy-p2p",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub kind: BackendKind,
    pub capabilities: BackendCapabilities,
    pub voice_service: VoiceServiceStatus,
    pub authenticated: bool,
    pub user_id: Option<String>,
    pub device_id: Option<String>,
    pub homeserver: Option<String>,
    /// True only when the sync worker is alive and has received a successful
    /// response within the backend's freshness window.
    pub sync_running: bool,
    pub durable_history: bool,
    /// Backend capability. This does not claim that the current account has a
    /// usable authenticated encryption session.
    pub supports_e2ee: bool,
    /// Health of the current account/device encryption session.
    pub session_e2ee_ready: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum BackendStartupPhase {
    Pending,
    Starting,
    Ready,
    RecoverableFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum BackendStartupIssue {
    SignInRequired,
    ConnectionUnavailable,
    ServiceUnavailable,
    RuntimeUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BackendStartupStatus {
    pub phase: BackendStartupPhase,
    pub issue: Option<BackendStartupIssue>,
}

impl BackendStartupStatus {
    pub const fn pending() -> Self {
        Self {
            phase: BackendStartupPhase::Pending,
            issue: None,
        }
    }

    pub const fn starting() -> Self {
        Self {
            phase: BackendStartupPhase::Starting,
            issue: None,
        }
    }

    pub const fn ready() -> Self {
        Self {
            phase: BackendStartupPhase::Ready,
            issue: None,
        }
    }

    pub const fn recoverable(issue: BackendStartupIssue) -> Self {
        Self {
            phase: BackendStartupPhase::RecoverableFailure,
            issue: Some(issue),
        }
    }
}

impl Default for BackendStartupStatus {
    fn default() -> Self {
        Self::pending()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceProvider {
    MatrixRtc,
    LegacySimplePeer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceServiceAvailability {
    Ready,
    NotConfigured,
    InvalidConfiguration,
    ClientUnavailable,
}

/// Honest calling readiness for the selected backend.
///
/// MatrixRTC endpoints are public service locations, not credentials. They are
/// reported for operator diagnostics, but are never treated as proof that
/// MatrixRTC authorization, LiveKit connectivity, or media E2EE works.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VoiceServiceStatus {
    pub provider: VoiceProvider,
    pub availability: VoiceServiceAvailability,
    pub discovery_key: Option<String>,
    pub livekit_service_url: Option<String>,
    pub token_endpoint: Option<String>,
    pub livekit_sfu_url: Option<String>,
    pub csp_ready: bool,
    /// The selected build contains the media-encryption client and its
    /// required network policy. Live media verification is a release gate.
    pub media_e2ee_ready: bool,
    pub reason: Option<String>,
}

impl VoiceServiceStatus {
    const MATRIXRTC_DISCOVERY_KEY: &'static str = "org.matrix.msc4143.rtc_foci";
    const MATRIXRTC_SERVICE_ENV: &'static str = "MESH_MATRIXRTC_LIVEKIT_SERVICE_URL";
    const MATRIXRTC_SFU_ENV: &'static str = "MESH_MATRIXRTC_LIVEKIT_SFU_URL";
    #[cfg(not(feature = "matrix-voice"))]
    const TAURI_CSP: &'static str = include_str!("../../tauri.conf.json");
    #[cfg(feature = "matrix-voice")]
    const TAURI_CSP: &'static str = include_str!("../../tauri.matrix-voice.conf.json");

    fn matrix_rtc_client_included() -> bool {
        cfg!(feature = "matrix-voice")
            && option_env!("MESH_MATRIX_VOICE_FRONTEND") == Some("matrix-voice")
    }

    pub fn for_kind(kind: BackendKind) -> Self {
        match kind {
            BackendKind::Matrix => Self::matrix_rtc(
                std::env::var(Self::MATRIXRTC_SERVICE_ENV).ok(),
                std::env::var(Self::MATRIXRTC_SFU_ENV).ok(),
                Self::TAURI_CSP,
            ),
            BackendKind::LegacyP2p => Self {
                provider: VoiceProvider::LegacySimplePeer,
                availability: VoiceServiceAvailability::Ready,
                discovery_key: None,
                livekit_service_url: None,
                token_endpoint: None,
                livekit_sfu_url: None,
                csp_ready: true,
                media_e2ee_ready: false,
                reason: Some(
                    "Experimental peer-to-peer WebRTC transport; not used by Matrix production"
                        .into(),
                ),
            },
        }
    }

    fn matrix_rtc(
        livekit_service_url: Option<String>,
        livekit_sfu_url: Option<String>,
        tauri_config: &str,
    ) -> Self {
        Self::matrix_rtc_with_client(
            livekit_service_url,
            livekit_sfu_url,
            tauri_config,
            Self::matrix_rtc_client_included(),
        )
    }

    fn matrix_rtc_with_client(
        livekit_service_url: Option<String>,
        livekit_sfu_url: Option<String>,
        tauri_config: &str,
        client_included: bool,
    ) -> Self {
        let livekit_service_url = livekit_service_url.and_then(Self::non_empty);
        let livekit_sfu_url = livekit_sfu_url.and_then(Self::non_empty);
        let base = Self {
            provider: VoiceProvider::MatrixRtc,
            availability: VoiceServiceAvailability::NotConfigured,
            discovery_key: Some(Self::MATRIXRTC_DISCOVERY_KEY.into()),
            livekit_service_url: livekit_service_url.clone(),
            token_endpoint: None,
            livekit_sfu_url: livekit_sfu_url.clone(),
            csp_ready: false,
            media_e2ee_ready: false,
            reason: None,
        };

        let Some(livekit_service_url) = livekit_service_url.as_deref() else {
            return Self {
                reason: Some(format!(
                    "Discover {}.livekit_service_url or set {}",
                    Self::MATRIXRTC_DISCOVERY_KEY,
                    Self::MATRIXRTC_SERVICE_ENV
                )),
                ..base
            };
        };

        let service =
            match Self::secure_url(Self::MATRIXRTC_SERVICE_ENV, livekit_service_url, "https") {
                Ok(url) => url,
                Err(reason) => {
                    return Self {
                        availability: VoiceServiceAvailability::InvalidConfiguration,
                        reason: Some(reason),
                        ..base
                    };
                }
            };
        let sfu = match livekit_sfu_url.as_deref() {
            Some(url) => match Self::secure_url(Self::MATRIXRTC_SFU_ENV, url, "wss") {
                Ok(url) => Some(url),
                Err(reason) => {
                    return Self {
                        availability: VoiceServiceAvailability::InvalidConfiguration,
                        reason: Some(reason),
                        ..base
                    };
                }
            },
            None => None,
        };
        let token_endpoint = format!("{}/get_token", service.as_str().trim_end_matches('/'));
        let service_origin = service.origin().ascii_serialization();
        let sfu_origin = sfu.as_ref().map(|sfu| sfu.origin().ascii_serialization());
        let mut required_origins = vec![service_origin.as_str()];
        if let Some(sfu_origin) = sfu_origin.as_deref() {
            required_origins.push(sfu_origin);
        }
        let csp_ready = Self::connect_src_allows(tauri_config, &required_origins);
        let base = Self {
            token_endpoint: Some(token_endpoint),
            csp_ready,
            ..base
        };

        if !csp_ready {
            let required = sfu_origin.as_deref().map_or_else(
                || service_origin.clone(),
                |sfu| format!("{service_origin} and {sfu}"),
            );
            return Self {
                availability: VoiceServiceAvailability::InvalidConfiguration,
                reason: Some(format!(
                    "Tauri connect-src must explicitly allow {required} before MatrixRTC network access"
                )),
                ..base
            };
        }

        if !client_included {
            return Self {
                availability: VoiceServiceAvailability::ClientUnavailable,
                reason: Some(
                    "Calling is not included in this Mesh build. Use the separately identified Matrix voice acceptance build."
                        .into(),
                ),
                ..base
            };
        }

        Self {
            availability: VoiceServiceAvailability::Ready,
            media_e2ee_ready: true,
            reason: None,
            ..base
        }
    }

    #[cfg(feature = "matrix-backend")]
    fn matrix_rtc_for_discovered_service(discovered_service_url: String) -> Self {
        Self::matrix_rtc(
            Some(discovered_service_url),
            std::env::var(Self::MATRIXRTC_SFU_ENV).ok(),
            Self::TAURI_CSP,
        )
    }

    #[cfg(feature = "matrix-backend")]
    fn matrix_rtc_discovery_unavailable() -> Self {
        let mut status = Self::matrix_rtc(
            std::env::var(Self::MATRIXRTC_SERVICE_ENV).ok(),
            std::env::var(Self::MATRIXRTC_SFU_ENV).ok(),
            Self::TAURI_CSP,
        );
        status.availability = VoiceServiceAvailability::ClientUnavailable;
        status.media_e2ee_ready = false;
        status.reason = Some(
            "Calling service discovery is temporarily unavailable. Try again after Mesh reconnects."
                .into(),
        );
        status
    }

    fn secure_url(name: &str, value: &str, required_scheme: &str) -> Result<url::Url, String> {
        let url = url::Url::parse(value)
            .map_err(|_| format!("{name} must be an absolute {required_scheme} URL"))?;
        if url.scheme() != required_scheme || url.host_str().is_none() {
            return Err(format!("{name} must be an absolute {required_scheme} URL"));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(format!("{name} must not contain credentials"));
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(format!("{name} must not contain a query or fragment"));
        }
        Ok(url)
    }

    fn connect_src_allows(tauri_config: &str, required_origins: &[&str]) -> bool {
        let parsed = serde_json::from_str::<serde_json::Value>(tauri_config).ok();
        let csp = parsed
            .as_ref()
            .and_then(|config| config.pointer("/app/security/csp"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or(tauri_config);
        let Some(connect_src) = csp.split(';').map(str::trim).find(|directive| {
            directive
                .split_whitespace()
                .next()
                .is_some_and(|name| name == "connect-src")
        }) else {
            return false;
        };
        let allowed = connect_src.split_whitespace().skip(1);
        required_origins.iter().all(|required| {
            allowed
                .clone()
                .any(|candidate| Self::connect_src_candidate_allows(candidate, required))
        })
    }

    fn connect_src_candidate_allows(candidate: &str, required_origin: &str) -> bool {
        if candidate == required_origin {
            return true;
        }
        let Some((scheme, host_suffix)) = candidate.split_once("://*.") else {
            return false;
        };
        let Ok(required) = url::Url::parse(required_origin) else {
            return false;
        };
        let Some(required_host) = required.host_str() else {
            return false;
        };
        required.scheme() == scheme
            && required.port().is_none()
            && required_host != host_suffix
            && required_host.ends_with(&format!(".{host_suffix}"))
    }

    fn non_empty(value: String) -> Option<String> {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_owned())
    }
}

/// Authoritative product capabilities for the selected backend. The frontend
/// renders unavailable features from this contract instead of probing legacy
/// commands or duplicating backend-mode conditionals.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BackendCapabilities {
    pub encrypted_text: bool,
    pub encrypted_attachments: bool,
    pub direct_messages: bool,
    pub voice: bool,
    pub durable_timeouts: bool,
    pub device_management: bool,
    pub recovery: bool,
    pub legacy_migration: bool,
}

impl BackendCapabilities {
    pub fn for_kind(kind: BackendKind) -> Self {
        match kind {
            BackendKind::Matrix => Self {
                encrypted_text: true,
                encrypted_attachments: true,
                direct_messages: true,
                voice: false,
                durable_timeouts: false,
                device_management: true,
                recovery: true,
                legacy_migration: cfg!(feature = "legacy-p2p"),
            },
            BackendKind::LegacyP2p => Self {
                encrypted_text: true,
                encrypted_attachments: true,
                direct_messages: true,
                voice: true,
                durable_timeouts: true,
                device_management: false,
                recovery: false,
                legacy_migration: true,
            },
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixLogin {
    pub homeserver: String,
    pub username: String,
    pub password: String,
    pub device_name: Option<String>,
}

impl std::fmt::Debug for MatrixLogin {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MatrixLogin")
            .field("homeserver", &self.homeserver)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .field("device_name", &self.device_name)
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRegistration {
    pub homeserver: String,
    pub username: String,
    pub password: String,
    /// Opaque native invitation handle. Registration admission remains in the
    /// encrypted native store and never crosses renderer IPC.
    pub pending_invitation_handle: Option<String>,
    pub device_name: Option<String>,
}

impl std::fmt::Debug for MatrixRegistration {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MatrixRegistration")
            .field("homeserver", &self.homeserver)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .field(
                "pending_invitation_handle_present",
                &self.pending_invitation_handle.is_some(),
            )
            .field("device_name", &self.device_name)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MatrixRegistrationAvailability {
    Open,
    Closed,
    InvitationOnly,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixServiceCapabilities {
    pub homeserver: String,
    pub server_versions: Vec<String>,
    pub password_login: bool,
    pub browser_login: bool,
    pub registration: MatrixRegistrationAvailability,
    pub max_upload_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MatrixOidcAvailability {
    Supported,
    NotSupported,
    InvalidConfiguration,
}

/// Authoritative MAS/OIDC readiness for a homeserver.
///
/// `supported` means matrix-rust-sdk successfully discovered and validated an
/// authorization-code server with refresh tokens and S256 PKCE. It does not
/// mean the desktop callback or session handoff is ready.
///
/// There is no registration-mode field. Mesh resolves clients only from its
/// embedded build configuration, so the mode is always static and
/// `client_id_configured` already says whether that resolution succeeded. A
/// field carrying one constant string invites a renderer to branch on a value
/// this backend cannot produce, which is how dead code starts looking
/// deliberate. Add it back as an enum if dynamic registration ever ships.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixOidcStatus {
    pub homeserver: String,
    pub availability: MatrixOidcAvailability,
    pub issuer: Option<String>,
    pub authorization_endpoint: Option<String>,
    pub client_id_configured: bool,
    pub redirect_uri: String,
    pub authorization_code_pkce: bool,
    pub native_callback_ready: bool,
    pub ready: bool,
    pub reason: String,
}

/// A server-registered Matrix device enriched with local cryptographic trust
/// state from matrix-rust-sdk's encrypted store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixDevice {
    pub device_id: String,
    pub display_name: Option<String>,
    pub last_seen_ip: Option<String>,
    pub last_seen_at: Option<String>,
    pub current: bool,
    pub verified: bool,
    pub cross_signed: bool,
    pub first_seen_at: Option<String>,
    pub new_device: bool,
    pub identity_changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixAccount {
    pub profile_id: String,
    pub user_id: String,
    pub homeserver: String,
    pub device_id: String,
    pub last_used_at: String,
    pub current: bool,
}

/// Summary of a user-initiated personal-data export written to a folder chosen
/// through the trusted native directory picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixPersonalDataExport {
    pub path: String,
    pub exported_at: String,
    pub room_count: u32,
    #[ts(type = "number")]
    pub message_count: u64,
    pub media_file_count: u32,
    pub warnings: Vec<String>,
}

/// Public profile metadata owned by the authenticated Matrix account.
///
/// `avatar_url` is an MXC URI. Matrix profile avatars are not end-to-end
/// encrypted. Mesh both reads and writes it (`set_profile_avatar_image`
/// sanitises and uploads, `clear_profile_avatar_image` removes), and resolves
/// the URI to displayable bytes through `load_profile_avatar_image`, because a
/// renderer under Mesh's content security policy cannot fetch MXC itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixProfile {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MatrixRecoverySecureStorageState {
    Saved,
    Missing,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MatrixRecoveryVerificationState {
    Verified,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRecoveryHealth {
    pub recovery_state: String,
    pub backup_state: String,
    pub backup_exists_on_server: bool,
    pub backup_enabled: bool,
    pub healthy: bool,
    pub checked_at: String,
    pub last_successful_test_at: Option<String>,
    pub secure_storage_state: MatrixRecoverySecureStorageState,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRecoverySetupResult {
    pub recovery_key: String,
    pub secure_storage_state: MatrixRecoverySecureStorageState,
    pub verification_state: MatrixRecoveryVerificationState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationEmoji {
    pub symbol: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixVerificationSession {
    pub verification_id: String,
    pub device_id: String,
    pub phase: String,
    pub method: Option<String>,
    pub emojis: Vec<VerificationEmoji>,
    pub decimals: Option<[u16; 3]>,
    pub qr_svg: Option<String>,
    pub cancellation_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedCommunity {
    pub space_id: String,
    pub channel_id: String,
    pub name: String,
}

/// A bounded, content-free diagnostic for an entity that was deliberately
/// excluded from an enumeration. The renderer may explain that an item is
/// unavailable, but must never use this record to read, preview, search, or
/// open the quarantined room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedEntityDiagnostic {
    pub entity_id: String,
    pub entity_kind: BlockedEntityKind,
    pub reason: BlockedEntityReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlockedEntityKind {
    Community,
    Channel,
    DirectMessage,
    Upgrade,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlockedEntityReason {
    Unencrypted,
    Inaccessible,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityList<T> {
    pub entities: Vec<T>,
    pub blocked_entities: Vec<BlockedEntityDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentMessage {
    pub event_id: String,
    pub room_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypingUser {
    pub user_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityMember {
    pub public_key: String,
    pub display_name: String,
    pub avatar_color: String,
    /// This member's profile picture as an MXC URI, or `None` when they have not
    /// set one. The renderer cannot fetch an MXC URI (see
    /// `load_profile_avatar_image`), so a consumer resolves it to bytes through
    /// `matrix_load_profile_avatar` rather than putting it in an `img` element.
    pub avatar_url: Option<String>,
    pub role: String,
    pub join_status: String,
    pub ban_status: String,
    pub last_seen: Option<String>,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityMemberPage {
    pub members: Vec<CommunityMember>,
    pub next_cursor: Option<String>,
    pub state_complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModerationRoomOutcome {
    pub room_id: String,
    pub room_name: String,
    pub succeeded: bool,
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModerationAuditEntry {
    pub id: String,
    pub actor_user_id: String,
    pub actor_display_name: String,
    pub target_user_id: String,
    pub target_display_name: String,
    pub action: String,
    pub reason: Option<String>,
    pub occurred_at: String,
    pub room_outcomes: Vec<ModerationRoomOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommunityModerationResult {
    pub audit: ModerationAuditEntry,
    pub audit_recorded: bool,
    /// Why no durable record was written, when none was.
    ///
    /// `audit_recorded: false` on its own reads as "Mesh tried and failed",
    /// and today it always means "Mesh declines to treat a forgeable room
    /// message as evidence" -- a policy, not a fault. Once a real audit store
    /// exists those two become genuinely different outcomes, and a bare
    /// boolean could not tell them apart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit_unrecorded_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityAccessSettings {
    pub alias: Option<String>,
    pub discoverable: bool,
    pub join_rule: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityDirectoryEntry {
    pub id: String,
    pub alias: Option<String>,
    pub name: String,
    pub description: String,
    pub member_count: u32,
    pub join_rule: String,
}

/// Somebody an account service returned for a directory search.
///
/// Deliberately not a `MemberRecord`: this person is not in any room with the
/// searcher and has no role, membership or ban state to report. All that is
/// known is what the service publishes about them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPerson {
    pub user_id: String,
    pub display_name: String,
    /// `mxc://` address, resolved by the renderer the same way message avatars
    /// are. `avatar_color` remains the fallback and is always present.
    pub avatar_url: Option<String>,
    pub avatar_color: String,
}

/// A directory answer, with whether the service gave all of it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPeopleResult {
    pub people: Vec<DirectoryPerson>,
    /// The service had more matches than it returned. Not the same as finding
    /// nobody, and the interface must not word them alike.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityApplication {
    pub user_id: String,
    pub display_name: String,
    pub reason: Option<String>,
    pub requested_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityAccessResult {
    pub status: String,
    pub community: Option<CommunityDto>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCommunityAdmission {
    /// Native-only one-use account admission. This field must never serialize
    /// into an IPC response or generated renderer type.
    #[serde(default, skip_serializing, skip_deserializing)]
    #[ts(skip)]
    pub registration_token: Option<String>,
    pub room_id: String,
    pub service: String,
    pub via: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub expires_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub community_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inviter_display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inviter_user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join_rule: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub community_service_display_name: Option<String>,
}

impl std::fmt::Debug for MatrixCommunityAdmission {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MatrixCommunityAdmission")
            .field(
                "registration_token_present",
                &self.registration_token.is_some(),
            )
            .field("room_id", &self.room_id)
            .field("service", &self.service)
            .field("via", &self.via)
            .field("expires_at", &self.expires_at)
            .field("community_name", &self.community_name)
            .field("inviter_display_name", &self.inviter_display_name)
            .field("inviter_user_id", &self.inviter_user_id)
            .field("join_rule", &self.join_rule)
            .field(
                "community_service_display_name",
                &self.community_service_display_name,
            )
            .finish()
    }
}

/// Metadata for an invitation held by the native pending-invitation store.
///
/// This intentionally contains no invitation URL, admission code, or
/// registration token. The renderer may use it to explain that an invitation
/// is waiting without receiving the secret itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PendingInvitationMetadata {
    pub handle: String,
    pub room_or_alias: Option<String>,
    pub via: Vec<String>,
    pub service: Option<String>,
    pub admission_service: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub community_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inviter_display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inviter_user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join_rule: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub community_service_display_name: Option<String>,
    #[ts(type = "number")]
    pub stored_at: u64,
    #[ts(type = "number")]
    pub expires_at: u64,
}

/// A server-scoped custom emoji published through a room image pack.
///
/// Unlike encrypted message content, image-pack state and its media URI are
/// visible to the homeservers participating in the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CustomEmoji {
    pub shortcode: String,
    pub body: String,
    pub mxc_uri: String,
    pub content_type: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u32,
}

/// Portable, non-secret preferences synchronized through Matrix account data.
/// Device credentials, recovery material, and machine-local network settings
/// are intentionally outside this contract.
fn default_interface_sound_volume() -> u8 {
    60
}

const INTERFACE_SOUND_IDS: [&str; 8] = [
    "voice-self-join",
    "voice-self-leave",
    "voice-peer-join",
    "voice-peer-leave",
    "message-mention",
    "message-direct",
    "message-failed",
    "connection-recovered",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UserPreferences {
    pub schema_version: u32,
    pub notifications_enabled: bool,
    pub notification_sound: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification_sound_id: Option<String>,
    #[serde(default = "default_interface_sound_volume")]
    pub interface_sound_volume: u8,
    #[serde(default)]
    pub interface_sound_events: std::collections::BTreeMap<String, bool>,
    #[serde(default)]
    pub do_not_disturb: bool,
    /// Whether bounded message text may appear in native notifications.
    /// Fresh and migrated accounts remain private unless the user opts in.
    #[serde(default)]
    pub show_notification_content: bool,
    #[serde(default)]
    pub quiet_hours_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quiet_hours_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quiet_hours_end: Option<String>,
    #[serde(default)]
    pub muted_channels: Vec<String>,
    #[serde(default)]
    pub muted_communities: Vec<String>,
    #[serde(default)]
    pub muted_channel_until: std::collections::HashMap<String, Option<String>>,
    #[serde(default)]
    pub muted_community_until: std::collections::HashMap<String, Option<String>>,
    #[serde(default)]
    pub channel_notification_levels: std::collections::HashMap<String, MatrixRoomNotificationMode>,
    #[serde(default)]
    pub send_read_receipts: bool,
    /// Explicit receipt visibility. Missing values are migrated from the
    /// legacy boolean: true meant private-only and false meant off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_receipt_mode: Option<ReadReceiptMode>,
    #[serde(default)]
    pub send_typing_indicators: bool,
    /// Optional per-conversation privacy choices, keyed by Matrix room ID.
    /// Missing fields inherit the account-level choice above.
    #[serde(default)]
    pub conversation_privacy: std::collections::BTreeMap<String, ConversationPrivacyOverride>,
    #[serde(default)]
    pub share_presence: bool,
    #[serde(default)]
    pub invisible_mode: bool,
    pub updated_at: String,
}

impl UserPreferences {
    pub const SCHEMA_VERSION: u32 = 7;
    pub const MAX_CONVERSATION_PRIVACY_OVERRIDES: usize = 256;

    pub fn effective_read_receipt_mode(&self) -> ReadReceiptMode {
        self.read_receipt_mode
            .unwrap_or(if self.send_read_receipts {
                ReadReceiptMode::Private
            } else {
                ReadReceiptMode::Off
            })
    }

    pub fn normalized(mut self) -> Self {
        self.schema_version = Self::SCHEMA_VERSION;
        self.interface_sound_volume = self.interface_sound_volume.min(100);
        self.interface_sound_events = INTERFACE_SOUND_IDS
            .iter()
            .map(|id| {
                (
                    (*id).to_owned(),
                    self.interface_sound_events
                        .get(*id)
                        .copied()
                        .unwrap_or(self.notification_sound),
                )
            })
            .collect();
        if self.read_receipt_mode.is_none() {
            self.read_receipt_mode = Some(self.effective_read_receipt_mode());
        }
        self.muted_channels.sort();
        self.muted_channels.dedup();
        self.muted_communities.sort();
        self.muted_communities.dedup();
        self.conversation_privacy = self.normalized_conversation_privacy();
        self.updated_at = chrono::Utc::now().to_rfc3339();
        self
    }

    pub fn normalized_conversation_privacy(
        &self,
    ) -> std::collections::BTreeMap<String, ConversationPrivacyOverride> {
        self.conversation_privacy
            .iter()
            .filter(|(room_id, value)| {
                room_id.starts_with('!')
                    && room_id.len() <= 255
                    && !room_id.chars().any(char::is_whitespace)
                    && (value.read_receipt_mode.is_some() || value.send_typing_indicators.is_some())
            })
            .take(Self::MAX_CONVERSATION_PRIVACY_OVERRIDES)
            .map(|(room_id, value)| (room_id.clone(), value.clone()))
            .collect()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPrivacyOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_receipt_mode: Option<ReadReceiptMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_typing_indicators: Option<bool>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ReadReceiptMode {
    Public,
    Private,
    #[default]
    Off,
}

#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("backend is not authenticated")]
    NotAuthenticated,
    #[error("network request failed: {0}")]
    Network(String),
    #[error("request was rate limited: {0}")]
    RateLimited(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("local account state permission denied: {0}")]
    LocalStatePermissionDenied(String),
    #[error("resource was not found: {0}")]
    NotFound(String),
    /// No account service knows this address.
    ///
    /// Distinct from `NotFound`, which the renderer words as "it may have been
    /// removed or you may no longer have access" -- true of a room, and wrong
    /// about an address that was simply mistyped.
    #[error("no account exists at {0}")]
    AccountNotFound(String),
    #[error("secure operation failed: {0}")]
    Crypto(String),
    #[error("response could not be decoded: {0}")]
    Serialization(String),
    #[error("room is not encrypted: {0}")]
    NotEncrypted(String),
    #[error("content could not be decrypted: {0}")]
    DecryptionFailed(String),
    #[error("operation was cancelled: {0}")]
    Cancelled(String),
    #[error("operation is unavailable on the {0} backend")]
    Unsupported(&'static str),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("invalid backend configuration: {0}")]
    InvalidConfiguration(String),
    #[error("community-hosted service is not configured")]
    CommunityHomeserverUnconfigured,
    #[error("that username is not available")]
    UsernameUnavailable,
    #[error("the selected account service requires terms acceptance")]
    RegistrationTermsRequired,
    #[error("the selected account service requires an additional verification step")]
    RegistrationAdditionalAuthRequired,
    #[error("a valid Mesh invitation is required to create an account")]
    RegistrationInvitationRequired,
    #[error("the Mesh invitation is invalid, expired, or has already been used")]
    RegistrationInvitationInvalid,
    #[error("account creation timed out after {0} seconds")]
    RegistrationTimedOut(u64),
    #[error("backend error: {0}")]
    Other(String),
    #[error("Matrix sign-in was cancelled")]
    LoginCancelled,
    #[error("Matrix sign-in timed out after {0} seconds")]
    LoginTimedOut(u64),
}

impl BackendError {
    /// Map only errors that can be recovered without modifying local account
    /// state. Permission, secure-storage, and serialization failures stay
    /// outside this mapping so startup can retain the fail-closed native path.
    pub const fn recoverable_startup_issue(&self) -> Option<BackendStartupIssue> {
        match self {
            Self::NotAuthenticated => Some(BackendStartupIssue::SignInRequired),
            Self::Network(_) | Self::RateLimited(_) | Self::LoginTimedOut(_) => {
                Some(BackendStartupIssue::ConnectionUnavailable)
            }
            Self::PermissionDenied(_)
            | Self::NotFound(_)
            // Startup looks up no addresses, so this cannot arise there; it is
            // grouped with NotFound because both mean the service answered and
            // the answer was "no such thing".
            | Self::AccountNotFound(_)
            | Self::InvalidConfiguration(_)
            | Self::CommunityHomeserverUnconfigured => {
                Some(BackendStartupIssue::ServiceUnavailable)
            }
            Self::InvalidInput(_)
            | Self::NotEncrypted(_)
            | Self::DecryptionFailed(_)
            | Self::Cancelled(_)
            | Self::Unsupported(_)
            | Self::UsernameUnavailable
            | Self::RegistrationTermsRequired
            | Self::RegistrationAdditionalAuthRequired
            | Self::RegistrationInvitationRequired
            | Self::RegistrationInvitationInvalid
            | Self::RegistrationTimedOut(_)
            | Self::Other(_)
            | Self::LoginCancelled => Some(BackendStartupIssue::RuntimeUnavailable),
            Self::LocalStatePermissionDenied(_) | Self::Crypto(_) | Self::Serialization(_) => None,
        }
    }

    pub fn device_verification_required() -> Self {
        Self::Crypto(
            "Secure messaging is not ready on this device. Open Settings > Security and verify this device, then try again."
                .into(),
        )
    }

    /// Classify errors from SDK boundaries before they cross IPC. The Matrix
    /// SDK exposes several error families through different concrete types, so
    /// the backend keeps this compatibility classifier in one place instead of
    /// teaching the frontend to parse display strings.
    pub fn from_sdk_error(error: impl std::fmt::Display) -> Self {
        let detail = error.to_string();
        let normalized = detail.to_ascii_lowercase();

        if normalized.contains("your device is not verified")
            || normalized.contains("cross-signing is not set up on your account")
            || normalized.contains("sendingfromunverifieddevice")
            || normalized.contains("crosssigningnotsetup")
        {
            return Self::device_verification_required();
        }

        if normalized.contains("m_limit_exceeded")
            || normalized.contains("rate limit")
            || normalized.contains("too many requests")
            || normalized.contains("status 429")
        {
            return Self::RateLimited(detail);
        }
        if normalized.contains("m_forbidden")
            || normalized.contains("permission denied")
            || normalized.contains("forbidden")
            || normalized.contains("status 403")
        {
            return Self::PermissionDenied(detail);
        }
        if normalized.contains("m_unauthorized")
            || normalized.contains("m_unknown_token")
            || normalized.contains("unknown token")
            || normalized.contains("not authenticated")
            || normalized.contains("authentication required")
            || normalized.contains("status 401")
            || normalized.contains("[401")
        {
            return Self::NotAuthenticated;
        }
        if normalized.contains("m_not_found")
            || normalized.contains("not found")
            || normalized.contains("unknown room")
            || normalized.contains("status 404")
        {
            return Self::NotFound(detail);
        }
        if normalized.contains("decrypt") {
            return Self::DecryptionFailed(detail);
        }
        if normalized.contains("not encrypted") || normalized.contains("encryption unavailable") {
            return Self::NotEncrypted(detail);
        }
        if normalized.contains("cancelled") || normalized.contains("canceled") {
            return Self::Cancelled(detail);
        }
        if normalized.contains("json")
            || normalized.contains("serialize")
            || normalized.contains("deserialize")
            || normalized.contains("decode")
        {
            return Self::Serialization(detail);
        }
        if normalized.contains("crypto")
            || normalized.contains("cipher")
            || normalized.contains("signature")
        {
            return Self::Crypto(detail);
        }
        if normalized.contains("network")
            || normalized.contains("connection")
            || normalized.contains("failed to connect")
            || normalized.contains("could not connect")
            || normalized.contains("dns")
            || normalized.contains("http")
            || normalized.contains("socket")
            || normalized.contains("timed out")
            || normalized.contains("timeout")
        {
            return Self::Network(detail);
        }

        Self::Other(detail)
    }
}

pub type BackendResult<T> = Result<T, BackendError>;

#[async_trait]
pub trait MeshBackend: Send + Sync {
    fn kind(&self) -> BackendKind;
    async fn shutdown(&self) -> BackendResult<()> {
        Ok(())
    }
    async fn active_account_storage_root(&self) -> BackendResult<PathBuf> {
        Err(BackendError::Unsupported("active account storage"))
    }
    async fn active_account_media_cache_root(&self) -> BackendResult<PathBuf> {
        Err(BackendError::Unsupported("active account media cache"))
    }
    async fn store_pending_invitation(
        &self,
        _invite_link: String,
    ) -> BackendResult<PendingInvitationMetadata> {
        Err(BackendError::Unsupported("pending invitations"))
    }
    async fn peek_pending_invitation(&self) -> BackendResult<Option<PendingInvitationMetadata>> {
        Err(BackendError::Unsupported("pending invitations"))
    }
    async fn join_pending_invitation(&self, _handle: String) -> BackendResult<CommunityDto> {
        Err(BackendError::Unsupported("pending invitations"))
    }
    async fn clear_pending_invitation(&self, _handle: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("pending invitations"))
    }
    fn set_matrix_event_callback(&self, _callback: Option<MatrixBackendEventCallback>) {}
    async fn start(&self) -> BackendResult<()>;
    async fn active_user_id(&self) -> Option<String> {
        None
    }
    async fn status(&self) -> BackendStatus;
    async fn matrix_room_is_encrypted(&self, _room_id: String) -> BackendResult<bool> {
        Err(BackendError::Unsupported("room protection status"))
    }
    async fn matrix_room_upgrade(
        &self,
        _room_id: String,
    ) -> BackendResult<Option<MatrixRoomUpgrade>> {
        Err(BackendError::Unsupported("room upgrade status"))
    }
    async fn matrix_room_notification_mode(
        &self,
        _room_id: String,
    ) -> BackendResult<MatrixRoomNotificationMode> {
        Err(BackendError::Unsupported(
            "Matrix room notification settings",
        ))
    }
    async fn matrix_set_room_notification_mode(
        &self,
        _room_id: String,
        _mode: MatrixRoomNotificationMode,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported(
            "Matrix room notification settings",
        ))
    }
    async fn reserve_login_attempt(&self) -> BackendResult<String> {
        Err(BackendError::Unsupported("Matrix login reservation"))
    }
    async fn login(&self, request: MatrixLogin, attempt_id: String)
        -> BackendResult<BackendStatus>;
    async fn register_account(&self, _request: MatrixRegistration) -> BackendResult<BackendStatus> {
        Err(BackendError::Unsupported("Matrix account registration"))
    }
    async fn check_username_available(
        &self,
        _homeserver: String,
        _username: String,
    ) -> BackendResult<bool> {
        Err(BackendError::Unsupported(
            "Matrix account username availability",
        ))
    }
    async fn service_capabilities(
        &self,
        _homeserver: String,
    ) -> BackendResult<MatrixServiceCapabilities> {
        Err(BackendError::Unsupported("Matrix service discovery"))
    }
    async fn oidc_status(&self, _homeserver: String) -> BackendResult<MatrixOidcStatus> {
        Err(BackendError::Unsupported("Matrix OIDC discovery"))
    }
    async fn start_oidc_login(
        &self,
        _homeserver: String,
        _attempt_id: String,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("Matrix OIDC login"))
    }
    async fn cancel_login(&self, _attempt_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("Matrix login cancellation"))
    }
    async fn restore_session(&self) -> BackendResult<BackendStatus>;
    async fn logout(&self) -> BackendResult<()>;
    async fn list_devices(&self) -> BackendResult<Vec<MatrixDevice>> {
        Err(BackendError::Unsupported("Matrix device listing"))
    }
    async fn revoke_device(&self, _device_id: String, _password: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("Matrix device revocation"))
    }
    async fn remove_local_account(&self) -> BackendResult<()> {
        Err(BackendError::Unsupported("local Matrix account removal"))
    }
    async fn export_personal_data(
        &self,
        _destination_root: PathBuf,
    ) -> BackendResult<MatrixPersonalDataExport> {
        Err(BackendError::Unsupported("personal data export"))
    }
    async fn cancel_personal_data_export(&self) -> BackendResult<()> {
        Err(BackendError::Unsupported(
            "personal data export cancellation",
        ))
    }
    async fn deactivate_account(&self, _password: String, _erase_data: bool) -> BackendResult<()> {
        Err(BackendError::Unsupported("Matrix account deactivation"))
    }
    async fn list_accounts(&self) -> BackendResult<Vec<MatrixAccount>> {
        Err(BackendError::Unsupported("saved Matrix accounts"))
    }
    async fn switch_account(&self, _profile_id: String) -> BackendResult<BackendStatus> {
        Err(BackendError::Unsupported("Matrix account switching"))
    }
    async fn get_profile(&self) -> BackendResult<MatrixProfile> {
        Err(BackendError::Unsupported("Matrix profile"))
    }
    async fn update_profile_display_name(
        &self,
        _display_name: String,
    ) -> BackendResult<MatrixProfile> {
        Err(BackendError::Unsupported("Matrix profile editing"))
    }
    async fn recovery_health(&self) -> BackendResult<MatrixRecoveryHealth> {
        Err(BackendError::Unsupported("Matrix recovery health"))
    }
    async fn test_recovery(
        &self,
        _recovery_key_or_passphrase: String,
    ) -> BackendResult<MatrixRecoveryHealth> {
        Err(BackendError::Unsupported("Matrix recovery test"))
    }
    async fn test_stored_recovery(&self) -> BackendResult<MatrixRecoveryHealth> {
        Err(BackendError::Unsupported("stored Matrix recovery test"))
    }
    async fn start_device_verification(
        &self,
        _device_id: String,
    ) -> BackendResult<MatrixVerificationSession> {
        Err(BackendError::Unsupported("Matrix device verification"))
    }
    async fn device_verification_status(
        &self,
        _verification_id: String,
    ) -> BackendResult<MatrixVerificationSession> {
        Err(BackendError::Unsupported("Matrix device verification"))
    }
    async fn select_device_verification_method(
        &self,
        _verification_id: String,
        _method: String,
    ) -> BackendResult<MatrixVerificationSession> {
        Err(BackendError::Unsupported("Matrix device verification"))
    }
    async fn confirm_device_verification(
        &self,
        _verification_id: String,
        _matches: bool,
    ) -> BackendResult<MatrixVerificationSession> {
        Err(BackendError::Unsupported("Matrix device verification"))
    }
    async fn cancel_device_verification(&self, _verification_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("Matrix device verification"))
    }
    async fn create_community(
        &self,
        name: String,
        description: String,
    ) -> BackendResult<CreatedCommunity>;
    async fn list_communities(&self) -> BackendResult<EntityList<CommunityDto>> {
        Err(BackendError::Unsupported("community listing"))
    }
    async fn community_invites(&self) -> BackendResult<Vec<CommunityInviteDto>> {
        Err(BackendError::Unsupported("community invitations"))
    }
    async fn decline_community_invite(&self, _room_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("community invitations"))
    }
    async fn list_channels(&self, _community_id: String) -> BackendResult<EntityList<ChannelDto>> {
        Err(BackendError::Unsupported("channel listing"))
    }
    async fn create_channel(
        &self,
        _community_id: String,
        _name: String,
        _channel_type: String,
    ) -> BackendResult<ChannelDto> {
        Err(BackendError::Unsupported("channel creation"))
    }
    /// Joins a room this account is already admitted to by being a member of
    /// the community that lists it, returning the room as a joined channel.
    ///
    /// Deliberately narrower than joining a room by ID: the room must be an
    /// active child of the named community, so this can never be used to enter
    /// an unrelated room, and the same encryption rule every other room in Mesh
    /// is held to applies before the join is allowed to stand.
    async fn join_community_channel(
        &self,
        _community_id: String,
        _channel_id: String,
    ) -> BackendResult<ChannelDto> {
        Err(BackendError::Unsupported("joining a community room"))
    }
    async fn update_profile_avatar(
        &self,
        _filename: String,
        _content_type: String,
        _bytes: Vec<u8>,
    ) -> BackendResult<MatrixProfile> {
        Err(BackendError::Unsupported("profile pictures"))
    }
    async fn clear_profile_avatar(&self) -> BackendResult<MatrixProfile> {
        Err(BackendError::Unsupported("profile pictures"))
    }
    async fn load_profile_avatar(&self, _avatar_url: String) -> BackendResult<Vec<u8>> {
        Err(BackendError::Unsupported("profile pictures"))
    }
    /// Sets a community's or room's icon, returning the MXC URI the room now
    /// carries. Room-generic because a Matrix space is a room and
    /// `m.room.avatar` is ordinary room state; only communities expose it today.
    async fn set_room_avatar(
        &self,
        _room_id: String,
        _filename: String,
        _content_type: String,
        _bytes: Vec<u8>,
    ) -> BackendResult<String> {
        Err(BackendError::Unsupported("community images"))
    }
    async fn clear_room_avatar(&self, _room_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("community images"))
    }
    async fn update_channel(
        &self,
        _community_id: String,
        _channel_id: String,
        _name: Option<String>,
        _topic: Option<String>,
    ) -> BackendResult<ChannelDto> {
        Err(BackendError::Unsupported("channel updates"))
    }
    async fn remove_channel(
        &self,
        _community_id: String,
        _channel_id: String,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("channel removal"))
    }
    async fn list_custom_emoji(&self, _community_id: String) -> BackendResult<Vec<CustomEmoji>> {
        Err(BackendError::Unsupported("server custom emoji"))
    }
    async fn upload_custom_emoji(
        &self,
        _community_id: String,
        _shortcode: String,
        _filename: String,
        _content_type: String,
        _bytes: Vec<u8>,
    ) -> BackendResult<CustomEmoji> {
        Err(BackendError::Unsupported("server custom emoji"))
    }
    async fn remove_custom_emoji(
        &self,
        _community_id: String,
        _shortcode: String,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("server custom emoji"))
    }
    async fn load_custom_emoji_image(
        &self,
        _community_id: String,
        _shortcode: String,
    ) -> BackendResult<Vec<u8>> {
        Err(BackendError::Unsupported("server custom emoji"))
    }
    async fn matrix_rtc_join(&self, _room_id: String) -> BackendResult<MatrixRtcJoinResult> {
        Err(BackendError::Unsupported("MatrixRTC calling"))
    }
    async fn matrix_rtc_refresh_membership(
        &self,
        _room_id: String,
        _session_id: String,
    ) -> BackendResult<Vec<MatrixRtcMember>> {
        Err(BackendError::Unsupported("MatrixRTC calling"))
    }
    async fn matrix_rtc_ack_media_key_pause(
        &self,
        _room_id: String,
        _session_id: String,
        _member_id: String,
        _activation_id: String,
    ) -> BackendResult<MatrixRtcMediaKey> {
        Err(BackendError::Unsupported("MatrixRTC media-key activation"))
    }
    async fn matrix_rtc_ack_media_key(
        &self,
        _room_id: String,
        _session_id: String,
        _member_id: String,
        _activation_id: String,
        _key_index: u8,
        _sent_ts: u64,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("MatrixRTC media-key activation"))
    }
    async fn matrix_rtc_renew_media_key_lease(
        &self,
        _room_id: String,
        _session_id: String,
        _member_id: String,
    ) -> BackendResult<MatrixRtcMediaKeyLease> {
        Err(BackendError::Unsupported(
            "MatrixRTC media-key publication lease",
        ))
    }
    async fn matrix_rtc_leave(&self, _room_id: String, _session_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("MatrixRTC calling"))
    }
    async fn matrix_rtc_members(&self, _room_id: String) -> BackendResult<Vec<MatrixRtcMember>> {
        Err(BackendError::Unsupported("MatrixRTC calling"))
    }
    async fn send_text(&self, room_id: String, body: String) -> BackendResult<SentMessage>;
    #[allow(clippy::too_many_arguments)]
    async fn send_message(
        &self,
        _room_id: String,
        _body: String,
        _mentions: Vec<String>,
        _mentions_room: bool,
        _reply_to_id: Option<String>,
        _thread_root_id: Option<String>,
        _transaction_id: String,
    ) -> BackendResult<MessageDto> {
        Err(BackendError::Unsupported("message delivery"))
    }
    async fn queued_messages(&self) -> BackendResult<Vec<MessageDto>> {
        Err(BackendError::Unsupported("durable queued messages"))
    }
    async fn retry_queued_message(
        &self,
        _room_id: String,
        _transaction_id: String,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("durable queued messages"))
    }
    async fn cancel_queued_message(
        &self,
        _room_id: String,
        _transaction_id: String,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("durable queued messages"))
    }
    async fn save_composer_draft(
        &self,
        _room_id: String,
        _draft: ComposerDraftDto,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("durable message drafts"))
    }
    async fn load_composer_draft(
        &self,
        _room_id: String,
    ) -> BackendResult<Option<ComposerDraftDto>> {
        Err(BackendError::Unsupported("durable message drafts"))
    }
    async fn clear_composer_draft(&self, _room_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("durable message drafts"))
    }
    async fn send_attachment(
        &self,
        _room_id: String,
        _request: MatrixAttachmentSendRequest,
        _transfer: MatrixTransferObserver,
    ) -> BackendResult<MessageDto> {
        Err(BackendError::Unsupported("encrypted Matrix attachments"))
    }
    async fn cancel_attachment_upload(&self, _transfer_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported(
            "encrypted Matrix attachment upload cancellation",
        ))
    }
    async fn download_attachment(
        &self,
        _room_id: String,
        _event_id: String,
        _attachment_index: u32,
        _transfer: MatrixTransferObserver,
    ) -> BackendResult<String> {
        Err(BackendError::Unsupported("encrypted Matrix attachments"))
    }
    async fn load_attachment_thumbnail(
        &self,
        _room_id: String,
        _event_id: String,
        _attachment_index: u32,
    ) -> BackendResult<Vec<u8>> {
        Err(BackendError::Unsupported(
            "encrypted Matrix attachment previews",
        ))
    }
    async fn load_attachment_image(
        &self,
        _room_id: String,
        _event_id: String,
        _attachment_index: u32,
    ) -> BackendResult<Vec<u8>> {
        Err(BackendError::Unsupported(
            "encrypted Matrix attachment image previews",
        ))
    }
    async fn cancel_attachment_download(&self, _file_hash: String) -> BackendResult<()> {
        Err(BackendError::Unsupported(
            "encrypted Matrix attachment cancellation",
        ))
    }
    async fn dm_conversations(&self) -> BackendResult<EntityList<DmConversationDto>> {
        Err(BackendError::Unsupported("Matrix direct messages"))
    }
    async fn dm_requests(&self) -> BackendResult<Vec<DmRequestDto>> {
        Err(BackendError::Unsupported("Matrix direct-message requests"))
    }
    async fn accept_dm_request(&self, _room_id: String) -> BackendResult<DmConversationDto> {
        Err(BackendError::Unsupported("Matrix direct-message requests"))
    }
    async fn decline_dm_request(&self, _room_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("Matrix direct-message requests"))
    }
    async fn block_dm_request(&self, _room_id: String) -> BackendResult<BlockedAccountDto> {
        Err(BackendError::Unsupported("Matrix direct-message requests"))
    }
    async fn blocked_accounts(
        &self,
        _after: Option<String>,
        _limit: u32,
    ) -> BackendResult<BlockedAccountPageDto> {
        Err(BackendError::Unsupported("Matrix account blocking"))
    }
    async fn ensure_dm(&self, _recipient_user_id: String) -> BackendResult<DmConversationDto> {
        Err(BackendError::Unsupported("Matrix direct messages"))
    }
    async fn dm_messages(
        &self,
        _conversation_id: String,
        _limit: u32,
        _before_timestamp: Option<String>,
        _before_id: Option<String>,
    ) -> BackendResult<Vec<DirectMessageDto>> {
        Err(BackendError::Unsupported("Matrix direct messages"))
    }
    async fn send_dm(
        &self,
        _recipient_user_id: String,
        _body: String,
        _reply_to_id: Option<String>,
        _thread_root_id: Option<String>,
        _transaction_id: String,
    ) -> BackendResult<DirectMessageDto> {
        Err(BackendError::Unsupported("Matrix direct messages"))
    }
    async fn send_dm_attachment(
        &self,
        _recipient_user_id: String,
        _request: MatrixAttachmentSendRequest,
        _transfer: MatrixTransferObserver,
    ) -> BackendResult<DirectMessageDto> {
        Err(BackendError::Unsupported(
            "Matrix direct-message attachments",
        ))
    }
    async fn mark_dm_read(&self, _conversation_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("Matrix direct messages"))
    }
    async fn set_dm_blocked(
        &self,
        _recipient_user_id: String,
        _blocked: bool,
    ) -> BackendResult<bool> {
        Err(BackendError::Unsupported("Matrix DM blocking"))
    }
    async fn dm_blocked(&self, _recipient_user_id: String) -> BackendResult<bool> {
        Err(BackendError::Unsupported("Matrix DM blocking"))
    }
    async fn messages(
        &self,
        _room_id: String,
        _limit: u32,
        _before_timestamp: Option<String>,
        _before_id: Option<String>,
    ) -> BackendResult<Vec<MessageDto>> {
        Err(BackendError::Unsupported("message history"))
    }
    async fn thread_context(
        &self,
        _room_id: String,
        _thread_root_id: String,
    ) -> BackendResult<MatrixThreadContextDto> {
        Err(BackendError::Unsupported("thread history"))
    }
    async fn thread_list(&self, _room_id: String) -> BackendResult<MatrixThreadListDto> {
        Err(BackendError::Unsupported("thread list"))
    }
    async fn edit_message(
        &self,
        _room_id: String,
        _event_id: String,
        _body: String,
        _mentions: Vec<String>,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("message editing"))
    }
    async fn redact_message(&self, _room_id: String, _event_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("message redaction"))
    }
    async fn report_message(
        &self,
        _room_id: String,
        _event_id: String,
        _reason: String,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("message reporting"))
    }
    async fn toggle_reaction(
        &self,
        _room_id: String,
        _event_id: String,
        _key: String,
    ) -> BackendResult<bool> {
        Err(BackendError::Unsupported("message reactions"))
    }
    async fn room_pins(&self, _room_id: String) -> BackendResult<MatrixRoomPins> {
        Err(BackendError::Unsupported("room pins"))
    }
    async fn toggle_room_pin(
        &self,
        _room_id: String,
        _event_id: String,
    ) -> BackendResult<MatrixRoomPins> {
        Err(BackendError::Unsupported("room pins"))
    }
    async fn mark_read(&self, _room_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("read receipts"))
    }
    async fn set_unread_flag(&self, _room_id: String, _unread: bool) -> BackendResult<()> {
        Err(BackendError::Unsupported("unread marker"))
    }
    async fn mark_thread_read(
        &self,
        _room_id: String,
        _thread_root_id: String,
        _event_id: String,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("thread read receipts"))
    }
    async fn set_typing(&self, _room_id: String, _typing: bool) -> BackendResult<()> {
        Err(BackendError::Unsupported("typing notifications"))
    }
    async fn typing_users(&self, _room_id: String) -> BackendResult<Vec<TypingUser>> {
        Err(BackendError::Unsupported("typing notifications"))
    }
    async fn search_messages(
        &self,
        _community_id: String,
        _terms: Vec<String>,
        _limit: u32,
        _request_id: String,
        _deadline_ms: u64,
        _filters: MessageSearchFilters,
    ) -> BackendResult<Vec<MessageDto>> {
        Err(BackendError::Unsupported("message search"))
    }
    async fn search_messages_everywhere(
        &self,
        _community_ids: Vec<String>,
        _terms: Vec<String>,
        _limit: u32,
        _request_id: String,
        _deadline_ms: u64,
        _filters: MessageSearchFilters,
    ) -> BackendResult<MatrixCrossCommunitySearchResultDto> {
        Err(BackendError::Unsupported("cross-community message search"))
    }
    async fn cancel_search(&self, _request_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("search cancellation"))
    }
    async fn wait_for_room_update(
        &self,
        _room_id: String,
        _timeout_ms: u64,
    ) -> BackendResult<MatrixRoomUpdateKind> {
        Err(BackendError::Unsupported("room update subscription"))
    }
    async fn list_member_page(
        &self,
        _community_id: String,
        _cursor: Option<String>,
        _limit: Option<u32>,
    ) -> BackendResult<CommunityMemberPage> {
        Err(BackendError::Unsupported("community membership"))
    }
    async fn invite_to_community(
        &self,
        _community_id: String,
        _user_id: String,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("community invitations"))
    }
    async fn create_community_invite(&self, _community_id: String) -> BackendResult<String> {
        Err(BackendError::Unsupported("community invite links"))
    }
    async fn resolve_community_invite(
        &self,
        _invite_url: String,
    ) -> BackendResult<MatrixCommunityAdmission> {
        Err(BackendError::Unsupported(
            "managed community invitation resolution",
        ))
    }
    async fn claim_community_invite(&self, _invite_url: String) -> BackendResult<CommunityDto> {
        Err(BackendError::Unsupported(
            "managed community invitation admission",
        ))
    }
    async fn community_access_settings(
        &self,
        _community_id: String,
    ) -> BackendResult<CommunityAccessSettings> {
        Err(BackendError::Unsupported("community access settings"))
    }
    async fn update_community_access(
        &self,
        _community_id: String,
        _alias: Option<String>,
        _discoverable: bool,
        _join_rule: String,
    ) -> BackendResult<CommunityAccessSettings> {
        Err(BackendError::Unsupported("community access settings"))
    }
    async fn search_community_directory(
        &self,
        _query: String,
        _server: Option<String>,
        _limit: u32,
        _request_id: String,
        _deadline_ms: u64,
    ) -> BackendResult<Vec<CommunityDirectoryEntry>> {
        Err(BackendError::Unsupported("community directory"))
    }
    /// Search the account service's user directory.
    ///
    /// What comes back is the *local* service's answer, and most homeservers
    /// only publish people who share a room with the searcher or are in public
    /// rooms. An account with no communities can therefore get an empty result
    /// from a service behaving exactly as intended, which is why the caller
    /// words the empty state as the service's answer rather than as absence.
    async fn search_person_directory(
        &self,
        _query: String,
        _limit: u32,
        _request_id: String,
        _deadline_ms: u64,
    ) -> BackendResult<DirectoryPeopleResult> {
        Err(BackendError::Unsupported("user directory"))
    }
    async fn knock_community(
        &self,
        _room_or_alias: String,
        _reason: Option<String>,
        _via: Vec<String>,
    ) -> BackendResult<CommunityAccessResult> {
        Err(BackendError::Unsupported("community knock requests"))
    }
    async fn list_community_applications(
        &self,
        _community_id: String,
    ) -> BackendResult<Vec<CommunityApplication>> {
        Err(BackendError::Unsupported("community applications"))
    }
    async fn respond_community_application(
        &self,
        _community_id: String,
        _user_id: String,
        _accept: bool,
        _reason: Option<String>,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("community applications"))
    }
    async fn join_community(
        &self,
        _room_or_alias: String,
        _via: Vec<String>,
    ) -> BackendResult<CommunityDto> {
        Err(BackendError::Unsupported("community join"))
    }
    async fn leave_community(&self, _community_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("community leave"))
    }
    async fn update_community(
        &self,
        _community_id: String,
        _name: String,
        _description: String,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("community metadata"))
    }
    async fn community_permission_projection(
        &self,
        _community_id: String,
        _subject_user_id: String,
    ) -> BackendResult<CommunityPermissionProjection> {
        Err(BackendError::Unsupported("community permission projection"))
    }
    async fn update_member_role(
        &self,
        _community_id: String,
        _user_id: String,
        _role: String,
    ) -> BackendResult<CommunityModerationResult> {
        Err(BackendError::Unsupported("community roles"))
    }
    async fn kick_member(
        &self,
        _community_id: String,
        _user_id: String,
        _reason: Option<String>,
    ) -> BackendResult<CommunityModerationResult> {
        Err(BackendError::Unsupported("community kicks"))
    }
    async fn ban_member(
        &self,
        _community_id: String,
        _user_id: String,
        _reason: Option<String>,
    ) -> BackendResult<CommunityModerationResult> {
        Err(BackendError::Unsupported("community bans"))
    }
    async fn unban_member(
        &self,
        _community_id: String,
        _user_id: String,
        _reason: Option<String>,
    ) -> BackendResult<CommunityModerationResult> {
        Err(BackendError::Unsupported("community bans"))
    }
    async fn list_moderation_audit(
        &self,
        _community_id: String,
        _limit: u32,
    ) -> BackendResult<Vec<ModerationAuditEntry>> {
        Err(BackendError::Unsupported("community moderation audit"))
    }
    async fn user_preferences(&self) -> BackendResult<Option<UserPreferences>> {
        Err(BackendError::Unsupported("Matrix account-data preferences"))
    }
    async fn update_user_preferences(
        &self,
        _preferences: UserPreferences,
    ) -> BackendResult<UserPreferences> {
        Err(BackendError::Unsupported("Matrix account-data preferences"))
    }
    async fn invite_user(&self, room_id: String, user_id: String) -> BackendResult<()>;
    async fn join_room(&self, room_id: String) -> BackendResult<()>;
    async fn recent_texts(&self, room_id: String, limit: u32) -> BackendResult<Vec<String>>;
    async fn enable_recovery(
        &self,
        passphrase: Option<String>,
    ) -> BackendResult<MatrixRecoverySetupResult>;
    async fn recover(&self, recovery_key_or_passphrase: String) -> BackendResult<()>;
    async fn sync_once(&self) -> BackendResult<()>;
    /// Persist one provenance event from an explicitly approved legacy import.
    /// Matrix implementations send an encrypted custom room event; legacy
    /// backends intentionally do not import into their own source store.
    async fn import_legacy_event(
        &self,
        _room_id: String,
        _content: serde_json::Value,
    ) -> BackendResult<String> {
        Err(BackendError::Unsupported("legacy archive import"))
    }
}

/// Owns the selected backend and makes selection explicit and inspectable.
#[derive(Clone)]
pub struct BackendManager {
    inner: Arc<dyn MeshBackend>,
}

impl BackendManager {
    #[allow(clippy::needless_return)]
    pub fn from_environment(app_data_dir: PathBuf) -> Self {
        #[cfg(not(feature = "matrix-backend"))]
        let _ = &app_data_dir;

        let requested = std::env::var("MESH_BACKEND")
            .unwrap_or_else(|_| "matrix".to_owned())
            .to_ascii_lowercase();

        match requested.as_str() {
            "legacy" | "legacy-p2p" | "libp2p" => {
                #[cfg(feature = "legacy-p2p")]
                {
                    return Self {
                        inner: Arc::new(LegacyP2pBackend::new()),
                    };
                }
                #[cfg(not(feature = "legacy-p2p"))]
                {
                    tracing::warn!(
                        "Legacy backend requested, but this production build excludes legacy-p2p; using Matrix"
                    );
                    #[cfg(feature = "matrix-backend")]
                    {
                        Self {
                            inner: Arc::new(MatrixBackend::new(app_data_dir.join("matrix"))),
                        }
                    }
                    #[cfg(not(feature = "matrix-backend"))]
                    compile_error!("Enable at least one backend feature");
                }
            }
            "matrix" => {
                #[cfg(feature = "matrix-backend")]
                {
                    Self {
                        inner: Arc::new(MatrixBackend::new(app_data_dir.join("matrix"))),
                    }
                }
                #[cfg(not(feature = "matrix-backend"))]
                {
                    #[cfg(feature = "legacy-p2p")]
                    {
                        tracing::warn!(
                            "Matrix backend requested but not compiled; using experimental legacy-p2p"
                        );
                        Self {
                            inner: Arc::new(LegacyP2pBackend::new()),
                        }
                    }
                    #[cfg(not(feature = "legacy-p2p"))]
                    compile_error!("Enable at least one backend feature");
                }
            }
            other => {
                tracing::warn!(
                    backend = other,
                    "Unknown MESH_BACKEND value; using Matrix production default"
                );
                #[cfg(feature = "matrix-backend")]
                {
                    Self {
                        inner: Arc::new(MatrixBackend::new(app_data_dir.join("matrix"))),
                    }
                }
                #[cfg(not(feature = "matrix-backend"))]
                {
                    #[cfg(feature = "legacy-p2p")]
                    {
                        Self {
                            inner: Arc::new(LegacyP2pBackend::new()),
                        }
                    }
                    #[cfg(not(feature = "legacy-p2p"))]
                    compile_error!("Enable at least one backend feature");
                }
            }
        }
    }

    pub fn kind(&self) -> BackendKind {
        self.inner.kind()
    }

    pub fn backend(&self) -> Arc<dyn MeshBackend> {
        Arc::clone(&self.inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_kind_serializes_for_typed_ipc() {
        assert_eq!(
            serde_json::to_string(&BackendKind::Matrix).unwrap(),
            "\"matrix\""
        );
        assert_eq!(
            serde_json::to_string(&BackendKind::LegacyP2p).unwrap(),
            "\"legacy-p2p\""
        );
    }

    #[test]
    fn startup_errors_keep_remote_failures_recoverable_and_local_failures_fatal() {
        let cases = [
            (
                BackendError::NotAuthenticated,
                Some(BackendStartupIssue::SignInRequired),
            ),
            (
                BackendError::Network("offline".into()),
                Some(BackendStartupIssue::ConnectionUnavailable),
            ),
            (
                BackendError::RateLimited("busy".into()),
                Some(BackendStartupIssue::ConnectionUnavailable),
            ),
            (
                BackendError::InvalidConfiguration("service".into()),
                Some(BackendStartupIssue::ServiceUnavailable),
            ),
            (
                BackendError::Other("runtime".into()),
                Some(BackendStartupIssue::RuntimeUnavailable),
            ),
            (
                BackendError::PermissionDenied("remote service".into()),
                Some(BackendStartupIssue::ServiceUnavailable),
            ),
            (
                BackendError::LocalStatePermissionDenied("local store".into()),
                None,
            ),
            (BackendError::Crypto("secure storage".into()), None),
            (BackendError::Serialization("saved session".into()), None),
        ];

        for (error, expected) in cases {
            assert_eq!(error.recoverable_startup_issue(), expected);
        }
    }

    #[test]
    fn secret_bearing_matrix_types_redact_debug_output() {
        let login = MatrixLogin {
            homeserver: "https://matrix.example".into(),
            username: "alice".into(),
            password: "sentinel-login-password".into(),
            device_name: Some("Mesh desktop".into()),
        };
        let registration = MatrixRegistration {
            homeserver: "https://matrix.example".into(),
            username: "alice".into(),
            password: "sentinel-registration-password".into(),
            pending_invitation_handle: Some("sentinel-pending-handle".into()),
            device_name: Some("Mesh desktop".into()),
        };
        let admission = MatrixCommunityAdmission {
            registration_token: Some("sentinel-registration-token".into()),
            room_id: "!community:example.org".into(),
            service: "https://matrix.example".into(),
            via: vec!["example.org".into()],
            expires_at: None,
            community_name: None,
            inviter_display_name: None,
            inviter_user_id: None,
            join_rule: None,
            community_service_display_name: None,
        };

        let rendered = format!("{login:?}\n{registration:?}\n{admission:?}");
        for secret in [
            "sentinel-login-password",
            "sentinel-registration-password",
            "sentinel-pending-handle",
            "sentinel-registration-token",
        ] {
            assert!(!rendered.contains(secret));
        }
        assert!(rendered.contains("[REDACTED]"));
        assert!(rendered.contains("registration_token_present: true"));
    }

    #[test]
    fn matrix_room_notification_modes_use_renderer_wire_values() {
        assert_eq!(
            serde_json::to_string(&MatrixRoomNotificationMode::All).unwrap(),
            "\"all\""
        );
        assert_eq!(
            serde_json::to_string(&MatrixRoomNotificationMode::Mentions).unwrap(),
            "\"mentions\""
        );
        assert_eq!(
            serde_json::to_string(&MatrixRoomNotificationMode::Nothing).unwrap(),
            "\"nothing\""
        );
    }

    #[test]
    fn missing_wire_privacy_fields_keep_read_receipts_off() {
        let preferences: UserPreferences = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "notificationsEnabled": true,
            "notificationSound": true,
            "updatedAt": "2026-07-26T00:00:00Z"
        }))
        .expect("legacy preferences should migrate");

        assert!(!preferences.send_read_receipts);
        assert_eq!(preferences.read_receipt_mode, None);
        assert_eq!(
            preferences.effective_read_receipt_mode(),
            ReadReceiptMode::Off
        );
        assert!(!preferences.send_typing_indicators);
        assert!(!preferences.share_presence);
        assert!(!preferences.invisible_mode);
        assert!(!preferences.show_notification_content);
    }

    #[test]
    fn portable_preferences_are_versioned_and_deduplicated() {
        let preferences = UserPreferences {
            schema_version: 99,
            notifications_enabled: true,
            notification_sound: false,
            notification_sound_id: Some("chime".into()),
            interface_sound_volume: 200,
            interface_sound_events: std::collections::BTreeMap::from([
                ("message-direct".into(), true),
                ("unknown-cue".into(), true),
            ]),
            do_not_disturb: true,
            show_notification_content: true,
            quiet_hours_enabled: true,
            quiet_hours_start: Some("22:00".into()),
            quiet_hours_end: Some("07:00".into()),
            muted_channels: vec!["!b:example.org".into(), "!b:example.org".into()],
            muted_communities: vec!["!space:example.org".into()],
            muted_channel_until: std::collections::HashMap::from([(
                "!b:example.org".into(),
                Some("2026-07-26T00:00:00Z".into()),
            )]),
            muted_community_until: std::collections::HashMap::from([(
                "!space:example.org".into(),
                None,
            )]),
            channel_notification_levels: std::collections::HashMap::from([(
                "!b:example.org".into(),
                MatrixRoomNotificationMode::Mentions,
            )]),
            send_read_receipts: false,
            read_receipt_mode: Some(ReadReceiptMode::Off),
            send_typing_indicators: true,
            conversation_privacy: std::collections::BTreeMap::from([
                (
                    "!room:example.org".into(),
                    ConversationPrivacyOverride {
                        read_receipt_mode: Some(ReadReceiptMode::Public),
                        send_typing_indicators: Some(true),
                    },
                ),
                (
                    "not-a-room".into(),
                    ConversationPrivacyOverride {
                        read_receipt_mode: Some(ReadReceiptMode::Public),
                        send_typing_indicators: None,
                    },
                ),
            ]),
            share_presence: false,
            invisible_mode: true,
            updated_at: "stale".into(),
        }
        .normalized();

        assert_eq!(preferences.schema_version, UserPreferences::SCHEMA_VERSION);
        assert_eq!(preferences.interface_sound_volume, 100);
        assert!(preferences.interface_sound_events["message-direct"]);
        assert!(!preferences.interface_sound_events["voice-self-join"]);
        assert!(!preferences
            .interface_sound_events
            .contains_key("unknown-cue"));
        assert!(preferences.show_notification_content);
        assert_eq!(preferences.read_receipt_mode, Some(ReadReceiptMode::Off));
        assert_eq!(preferences.conversation_privacy.len(), 1);
        assert_eq!(
            preferences.conversation_privacy["!room:example.org"].read_receipt_mode,
            Some(ReadReceiptMode::Public)
        );
        assert_eq!(preferences.muted_channels, vec!["!b:example.org"]);
        assert_eq!(
            preferences.channel_notification_levels["!b:example.org"],
            MatrixRoomNotificationMode::Mentions
        );
        assert_ne!(preferences.updated_at, "stale");
    }

    #[test]
    fn legacy_read_receipt_opt_in_migrates_to_private_only() {
        let preferences: UserPreferences = serde_json::from_value(serde_json::json!({
            "schemaVersion": 3,
            "notificationsEnabled": true,
            "notificationSound": true,
            "sendReadReceipts": true,
            "updatedAt": "2026-07-26T00:00:00Z"
        }))
        .expect("legacy preferences should migrate");

        assert_eq!(
            preferences.effective_read_receipt_mode(),
            ReadReceiptMode::Private
        );
        assert_eq!(
            preferences.normalized().read_receipt_mode,
            Some(ReadReceiptMode::Private)
        );
    }

    #[test]
    fn matrix_capabilities_include_encrypted_direct_messages() {
        let capabilities = BackendCapabilities::for_kind(BackendKind::Matrix);
        assert!(capabilities.encrypted_text);
        assert!(capabilities.encrypted_attachments);
        assert!(capabilities.direct_messages);
        assert!(!capabilities.voice);
    }

    #[test]
    fn security_boundary_matrix_rtc_configuration_accepts_a_discovered_service() {
        let discovered_sfu = VoiceServiceStatus::matrix_rtc(
            Some("https://rtc.example.org".into()),
            None,
            "connect-src https://rtc.example.org wss://livekit.example.org",
        );
        assert_eq!(
            discovered_sfu.availability,
            if VoiceServiceStatus::matrix_rtc_client_included() {
                VoiceServiceAvailability::Ready
            } else {
                VoiceServiceAvailability::ClientUnavailable
            }
        );
        assert!(discovered_sfu.csp_ready);
        assert!(discovered_sfu.livekit_sfu_url.is_none());
        assert_eq!(
            discovered_sfu.media_e2ee_ready,
            VoiceServiceStatus::matrix_rtc_client_included()
        );

        let insecure = VoiceServiceStatus::matrix_rtc(
            Some("http://rtc.example.org".into()),
            Some("wss://livekit.example.org".into()),
            "connect-src http://rtc.example.org wss://livekit.example.org",
        );
        assert_eq!(
            insecure.availability,
            VoiceServiceAvailability::InvalidConfiguration
        );
        assert!(insecure
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("absolute https URL")));
    }

    #[test]
    fn security_boundary_matrix_rtc_readiness_tracks_the_compiled_client_and_e2ee_worker() {
        let status = VoiceServiceStatus::matrix_rtc(
            Some("https://rtc.example.org/livekit/jwt".into()),
            Some("wss://livekit.example.org".into()),
            "connect-src https://rtc.example.org wss://livekit.example.org",
        );

        assert_eq!(
            status.availability,
            if VoiceServiceStatus::matrix_rtc_client_included() {
                VoiceServiceAvailability::Ready
            } else {
                VoiceServiceAvailability::ClientUnavailable
            }
        );
        assert_eq!(
            status.discovery_key.as_deref(),
            Some("org.matrix.msc4143.rtc_foci")
        );
        assert_eq!(
            status.token_endpoint.as_deref(),
            Some("https://rtc.example.org/livekit/jwt/get_token")
        );
        assert!(status.csp_ready);
        assert_eq!(
            status.media_e2ee_ready,
            VoiceServiceStatus::matrix_rtc_client_included()
        );
        assert!(!BackendCapabilities::for_kind(BackendKind::Matrix).voice);
    }

    #[test]
    fn security_boundary_matrix_rtc_acceptance_client_requires_secure_csp_config() {
        let status = VoiceServiceStatus::matrix_rtc_with_client(
            Some("https://rtc.example.org/livekit/jwt".into()),
            None,
            "connect-src https://rtc.example.org wss://livekit.example.org",
            true,
        );

        assert_eq!(status.availability, VoiceServiceAvailability::Ready);
        assert!(status.csp_ready);
        assert!(status.media_e2ee_ready);
        assert!(status.livekit_sfu_url.is_none());
    }

    #[test]
    fn security_boundary_matrix_rtc_fails_closed_when_csp_omits_media_origins() {
        let status = VoiceServiceStatus::matrix_rtc(
            Some("https://rtc.example.org".into()),
            Some("wss://livekit.example.org".into()),
            "connect-src ipc: http://ipc.localhost",
        );

        assert_eq!(
            status.availability,
            VoiceServiceAvailability::InvalidConfiguration
        );
        assert!(!status.csp_ready);
        assert!(status
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("Tauri connect-src")));
    }

    #[test]
    fn security_boundary_matrix_rtc_csp_wildcard_is_scheme_and_subdomain_scoped() {
        let csp = "connect-src https://livekit-jwt.call.matrix.org wss://*.call.matrix.org";
        assert!(VoiceServiceStatus::connect_src_allows(
            csp,
            &["wss://livekit.call.matrix.org"],
        ));
        assert!(!VoiceServiceStatus::connect_src_allows(
            csp,
            &["wss://call.matrix.org"],
        ));
        assert!(!VoiceServiceStatus::connect_src_allows(
            csp,
            &["https://livekit.call.matrix.org"],
        ));
    }

    #[test]
    fn security_boundary_matrix_rtc_rejects_credentials_and_non_connect_src_origins() {
        let credentialed_url = ["https://operator:", "secret", "@rtc.example.org"].concat();
        let credentialed = VoiceServiceStatus::matrix_rtc(
            Some(credentialed_url),
            Some("wss://livekit.example.org".into()),
            "connect-src https://rtc.example.org wss://livekit.example.org",
        );
        assert_eq!(
            credentialed.availability,
            VoiceServiceAvailability::InvalidConfiguration
        );
        assert!(credentialed
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("must not contain credentials")));

        let wrong_directive = VoiceServiceStatus::matrix_rtc(
            Some("https://rtc.example.org".into()),
            Some("wss://livekit.example.org".into()),
            r#"{"app":{"security":{"csp":"connect-src ipc:; img-src https://rtc.example.org wss://livekit.example.org"}}}"#,
        );
        assert_eq!(
            wrong_directive.availability,
            VoiceServiceAvailability::InvalidConfiguration
        );
        assert!(!wrong_directive.csp_ready);
    }

    #[test]
    fn security_boundary_legacy_voice_is_explicitly_separate_from_matrix_rtc() {
        let status = VoiceServiceStatus::for_kind(BackendKind::LegacyP2p);
        assert_eq!(status.provider, VoiceProvider::LegacySimplePeer);
        assert_eq!(status.availability, VoiceServiceAvailability::Ready);
        assert!(!status.media_e2ee_ready);
    }

    #[test]
    fn sdk_errors_are_classified_before_crossing_ipc() {
        assert!(matches!(
            BackendError::from_sdk_error("M_LIMIT_EXCEEDED (status 429)"),
            BackendError::RateLimited(_)
        ));
        assert!(matches!(
            BackendError::from_sdk_error("M_FORBIDDEN"),
            BackendError::PermissionDenied(_)
        ));
        assert!(matches!(
            BackendError::from_sdk_error(
                "the server returned an error: [401] M_UNKNOWN_TOKEN: refresh token does not exist"
            ),
            BackendError::NotAuthenticated
        ));
        assert!(matches!(
            BackendError::from_sdk_error("failed to connect to homeserver"),
            BackendError::Network(_)
        ));
        assert!(matches!(
            BackendError::from_sdk_error("unrecognized response shape"),
            BackendError::Other(_)
        ));
        let verification =
            BackendError::from_sdk_error("Encryption failed because your device is not verified");
        assert!(matches!(verification, BackendError::Crypto(_)));
        assert!(verification.to_string().contains("Settings > Security"));
        assert!(!verification
            .to_string()
            .contains("your device is not verified"));
    }
}
