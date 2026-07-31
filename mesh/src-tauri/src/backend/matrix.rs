use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
    io::{Cursor, Read},
    path::{Component, Path, PathBuf},
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex, MutexGuard as StdMutexGuard, OnceLock, RwLock as StdRwLock,
    },
    time::{Duration, Instant, SystemTime},
};

use async_trait::async_trait;
use base64::{
    engine::general_purpose::{STANDARD_NO_PAD as BASE64_STANDARD, URL_SAFE_NO_PAD as BASE64},
    Engine as _,
};
use futures::StreamExt as _;
use matrix_sdk::{
    authentication::{
        matrix::MatrixSession,
        oauth::{ClientId, OAuthSession, UserSession},
        AuthApi, AuthSession,
    },
    config::SyncSettings,
    deserialized_responses::{AlgorithmInfo, EncryptionInfo, TimelineEventKind},
    encryption::{
        backups::BackupState,
        recovery::RecoveryState,
        verification::{
            QrVerification, QrVerificationState, SasState, SasVerification, Verification,
            VerificationRequest, VerificationRequestState,
        },
        BackupDownloadStrategy, EncryptionSettings,
    },
    notification_settings::RoomNotificationMode,
    room::{
        reply::{EnforceThread, Reply},
        MessagesOptions, ParentSpace, Receipts, RoomMemberRole,
    },
    ruma::{
        api::{
            auth_scheme::SendAccessToken,
            client::{
                account::{
                    get_username_availability, register::v3::Request as RegistrationRequest,
                    request_openid_token,
                },
                directory::get_public_rooms_filtered,
                discovery::get_authorization_server_metadata::v1::{
                    AuthorizationServerMetadata, CodeChallengeMethod, GrantType, ResponseMode,
                    ResponseType,
                },
                presence::set_presence::v3::Request as SetPresenceRequest,
                push::{delete_pushrule, get_pushrules_all, set_pushrule},
                receipt::create_receipt::v3::ReceiptType as MatrixReceiptType,
                room::{
                    create_room::{
                        v3::{CreationContent, Request as CreateRoomRequest, RoomPreset},
                        RoomPowerLevelsContentOverride,
                    },
                    Visibility,
                },
                rtc::{transports::v1::Request as MatrixRtcTransportsRequest, RtcTransport},
                session::get_login_types::v3::LoginType,
                state::{get_state_event_for_key, get_state_events, send_state_event},
                uiaa::{self, AuthData, AuthType, Dummy, RegistrationToken, UiaaInfo},
            },
            error::ErrorKind,
            Metadata, OutgoingRequest, SupportedVersions,
        },
        directory::{Filter, RoomTypeFilter},
        events::{
            call::member::{CallMemberStateKey, Focus, OriginalSyncCallMemberEvent},
            direct::{DirectEventContent, DirectUserIdentifier},
            ignored_user_list::{IgnoredUser, IgnoredUserListEventContent},
            image_pack::{PackImage, PackInfo, PackUsage, RoomImagePackEventContent},
            presence::PresenceEvent,
            reaction::ReactionEventContent,
            receipt::{ReceiptThread, ReceiptType},
            relation::Annotation,
            room::{
                create::RoomCreateEventContent,
                encryption::RoomEncryptionEventContent,
                join_rules::{AllowRule, JoinRule, RoomJoinRulesEventContent},
                message::{
                    AddMentions, FileInfo, FileMessageEventContent, MessageType,
                    OriginalSyncRoomMessageEvent, ReplacementMetadata, ReplyWithinThread,
                    RoomMessageEventContent, RoomMessageEventContentWithoutRelation,
                },
                pinned_events::{OriginalSyncRoomPinnedEventsEvent, RoomPinnedEventsEventContent},
                power_levels::OriginalSyncRoomPowerLevelsEvent,
                tombstone::RoomTombstoneEventContent,
                EncryptedFile, EncryptedFileHash, EncryptedFileHashAlgorithm, ImageInfo,
                MediaSource, ThumbnailInfo,
            },
            space::{
                child::{OriginalSyncSpaceChildEvent, SpaceChildEventContent},
                parent::SpaceParentEventContent,
            },
            typing::SyncTypingEvent,
            AnyGlobalAccountDataEventContent, AnyInitialStateEvent, AnyMessageLikeEventContent,
            AnyStateEvent, AnyStateEventContent, AnyToDeviceEvent, AnyToDeviceEventContent,
            GlobalAccountDataEventType, InitialStateEvent, Mentions, StateEvent, StateEventType,
        },
        int,
        presence::PresenceState,
        push::{
            Action, EventMatchConditionData, NewConditionalPushRule, NewPushRule,
            NewSimplePushRule, PredefinedUnderrideRuleId, PushCondition, RuleKind, Ruleset,
            SoundTweakValue, Tweak,
        },
        room::RoomType,
        serde::Raw,
        EventEncryptionAlgorithm, MxcUri, OwnedDeviceId, OwnedRoomAliasId, OwnedRoomId,
        OwnedServerName, OwnedTransactionId, OwnedUserId, RoomAliasId, RoomId, RoomOrAliasId,
        ServerName, UInt, UserId,
    },
    send_queue::{LocalEcho, LocalEchoContent, RoomSendQueueUpdate, SendQueueUpdate},
    store::RoomLoadSettings,
    utils::UrlOrQuery,
    Client, ComposerDraft, ComposerDraftType, LoopCtrl, Room, RoomMemberships, RoomState,
    SessionChange,
};
use matrix_sdk_crypto::{AttachmentDecryptor, CollectStrategy};
use qrcode::render::svg;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, Notify, RwLock, Semaphore};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroize;

use crate::crypto::keychain;
use crate::security::{create_private_dir, has_blocked_attachment_extension, open_private_file};
use crate::types::{
    community::{ChannelDto, CommunityDto},
    dm::{DirectMessageDto, DmConversationDto, ReadReceiptDto},
    message::{
        AttachmentDto, AttachmentThumbnailDto, MessageDto, UndecryptableMessageDto,
        UndecryptableMessageReason,
    },
};

use super::{
    BackendError, BackendKind, BackendResult, BackendStatus, CommunityAccessResult,
    CommunityAccessSettings, CommunityApplication, CommunityDirectoryEntry, CommunityMember,
    CommunityPermissionProjection, CreatedCommunity, CustomEmoji, MatrixAccount,
    MatrixAttachmentSendRequest, MatrixBackendEvent, MatrixBackendEventCallback, MatrixDevice,
    MatrixLogin, MatrixNotification, MatrixOidcAvailability, MatrixOidcStatus,
    MatrixPermissionStateChanged, MatrixPersonalDataExport, MatrixProfile,
    MatrixQueuedMessageState, MatrixQueuedMessageUpdate, MatrixRecoveryHealth, MatrixRegistration,
    MatrixRegistrationAvailability, MatrixRoomNotificationMode, MatrixRoomPins,
    MatrixRoomPinsUpdate, MatrixRoomUpgrade, MatrixRtcJoinResult, MatrixRtcMediaKey,
    MatrixRtcMediaKeyFailure, MatrixRtcMediaKeyLease, MatrixRtcMediaKeyPause, MatrixRtcMember,
    MatrixRtcMembershipUpdate, MatrixServiceCapabilities, MatrixTransferDirection,
    MatrixTransferObserver, MatrixTransferProgress, MatrixTransferProgressCallback,
    MatrixTransferResult, MatrixTransferRetryMode, MatrixTransferState, MatrixUnreadUpdate,
    MatrixVerificationSession, MeshBackend, ModerationAuditEntry, PendingInvitationMetadata,
    ReadReceiptMode, SentMessage, TypingUser, UserPreferences, VerificationEmoji,
    VoiceServiceAvailability, VoiceServiceStatus,
};

mod moderation;
mod oidc;
use moderation::MatrixModerationAction;
use oidc::configuration::{
    NativeOidcCapabilities, OidcClientRegistration, OidcClientRegistry, OidcRegistrationError,
    NATIVE_REDIRECT_URI,
};

const SESSION_KEY: &str = "matrix-session-v1";
const STORE_PASSPHRASE_KEY: &str = "matrix-store-passphrase-v1";
const ACCOUNT_REGISTRY_KEY: &str = "matrix-account-registry-v1";
const PENDING_INVITATION_KEY: &str = "matrix-pending-invitation-key-v1";
const PENDING_INVITATION_FILE: &str = "pending-invitation-v1.bin";
const PENDING_INVITATION_MAX_BYTES: usize = 8 * 1024;
const PENDING_INVITATION_MAX_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
const TRUSTED_DEVICES_KEY: &str = "matrix-trusted-devices-v1";
const RECOVERY_TEST_KEY: &str = "matrix-recovery-test-v1";
const PREFERENCES_EVENT_TYPE: &str = "org.mesh.preferences.v1";
const MAX_PINNED_EVENTS: usize = 100;
const COMMUNITY_HOMESERVER_ENV: &str = "MESH_COMMUNITY_HOMESERVER";
const COMMUNITY_SERVER_NAME_ENV: &str = "MESH_COMMUNITY_SERVER_NAME";
const LOGIN_TIMEOUT_SECONDS: u64 = 45;
const SESSION_RESTORE_SYNC_TIMEOUT_SECONDS: u64 = 10;
const REGISTRATION_TIMEOUT_SECONDS: u64 = 45;
const MAX_COMPOSER_DRAFT_BYTES: usize = 16 * 1024;
const CLIENT_REQUEST_ID_KEY: &str = "org.mesh.client_request_id";
const MAX_MEDIA_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_THUMBNAIL_SOURCE_PIXELS: u64 = 25_000_000;
const MAX_THUMBNAIL_SOURCE_DIMENSION: u32 = 16_384;
const MAX_THUMBNAIL_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_THUMBNAIL_DIMENSION: u32 = 512;
const MAX_THUMBNAIL_BYTES: usize = 2 * 1024 * 1024;
const MAX_INLINE_THUMBNAIL_DECODE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CONCURRENT_THUMBNAIL_LOADS: usize = 4;
const MAX_CONCURRENT_LIGHTBOX_IMAGE_LOADS: usize = 1;
const MEDIA_DOWNLOAD_PROGRESS_INTERVAL_BYTES: u64 = 1024 * 1024;
// A Content-Length hint is remote-claimed and unverified, so the initial
// allocation it sizes must stay modest regardless of what the header claims
// (a lying server can otherwise force a large up-front allocation per
// concurrent download). Real growth still happens via normal Vec
// reallocation as bytes actually arrive.
const MEDIA_DOWNLOAD_INITIAL_CAPACITY_BYTES: u64 = 1024 * 1024;
const MEDIA_DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
// A read/idle timeout, not a total-transfer timeout: it fires only when no
// bytes arrive for this long, so a large-but-healthy download near the byte
// cap isn't penalized for taking a while overall.
const MEDIA_DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(30);
const DIRECT_ACCOUNT_DATA_MERGE_ATTEMPTS: usize = 3;
const MATRIX_RTC_SLOT_ID: &str = "m.call#ROOM";
const MATRIX_RTC_TRANSPORTS_PATH: &str =
    "/_matrix/client/unstable/org.matrix.msc4143/rtc/transports";
const MATRIX_RTC_DISCOVERY_KEY: &str = "org.matrix.msc4143.rtc_foci";
const MATRIX_RTC_MEMBERSHIP_TTL: Duration = Duration::from_secs(120);
const MATRIX_RTC_MEMBERSHIP_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
const MATRIX_RTC_TOKEN_TIMEOUT: Duration = Duration::from_secs(15);
const MATRIX_RTC_TOKEN_RESPONSE_MAX_BYTES: usize = 64 * 1024;
const MATRIX_RTC_KEY_TO_DEVICE_EVENT_TYPE: &str = "io.element.call.encryption_keys";
const MATRIX_RTC_MEDIA_KEY_BYTES: usize = 16;
const MATRIX_RTC_KEY_MAX_AGE: Duration = Duration::from_secs(5 * 60);
const MATRIX_RTC_KEY_MAX_FUTURE_SKEW: Duration = Duration::from_secs(30);
const MATRIX_RTC_KEY_DISTRIBUTION_DELAY: Duration = Duration::from_secs(1);
const MATRIX_RTC_KEY_ACTIVATION_TTL: Duration = Duration::from_secs(30);
const MATRIX_RTC_KEY_LEASE_TTL: Duration = Duration::from_secs(3);
const MATRIX_RTC_COMPLETED_ACTIVATION_TTL: Duration = Duration::from_secs(60);
const MATRIX_SYNC_NORMAL_TIMEOUT: Duration = Duration::from_secs(30);
const MATRIX_RTC_SYNC_TIMEOUT: Duration = Duration::from_secs(1);
const MATRIX_SYNC_STATUS_FRESHNESS: Duration = Duration::from_secs(90);
const MATRIX_SYNC_RETRY_MAX_DELAY: Duration = Duration::from_secs(30);
// With a three-second renderer lease, accepting only a sync completion from
// the last two seconds bounds publication after the last successful `/sync`
// response to five seconds.
const MATRIX_RTC_SYNC_FRESHNESS: Duration = Duration::from_secs(2);
const MATRIX_RTC_MAX_PARTICIPANTS: usize = 256;
const MATRIX_RTC_MAX_INBOUND_PUBLISHERS: usize = 512;
const MATRIX_RTC_MAX_PENDING_KEYS: usize = 256;
const MATRIX_RTC_MAX_PENDING_ACTIVATIONS: usize = 64;
const MATRIX_RTC_MAX_TO_DEVICE_BYTES: usize = 16 * 1024;
const MATRIX_RTC_KEY_ATTEMPTS_PER_MINUTE: usize = 32;
const BLOCKED_MEDIA_CONTENT_TYPES: &[&str] = &[
    "application/x-msdownload",
    "application/x-msdos-program",
    "application/x-sh",
    "application/x-shellscript",
    "text/x-shellscript",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MatrixRtcDiscoverySource {
    AuthenticatedEndpoint,
    WellKnownFallback,
}

impl MatrixRtcDiscoverySource {
    fn label(self) -> &'static str {
        match self {
            Self::AuthenticatedEndpoint => "authenticated MSC4143 transport endpoint",
            Self::WellKnownFallback => ".well-known MatrixRTC fallback",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MatrixRtcDiscovery {
    service_url: String,
    source: MatrixRtcDiscoverySource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MatrixRtcEndpointFailure {
    /// The endpoint is not implemented. MSC4143 permits falling back to the
    /// unauthenticated client well-known in this case.
    FallbackToWellKnown,
    Unauthorized,
    RateLimited,
    Other,
}

struct GeneratedThumbnail {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
}

struct ResolvedMatrixThumbnail {
    metadata: AttachmentThumbnailDto,
    encrypted_file: EncryptedFile,
}

struct ResolvedMatrixAttachment {
    metadata: AttachmentDto,
    encrypted_file: EncryptedFile,
    thumbnail: Option<ResolvedMatrixThumbnail>,
}

/// Incremental view of a media transfer so the download cap can be enforced on
/// bytes as they arrive instead of on a finished buffer.
#[async_trait]
trait MediaChunkSource: Send {
    async fn next_chunk(&mut self) -> BackendResult<Option<Vec<u8>>>;
}

struct HttpMediaChunkSource(reqwest::Response);

#[async_trait]
impl MediaChunkSource for HttpMediaChunkSource {
    async fn next_chunk(&mut self) -> BackendResult<Option<Vec<u8>>> {
        Ok(self
            .0
            .chunk()
            .await
            .map_err(|error| BackendError::Network(error.to_string()))?
            .map(|chunk| chunk.to_vec()))
    }
}

#[derive(Clone)]
struct MatrixRtcLocalSession {
    room: Room,
    device_id: OwnedDeviceId,
    session_id: String,
    state_key: String,
    member_id: String,
    livekit_service_url: String,
    created_ts: matrix_sdk::ruma::MilliSecondsSinceUnixEpoch,
    cancellation: CancellationToken,
    ready: bool,
}

#[derive(Clone)]
struct ActiveMatrixRtcMembership {
    member: MatrixRtcMember,
    member_id: String,
    created_ts: matrix_sdk::ruma::MilliSecondsSinceUnixEpoch,
    livekit_service_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct MatrixRtcKeyParticipant {
    user_id: String,
    device_id: String,
    member_id: String,
}

struct MatrixRtcOutboundMediaKey {
    key_index: u8,
    key: [u8; MATRIX_RTC_MEDIA_KEY_BYTES],
    recipients: HashSet<MatrixRtcKeyParticipant>,
}

impl Drop for MatrixRtcOutboundMediaKey {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

struct MatrixRtcInboundMediaKey {
    key_index: u8,
    sent_ts: u64,
    key_digest: [u8; 32],
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MatrixRtcActivationPhase {
    AwaitingPauseAck,
    Distributed { sent_ts: u64 },
}

enum MatrixRtcLocalLeaseState {
    Active { key_index: u8 },
    Paused,
    Expired,
}

struct MatrixRtcPendingActivation {
    activation_id: String,
    room_id: String,
    session_id: String,
    member_id: String,
    key_index: u8,
    key: [u8; MATRIX_RTC_MEDIA_KEY_BYTES],
    recipients: HashSet<MatrixRtcKeyParticipant>,
    recipient_fingerprint: String,
    expires_at: u64,
    phase: MatrixRtcActivationPhase,
}

struct MatrixRtcPendingActivationSnapshot {
    activation_id: String,
    key_index: u8,
    key: [u8; MATRIX_RTC_MEDIA_KEY_BYTES],
    recipients: HashSet<MatrixRtcKeyParticipant>,
    recipient_fingerprint: String,
    expires_at: u64,
}

impl Drop for MatrixRtcPendingActivationSnapshot {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

impl Drop for MatrixRtcPendingActivation {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

struct MatrixRtcCompletedActivation {
    activation_id: String,
    member_id: String,
    key_index: u8,
    sent_ts: u64,
    completed_at: u64,
}

#[derive(Default)]
struct MatrixRtcMediaKeyRuntime {
    outbound: HashMap<(String, String), MatrixRtcOutboundMediaKey>,
    inbound: HashMap<(String, String, String, String), MatrixRtcInboundMediaKey>,
    pending: HashMap<String, Vec<MatrixRtcMediaKey>>,
    pending_activations: HashMap<(String, String), MatrixRtcPendingActivation>,
    completed_activations: HashMap<(String, String), MatrixRtcCompletedActivation>,
    lease_blocked: HashSet<(String, String)>,
    attempts: HashMap<(String, String), VecDeque<u64>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MatrixRtcMediaKeyEntry {
    index: u8,
    key: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MatrixRtcMediaKeyMember {
    claimed_device_id: String,
    id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MatrixRtcMediaKeySession {
    application: String,
    call_id: String,
    scope: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MatrixRtcToDeviceKeyContent {
    keys: MatrixRtcMediaKeyEntry,
    room_id: String,
    member: MatrixRtcMediaKeyMember,
    session: MatrixRtcMediaKeySession,
    sent_ts: u64,
}

#[derive(Deserialize)]
struct MatrixRtcToDeviceEnvelope {
    #[serde(rename = "type")]
    event_type: String,
    sender: String,
    content: MatrixRtcToDeviceKeyContent,
}

#[derive(Serialize)]
struct MatrixRtcOpenIdToken {
    access_token: String,
    token_type: String,
    matrix_server_name: String,
    expires_in: u64,
}

#[derive(Serialize)]
struct MatrixRtcTokenMember {
    id: String,
    claimed_user_id: String,
    claimed_device_id: String,
}

#[derive(Serialize)]
struct MatrixRtcTokenRequest {
    room_id: String,
    slot_id: String,
    openid_token: MatrixRtcOpenIdToken,
    member: MatrixRtcTokenMember,
}

#[derive(Deserialize)]
struct MatrixRtcTokenResponse {
    url: String,
    jwt: String,
}

#[derive(Serialize)]
struct MatrixRtcSessionEventContent {
    application: String,
    call_id: String,
    scope: String,
    device_id: String,
    #[serde(rename = "membershipID")]
    membership_id: String,
    expires: u64,
    created_ts: u64,
    focus_active: MatrixRtcActiveFocus,
    foci_preferred: Vec<MatrixRtcPreferredFocus>,
    #[serde(rename = "m.call.intent")]
    call_intent: String,
}

#[derive(Serialize)]
struct MatrixRtcActiveFocus {
    #[serde(rename = "type")]
    focus_type: String,
    focus_selection: String,
}

#[derive(Serialize)]
struct MatrixRtcPreferredFocus {
    #[serde(rename = "type")]
    focus_type: String,
    livekit_service_url: String,
}

#[derive(Serialize, Deserialize)]
struct PersistedSession {
    homeserver: String,
    authentication: PersistedAuthentication,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum PersistedAuthentication {
    Password {
        session: MatrixSession,
    },
    OAuth {
        client_id: String,
        user: UserSession,
    },
}

#[derive(Deserialize)]
struct LegacyPersistedSession {
    homeserver: String,
    session: MatrixSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingInvitationRecord {
    invite_link: String,
    metadata: PendingInvitationMetadata,
}

impl PersistedAuthentication {
    fn into_sdk_session(self) -> AuthSession {
        match self {
            Self::Password { session } => session.into(),
            Self::OAuth { client_id, user } => OAuthSession {
                client_id: ClientId::new(client_id),
                user,
            }
            .into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedAccount {
    profile_id: String,
    user_id: String,
    homeserver: String,
    device_id: String,
    last_used_at: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountRegistry {
    active_profile_id: Option<String>,
    accounts: Vec<SavedAccount>,
}

#[derive(Debug, Clone)]
struct AccountStorage {
    profile_id: String,
    store_root: PathBuf,
    key_namespace: String,
}

#[derive(Debug)]
struct LocalAccountRemovalPlan {
    profile_id: String,
    store_root: PathBuf,
    key_names: [String; 4],
}

struct LoginAttempt {
    id: u64,
    cancellation: CancellationToken,
}

// The SDK owns the room-key sharing decision. This registry is only the
// keychain-backed identity-change signal shown in the device UI; it must not
// become a second, weaker crypto trust policy.
#[derive(Default, Serialize, Deserialize)]
struct TrustedDeviceRegistry {
    fingerprints: HashMap<String, String>,
}

#[derive(Clone)]
enum DeviceVerificationFlow {
    Request {
        request: VerificationRequest,
        device_id: String,
    },
    Sas(SasVerification),
    Qr(QrVerification),
}

#[derive(Default)]
struct MatrixRuntime {
    client: Option<Client>,
    homeserver: Option<String>,
    profile_id: Option<String>,
    session_task: Option<JoinHandle<()>>,
    room_updates_task: Option<JoinHandle<()>>,
    send_queue_task: Option<JoinHandle<()>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum MatrixSyncCadence {
    #[default]
    Normal,
    ActiveCall,
}

impl MatrixSyncCadence {
    fn timeout(self) -> Duration {
        match self {
            Self::Normal => MATRIX_SYNC_NORMAL_TIMEOUT,
            Self::ActiveCall => MATRIX_RTC_SYNC_TIMEOUT,
        }
    }
}

struct MatrixSyncControl {
    client: Option<Client>,
    task: Option<JoinHandle<()>>,
    cadence: MatrixSyncCadence,
    presence: PresenceState,
    paused: bool,
    send_queue_reconcile: Option<Arc<Notify>>,
}

impl Default for MatrixSyncControl {
    fn default() -> Self {
        Self {
            client: None,
            task: None,
            cadence: MatrixSyncCadence::Normal,
            presence: PresenceState::Offline,
            paused: false,
            send_queue_reconcile: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct WirePrivacyPreferences {
    read_receipt_mode: ReadReceiptMode,
    send_typing_indicators: bool,
    share_presence: bool,
    invisible_mode: bool,
}

impl From<&UserPreferences> for WirePrivacyPreferences {
    fn from(preferences: &UserPreferences) -> Self {
        Self {
            read_receipt_mode: preferences.effective_read_receipt_mode(),
            send_typing_indicators: preferences.send_typing_indicators,
            share_presence: preferences.share_presence,
            invisible_mode: preferences.invisible_mode,
        }
    }
}

impl WirePrivacyPreferences {
    fn presence(self) -> PresenceState {
        if self.share_presence && !self.invisible_mode {
            PresenceState::Online
        } else {
            PresenceState::Offline
        }
    }

    fn should_send_typing_notice(self, already_sent: bool, typing: bool) -> bool {
        (typing && self.send_typing_indicators) || (!typing && already_sent)
    }
}

#[derive(Default)]
struct MatrixSyncFreshness {
    epoch: u64,
    last_success_ms: u64,
}

#[derive(Clone)]
struct MatrixSyncCoordinator {
    control: Arc<Mutex<MatrixSyncControl>>,
    freshness: Arc<StdMutex<MatrixSyncFreshness>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CommunityHomeserverConfig {
    homeserver: String,
    server_name: OwnedServerName,
}

/// Production Matrix implementation backed by matrix-rust-sdk.
///
/// The SDK owns room state, timeline deduplication, Olm/Megolm, and its
/// encrypted SQLite stores. Mesh only translates those capabilities into the
/// product's typed IPC/domain model.
pub struct MatrixBackend {
    store_root: PathBuf,
    profile_hint: String,
    dynamic_accounts: bool,
    runtime: RwLock<MatrixRuntime>,
    login_attempt: Mutex<Option<LoginAttempt>>,
    login_sequence: AtomicU64,
    verification_sessions: RwLock<HashMap<String, DeviceVerificationFlow>>,
    media_uploads: Mutex<HashMap<String, CancellationToken>>,
    media_downloads: Mutex<HashMap<String, CancellationToken>>,
    custom_emoji_writes: Mutex<()>,
    verified_room_upgrades: RwLock<HashMap<OwnedRoomId, OwnedRoomId>>,
    send_queue_gate: Arc<Mutex<()>>,
    send_queue_reconcile: Arc<Notify>,
    send_queue_known: Arc<Mutex<HashMap<String, HashSet<String>>>>,
    pending_invitation_gate: Arc<Mutex<()>>,
    thumbnail_loads: Semaphore,
    lightbox_image_loads: Semaphore,
    rtc_sessions: Arc<Mutex<HashMap<(String, String), MatrixRtcLocalSession>>>,
    rtc_media_keys: Arc<Mutex<MatrixRtcMediaKeyRuntime>>,
    rtc_membership_writes: Arc<Mutex<()>>,
    matrix_sync_freshness: Arc<StdMutex<MatrixSyncFreshness>>,
    matrix_sync_control: Arc<Mutex<MatrixSyncControl>>,
    wire_privacy: Arc<RwLock<WirePrivacyPreferences>>,
    sent_typing_notices: Mutex<HashSet<String>>,
    typing_users: Arc<RwLock<HashMap<String, Vec<String>>>>,
    presence: Arc<RwLock<HashMap<String, String>>>,
    event_callback: Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
}

include!("matrix/messages.rs");
include!("matrix/rtc.rs");
include!("matrix/encryption.rs");
include!("matrix/attachments.rs");
include!("matrix/admission.rs");
include!("matrix/rooms.rs");
include!("matrix/dm.rs");
include!("matrix/emoji.rs");
include!("matrix/personal_data.rs");

impl MatrixBackend {
    pub fn new(store_root: PathBuf) -> Self {
        Self {
            store_root,
            profile_hint: "default".into(),
            dynamic_accounts: true,
            runtime: RwLock::new(MatrixRuntime::default()),
            login_attempt: Mutex::new(None),
            login_sequence: AtomicU64::new(0),
            verification_sessions: RwLock::new(HashMap::new()),
            media_uploads: Mutex::new(HashMap::new()),
            media_downloads: Mutex::new(HashMap::new()),
            custom_emoji_writes: Mutex::new(()),
            verified_room_upgrades: RwLock::new(HashMap::new()),
            send_queue_gate: Arc::new(Mutex::new(())),
            send_queue_reconcile: Arc::new(Notify::new()),
            send_queue_known: Arc::new(Mutex::new(HashMap::new())),
            pending_invitation_gate: Arc::new(Mutex::new(())),
            thumbnail_loads: Semaphore::new(MAX_CONCURRENT_THUMBNAIL_LOADS),
            lightbox_image_loads: Semaphore::new(MAX_CONCURRENT_LIGHTBOX_IMAGE_LOADS),
            rtc_sessions: Arc::new(Mutex::new(HashMap::new())),
            rtc_media_keys: Arc::new(Mutex::new(MatrixRtcMediaKeyRuntime::default())),
            rtc_membership_writes: Arc::new(Mutex::new(())),
            matrix_sync_freshness: Arc::new(StdMutex::new(MatrixSyncFreshness::default())),
            matrix_sync_control: Arc::new(Mutex::new(MatrixSyncControl::default())),
            wire_privacy: Arc::new(RwLock::new(WirePrivacyPreferences::default())),
            sent_typing_notices: Mutex::new(HashSet::new()),
            typing_users: Arc::new(RwLock::new(HashMap::new())),
            presence: Arc::new(RwLock::new(HashMap::new())),
            event_callback: Arc::new(StdRwLock::new(None)),
        }
    }

    /// Construct an isolated backend profile. Production uses `default`; the
    /// federation harness uses separate profiles to model distinct devices.
    pub fn with_profile(store_root: PathBuf, profile: impl Into<String>) -> Self {
        let profile = profile.into();
        let key_namespace: String = profile
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || character == '-' {
                    character
                } else {
                    '_'
                }
            })
            .collect();
        Self {
            store_root,
            profile_hint: key_namespace,
            dynamic_accounts: false,
            runtime: RwLock::new(MatrixRuntime::default()),
            login_attempt: Mutex::new(None),
            login_sequence: AtomicU64::new(0),
            verification_sessions: RwLock::new(HashMap::new()),
            media_uploads: Mutex::new(HashMap::new()),
            media_downloads: Mutex::new(HashMap::new()),
            custom_emoji_writes: Mutex::new(()),
            verified_room_upgrades: RwLock::new(HashMap::new()),
            send_queue_gate: Arc::new(Mutex::new(())),
            send_queue_reconcile: Arc::new(Notify::new()),
            send_queue_known: Arc::new(Mutex::new(HashMap::new())),
            pending_invitation_gate: Arc::new(Mutex::new(())),
            thumbnail_loads: Semaphore::new(MAX_CONCURRENT_THUMBNAIL_LOADS),
            lightbox_image_loads: Semaphore::new(MAX_CONCURRENT_LIGHTBOX_IMAGE_LOADS),
            rtc_sessions: Arc::new(Mutex::new(HashMap::new())),
            rtc_media_keys: Arc::new(Mutex::new(MatrixRtcMediaKeyRuntime::default())),
            rtc_membership_writes: Arc::new(Mutex::new(())),
            matrix_sync_freshness: Arc::new(StdMutex::new(MatrixSyncFreshness::default())),
            matrix_sync_control: Arc::new(Mutex::new(MatrixSyncControl::default())),
            wire_privacy: Arc::new(RwLock::new(WirePrivacyPreferences::default())),
            sent_typing_notices: Mutex::new(HashSet::new()),
            typing_users: Arc::new(RwLock::new(HashMap::new())),
            presence: Arc::new(RwLock::new(HashMap::new())),
            event_callback: Arc::new(StdRwLock::new(None)),
        }
    }

    fn storage_for_profile(&self, profile_id: &str) -> AccountStorage {
        if !self.dynamic_accounts || profile_id == "default" {
            AccountStorage {
                profile_id: profile_id.to_owned(),
                store_root: self.store_root.clone(),
                key_namespace: self.profile_hint.clone(),
            }
        } else {
            AccountStorage {
                profile_id: profile_id.to_owned(),
                store_root: self.store_root.join("accounts").join(profile_id),
                key_namespace: profile_id.to_owned(),
            }
        }
    }

    fn pending_invitation_key(storage: &AccountStorage) -> String {
        format!("{PENDING_INVITATION_KEY}-{}", storage.key_namespace)
    }

    fn pending_invitation_path(storage: &AccountStorage) -> PathBuf {
        storage.store_root.join(PENDING_INVITATION_FILE)
    }

    async fn pending_invitation_storages(&self) -> Vec<AccountStorage> {
        let preferred = match self.runtime.read().await.profile_id.clone() {
            Some(profile_id) => self.storage_for_profile(&profile_id),
            None => self
                .active_storage_from_registry()
                .unwrap_or_else(|_| self.storage_for_profile("default")),
        };
        let default = self.storage_for_profile("default");
        if preferred.store_root == default.store_root {
            vec![preferred]
        } else {
            vec![preferred, default]
        }
    }

    fn pending_invitation_now_ms() -> u64 {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0)
    }

    fn pending_invitation_expired(metadata: &PendingInvitationMetadata, now_ms: u64) -> bool {
        now_ms >= metadata.expires_at
    }

    fn pending_invitation_metadata(invite_link: &str, stored_at: u64) -> PendingInvitationMetadata {
        let mut room_or_alias = None;
        let mut service = None;
        let mut admission_service = None;
        let mut via = Vec::new();

        if let Ok(url) = url::Url::parse(invite_link) {
            for (key, value) in url.query_pairs() {
                match key.as_ref() {
                    "room" => room_or_alias = Some(value.into_owned()),
                    "service" | "community_service" => {
                        if service.is_none() {
                            service = Some(value.into_owned());
                        }
                    }
                    "admission" => admission_service = Some(value.into_owned()),
                    "via" => {
                        for server in value
                            .split(',')
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                        {
                            if !via.iter().any(|existing| existing == server) && via.len() < 3 {
                                via.push(server.to_owned());
                            }
                        }
                    }
                    _ => {}
                }
            }

            if admission_service.is_none()
                && url.path().starts_with("/invite/")
                && matches!(url.scheme(), "https" | "http")
            {
                admission_service = url.host_str().map(|_| url.origin().ascii_serialization());
            }
        }

        PendingInvitationMetadata {
            // The renderer needs only an opaque identity token. Do not derive
            // it from the invitation, because even a truncated digest would
            // give the renderer an offline oracle for low-entropy links.
            handle: uuid::Uuid::new_v4().to_string(),
            room_or_alias,
            via,
            community_service_display_name: service
                .as_deref()
                .and_then(Self::invitation_service_display_name),
            service,
            admission_service,
            community_name: None,
            inviter_display_name: None,
            inviter_user_id: None,
            join_rule: None,
            stored_at,
            expires_at: stored_at.saturating_add(PENDING_INVITATION_MAX_AGE_MS),
        }
    }

    fn invitation_service_display_name(service: &str) -> Option<String> {
        let service = service.trim().trim_end_matches('/');
        if service.is_empty() {
            return None;
        }
        if let Ok(url) = url::Url::parse(service) {
            return url.host_str().map(str::to_owned);
        }
        Some(service.to_owned())
    }

    async fn enrich_pending_invitation_metadata(
        &self,
        mut metadata: PendingInvitationMetadata,
    ) -> PendingInvitationMetadata {
        if metadata.community_service_display_name.is_none() {
            metadata.community_service_display_name = metadata
                .service
                .as_deref()
                .and_then(Self::invitation_service_display_name);
        }
        let Some(room_id) = metadata
            .room_or_alias
            .as_deref()
            .and_then(|value| matrix_sdk::ruma::RoomId::parse(value).ok())
        else {
            return metadata;
        };
        let Ok(client) = self.client().await else {
            return metadata;
        };
        let Some(room) = Self::prejoin_invited_room_if_available(&client, &room_id) else {
            return metadata;
        };

        if metadata.community_name.is_none() {
            metadata.community_name = room
                .display_name()
                .await
                .ok()
                .map(|name| name.to_string())
                .filter(|name| !name.trim().is_empty());
        }
        if metadata.join_rule.is_none() {
            metadata.join_rule = room.join_rule().map(|rule| rule.as_str().to_owned());
        }
        if metadata.inviter_user_id.is_none() || metadata.inviter_display_name.is_none() {
            if let Ok(invite) = room.invite_details().await {
                if metadata.inviter_user_id.is_none() {
                    metadata.inviter_user_id = Some(invite.inviter_id.to_string());
                }
                if metadata.inviter_display_name.is_none() {
                    metadata.inviter_display_name =
                        invite.inviter.map(|member| member.name().to_owned());
                }
            }
        }
        metadata
    }

    async fn enrich_community_admission(
        &self,
        mut admission: super::MatrixCommunityAdmission,
    ) -> super::MatrixCommunityAdmission {
        let metadata = self
            .enrich_pending_invitation_metadata(PendingInvitationMetadata {
                handle: String::new(),
                room_or_alias: Some(admission.room_id.clone()),
                via: admission.via.clone(),
                service: Some(admission.service.clone()),
                admission_service: None,
                community_name: admission.community_name.take(),
                inviter_display_name: admission.inviter_display_name.take(),
                inviter_user_id: admission.inviter_user_id.take(),
                join_rule: admission.join_rule.take(),
                community_service_display_name: admission.community_service_display_name.take(),
                stored_at: 0,
                expires_at: admission.expires_at.unwrap_or_default(),
            })
            .await;
        admission.community_name = metadata.community_name;
        admission.inviter_display_name = metadata.inviter_display_name;
        admission.inviter_user_id = metadata.inviter_user_id;
        admission.join_rule = metadata.join_rule;
        admission.community_service_display_name = metadata.community_service_display_name;
        admission
    }

    fn load_or_create_pending_invitation_key(storage: &AccountStorage) -> BackendResult<[u8; 32]> {
        let key_name = Self::pending_invitation_key(storage);
        match keychain::lookup_secret(&key_name).map_err(Self::map_secure_storage_error)? {
            keychain::SecretLookup::Found(bytes) => bytes.try_into().map_err(|_| {
                BackendError::Crypto("pending invitation secure-storage key is invalid".into())
            }),
            keychain::SecretLookup::Missing => {
                let mut key = [0_u8; 32];
                rand::thread_rng().fill_bytes(&mut key);
                keychain::store_secret(&key_name, &key).map_err(Self::map_secure_storage_error)?;
                Ok(key)
            }
        }
    }

    async fn read_pending_invitation_record(
        &self,
        storage: &AccountStorage,
    ) -> BackendResult<Option<PendingInvitationRecord>> {
        let path = Self::pending_invitation_path(storage);
        let ciphertext = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(BackendError::Crypto(format!(
                    "could not read the pending invitation store: {error}"
                )))
            }
        };
        let mut key = Self::load_or_create_pending_invitation_key(storage)?;
        let plaintext = crate::crypto::encryption::decrypt_community_payload(
            &key,
            &ciphertext,
            b"mesh-pending-invitation-v1",
        )
        .map_err(|_| BackendError::Crypto("pending invitation store could not be opened".into()));
        key.zeroize();
        let plaintext = plaintext?;
        serde_json::from_slice(&plaintext)
            .map(Some)
            .map_err(|_| BackendError::Crypto("pending invitation store is invalid".into()))
    }

    async fn write_pending_invitation_record(
        &self,
        storage: &AccountStorage,
        record: &PendingInvitationRecord,
    ) -> BackendResult<()> {
        let plaintext = serde_json::to_vec(record).map_err(|_| {
            BackendError::Serialization("pending invitation could not be encoded".into())
        })?;
        if plaintext.len() > PENDING_INVITATION_MAX_BYTES {
            return Err(BackendError::InvalidConfiguration(
                "pending invitation is too large".into(),
            ));
        }
        let mut key = Self::load_or_create_pending_invitation_key(storage)?;
        let ciphertext = crate::crypto::encryption::encrypt_community_payload(
            &key,
            &plaintext,
            b"mesh-pending-invitation-v1",
        )
        .map_err(|_| BackendError::Crypto("pending invitation could not be protected".into()));
        key.zeroize();
        let ciphertext = ciphertext?;

        create_private_dir(&storage.store_root, true)
            .await
            .map_err(|error| {
                BackendError::Crypto(format!(
                    "could not prepare the pending invitation store: {error}"
                ))
            })?;
        let path = Self::pending_invitation_path(storage);
        let temporary_path = storage.store_root.join(format!(
            "{PENDING_INVITATION_FILE}.tmp-{}",
            uuid::Uuid::new_v4()
        ));
        let mut file = open_private_file(&temporary_path, true)
            .await
            .map_err(|error| {
                BackendError::Crypto(format!(
                    "could not write the pending invitation store: {error}"
                ))
            })?;
        file.write_all(&ciphertext).await.map_err(|error| {
            BackendError::Crypto(format!(
                "could not write the pending invitation store: {error}"
            ))
        })?;
        file.flush().await.map_err(|error| {
            BackendError::Crypto(format!(
                "could not flush the pending invitation store: {error}"
            ))
        })?;
        drop(file);

        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                let _ = tokio::fs::remove_file(&temporary_path).await;
                return Err(BackendError::Crypto(format!(
                    "could not replace the pending invitation store: {error}"
                )));
            }
        }
        if let Err(error) = tokio::fs::rename(&temporary_path, &path).await {
            let _ = tokio::fs::remove_file(&temporary_path).await;
            return Err(BackendError::Crypto(format!(
                "could not replace the pending invitation store: {error}"
            )));
        }
        Ok(())
    }

    async fn remove_pending_invitation_record(storage: &AccountStorage) -> BackendResult<()> {
        let path = Self::pending_invitation_path(storage);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(BackendError::Crypto(format!(
                    "could not clear the pending invitation store: {error}"
                )))
            }
        }
        let key_name = Self::pending_invitation_key(storage);
        if keychain::try_secret_exists(&key_name).map_err(Self::map_secure_storage_error)? {
            keychain::delete_secret(&key_name).map_err(Self::map_secure_storage_error)?;
        }
        Ok(())
    }

    async fn clear_pending_invitation_records(&self) -> BackendResult<()> {
        for storage in self.pending_invitation_storages().await {
            Self::remove_pending_invitation_record(&storage).await?;
        }
        Ok(())
    }

    async fn find_pending_invitation_record(
        &self,
    ) -> BackendResult<Option<(AccountStorage, PendingInvitationRecord)>> {
        for storage in self.pending_invitation_storages().await {
            if let Some(record) = self.read_pending_invitation_record(&storage).await? {
                return Ok(Some((storage, record)));
            }
        }
        Ok(None)
    }

    fn profile_id(homeserver: &str, username: &str) -> String {
        let username = username.trim();
        let account_name = username
            .strip_prefix('@')
            .unwrap_or(username)
            .split_once(':')
            .map(|(localpart, _)| localpart)
            .unwrap_or_else(|| username.strip_prefix('@').unwrap_or(username));
        let digest = Sha256::digest(
            format!(
                "{}\n{}",
                homeserver.to_ascii_lowercase(),
                account_name.to_ascii_lowercase()
            )
            .as_bytes(),
        );
        digest[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn session_key(storage: &AccountStorage) -> String {
        format!("{SESSION_KEY}-{}", storage.key_namespace)
    }

    fn store_passphrase_key(storage: &AccountStorage) -> String {
        format!("{STORE_PASSPHRASE_KEY}-{}", storage.key_namespace)
    }

    fn trusted_devices_key(storage: &AccountStorage) -> String {
        format!("{TRUSTED_DEVICES_KEY}-{}", storage.key_namespace)
    }

    fn recovery_test_key(storage: &AccountStorage) -> String {
        format!("{RECOVERY_TEST_KEY}-{}", storage.key_namespace)
    }

    fn load_trusted_devices(storage: &AccountStorage) -> BackendResult<TrustedDeviceRegistry> {
        let key = Self::trusted_devices_key(storage);
        match keychain::lookup_secret(&key).map_err(Self::map_secure_storage_error)? {
            keychain::SecretLookup::Found(serialized) => {
                serde_json::from_slice(&serialized).map_err(Self::map_error)
            }
            keychain::SecretLookup::Missing => Ok(TrustedDeviceRegistry::default()),
        }
    }

    fn persist_trusted_devices(
        storage: &AccountStorage,
        devices: &TrustedDeviceRegistry,
    ) -> BackendResult<()> {
        let serialized = serde_json::to_vec(devices).map_err(Self::map_error)?;
        keychain::store_secret(&Self::trusted_devices_key(storage), &serialized)
            .map_err(Self::map_secure_storage_error)
    }

    fn device_fingerprint(
        device: &matrix_sdk::encryption::identities::Device,
    ) -> BackendResult<String> {
        let mut digest = Sha256::new();
        for (key_id, key) in device.keys() {
            digest.update(key_id.as_str().as_bytes());
            digest.update(b"=");
            digest.update(key.to_base64().as_bytes());
            digest.update(b"\n");
        }
        Ok(format!("{:x}", digest.finalize()))
    }

    fn load_last_recovery_test(storage: &AccountStorage) -> BackendResult<Option<String>> {
        let key = Self::recovery_test_key(storage);
        match keychain::lookup_secret(&key).map_err(Self::map_secure_storage_error)? {
            keychain::SecretLookup::Found(bytes) => {
                String::from_utf8(bytes).map(Some).map_err(Self::map_error)
            }
            keychain::SecretLookup::Missing => Ok(None),
        }
    }

    fn persist_last_recovery_test(storage: &AccountStorage, tested_at: &str) -> BackendResult<()> {
        keychain::store_secret(&Self::recovery_test_key(storage), tested_at.as_bytes())
            .map_err(Self::map_secure_storage_error)
    }

    fn account_registry_key(&self) -> String {
        if self.dynamic_accounts {
            ACCOUNT_REGISTRY_KEY.to_owned()
        } else {
            format!("{ACCOUNT_REGISTRY_KEY}-{}", self.profile_hint)
        }
    }

    fn load_registry_if_present(&self) -> BackendResult<Option<AccountRegistry>> {
        let key = self.account_registry_key();
        match keychain::lookup_secret(&key).map_err(Self::map_secure_storage_error)? {
            keychain::SecretLookup::Found(serialized) => serde_json::from_slice(&serialized)
                .map(Some)
                .map_err(Self::map_error),
            keychain::SecretLookup::Missing => Ok(None),
        }
    }

    fn load_registry(&self) -> BackendResult<AccountRegistry> {
        Ok(self.load_registry_if_present()?.unwrap_or_default())
    }

    fn persist_registry(&self, registry: &AccountRegistry) -> BackendResult<()> {
        let serialized = serde_json::to_vec(registry).map_err(Self::map_error)?;
        keychain::store_secret(&self.account_registry_key(), &serialized)
            .map_err(Self::map_secure_storage_error)
    }

    fn remember_account(
        &self,
        storage: &AccountStorage,
        homeserver: &str,
        session: &MatrixSession,
    ) -> BackendResult<()> {
        self.register_account_identity(
            storage,
            homeserver,
            session.meta.user_id.as_str(),
            session.meta.device_id.as_str(),
        )
    }

    fn register_account_identity(
        &self,
        storage: &AccountStorage,
        homeserver: &str,
        user_id: &str,
        device_id: &str,
    ) -> BackendResult<()> {
        let mut registry = self.load_registry()?;
        let saved = SavedAccount {
            profile_id: storage.profile_id.clone(),
            user_id: user_id.to_owned(),
            homeserver: homeserver.to_owned(),
            device_id: device_id.to_owned(),
            last_used_at: chrono::Utc::now().to_rfc3339(),
        };
        registry
            .accounts
            .retain(|account| account.profile_id != storage.profile_id);
        registry.accounts.push(saved);
        registry.active_profile_id = Some(storage.profile_id.clone());
        self.persist_registry(&registry)
    }

    fn active_storage_from_registry(&self) -> BackendResult<AccountStorage> {
        match self.load_registry_if_present()? {
            Some(registry) => match registry.active_profile_id.as_deref() {
                Some(profile_id) => Ok(self.storage_for_profile(profile_id)),
                None => Err(BackendError::NotAuthenticated),
            },
            None => Ok(self.storage_for_profile("default")),
        }
    }

    fn normalize_homeserver_input(input: &str) -> BackendResult<String> {
        let input = input.trim();
        if input.is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "homeserver or Matrix server name is required".into(),
            ));
        }

        if !input.contains("://") {
            let candidate = format!("http://{input}");
            if let Ok(url) = url::Url::parse(&candidate) {
                let is_loopback = url.host_str().is_some_and(|host| {
                    let unbracketed = host.trim_matches(&['[', ']'][..]);
                    unbracketed.eq_ignore_ascii_case("localhost")
                        || unbracketed
                            .parse::<std::net::IpAddr>()
                            .is_ok_and(|address| address.is_loopback())
                });
                if is_loopback
                    && url.path() == "/"
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && url.username().is_empty()
                    && url.password().is_none()
                {
                    return Ok(candidate);
                }
            }
        }

        if input.contains("://") {
            let url = url::Url::parse(input).map_err(|error| {
                BackendError::InvalidConfiguration(format!("invalid homeserver URL: {error}"))
            })?;
            let host = url.host_str().ok_or_else(|| {
                BackendError::InvalidConfiguration("homeserver URL has no host".into())
            })?;
            let is_loopback = host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback());
            if url.scheme() != "https" && !(url.scheme() == "http" && is_loopback) {
                return Err(BackendError::InvalidConfiguration(
                    "homeserver must use HTTPS (HTTP is allowed only for loopback development)"
                        .into(),
                ));
            }
            if !url.username().is_empty() || url.password().is_some() {
                return Err(BackendError::InvalidConfiguration(
                    "homeserver URL must not contain credentials".into(),
                ));
            }
        } else {
            ServerName::parse(input).map_err(|error| {
                BackendError::InvalidConfiguration(format!("invalid Matrix server name: {error}"))
            })?;
        }

        Ok(input.to_owned())
    }

    fn normalize_report_reason(reason: String) -> BackendResult<String> {
        let reason = reason.split_whitespace().collect::<Vec<_>>().join(" ");
        let character_count = reason.chars().count();
        if character_count == 0 || character_count > 500 || reason.chars().any(char::is_control) {
            return Err(BackendError::InvalidConfiguration(
                "report reason must contain 1 to 500 visible characters".into(),
            ));
        }
        Ok(reason)
    }

    fn community_homeserver_config_from(
        homeserver: Option<&str>,
        server_name: Option<&str>,
    ) -> BackendResult<CommunityHomeserverConfig> {
        let homeserver = homeserver
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(BackendError::CommunityHomeserverUnconfigured)?;
        let homeserver = Self::normalize_homeserver_input(homeserver)?;

        let derived_server_name = if let Some(server_name) =
            server_name.map(str::trim).filter(|value| !value.is_empty())
        {
            server_name.to_owned()
        } else if homeserver.contains("://") {
            let url = url::Url::parse(&homeserver).map_err(|error| {
                BackendError::InvalidConfiguration(format!(
                    "invalid community homeserver URL: {error}"
                ))
            })?;
            let host = url.host_str().ok_or_else(|| {
                BackendError::InvalidConfiguration(
                    "community homeserver URL has no server name".into(),
                )
            })?;
            let mut derived = if host.contains(':') {
                format!("[{host}]")
            } else {
                host.to_owned()
            };
            if let Some(port) = url.port() {
                derived.push(':');
                derived.push_str(&port.to_string());
            }
            derived
        } else {
            homeserver.clone()
        };

        let server_name = ServerName::parse(derived_server_name).map_err(|error| {
            BackendError::InvalidConfiguration(format!(
                "invalid managed Matrix server name: {error}"
            ))
        })?;
        Ok(CommunityHomeserverConfig {
            homeserver,
            server_name,
        })
    }

    fn community_homeserver_config() -> BackendResult<CommunityHomeserverConfig> {
        let homeserver = std::env::var(COMMUNITY_HOMESERVER_ENV).ok();
        let server_name = std::env::var(COMMUNITY_SERVER_NAME_ENV).ok();
        Self::community_homeserver_config_from(homeserver.as_deref(), server_name.as_deref())
    }

    fn normalize_product_username(input: &str) -> BackendResult<String> {
        let username = input.trim().to_ascii_lowercase();
        if username.starts_with('@') || username.contains(':') {
            return Err(BackendError::InvalidConfiguration(
                "enter only a username, not a full account address".into(),
            ));
        }
        if !(3..=32).contains(&username.len()) {
            return Err(BackendError::InvalidConfiguration(
                "username must be between 3 and 32 characters".into(),
            ));
        }
        if !username
            .bytes()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
            || !username.bytes().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, b'.' | b'_' | b'-')
            })
        {
            return Err(BackendError::InvalidConfiguration(
                "username must start with a letter or number and use only letters, numbers, dots, dashes, or underscores"
                    .into(),
            ));
        }
        Ok(username)
    }

    fn normalize_registration_token(input: Option<String>) -> BackendResult<Option<String>> {
        let Some(input) = input else {
            return Ok(None);
        };
        let token = input.trim();
        if token.is_empty() {
            return Ok(None);
        }
        if token.len() > 64
            || !token.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-')
            })
        {
            return Err(BackendError::InvalidConfiguration(
                "the Mesh invitation code has an invalid format".into(),
            ));
        }
        Ok(Some(token.to_owned()))
    }

    fn normalize_public_link_slug(input: &str) -> BackendResult<String> {
        let slug = input.trim().to_ascii_lowercase();
        if slug.starts_with('#') || slug.contains(':') {
            return Err(BackendError::InvalidConfiguration(
                "enter only the public-link name".into(),
            ));
        }
        if slug.is_empty() || slug.len() > 64 {
            return Err(BackendError::InvalidConfiguration(
                "public-link name must be between 1 and 64 characters".into(),
            ));
        }
        if !slug
            .bytes()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
            || !slug
                .bytes()
                .last()
                .is_some_and(|character| character.is_ascii_alphanumeric())
            || !slug.bytes().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, b'.' | b'_' | b'-')
            })
        {
            return Err(BackendError::InvalidConfiguration(
                "public-link name must start and end with a letter or number and use only letters, numbers, dots, dashes, or underscores"
                    .into(),
            ));
        }
        Ok(slug)
    }

    fn qualify_user_input(input: &str, account_server: &ServerName) -> BackendResult<OwnedUserId> {
        let input = input.trim();
        if input.starts_with('@') {
            return UserId::parse(input).map_err(Self::map_error);
        }
        let username = Self::normalize_product_username(input)?;
        UserId::parse(format!("@{username}:{account_server}")).map_err(Self::map_error)
    }

    fn qualify_public_link_input(
        input: &str,
        account_server: &ServerName,
    ) -> BackendResult<OwnedRoomAliasId> {
        let input = input.trim();
        if input.starts_with('#') {
            return RoomAliasId::parse(input).map_err(Self::map_error);
        }
        let slug = Self::normalize_public_link_slug(input)?;
        RoomAliasId::parse(format!("#{slug}:{account_server}")).map_err(Self::map_error)
    }

    fn uiaa_has_incomplete_stage(info: &UiaaInfo, stage: AuthType) -> bool {
        info.flows.iter().any(|flow| {
            flow.stages.iter().any(|candidate| {
                candidate.as_str() == stage.as_str()
                    && !info
                        .completed
                        .iter()
                        .any(|completed| completed.as_str() == candidate.as_str())
            })
        })
    }

    #[cfg(test)]
    fn uiaa_can_complete_with_stage(info: &UiaaInfo, required_stage: AuthType) -> bool {
        info.flows.iter().any(|flow| {
            let mut incomplete_count = 0_u8;
            let only_required_stage = flow
                .stages
                .iter()
                .filter(|stage| {
                    !info
                        .completed
                        .iter()
                        .any(|completed| completed.as_str() == stage.as_str())
                })
                .all(|stage| {
                    incomplete_count = incomplete_count.saturating_add(1);
                    stage.as_str() == required_stage.as_str()
                });
            incomplete_count > 0 && only_required_stage
        })
    }

    fn uiaa_has_supported_registration_flow(
        info: &UiaaInfo,
        registration_token_available: bool,
    ) -> bool {
        info.flows.iter().any(|flow| {
            let mut incomplete_count = 0_u8;
            let supported = flow
                .stages
                .iter()
                .filter(|stage| {
                    !info
                        .completed
                        .iter()
                        .any(|completed| completed.as_str() == stage.as_str())
                })
                .all(|stage| {
                    incomplete_count = incomplete_count.saturating_add(1);
                    matches!(stage, AuthType::Dummy)
                        || (registration_token_available
                            && matches!(stage, AuthType::RegistrationToken))
                });
            incomplete_count > 0 && supported
        })
    }

    fn map_registration_error(
        error: matrix_sdk::Error,
        registration_token_supplied: bool,
    ) -> BackendError {
        if let Some(info) = error.as_uiaa_response() {
            if Self::uiaa_has_incomplete_stage(info, AuthType::Terms) {
                return BackendError::RegistrationTermsRequired;
            }
            if Self::uiaa_has_incomplete_stage(info, AuthType::RegistrationToken) {
                return if registration_token_supplied {
                    BackendError::RegistrationInvitationInvalid
                } else {
                    BackendError::RegistrationInvitationRequired
                };
            }
            return BackendError::RegistrationAdditionalAuthRequired;
        }
        match error.client_api_error_kind() {
            Some(ErrorKind::UserInUse) => BackendError::UsernameUnavailable,
            Some(ErrorKind::InvalidUsername) => BackendError::InvalidConfiguration(
                "the selected account service rejected that username".into(),
            ),
            Some(ErrorKind::WeakPassword) => BackendError::InvalidConfiguration(
                "password does not meet the selected account service requirements".into(),
            ),
            _ => Self::map_error(error),
        }
    }

    fn validate_store_root_for_removal<'a>(
        &self,
        storage: &'a AccountStorage,
    ) -> BackendResult<&'a Path> {
        let path = storage.store_root.as_path();
        let normal_components = path
            .components()
            .filter(|component| matches!(component, Component::Normal(_)))
            .count();
        if !path.is_absolute()
            || normal_components < 2
            || path
                .components()
                .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
        {
            return Err(BackendError::InvalidConfiguration(
                "refusing to remove an unsafe Matrix store path".into(),
            ));
        }
        if storage.key_namespace == "default"
            && path.file_name().and_then(|name| name.to_str()) != Some("matrix")
        {
            return Err(BackendError::InvalidConfiguration(
                "refusing to remove a production Matrix store outside its dedicated directory"
                    .into(),
            ));
        }
        if self.dynamic_accounts
            && storage.profile_id == "default"
            && self.store_root.join("accounts").exists()
        {
            return Err(BackendError::InvalidConfiguration(
                "migrate or remove saved accounts before erasing the legacy default store".into(),
            ));
        }
        if self.dynamic_accounts
            && storage.profile_id != "default"
            && !path.starts_with(self.store_root.join("accounts"))
        {
            return Err(BackendError::InvalidConfiguration(
                "refusing to remove a Matrix account outside the account store".into(),
            ));
        }
        Ok(path)
    }

    fn local_account_removal_plan(
        &self,
        storage: &AccountStorage,
    ) -> BackendResult<LocalAccountRemovalPlan> {
        Ok(LocalAccountRemovalPlan {
            profile_id: storage.profile_id.clone(),
            store_root: self.validate_store_root_for_removal(storage)?.to_owned(),
            key_names: [
                Self::session_key(storage),
                Self::store_passphrase_key(storage),
                Self::trusted_devices_key(storage),
                Self::recovery_test_key(storage),
            ],
        })
    }

    fn erase_local_account_artifacts_with<Exists, Delete>(
        plan: &LocalAccountRemovalPlan,
        mut secret_exists: Exists,
        mut delete_secret: Delete,
    ) -> BackendResult<()>
    where
        Exists: FnMut(&str) -> Result<bool, String>,
        Delete: FnMut(&str) -> Result<(), String>,
    {
        let mut failures = Vec::new();
        for key in &plan.key_names {
            match secret_exists(key) {
                Ok(true) => {
                    if let Err(error) = delete_secret(key) {
                        failures.push(format!("could not erase keychain entry {key}: {error}"));
                    }
                }
                Ok(false) => {}
                Err(error) => {
                    failures.push(format!("could not inspect keychain entry {key}: {error}"));
                }
            }

            match secret_exists(key) {
                Ok(false) => {}
                Ok(true) => failures.push(format!(
                    "keychain entry {key} remained after local account cleanup"
                )),
                Err(error) => failures.push(format!(
                    "could not verify keychain entry {key} was erased: {error}"
                )),
            }
        }

        match plan.store_root.try_exists() {
            Ok(true) => {
                if let Err(error) = std::fs::remove_dir_all(&plan.store_root) {
                    failures.push(format!(
                        "could not remove account store {}: {error}",
                        plan.store_root.display()
                    ));
                }
            }
            Ok(false) => {}
            Err(error) => failures.push(format!(
                "could not inspect account store {}: {error}",
                plan.store_root.display()
            )),
        }
        match plan.store_root.try_exists() {
            Ok(false) => {}
            Ok(true) => failures.push(format!(
                "account store {} remained after local account cleanup",
                plan.store_root.display()
            )),
            Err(error) => failures.push(format!(
                "could not verify account store {} was erased: {error}",
                plan.store_root.display()
            )),
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(BackendError::Other(failures.join("; ")))
        }
    }

    fn remove_account_from_registry(registry: &mut AccountRegistry, profile_id: &str) {
        registry
            .accounts
            .retain(|account| account.profile_id != profile_id);
        if registry.active_profile_id.as_deref() == Some(profile_id) {
            registry.active_profile_id = None;
        }
    }

    fn load_or_create_store_passphrase(storage: &AccountStorage) -> BackendResult<String> {
        let key = Self::store_passphrase_key(storage);
        match keychain::lookup_secret(&key).map_err(Self::map_secure_storage_error)? {
            keychain::SecretLookup::Found(bytes) => return Ok(BASE64.encode(bytes)),
            keychain::SecretLookup::Missing => {}
        }

        let mut bytes = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        keychain::store_secret(&key, &bytes).map_err(Self::map_secure_storage_error)?;
        Ok(BASE64.encode(bytes))
    }

    async fn build_client(
        &self,
        homeserver: &str,
        storage: &AccountStorage,
    ) -> BackendResult<Client> {
        let homeserver = Self::normalize_homeserver_input(homeserver)?;

        std::fs::create_dir_all(&storage.store_root).map_err(Self::map_error)?;
        let passphrase = Self::load_or_create_store_passphrase(storage)?;

        let builder = Client::builder();
        let builder = if homeserver.contains("://") {
            // Explicit URLs were already validated above and must remain
            // usable for opening encrypted local state while the server is
            // offline. Server names still use normal .well-known discovery.
            builder.homeserver_url(&homeserver)
        } else {
            builder.server_name_or_homeserver_url(&homeserver)
        };
        let client = builder
            .sqlite_store(&storage.store_root, Some(&passphrase))
            .handle_refresh_tokens()
            // Follow the SDK's MSC4153 identity-based policy: distribute new
            // room keys only to devices signed by their owner's cross-signing
            // identity, without requiring users to interactively verify every
            // person before ordinary encrypted conversations can work.
            .with_room_key_recipient_strategy(CollectStrategy::IdentityBasedStrategy)
            .with_encryption_settings(EncryptionSettings {
                auto_enable_cross_signing: true,
                auto_enable_backups: true,
                backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
            })
            .build()
            .await
            .map_err(Self::map_error)?;
        // Persisted requests must never respawn under the SDK's permissive
        // default. Mesh enables each room queue only after re-establishing the
        // joined-and-encrypted invariant for the active account.
        client.send_queue().set_enabled(false).await;
        Ok(client)
    }

    async fn build_ephemeral_oauth_client(
        &self,
        homeserver: &str,
        store: &oidc::EphemeralStore,
    ) -> BackendResult<Client> {
        let homeserver = Self::normalize_homeserver_input(homeserver)?;
        let mut passphrase = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut passphrase);
        let encoded_passphrase = BASE64.encode(passphrase);
        passphrase.zeroize();

        let builder = Client::builder();
        let builder = if homeserver.contains("://") {
            builder.homeserver_url(&homeserver)
        } else {
            builder.server_name_or_homeserver_url(&homeserver)
        };
        builder
            .sqlite_store(store.path(), Some(&encoded_passphrase))
            .handle_refresh_tokens()
            // Keep the short-lived OAuth client on the same identity-based
            // sharing policy as the durable client.
            .with_room_key_recipient_strategy(CollectStrategy::IdentityBasedStrategy)
            .with_encryption_settings(EncryptionSettings {
                auto_enable_cross_signing: true,
                auto_enable_backups: true,
                backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
            })
            .build()
            .await
            .map_err(Self::map_error)
    }

    async fn sync_once_for_session_restore(client: &Client) -> BackendResult<()> {
        match tokio::time::timeout(
            Duration::from_secs(SESSION_RESTORE_SYNC_TIMEOUT_SECONDS),
            client.sync_once(SyncSettings::default().set_presence(PresenceState::Offline)),
        )
        .await
        {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => match Self::map_error(error) {
                BackendError::Network(detail) => {
                    tracing::warn!(
                        target: "mesh::matrix",
                        "Restored the encrypted local account while offline; sync will retry automatically: {detail}"
                    );
                    Ok(())
                }
                BackendError::RateLimited(detail) => {
                    tracing::warn!(
                        target: "mesh::matrix",
                        "Restored the encrypted local account while initial sync was rate limited; sync will retry automatically: {detail}"
                    );
                    Ok(())
                }
                error => Err(error),
            },
            Err(_) => {
                tracing::warn!(
                    target: "mesh::matrix",
                    timeout_seconds = SESSION_RESTORE_SYNC_TIMEOUT_SECONDS,
                    "Restored the encrypted local account while initial sync was unavailable; sync will retry automatically"
                );
                Ok(())
            }
        }
    }

    fn persist_session(
        &self,
        storage: &AccountStorage,
        homeserver: &str,
        session: &MatrixSession,
    ) -> BackendResult<()> {
        let value = PersistedSession {
            homeserver: homeserver.to_owned(),
            authentication: PersistedAuthentication::Password {
                session: session.clone(),
            },
        };
        let serialized = serde_json::to_vec(&value).map_err(Self::map_error)?;
        keychain::store_secret(&Self::session_key(storage), &serialized)
            .map_err(Self::map_secure_storage_error)
    }

    fn persist_oauth_session(
        storage: &AccountStorage,
        homeserver: &str,
        session: &OAuthSession,
    ) -> BackendResult<()> {
        let value = PersistedSession {
            homeserver: homeserver.to_owned(),
            authentication: PersistedAuthentication::OAuth {
                client_id: session.client_id.as_str().to_owned(),
                user: session.user.clone(),
            },
        };
        let serialized = serde_json::to_vec(&value).map_err(Self::map_error)?;
        keychain::store_secret(&Self::session_key(storage), &serialized)
            .map_err(Self::map_secure_storage_error)
    }

    fn rollback_unregistered_oauth_storage(&self, storage: &AccountStorage) -> BackendResult<()> {
        let plan = self.local_account_removal_plan(storage)?;
        Self::erase_local_account_artifacts_with(
            &plan,
            |key| keychain::try_secret_exists(key).map_err(|error| error.to_string()),
            |key| keychain::delete_secret(key).map_err(|error| error.to_string()),
        )
    }

    fn load_session(&self, storage: &AccountStorage) -> BackendResult<PersistedSession> {
        let serialized = keychain::load_secret(&Self::session_key(storage))
            .map_err(Self::map_secure_storage_error)?;
        Self::decode_persisted_session(&serialized)
    }

    fn decode_persisted_session(serialized: &[u8]) -> BackendResult<PersistedSession> {
        match serde_json::from_slice(serialized) {
            Ok(session) => Ok(session),
            Err(versioned_error) => {
                let legacy: LegacyPersistedSession =
                    serde_json::from_slice(serialized).map_err(|legacy_error| {
                        BackendError::Other(format!(
                            "saved Matrix session is invalid: {versioned_error}; legacy decode also failed: {legacy_error}"
                        ))
                    })?;
                Ok(PersistedSession {
                    homeserver: legacy.homeserver,
                    authentication: PersistedAuthentication::Password {
                        session: legacy.session,
                    },
                })
            }
        }
    }

    fn native_oidc_capabilities(metadata: &AuthorizationServerMetadata) -> NativeOidcCapabilities {
        NativeOidcCapabilities {
            code_response: metadata
                .response_types_supported
                .contains(&ResponseType::Code),
            query_response_mode: metadata
                .response_modes_supported
                .contains(&ResponseMode::Query),
            authorization_code_grant: metadata
                .grant_types_supported
                .contains(&GrantType::AuthorizationCode),
            refresh_token_grant: metadata
                .grant_types_supported
                .contains(&GrantType::RefreshToken),
            s256_pkce: metadata
                .code_challenge_methods_supported
                .contains(&CodeChallengeMethod::S256),
        }
    }

    async fn discover_oidc_registration(
        &self,
        homeserver: String,
    ) -> BackendResult<(MatrixOidcStatus, Option<OidcClientRegistration>)> {
        let homeserver = Self::normalize_homeserver_input(&homeserver)?;
        let redirect_uri = NATIVE_REDIRECT_URI.to_owned();

        // Discovery deliberately uses a storeless client. Merely checking
        // whether browser sign-in is available must not create an encrypted
        // account store or keychain material.
        let client = Client::builder()
            .server_name_or_homeserver_url(homeserver.clone())
            .handle_refresh_tokens()
            .build()
            .await
            .map_err(Self::map_error)?;
        let resolved_homeserver = client.homeserver().to_string();
        let metadata = match client.oauth().server_metadata().await {
            Ok(metadata) => metadata,
            Err(error) if error.is_not_supported() => {
                return Ok((
                    MatrixOidcStatus {
                        homeserver: resolved_homeserver,
                        availability: MatrixOidcAvailability::NotSupported,
                        issuer: None,
                        authorization_endpoint: None,
                        registration_mode: None,
                        client_id_configured: false,
                        redirect_uri,
                        authorization_code_pkce: false,
                        native_callback_ready: false,
                        ready: false,
                        reason: "This homeserver does not advertise Matrix OAuth/OIDC metadata"
                            .into(),
                    },
                    None,
                ));
            }
            Err(error) => {
                return Ok((
                    MatrixOidcStatus {
                        homeserver: resolved_homeserver,
                        availability: MatrixOidcAvailability::InvalidConfiguration,
                        issuer: None,
                        authorization_endpoint: None,
                        registration_mode: None,
                        client_id_configured: false,
                        redirect_uri,
                        authorization_code_pkce: false,
                        native_callback_ready: false,
                        ready: false,
                        reason: format!("OAuth/OIDC metadata could not be validated: {error}"),
                    },
                    None,
                ));
            }
        };
        let issuer = metadata.issuer.to_string();
        let authorization_endpoint = metadata.authorization_endpoint.to_string();
        let capabilities = Self::native_oidc_capabilities(&metadata);
        if let Err(error) = capabilities.require_all(&issuer) {
            return Ok((
                MatrixOidcStatus {
                    homeserver: resolved_homeserver,
                    availability: MatrixOidcAvailability::InvalidConfiguration,
                    issuer: Some(issuer),
                    authorization_endpoint: Some(authorization_endpoint),
                    registration_mode: None,
                    client_id_configured: false,
                    redirect_uri,
                    authorization_code_pkce: false,
                    native_callback_ready: false,
                    ready: false,
                    reason: error.to_string(),
                },
                None,
            ));
        }

        let registration = OidcClientRegistry::from_embedded_build_configuration()
            .and_then(|registry| registry.resolve(&metadata.issuer, capabilities).cloned());
        let registration = match registration {
            Ok(registration) => registration,
            Err(error) => {
                let availability = match &error {
                    OidcRegistrationError::MissingConfiguration
                    | OidcRegistrationError::MissingIssuerRegistration { .. } => {
                        MatrixOidcAvailability::Supported
                    }
                    _ => MatrixOidcAvailability::InvalidConfiguration,
                };
                return Ok((
                    MatrixOidcStatus {
                        homeserver: resolved_homeserver,
                        availability,
                        issuer: Some(issuer),
                        authorization_endpoint: Some(authorization_endpoint),
                        registration_mode: None,
                        client_id_configured: false,
                        redirect_uri,
                        authorization_code_pkce: true,
                        native_callback_ready: true,
                        ready: false,
                        reason: error.to_string(),
                    },
                    None,
                ));
            }
        };

        Ok((
            MatrixOidcStatus {
                homeserver: resolved_homeserver,
                availability: MatrixOidcAvailability::Supported,
                issuer: Some(issuer),
                authorization_endpoint: Some(authorization_endpoint),
                registration_mode: Some("static".into()),
                client_id_configured: true,
                redirect_uri,
                authorization_code_pkce: true,
                native_callback_ready: true,
                ready: true,
                reason: "Continue with Mesh is ready for this provider".into(),
            },
            Some(registration),
        ))
    }

    async fn discover_oidc(&self, homeserver: String) -> BackendResult<MatrixOidcStatus> {
        self.discover_oidc_registration(homeserver)
            .await
            .map(|(status, _registration)| status)
    }

    // `MatrixSyncFreshness` is advisory (staleness telemetry for the status
    // banner and the MatrixRTC lease gate), not a correctness invariant, so a
    // poisoned lock is recovered rather than left to panic every caller forever.
    fn lock_matrix_sync_freshness(
        freshness: &StdMutex<MatrixSyncFreshness>,
    ) -> StdMutexGuard<'_, MatrixSyncFreshness> {
        freshness
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn record_matrix_sync_success(
        freshness: &StdMutex<MatrixSyncFreshness>,
        task_epoch: u64,
        now_ms: u64,
    ) -> bool {
        let mut freshness = Self::lock_matrix_sync_freshness(freshness);
        if freshness.epoch != task_epoch {
            return false;
        }
        freshness.last_success_ms = now_ms;
        true
    }

    fn matrix_sync_is_fresh(last_success_ms: u64, now_ms: u64) -> bool {
        last_success_ms != 0
            && now_ms.saturating_sub(last_success_ms)
                <= MATRIX_SYNC_STATUS_FRESHNESS.as_millis() as u64
    }

    fn matrix_sync_retry_delay(failure_count: u32) -> Duration {
        let exponent = failure_count.saturating_sub(1).min(5);
        Duration::from_secs(1_u64 << exponent).min(MATRIX_SYNC_RETRY_MAX_DELAY)
    }

    fn spawn_matrix_sync(
        client: Client,
        cadence: MatrixSyncCadence,
        presence: PresenceState,
        task_epoch: u64,
        freshness: Arc<StdMutex<MatrixSyncFreshness>>,
        send_queue_reconcile: Option<Arc<Notify>>,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut failure_count: u32 = 0;
            loop {
                let callback_freshness = Arc::clone(&freshness);
                let callback_send_queue_reconcile = send_queue_reconcile.clone();
                let result = client
                    .sync_with_result_callback(
                        SyncSettings::default()
                            .timeout(cadence.timeout())
                            .set_presence(presence.clone()),
                        move |result| {
                            let freshness = Arc::clone(&callback_freshness);
                            let send_queue_reconcile = callback_send_queue_reconcile.clone();
                            async move {
                                if Self::lock_matrix_sync_freshness(&freshness).epoch != task_epoch
                                {
                                    return Ok(LoopCtrl::Break);
                                }
                                match result {
                                    Ok(_) => {
                                        if Self::record_matrix_sync_success(
                                            &freshness,
                                            task_epoch,
                                            Self::matrix_rtc_monotonic_now_ms(),
                                        ) {
                                            if let Some(send_queue_reconcile) = send_queue_reconcile
                                            {
                                                send_queue_reconcile.notify_one();
                                            }
                                            Ok(LoopCtrl::Continue)
                                        } else {
                                            Ok(LoopCtrl::Break)
                                        }
                                    }
                                    Err(error) => Err(error),
                                }
                            }
                        },
                    )
                    .await;

                let current_epoch = Self::lock_matrix_sync_freshness(&freshness).epoch;
                if current_epoch != task_epoch {
                    break;
                }

                match result {
                    Ok(()) => {
                        // A clean SDK exit is unusual for a live client. Re-enter
                        // the loop so a transient transport shutdown cannot leave
                        // the account silently stale.
                        failure_count = 0;
                    }
                    Err(error) => {
                        failure_count = failure_count.saturating_add(1);
                        tracing::warn!(
                            target: "mesh::matrix",
                            failure_count,
                            "Matrix sync paused; retrying automatically: {error}"
                        );
                    }
                }

                tokio::time::sleep(Self::matrix_sync_retry_delay(failure_count)).await;
            }
        })
    }

    async fn restart_matrix_sync_locked(
        control: &mut MatrixSyncControl,
        freshness: &Arc<StdMutex<MatrixSyncFreshness>>,
    ) {
        let task_epoch = {
            let mut freshness = Self::lock_matrix_sync_freshness(freshness);
            freshness.epoch = freshness.epoch.saturating_add(1);
            freshness.last_success_ms = 0;
            freshness.epoch
        };
        if let Some(task) = control.task.take() {
            task.abort();
            let _ = task.await;
        }
        if !control.paused {
            if let Some(client) = control.client.clone() {
                control.task = Some(Self::spawn_matrix_sync(
                    client,
                    control.cadence,
                    control.presence.clone(),
                    task_epoch,
                    Arc::clone(freshness),
                    control.send_queue_reconcile.clone(),
                ));
            }
        }
    }

    async fn set_matrix_sync_cadence(
        control: &Arc<Mutex<MatrixSyncControl>>,
        freshness: &Arc<StdMutex<MatrixSyncFreshness>>,
        cadence: MatrixSyncCadence,
    ) {
        let mut control = control.lock().await;
        let task_is_live = control
            .task
            .as_ref()
            .is_some_and(|task| !task.is_finished());
        if control.cadence == cadence
            && (control.paused || control.client.is_none() || task_is_live)
        {
            return;
        }
        control.cadence = cadence;
        Self::restart_matrix_sync_locked(&mut control, freshness).await;
    }

    async fn clear_sent_typing_notices(&self) {
        let mut sent_rooms = self.sent_typing_notices.lock().await;
        if sent_rooms.is_empty() {
            return;
        }
        let client = self.runtime.read().await.client.clone();
        let Some(client) = client else {
            sent_rooms.clear();
            return;
        };

        for room_id in sent_rooms.clone() {
            let Ok(room_id) = matrix_sdk::ruma::RoomId::parse(&room_id) else {
                sent_rooms.remove(&room_id);
                continue;
            };
            let room = match Self::protected_joined_room(
                &client,
                &room_id,
                "clearing typing status",
            )
            .await
            {
                Ok(room) => room,
                Err(error) => {
                    tracing::warn!(
                        target: "mesh::privacy",
                        room_id = %room_id,
                        "Could not clear a previously sent typing notice: {error}"
                    );
                    continue;
                }
            };
            match room.typing_notice(false).await {
                Ok(()) => {
                    sent_rooms.remove(room_id.as_str());
                }
                Err(error) => {
                    tracing::warn!(
                        target: "mesh::privacy",
                        room_id = %room_id,
                        "Could not clear a previously sent typing notice: {error}"
                    );
                }
            }
        }
    }

    async fn apply_wire_privacy(&self, preferences: &UserPreferences) -> BackendResult<()> {
        let next = WirePrivacyPreferences::from(preferences);
        let previous = *self.wire_privacy.read().await;
        let mut control = self.matrix_sync_control.lock().await;
        let presence = next.presence();
        if control.presence != presence {
            let publish_target = control
                .client
                .clone()
                .map(|client| {
                    let user_id = client
                        .user_id()
                        .ok_or(BackendError::NotAuthenticated)?
                        .to_owned();
                    Ok::<_, BackendError>((client, user_id))
                })
                .transpose()?;
            let previous_presence = control.presence.clone();
            control.presence = presence.clone();
            Self::restart_matrix_sync_locked(&mut control, &self.matrix_sync_freshness).await;

            if let Some((client, user_id)) = publish_target {
                if let Err(error) = client
                    .send(SetPresenceRequest::new(user_id, presence))
                    .await
                    .map_err(Self::map_error)
                {
                    // Keep the background sync and in-memory privacy state on
                    // the last successfully published value when the explicit
                    // Matrix presence write fails.
                    control.presence = previous_presence;
                    Self::restart_matrix_sync_locked(&mut control, &self.matrix_sync_freshness)
                        .await;
                    return Err(error);
                }
            }
        }
        drop(control);
        if previous.send_typing_indicators && !next.send_typing_indicators {
            self.clear_sent_typing_notices().await;
        }
        *self.wire_privacy.write().await = next;
        Ok(())
    }

    async fn reconcile_matrix_sync_cadence(
        sessions: &Arc<Mutex<HashMap<(String, String), MatrixRtcLocalSession>>>,
        control: &Arc<Mutex<MatrixSyncControl>>,
        freshness: &Arc<StdMutex<MatrixSyncFreshness>>,
    ) {
        // Keep the session snapshot locked through the controller transition so
        // a stale join/leave reconciliation cannot win after a newer epoch.
        let sessions = sessions.lock().await;
        let has_ready_session = sessions.values().any(|session| session.ready);
        let cadence = Self::matrix_sync_cadence_for_active_call(has_ready_session);
        Self::set_matrix_sync_cadence(control, freshness, cadence).await;
    }

    fn matrix_sync_cadence_for_active_call(active: bool) -> MatrixSyncCadence {
        if active {
            MatrixSyncCadence::ActiveCall
        } else {
            MatrixSyncCadence::Normal
        }
    }

    fn matrix_rtc_sync_is_fresh(last_success_ms: u64, now_ms: u64) -> bool {
        last_success_ms != 0
            && now_ms.saturating_sub(last_success_ms)
                <= MATRIX_RTC_SYNC_FRESHNESS.as_millis() as u64
    }

    async fn install_client(&self, client: Client, homeserver: String, profile_id: String) {
        client.add_event_handler({
            let event_callback = Arc::clone(&self.event_callback);
            move |event: OriginalSyncRoomMessageEvent, room: Room, push_actions: Vec<Action>| {
                let event_callback = Arc::clone(&event_callback);
                async move {
                    if !push_actions.iter().any(Action::should_notify)
                        || room.own_user_id() == event.sender
                    {
                        return;
                    }
                    if let Err(error) =
                        MatrixBackend::require_protected_room(&room, "showing a notification").await
                    {
                        tracing::warn!(
                            target: "mesh::security",
                            room_id = %room.room_id(),
                            "Suppressed a notification from an unprotected room: {error}"
                        );
                        return;
                    }

                    let member = room.get_member(&event.sender).await.ok().flatten();
                    let display_name = member
                        .as_ref()
                        .map(|member| member.name().to_owned())
                        .unwrap_or_else(|| event.sender.localpart().to_owned());
                    let avatar_url = member
                        .as_ref()
                        .and_then(|member| member.avatar_url())
                        .map(ToString::to_string);
                    MatrixBackend::dispatch_backend_event(
                        &event_callback,
                        MatrixBackendEvent::Notification(MatrixNotification {
                            room_id: room.room_id().to_string(),
                            event_id: event.event_id.to_string(),
                            sender: event.sender.to_string(),
                            display_name,
                            preview: MatrixBackend::notification_preview(event.content.body()),
                            is_mention: push_actions.iter().any(Action::is_highlight),
                            is_dm: !room.direct_targets().is_empty(),
                            avatar_url,
                        }),
                    );
                }
            }
        });
        client.add_event_handler({
            let event_callback = Arc::clone(&self.event_callback);
            move |event: OriginalSyncRoomPinnedEventsEvent, room: Room| {
                let event_callback = Arc::clone(&event_callback);
                async move {
                    if let Err(error) =
                        MatrixBackend::require_protected_room(&room, "reading pinned messages")
                            .await
                    {
                        tracing::warn!(
                            target: "mesh::security",
                            room_id = %room.room_id(),
                            "Suppressed pinned-message state from an unprotected room: {error}"
                        );
                        return;
                    }
                    MatrixBackend::dispatch_backend_event(
                        &event_callback,
                        MatrixBackendEvent::RoomPins(MatrixRoomPinsUpdate {
                            room_id: room.room_id().to_string(),
                            event_ids: event
                                .content
                                .pinned
                                .into_iter()
                                .take(MAX_PINNED_EVENTS)
                                .map(|event_id| event_id.to_string())
                                .collect(),
                        }),
                    );
                }
            }
        });
        client.add_event_handler({
            let event_callback = Arc::clone(&self.event_callback);
            move |_event: OriginalSyncRoomPowerLevelsEvent, room: Room| {
                let event_callback = Arc::clone(&event_callback);
                async move {
                    MatrixBackend::dispatch_backend_event(
                        &event_callback,
                        MatrixBackendEvent::PermissionStateChanged(MatrixPermissionStateChanged {
                            room_id: room.room_id().to_string(),
                        }),
                    );
                }
            }
        });
        client.add_event_handler({
            let event_callback = Arc::clone(&self.event_callback);
            move |_event: OriginalSyncSpaceChildEvent, room: Room| {
                let event_callback = Arc::clone(&event_callback);
                async move {
                    MatrixBackend::dispatch_backend_event(
                        &event_callback,
                        MatrixBackendEvent::PermissionStateChanged(MatrixPermissionStateChanged {
                            room_id: room.room_id().to_string(),
                        }),
                    );
                }
            }
        });
        client.add_event_handler({
            let event_callback = Arc::clone(&self.event_callback);
            let rtc_sessions = Arc::clone(&self.rtc_sessions);
            let rtc_media_keys = Arc::clone(&self.rtc_media_keys);
            let rtc_membership_writes = Arc::clone(&self.rtc_membership_writes);
            let matrix_sync = MatrixSyncCoordinator {
                control: Arc::clone(&self.matrix_sync_control),
                freshness: Arc::clone(&self.matrix_sync_freshness),
            };
            move |_event: OriginalSyncCallMemberEvent, room: Room| {
                let event_callback = Arc::clone(&event_callback);
                let rtc_sessions = Arc::clone(&rtc_sessions);
                let rtc_media_keys = Arc::clone(&rtc_media_keys);
                let rtc_membership_writes = Arc::clone(&rtc_membership_writes);
                let matrix_sync = matrix_sync.clone();
                async move {
                    MatrixBackend::emit_matrix_rtc_membership(&room, &event_callback).await;
                    if let Err(error) = MatrixBackend::sync_matrix_rtc_media_keys_for_room(
                        &room,
                        &rtc_sessions,
                        &rtc_media_keys,
                        &rtc_membership_writes,
                        &matrix_sync,
                        &event_callback,
                    )
                    .await
                    {
                        MatrixBackend::fail_closed_matrix_rtc_room(
                            room.room_id().as_str(),
                            &rtc_sessions,
                            &rtc_media_keys,
                            &rtc_membership_writes,
                            &matrix_sync,
                            &event_callback,
                            "distribution-failed",
                        )
                        .await;
                        tracing::warn!(
                            target: "mesh::matrixrtc",
                            room_id = %room.room_id(),
                            "MatrixRTC media key rotation was rejected: {error}"
                        );
                    }
                }
            }
        });
        client.add_event_handler({
            let rtc_sessions = Arc::clone(&self.rtc_sessions);
            let rtc_media_keys = Arc::clone(&self.rtc_media_keys);
            let event_callback = Arc::clone(&self.event_callback);
            move |raw: Raw<AnyToDeviceEvent>,
                  encryption_info: Option<EncryptionInfo>,
                  client: Client| {
                let rtc_sessions = Arc::clone(&rtc_sessions);
                let rtc_media_keys = Arc::clone(&rtc_media_keys);
                let event_callback = Arc::clone(&event_callback);
                async move {
                    if let Err(error) = MatrixBackend::handle_matrix_rtc_media_key_event(
                        raw,
                        encryption_info,
                        client,
                        rtc_sessions,
                        rtc_media_keys,
                        event_callback,
                    )
                    .await
                    {
                        tracing::warn!(
                            target: "mesh::matrixrtc",
                            "Rejected MatrixRTC media key event: {error}"
                        );
                    }
                }
            }
        });
        client.add_event_handler({
            let presence = Arc::clone(&self.presence);
            move |event: PresenceEvent| {
                let presence = Arc::clone(&presence);
                async move {
                    presence
                        .write()
                        .await
                        .insert(event.sender.to_string(), event.content.presence.to_string());
                }
            }
        });
        client.add_event_handler({
            let typing_users = Arc::clone(&self.typing_users);
            move |event: SyncTypingEvent, room: Room| {
                let typing_users = Arc::clone(&typing_users);
                async move {
                    if let Err(error) =
                        MatrixBackend::require_protected_room(&room, "reading typing status").await
                    {
                        typing_users.write().await.remove(room.room_id().as_str());
                        tracing::warn!(
                            target: "mesh::security",
                            room_id = %room.room_id(),
                            "Suppressed typing status from an unprotected room: {error}"
                        );
                        return;
                    }
                    let own_user_id = room.own_user_id();
                    let users = event
                        .content
                        .user_ids
                        .into_iter()
                        .filter(|user_id| user_id != own_user_id)
                        .map(|user_id| user_id.to_string())
                        .collect();
                    typing_users
                        .write()
                        .await
                        .insert(room.room_id().to_string(), users);
                }
            }
        });

        let session_task = matches!(client.auth_api(), Some(AuthApi::OAuth(_))).then(|| {
            let mut session_changes = client.subscribe_to_session_changes();
            let session_client = client.clone();
            let session_homeserver = homeserver.clone();
            let session_storage = self.storage_for_profile(&profile_id);
            tokio::spawn(async move {
                loop {
                    match session_changes.recv().await {
                        Ok(SessionChange::TokensRefreshed) => {
                            let Some(session) = session_client.oauth().full_session() else {
                                tracing::error!(
                                    target: "mesh::matrix",
                                    "OAuth tokens changed without a complete SDK session"
                                );
                                continue;
                            };
                            if MatrixBackend::persist_oauth_session(
                                &session_storage,
                                &session_homeserver,
                                &session,
                            )
                            .is_err()
                            {
                                tracing::error!(
                                    target: "mesh::matrix",
                                    "Failed to persist the rotated OAuth session"
                                );
                            }
                        }
                        Ok(SessionChange::UnknownToken { .. }) => {
                            tracing::warn!(
                                target: "mesh::matrix",
                                "The OAuth session is no longer valid"
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            if let Some(session) = session_client.oauth().full_session() {
                                let _ = MatrixBackend::persist_oauth_session(
                                    &session_storage,
                                    &session_homeserver,
                                    &session,
                                );
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            })
        });

        let mut room_updates = client.subscribe_to_all_room_updates();
        let room_updates_client = client.clone();
        let room_updates_callback = Arc::clone(&self.event_callback);
        let room_updates_task = tokio::spawn(async move {
            loop {
                match room_updates.recv().await {
                    Ok(updates) => {
                        let room_ids = updates.iter_all_room_ids().cloned().collect::<Vec<_>>();
                        for room_id in room_ids {
                            MatrixBackend::emit_room_unread(
                                &room_updates_client,
                                &room_updates_callback,
                                &room_id,
                            )
                            .await;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(
                            target: "mesh::matrix",
                            skipped,
                            "Matrix unread update stream lagged; reconciling every room"
                        );
                        MatrixBackend::emit_all_room_unreads(
                            &room_updates_client,
                            &room_updates_callback,
                        )
                        .await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        let send_queue_task = Self::spawn_send_queue_task(
            client.clone(),
            Arc::clone(&self.send_queue_reconcile),
            Arc::clone(&self.send_queue_gate),
            Arc::clone(&self.send_queue_known),
            Arc::clone(&self.event_callback),
        );

        let mut runtime = self.runtime.write().await;
        if let Some(previous) = runtime.session_task.take() {
            previous.abort();
        }
        if let Some(previous) = runtime.room_updates_task.take() {
            previous.abort();
        }
        if let Some(previous) = runtime.send_queue_task.take() {
            previous.abort();
        }
        runtime.client = Some(client.clone());
        runtime.homeserver = Some(homeserver);
        runtime.profile_id = Some(profile_id);
        runtime.session_task = session_task;
        runtime.room_updates_task = Some(room_updates_task);
        runtime.send_queue_task = Some(send_queue_task);
        drop(runtime);

        let mut sync = self.matrix_sync_control.lock().await;
        sync.client = Some(client);
        sync.cadence = MatrixSyncCadence::Normal;
        sync.paused = false;
        sync.send_queue_reconcile = Some(Arc::clone(&self.send_queue_reconcile));
        Self::restart_matrix_sync_locked(&mut sync, &self.matrix_sync_freshness).await;
        drop(sync);
    }

    async fn stop_runtime(&self) -> Option<Client> {
        {
            let mut sync = self.matrix_sync_control.lock().await;
            sync.paused = true;
            sync.client = None;
            sync.cadence = MatrixSyncCadence::Normal;
            sync.presence = PresenceState::Offline;
            sync.send_queue_reconcile = None;
            Self::restart_matrix_sync_locked(&mut sync, &self.matrix_sync_freshness).await;
        }
        *self.wire_privacy.write().await = WirePrivacyPreferences::default();
        self.sent_typing_notices.lock().await.clear();
        let (client, session_task, room_updates_task, send_queue_task) = {
            let mut runtime = self.runtime.write().await;
            let client = runtime.client.take();
            let session_task = runtime.session_task.take();
            let room_updates_task = runtime.room_updates_task.take();
            let send_queue_task = runtime.send_queue_task.take();
            runtime.homeserver = None;
            runtime.profile_id = None;
            (client, session_task, room_updates_task, send_queue_task)
        };

        if let Some(client) = client.as_ref() {
            client.send_queue().set_enabled(false).await;
        }
        if let Some(task) = session_task {
            task.abort();
            let _ = task.await;
        }
        if let Some(task) = room_updates_task {
            task.abort();
            let _ = task.await;
        }
        if let Some(task) = send_queue_task {
            task.abort();
            let _ = task.await;
        }
        self.send_queue_known.lock().await.clear();
        for session in self
            .rtc_sessions
            .lock()
            .await
            .drain()
            .map(|(_, session)| session)
        {
            session.cancellation.cancel();
        }
        let mut media_keys = self.rtc_media_keys.lock().await;
        media_keys.outbound.clear();
        media_keys.inbound.clear();
        media_keys.pending.clear();
        media_keys.pending_activations.clear();
        media_keys.completed_activations.clear();
        media_keys.lease_blocked.clear();
        media_keys.attempts.clear();
        drop(media_keys);
        self.typing_users.write().await.clear();
        self.presence.write().await.clear();
        self.verification_sessions.write().await.clear();
        Self::lock_matrix_sync_freshness(&self.matrix_sync_freshness).last_success_ms = 0;
        client
    }

    async fn client(&self) -> BackendResult<Client> {
        self.runtime
            .read()
            .await
            .client
            .clone()
            .ok_or(BackendError::NotAuthenticated)
    }

    pub async fn pause_sync(&self) {
        let mut sync = self.matrix_sync_control.lock().await;
        Self::lock_matrix_sync_freshness(&self.matrix_sync_freshness).last_success_ms = 0;
        if sync.paused && sync.task.is_none() {
            return;
        }
        sync.paused = true;
        Self::restart_matrix_sync_locked(&mut sync, &self.matrix_sync_freshness).await;
    }

    #[doc(hidden)]
    pub async fn shutdown_for_test(&self) {
        self.stop_runtime().await;
    }

    pub async fn resume_sync(&self) -> BackendResult<()> {
        let client = self.client().await?;
        let sessions = self.rtc_sessions.lock().await;
        let has_ready_session = sessions.values().any(|session| session.ready);
        let cadence = Self::matrix_sync_cadence_for_active_call(has_ready_session);
        let mut sync = self.matrix_sync_control.lock().await;
        let task_is_live =
            sync.task.as_ref().is_some_and(|task| !task.is_finished()) && !sync.paused;
        if task_is_live && sync.cadence == cadence {
            return Ok(());
        }
        sync.client = Some(client);
        sync.cadence = cadence;
        sync.paused = false;
        Self::restart_matrix_sync_locked(&mut sync, &self.matrix_sync_freshness).await;
        drop(sessions);
        Ok(())
    }

    fn room_notification_mode_from_ruleset(
        ruleset: &Ruleset,
        room_id: &RoomId,
        is_encrypted: bool,
        is_direct: bool,
    ) -> RoomNotificationMode {
        let muted = ruleset.override_.iter().any(|rule| {
            rule.enabled
                && rule.conditions.iter().any(|condition| {
                    matches!(
                        condition,
                        PushCondition::EventMatch(data)
                            if data.key == "room_id" && data.pattern == *room_id
                    )
                })
                && !rule.actions.iter().any(Action::should_notify)
        });
        if muted {
            return RoomNotificationMode::Mute;
        }

        if let Some(rule) = ruleset.get(RuleKind::Room, room_id) {
            return if rule.triggers_notification() {
                RoomNotificationMode::AllMessages
            } else {
                RoomNotificationMode::MentionsAndKeywordsOnly
            };
        }

        let default_rule = match (is_encrypted, is_direct) {
            (true, true) => PredefinedUnderrideRuleId::EncryptedRoomOneToOne,
            (false, true) => PredefinedUnderrideRuleId::RoomOneToOne,
            (true, false) => PredefinedUnderrideRuleId::Encrypted,
            (false, false) => PredefinedUnderrideRuleId::Message,
        };
        if ruleset
            .get(RuleKind::Underride, default_rule.as_str())
            .is_some_and(|rule| rule.enabled() && rule.triggers_notification())
        {
            RoomNotificationMode::AllMessages
        } else {
            RoomNotificationMode::MentionsAndKeywordsOnly
        }
    }

    fn custom_notification_rules_for_room(
        ruleset: &Ruleset,
        room_id: &RoomId,
    ) -> Vec<(RuleKind, String)> {
        let mut rules = Vec::new();
        for rule in &ruleset.override_ {
            if rule.conditions.iter().any(|condition| {
                matches!(
                    condition,
                    PushCondition::EventMatch(data)
                        if data.key == "room_id" && data.pattern == *room_id
                )
            }) {
                rules.push((RuleKind::Override, rule.rule_id.clone()));
            }
        }
        if let Some(rule) = ruleset.get(RuleKind::Room, room_id) {
            rules.push((RuleKind::Room, rule.rule_id().to_owned()));
        }
        for rule in &ruleset.underride {
            if rule.conditions.iter().any(|condition| {
                matches!(
                    condition,
                    PushCondition::EventMatch(data)
                        if data.key == "room_id" && data.pattern == *room_id
                )
            }) {
                rules.push((RuleKind::Underride, rule.rule_id.clone()));
            }
        }
        rules
    }

    async fn set_room_notification_mode_server_authoritative(
        client: &Client,
        room_id: &RoomId,
        mode: RoomNotificationMode,
    ) -> BackendResult<()> {
        for _ in 0..3 {
            let response = client
                .send(get_pushrules_all::v3::Request::new())
                .await
                .map_err(Self::map_error)?;
            let (target_kind, target_rule) = match mode {
                RoomNotificationMode::AllMessages => (
                    RuleKind::Room,
                    NewPushRule::Room(NewSimplePushRule::new(
                        room_id.to_owned(),
                        vec![
                            Action::Notify,
                            Action::SetTweak(Tweak::Sound(SoundTweakValue::Default)),
                        ],
                    )),
                ),
                RoomNotificationMode::MentionsAndKeywordsOnly => (
                    RuleKind::Room,
                    NewPushRule::Room(NewSimplePushRule::new(room_id.to_owned(), Vec::new())),
                ),
                RoomNotificationMode::Mute => (
                    RuleKind::Override,
                    NewPushRule::Override(NewConditionalPushRule::new(
                        room_id.to_string(),
                        vec![PushCondition::EventMatch(EventMatchConditionData::new(
                            "room_id".into(),
                            room_id.to_string(),
                        ))],
                        Vec::new(),
                    )),
                ),
            };

            client
                .send(set_pushrule::v3::Request::new(target_rule))
                .await
                .map_err(Self::map_error)?;

            for (kind, rule_id) in
                Self::custom_notification_rules_for_room(&response.global, room_id)
            {
                if kind == target_kind && rule_id == room_id.as_str() {
                    continue;
                }
                if let Err(error) = client
                    .send(delete_pushrule::v3::Request::new(kind, rule_id.clone()))
                    .await
                {
                    tracing::debug!(
                        target: "mesh::matrix",
                        room_id = %room_id,
                        rule_id,
                        "A concurrent notification-rule cleanup will be verified and retried: {error}"
                    );
                }
            }

            let refreshed = client
                .send(get_pushrules_all::v3::Request::new())
                .await
                .map_err(Self::map_error)?;
            if Self::room_notification_mode_from_ruleset(&refreshed.global, room_id, true, false)
                == mode
            {
                return Ok(());
            }
        }

        Err(BackendError::Other(
            "the account service did not converge the room notification setting".into(),
        ))
    }
}

#[async_trait]
impl MeshBackend for MatrixBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Matrix
    }

    async fn store_pending_invitation(
        &self,
        invite_link: String,
    ) -> BackendResult<PendingInvitationMetadata> {
        let invite_link = invite_link.trim().to_owned();
        if invite_link.is_empty() || invite_link.len() > 4_096 {
            return Err(BackendError::InvalidConfiguration(
                "pending invitation is empty or too large".into(),
            ));
        }

        let _gate = self.pending_invitation_gate.lock().await;
        let stored_at = Self::pending_invitation_now_ms();
        let metadata = Self::pending_invitation_metadata(&invite_link, stored_at);
        let record = PendingInvitationRecord {
            invite_link,
            metadata: metadata.clone(),
        };
        let storages = self.pending_invitation_storages().await;
        for storage in storages.iter().skip(1) {
            Self::remove_pending_invitation_record(storage).await?;
        }
        let storage = storages.first().ok_or_else(|| {
            BackendError::Crypto("pending invitation store is unavailable".into())
        })?;
        self.write_pending_invitation_record(storage, &record)
            .await?;
        Ok(metadata)
    }

    async fn read_pending_invitation(&self) -> BackendResult<Option<String>> {
        let _gate = self.pending_invitation_gate.lock().await;
        let Some((storage, record)) = self.find_pending_invitation_record().await? else {
            return Ok(None);
        };
        if Self::pending_invitation_expired(&record.metadata, Self::pending_invitation_now_ms()) {
            Self::remove_pending_invitation_record(&storage).await?;
            return Ok(None);
        }
        Ok(Some(record.invite_link))
    }

    async fn take_pending_invitation(&self) -> BackendResult<Option<String>> {
        let _gate = self.pending_invitation_gate.lock().await;
        let Some((storage, record)) = self.find_pending_invitation_record().await? else {
            return Ok(None);
        };
        if Self::pending_invitation_expired(&record.metadata, Self::pending_invitation_now_ms()) {
            Self::remove_pending_invitation_record(&storage).await?;
            return Ok(None);
        }
        let invite_link = record.invite_link;
        Self::remove_pending_invitation_record(&storage).await?;
        Ok(Some(invite_link))
    }

    async fn peek_pending_invitation(&self) -> BackendResult<Option<PendingInvitationMetadata>> {
        let metadata = {
            let _gate = self.pending_invitation_gate.lock().await;
            let Some((storage, record)) = self.find_pending_invitation_record().await? else {
                return Ok(None);
            };
            if Self::pending_invitation_expired(&record.metadata, Self::pending_invitation_now_ms())
            {
                Self::remove_pending_invitation_record(&storage).await?;
                return Ok(None);
            }
            record.metadata
        };
        Ok(Some(
            self.enrich_pending_invitation_metadata(metadata).await,
        ))
    }

    async fn resolve_pending_invitation(
        &self,
    ) -> BackendResult<Option<super::MatrixCommunityAdmission>> {
        let record = {
            let _gate = self.pending_invitation_gate.lock().await;
            let Some((storage, record)) = self.find_pending_invitation_record().await? else {
                return Ok(None);
            };
            if Self::pending_invitation_expired(&record.metadata, Self::pending_invitation_now_ms())
            {
                Self::remove_pending_invitation_record(&storage).await?;
                return Ok(None);
            }
            record
        };

        let admission = self.resolve_community_invite(record.invite_link).await?;
        Ok(Some(self.enrich_community_admission(admission).await))
    }

    async fn clear_pending_invitation(&self) -> BackendResult<()> {
        let _gate = self.pending_invitation_gate.lock().await;
        self.clear_pending_invitation_records().await
    }

    async fn active_account_storage_root(&self) -> BackendResult<PathBuf> {
        let profile_id = self
            .runtime
            .read()
            .await
            .profile_id
            .clone()
            .ok_or(BackendError::NotAuthenticated)?;
        Ok(self.storage_for_profile(&profile_id).store_root)
    }

    fn set_matrix_event_callback(&self, callback: Option<MatrixBackendEventCallback>) {
        match self.event_callback.write() {
            Ok(mut current) => *current = callback,
            Err(error) => {
                tracing::error!(
                    target: "mesh::matrix",
                    "Matrix event callback lock was poisoned: {error}"
                );
            }
        }
    }

    async fn start(&self) -> BackendResult<()> {
        let storage = match self.active_storage_from_registry() {
            Ok(storage) => storage,
            Err(BackendError::NotAuthenticated) => return Ok(()),
            Err(error) => return Err(error),
        };
        match keychain::lookup_secret(&Self::session_key(&storage))
            .map_err(Self::map_secure_storage_error)?
        {
            keychain::SecretLookup::Found(_) => {
                self.restore_session().await?;
            }
            keychain::SecretLookup::Missing => {}
        }
        Ok(())
    }

    async fn status(&self) -> BackendStatus {
        let sync_running_task = self
            .matrix_sync_control
            .lock()
            .await
            .task
            .as_ref()
            .is_some_and(|task| !task.is_finished());
        let last_success_ms =
            Self::lock_matrix_sync_freshness(&self.matrix_sync_freshness).last_success_ms;
        let sync_running = sync_running_task
            && Self::matrix_sync_is_fresh(last_success_ms, Self::matrix_rtc_monotonic_now_ms());
        let runtime = self.runtime.read().await;
        let user_id = runtime
            .client
            .as_ref()
            .and_then(|client| client.user_id())
            .map(ToString::to_string);
        let device_id = runtime
            .client
            .as_ref()
            .and_then(|client| client.device_id())
            .map(ToString::to_string);
        let authenticated = user_id.is_some();

        let warnings = if !authenticated {
            vec!["Sign in to synchronize communities and messages".into()]
        } else if !sync_running {
            vec![
                "Your connection is temporarily unavailable. Mesh will retry automatically.".into(),
            ]
        } else {
            Vec::new()
        };

        BackendStatus {
            kind: BackendKind::Matrix,
            capabilities: super::BackendCapabilities::for_kind(BackendKind::Matrix),
            voice_service: super::VoiceServiceStatus::for_kind(BackendKind::Matrix),
            authenticated,
            user_id,
            device_id,
            homeserver: runtime.homeserver.clone(),
            sync_running,
            durable_history: true,
            end_to_end_encryption: true,
            warnings,
        }
    }

    async fn matrix_room_is_encrypted(&self, room_id: String) -> BackendResult<bool> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        // This is the status probe used before opening a room, so it cannot use
        // `protected_joined_room` without making an unencrypted result unobservable.
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::NotFound("room is not present in the local Matrix store".into())
        })?;
        room.latest_encryption_state()
            .await
            .map(|state| state.is_encrypted())
            .map_err(|error| {
                BackendError::Other(format!(
                    "could not verify encryption for Matrix room {}: {error}",
                    room.room_id()
                ))
            })
    }

    async fn matrix_room_upgrade(
        &self,
        room_id: String,
    ) -> BackendResult<Option<MatrixRoomUpgrade>> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room =
            Self::protected_joined_room(&client, &room_id, "reading room upgrade status").await?;
        let (replacement_room_id, reason) = match client
            .send(get_state_event_for_key::v3::Request::new(
                room.room_id().to_owned(),
                StateEventType::RoomTombstone,
                String::new(),
            ))
            .await
        {
            Ok(response) => {
                let content = response
                    .into_content()
                    .deserialize_as_unchecked::<RoomTombstoneEventContent>()
                    .map_err(Self::map_error)?;
                (
                    Some(content.replacement_room.to_string()),
                    Some(content.body.chars().take(240).collect()),
                )
            }
            Err(_) => match room.successor_room() {
                Some(successor) => (
                    Some(successor.room_id.to_string()),
                    successor
                        .reason
                        .map(|reason| reason.chars().take(240).collect()),
                ),
                None => (None, None),
            },
        };
        let mut predecessor_room_id = room
            .predecessor_room()
            .map(|predecessor| predecessor.room_id.to_string());
        if predecessor_room_id.is_none() {
            predecessor_room_id = self.verified_room_upgrades.read().await.iter().find_map(
                |(predecessor, replacement)| {
                    (replacement == room.room_id()).then(|| predecessor.to_string())
                },
            );
        }
        if predecessor_room_id.is_none() {
            predecessor_room_id = self
                .cache_verified_room_upgrade(&client, &room, "reading room upgrade status")
                .await?
                .map(|predecessor| predecessor.to_string());
        }
        if replacement_room_id.is_none() && predecessor_room_id.is_none() {
            return Ok(None);
        }
        Ok(Some(MatrixRoomUpgrade {
            room_id: room.room_id().to_string(),
            replacement_room_id,
            predecessor_room_id,
            reason,
        }))
    }

    async fn matrix_room_notification_mode(
        &self,
        room_id: String,
    ) -> BackendResult<MatrixRoomNotificationMode> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room =
            Self::protected_joined_room(&client, &room_id, "reading notification settings").await?;
        let mode = match client.send(get_pushrules_all::v3::Request::new()).await {
            Ok(response) => Self::room_notification_mode_from_ruleset(
                &response.global,
                &room_id,
                room.latest_encryption_state()
                    .await
                    .map_err(Self::map_error)?
                    .is_encrypted(),
                !room.direct_targets().is_empty(),
            ),
            Err(error) => {
                tracing::warn!(
                    target: "mesh::matrix",
                    room_id = %room_id,
                    "Could not refresh notification settings from the account service; using the cached mode: {error}"
                );
                room.notification_mode().await.ok_or_else(|| {
                    BackendError::Other(
                        "Matrix notification mode is not available for this room".into(),
                    )
                })?
            }
        };
        Ok(match mode {
            RoomNotificationMode::AllMessages => MatrixRoomNotificationMode::All,
            RoomNotificationMode::MentionsAndKeywordsOnly => MatrixRoomNotificationMode::Mentions,
            RoomNotificationMode::Mute => MatrixRoomNotificationMode::Nothing,
        })
    }

    async fn matrix_set_room_notification_mode(
        &self,
        room_id: String,
        mode: MatrixRoomNotificationMode,
    ) -> BackendResult<()> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let _room =
            Self::protected_joined_room(&client, &room_id, "updating notification settings")
                .await?;
        let mode = match mode {
            MatrixRoomNotificationMode::All => RoomNotificationMode::AllMessages,
            MatrixRoomNotificationMode::Mentions => RoomNotificationMode::MentionsAndKeywordsOnly,
            MatrixRoomNotificationMode::Nothing => RoomNotificationMode::Mute,
        };
        Self::set_room_notification_mode_server_authoritative(&client, &room_id, mode).await
    }

    async fn login(&self, request: MatrixLogin) -> BackendResult<BackendStatus> {
        if request.username.trim().is_empty() || request.password.is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "username and password are required".into(),
            ));
        }

        let normalized_homeserver = Self::normalize_homeserver_input(&request.homeserver)?;
        let profile_id = if self.dynamic_accounts {
            Self::profile_id(&normalized_homeserver, request.username.trim())
        } else {
            self.profile_hint.clone()
        };
        let storage = self.storage_for_profile(&profile_id);
        let attempt_id = self.login_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let cancellation = CancellationToken::new();
        {
            let mut active = self.login_attempt.lock().await;
            if let Some(previous) = active.replace(LoginAttempt {
                id: attempt_id,
                cancellation: cancellation.clone(),
            }) {
                previous.cancellation.cancel();
            }
        }

        let operation = async {
            let client = self.build_client(&normalized_homeserver, &storage).await?;
            let mut login = client
                .matrix_auth()
                .login_username(request.username.trim(), &request.password);
            if let Some(device_name) = request.device_name.as_deref() {
                login = login.initial_device_display_name(device_name);
            }
            login.send().await.map_err(Self::map_error)?;

            let session = client.matrix_auth().session().ok_or_else(|| {
                BackendError::Other("homeserver login returned no Matrix session".into())
            })?;
            let resolved_homeserver = client.homeserver().to_string();

            // Complete one sync before exposing or persisting the account. A
            // cancelled/timed-out attempt therefore never becomes restorable.
            client
                .sync_once(SyncSettings::default().set_presence(PresenceState::Offline))
                .await
                .map_err(Self::map_error)?;
            self.persist_session(&storage, &resolved_homeserver, &session)?;
            self.remember_account(&storage, &resolved_homeserver, &session)?;
            Ok::<_, BackendError>((client, resolved_homeserver, storage.profile_id.clone()))
        };

        let result = tokio::select! {
            _ = cancellation.cancelled() => Err(BackendError::LoginCancelled),
            timed = tokio::time::timeout(Duration::from_secs(LOGIN_TIMEOUT_SECONDS), operation) => {
                timed.map_err(|_| BackendError::LoginTimedOut(LOGIN_TIMEOUT_SECONDS))?
            }
        };

        {
            let mut active = self.login_attempt.lock().await;
            if active
                .as_ref()
                .is_some_and(|attempt| attempt.id == attempt_id)
            {
                *active = None;
            }
        }

        let (client, resolved_homeserver, profile_id) = result?;
        self.stop_runtime().await;
        self.install_client(client, resolved_homeserver, profile_id)
            .await;
        Ok(self.status().await)
    }

    async fn register_account(&self, request: MatrixRegistration) -> BackendResult<BackendStatus> {
        let MatrixRegistration {
            homeserver,
            username,
            mut password,
            registration_token,
            device_name,
        } = request;
        let normalized_homeserver = match Self::normalize_homeserver_input(&homeserver) {
            Ok(homeserver) => homeserver,
            Err(error) => {
                password.zeroize();
                return Err(error);
            }
        };
        let mut registration_token = match Self::normalize_registration_token(registration_token) {
            Ok(token) => token,
            Err(error) => {
                password.zeroize();
                return Err(error);
            }
        };
        let username = match Self::normalize_product_username(&username) {
            Ok(username) => username,
            Err(error) => {
                password.zeroize();
                if let Some(token) = &mut registration_token {
                    token.zeroize();
                }
                return Err(error);
            }
        };
        if password.len() < 8 {
            password.zeroize();
            if let Some(token) = &mut registration_token {
                token.zeroize();
            }
            return Err(BackendError::InvalidConfiguration(
                "password must be at least 8 characters".into(),
            ));
        }
        let profile_id = if self.dynamic_accounts {
            Self::profile_id(&normalized_homeserver, &username)
        } else {
            self.profile_hint.clone()
        };
        let storage = self.storage_for_profile(&profile_id);

        let operation =
            match tokio::time::timeout(Duration::from_secs(REGISTRATION_TIMEOUT_SECONDS), async {
                let client = self.build_client(&normalized_homeserver, &storage).await?;
                let registration_request = |auth: Option<AuthData>| {
                    let mut request = RegistrationRequest::new();
                    request.username = Some(username.clone());
                    request.password = Some(password.clone());
                    request.initial_device_display_name =
                        Some(device_name.clone().unwrap_or_else(|| "Mesh desktop".into()));
                    request.auth = auth;
                    request.refresh_token = true;
                    request
                };

                let mut registration_result = client
                    .matrix_auth()
                    .register(registration_request(None))
                    .await;
                let mut registration_complete = false;
                for attempt in 0..4 {
                    let error = match registration_result {
                        Ok(_) => {
                            registration_complete = true;
                            break;
                        }
                        Err(error) => error,
                    };
                    if attempt == 3 {
                        return Err(Self::map_registration_error(
                            error,
                            registration_token.is_some(),
                        ));
                    }
                    let Some(info) = error.as_uiaa_response() else {
                        return Err(Self::map_registration_error(
                            error,
                            registration_token.is_some(),
                        ));
                    };
                    if !Self::uiaa_has_supported_registration_flow(
                        info,
                        registration_token.is_some(),
                    ) {
                        return Err(Self::map_registration_error(
                            error,
                            registration_token.is_some(),
                        ));
                    }

                    let auth = if Self::uiaa_has_incomplete_stage(info, AuthType::RegistrationToken)
                    {
                        let Some(token) = registration_token.as_ref() else {
                            return Err(BackendError::RegistrationInvitationRequired);
                        };
                        let mut registration = RegistrationToken::new(token.clone());
                        registration.session = info.session.clone();
                        AuthData::RegistrationToken(registration)
                    } else if Self::uiaa_has_incomplete_stage(info, AuthType::Dummy) {
                        let mut dummy = Dummy::new();
                        dummy.session = info.session.clone();
                        AuthData::Dummy(dummy)
                    } else {
                        return Err(Self::map_registration_error(
                            error,
                            registration_token.is_some(),
                        ));
                    };
                    registration_result = client
                        .matrix_auth()
                        .register(registration_request(Some(auth)))
                        .await;
                }
                if !registration_complete {
                    return Err(BackendError::RegistrationAdditionalAuthRequired);
                }

                let session = client.matrix_auth().session().ok_or_else(|| {
                    BackendError::Other(
                        "account registration returned no usable Matrix session".into(),
                    )
                })?;
                let resolved_homeserver = client.homeserver().to_string();
                client
                    .sync_once(SyncSettings::default().set_presence(PresenceState::Offline))
                    .await
                    .map_err(Self::map_error)?;
                self.persist_session(&storage, &resolved_homeserver, &session)?;
                self.remember_account(&storage, &resolved_homeserver, &session)?;
                Ok::<_, BackendError>((client, resolved_homeserver, storage.profile_id.clone()))
            })
            .await
            {
                Ok(result) => result,
                Err(_) => Err(BackendError::RegistrationTimedOut(
                    REGISTRATION_TIMEOUT_SECONDS,
                )),
            };
        password.zeroize();
        if let Some(token) = &mut registration_token {
            token.zeroize();
        }

        let (client, resolved_homeserver, profile_id) = operation?;
        self.stop_runtime().await;
        self.install_client(client, resolved_homeserver, profile_id)
            .await;
        Ok(self.status().await)
    }

    async fn check_username_available(
        &self,
        homeserver: String,
        username: String,
    ) -> BackendResult<bool> {
        let username = Self::normalize_product_username(&username)?;
        let homeserver = Self::normalize_homeserver_input(&homeserver)?;
        let client = Client::builder()
            .server_name_or_homeserver_url(&homeserver)
            .build()
            .await
            .map_err(Self::map_error)?;
        let request = get_username_availability::v3::Request::new(username);
        match client.send(request).await {
            Ok(response) => Ok(response.available),
            Err(error) if matches!(error.client_api_error_kind(), Some(ErrorKind::UserInUse)) => {
                Ok(false)
            }
            Err(error) => Err(Self::map_error(error)),
        }
    }

    async fn service_capabilities(
        &self,
        homeserver: String,
    ) -> BackendResult<MatrixServiceCapabilities> {
        let homeserver = Self::normalize_homeserver_input(&homeserver)?;
        tokio::time::timeout(Duration::from_secs(20), async {
            let client = Client::builder()
                .server_name_or_homeserver_url(&homeserver)
                .build()
                .await
                .map_err(Self::map_error)?;
            let server_versions = client
                .server_versions()
                .await
                .map_err(Self::map_error)?
                .into_iter()
                .map(|version| format!("{version:?}"))
                .collect();
            let login_types = client
                .matrix_auth()
                .get_login_types()
                .await
                .map_err(Self::map_error)?;
            let password_login = login_types
                .flows
                .iter()
                .any(|flow| matches!(flow, LoginType::Password(_)));
            let browser_login = login_types
                .flows
                .iter()
                .any(|flow| matches!(flow, LoginType::Sso(_)));
            let registration_request = get_username_availability::v3::Request::new(
                "mesh-service-capability-probe".to_owned(),
            );
            let registration = match client.send(registration_request).await {
                Ok(_) => MatrixRegistrationAvailability::Open,
                Err(error)
                    if matches!(error.client_api_error_kind(), Some(ErrorKind::Forbidden)) =>
                {
                    MatrixRegistrationAvailability::Closed
                }
                Err(_) => MatrixRegistrationAvailability::Unknown,
            };
            let max_upload_bytes = client
                .load_or_fetch_max_upload_size()
                .await
                .ok()
                .map(u64::from);

            Ok(MatrixServiceCapabilities {
                homeserver: client.homeserver().to_string(),
                server_versions,
                password_login,
                browser_login,
                registration,
                max_upload_bytes,
            })
        })
        .await
        .map_err(|_| {
            BackendError::Network(
                "the selected account service did not respond to capability checks".into(),
            )
        })?
    }

    async fn oidc_status(&self, homeserver: String) -> BackendResult<MatrixOidcStatus> {
        self.discover_oidc(homeserver).await
    }

    async fn start_oidc_login(&self, homeserver: String) -> BackendResult<()> {
        let (status, registration) = self.discover_oidc_registration(homeserver).await?;
        if !status.ready {
            return Err(BackendError::InvalidConfiguration(format!(
                "Matrix browser sign-in is unavailable: {}. Password sign-in remains available for an existing account",
                status.reason
            )));
        }
        let registration = registration.ok_or_else(|| {
            BackendError::InvalidConfiguration(
                "Matrix browser sign-in has no issuer-specific desktop registration".into(),
            )
        })?;

        let attempt_id = self.login_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let cancellation = CancellationToken::new();
        {
            let mut active = self.login_attempt.lock().await;
            if let Some(previous) = active.replace(LoginAttempt {
                id: attempt_id,
                cancellation: cancellation.clone(),
            }) {
                previous.cancellation.cancel();
            }
        }

        let operation = async {
            let listener =
                oidc::bind_callback_listener()
                    .await
                    .map_err(|error| match error {
                        oidc::CallbackError::PortUnavailable => {
                            BackendError::InvalidConfiguration(
                                "Mesh cannot start browser sign-in because 127.0.0.1:8418 is already in use"
                                    .into(),
                            )
                        }
                        _ => BackendError::Other(
                            "Mesh could not start its local sign-in callback".into(),
                        ),
                    })?;
            oidc::EphemeralStore::remove_stale(&self.store_root).map_err(Self::map_error)?;
            let ephemeral_store =
                oidc::EphemeralStore::create(&self.store_root).map_err(Self::map_error)?;
            let client = tokio::select! {
                _ = cancellation.cancelled() => return Err(BackendError::LoginCancelled),
                result = tokio::time::timeout(
                    Duration::from_secs(LOGIN_TIMEOUT_SECONDS),
                    self.build_ephemeral_oauth_client(&status.homeserver, &ephemeral_store),
                ) => result
                    .map_err(|_| BackendError::LoginTimedOut(LOGIN_TIMEOUT_SECONDS))??,
            };
            let oauth = client.oauth();
            oauth.restore_registered_client(ClientId::new(registration.client_id().to_owned()));
            let redirect_uri =
                url::Url::parse(registration.redirect_uri()).map_err(Self::map_error)?;
            let authorization = tokio::select! {
                _ = cancellation.cancelled() => return Err(BackendError::LoginCancelled),
                result = oauth.login(redirect_uri, None, None, None).build() => {
                    result.map_err(|_| BackendError::Other(
                        "The Matrix authorization server could not start browser sign-in".into()
                    ))?
                }
            };

            if tauri_plugin_opener::open_url(authorization.url.as_str(), None::<&str>).is_err() {
                oauth.abort_login(&authorization.state).await;
                return Err(BackendError::Other(
                    "Mesh could not open the system browser for sign-in".into(),
                ));
            }

            let callback = match oidc::receive_callback(
                listener,
                cancellation.clone(),
                authorization.state.secret(),
            )
            .await
            {
                Ok(callback) => callback,
                Err(oidc::CallbackError::Cancelled) => {
                    oauth.abort_login(&authorization.state).await;
                    return Err(BackendError::LoginCancelled);
                }
                Err(oidc::CallbackError::TimedOut) => {
                    oauth.abort_login(&authorization.state).await;
                    return Err(BackendError::LoginTimedOut(
                        oidc::CALLBACK_TIMEOUT.as_secs(),
                    ));
                }
                Err(oidc::CallbackError::PortUnavailable) => unreachable!(),
                Err(_) => {
                    oauth.abort_login(&authorization.state).await;
                    return Err(BackendError::Other(
                        "Mesh rejected the local browser sign-in response".into(),
                    ));
                }
            };

            let finish_result = tokio::select! {
                _ = cancellation.cancelled() => {
                    oauth.abort_login(&authorization.state).await;
                    return Err(BackendError::LoginCancelled);
                }
                result = oauth.finish_login(UrlOrQuery::Url(callback)) => result,
            };
            if finish_result.is_err() {
                oauth.abort_login(&authorization.state).await;
                return Err(BackendError::Other(
                    "The Matrix authorization response was denied or could not be validated".into(),
                ));
            }

            let oauth_session = oauth.full_session().ok_or_else(|| {
                BackendError::Other(
                    "The Matrix authorization server returned no restorable OAuth session".into(),
                )
            })?;
            let resolved_homeserver = client.homeserver().to_string();
            let user_id = oauth_session.user.meta.user_id.to_string();
            let device_id = oauth_session.user.meta.device_id.to_string();
            let profile_id = if self.dynamic_accounts {
                Self::profile_id(&resolved_homeserver, &user_id)
            } else {
                self.profile_hint.clone()
            };
            if self
                .load_registry()?
                .accounts
                .iter()
                .any(|account| account.profile_id == profile_id)
            {
                let _ = oauth.logout().await;
                return Err(BackendError::InvalidConfiguration(
                    "This Matrix account is already saved in Mesh; use the saved-account switcher"
                        .into(),
                ));
            }

            drop(oauth);
            drop(client);
            drop(ephemeral_store);

            let storage = self.storage_for_profile(&profile_id);
            let durable_client = match self.build_client(&resolved_homeserver, &storage).await {
                Ok(client) => client,
                Err(error) => {
                    self.rollback_unregistered_oauth_storage(&storage)?;
                    return Err(error);
                }
            };
            if durable_client
                .oauth()
                .restore_session(oauth_session.clone(), RoomLoadSettings::default())
                .await
                .is_err()
            {
                let _ = durable_client.oauth().logout().await;
                drop(durable_client);
                self.rollback_unregistered_oauth_storage(&storage)?;
                return Err(BackendError::Other(
                    "Mesh could not restore the authorized account into its encrypted store".into(),
                ));
            }
            let sync_result = tokio::select! {
                _ = cancellation.cancelled() => Err(BackendError::LoginCancelled),
                result = tokio::time::timeout(
                    Duration::from_secs(LOGIN_TIMEOUT_SECONDS),
                    durable_client
                        .sync_once(SyncSettings::default().set_presence(PresenceState::Offline)),
                ) => result
                    .map_err(|_| BackendError::LoginTimedOut(LOGIN_TIMEOUT_SECONDS))?
                    .map(|_| ())
                    .map_err(Self::map_error),
            };
            if let Err(error) = sync_result {
                let _ = durable_client.oauth().logout().await;
                drop(durable_client);
                self.rollback_unregistered_oauth_storage(&storage)?;
                return Err(error);
            }

            let Some(current_session) = durable_client.oauth().full_session() else {
                let _ = durable_client.oauth().logout().await;
                drop(durable_client);
                self.rollback_unregistered_oauth_storage(&storage)?;
                return Err(BackendError::Other(
                    "The authorized Matrix account lost its restorable OAuth session".into(),
                ));
            };
            if let Err(error) =
                Self::persist_oauth_session(&storage, &resolved_homeserver, &current_session)
            {
                let _ = durable_client.oauth().logout().await;
                drop(durable_client);
                self.rollback_unregistered_oauth_storage(&storage)?;
                return Err(error);
            }
            if let Err(error) =
                self.register_account_identity(&storage, &resolved_homeserver, &user_id, &device_id)
            {
                let _ = durable_client.oauth().logout().await;
                drop(durable_client);
                self.rollback_unregistered_oauth_storage(&storage)?;
                return Err(error);
            }
            Ok::<_, BackendError>((durable_client, resolved_homeserver, profile_id))
        }
        .await;

        {
            let mut active = self.login_attempt.lock().await;
            if active
                .as_ref()
                .is_some_and(|attempt| attempt.id == attempt_id)
            {
                *active = None;
            }
        }

        let (client, resolved_homeserver, profile_id) = operation?;
        self.stop_runtime().await;
        self.install_client(client, resolved_homeserver, profile_id)
            .await;
        Ok(())
    }

    async fn cancel_login(&self) -> BackendResult<()> {
        if let Some(attempt) = self.login_attempt.lock().await.as_ref() {
            attempt.cancellation.cancel();
        }
        Ok(())
    }

    async fn restore_session(&self) -> BackendResult<BackendStatus> {
        let storage = self.active_storage_from_registry()?;
        let persisted = self.load_session(&storage)?;
        let homeserver = persisted.homeserver.clone();
        let profile_id = storage.profile_id.clone();
        let operation = async {
            let client = self.build_client(&homeserver, &storage).await?;
            client
                .restore_session(persisted.authentication.into_sdk_session())
                .await
                .map_err(Self::map_error)?;
            Self::sync_once_for_session_restore(&client).await?;
            Ok::<_, BackendError>(client)
        };
        let client = tokio::time::timeout(Duration::from_secs(LOGIN_TIMEOUT_SECONDS), operation)
            .await
            .map_err(|_| BackendError::LoginTimedOut(LOGIN_TIMEOUT_SECONDS))??;
        self.stop_runtime().await;
        self.install_client(client, homeserver, profile_id).await;
        Ok(self.status().await)
    }

    async fn logout(&self) -> BackendResult<()> {
        let client = self.client().await?;
        let profile_id = self
            .runtime
            .read()
            .await
            .profile_id
            .clone()
            .ok_or(BackendError::NotAuthenticated)?;
        let storage = self.storage_for_profile(&profile_id);
        match client.auth_api() {
            Some(AuthApi::Matrix(auth)) => {
                auth.logout().await.map_err(Self::map_error)?;
            }
            Some(AuthApi::OAuth(auth)) => {
                auth.logout().await.map_err(Self::map_error)?;
            }
            _ => return Err(BackendError::NotAuthenticated),
        }
        self.stop_runtime().await;
        let session_key = Self::session_key(&storage);
        if keychain::try_secret_exists(&session_key).map_err(Self::map_secure_storage_error)? {
            keychain::delete_secret(&session_key).map_err(Self::map_secure_storage_error)?;
        }
        let mut registry = self.load_registry()?;
        registry
            .accounts
            .retain(|account| account.profile_id != profile_id);
        registry.active_profile_id = None;
        self.persist_registry(&registry)?;
        Ok(())
    }

    async fn list_devices(&self) -> BackendResult<Vec<MatrixDevice>> {
        let client = self.client().await?;
        let current_device_id = client
            .device_id()
            .ok_or(BackendError::NotAuthenticated)?
            .to_owned();
        let user_id = client
            .user_id()
            .ok_or(BackendError::NotAuthenticated)?
            .to_owned();
        let registered = client.devices().await.map_err(Self::map_error)?;
        let crypto_devices = client
            .encryption()
            .get_user_devices(&user_id)
            .await
            .map_err(Self::map_error)?;
        let profile_id = self
            .runtime
            .read()
            .await
            .profile_id
            .clone()
            .ok_or(BackendError::NotAuthenticated)?;
        let storage = self.storage_for_profile(&profile_id);
        let mut trusted_devices = Self::load_trusted_devices(&storage)?;
        let mut trust_registry_changed = false;
        let mut devices = Vec::with_capacity(registered.devices.len());
        for device in registered.devices {
            let current = device.device_id == current_device_id;
            let crypto = crypto_devices.get(&device.device_id);
            let verified = current || crypto.as_ref().is_some_and(|item| item.is_verified());
            let cross_signed = crypto
                .as_ref()
                .is_some_and(|item| item.is_verified_with_cross_signing());
            let device_id = device.device_id.to_string();
            let fingerprint = crypto.as_ref().map(Self::device_fingerprint).transpose()?;
            let previous_fingerprint = trusted_devices.fingerprints.get(&device_id);
            let identity_changed = fingerprint.as_ref().is_some_and(|fingerprint| {
                previous_fingerprint.is_some_and(|previous| previous != fingerprint)
            }) && !cross_signed;
            let new_device = !current && previous_fingerprint.is_none();
            if verified && !identity_changed {
                if let Some(fingerprint) = fingerprint {
                    if previous_fingerprint != Some(&fingerprint) {
                        trusted_devices
                            .fingerprints
                            .insert(device_id.clone(), fingerprint);
                        trust_registry_changed = true;
                    }
                }
            }
            let first_seen_at = crypto.as_ref().and_then(|item| {
                let millis = u64::from(item.first_time_seen_ts().get());
                (millis > 0).then(|| Self::timestamp_from_millis(Some(millis)))
            });
            devices.push(MatrixDevice {
                device_id,
                display_name: device.display_name,
                last_seen_ip: device.last_seen_ip,
                last_seen_at: device
                    .last_seen_ts
                    .map(|timestamp| Self::timestamp_from_millis(Some(u64::from(timestamp.get())))),
                current,
                verified,
                cross_signed,
                first_seen_at,
                new_device,
                identity_changed,
            });
        }
        if trust_registry_changed {
            Self::persist_trusted_devices(&storage, &trusted_devices)?;
        }
        devices.sort_by(|left, right| {
            right
                .current
                .cmp(&left.current)
                .then_with(|| right.last_seen_at.cmp(&left.last_seen_at))
                .then_with(|| left.device_id.cmp(&right.device_id))
        });
        Ok(devices)
    }

    async fn revoke_device(&self, device_id: String, mut password: String) -> BackendResult<()> {
        let client = self.client().await?;
        if device_id.trim().is_empty() || password.is_empty() {
            password.zeroize();
            return Err(BackendError::InvalidConfiguration(
                "device ID and account password are required".into(),
            ));
        }
        if client
            .device_id()
            .is_some_and(|current| current.as_str() == device_id)
        {
            password.zeroize();
            return Err(BackendError::InvalidConfiguration(
                "use Sign out or Remove account for the current device".into(),
            ));
        }
        let user_id = match client.user_id() {
            Some(user_id) => user_id.to_string(),
            None => {
                password.zeroize();
                return Err(BackendError::NotAuthenticated);
            }
        };

        let devices = [OwnedDeviceId::from(device_id)];
        let first_attempt = client.delete_devices(&devices, None).await;
        let result = match first_attempt {
            Ok(_) => Ok(()),
            Err(error) => {
                let Some(info) = error.as_uiaa_response() else {
                    password.zeroize();
                    return Err(Self::map_error(error));
                };
                let mut password_auth = uiaa::Password::new(
                    uiaa::UserIdentifier::Matrix(uiaa::MatrixUserIdentifier::new(user_id)),
                    password.clone(),
                );
                password_auth.session = info.session.clone();
                client
                    .delete_devices(&devices, Some(uiaa::AuthData::Password(password_auth)))
                    .await
                    .map(|_| ())
                    .map_err(Self::map_error)
            }
        };
        password.zeroize();
        result.map(|_| ())
    }

    async fn remove_local_account(&self) -> BackendResult<()> {
        let runtime_profile_id = self.runtime.read().await.profile_id.clone();
        let profile_id = match runtime_profile_id {
            Some(profile_id) => profile_id,
            None => self
                .load_registry()?
                .active_profile_id
                .unwrap_or_else(|| "default".into()),
        };
        let storage = self.storage_for_profile(&profile_id);
        let plan = self.local_account_removal_plan(&storage)?;
        let client = self.stop_runtime().await;
        if let Some(client) = client {
            let logout_result = match client.auth_api() {
                Some(AuthApi::Matrix(auth)) => {
                    auth.logout().await.map(|_| ()).map_err(Self::map_error)
                }
                Some(AuthApi::OAuth(auth)) => auth.logout().await.map_err(Self::map_error),
                _ => Err(BackendError::NotAuthenticated),
            };
            if let Err(error) = logout_result {
                tracing::warn!(
                    target: "mesh::matrix",
                    "Remote logout failed during local account removal; continuing cryptographic erasure: {error}"
                );
            }
        }

        Self::erase_local_account_artifacts_with(
            &plan,
            |key| keychain::try_secret_exists(key).map_err(|error| error.to_string()),
            |key| keychain::delete_secret(key).map_err(|error| error.to_string()),
        )?;

        let mut registry = self.load_registry()?;
        Self::remove_account_from_registry(&mut registry, &plan.profile_id);
        self.persist_registry(&registry)?;
        Ok(())
    }

    async fn export_personal_data(
        &self,
        destination_root: PathBuf,
    ) -> BackendResult<MatrixPersonalDataExport> {
        self.write_personal_data_export(destination_root).await
    }

    async fn deactivate_account(
        &self,
        mut password: String,
        erase_data: bool,
    ) -> BackendResult<()> {
        if password.is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "account password is required".into(),
            ));
        }

        let remote_result: BackendResult<()> = async {
            // Validate every local deletion target before making the
            // irreversible remote request. A malformed registry must never
            // leave the account deactivated while Mesh still retains an
            // unvalidated local store.
            let profile_id = self
                .runtime
                .read()
                .await
                .profile_id
                .clone()
                .ok_or(BackendError::NotAuthenticated)?;
            let storage = self.storage_for_profile(&profile_id);
            self.local_account_removal_plan(&storage)?;

            let client = self.client().await?;
            let user_id = client
                .user_id()
                .ok_or(BackendError::NotAuthenticated)?
                .to_string();
            match client.account().deactivate(None, None, erase_data).await {
                Ok(_) => Ok(()),
                Err(error) => {
                    let Some(info) = error.as_uiaa_response() else {
                        return Err(Self::map_error(error));
                    };
                    let supports_password = info
                        .flows
                        .iter()
                        .any(|flow| flow.stages.iter().any(|stage| stage == &AuthType::Password));
                    if !supports_password {
                        return Err(BackendError::PermissionDenied(
                            "This account uses browser sign-in. Delete it from the account website until browser confirmation is available in Mesh.".into(),
                        ));
                    }
                    let mut password_auth = uiaa::Password::new(
                        uiaa::UserIdentifier::Matrix(uiaa::MatrixUserIdentifier::new(user_id)),
                        password.clone(),
                    );
                    password_auth.session = info.session.clone();
                    client
                        .account()
                        .deactivate(
                            None,
                            Some(uiaa::AuthData::Password(password_auth)),
                            erase_data,
                        )
                        .await
                        .map(|_| ())
                        .map_err(Self::map_error)
                }
            }
        }
        .await;
        password.zeroize();
        remote_result?;

        <Self as MeshBackend>::remove_local_account(self)
            .await
            .map_err(|error| {
                BackendError::Other(format!(
                    "Your account was deactivated, but Mesh could not finish removing its local data: {error}"
                ))
            })
    }

    async fn list_accounts(&self) -> BackendResult<Vec<MatrixAccount>> {
        let registry = self.load_registry()?;
        let current = self.runtime.read().await.profile_id.clone();
        let mut accounts = registry
            .accounts
            .into_iter()
            .map(|account| MatrixAccount {
                current: current.as_deref() == Some(account.profile_id.as_str()),
                profile_id: account.profile_id,
                user_id: account.user_id,
                homeserver: account.homeserver,
                device_id: account.device_id,
                last_used_at: account.last_used_at,
            })
            .collect::<Vec<_>>();
        accounts.sort_by(|left, right| right.last_used_at.cmp(&left.last_used_at));
        Ok(accounts)
    }

    async fn switch_account(&self, profile_id: String) -> BackendResult<BackendStatus> {
        if self.runtime.read().await.profile_id.as_deref() == Some(profile_id.as_str()) {
            return Ok(self.status().await);
        }
        let mut registry = self.load_registry()?;
        let account = registry
            .accounts
            .iter()
            .find(|account| account.profile_id == profile_id)
            .cloned()
            .ok_or_else(|| {
                BackendError::InvalidConfiguration("saved account was not found".into())
            })?;
        let storage = self.storage_for_profile(&profile_id);
        let persisted = self.load_session(&storage)?;
        let homeserver = persisted.homeserver.clone();
        let operation = async {
            let client = self.build_client(&homeserver, &storage).await?;
            client
                .restore_session(persisted.authentication.into_sdk_session())
                .await
                .map_err(Self::map_error)?;
            Self::sync_once_for_session_restore(&client).await?;
            Ok::<_, BackendError>(client)
        };
        let client = tokio::time::timeout(Duration::from_secs(LOGIN_TIMEOUT_SECONDS), operation)
            .await
            .map_err(|_| BackendError::LoginTimedOut(LOGIN_TIMEOUT_SECONDS))??;
        self.stop_runtime().await;
        self.install_client(client, homeserver, profile_id.clone())
            .await;

        registry.active_profile_id = Some(profile_id.clone());
        if let Some(saved) = registry
            .accounts
            .iter_mut()
            .find(|saved| saved.profile_id == account.profile_id)
        {
            saved.last_used_at = chrono::Utc::now().to_rfc3339();
        }
        self.persist_registry(&registry)?;
        Ok(self.status().await)
    }

    async fn get_profile(&self) -> BackendResult<MatrixProfile> {
        let client = self.client().await?;
        let user_id = client
            .user_id()
            .ok_or(BackendError::NotAuthenticated)?
            .to_string();
        let account = client.account();
        let display_name = account.get_display_name().await.map_err(Self::map_error)?;
        let avatar_url = account
            .get_avatar_url()
            .await
            .map_err(Self::map_error)?
            .map(|url| url.to_string());

        Ok(MatrixProfile {
            user_id,
            display_name,
            avatar_url,
        })
    }

    async fn update_profile_display_name(
        &self,
        display_name: String,
    ) -> BackendResult<MatrixProfile> {
        let display_name = Self::normalize_display_name(&display_name)?;
        let client = self.client().await?;
        client
            .account()
            .set_display_name(Some(&display_name))
            .await
            .map_err(Self::map_error)?;

        self.get_profile().await
    }

    async fn recovery_health(&self) -> BackendResult<MatrixRecoveryHealth> {
        let client = self.client().await?;
        let profile_id = self
            .runtime
            .read()
            .await
            .profile_id
            .clone()
            .ok_or(BackendError::NotAuthenticated)?;
        let storage = self.storage_for_profile(&profile_id);
        let last_successful_test_at = Self::load_last_recovery_test(&storage)?;
        let recovery_test_is_fresh = last_successful_test_at
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .is_some_and(|tested_at| {
                tested_at.with_timezone(&chrono::Utc)
                    >= chrono::Utc::now() - chrono::Duration::days(90)
            });
        let encryption = client.encryption();
        let recovery_state = encryption.recovery().state();
        let backups = encryption.backups();
        let backup_state = backups.state();
        let backup_enabled = backups.are_enabled().await;
        let mut warnings = Vec::new();
        let backup_exists_on_server =
            match tokio::time::timeout(Duration::from_secs(15), backups.fetch_exists_on_server())
                .await
            {
                Ok(Ok(exists)) => exists,
                Ok(Err(error)) => {
                    warnings.push(format!("Could not check the server backup: {error}"));
                    false
                }
                Err(_) => {
                    warnings.push("The server backup check timed out".into());
                    false
                }
            };
        if recovery_state == RecoveryState::Disabled {
            warnings.push("Recovery has not been enabled".into());
        } else if recovery_state == RecoveryState::Incomplete {
            warnings.push("Recovery is missing one or more identity secrets".into());
        }
        if !backup_enabled {
            warnings.push("This device is not actively backing up room keys".into());
        }
        if !backup_exists_on_server {
            warnings.push("No current server-side key backup was confirmed".into());
        }
        if last_successful_test_at.is_none() {
            warnings.push("Recovery credentials have not been tested on this device".into());
        } else if !recovery_test_is_fresh {
            warnings.push("The last successful recovery test is more than 90 days old".into());
        }
        let healthy = recovery_state == RecoveryState::Enabled
            && backup_state == BackupState::Enabled
            && backup_enabled
            && backup_exists_on_server
            && recovery_test_is_fresh
            && warnings.is_empty();
        Ok(MatrixRecoveryHealth {
            recovery_state: Self::recovery_state_name(recovery_state).into(),
            backup_state: Self::backup_state_name(backup_state).into(),
            backup_exists_on_server,
            backup_enabled,
            healthy,
            checked_at: chrono::Utc::now().to_rfc3339(),
            last_successful_test_at,
            warnings,
        })
    }

    async fn test_recovery(
        &self,
        mut recovery_key_or_passphrase: String,
    ) -> BackendResult<MatrixRecoveryHealth> {
        if recovery_key_or_passphrase.trim().is_empty() {
            recovery_key_or_passphrase.zeroize();
            return Err(BackendError::InvalidConfiguration(
                "recovery key or passphrase cannot be empty".into(),
            ));
        }
        let client = self.client().await?;
        let result = client
            .encryption()
            .recovery()
            .recover(recovery_key_or_passphrase.trim())
            .await
            .map_err(Self::map_error);
        recovery_key_or_passphrase.zeroize();
        result?;

        let profile_id = self
            .runtime
            .read()
            .await
            .profile_id
            .clone()
            .ok_or(BackendError::NotAuthenticated)?;
        let storage = self.storage_for_profile(&profile_id);
        let tested_at = chrono::Utc::now().to_rfc3339();
        Self::persist_last_recovery_test(&storage, &tested_at)?;
        self.recovery_health().await
    }

    async fn start_device_verification(
        &self,
        device_id: String,
    ) -> BackendResult<MatrixVerificationSession> {
        let client = self.client().await?;
        let own_user_id = client
            .user_id()
            .ok_or(BackendError::NotAuthenticated)?
            .to_owned();
        if client
            .device_id()
            .is_some_and(|current| current.as_str() == device_id)
        {
            return Err(BackendError::InvalidConfiguration(
                "the current device cannot verify itself".into(),
            ));
        }
        let owned_device_id = OwnedDeviceId::from(device_id);
        let device = client
            .encryption()
            .get_device(&own_user_id, &owned_device_id)
            .await
            .map_err(Self::map_error)?
            .ok_or_else(|| {
                BackendError::InvalidConfiguration("device keys are not available yet".into())
            })?;
        let request = device
            .request_verification()
            .await
            .map_err(Self::map_error)?;
        let verification_id = uuid::Uuid::new_v4().to_string();
        let flow = DeviceVerificationFlow::Request {
            request,
            device_id: owned_device_id.to_string(),
        };
        let snapshot = Self::verification_snapshot(verification_id.clone(), &flow)?;
        self.verification_sessions
            .write()
            .await
            .insert(verification_id, flow);
        Ok(snapshot)
    }

    async fn device_verification_status(
        &self,
        verification_id: String,
    ) -> BackendResult<MatrixVerificationSession> {
        let mut sessions = self.verification_sessions.write().await;
        let flow = sessions.get_mut(&verification_id).ok_or_else(|| {
            BackendError::InvalidConfiguration("verification session was not found".into())
        })?;
        if let DeviceVerificationFlow::Request { request, .. } = flow {
            if let VerificationRequestState::Transitioned { verification } = request.state() {
                *flow = match verification {
                    Verification::SasV1(sas) => DeviceVerificationFlow::Sas(sas),
                    Verification::QrV1(qr) => DeviceVerificationFlow::Qr(qr),
                    _ => {
                        return Err(BackendError::Unsupported(
                            "unrecognized Matrix device verification method",
                        ));
                    }
                };
            }
        }
        Self::verification_snapshot(verification_id, flow)
    }

    async fn select_device_verification_method(
        &self,
        verification_id: String,
        method: String,
    ) -> BackendResult<MatrixVerificationSession> {
        let request = match self
            .verification_sessions
            .read()
            .await
            .get(&verification_id)
            .cloned()
            .ok_or_else(|| {
                BackendError::InvalidConfiguration("verification session was not found".into())
            })? {
            DeviceVerificationFlow::Request { request, .. } => request,
            _ => {
                return Err(BackendError::InvalidConfiguration(
                    "a verification method has already been selected".into(),
                ));
            }
        };

        let flow = match method.trim().to_ascii_lowercase().as_str() {
            "sas" => DeviceVerificationFlow::Sas(
                request
                    .start_sas()
                    .await
                    .map_err(Self::map_error)?
                    .ok_or_else(|| {
                        BackendError::InvalidConfiguration(
                            "emoji verification is not ready on the other device".into(),
                        )
                    })?,
            ),
            "qr" => DeviceVerificationFlow::Qr(
                request
                    .generate_qr_code()
                    .await
                    .map_err(Self::map_error)?
                    .ok_or_else(|| {
                        BackendError::InvalidConfiguration(
                            "QR verification is not ready or supported on the other device".into(),
                        )
                    })?,
            ),
            _ => {
                return Err(BackendError::InvalidConfiguration(
                    "verification method must be `sas` or `qr`".into(),
                ));
            }
        };

        let snapshot = Self::verification_snapshot(verification_id.clone(), &flow)?;
        self.verification_sessions
            .write()
            .await
            .insert(verification_id, flow);
        Ok(snapshot)
    }

    async fn confirm_device_verification(
        &self,
        verification_id: String,
        matches: bool,
    ) -> BackendResult<MatrixVerificationSession> {
        let flow = self
            .verification_sessions
            .read()
            .await
            .get(&verification_id)
            .cloned()
            .ok_or_else(|| {
                BackendError::InvalidConfiguration("verification session was not found".into())
            })?;
        match &flow {
            DeviceVerificationFlow::Request { .. } => {
                return Err(BackendError::InvalidConfiguration(
                    "choose a verification method before confirming".into(),
                ));
            }
            DeviceVerificationFlow::Sas(sas) => {
                if matches {
                    sas.confirm().await.map_err(Self::map_error)?;
                } else {
                    sas.mismatch().await.map_err(Self::map_error)?;
                }
            }
            DeviceVerificationFlow::Qr(qr) => {
                if matches {
                    qr.confirm().await.map_err(Self::map_error)?;
                } else {
                    qr.cancel().await.map_err(Self::map_error)?;
                }
            }
        }
        Self::verification_snapshot(verification_id, &flow)
    }

    async fn cancel_device_verification(&self, verification_id: String) -> BackendResult<()> {
        let flow = self
            .verification_sessions
            .write()
            .await
            .remove(&verification_id)
            .ok_or_else(|| {
                BackendError::InvalidConfiguration("verification session was not found".into())
            })?;
        match flow {
            DeviceVerificationFlow::Request { request, .. } => {
                request.cancel().await.map_err(Self::map_error)
            }
            DeviceVerificationFlow::Sas(sas) => sas.cancel().await.map_err(Self::map_error),
            DeviceVerificationFlow::Qr(qr) => qr.cancel().await.map_err(Self::map_error),
        }
    }

    async fn create_community(
        &self,
        name: String,
        description: String,
    ) -> BackendResult<CreatedCommunity> {
        if name.trim().is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "community name cannot be empty".into(),
            ));
        }
        let client = self.client().await?;
        let user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let via = vec![user_id.server_name().to_owned()];

        let mut space_creation = CreationContent::new();
        space_creation.room_type = Some(RoomType::Space);
        let mut space_request = CreateRoomRequest::new();
        space_request.name = Some(name.trim().to_owned());
        space_request.topic =
            (!description.trim().is_empty()).then(|| description.trim().to_owned());
        space_request.preset = Some(RoomPreset::PrivateChat);
        space_request.creation_content = Some(Raw::new(&space_creation).map_err(Self::map_error)?);
        space_request.power_level_content_override =
            Some(Self::community_role_power_level_override()?);
        space_request.initial_state = vec![Self::encrypted_room_initial_state()];
        let space = client
            .create_room(space_request)
            .await
            .map_err(Self::map_error)?;

        let mut parent = SpaceParentEventContent::new(via.clone());
        parent.canonical = true;

        let mut channel_request = CreateRoomRequest::new();
        channel_request.name = Some("general".into());
        channel_request.topic = Some(format!("General discussion for {}", name.trim()));
        channel_request.preset = Some(RoomPreset::PrivateChat);
        channel_request.power_level_content_override =
            Some(Self::community_role_power_level_override()?);
        channel_request.initial_state = vec![
            Self::encrypted_room_initial_state(),
            Self::community_channel_join_rule_initial_state(space.room_id()),
            InitialStateEvent::new(space.room_id().to_owned(), parent).to_raw_any(),
        ];
        let channel = client
            .create_room(channel_request)
            .await
            .map_err(Self::map_error)?;

        let mut child = SpaceChildEventContent::new(via);
        child.suggested = true;
        space
            .send_state_event_for_key(channel.room_id(), child)
            .await
            .map_err(Self::map_error)?;

        Ok(CreatedCommunity {
            space_id: space.room_id().to_string(),
            channel_id: channel.room_id().to_string(),
            name: name.trim().to_owned(),
        })
    }

    async fn list_communities(&self) -> BackendResult<Vec<CommunityDto>> {
        let client = self.client().await?;
        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let mut communities = Vec::new();

        for room in client
            .joined_rooms()
            .into_iter()
            .filter(|room| room.is_space())
        {
            if room.successor_room().is_some() {
                continue;
            }
            Self::require_protected_room(&room, "listing communities").await?;
            let role = if room
                .creators()
                .is_some_and(|creators| creators.iter().any(|creator| creator == own_user_id))
            {
                "owner"
            } else {
                match room
                    .get_member(own_user_id)
                    .await
                    .map_err(Self::map_error)?
                    .map(|member| member.suggested_role_for_power_level())
                {
                    Some(RoomMemberRole::Creator) => "owner",
                    Some(RoomMemberRole::Administrator | RoomMemberRole::Moderator) => "admin",
                    _ => "member",
                }
            };

            communities.push(CommunityDto {
                id: room.room_id().to_string(),
                name: room.name().unwrap_or_else(|| "Unnamed community".into()),
                description: room.topic().unwrap_or_default(),
                member_count: room.joined_members_count().min(u32::MAX as u64) as u32,
                role: role.into(),
                joined_at: None,
            });
        }

        communities.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(communities)
    }

    async fn list_channels(&self, community_id: String) -> BackendResult<Vec<ChannelDto>> {
        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(&community_id).map_err(Self::map_error)?;
        let space =
            Self::protected_joined_room(&client, &space_id, "opening this community").await?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community ID does not identify a Matrix Space".into(),
            ));
        }

        let mut channels = Vec::new();
        let mut listed_room_ids = BTreeSet::new();
        for child_id in self.space_child_ids(&space).await? {
            let room = match Self::protected_joined_room(
                &client,
                &child_id,
                "opening this community channel",
            )
            .await
            {
                Ok(room) => room,
                Err(BackendError::NotFound(_)) => continue,
                Err(error) => return Err(error),
            };
            if room.is_space() {
                continue;
            }
            let room = self
                .joined_room_upgrade_chain(&client, room, "opening this community channel")
                .await?
                .pop()
                .expect("the room upgrade chain always contains its starting room");
            if !listed_room_ids.insert(room.room_id().to_owned()) {
                continue;
            }

            channels.push(ChannelDto {
                id: room.room_id().to_string(),
                community_id: community_id.clone(),
                name: room.name().unwrap_or_else(|| "unnamed".into()),
                channel_type: if room
                    .room_type()
                    .is_some_and(|room_type| room_type.as_str() == "org.mesh.voice")
                {
                    "voice".into()
                } else {
                    "text".into()
                },
                unread_count: room.num_unread_messages().min(u32::MAX as u64) as u32,
            });
        }

        channels.sort_by(|left, right| {
            let left_general = left.name.eq_ignore_ascii_case("general");
            let right_general = right.name.eq_ignore_ascii_case("general");
            right_general
                .cmp(&left_general)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(channels)
    }

    async fn create_channel(
        &self,
        community_id: String,
        name: String,
        channel_type: String,
    ) -> BackendResult<ChannelDto> {
        if channel_type != "text" && channel_type != "voice" {
            return Err(BackendError::InvalidConfiguration(
                "channel type must be text or voice".into(),
            ));
        }
        if name.trim().is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "channel name cannot be empty".into(),
            ));
        }

        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(&community_id).map_err(Self::map_error)?;
        let space =
            Self::protected_joined_room(&client, &space_id, "adding a community channel").await?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community ID does not identify a Matrix Space".into(),
            ));
        }

        let user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let via = vec![user_id.server_name().to_owned()];
        let mut parent = SpaceParentEventContent::new(via.clone());
        parent.canonical = true;

        let mut request = CreateRoomRequest::new();
        request.name = Some(name.trim().to_owned());
        request.preset = Some(RoomPreset::PrivateChat);
        request.power_level_content_override = Some(Self::community_role_power_level_override()?);
        if channel_type == "voice" {
            let mut creation = CreationContent::new();
            creation.room_type = Some("org.mesh.voice".into());
            request.creation_content = Some(Raw::new(&creation).map_err(Self::map_error)?);
        }
        request.initial_state = vec![
            Self::encrypted_room_initial_state(),
            Self::community_channel_join_rule_initial_state(space.room_id()),
            InitialStateEvent::new(space.room_id().to_owned(), parent).to_raw_any(),
        ];
        let channel = client.create_room(request).await.map_err(Self::map_error)?;

        let mut child = SpaceChildEventContent::new(via);
        child.suggested = true;
        space
            .send_state_event_for_key(channel.room_id(), child)
            .await
            .map_err(Self::map_error)?;

        Ok(ChannelDto {
            id: channel.room_id().to_string(),
            community_id,
            name: name.trim().to_owned(),
            channel_type,
            unread_count: 0,
        })
    }

    async fn list_custom_emoji(&self, community_id: String) -> BackendResult<Vec<CustomEmoji>> {
        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(&community_id).map_err(Self::map_error)?;
        let space = Self::protected_joined_room(&client, &space_id, "reading server emoji").await?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community ID does not identify a server".into(),
            ));
        }
        let pack = Self::custom_emoji_pack(&space).await?;
        if pack.images.len() > MAX_CUSTOM_EMOJI_COUNT {
            return Err(BackendError::InvalidConfiguration(
                "server emoji settings exceed the 100-item limit".into(),
            ));
        }
        pack.images
            .iter()
            .map(|(shortcode, image)| Self::custom_emoji_info(shortcode, image))
            .collect()
    }

    async fn upload_custom_emoji(
        &self,
        community_id: String,
        shortcode: String,
        filename: String,
        content_type: String,
        bytes: Vec<u8>,
    ) -> BackendResult<CustomEmoji> {
        let shortcode = Self::normalize_custom_emoji_shortcode(&shortcode)?;
        let sanitized = Self::sanitize_custom_emoji(&bytes, content_type.trim(), filename.trim())?;
        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(&community_id).map_err(Self::map_error)?;
        let space = Self::protected_joined_room(&client, &space_id, "adding server emoji").await?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community ID does not identify a server".into(),
            ));
        }

        let _write = self.custom_emoji_writes.lock().await;
        let mut pack = Self::custom_emoji_pack(&space).await?;
        if pack.images.len() >= MAX_CUSTOM_EMOJI_COUNT && !pack.images.contains_key(&shortcode) {
            return Err(BackendError::InvalidConfiguration(
                "this server already has 100 custom emoji".into(),
            ));
        }
        if pack.images.contains_key(&shortcode) {
            return Err(BackendError::InvalidConfiguration(
                "that emoji name is already in use".into(),
            ));
        }

        let size_bytes = sanitized.bytes.len();
        let width = sanitized.width;
        let height = sanitized.height;
        let upload = client
            .media()
            .upload(&mime::IMAGE_PNG, sanitized.bytes, None)
            .await
            .map_err(Self::map_error)?;
        let mut info = ImageInfo::new();
        info.width = Some(UInt::try_from(u64::from(sanitized.width)).map_err(Self::map_error)?);
        info.height = Some(UInt::try_from(u64::from(sanitized.height)).map_err(Self::map_error)?);
        info.mimetype = Some("image/png".into());
        let mut image = PackImage::new(upload.content_uri);
        image.body = Some(shortcode.clone());
        image.info = Some(info);
        image.usage = BTreeSet::from([PackUsage::Emoticon]);
        let content = image.url.to_string();
        if let Some(info) = image.info.as_mut() {
            info.size = Some(UInt::try_from(size_bytes as u64).map_err(Self::map_error)?);
        }
        pack.images.insert(shortcode.clone(), image);
        let mut pack_info = PackInfo::new();
        pack_info.display_name = Some(CUSTOM_EMOJI_PACK_NAME.into());
        pack_info.usage = BTreeSet::from([PackUsage::Emoticon]);
        pack.pack = Some(pack_info);
        space
            .send_state_event_for_key(CUSTOM_EMOJI_PACK_STATE_KEY, pack)
            .await
            .map_err(Self::map_error)?;

        Ok(CustomEmoji {
            shortcode: shortcode.clone(),
            body: shortcode,
            mxc_uri: content,
            content_type: "image/png".into(),
            width,
            height,
            size_bytes: size_bytes as u32,
        })
    }

    async fn remove_custom_emoji(
        &self,
        community_id: String,
        shortcode: String,
    ) -> BackendResult<()> {
        let shortcode = Self::normalize_custom_emoji_shortcode(&shortcode)?;
        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(&community_id).map_err(Self::map_error)?;
        let space =
            Self::protected_joined_room(&client, &space_id, "removing server emoji").await?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community ID does not identify a server".into(),
            ));
        }
        let _write = self.custom_emoji_writes.lock().await;
        let mut pack = Self::custom_emoji_pack(&space).await?;
        if pack.images.remove(&shortcode).is_none() {
            return Err(BackendError::NotFound("server emoji was not found".into()));
        }
        space
            .send_state_event_for_key(CUSTOM_EMOJI_PACK_STATE_KEY, pack)
            .await
            .map_err(Self::map_error)?;
        Ok(())
    }

    async fn load_custom_emoji_image(
        &self,
        community_id: String,
        shortcode: String,
    ) -> BackendResult<Vec<u8>> {
        let shortcode = Self::normalize_custom_emoji_shortcode(&shortcode)?;
        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(&community_id).map_err(Self::map_error)?;
        let space = Self::protected_joined_room(&client, &space_id, "loading server emoji").await?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community ID does not identify a server".into(),
            ));
        }
        let pack = Self::custom_emoji_pack(&space).await?;
        let image = pack
            .images
            .get(&shortcode)
            .ok_or_else(|| BackendError::NotFound("server emoji was not found".into()))?;
        Self::custom_emoji_info(&shortcode, image)?;
        Self::download_custom_emoji(&client, &image.url).await
    }

    async fn matrix_rtc_join(&self, room_id: String) -> BackendResult<MatrixRtcJoinResult> {
        // This guard is deliberately enforced in Rust before publishing call
        // membership or requesting an SFU token. Renderer capability checks
        // are UX only and cannot protect against a compromised webview.
        Self::require_matrix_rtc_media_e2ee_ready()?;
        let status = Self::matrix_rtc_config()?;
        let configured_service_url = status.livekit_service_url.as_deref().ok_or_else(|| {
            BackendError::InvalidConfiguration(
                "MatrixRTC authorization service URL is not configured".into(),
            )
        })?;
        let expected_sfu_url = status.livekit_sfu_url.as_deref().ok_or_else(|| {
            BackendError::InvalidConfiguration("MatrixRTC LiveKit URL is not configured".into())
        })?;
        let client = self.client().await?;
        let parsed_room_id = matrix_sdk::ruma::RoomId::parse(&room_id).map_err(Self::map_error)?;
        let room =
            Self::protected_joined_room(&client, &parsed_room_id, "joining a MatrixRTC call")
                .await?;
        let discovered = Self::discover_matrix_rtc_service_url(&client).await?;
        let configured_service = VoiceServiceStatus::secure_url(
            "MESH_MATRIXRTC_LIVEKIT_SERVICE_URL",
            configured_service_url,
            "https",
        )
        .map_err(BackendError::InvalidConfiguration)?;
        let discovered_service = VoiceServiceStatus::secure_url(
            "discovered MatrixRTC LiveKit service URL",
            &discovered.service_url,
            "https",
        )
        .map_err(BackendError::InvalidConfiguration)?;
        if discovered_service != configured_service {
            return Err(BackendError::InvalidConfiguration(format!(
                "MESH_MATRIXRTC_LIVEKIT_SERVICE_URL does not match the {} LiveKit service URL discovered from the homeserver",
                discovered.source.label()
            )));
        }
        let livekit_service_url =
            Self::select_matrix_rtc_service_url(&room, configured_service_url).await?;
        let user_id = client
            .user_id()
            .ok_or(BackendError::NotAuthenticated)?
            .to_owned();
        let device_id = client
            .device_id()
            .ok_or(BackendError::NotAuthenticated)?
            .to_owned();
        let member_id = uuid::Uuid::new_v4().to_string();
        let state_key =
            CallMemberStateKey::new(user_id.clone(), Some(format!("{device_id}_m.call")), true);
        let state_key = state_key.as_ref().to_owned();
        let session_id = uuid::Uuid::new_v4().to_string();
        let cancellation = CancellationToken::new();
        let session = MatrixRtcLocalSession {
            room: room.clone(),
            device_id: device_id.clone(),
            session_id: session_id.clone(),
            state_key: state_key.clone(),
            member_id: member_id.clone(),
            livekit_service_url: livekit_service_url.clone(),
            created_ts: matrix_sdk::ruma::MilliSecondsSinceUnixEpoch::now(),
            cancellation: cancellation.clone(),
            ready: false,
        };

        let stale_session_keys = {
            let mut sessions = self.rtc_sessions.lock().await;
            let stale_keys = sessions
                .iter()
                .filter(|(_, active)| {
                    active.room.room_id() == room.room_id() && active.state_key == state_key
                })
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            for stale_key in &stale_keys {
                if let Some(previous) = sessions.remove(stale_key) {
                    previous.cancellation.cancel();
                }
            }
            sessions.insert((room_id.clone(), session_id.clone()), session.clone());
            stale_keys
        };
        {
            let mut media_keys = self.rtc_media_keys.lock().await;
            media_keys
                .outbound
                .retain(|key, _| !stale_session_keys.contains(key));
            media_keys
                .pending_activations
                .retain(|key, _| !stale_session_keys.contains(key));
            media_keys
                .completed_activations
                .retain(|key, _| !stale_session_keys.contains(key));
            media_keys
                .lease_blocked
                .retain(|key| !stale_session_keys.contains(key));
        }
        Self::reconcile_matrix_sync_cadence(
            &self.rtc_sessions,
            &self.matrix_sync_control,
            &self.matrix_sync_freshness,
        )
        .await;
        if let Err(error) = Self::publish_current_matrix_rtc_membership(
            &session,
            &self.rtc_sessions,
            &self.rtc_membership_writes,
            true,
        )
        .await
        {
            if let Err(cleanup_error) = Self::clear_current_matrix_rtc_membership(
                &session,
                &self.rtc_sessions,
                &self.rtc_membership_writes,
            )
            .await
            {
                tracing::warn!(
                    target: "mesh::matrixrtc",
                    "Could not clear an ambiguously published MatrixRTC membership: {cleanup_error}"
                );
                self.rtc_sessions
                    .lock()
                    .await
                    .remove(&(room_id.clone(), session_id.clone()));
            }
            return Err(error);
        }
        let token = match Self::exchange_matrix_rtc_token(
            &client,
            &room_id,
            &member_id,
            &user_id,
            &device_id,
            &livekit_service_url,
            expected_sfu_url,
        )
        .await
        {
            Ok(token) => token,
            Err(error) => {
                if let Err(leave_error) = Self::clear_current_matrix_rtc_membership(
                    &session,
                    &self.rtc_sessions,
                    &self.rtc_membership_writes,
                )
                .await
                {
                    tracing::warn!(
                        target: "mesh::matrixrtc",
                        "Could not clear failed MatrixRTC join membership: {leave_error}"
                    );
                }
                return Err(error);
            }
        };

        let memberships = match Self::active_matrix_rtc_memberships(&room).await {
            Ok(memberships) => memberships,
            Err(error) => {
                let _ = Self::clear_current_matrix_rtc_membership(
                    &session,
                    &self.rtc_sessions,
                    &self.rtc_membership_writes,
                )
                .await;
                return Err(error);
            }
        };
        let media_key = match Self::create_initial_matrix_rtc_media_key(
            &client,
            &session,
            &memberships,
            &self.rtc_media_keys,
        )
        .await
        {
            Ok(key) => key,
            Err(error) => {
                if let Err(leave_error) = Self::clear_current_matrix_rtc_membership(
                    &session,
                    &self.rtc_sessions,
                    &self.rtc_membership_writes,
                )
                .await
                {
                    tracing::warn!(
                        target: "mesh::matrixrtc",
                        "Could not clear failed MatrixRTC key setup membership: {leave_error}"
                    );
                }
                return Err(error);
            }
        };
        let state_key = (room_id.clone(), session_id.clone());
        let activated = {
            let mut sessions = self.rtc_sessions.lock().await;
            sessions.get_mut(&state_key).is_some_and(|active| {
                if active.member_id != member_id || active.cancellation.is_cancelled() {
                    return false;
                }
                active.ready = true;
                true
            })
        };
        if !activated {
            let mut media_keys = self.rtc_media_keys.lock().await;
            Self::revoke_matrix_rtc_publication(&mut media_keys, &state_key);
            return Err(BackendError::PermissionDenied(
                "MatrixRTC join was cancelled before publication became active".into(),
            ));
        }
        Self::reconcile_matrix_sync_cadence(
            &self.rtc_sessions,
            &self.matrix_sync_control,
            &self.matrix_sync_freshness,
        )
        .await;
        let pending_keys = self
            .rtc_media_keys
            .lock()
            .await
            .pending
            .remove(&room_id)
            .unwrap_or_default();
        for pending_key in pending_keys {
            Self::dispatch_backend_event(
                &self.event_callback,
                MatrixBackendEvent::RtcMediaKey(pending_key),
            );
        }
        Self::spawn_matrix_rtc_membership_refresh(
            session,
            Arc::clone(&self.rtc_sessions),
            Arc::clone(&self.rtc_membership_writes),
            Arc::clone(&self.event_callback),
        );
        Self::emit_matrix_rtc_membership(&room, &self.event_callback).await;

        Ok(MatrixRtcJoinResult {
            room_id: room_id.clone(),
            session_id,
            member_id: member_id.clone(),
            url: token.url,
            token: token.jwt,
            room_name: Self::matrix_rtc_room_name(&room_id)?,
            participant_identity: Self::matrix_rtc_participant_identity(
                user_id.as_str(),
                device_id.as_str(),
                &member_id,
            )?,
            media_e2ee_verified: false,
            media_key,
        })
    }

    async fn matrix_rtc_refresh_membership(
        &self,
        room_id: String,
        session_id: String,
    ) -> BackendResult<Vec<MatrixRtcMember>> {
        let session = self
            .rtc_sessions
            .lock()
            .await
            .get(&(room_id.clone(), session_id))
            .cloned()
            .ok_or_else(|| {
                BackendError::NotFound("MatrixRTC session is not active on this device".into())
            })?;
        if !Self::publish_current_matrix_rtc_membership(
            &session,
            &self.rtc_sessions,
            &self.rtc_membership_writes,
            true,
        )
        .await?
        {
            return Err(BackendError::NotFound(
                "MatrixRTC session membership epoch is no longer current".into(),
            ));
        }
        let members = Self::matrix_rtc_members_for_room(&session.room).await?;
        let matrix_sync = MatrixSyncCoordinator {
            control: Arc::clone(&self.matrix_sync_control),
            freshness: Arc::clone(&self.matrix_sync_freshness),
        };
        Self::sync_matrix_rtc_media_keys_for_room(
            &session.room,
            &self.rtc_sessions,
            &self.rtc_media_keys,
            &self.rtc_membership_writes,
            &matrix_sync,
            &self.event_callback,
        )
        .await?;
        Self::dispatch_backend_event(
            &self.event_callback,
            MatrixBackendEvent::RtcMembership(MatrixRtcMembershipUpdate {
                room_id,
                members: members.clone(),
            }),
        );
        Ok(members)
    }

    async fn matrix_rtc_ack_media_key_pause(
        &self,
        room_id: String,
        session_id: String,
        member_id: String,
        activation_id: String,
    ) -> BackendResult<MatrixRtcMediaKey> {
        self.ack_matrix_rtc_media_key_pause_inner(&room_id, &session_id, &member_id, &activation_id)
            .await
    }

    async fn matrix_rtc_ack_media_key(
        &self,
        room_id: String,
        session_id: String,
        member_id: String,
        activation_id: String,
        key_index: u8,
        sent_ts: u64,
    ) -> BackendResult<()> {
        self.ack_matrix_rtc_media_key_inner(
            &room_id,
            &session_id,
            &member_id,
            &activation_id,
            key_index,
            sent_ts,
        )
        .await
    }

    async fn matrix_rtc_renew_media_key_lease(
        &self,
        room_id: String,
        session_id: String,
        member_id: String,
    ) -> BackendResult<MatrixRtcMediaKeyLease> {
        self.renew_matrix_rtc_media_key_lease_inner(&room_id, &session_id, &member_id)
            .await
    }

    async fn matrix_rtc_leave(&self, room_id: String, session_id: String) -> BackendResult<()> {
        let key = (room_id, session_id);
        let session = {
            let mut sessions = self.rtc_sessions.lock().await;
            let Some(active) = sessions.get_mut(&key) else {
                return Ok(());
            };
            active.ready = false;
            active.clone()
        };
        session.cancellation.cancel();
        {
            let mut media_keys = self.rtc_media_keys.lock().await;
            Self::revoke_matrix_rtc_publication(&mut media_keys, &key);
        }
        Self::reconcile_matrix_sync_cadence(
            &self.rtc_sessions,
            &self.matrix_sync_control,
            &self.matrix_sync_freshness,
        )
        .await;
        if !Self::clear_current_matrix_rtc_membership(
            &session,
            &self.rtc_sessions,
            &self.rtc_membership_writes,
        )
        .await?
        {
            return Ok(());
        }
        let room_still_active = self
            .rtc_sessions
            .lock()
            .await
            .keys()
            .any(|(active_room_id, _)| active_room_id == &key.0);
        {
            let mut media_keys = self.rtc_media_keys.lock().await;
            if !room_still_active {
                media_keys
                    .inbound
                    .retain(|(active_room_id, _, _, _), _| active_room_id != &key.0);
                media_keys.pending.remove(&key.0);
            }
        }
        Self::emit_matrix_rtc_membership(&session.room, &self.event_callback).await;
        Ok(())
    }

    async fn matrix_rtc_members(&self, room_id: String) -> BackendResult<Vec<MatrixRtcMember>> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room =
            Self::protected_joined_room(&client, &room_id, "reading MatrixRTC membership").await?;
        Self::matrix_rtc_members_for_room(&room).await
    }

    async fn send_text(&self, room_id: String, body: String) -> BackendResult<SentMessage> {
        if body.trim().is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "message body cannot be empty".into(),
            ));
        }
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room = Self::protected_joined_room(&client, &room_id, "sending a message").await?;
        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let mentions = Self::mentions_for_body(body.as_str(), Some(own_user_id));
        let content = RoomMessageEventContent::text_plain(body).add_mentions(mentions);
        let transaction_id = Self::validate_transaction_id(&uuid::Uuid::new_v4().to_string())?;
        let response = room
            .send(content)
            .with_transaction_id(transaction_id)
            .await
            .map_err(Self::map_error)?;
        Ok(SentMessage {
            event_id: response.response.event_id.to_string(),
            room_id: room.room_id().to_string(),
        })
    }

    async fn send_message(
        &self,
        room_id: String,
        body: String,
        reply_to_id: Option<String>,
        thread_root_id: Option<String>,
        transaction_id: String,
    ) -> BackendResult<MessageDto> {
        if body.trim().is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "message body cannot be empty".into(),
            ));
        }

        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let action = if reply_to_id.is_some() {
            "sending a reply"
        } else {
            "sending a message"
        };
        let room = Self::existing_protected_text_channel(&client, &room_id, action).await?;
        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let base_content = RoomMessageEventContentWithoutRelation::text_plain(body.clone())
            .add_mentions(Self::mentions_for_body(body.as_str(), Some(own_user_id)));

        let content = match reply_to_id.as_deref() {
            Some(event_id) => {
                let event_id =
                    matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
                let is_thread_root_reply = thread_root_id.as_deref() == Some(event_id.as_str());
                room.make_reply_event(
                    base_content,
                    Reply {
                        event_id,
                        enforce_thread: if is_thread_root_reply {
                            EnforceThread::Threaded(ReplyWithinThread::No)
                        } else if thread_root_id.is_some() {
                            EnforceThread::Threaded(ReplyWithinThread::Yes)
                        } else {
                            EnforceThread::Unthreaded
                        },
                        add_mentions: AddMentions::Yes,
                    },
                )
                .await
                .map_err(Self::map_error)?
            }
            None => base_content.into(),
        };
        let client_request_id = Self::validate_transaction_id(&transaction_id)?.to_string();
        let _queue_gate = self.send_queue_gate.lock().await;
        let queue = room.send_queue();
        // Keep the queue asleep until the event is durably present and its SDK
        // transaction ID has been recovered from the encrypted local echo.
        queue.set_enabled(false);
        let (existing_echoes, _) = queue.subscribe().await.map_err(Self::map_error)?;
        for echo in existing_echoes {
            if Self::queued_client_request_id(&echo).as_deref() != Some(client_request_id.as_str())
            {
                continue;
            }
            if let Some(message) =
                Self::queued_message_from_local_echo(&client, &room, &echo).await?
            {
                let last_success_ms =
                    Self::lock_matrix_sync_freshness(&self.matrix_sync_freshness).last_success_ms;
                queue.set_enabled(Self::matrix_sync_is_fresh(
                    last_success_ms,
                    Self::matrix_rtc_monotonic_now_ms(),
                ));
                return Ok(message);
            }
        }

        let mut raw_content = serde_json::to_value(&content).map_err(Self::map_error)?;
        raw_content
            .as_object_mut()
            .ok_or_else(|| {
                BackendError::InvalidConfiguration(
                    "queued message content was not an object".into(),
                )
            })?
            .insert(
                CLIENT_REQUEST_ID_KEY.into(),
                serde_json::Value::String(client_request_id.clone()),
            );
        let raw_content = Raw::<AnyMessageLikeEventContent>::from_json_string(
            serde_json::to_string(&raw_content).map_err(Self::map_error)?,
        )
        .map_err(Self::map_error)?;
        queue
            .send_raw(raw_content, "m.room.message".into())
            .await
            .map_err(Self::map_error)?;

        let (echoes, _) = queue.subscribe().await.map_err(Self::map_error)?;
        let queued = echoes
            .iter()
            .find(|echo| {
                Self::queued_client_request_id(echo).as_deref() == Some(client_request_id.as_str())
            })
            .ok_or_else(|| {
                BackendError::Other(
                    "durable message was accepted but its local echo could not be recovered".into(),
                )
            })?;
        let message = Self::queued_message_from_local_echo(&client, &room, queued)
            .await?
            .ok_or_else(|| {
                BackendError::Other("durable message local echo was not displayable".into())
            })?;
        let last_success_ms =
            Self::lock_matrix_sync_freshness(&self.matrix_sync_freshness).last_success_ms;
        queue.set_enabled(Self::matrix_sync_is_fresh(
            last_success_ms,
            Self::matrix_rtc_monotonic_now_ms(),
        ));
        Ok(message)
    }

    async fn queued_messages(&self) -> BackendResult<Vec<MessageDto>> {
        let _queue_gate = self.send_queue_gate.lock().await;
        Self::queued_messages_for_client(&self.client().await?).await
    }

    async fn retry_queued_message(
        &self,
        room_id: String,
        transaction_id: String,
    ) -> BackendResult<()> {
        let client = self.client().await?;
        let _queue_gate = self.send_queue_gate.lock().await;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let transaction_id = Self::validate_transaction_id(&transaction_id)?;
        let room =
            Self::existing_protected_text_channel(&client, &room_id, "retrying a queued message")
                .await?;
        let queue = room.send_queue();
        let (echoes, _) = queue.subscribe().await.map_err(Self::map_error)?;
        let echo = echoes
            .into_iter()
            .find(|echo| echo.transaction_id == transaction_id)
            .ok_or_else(|| BackendError::NotFound("queued message is no longer pending".into()))?;
        if !Self::is_supported_queued_text(&echo) {
            return Err(BackendError::PermissionDenied(
                "queued message content could not be verified".into(),
            ));
        }
        let LocalEchoContent::Event {
            send_handle,
            send_error,
            ..
        } = echo.content
        else {
            return Err(BackendError::PermissionDenied(
                "queued message content could not be verified".into(),
            ));
        };
        if send_error.is_some() {
            send_handle.unwedge().await.map_err(Self::map_error)?;
        }
        let last_success_ms =
            Self::lock_matrix_sync_freshness(&self.matrix_sync_freshness).last_success_ms;
        queue.set_enabled(Self::matrix_sync_is_fresh(
            last_success_ms,
            Self::matrix_rtc_monotonic_now_ms(),
        ));
        Ok(())
    }

    async fn cancel_queued_message(
        &self,
        room_id: String,
        transaction_id: String,
    ) -> BackendResult<()> {
        let client = self.client().await?;
        let _queue_gate = self.send_queue_gate.lock().await;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let transaction_id = Self::validate_transaction_id(&transaction_id)?;
        let room =
            Self::existing_protected_text_channel(&client, &room_id, "cancelling a queued message")
                .await?;
        let queue = room.send_queue();
        let (echoes, _) = queue.subscribe().await.map_err(Self::map_error)?;
        let echo = echoes
            .into_iter()
            .find(|echo| echo.transaction_id == transaction_id)
            .ok_or_else(|| BackendError::NotFound("queued message is no longer pending".into()))?;
        if !Self::is_supported_queued_text(&echo) {
            return Err(BackendError::PermissionDenied(
                "queued message content could not be verified".into(),
            ));
        }
        let LocalEchoContent::Event { send_handle, .. } = echo.content else {
            return Err(BackendError::PermissionDenied(
                "queued message content could not be verified".into(),
            ));
        };
        if !send_handle.abort().await.map_err(Self::map_error)? {
            return Err(BackendError::NotFound(
                "queued message is already being delivered".into(),
            ));
        }
        Ok(())
    }

    async fn save_composer_draft(&self, room_id: String, body: String) -> BackendResult<()> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room = Self::protected_joined_room(&client, &room_id, "saving a message draft").await?;
        match Self::new_message_composer_draft(body)? {
            Some(draft) => room
                .save_composer_draft(draft, None)
                .await
                .map_err(Self::map_error),
            None => room
                .clear_composer_draft(None)
                .await
                .map_err(Self::map_error),
        }
    }

    async fn load_composer_draft(&self, room_id: String) -> BackendResult<Option<String>> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room =
            Self::protected_joined_room(&client, &room_id, "loading a message draft").await?;
        let draft = room
            .load_composer_draft(None)
            .await
            .map_err(Self::map_error)?;
        draft
            .map(Self::new_message_composer_draft_body)
            .transpose()
            .map(Option::flatten)
    }

    async fn clear_composer_draft(&self, room_id: String) -> BackendResult<()> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room =
            Self::protected_joined_room(&client, &room_id, "clearing a message draft").await?;
        room.clear_composer_draft(None)
            .await
            .map_err(Self::map_error)
    }

    async fn send_attachment(
        &self,
        room_id: String,
        request: MatrixAttachmentSendRequest,
        transfer: MatrixTransferObserver,
    ) -> BackendResult<MessageDto> {
        let MatrixAttachmentSendRequest {
            transaction_id,
            file_path,
            filename,
            content_type,
            body,
            reply_to_id,
            thread_root_id,
        } = request;
        let MatrixTransferObserver {
            transfer_id,
            progress,
        } = transfer;

        Self::validate_transfer_id(&transfer_id)?;
        let transaction_id = Self::validate_transaction_id(&transaction_id)?;
        Self::emit_transfer_progress(
            &progress,
            &transfer_id,
            MatrixTransferDirection::Upload,
            0,
            None,
            MatrixTransferState::Queued,
            None,
        );
        let path = PathBuf::from(file_path);
        let metadata = match tokio::fs::metadata(&path).await.map_err(Self::map_error) {
            Ok(metadata) => metadata,
            Err(error) => {
                Self::emit_transfer_progress(
                    &progress,
                    &transfer_id,
                    MatrixTransferDirection::Upload,
                    0,
                    None,
                    MatrixTransferState::Failed,
                    None,
                );
                return Err(error);
            }
        };
        if !metadata.is_file() {
            Self::emit_transfer_progress(
                &progress,
                &transfer_id,
                MatrixTransferDirection::Upload,
                0,
                Some(metadata.len()),
                MatrixTransferState::Failed,
                None,
            );
            return Err(BackendError::InvalidConfiguration(
                "attachment path is not a regular file".into(),
            ));
        }
        if let Err(error) = Self::validate_attachment_size(metadata.len()) {
            Self::emit_transfer_progress(
                &progress,
                &transfer_id,
                MatrixTransferDirection::Upload,
                0,
                Some(metadata.len()),
                MatrixTransferState::Failed,
                None,
            );
            return Err(error);
        }
        let total_bytes = metadata.len();
        let cancellation = CancellationToken::new();
        {
            let mut uploads = self.media_uploads.lock().await;
            if uploads.contains_key(&transfer_id) {
                Self::emit_transfer_progress(
                    &progress,
                    &transfer_id,
                    MatrixTransferDirection::Upload,
                    0,
                    Some(total_bytes),
                    MatrixTransferState::Failed,
                    None,
                );
                return Err(BackendError::Other(
                    "this Matrix attachment transfer id is already uploading".into(),
                ));
            }
            uploads.insert(transfer_id.clone(), cancellation.clone());
        }
        let transferred_bytes = Arc::new(AtomicU64::new(0));
        let transfer_total_bytes = Arc::new(AtomicU64::new(total_bytes));

        let result: BackendResult<MessageDto> = async {
            let filename = Self::safe_media_filename(&filename)?;
            let content_type = content_type
                .as_deref()
                .and_then(|value| mime::Mime::from_str(value).ok())
                .unwrap_or_else(|| {
                    mime::Mime::from_str("application/octet-stream")
                        .expect("invariant: application/octet-stream is a valid MIME")
                });
            Self::emit_transfer_progress(
                &progress,
                &transfer_id,
                MatrixTransferDirection::Upload,
                0,
                Some(total_bytes),
                MatrixTransferState::Encrypting,
                None,
            );
            let data = tokio::select! {
                result = tokio::fs::read(&path) => result.map_err(Self::map_error)?,
                _ = cancellation.cancelled() => {
                    return Err(BackendError::Other("Matrix attachment upload cancelled".into()))
                }
            };
            Self::validate_attachment_size(data.len() as u64)?;
            let content_type_string = content_type.to_string();
            Self::validate_media_payload(&data, Some(&content_type_string), &filename)?;
            let thumbnail_content_type = content_type_string.clone();
            let (data, generated_thumbnail) = tokio::task::spawn_blocking(move || {
                let thumbnail = Self::generate_sanitized_thumbnail(&data, &thumbnail_content_type)?;
                Ok::<_, BackendError>((data, thumbnail))
            })
            .await
            .map_err(Self::map_error)??;
            let network_total_bytes = generated_thumbnail
                .as_ref()
                .map(|thumbnail| thumbnail.bytes.len() as u64)
                .unwrap_or_default()
                .checked_add(total_bytes)
                .ok_or_else(|| BackendError::Other("attachment transfer size overflowed".into()))?;
            transfer_total_bytes.store(network_total_bytes, Ordering::Relaxed);

            let client = self.client().await?;
            let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
            let room =
                Self::protected_joined_room(&client, &room_id, "sending an attachment").await?;
            let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;

            Self::emit_transfer_progress(
                &progress,
                &transfer_id,
                MatrixTransferDirection::Upload,
                0,
                Some(network_total_bytes),
                MatrixTransferState::Uploading,
                None,
            );
            let encrypted_file = Self::upload_encrypted_media_bytes(
                &client,
                &data,
                &cancellation,
                &progress,
                &transfer_id,
                &transferred_bytes,
                (0, network_total_bytes),
            )
            .await?;
            if cancellation.is_cancelled() {
                return Err(BackendError::Other(
                    "Matrix attachment upload cancelled".into(),
                ));
            }
            let sha256 = Self::encrypted_file_sha256(&encrypted_file).ok_or_else(|| {
                BackendError::Other("Matrix encrypted attachment omitted SHA-256".into())
            })?;
            let mut info = FileInfo::new();
            info.mimetype = Some(content_type.to_string());
            info.size = total_bytes.try_into().ok();
            let thumbnail_dto = if let Some(thumbnail) = generated_thumbnail {
                let encrypted_thumbnail = Self::upload_encrypted_media_bytes(
                    &client,
                    &thumbnail.bytes,
                    &cancellation,
                    &progress,
                    &transfer_id,
                    &transferred_bytes,
                    (total_bytes, network_total_bytes),
                )
                .await?;
                let thumbnail_sha256 = Self::encrypted_file_sha256(&encrypted_thumbnail)
                    .ok_or_else(|| {
                        BackendError::Other("Matrix encrypted thumbnail omitted SHA-256".into())
                    })?;
                let mut thumbnail_info = ThumbnailInfo::new();
                thumbnail_info.width = Some(thumbnail.width.into());
                thumbnail_info.height = Some(thumbnail.height.into());
                thumbnail_info.mimetype = Some("image/png".into());
                thumbnail_info.size = thumbnail.bytes.len().try_into().ok();
                info.thumbnail_info = Some(Box::new(thumbnail_info));
                info.thumbnail_source = Some(MediaSource::Encrypted(Box::new(encrypted_thumbnail)));
                Some(AttachmentThumbnailDto {
                    file_hash: format!("matrix-sha256:{thumbnail_sha256}"),
                    size: thumbnail.bytes.len() as u64,
                    width: thumbnail.width,
                    height: thumbnail.height,
                    content_type: "image/png".into(),
                })
            } else {
                None
            };
            let caption = if body.trim().is_empty() {
                filename.clone()
            } else {
                body.trim().to_owned()
            };
            let mut file_content =
                FileMessageEventContent::encrypted(caption.clone(), encrypted_file);
            file_content.filename = Some(filename.clone());
            file_content.info = Some(Box::new(info));
            let base_content =
                RoomMessageEventContentWithoutRelation::new(MessageType::File(file_content))
                    .add_mentions(Self::mentions_for_body(body.as_str(), Some(own_user_id)));
            let content = match reply_to_id.as_deref() {
                Some(event_id) => {
                    let event_id =
                        matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
                    let is_thread_root_reply = thread_root_id.as_deref() == Some(event_id.as_str());
                    room.make_reply_event(
                        base_content,
                        Reply {
                            event_id,
                            enforce_thread: if is_thread_root_reply {
                                EnforceThread::Threaded(ReplyWithinThread::No)
                            } else if thread_root_id.is_some() {
                                EnforceThread::Threaded(ReplyWithinThread::Yes)
                            } else {
                                EnforceThread::Unthreaded
                            },
                            add_mentions: AddMentions::Yes,
                        },
                    )
                    .await
                    .map_err(Self::map_error)?
                }
                None => base_content.into(),
            };
            Self::emit_transfer_progress(
                &progress,
                &transfer_id,
                MatrixTransferDirection::Upload,
                network_total_bytes,
                Some(network_total_bytes),
                MatrixTransferState::Publishing,
                None,
            );
            if cancellation.is_cancelled() {
                return Err(BackendError::Other(
                    "Matrix attachment upload cancelled".into(),
                ));
            }
            let response = room
                .send(content)
                .with_transaction_id(transaction_id)
                .await
                .map_err(Self::map_error)?;
            let display_name = room
                .get_member(own_user_id)
                .await
                .map_err(Self::map_error)?
                .map(|member| member.name().to_owned())
                .unwrap_or_else(|| own_user_id.localpart().to_owned());

            Ok(MessageDto {
                id: response.response.event_id.to_string(),
                channel_id: room.room_id().to_string(),
                author_public_key: own_user_id.to_string(),
                author_display_name: display_name,
                author_avatar_color: Self::avatar_color(own_user_id.as_str()),
                content: if body.trim().is_empty() {
                    String::new()
                } else {
                    body.trim().to_owned()
                },
                attachments: vec![AttachmentDto {
                    file_hash: format!("matrix-sha256:{sha256}"),
                    filename,
                    size: total_bytes,
                    chunks: 1,
                    source_peer_id: "matrix".into(),
                    content_type: Some(content_type.to_string()),
                    thumbnail: thumbnail_dto,
                }],
                reactions: HashMap::new(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                signature: String::new(),
                edited_at: None,
                deleted_at: None,
                reply_to_id,
                thread_root_id,
                transaction_id: None,
                client_request_id: None,
                delivery_status: Some("sent".into()),
                undecryptable: None,
            })
        }
        .await;
        self.media_uploads.lock().await.remove(&transfer_id);
        let reported_total_bytes = transfer_total_bytes.load(Ordering::Relaxed);
        let final_bytes = transferred_bytes
            .load(Ordering::Relaxed)
            .min(reported_total_bytes);
        match &result {
            Ok(message) => Self::emit_transfer_progress(
                &progress,
                &transfer_id,
                MatrixTransferDirection::Upload,
                reported_total_bytes,
                Some(reported_total_bytes),
                MatrixTransferState::Completed,
                Some(MatrixTransferResult {
                    event_id: Some(message.id.clone()),
                    local_path: None,
                }),
            ),
            Err(error) => Self::emit_transfer_progress(
                &progress,
                &transfer_id,
                MatrixTransferDirection::Upload,
                final_bytes,
                Some(reported_total_bytes),
                if error.to_string().contains("cancelled") {
                    MatrixTransferState::Cancelled
                } else {
                    MatrixTransferState::Failed
                },
                None,
            ),
        }
        result
    }

    async fn cancel_attachment_upload(&self, transfer_id: String) -> BackendResult<()> {
        Self::validate_transfer_id(&transfer_id)?;
        if let Some(cancellation) = self.media_uploads.lock().await.get(&transfer_id) {
            cancellation.cancel();
        }
        Ok(())
    }

    async fn download_attachment(
        &self,
        room_id: String,
        event_id: String,
        attachment_index: u32,
        transfer: MatrixTransferObserver,
    ) -> BackendResult<String> {
        let MatrixTransferObserver {
            transfer_id,
            progress,
        } = transfer;
        Self::validate_transfer_id(&transfer_id)?;
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
        let resolved_attachment =
            Self::resolve_protected_attachment(&client, &room_id, &event_id, attachment_index)
                .await?;
        let ResolvedMatrixAttachment {
            metadata: attachment,
            encrypted_file,
            ..
        } = resolved_attachment;
        let total_bytes = (attachment.size > 0).then_some(attachment.size);
        if let Err(error) = Self::validate_attachment_size(attachment.size) {
            Self::emit_transfer_progress(
                &progress,
                &transfer_id,
                MatrixTransferDirection::Download,
                0,
                total_bytes,
                MatrixTransferState::Failed,
                None,
            );
            return Err(error);
        }
        Self::emit_transfer_progress(
            &progress,
            &transfer_id,
            MatrixTransferDirection::Download,
            0,
            total_bytes,
            MatrixTransferState::Queued,
            None,
        );
        let file_hash = attachment.file_hash.clone();
        let cancellation = CancellationToken::new();
        {
            let mut downloads = self.media_downloads.lock().await;
            if downloads.contains_key(&file_hash) {
                Self::emit_transfer_progress(
                    &progress,
                    &transfer_id,
                    MatrixTransferDirection::Download,
                    0,
                    total_bytes,
                    MatrixTransferState::Failed,
                    None,
                );
                return Err(BackendError::Other(
                    "this Matrix attachment is already downloading".into(),
                ));
            }
            downloads.insert(file_hash.clone(), cancellation.clone());
        }
        let transferred_bytes = Arc::new(AtomicU64::new(0));

        let result: BackendResult<String> = async {
            let client = self.client().await?;
            Self::emit_transfer_progress(
                &progress,
                &transfer_id,
                MatrixTransferDirection::Download,
                0,
                total_bytes,
                MatrixTransferState::Downloading,
                None,
            );
            let mut on_progress = |received| {
                transferred_bytes.store(received, Ordering::Relaxed);
                Self::emit_transfer_progress(
                    &progress,
                    &transfer_id,
                    MatrixTransferDirection::Download,
                    received,
                    total_bytes,
                    MatrixTransferState::Downloading,
                    None,
                );
            };
            let data = tokio::select! {
                result = Self::download_bounded_encrypted_media(
                    &client,
                    &encrypted_file,
                    MAX_ATTACHMENT_BYTES,
                    &mut on_progress,
                ) => result?,
                _ = cancellation.cancelled() => {
                    return Err(BackendError::Other("Matrix attachment download cancelled".into()))
                }
            };
            if cancellation.is_cancelled() {
                return Err(BackendError::Other(
                    "Matrix attachment download cancelled".into(),
                ));
            }
            let received_bytes = data.len() as u64;
            transferred_bytes.store(received_bytes, Ordering::Relaxed);
            Self::validate_attachment_size(received_bytes)?;
            Self::emit_transfer_progress(
                &progress,
                &transfer_id,
                MatrixTransferDirection::Download,
                received_bytes,
                total_bytes.or(Some(received_bytes)),
                MatrixTransferState::Validating,
                None,
            );
            if attachment.size > 0 && data.len() as u64 != attachment.size {
                return Err(BackendError::Other(
                    "decrypted attachment size does not match its metadata".into(),
                ));
            }
            Self::validate_media_payload(
                &data,
                attachment.content_type.as_deref(),
                &attachment.filename,
            )?;

            let profile_id = self
                .runtime
                .read()
                .await
                .profile_id
                .clone()
                .ok_or(BackendError::NotAuthenticated)?;
            let cache_root = self
                .storage_for_profile(&profile_id)
                .store_root
                .join("media-cache");
            create_private_dir(&cache_root, true)
                .await
                .map_err(Self::map_error)?;
            let safe_filename = Self::safe_media_filename(&attachment.filename)?;
            let safe_hash: String = attachment
                .file_hash
                .chars()
                .map(|character| {
                    if character.is_ascii_alphanumeric() {
                        character
                    } else {
                        '_'
                    }
                })
                .collect();
            let destination = cache_root.join(format!("{safe_hash}-{safe_filename}"));
            if cancellation.is_cancelled() {
                return Err(BackendError::Other(
                    "Matrix attachment download cancelled".into(),
                ));
            }
            Self::emit_transfer_progress(
                &progress,
                &transfer_id,
                MatrixTransferDirection::Download,
                received_bytes,
                total_bytes.or(Some(received_bytes)),
                MatrixTransferState::Writing,
                None,
            );
            let mut file = open_private_file(&destination, false)
                .await
                .map_err(Self::map_error)?;
            if let Err(error) = file.write_all(&data).await {
                drop(file);
                let _ = tokio::fs::remove_file(&destination).await;
                return Err(Self::map_error(error));
            }
            if let Err(error) = file.sync_all().await {
                drop(file);
                let _ = tokio::fs::remove_file(&destination).await;
                return Err(Self::map_error(error));
            }
            drop(file);
            if cancellation.is_cancelled() {
                let _ = tokio::fs::remove_file(&destination).await;
                return Err(BackendError::Other(
                    "Matrix attachment download cancelled".into(),
                ));
            }
            Self::enforce_media_cache_quota(&cache_root, &destination).await?;
            Ok(destination.to_string_lossy().into_owned())
        }
        .await;
        self.media_downloads.lock().await.remove(&file_hash);
        let final_bytes = transferred_bytes.load(Ordering::Relaxed);
        match &result {
            Ok(local_path) => Self::emit_transfer_progress(
                &progress,
                &transfer_id,
                MatrixTransferDirection::Download,
                final_bytes,
                total_bytes.or(Some(final_bytes)),
                MatrixTransferState::Completed,
                Some(MatrixTransferResult {
                    event_id: None,
                    local_path: Some(local_path.clone()),
                }),
            ),
            Err(error) => Self::emit_transfer_progress(
                &progress,
                &transfer_id,
                MatrixTransferDirection::Download,
                final_bytes,
                total_bytes,
                if error.to_string().contains("cancelled") {
                    MatrixTransferState::Cancelled
                } else {
                    MatrixTransferState::Failed
                },
                None,
            ),
        }
        result
    }

    async fn load_attachment_thumbnail(
        &self,
        room_id: String,
        event_id: String,
        attachment_index: u32,
    ) -> BackendResult<Vec<u8>> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
        let thumbnail =
            Self::resolve_protected_thumbnail(&client, &room_id, &event_id, attachment_index)
                .await?;
        let _permit =
            self.thumbnail_loads.acquire().await.map_err(|_| {
                BackendError::Other("inline preview scheduler is unavailable".into())
            })?;
        let data = Self::download_bounded_encrypted_media(
            &client,
            &thumbnail.encrypted_file,
            MAX_THUMBNAIL_BYTES as u64,
            &mut |_| {},
        )
        .await?;
        let metadata = thumbnail.metadata;
        tokio::task::spawn_blocking(move || Self::sanitize_inline_thumbnail(&data, &metadata))
            .await
            .map_err(Self::map_error)?
    }

    async fn load_attachment_image(
        &self,
        room_id: String,
        event_id: String,
        attachment_index: u32,
    ) -> BackendResult<Vec<u8>> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
        let resolved_attachment =
            Self::resolve_protected_attachment(&client, &room_id, &event_id, attachment_index)
                .await?;
        let content_type = resolved_attachment
            .metadata
            .content_type
            .clone()
            .ok_or_else(|| {
                BackendError::InvalidConfiguration(
                    "attachment does not declare a supported protected image type".into(),
                )
            })?;
        if Self::thumbnail_image_format(&content_type).is_none() {
            return Err(BackendError::InvalidConfiguration(
                "attachment does not declare a supported protected image type".into(),
            ));
        }
        Self::validate_attachment_size(resolved_attachment.metadata.size)?;
        let _permit =
            self.lightbox_image_loads.acquire().await.map_err(|_| {
                BackendError::Other("protected image scheduler is unavailable".into())
            })?;
        let data = Self::download_bounded_encrypted_media(
            &client,
            &resolved_attachment.encrypted_file,
            MAX_ATTACHMENT_BYTES,
            &mut |_| {},
        )
        .await?;
        Self::validate_attachment_size(data.len() as u64)?;
        if resolved_attachment.metadata.size > 0
            && data.len() as u64 != resolved_attachment.metadata.size
        {
            return Err(BackendError::Other(
                "decrypted attachment size does not match its metadata".into(),
            ));
        }
        Self::validate_media_payload(
            &data,
            Some(&content_type),
            &resolved_attachment.metadata.filename,
        )?;
        tokio::task::spawn_blocking(move || {
            Self::validate_lightbox_image(&data, &content_type)?;
            Ok::<_, BackendError>(data)
        })
        .await
        .map_err(Self::map_error)?
    }

    async fn cancel_attachment_download(&self, file_hash: String) -> BackendResult<()> {
        if let Some(cancellation) = self.media_downloads.lock().await.get(&file_hash) {
            cancellation.cancel();
        }
        Ok(())
    }

    async fn dm_conversations(&self) -> BackendResult<Vec<DmConversationDto>> {
        let client = self.client().await?;
        let mut conversations = Vec::new();
        for room in client.joined_rooms() {
            let targets = room.direct_targets();
            if targets.len() != 1 {
                continue;
            }
            Self::require_protected_room(&room, "listing direct messages").await?;
            let Some(target) = targets.into_iter().next() else {
                continue;
            };
            let Ok(user_id) = matrix_sdk::ruma::UserId::parse(target.as_str()) else {
                continue;
            };
            let member = room.get_member(&user_id).await.map_err(Self::map_error)?;
            let peer_display_name = member
                .map(|member| member.name().to_owned())
                .unwrap_or_else(|| user_id.localpart().to_owned());
            let latest = self
                .messages(room.room_id().to_string(), 1, None, None)
                .await?
                .into_iter()
                .next();
            let created_at = latest
                .as_ref()
                .map(|message| message.timestamp.clone())
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
            conversations.push(DmConversationDto {
                id: room.room_id().to_string(),
                peer_public_key: user_id.to_string(),
                peer_display_name,
                peer_avatar_color: Self::avatar_color(user_id.as_str()),
                last_message_at: latest.map(|message| message.timestamp),
                unread_count: room.num_unread_messages().min(i64::MAX as u64) as i64,
                created_at,
            });
        }
        conversations.sort_by(|left, right| {
            right
                .last_message_at
                .cmp(&left.last_message_at)
                .then_with(|| left.peer_display_name.cmp(&right.peer_display_name))
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(conversations)
    }

    async fn ensure_dm(&self, recipient_user_id: String) -> BackendResult<DmConversationDto> {
        let client = self.client().await?;
        let recipient =
            matrix_sdk::ruma::UserId::parse(recipient_user_id).map_err(Self::map_error)?;
        if client.user_id().is_some_and(|user_id| user_id == recipient) {
            return Err(BackendError::InvalidConfiguration(
                "cannot create a direct message with the signed-in user".into(),
            ));
        }
        if Self::is_ignored_user(&client, &recipient).await? {
            return Err(BackendError::InvalidConfiguration(
                "direct messages are blocked for this Matrix user".into(),
            ));
        }
        let room = self.direct_room(&client, &recipient).await?;
        let member = room.get_member(&recipient).await.map_err(Self::map_error)?;
        let peer_display_name = member
            .map(|member| member.name().to_owned())
            .unwrap_or_else(|| recipient.localpart().to_owned());
        let latest = self
            .messages(room.room_id().to_string(), 1, None, None)
            .await?
            .into_iter()
            .next();
        Ok(DmConversationDto {
            id: room.room_id().to_string(),
            peer_public_key: recipient.to_string(),
            peer_display_name,
            peer_avatar_color: Self::avatar_color(recipient.as_str()),
            last_message_at: latest.as_ref().map(|message| message.timestamp.clone()),
            unread_count: room.num_unread_messages().min(i64::MAX as u64) as i64,
            created_at: latest
                .map(|message| message.timestamp)
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
        })
    }

    async fn dm_messages(
        &self,
        conversation_id: String,
        limit: u32,
        before_timestamp: Option<String>,
        before_id: Option<String>,
    ) -> BackendResult<Vec<DirectMessageDto>> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(&conversation_id).map_err(Self::map_error)?;
        let room =
            Self::protected_joined_room(&client, &room_id, "reading direct messages").await?;
        if room.direct_targets().len() != 1 {
            return Err(BackendError::InvalidConfiguration(
                "conversation is not a one-to-one Matrix direct room".into(),
            ));
        }
        let mut messages = self
            .messages(conversation_id, limit, before_timestamp, before_id)
            .await?
            .into_iter()
            .map(Self::direct_message_from_message)
            .collect::<Vec<_>>();
        let own_user_id = client.user_id();

        for message in &mut messages {
            let Ok(event_id) = matrix_sdk::ruma::EventId::parse(&message.id) else {
                continue;
            };
            let receipt_thread = Self::receipt_thread_for_message(message.thread_root_id.is_some());
            let receipts = room
                .load_event_receipts(ReceiptType::Read, receipt_thread, &event_id)
                .await
                .map_err(Self::map_error)?;
            for (user_id, _) in receipts {
                if own_user_id.is_some_and(|own_user_id| own_user_id == user_id) {
                    continue;
                }
                let display_name = room
                    .get_member(&user_id)
                    .await
                    .map_err(Self::map_error)?
                    .map(|member| member.name().to_owned())
                    .unwrap_or_else(|| user_id.localpart().to_owned());
                message
                    .seen_by
                    .get_or_insert_default()
                    .push(ReadReceiptDto {
                        user_id: user_id.to_string(),
                        display_name,
                    });
            }
        }

        Ok(messages)
    }

    async fn send_dm(
        &self,
        recipient_user_id: String,
        body: String,
        reply_to_id: Option<String>,
        thread_root_id: Option<String>,
        transaction_id: String,
    ) -> BackendResult<DirectMessageDto> {
        if body.trim().is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "direct-message body cannot be empty".into(),
            ));
        }
        let client = self.client().await?;
        let recipient =
            matrix_sdk::ruma::UserId::parse(recipient_user_id).map_err(Self::map_error)?;
        if client.user_id().is_some_and(|user_id| user_id == recipient) {
            return Err(BackendError::InvalidConfiguration(
                "cannot create a direct message with the signed-in user".into(),
            ));
        }
        if Self::is_ignored_user(&client, &recipient).await? {
            return Err(BackendError::InvalidConfiguration(
                "direct messages are blocked for this Matrix user".into(),
            ));
        }
        let room = self.direct_room(&client, &recipient).await?;
        let message = Self::send_immediate_protected_message(
            &client,
            &room,
            body,
            reply_to_id,
            thread_root_id,
            transaction_id,
        )
        .await?;
        Ok(Self::direct_message_from_message(message))
    }

    async fn send_dm_attachment(
        &self,
        recipient_user_id: String,
        request: MatrixAttachmentSendRequest,
        transfer: MatrixTransferObserver,
    ) -> BackendResult<DirectMessageDto> {
        let client = self.client().await?;
        let recipient =
            matrix_sdk::ruma::UserId::parse(recipient_user_id).map_err(Self::map_error)?;
        if client.user_id().is_some_and(|user_id| user_id == recipient) {
            return Err(BackendError::InvalidConfiguration(
                "cannot create a direct message with the signed-in user".into(),
            ));
        }
        let room = self.direct_room(&client, &recipient).await?;
        let message = <Self as MeshBackend>::send_attachment(
            self,
            room.room_id().to_string(),
            request,
            transfer,
        )
        .await?;
        Ok(Self::direct_message_from_message(message))
    }

    async fn mark_dm_read(&self, conversation_id: String) -> BackendResult<()> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(&conversation_id).map_err(Self::map_error)?;
        let room =
            Self::protected_joined_room(&client, &room_id, "updating direct-message receipts")
                .await?;
        if room.direct_targets().len() != 1 {
            return Err(BackendError::InvalidConfiguration(
                "conversation is not a one-to-one Matrix direct room".into(),
            ));
        }
        <Self as MeshBackend>::mark_read(self, conversation_id).await
    }

    async fn set_dm_blocked(
        &self,
        recipient_user_id: String,
        blocked: bool,
    ) -> BackendResult<bool> {
        let client = self.client().await?;
        let recipient =
            matrix_sdk::ruma::UserId::parse(recipient_user_id).map_err(Self::map_error)?;
        if client.user_id().is_some_and(|user_id| user_id == recipient) {
            return Err(BackendError::InvalidConfiguration(
                "cannot block the signed-in Matrix user".into(),
            ));
        }
        let mut content = client
            .account()
            .fetch_account_data_static::<IgnoredUserListEventContent>()
            .await
            .map_err(Self::map_error)?
            .map(|raw| raw.deserialize().map_err(Self::map_error))
            .transpose()?
            .unwrap_or_default();
        if blocked {
            content.ignored_users.insert(recipient, IgnoredUser::new());
        } else {
            content.ignored_users.remove(&recipient);
        }
        client
            .account()
            .set_account_data(content)
            .await
            .map_err(Self::map_error)?;
        Ok(blocked)
    }

    async fn dm_blocked(&self, recipient_user_id: String) -> BackendResult<bool> {
        let client = self.client().await?;
        let recipient =
            matrix_sdk::ruma::UserId::parse(recipient_user_id).map_err(Self::map_error)?;
        Self::is_ignored_user(&client, &recipient).await
    }

    async fn messages(
        &self,
        room_id: String,
        limit: u32,
        before_timestamp: Option<String>,
        before_id: Option<String>,
    ) -> BackendResult<Vec<MessageDto>> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room = Self::protected_joined_room(&client, &room_id, "reading messages").await?;

        let members: HashMap<String, String> = room
            .members(RoomMemberships::JOIN)
            .await
            .map_err(Self::map_error)?
            .into_iter()
            .map(|member| (member.user_id().to_string(), member.name().to_owned()))
            .collect();
        let requested = limit.clamp(1, 5_000) as usize;
        let values = if before_id.is_some() || before_timestamp.is_some() {
            self.timeline_values_with_predecessors(&client, &room, requested, before_id.as_deref())
                .await?
        } else {
            Self::timeline_values(&room, requested, None).await?
        };
        let mut result = Self::project_timeline(room.room_id().as_str(), &members, values);
        if let Some(before_timestamp) = before_timestamp.as_deref() {
            result.retain(|message| {
                message.timestamp.as_str() < before_timestamp
                    || (message.timestamp == before_timestamp
                        && before_id
                            .as_deref()
                            .is_some_and(|before_id| message.id.as_str() < before_id))
            });
        }
        if result.len() > limit as usize {
            result = result.split_off(result.len() - limit as usize);
        }
        Ok(result)
    }

    async fn edit_message(
        &self,
        room_id: String,
        event_id: String,
        body: String,
    ) -> BackendResult<()> {
        if body.trim().is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "message body cannot be empty".into(),
            ));
        }
        let client = self.client().await?;
        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
        let room = Self::protected_joined_room(&client, &room_id, "editing a message").await?;
        let mentions = Self::mentions_for_body(body.as_str(), Some(own_user_id));
        let replacement = RoomMessageEventContentWithoutRelation::text_plain(body.clone())
            .add_mentions(mentions.clone())
            .make_replacement(ReplacementMetadata::new(event_id, None))
            // Keep the top-level m.mentions present as well as the m.new_content
            // copy produced by the replacement relation.
            .add_mentions(mentions);
        room.send(replacement).await.map_err(Self::map_error)?;
        Ok(())
    }

    async fn redact_message(&self, room_id: String, event_id: String) -> BackendResult<()> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
        let room = Self::room_for_cleanup_redaction(&client, &room_id).await?;
        // Keep explicit redaction available for legacy plaintext rooms so users can remove
        // previously exposed content. Every other content path uses `protected_joined_room`.
        room.redact(&event_id, None, None)
            .await
            .map_err(Self::map_error)?;
        Ok(())
    }

    async fn report_message(
        &self,
        room_id: String,
        event_id: String,
        reason: String,
    ) -> BackendResult<()> {
        let reason = Self::normalize_report_reason(reason)?;
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
        let room = Self::protected_joined_room(&client, &room_id, "reporting a message").await?;
        room.report_content(event_id, Some(reason))
            .await
            .map_err(Self::map_error)?;
        Ok(())
    }

    async fn toggle_reaction(
        &self,
        room_id: String,
        event_id: String,
        key: String,
    ) -> BackendResult<bool> {
        if key.trim().is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "reaction key cannot be empty".into(),
            ));
        }
        let client = self.client().await?;
        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let target_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
        let room = Self::protected_joined_room(&client, &room_id, "changing a reaction").await?;

        let values = Self::timeline_values(&room, 500, None).await?;
        let redacted: HashSet<&str> = values
            .iter()
            .filter(|value| {
                value.get("type").and_then(serde_json::Value::as_str) == Some("m.room.redaction")
            })
            .filter_map(|value| {
                value
                    .get("redacts")
                    .or_else(|| {
                        value
                            .get("content")
                            .and_then(|content| content.get("redacts"))
                    })
                    .and_then(serde_json::Value::as_str)
            })
            .collect();
        let existing = values.iter().find_map(|value| {
            if value.get("type").and_then(serde_json::Value::as_str) != Some("m.reaction")
                || value.get("sender").and_then(serde_json::Value::as_str)
                    != Some(own_user_id.as_str())
            {
                return None;
            }
            let relation = value.get("content")?.get("m.relates_to")?;
            let matches_target = relation.get("event_id")?.as_str()? == target_id.as_str();
            let matches_key = relation.get("key")?.as_str()? == key;
            let reaction_id = value.get("event_id")?.as_str()?;
            let inline_redacted = value
                .get("unsigned")
                .and_then(|unsigned| unsigned.get("redacted_because"))
                .is_some();
            (matches_target && matches_key && !inline_redacted && !redacted.contains(reaction_id))
                .then_some(reaction_id)
        });

        if let Some(reaction_id) = existing {
            let reaction_id =
                matrix_sdk::ruma::EventId::parse(reaction_id).map_err(Self::map_error)?;
            room.redact(&reaction_id, None, None)
                .await
                .map_err(Self::map_error)?;
            return Ok(false);
        }

        room.send(ReactionEventContent::new(Annotation::new(target_id, key)))
            .await
            .map_err(Self::map_error)?;
        Ok(true)
    }

    async fn room_pins(&self, room_id: String) -> BackendResult<MatrixRoomPins> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room =
            Self::existing_protected_text_channel(&client, &room_id, "reading pinned messages")
                .await?;
        let pinned_event_ids = room
            .load_pinned_events()
            .await
            .map_err(Self::map_error)?
            .unwrap_or_default();
        Self::room_pins_snapshot(&client, &room, pinned_event_ids).await
    }

    async fn toggle_room_pin(
        &self,
        room_id: String,
        event_id: String,
    ) -> BackendResult<MatrixRoomPins> {
        let client = self.client().await?;
        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
        let room =
            Self::existing_protected_text_channel(&client, &room_id, "changing pinned messages")
                .await?;
        let can_manage = room
            .get_member(own_user_id)
            .await
            .map_err(Self::map_error)?
            .is_some_and(|member| member.can_pin_or_unpin_event());
        if !can_manage {
            return Err(BackendError::PermissionDenied(
                "Only room moderators can manage pinned messages.".into(),
            ));
        }

        let pinned_event_ids = room
            .load_pinned_events()
            .await
            .map_err(Self::map_error)?
            .unwrap_or_default();
        let (pinned_event_ids, now_pinned) =
            Self::updated_room_pins(pinned_event_ids, event_id.clone())?;
        if now_pinned {
            let event = room
                .load_or_fetch_event(&event_id, None)
                .await
                .map_err(Self::map_error)?;
            let value = event
                .raw()
                .deserialize_as::<serde_json::Value>()
                .map_err(Self::map_error)?;
            if !Self::is_base_text_message(&value) {
                return Err(BackendError::InvalidConfiguration(
                    "Only readable room messages can be pinned.".into(),
                ));
            }
        }

        room.send_state_event(RoomPinnedEventsEventContent::new(pinned_event_ids.clone()))
            .await
            .map_err(Self::map_error)?;
        Self::room_pins_snapshot(&client, &room, pinned_event_ids).await
    }

    async fn mark_read(&self, room_id: String) -> BackendResult<()> {
        let read_receipt_mode = self.wire_privacy.read().await.read_receipt_mode;
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room =
            Self::protected_joined_room(&client, &room_id, "updating message receipts").await?;
        let values = Self::timeline_values(&room, 1, None).await?;
        let Some(event_id) = values
            .iter()
            .find_map(|value| value.get("event_id").and_then(serde_json::Value::as_str))
        else {
            return Ok(());
        };
        let is_thread_event = values.iter().any(|value| {
            value.get("event_id").and_then(serde_json::Value::as_str) == Some(event_id)
                && value
                    .get("content")
                    .and_then(Self::thread_root_id)
                    .is_some()
        });
        let receipt_thread = Self::receipt_thread_for_message(is_thread_event);
        let event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
        if is_thread_event {
            room.send_multiple_receipts(Receipts::new().fully_read_marker(event_id.clone()))
                .await
                .map_err(Self::map_error)?;
            let receipt_type = match read_receipt_mode {
                ReadReceiptMode::Public => Some(MatrixReceiptType::Read),
                ReadReceiptMode::Private => Some(MatrixReceiptType::ReadPrivate),
                ReadReceiptMode::Off => None,
            };
            if let Some(receipt_type) = receipt_type {
                room.send_single_receipt(receipt_type, receipt_thread, event_id)
                    .await
                    .map_err(Self::map_error)?;
            }
            return Ok(());
        }
        let mut receipts = Receipts::new().fully_read_marker(event_id.clone());
        receipts = match read_receipt_mode {
            ReadReceiptMode::Public => receipts.public_read_receipt(event_id),
            ReadReceiptMode::Private => receipts.private_read_receipt(event_id),
            ReadReceiptMode::Off => receipts,
        };
        room.send_multiple_receipts(receipts)
            .await
            .map_err(Self::map_error)
    }

    async fn set_typing(&self, room_id: String, typing: bool) -> BackendResult<()> {
        let privacy = *self.wire_privacy.read().await;
        let mut sent_rooms = self.sent_typing_notices.lock().await;
        if !privacy.should_send_typing_notice(sent_rooms.contains(&room_id), typing) {
            return Ok(());
        }
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room = Self::protected_joined_room(&client, &room_id, "updating typing status").await?;
        room.typing_notice(typing).await.map_err(Self::map_error)?;
        if typing {
            sent_rooms.insert(room_id.to_string());
        } else {
            sent_rooms.remove(room_id.as_str());
        }
        Ok(())
    }

    async fn typing_users(&self, room_id: String) -> BackendResult<Vec<TypingUser>> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room = Self::protected_joined_room(&client, &room_id, "reading typing status").await?;
        let user_ids = self
            .typing_users
            .read()
            .await
            .get(room.room_id().as_str())
            .cloned()
            .unwrap_or_default();
        let mut users = Vec::new();
        for user_id in user_ids {
            let parsed = matrix_sdk::ruma::UserId::parse(&user_id).map_err(Self::map_error)?;
            let display_name = room
                .get_member(&parsed)
                .await
                .map_err(Self::map_error)?
                .map(|member| member.name().to_owned())
                .unwrap_or_else(|| parsed.localpart().to_owned());
            users.push(TypingUser {
                user_id,
                display_name,
            });
        }
        Ok(users)
    }

    async fn search_messages(
        &self,
        community_id: String,
        query: String,
        limit: u32,
    ) -> BackendResult<Vec<MessageDto>> {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let mut result = Vec::new();
        for channel in self.list_channels(community_id).await? {
            result.extend(
                self.messages(channel.id, 5_000, None, None)
                    .await?
                    .into_iter()
                    .filter(|message| {
                        message.deleted_at.is_none()
                            && message.content.to_lowercase().contains(&query)
                    }),
            );
        }
        result.sort_by(|left, right| {
            right
                .timestamp
                .cmp(&left.timestamp)
                .then_with(|| right.id.cmp(&left.id))
        });
        result.truncate(limit.clamp(1, 500) as usize);
        Ok(result)
    }

    async fn wait_for_room_update(&self, room_id: String, timeout_ms: u64) -> BackendResult<bool> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room =
            Self::protected_joined_room(&client, &room_id, "waiting for message updates").await?;
        let mut updates = room.subscribe_to_updates();
        Ok(matches!(
            tokio::time::timeout(
                Duration::from_millis(timeout_ms.clamp(250, 30_000)),
                updates.recv(),
            )
            .await,
            Ok(Ok(_))
        ))
    }

    async fn list_members(&self, community_id: String) -> BackendResult<Vec<CommunityMember>> {
        let client = self.client().await?;
        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let rooms = self.community_rooms(&community_id).await?;
        let space = rooms.first().ok_or_else(|| {
            BackendError::Other("community Space is not present in the local Matrix store".into())
        })?;
        let creators = space.creators().unwrap_or_default();
        let presence = self.presence.read().await;
        let mut members = Vec::new();
        for member in space
            .members(RoomMemberships::all())
            .await
            .map_err(Self::map_error)?
        {
            let user_id = member.user_id().to_string();
            let membership = member.membership().as_str();
            let banned = membership == "ban";
            let joined = membership == "join";
            let role = if creators.iter().any(|creator| creator == member.user_id()) {
                "owner"
            } else {
                match member.suggested_role_for_power_level() {
                    RoomMemberRole::Creator => "owner",
                    RoomMemberRole::Administrator | RoomMemberRole::Moderator => "admin",
                    _ => "member",
                }
            };
            let online = joined
                && (member.user_id() == own_user_id
                    || presence
                        .get(&user_id)
                        .is_some_and(|status| status == "online"));
            members.push(CommunityMember {
                public_key: user_id.clone(),
                display_name: member.name().to_owned(),
                avatar_color: Self::avatar_color(&user_id),
                role: role.into(),
                join_status: match membership {
                    "invite" => "invited",
                    "join" => "joined",
                    _ => "left",
                }
                .into(),
                ban_status: if banned { "banned" } else { "none" }.into(),
                last_seen: online.then(|| chrono::Utc::now().to_rfc3339()),
                online,
            });
        }
        members.sort_by(|left, right| {
            let rank = |role: &str| match role {
                "owner" => 0,
                "admin" => 1,
                _ => 2,
            };
            rank(&left.role)
                .cmp(&rank(&right.role))
                .then_with(|| {
                    left.display_name
                        .to_lowercase()
                        .cmp(&right.display_name.to_lowercase())
                })
                .then_with(|| left.public_key.cmp(&right.public_key))
        });
        Ok(members)
    }

    async fn invite_to_community(
        &self,
        community_id: String,
        user_id: String,
    ) -> BackendResult<()> {
        let client = self.client().await?;
        let account_server = client
            .user_id()
            .ok_or(BackendError::NotAuthenticated)?
            .server_name();
        let user_id = if user_id.trim().starts_with('@') {
            UserId::parse(user_id.trim()).map_err(Self::map_error)?
        } else {
            Self::qualify_user_input(&user_id, account_server)?
        };
        let mut rooms = self.community_rooms(&community_id).await?;
        rooms.reverse();
        for room in rooms {
            room.invite_user_by_id(&user_id)
                .await
                .map_err(Self::map_error)?;
        }
        Ok(())
    }

    async fn create_community_invite(&self, community_id: String) -> BackendResult<String> {
        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(community_id).map_err(Self::map_error)?;
        let space =
            Self::protected_joined_room(&client, &space_id, "creating a community invite").await?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community invites require a joined Matrix Space".into(),
            ));
        }

        let user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let community = Self::community_homeserver_config().ok();
        let admission_origin = Self::community_admission_origin().ok();
        if community.as_ref().is_some_and(|community| {
            client.homeserver().as_str().trim_end_matches('/')
                == community.homeserver.trim_end_matches('/')
        }) && admission_origin.is_some()
        {
            let access_token = client
                .access_token()
                .ok_or(BackendError::NotAuthenticated)?;
            let origin = admission_origin.ok_or_else(|| {
                BackendError::InvalidConfiguration(
                    "no community admission service is configured".into(),
                )
            })?;
            let endpoint = origin
                .join("/_mesh/admission/v1/invitations")
                .map_err(|_| {
                    BackendError::InvalidConfiguration(
                        "the invitation service address could not be prepared".into(),
                    )
                })?;
            let response = Self::admission_http_client()?
                .post(endpoint)
                .bearer_auth(access_token)
                .json(&serde_json::json!({ "room_id": space.room_id().as_str() }))
                .send()
                .await
                .map_err(BackendError::from_sdk_error)?;
            let payload = Self::admission_response_bytes(response).await?;
            let created: AdmissionCreateResponse =
                serde_json::from_slice(&payload).map_err(|error| {
                    BackendError::Serialization(format!(
                        "the invitation service returned invalid JSON: {error}"
                    ))
                })?;
            Self::parse_admission_invitation(&created.invite_url, Some(&origin))?;
            return Ok(created.invite_url);
        }

        // Custom compatible services keep the interoperable access-request
        // fallback until they expose Mesh's bounded admission API.
        space
            .privacy_settings()
            .update_join_rule(JoinRule::Knock)
            .await
            .map_err(Self::map_error)?;
        let mut invite = url::Url::parse("mesh://join").map_err(|error| {
            BackendError::InvalidConfiguration(format!(
                "could not prepare the community invite URL: {error}"
            ))
        })?;
        invite
            .query_pairs_mut()
            .append_pair("v", "5")
            .append_pair("kind", "community")
            .append_pair("room", space.room_id().as_str())
            .append_pair("via", user_id.server_name().as_str())
            .append_pair("community_service", client.homeserver().as_str());
        Ok(invite.into())
    }

    async fn resolve_community_invite(
        &self,
        invite_url: String,
    ) -> BackendResult<super::MatrixCommunityAdmission> {
        self.resolve_admission_invitation(&invite_url, true).await
    }

    async fn claim_community_invite(&self, invite_url: String) -> BackendResult<CommunityDto> {
        let client = self.client().await?;
        let user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let target = Self::parse_admission_invitation(&invite_url, None)?;
        let endpoint = Self::admission_endpoint(&target, "/claim")?;
        let response = Self::admission_http_client()?
            .post(endpoint)
            .json(&serde_json::json!({ "user_id": user_id.as_str() }))
            .send()
            .await
            .map_err(BackendError::from_sdk_error)?;
        let payload = Self::admission_response_bytes(response).await?;
        let claimed: AdmissionServiceResponse =
            serde_json::from_slice(&payload).map_err(|error| {
                BackendError::Serialization(format!(
                    "the invitation service returned invalid JSON: {error}"
                ))
            })?;
        let admission = Self::validate_admission_response(claimed, false)?;
        self.join_community(admission.room_id, admission.via).await
    }

    async fn community_access_settings(
        &self,
        community_id: String,
    ) -> BackendResult<CommunityAccessSettings> {
        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(community_id).map_err(Self::map_error)?;
        let space =
            Self::protected_joined_room(&client, &space_id, "reading community access settings")
                .await?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community access settings require a joined Matrix Space".into(),
            ));
        }

        let visibility = space
            .privacy_settings()
            .get_room_visibility()
            .await
            .map_err(Self::map_error)?;
        Ok(CommunityAccessSettings {
            alias: space.canonical_alias().map(|alias| alias.to_string()),
            discoverable: visibility == Visibility::Public,
            join_rule: space
                .join_rule()
                .map(|rule| rule.as_str().to_owned())
                .unwrap_or_else(|| "invite".into()),
        })
    }

    async fn update_community_access(
        &self,
        community_id: String,
        alias: Option<String>,
        discoverable: bool,
    ) -> BackendResult<CommunityAccessSettings> {
        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(community_id).map_err(Self::map_error)?;
        let space =
            Self::protected_joined_room(&client, &space_id, "updating community access settings")
                .await?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community access settings require a joined Matrix Space".into(),
            ));
        }

        let alias = alias.and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        });
        if discoverable && alias.is_none() {
            return Err(BackendError::InvalidConfiguration(
                "a canonical Matrix alias is required before directory discovery can be enabled"
                    .into(),
            ));
        }

        let parsed_alias = if let Some(alias) = alias {
            let alias = if alias.starts_with('#') {
                RoomAliasId::parse(alias).map_err(Self::map_error)?
            } else {
                let account_server = client
                    .user_id()
                    .ok_or(BackendError::NotAuthenticated)?
                    .server_name();
                Self::qualify_public_link_input(&alias, account_server)?
            };
            let own_server = client
                .user_id()
                .ok_or(BackendError::NotAuthenticated)?
                .server_name();
            if alias.server_name() != own_server {
                return Err(BackendError::InvalidConfiguration(format!(
                    "community aliases must belong to the signed-in homeserver ({own_server})"
                )));
            }

            if client
                .is_room_alias_available(&alias)
                .await
                .map_err(Self::map_error)?
            {
                client
                    .create_room_alias(&alias, space.room_id())
                    .await
                    .map_err(Self::map_error)?;
            } else {
                let resolved = client
                    .resolve_room_alias(&alias)
                    .await
                    .map_err(Self::map_error)?;
                if resolved.room_id != space.room_id() {
                    return Err(BackendError::InvalidConfiguration(
                        "that Matrix alias already belongs to another room".into(),
                    ));
                }
            }
            Some(alias)
        } else {
            None
        };

        let privacy = space.privacy_settings();
        if discoverable {
            privacy
                .update_canonical_alias(parsed_alias.clone(), Vec::new())
                .await
                .map_err(Self::map_error)?;
            privacy
                .update_room_visibility(Visibility::Public)
                .await
                .map_err(Self::map_error)?;
            privacy
                .update_join_rule(JoinRule::Knock)
                .await
                .map_err(Self::map_error)?;
        } else {
            privacy
                .update_room_visibility(Visibility::Private)
                .await
                .map_err(Self::map_error)?;
            privacy
                .update_join_rule(JoinRule::Invite)
                .await
                .map_err(Self::map_error)?;
            privacy
                .update_canonical_alias(parsed_alias.clone(), Vec::new())
                .await
                .map_err(Self::map_error)?;
        }

        Ok(CommunityAccessSettings {
            alias: parsed_alias.map(|alias| alias.to_string()),
            discoverable,
            join_rule: if discoverable { "knock" } else { "invite" }.into(),
        })
    }

    async fn search_community_directory(
        &self,
        query: String,
        server: Option<String>,
        limit: u32,
    ) -> BackendResult<Vec<CommunityDirectoryEntry>> {
        let client = self.client().await?;
        let mut request = get_public_rooms_filtered::v3::Request::new();
        request.limit = Some(limit.clamp(1, 50).into());
        let mut filter = Filter::new();
        filter.generic_search_term = (!query.trim().is_empty()).then(|| query.trim().to_owned());
        filter.room_types = vec![RoomTypeFilter::Space];
        request.filter = filter;
        request.server = server
            .and_then(|value| {
                let trimmed = value.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_owned())
            })
            .map(ServerName::parse)
            .transpose()
            .map_err(Self::map_error)?;

        let response = client
            .public_rooms_filtered(request)
            .await
            .map_err(Self::map_error)?;
        Ok(response
            .chunk
            .into_iter()
            .filter(|room| room.room_type == Some(RoomType::Space))
            .map(|room| CommunityDirectoryEntry {
                id: room.room_id.to_string(),
                alias: room.canonical_alias.map(|alias| alias.to_string()),
                name: room.name.unwrap_or_else(|| "Unnamed community".into()),
                description: room.topic.unwrap_or_default(),
                member_count: u64::from(room.num_joined_members).min(u32::MAX as u64) as u32,
                join_rule: room.join_rule.as_str().to_owned(),
            })
            .collect())
    }

    async fn knock_community(
        &self,
        room_or_alias: String,
        reason: Option<String>,
        via: Vec<String>,
    ) -> BackendResult<CommunityAccessResult> {
        let client = self.client().await?;
        let value = room_or_alias.trim();
        let identifier = RoomOrAliasId::parse(value).map_err(Self::map_error)?;
        let mut via = via
            .into_iter()
            .take(3)
            .map(ServerName::parse)
            .collect::<Result<Vec<_>, _>>()
            .map_err(Self::map_error)?;
        let room_id = if value.starts_with('#') {
            let alias = RoomAliasId::parse(value).map_err(Self::map_error)?;
            let room_id = client
                .resolve_room_alias(&alias)
                .await
                .map_err(Self::map_error)?
                .room_id;
            if !via.iter().any(|server| server == alias.server_name()) {
                via.push(alias.server_name().to_owned());
            }
            room_id
        } else {
            matrix_sdk::ruma::RoomId::parse(value).map_err(Self::map_error)?
        };

        if let Some(room) = client.get_room(&room_id) {
            if room.state() == RoomState::Invited {
                return Ok(CommunityAccessResult {
                    status: "joined".into(),
                    community: Some(
                        self.join_community(
                            room_or_alias,
                            via.iter().map(ToString::to_string).collect(),
                        )
                        .await?,
                    ),
                });
            }
            if room.state() == RoomState::Joined {
                let community = self
                    .list_communities()
                    .await?
                    .into_iter()
                    .find(|community| community.id == room_id.as_str());
                return Ok(CommunityAccessResult {
                    status: "joined".into(),
                    community,
                });
            }
        }

        client
            .knock(
                identifier,
                reason.filter(|value| !value.trim().is_empty()),
                via,
            )
            .await
            .map_err(Self::map_error)?;
        Ok(CommunityAccessResult {
            status: "knocked".into(),
            community: None,
        })
    }

    async fn list_community_applications(
        &self,
        community_id: String,
    ) -> BackendResult<Vec<CommunityApplication>> {
        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(community_id).map_err(Self::map_error)?;
        let space =
            Self::protected_joined_room(&client, &space_id, "reading community applications")
                .await?;
        let mut applications = Vec::new();
        for member in space
            .members(RoomMemberships::KNOCK)
            .await
            .map_err(Self::map_error)?
        {
            let requested_at = member.event().timestamp().and_then(|timestamp| {
                chrono::DateTime::from_timestamp_millis(u64::from(timestamp) as i64)
                    .map(|value| value.to_rfc3339())
            });
            applications.push(CommunityApplication {
                user_id: member.user_id().to_string(),
                display_name: member.name().to_owned(),
                reason: member.event().reason().map(ToOwned::to_owned),
                requested_at,
            });
        }
        applications.sort_by(|left, right| {
            left.requested_at
                .cmp(&right.requested_at)
                .then_with(|| left.user_id.cmp(&right.user_id))
        });
        Ok(applications)
    }

    async fn respond_community_application(
        &self,
        community_id: String,
        user_id: String,
        accept: bool,
        reason: Option<String>,
    ) -> BackendResult<()> {
        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(&community_id).map_err(Self::map_error)?;
        let user_id = matrix_sdk::ruma::UserId::parse(user_id).map_err(Self::map_error)?;
        let space = Self::protected_joined_room(
            &client,
            &space_id,
            "responding to a community application",
        )
        .await?;
        let is_pending = space
            .members(RoomMemberships::KNOCK)
            .await
            .map_err(Self::map_error)?
            .iter()
            .any(|member| member.user_id() == user_id);
        if !is_pending {
            return Err(BackendError::InvalidConfiguration(
                "the user no longer has a pending application for this community".into(),
            ));
        }

        if accept {
            self.invite_to_community(community_id, user_id.to_string())
                .await
        } else {
            space
                .kick_user(&user_id, reason.as_deref())
                .await
                .map_err(Self::map_error)
        }
    }

    async fn join_community(
        &self,
        room_or_alias: String,
        via: Vec<String>,
    ) -> BackendResult<CommunityDto> {
        let client = self.client().await?;
        let identifier = RoomOrAliasId::parse(room_or_alias.trim()).map_err(Self::map_error)?;
        let via = via
            .into_iter()
            .take(3)
            .map(ServerName::parse)
            .collect::<Result<Vec<_>, _>>()
            .map_err(Self::map_error)?;
        let space = client
            .join_room_by_id_or_alias(&identifier, &via)
            .await
            .map_err(Self::map_error)?;
        let presence = self.matrix_sync_control.lock().await.presence.clone();
        client
            .sync_once(SyncSettings::default().set_presence(presence.clone()))
            .await
            .map_err(Self::map_error)?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "join target is not a Matrix Space".into(),
            ));
        }

        let space =
            Self::protected_joined_room(&client, space.room_id(), "joining this community").await?;
        let mut opened_child_ids = Vec::new();
        for child_id in self.space_child_ids(&space).await? {
            if client
                .get_room(&child_id)
                .is_some_and(|room| room.state() == matrix_sdk::RoomState::Joined)
            {
                opened_child_ids.push(child_id);
                continue;
            }
            if client.join_room_by_id(&child_id).await.is_ok() {
                opened_child_ids.push(child_id);
            }
        }
        client
            .sync_once(SyncSettings::default().set_presence(presence))
            .await
            .map_err(Self::map_error)?;

        for child_id in opened_child_ids {
            Self::protected_joined_room(&client, &child_id, "joining this community").await?;
        }

        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let role = match space
            .get_suggested_user_role(own_user_id)
            .await
            .map_err(Self::map_error)?
        {
            RoomMemberRole::Creator => "owner",
            RoomMemberRole::Administrator | RoomMemberRole::Moderator => "admin",
            _ => "member",
        };
        Ok(CommunityDto {
            id: space.room_id().to_string(),
            name: space.name().unwrap_or_else(|| "Unnamed community".into()),
            description: space.topic().unwrap_or_default(),
            member_count: space.joined_members_count().min(u32::MAX as u64) as u32,
            role: role.into(),
            joined_at: Some(chrono::Utc::now().to_rfc3339()),
        })
    }

    async fn leave_community(&self, community_id: String) -> BackendResult<()> {
        let mut rooms = self.community_rooms(&community_id).await?;
        rooms.reverse();
        for room in rooms {
            if room.state() == matrix_sdk::RoomState::Joined {
                room.leave().await.map_err(Self::map_error)?;
            }
        }
        Ok(())
    }

    async fn update_community(
        &self,
        community_id: String,
        name: String,
        description: String,
    ) -> BackendResult<()> {
        if name.trim().is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "community name cannot be empty".into(),
            ));
        }
        let rooms = self.community_rooms(&community_id).await?;
        let space = rooms.first().ok_or_else(|| {
            BackendError::Other("community Space is not present in the local Matrix store".into())
        })?;
        space
            .set_name(name.trim().to_owned())
            .await
            .map_err(Self::map_error)?;
        space
            .set_room_topic(description.trim())
            .await
            .map_err(Self::map_error)?;
        Ok(())
    }

    async fn community_permission_projection(
        &self,
        community_id: String,
        subject_user_id: String,
    ) -> BackendResult<CommunityPermissionProjection> {
        MatrixBackend::community_permission_projection(self, &community_id, &subject_user_id).await
    }

    async fn update_member_role(
        &self,
        community_id: String,
        user_id: String,
        role: String,
    ) -> BackendResult<super::CommunityModerationResult> {
        self.apply_community_moderation(
            community_id,
            user_id,
            MatrixModerationAction::role(role)?,
            None,
        )
        .await
    }

    async fn kick_member(
        &self,
        community_id: String,
        user_id: String,
        reason: Option<String>,
    ) -> BackendResult<super::CommunityModerationResult> {
        self.apply_community_moderation(community_id, user_id, MatrixModerationAction::Kick, reason)
            .await
    }

    async fn ban_member(
        &self,
        community_id: String,
        user_id: String,
        reason: Option<String>,
    ) -> BackendResult<super::CommunityModerationResult> {
        self.apply_community_moderation(community_id, user_id, MatrixModerationAction::Ban, reason)
            .await
    }

    async fn list_moderation_audit(
        &self,
        community_id: String,
        limit: u32,
    ) -> BackendResult<Vec<ModerationAuditEntry>> {
        self.moderation_audit(&community_id, limit).await
    }

    async fn user_preferences(&self) -> BackendResult<Option<UserPreferences>> {
        let client = self.client().await?;
        let content = client
            .account()
            .fetch_account_data(GlobalAccountDataEventType::from(PREFERENCES_EVENT_TYPE))
            .await
            .map_err(Self::map_error)?;

        let preferences = content
            .map(|raw| {
                raw.deserialize_as_unchecked::<UserPreferences>()
                    .map_err(Self::map_error)
            })
            .transpose()?;
        if let Some(preferences) = preferences.as_ref() {
            self.apply_wire_privacy(preferences).await?;
        }
        Ok(preferences)
    }

    async fn update_user_preferences(
        &self,
        preferences: UserPreferences,
    ) -> BackendResult<UserPreferences> {
        let client = self.client().await?;
        let preferences = preferences.normalized();
        self.apply_wire_privacy(&preferences).await?;
        let content: Raw<AnyGlobalAccountDataEventContent> = Raw::new(&preferences)
            .map_err(Self::map_error)?
            .cast_unchecked();
        client
            .account()
            .set_account_data_raw(
                GlobalAccountDataEventType::from(PREFERENCES_EVENT_TYPE),
                content,
            )
            .await
            .map_err(Self::map_error)?;
        Ok(preferences)
    }

    async fn invite_user(&self, room_id: String, user_id: String) -> BackendResult<()> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let user_id = matrix_sdk::ruma::UserId::parse(user_id).map_err(Self::map_error)?;
        let room = Self::protected_joined_room(&client, &room_id, "inviting a room member").await?;
        room.invite_user_by_id(&user_id)
            .await
            .map_err(Self::map_error)
    }

    async fn join_room(&self, room_id: String) -> BackendResult<()> {
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let via = room_id
            .server_name()
            .map(ToOwned::to_owned)
            .into_iter()
            .collect::<Vec<_>>();
        let client = self.client().await?;
        let room = client
            .join_room_by_id_or_alias((&*room_id).into(), &via)
            .await
            .map_err(Self::map_error)?;
        let _ = self
            .cache_verified_room_upgrade(&client, &room, "following a room upgrade")
            .await;
        Ok(())
    }

    async fn recent_texts(&self, room_id: String, limit: u32) -> BackendResult<Vec<String>> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room =
            Self::protected_joined_room(&client, &room_id, "reading recent messages").await?;
        let mut options = MessagesOptions::backward();
        options.limit = limit.into();
        let messages = room.messages(options).await.map_err(Self::map_error)?;

        Ok(messages
            .chunk
            .into_iter()
            .filter_map(|event| {
                event
                    .raw()
                    .get_field::<serde_json::Value>("content")
                    .ok()
                    .flatten()
            })
            .filter_map(|content| {
                content
                    .get("body")
                    .and_then(|body| body.as_str())
                    .map(str::to_owned)
            })
            .collect())
    }

    async fn enable_recovery(&self, passphrase: Option<String>) -> BackendResult<String> {
        let client = self.client().await?;
        let recovery = client.encryption().recovery();
        let enable = recovery.enable().wait_for_backups_to_upload();
        match passphrase.as_deref() {
            Some(passphrase) if !passphrase.is_empty() => enable
                .with_passphrase(passphrase)
                .await
                .map_err(Self::map_error),
            _ => enable.await.map_err(Self::map_error),
        }
    }

    async fn recover(&self, recovery_key_or_passphrase: String) -> BackendResult<()> {
        if recovery_key_or_passphrase.is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "recovery key or passphrase cannot be empty".into(),
            ));
        }
        self.client()
            .await?
            .encryption()
            .recovery()
            .recover(&recovery_key_or_passphrase)
            .await
            .map_err(Self::map_error)
    }

    async fn sync_once(&self) -> BackendResult<()> {
        let client = self.client().await?;
        let mut sync = self.matrix_sync_control.lock().await;
        let task_epoch = {
            let mut freshness = Self::lock_matrix_sync_freshness(&self.matrix_sync_freshness);
            freshness.epoch = freshness.epoch.saturating_add(1);
            freshness.last_success_ms = 0;
            freshness.epoch
        };
        if let Some(task) = sync.task.take() {
            task.abort();
            let _ = task.await;
        }
        let result = client
            .sync_once(
                SyncSettings::default()
                    // Explicit one-shot synchronization must not inherit the
                    // background 30-second long poll. A one-second server poll
                    // is long enough to deliver newly published ephemeral
                    // state while remaining inside the caller's bounded
                    // deadline; the restarted background task below retains
                    // the normal long poll.
                    .timeout(Duration::from_secs(1))
                    .set_presence(sync.presence.clone()),
            )
            .await
            .map_err(Self::map_error);
        if result.is_ok() {
            Self::record_matrix_sync_success(
                &self.matrix_sync_freshness,
                task_epoch,
                Self::matrix_rtc_monotonic_now_ms(),
            );
            self.send_queue_reconcile.notify_one();
        }
        if !sync.paused {
            if let Some(client) = sync.client.clone() {
                sync.task = Some(Self::spawn_matrix_sync(
                    client,
                    sync.cadence,
                    sync.presence.clone(),
                    task_epoch,
                    Arc::clone(&self.matrix_sync_freshness),
                    sync.send_queue_reconcile.clone(),
                ));
            }
        }
        result.map(|_| ())
    }

    async fn import_legacy_event(
        &self,
        room_id: String,
        content: serde_json::Value,
    ) -> BackendResult<String> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room =
            Self::protected_joined_room(&client, &room_id, "importing legacy provenance").await?;
        let response = room
            .send_raw(crate::backend::LEGACY_MATRIX_EVENT_TYPE, content)
            .await
            .map_err(Self::map_error)?;
        Ok(response.response.event_id.to_string())
    }
}

#[cfg(test)]
#[path = "matrix/tests/mod.rs"]
mod tests;
