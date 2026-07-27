use std::{
    borrow::Cow,
    collections::{HashMap, HashSet, VecDeque},
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
use matrix_sdk::{
    authentication::{
        matrix::MatrixSession,
        oauth::{ClientId, OAuthSession, UserSession},
        AuthApi, AuthSession,
    },
    config::SyncSettings,
    deserialized_responses::{AlgorithmInfo, EncryptionInfo},
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
        MessagesOptions, Receipts, RoomMemberRole,
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
                room::{
                    create_room::v3::{CreationContent, Request as CreateRoomRequest, RoomPreset},
                    Visibility,
                },
                rtc::{transports::v1::Request as MatrixRtcTransportsRequest, RtcTransport},
                state::{get_state_events, send_state_event},
                uiaa::{self, AuthData, AuthType, Dummy, UiaaInfo},
            },
            error::ErrorKind,
            Metadata, OutgoingRequest, SupportedVersions,
        },
        directory::{Filter, RoomTypeFilter},
        events::{
            call::member::{CallMemberStateKey, Focus, OriginalSyncCallMemberEvent},
            direct::{DirectEventContent, DirectUserIdentifier},
            ignored_user_list::{IgnoredUser, IgnoredUserListEventContent},
            presence::PresenceEvent,
            reaction::ReactionEventContent,
            relation::Annotation,
            room::{
                encryption::RoomEncryptionEventContent,
                join_rules::JoinRule,
                message::{
                    AddMentions, FileInfo, FileMessageEventContent, MessageType,
                    OriginalSyncRoomMessageEvent, ReplacementMetadata, RoomMessageEventContent,
                    RoomMessageEventContentWithoutRelation,
                },
                EncryptedFile, EncryptedFileHash, EncryptedFileHashAlgorithm, MediaSource,
                ThumbnailInfo,
            },
            space::{child::SpaceChildEventContent, parent::SpaceParentEventContent},
            typing::SyncTypingEvent,
            AnyGlobalAccountDataEventContent, AnyInitialStateEvent, AnyStateEvent,
            AnyStateEventContent, AnyToDeviceEvent, AnyToDeviceEventContent,
            GlobalAccountDataEventType, InitialStateEvent, Mentions, StateEvent, StateEventType,
        },
        int,
        presence::PresenceState,
        push::Action,
        room::RoomType,
        serde::Raw,
        EventEncryptionAlgorithm, MxcUri, OwnedDeviceId, OwnedRoomAliasId, OwnedRoomId,
        OwnedServerName, OwnedTransactionId, OwnedUserId, RoomAliasId, RoomOrAliasId, ServerName,
        UserId,
    },
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
use tokio::sync::{Mutex, RwLock, Semaphore};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroize;

use crate::crypto::keychain;
use crate::security::{create_private_dir, has_blocked_attachment_extension, open_private_file};
use crate::types::{
    community::{ChannelDto, CommunityDto},
    dm::{DirectMessageDto, DmConversationDto},
    message::{AttachmentDto, AttachmentThumbnailDto, MessageDto},
};

use super::{
    BackendError, BackendKind, BackendResult, BackendStatus, CommunityAccessResult,
    CommunityAccessSettings, CommunityApplication, CommunityDirectoryEntry, CommunityMember,
    CreatedCommunity, MatrixAccount, MatrixAttachmentSendRequest, MatrixBackendEvent,
    MatrixBackendEventCallback, MatrixDevice, MatrixLogin, MatrixNotification,
    MatrixOidcAvailability, MatrixOidcStatus, MatrixProfile, MatrixRecoveryHealth,
    MatrixRoomNotificationMode, MatrixRtcJoinResult, MatrixRtcMediaKey, MatrixRtcMediaKeyFailure,
    MatrixRtcMediaKeyLease, MatrixRtcMediaKeyPause, MatrixRtcMember, MatrixRtcMembershipUpdate,
    MatrixTransferDirection, MatrixTransferObserver, MatrixTransferProgress,
    MatrixTransferProgressCallback, MatrixTransferResult, MatrixTransferRetryMode,
    MatrixTransferState, MatrixUnreadUpdate, MatrixVerificationSession, MeshBackend, SentMessage,
    TypingUser, UserPreferences, VerificationEmoji, VoiceServiceAvailability, VoiceServiceStatus,
};

mod oidc;

const SESSION_KEY: &str = "matrix-session-v1";
const STORE_PASSPHRASE_KEY: &str = "matrix-store-passphrase-v1";
const ACCOUNT_REGISTRY_KEY: &str = "matrix-account-registry-v1";
const TRUSTED_DEVICES_KEY: &str = "matrix-trusted-devices-v1";
const RECOVERY_TEST_KEY: &str = "matrix-recovery-test-v1";
const PREFERENCES_EVENT_TYPE: &str = "org.mesh.preferences.v1";
const MANAGED_HOMESERVER_ENV: &str = "MESH_MANAGED_HOMESERVER";
const MANAGED_SERVER_NAME_ENV: &str = "MESH_MANAGED_SERVER_NAME";
const LOGIN_TIMEOUT_SECONDS: u64 = 45;
const REGISTRATION_TIMEOUT_SECONDS: u64 = 45;
const OIDC_REDIRECT_URI: &str = "http://127.0.0.1:8418/oauth/callback";
const OIDC_CLIENT_ID_ENV: &str = "MESH_OAUTH_CLIENT_ID";
const MAX_COMPOSER_DRAFT_BYTES: usize = 16 * 1024;
const MAX_MEDIA_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_THUMBNAIL_SOURCE_PIXELS: u64 = 25_000_000;
const MAX_THUMBNAIL_SOURCE_DIMENSION: u32 = 16_384;
const MAX_THUMBNAIL_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_THUMBNAIL_DIMENSION: u32 = 512;
const MAX_THUMBNAIL_BYTES: usize = 2 * 1024 * 1024;
const MAX_INLINE_THUMBNAIL_DECODE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CONCURRENT_THUMBNAIL_LOADS: usize = 4;
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
}

impl Default for MatrixSyncControl {
    fn default() -> Self {
        Self {
            client: None,
            task: None,
            cadence: MatrixSyncCadence::Normal,
            presence: PresenceState::Offline,
            paused: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct WirePrivacyPreferences {
    send_read_receipts: bool,
    send_typing_indicators: bool,
    share_presence: bool,
    invisible_mode: bool,
}

impl From<&UserPreferences> for WirePrivacyPreferences {
    fn from(preferences: &UserPreferences) -> Self {
        Self {
            send_read_receipts: preferences.send_read_receipts,
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
struct ManagedHomeserverConfig {
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
    thumbnail_loads: Semaphore,
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
            thumbnail_loads: Semaphore::new(MAX_CONCURRENT_THUMBNAIL_LOADS),
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
            thumbnail_loads: Semaphore::new(MAX_CONCURRENT_THUMBNAIL_LOADS),
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

    fn dispatch_backend_event(
        callback: &Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
        event: MatrixBackendEvent,
    ) {
        let callback = callback
            .read()
            .ok()
            .and_then(|callback| callback.as_ref().cloned());
        if let Some(callback) = callback {
            callback(event);
        }
    }

    fn notification_preview(body: &str) -> String {
        let normalized = body.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut preview = normalized.chars().take(240).collect::<String>();
        if normalized.chars().count() > 240 {
            preview.push('…');
        }
        preview
    }

    /// Extract explicit Matrix user IDs from a message body for intentional mentions.
    ///
    /// Display names and local `@everyone`-style conventions are deliberately ignored until
    /// the composer has a member-backed representation and a server-side policy for them.
    fn mentions_for_body(body: &str, own_user_id: Option<&UserId>) -> Mentions {
        const MAX_MENTIONS: usize = 64;
        const MAX_SCAN_BYTES: usize = 16 * 1024;

        let mut mentions = Mentions::new();
        for (at_index, character) in body.char_indices() {
            if at_index >= MAX_SCAN_BYTES {
                break;
            }
            if character != '@' || mentions.user_ids.len() >= MAX_MENTIONS {
                continue;
            }

            let boundary = body[..at_index].chars().next_back().is_none_or(|previous| {
                previous.is_whitespace()
                    || matches!(previous, '<' | '(' | '[' | '{' | '"' | '\'' | '`')
            });
            if !boundary {
                continue;
            }

            let candidate = body[at_index..]
                .split(|character: char| {
                    character.is_whitespace()
                        || matches!(
                            character,
                            '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\'' | '`'
                        )
                })
                .next()
                .unwrap_or_default()
                .trim_end_matches(|character: char| {
                    matches!(character, '.' | ',' | '!' | '?' | ';' | ':')
                });
            let Ok(user_id) = UserId::parse(candidate) else {
                continue;
            };
            if own_user_id.is_some_and(|own_user_id| own_user_id == user_id) {
                continue;
            }
            mentions.user_ids.insert(user_id);
        }
        mentions
    }

    async fn emit_room_unread(
        client: &Client,
        callback: &Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
        room_id: &matrix_sdk::ruma::RoomId,
    ) {
        let room =
            match Self::protected_joined_room(client, room_id, "reading unread message counts")
                .await
            {
                Ok(room) => room,
                Err(error) => {
                    tracing::warn!(
                        target: "mesh::security",
                        room_id = %room_id,
                        "Suppressed unread state for an unprotected room: {error}"
                    );
                    return;
                }
            };
        Self::dispatch_backend_event(
            callback,
            MatrixBackendEvent::UnreadUpdate(MatrixUnreadUpdate {
                room_id: room.room_id().to_string(),
                unread_messages: room.num_unread_messages().min(i64::MAX as u64) as i64,
                unread_mentions: room.num_unread_mentions().min(i64::MAX as u64) as i64,
            }),
        );
    }

    async fn emit_all_room_unreads(
        client: &Client,
        callback: &Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
    ) {
        for room in client.rooms() {
            Self::emit_room_unread(client, callback, room.room_id()).await;
        }
    }

    fn matrix_rtc_room_name(room_id: &str) -> BackendResult<String> {
        let canonical = serde_json::to_vec(&[room_id, MATRIX_RTC_SLOT_ID])
            .map_err(|error| BackendError::Serialization(error.to_string()))?;
        Ok(BASE64_STANDARD.encode(Sha256::digest(canonical)))
    }

    fn matrix_rtc_participant_identity(
        user_id: &str,
        device_id: &str,
        member_id: &str,
    ) -> BackendResult<String> {
        let canonical = serde_json::to_vec(&[user_id, device_id, member_id])
            .map_err(|error| BackendError::Serialization(error.to_string()))?;
        Ok(BASE64_STANDARD.encode(Sha256::digest(canonical)))
    }

    fn matrix_rtc_membership_id(raw_event: &str, sender: &str, device_id: &str) -> String {
        let content = serde_json::from_str::<serde_json::Value>(raw_event)
            .ok()
            .and_then(|event| event.get("content").cloned());
        let explicit = content.as_ref().and_then(|content| {
            content
                .get("membershipID")
                .and_then(serde_json::Value::as_str)
                .filter(|member_id| !member_id.is_empty())
                .map(ToOwned::to_owned)
                .or_else(|| {
                    content
                        .get("memberships")
                        .and_then(serde_json::Value::as_array)
                        .and_then(|memberships| {
                            memberships.iter().find_map(|membership| {
                                (membership
                                    .get("device_id")
                                    .and_then(serde_json::Value::as_str)
                                    == Some(device_id))
                                .then(|| {
                                    membership
                                        .get("membershipID")
                                        .and_then(serde_json::Value::as_str)
                                        .filter(|member_id| !member_id.is_empty())
                                        .map(ToOwned::to_owned)
                                })
                                .flatten()
                            })
                        })
                })
        });
        explicit.unwrap_or_else(|| format!("{sender}:{device_id}"))
    }

    fn matrix_rtc_key_now_ms() -> u64 {
        u64::from(matrix_sdk::ruma::MilliSecondsSinceUnixEpoch::now().get())
    }

    fn matrix_rtc_monotonic_now_ms() -> u64 {
        static PROCESS_EPOCH: OnceLock<Instant> = OnceLock::new();
        (PROCESS_EPOCH
            .get_or_init(Instant::now)
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64)
            .saturating_add(1)
    }

    fn decode_matrix_rtc_media_key(
        encoded: &str,
    ) -> BackendResult<[u8; MATRIX_RTC_MEDIA_KEY_BYTES]> {
        let mut decoded = BASE64_STANDARD.decode(encoded).map_err(|_| {
            BackendError::InvalidConfiguration(
                "MatrixRTC media key was not valid canonical unpadded base64".into(),
            )
        })?;
        if decoded.len() != MATRIX_RTC_MEDIA_KEY_BYTES
            || BASE64_STANDARD.encode(&decoded) != encoded
        {
            decoded.zeroize();
            return Err(BackendError::InvalidConfiguration(format!(
                "MatrixRTC media key must decode to exactly {MATRIX_RTC_MEDIA_KEY_BYTES} bytes"
            )));
        }
        let mut key = [0_u8; MATRIX_RTC_MEDIA_KEY_BYTES];
        key.copy_from_slice(&decoded);
        decoded.zeroize();
        Ok(key)
    }

    fn validate_matrix_rtc_media_key(
        content: MatrixRtcToDeviceKeyContent,
        envelope_sender: &str,
        olm_sender: &str,
        olm_device: &str,
        memberships: &[ActiveMatrixRtcMembership],
        now_ms: u64,
        runtime: &mut MatrixRtcMediaKeyRuntime,
    ) -> BackendResult<MatrixRtcMediaKey> {
        if envelope_sender != olm_sender {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC media key sender did not match its Olm sender".into(),
            ));
        }
        if content.session.application != "m.call"
            || !content.session.call_id.is_empty()
            || content.session.scope != "m.room"
        {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC media key was for a different RTC session".into(),
            ));
        }
        if content.member.claimed_device_id != olm_device {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC media key claimed a different Olm device".into(),
            ));
        }
        if content.sent_ts
            > now_ms.saturating_add(MATRIX_RTC_KEY_MAX_FUTURE_SKEW.as_millis() as u64)
            || now_ms.saturating_sub(content.sent_ts) > MATRIX_RTC_KEY_MAX_AGE.as_millis() as u64
        {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC media key was stale or too far in the future".into(),
            ));
        }

        let membership = memberships.iter().find(|membership| {
            membership.member.room_id == content.room_id
                && membership.member.user_id == envelope_sender
                && membership.member.device_id == olm_device
                && membership.member_id == content.member.id
        });
        let Some(_membership) = membership else {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC media key was not bound to a current room membership".into(),
            ));
        };

        let key_entry = content.keys;
        let mut key = Self::decode_matrix_rtc_media_key(&key_entry.key)?;
        let key_digest: [u8; 32] = Sha256::digest(key).into();
        let publisher = (
            content.room_id.clone(),
            envelope_sender.to_owned(),
            olm_device.to_owned(),
            content.member.id.clone(),
        );
        if let Some(previous) = runtime.inbound.get(&publisher) {
            if content.sent_ts <= previous.sent_ts {
                key.zeroize();
                return Err(BackendError::PermissionDenied(
                    "MatrixRTC media key was replayed or stale".into(),
                ));
            }
            let generation_delta = key_entry.index.wrapping_sub(previous.key_index);
            if generation_delta == 0 || generation_delta > 127 {
                key.zeroize();
                return Err(BackendError::PermissionDenied(
                    "MatrixRTC media key index was replayed or moved backwards".into(),
                ));
            }
            if key_digest == previous.key_digest {
                key.zeroize();
                return Err(BackendError::PermissionDenied(
                    "MatrixRTC publisher reused key material across rotations".into(),
                ));
            }
        } else if runtime.inbound.len() >= MATRIX_RTC_MAX_INBOUND_PUBLISHERS {
            key.zeroize();
            return Err(BackendError::RateLimited(
                "MatrixRTC inbound publisher key limit reached".into(),
            ));
        }

        let participant_identity =
            Self::matrix_rtc_participant_identity(envelope_sender, olm_device, &content.member.id)?;
        runtime.inbound.insert(
            publisher,
            MatrixRtcInboundMediaKey {
                key_index: key_entry.index,
                sent_ts: content.sent_ts,
                key_digest,
            },
        );
        key.zeroize();
        Ok(MatrixRtcMediaKey {
            room_id: content.room_id,
            user_id: envelope_sender.to_owned(),
            device_id: olm_device.to_owned(),
            member_id: content.member.id,
            session_id: None,
            activation_id: None,
            participant_identity,
            key_index: key_entry.index,
            key: key_entry.key,
            sent_ts: content.sent_ts,
        })
    }

    fn record_matrix_rtc_key_attempt(
        runtime: &mut MatrixRtcMediaKeyRuntime,
        sender: &str,
        device_id: &str,
        now_ms: u64,
    ) -> BackendResult<()> {
        let cutoff = now_ms.saturating_sub(Duration::from_secs(60).as_millis() as u64);
        runtime.attempts.retain(|_, attempts| {
            while attempts.front().is_some_and(|attempt| *attempt < cutoff) {
                attempts.pop_front();
            }
            !attempts.is_empty()
        });
        let identity = (sender.to_owned(), device_id.to_owned());
        if !runtime.attempts.contains_key(&identity)
            && runtime.attempts.len() >= MATRIX_RTC_MAX_INBOUND_PUBLISHERS
        {
            return Err(BackendError::RateLimited(
                "MatrixRTC media key sender limit reached".into(),
            ));
        }
        let attempts = runtime.attempts.entry(identity).or_default();
        if attempts.len() >= MATRIX_RTC_KEY_ATTEMPTS_PER_MINUTE {
            return Err(BackendError::RateLimited(
                "MatrixRTC media key attempt rate exceeded".into(),
            ));
        }
        attempts.push_back(now_ms);
        Ok(())
    }

    fn matrix_rtc_key_recipients(
        memberships: &[ActiveMatrixRtcMembership],
        own_user_id: &str,
        own_device_id: &str,
    ) -> BackendResult<HashSet<MatrixRtcKeyParticipant>> {
        let recipients = memberships
            .iter()
            .filter(|membership| {
                membership.member.user_id != own_user_id
                    || membership.member.device_id != own_device_id
            })
            .map(|membership| MatrixRtcKeyParticipant {
                user_id: membership.member.user_id.clone(),
                device_id: membership.member.device_id.clone(),
                member_id: membership.member_id.clone(),
            })
            .collect::<HashSet<_>>();
        if recipients.len() > MATRIX_RTC_MAX_PARTICIPANTS {
            return Err(BackendError::RateLimited(format!(
                "MatrixRTC media key recipient limit of {MATRIX_RTC_MAX_PARTICIPANTS} exceeded"
            )));
        }
        Ok(recipients)
    }

    fn matrix_rtc_membership_content(
        device_id: &str,
        member_id: &str,
        livekit_service_url: &str,
        created_ts: u64,
        now: u64,
    ) -> BackendResult<serde_json::Value> {
        let expires = now
            .saturating_sub(created_ts)
            .saturating_add(MATRIX_RTC_MEMBERSHIP_TTL.as_millis() as u64);
        serde_json::to_value(MatrixRtcSessionEventContent {
            application: "m.call".into(),
            call_id: String::new(),
            scope: "m.room".into(),
            device_id: device_id.to_owned(),
            membership_id: member_id.to_owned(),
            expires,
            created_ts,
            focus_active: MatrixRtcActiveFocus {
                focus_type: "livekit".into(),
                focus_selection: "oldest_membership".into(),
            },
            foci_preferred: vec![MatrixRtcPreferredFocus {
                focus_type: "livekit".into(),
                livekit_service_url: livekit_service_url.to_owned(),
            }],
            call_intent: "audio".into(),
        })
        .map_err(|error| BackendError::Serialization(error.to_string()))
    }

    fn validate_matrix_rtc_sfu_url(returned: &str, expected: &str) -> BackendResult<String> {
        let returned = VoiceServiceStatus::secure_url("MSC4195 LiveKit URL", returned, "wss")
            .map_err(BackendError::InvalidConfiguration)?;
        let expected =
            VoiceServiceStatus::secure_url("MESH_MATRIXRTC_LIVEKIT_SFU_URL", expected, "wss")
                .map_err(BackendError::InvalidConfiguration)?;
        if returned != expected {
            return Err(BackendError::InvalidConfiguration(
                "MatrixRTC authorization returned an unexpected LiveKit endpoint".into(),
            ));
        }
        Ok(returned.to_string())
    }

    fn classify_matrix_rtc_endpoint_failure(
        status_code: Option<u16>,
        error_kind: Option<&ErrorKind>,
    ) -> MatrixRtcEndpointFailure {
        // Some homeservers return a bare 404 while others return the Matrix
        // M_UNRECOGNIZED body. Both mean that this unstable endpoint is not
        // implemented and are the only conditions that permit fallback.
        if status_code == Some(404)
            || error_kind.is_some_and(|kind| matches!(kind, ErrorKind::Unrecognized))
        {
            return MatrixRtcEndpointFailure::FallbackToWellKnown;
        }
        if error_kind.is_some_and(|kind| {
            matches!(kind, ErrorKind::Unauthorized | ErrorKind::UnknownToken(_))
        }) || status_code == Some(401)
        {
            return MatrixRtcEndpointFailure::Unauthorized;
        }
        if error_kind.is_some_and(|kind| matches!(kind, ErrorKind::LimitExceeded(_)))
            || status_code == Some(429)
        {
            return MatrixRtcEndpointFailure::RateLimited;
        }
        MatrixRtcEndpointFailure::Other
    }

    fn parse_matrix_rtc_transports(
        transports: Vec<RtcTransport>,
        source: MatrixRtcDiscoverySource,
    ) -> BackendResult<MatrixRtcDiscovery> {
        for transport in transports {
            if transport.transport_type() != "livekit" {
                continue;
            }
            let raw_url = {
                let data = transport.data();
                data.get("livekit_service_url")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
            }
            .ok_or_else(|| {
                BackendError::Serialization(format!(
                    "{} advertised a LiveKit transport without livekit_service_url",
                    source.label()
                ))
            })?;
            let service_url = VoiceServiceStatus::secure_url(
                &format!("{} LiveKit service URL", source.label()),
                &raw_url,
                "https",
            )
            .map_err(BackendError::InvalidConfiguration)?;
            return Ok(MatrixRtcDiscovery {
                service_url: service_url.to_string(),
                source,
            });
        }
        Err(BackendError::NotFound(format!(
            "{} did not advertise a LiveKit transport under {MATRIX_RTC_DISCOVERY_KEY}",
            source.label()
        )))
    }

    fn matrix_rtc_endpoint_error(error: &matrix_sdk::HttpError) -> BackendError {
        let api_error = error.as_client_api_error();
        let status_code = api_error.map(|api_error| api_error.status_code.as_u16());
        match Self::classify_matrix_rtc_endpoint_failure(
            status_code,
            api_error.and_then(|api_error| api_error.error_kind()),
        ) {
            MatrixRtcEndpointFailure::Unauthorized => BackendError::NotAuthenticated,
            MatrixRtcEndpointFailure::RateLimited => BackendError::RateLimited(format!(
                "MatrixRTC discovery endpoint {MATRIX_RTC_TRANSPORTS_PATH} rate limited the request"
            )),
            MatrixRtcEndpointFailure::FallbackToWellKnown | MatrixRtcEndpointFailure::Other => {
                BackendError::Network(format!(
                    "MatrixRTC discovery endpoint {MATRIX_RTC_TRANSPORTS_PATH} failed: {error}"
                ))
            }
        }
    }

    async fn discover_matrix_rtc_service_url(client: &Client) -> BackendResult<MatrixRtcDiscovery> {
        // Client::send supplies the SDK's current access token for this
        // authenticated endpoint. Do not hand-roll this request with a bare
        // reqwest client: omitting Authorization is a common MSC4143 failure.
        match client.send(MatrixRtcTransportsRequest::new()).await {
            Ok(response) => Self::parse_matrix_rtc_transports(
                response.rtc_transports,
                MatrixRtcDiscoverySource::AuthenticatedEndpoint,
            ),
            Err(error) => {
                let api_error = error.as_client_api_error();
                let status_code = api_error.map(|api_error| api_error.status_code.as_u16());
                let failure = Self::classify_matrix_rtc_endpoint_failure(
                    status_code,
                    api_error.and_then(|api_error| api_error.error_kind()),
                );
                if failure != MatrixRtcEndpointFailure::FallbackToWellKnown {
                    return Err(Self::matrix_rtc_endpoint_error(&error));
                }

                let fallback = client.rtc_foci().await.map_err(|fallback_error| {
                    BackendError::Network(format!(
                        "MatrixRTC authenticated discovery was unavailable (HTTP 404 or M_UNRECOGNIZED), and {MATRIX_RTC_DISCOVERY_KEY} fallback failed: {fallback_error}"
                    ))
                })?;
                Self::parse_matrix_rtc_transports(
                    fallback,
                    MatrixRtcDiscoverySource::WellKnownFallback,
                )
                .map_err(|fallback_error| {
                    BackendError::InvalidConfiguration(format!(
                        "MatrixRTC authenticated discovery was unavailable (HTTP 404 or M_UNRECOGNIZED); {MATRIX_RTC_DISCOVERY_KEY} fallback is unusable: {fallback_error}"
                    ))
                })
            }
        }
    }

    fn matrix_rtc_config() -> BackendResult<VoiceServiceStatus> {
        let status = VoiceServiceStatus::for_kind(BackendKind::Matrix);
        match status.availability {
            VoiceServiceAvailability::ClientUnavailable
                if status.csp_ready
                    && status.livekit_service_url.is_some()
                    && status.livekit_sfu_url.is_some() =>
            {
                Ok(status)
            }
            _ => Err(BackendError::InvalidConfiguration(
                status
                    .reason
                    .unwrap_or_else(|| "MatrixRTC service is not configured".into()),
            )),
        }
    }

    fn require_matrix_rtc_media_e2ee_ready() -> BackendResult<()> {
        Err(BackendError::Unsupported(
            "MatrixRTC joining is disabled until membership-bound media E2EE is implemented and verified",
        ))
    }

    async fn active_matrix_rtc_memberships(
        room: &Room,
    ) -> BackendResult<Vec<ActiveMatrixRtcMembership>> {
        let response = room
            .client()
            .send(get_state_events::v3::Request::new(
                room.room_id().to_owned(),
            ))
            .await
            .map_err(Self::map_error)?;
        let mut memberships = Vec::new();

        for raw in response.room_state {
            let raw_event = raw.json().get().to_owned();
            let event = raw.deserialize().map_err(Self::map_error)?;
            let AnyStateEvent::CallMember(StateEvent::Original(event)) = event else {
                continue;
            };
            if event.state_key.user_id() != event.sender {
                continue;
            }
            let Some(room_member) = room
                .get_member(&event.sender)
                .await
                .map_err(Self::map_error)?
            else {
                continue;
            };
            if room_member.membership().as_str() != "join" {
                continue;
            }

            for membership in event
                .content
                .active_memberships(Some(event.origin_server_ts))
            {
                if !membership.is_room_call() {
                    continue;
                }
                let member_id = Self::matrix_rtc_membership_id(
                    &raw_event,
                    event.sender.as_str(),
                    membership.device_id().as_str(),
                );
                let session_id = event.state_key.as_ref().to_owned();
                let livekit_service_url =
                    membership
                        .foci_preferred()
                        .iter()
                        .find_map(|focus| match focus {
                            Focus::Livekit(focus) => Some(focus.service_url.clone()),
                            #[allow(unreachable_patterns)]
                            _ => None,
                        });
                memberships.push(ActiveMatrixRtcMembership {
                    member_id,
                    member: MatrixRtcMember {
                        room_id: room.room_id().to_string(),
                        user_id: event.sender.to_string(),
                        device_id: membership.device_id().to_string(),
                        session_id,
                        display_name: room_member.name().to_owned(),
                        avatar_url: room_member.avatar_url().map(ToString::to_string),
                    },
                    created_ts: membership.created_ts().unwrap_or(event.origin_server_ts),
                    livekit_service_url,
                });
            }
        }

        memberships.sort_by(|left, right| {
            left.created_ts
                .cmp(&right.created_ts)
                .then_with(|| left.member.user_id.cmp(&right.member.user_id))
                .then_with(|| left.member.device_id.cmp(&right.member.device_id))
                .then_with(|| left.member.session_id.cmp(&right.member.session_id))
        });
        Ok(memberships)
    }

    async fn matrix_rtc_members_for_room(room: &Room) -> BackendResult<Vec<MatrixRtcMember>> {
        Ok(Self::active_matrix_rtc_memberships(room)
            .await?
            .into_iter()
            .map(|membership| membership.member)
            .collect())
    }

    fn matrix_rtc_recipient_fingerprint(
        recipients: &HashSet<MatrixRtcKeyParticipant>,
    ) -> BackendResult<String> {
        let mut canonical = recipients
            .iter()
            .map(|recipient| {
                (
                    recipient.user_id.as_str(),
                    recipient.device_id.as_str(),
                    recipient.member_id.as_str(),
                )
            })
            .collect::<Vec<_>>();
        canonical.sort_unstable();
        let canonical = serde_json::to_vec(&canonical)
            .map_err(|error| BackendError::Serialization(error.to_string()))?;
        Ok(BASE64_STANDARD.encode(Sha256::digest(canonical)))
    }

    fn ensure_matrix_rtc_local_membership(
        memberships: &[ActiveMatrixRtcMembership],
        own_user_id: &str,
        session: &MatrixRtcLocalSession,
    ) -> BackendResult<()> {
        if memberships.iter().any(|membership| {
            membership.member.user_id == own_user_id
                && membership.member.device_id == session.device_id.as_str()
                && membership.member_id == session.member_id
        }) {
            Ok(())
        } else {
            Err(BackendError::PermissionDenied(
                "MatrixRTC local membership epoch is no longer current".into(),
            ))
        }
    }

    fn matrix_rtc_local_media_key(
        own_user_id: &str,
        session: &MatrixRtcLocalSession,
        key_index: u8,
        key: &[u8; MATRIX_RTC_MEDIA_KEY_BYTES],
        sent_ts: u64,
        activation_id: Option<String>,
    ) -> BackendResult<MatrixRtcMediaKey> {
        Ok(MatrixRtcMediaKey {
            room_id: session.room.room_id().to_string(),
            user_id: own_user_id.to_owned(),
            device_id: session.device_id.to_string(),
            member_id: session.member_id.clone(),
            session_id: Some(session.session_id.clone()),
            activation_id,
            participant_identity: Self::matrix_rtc_participant_identity(
                own_user_id,
                session.device_id.as_str(),
                &session.member_id,
            )?,
            key_index,
            key: BASE64_STANDARD.encode(key),
            sent_ts,
        })
    }

    async fn distribute_matrix_rtc_media_key(
        client: &Client,
        session: &MatrixRtcLocalSession,
        recipients: &HashSet<MatrixRtcKeyParticipant>,
        key_index: u8,
        key: &[u8; MATRIX_RTC_MEDIA_KEY_BYTES],
        sent_ts: u64,
    ) -> BackendResult<()> {
        let content = MatrixRtcToDeviceKeyContent {
            keys: MatrixRtcMediaKeyEntry {
                index: key_index,
                key: BASE64_STANDARD.encode(key),
            },
            room_id: session.room.room_id().to_string(),
            member: MatrixRtcMediaKeyMember {
                claimed_device_id: session.device_id.to_string(),
                id: session.member_id.clone(),
            },
            session: MatrixRtcMediaKeySession {
                application: "m.call".into(),
                call_id: String::new(),
                scope: "m.room".into(),
            },
            sent_ts,
        };
        let mut devices = Vec::new();
        let mut device_targets = HashSet::new();
        for recipient in recipients {
            if !device_targets.insert((recipient.user_id.clone(), recipient.device_id.clone())) {
                continue;
            }
            let user_id =
                matrix_sdk::ruma::UserId::parse(&recipient.user_id).map_err(Self::map_error)?;
            let device_id = OwnedDeviceId::from(recipient.device_id.clone());
            let device = client
                .encryption()
                .get_device(&user_id, &device_id)
                .await
                .map_err(Self::map_error)?
                .ok_or_else(|| {
                    BackendError::PermissionDenied(
                        "MatrixRTC recipient device is absent from the encrypted device store"
                            .into(),
                    )
                })?;
            devices.push(device);
        }
        if devices.is_empty() {
            return Ok(());
        }
        let raw: Raw<AnyToDeviceEventContent> = Raw::new(&content)
            .map_err(|error| BackendError::Serialization(error.to_string()))?
            .cast_unchecked();
        let failures = client
            .encryption()
            .encrypt_and_send_raw_to_device(
                devices.iter().collect(),
                MATRIX_RTC_KEY_TO_DEVICE_EVENT_TYPE,
                raw,
                CollectStrategy::AllDevices,
            )
            .await
            .map_err(Self::map_error)?;
        if failures.is_empty() {
            Ok(())
        } else {
            Err(BackendError::Network(format!(
                "MatrixRTC media key delivery failed for {} recipient device(s)",
                failures.len()
            )))
        }
    }

    async fn create_initial_matrix_rtc_media_key(
        client: &Client,
        session: &MatrixRtcLocalSession,
        memberships: &[ActiveMatrixRtcMembership],
        runtime: &Arc<Mutex<MatrixRtcMediaKeyRuntime>>,
    ) -> BackendResult<MatrixRtcMediaKey> {
        let own_user_id = client
            .user_id()
            .ok_or(BackendError::NotAuthenticated)?
            .to_owned();
        Self::ensure_matrix_rtc_local_membership(memberships, own_user_id.as_str(), session)?;
        let recipients = Self::matrix_rtc_key_recipients(
            memberships,
            own_user_id.as_str(),
            session.device_id.as_str(),
        )?;
        let mut key = [0_u8; MATRIX_RTC_MEDIA_KEY_BYTES];
        rand::rngs::OsRng.fill_bytes(&mut key);
        let sent_ts = Self::matrix_rtc_key_now_ms();
        Self::distribute_matrix_rtc_media_key(client, session, &recipients, 0, &key, sent_ts)
            .await?;
        tokio::time::sleep(MATRIX_RTC_KEY_DISTRIBUTION_DELAY).await;
        let latest_memberships = Self::active_matrix_rtc_memberships(&session.room).await?;
        Self::ensure_matrix_rtc_local_membership(
            &latest_memberships,
            own_user_id.as_str(),
            session,
        )?;
        let latest_recipients = Self::matrix_rtc_key_recipients(
            &latest_memberships,
            own_user_id.as_str(),
            session.device_id.as_str(),
        )?;
        if latest_recipients != recipients {
            key.zeroize();
            return Err(BackendError::PermissionDenied(
                "MatrixRTC membership changed during initial key activation".into(),
            ));
        }
        let media_key = Self::matrix_rtc_local_media_key(
            own_user_id.as_str(),
            session,
            0,
            &key,
            sent_ts,
            None,
        )?;
        let state_key = (
            session.room.room_id().to_string(),
            session.session_id.clone(),
        );
        let mut runtime = runtime.lock().await;
        if runtime.outbound.contains_key(&state_key)
            || runtime.pending_activations.contains_key(&state_key)
        {
            key.zeroize();
            return Err(BackendError::PermissionDenied(
                "MatrixRTC initial key activation was superseded".into(),
            ));
        }
        runtime.lease_blocked.remove(&state_key);
        runtime.outbound.insert(
            state_key,
            MatrixRtcOutboundMediaKey {
                key_index: 0,
                key,
                recipients,
            },
        );
        Ok(media_key)
    }

    async fn prepare_matrix_rtc_media_key_activation(
        session: &MatrixRtcLocalSession,
        memberships: &[ActiveMatrixRtcMembership],
        own_user_id: &str,
        runtime: &Arc<Mutex<MatrixRtcMediaKeyRuntime>>,
    ) -> BackendResult<Option<MatrixRtcMediaKeyPause>> {
        Self::ensure_matrix_rtc_local_membership(memberships, own_user_id, session)?;
        let recipients =
            Self::matrix_rtc_key_recipients(memberships, own_user_id, session.device_id.as_str())?;
        let recipient_fingerprint = Self::matrix_rtc_recipient_fingerprint(&recipients)?;
        let state_key = (
            session.room.room_id().to_string(),
            session.session_id.clone(),
        );
        let now = Self::matrix_rtc_monotonic_now_ms();
        let mut runtime = runtime.lock().await;
        runtime.completed_activations.retain(|_, completed| {
            now.saturating_sub(completed.completed_at)
                <= MATRIX_RTC_COMPLETED_ACTIVATION_TTL.as_millis() as u64
        });
        if runtime
            .outbound
            .get(&state_key)
            .is_some_and(|current| current.recipients == recipients)
        {
            runtime.pending_activations.remove(&state_key);
            return Ok(None);
        }
        if let Some(pending) = runtime.pending_activations.get(&state_key) {
            if pending.expires_at > now
                && pending.member_id == session.member_id
                && pending.recipients == recipients
            {
                return Ok(None);
            }
        }
        runtime.pending_activations.remove(&state_key);
        runtime.completed_activations.remove(&state_key);
        if runtime.pending_activations.len() >= MATRIX_RTC_MAX_PENDING_ACTIVATIONS {
            return Err(BackendError::RateLimited(
                "MatrixRTC pending activation limit reached".into(),
            ));
        }
        let key_index = runtime
            .outbound
            .get(&state_key)
            .map_or(0, |current| current.key_index.wrapping_add(1));
        let activation_id = uuid::Uuid::new_v4().to_string();
        let mut key = [0_u8; MATRIX_RTC_MEDIA_KEY_BYTES];
        rand::rngs::OsRng.fill_bytes(&mut key);
        runtime.pending_activations.insert(
            state_key,
            MatrixRtcPendingActivation {
                activation_id: activation_id.clone(),
                room_id: session.room.room_id().to_string(),
                session_id: session.session_id.clone(),
                member_id: session.member_id.clone(),
                key_index,
                key,
                recipients,
                recipient_fingerprint,
                expires_at: now.saturating_add(MATRIX_RTC_KEY_ACTIVATION_TTL.as_millis() as u64),
                phase: MatrixRtcActivationPhase::AwaitingPauseAck,
            },
        );
        Ok(Some(MatrixRtcMediaKeyPause {
            room_id: session.room.room_id().to_string(),
            session_id: session.session_id.clone(),
            member_id: session.member_id.clone(),
            activation_id,
            key_index,
        }))
    }

    fn spawn_matrix_rtc_activation_timeout(
        pause: MatrixRtcMediaKeyPause,
        runtime: Arc<Mutex<MatrixRtcMediaKeyRuntime>>,
        sessions: Arc<Mutex<HashMap<(String, String), MatrixRtcLocalSession>>>,
        writes: Arc<Mutex<()>>,
        sync: MatrixSyncCoordinator,
        callback: Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
    ) {
        tokio::spawn(async move {
            tokio::time::sleep(MATRIX_RTC_KEY_ACTIVATION_TTL).await;
            let state_key = (pause.room_id.clone(), pause.session_id.clone());
            let removed = {
                let mut runtime = runtime.lock().await;
                let expired = runtime
                    .pending_activations
                    .get(&state_key)
                    .is_some_and(|pending| {
                        pending.activation_id == pause.activation_id
                            && pending.member_id == pause.member_id
                            && pending.expires_at <= Self::matrix_rtc_monotonic_now_ms()
                    });
                if expired {
                    runtime.pending_activations.remove(&state_key);
                    runtime.outbound.remove(&state_key);
                    runtime.completed_activations.remove(&state_key);
                    runtime.lease_blocked.insert(state_key.clone());
                }
                expired
            };
            if !removed {
                return;
            }
            let session = {
                let mut sessions = sessions.lock().await;
                sessions.get_mut(&state_key).and_then(|active| {
                    (active.member_id == pause.member_id).then(|| {
                        active.ready = false;
                        active.clone()
                    })
                })
            };
            Self::reconcile_matrix_sync_cadence(&sessions, &sync.control, &sync.freshness).await;
            let cleared = if let Some(session) = session {
                session.cancellation.cancel();
                Self::clear_current_matrix_rtc_membership(&session, &sessions, &writes)
                    .await
                    .unwrap_or(false)
            } else {
                false
            };
            {
                let mut runtime = runtime.lock().await;
                runtime.outbound.remove(&state_key);
                runtime.completed_activations.remove(&state_key);
                if cleared {
                    runtime.lease_blocked.remove(&state_key);
                }
            }
            Self::dispatch_backend_event(
                &callback,
                MatrixBackendEvent::RtcMediaKeyFailure(MatrixRtcMediaKeyFailure {
                    room_id: pause.room_id,
                    code: "activation-expired".into(),
                }),
            );
        });
    }

    async fn fail_closed_matrix_rtc_room(
        room_id: &str,
        sessions: &Arc<Mutex<HashMap<(String, String), MatrixRtcLocalSession>>>,
        runtime: &Arc<Mutex<MatrixRtcMediaKeyRuntime>>,
        writes: &Arc<Mutex<()>>,
        sync: &MatrixSyncCoordinator,
        callback: &Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
        code: &str,
    ) {
        let failed_sessions = {
            let mut sessions = sessions.lock().await;
            sessions
                .iter_mut()
                .filter(|((active_room_id, _), _)| active_room_id == room_id)
                .map(|(_, session)| {
                    session.ready = false;
                    session.cancellation.cancel();
                    session.clone()
                })
                .collect::<Vec<_>>()
        };
        let failed_keys = failed_sessions
            .iter()
            .map(|session| (room_id.to_owned(), session.session_id.clone()))
            .collect::<Vec<_>>();
        {
            let mut runtime = runtime.lock().await;
            for key in &failed_keys {
                runtime.lease_blocked.insert(key.clone());
                runtime.outbound.remove(key);
                runtime.pending_activations.remove(key);
                runtime.completed_activations.remove(key);
            }
        }
        Self::reconcile_matrix_sync_cadence(sessions, &sync.control, &sync.freshness).await;
        for (session, key) in failed_sessions.iter().zip(&failed_keys) {
            let cleared = Self::clear_current_matrix_rtc_membership(session, sessions, writes)
                .await
                .unwrap_or(false);
            if cleared {
                runtime.lock().await.lease_blocked.remove(key);
            }
        }
        Self::dispatch_backend_event(
            callback,
            MatrixBackendEvent::RtcMediaKeyFailure(MatrixRtcMediaKeyFailure {
                room_id: room_id.to_owned(),
                code: code.to_owned(),
            }),
        );
    }

    async fn sync_matrix_rtc_media_keys_for_room(
        room: &Room,
        sessions: &Arc<Mutex<HashMap<(String, String), MatrixRtcLocalSession>>>,
        runtime: &Arc<Mutex<MatrixRtcMediaKeyRuntime>>,
        writes: &Arc<Mutex<()>>,
        sync: &MatrixSyncCoordinator,
        callback: &Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
    ) -> BackendResult<()> {
        if room.state() != RoomState::Joined {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC media keys require a joined room".into(),
            ));
        }
        Self::require_protected_room(room, "processing MatrixRTC media keys").await?;
        let memberships = Self::active_matrix_rtc_memberships(room).await?;
        let current_publishers = memberships
            .iter()
            .map(|membership| {
                (
                    membership.member.user_id.clone(),
                    membership.member.device_id.clone(),
                    membership.member_id.clone(),
                )
            })
            .collect::<HashSet<_>>();
        {
            let room_id = room.room_id().as_str();
            runtime.lock().await.inbound.retain(
                |(key_room_id, user_id, device_id, member_id), _| {
                    key_room_id != room_id
                        || current_publishers.contains(&(
                            user_id.clone(),
                            device_id.clone(),
                            member_id.clone(),
                        ))
                },
            );
        }
        let local_sessions = sessions
            .lock()
            .await
            .values()
            .filter(|session| session.room.room_id() == room.room_id() && session.ready)
            .cloned()
            .collect::<Vec<_>>();
        let client = room.client();
        let own_user_id = client
            .user_id()
            .ok_or(BackendError::NotAuthenticated)?
            .to_owned();
        for session in local_sessions {
            if let Some(pause) = Self::prepare_matrix_rtc_media_key_activation(
                &session,
                &memberships,
                own_user_id.as_str(),
                runtime,
            )
            .await?
            {
                Self::spawn_matrix_rtc_activation_timeout(
                    pause.clone(),
                    Arc::clone(runtime),
                    Arc::clone(sessions),
                    Arc::clone(writes),
                    sync.clone(),
                    Arc::clone(callback),
                );
                Self::dispatch_backend_event(callback, MatrixBackendEvent::RtcMediaKeyPause(pause));
            }
        }
        Ok(())
    }

    async fn current_matrix_rtc_recipients(
        client: &Client,
        session: &MatrixRtcLocalSession,
    ) -> BackendResult<HashSet<MatrixRtcKeyParticipant>> {
        if session.room.state() != RoomState::Joined {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC local session room is no longer joined".into(),
            ));
        }
        Self::require_protected_room(&session.room, "activating a MatrixRTC media key").await?;
        let own_user_id = client
            .user_id()
            .ok_or(BackendError::NotAuthenticated)?
            .to_owned();
        let memberships = Self::active_matrix_rtc_memberships(&session.room).await?;
        Self::ensure_matrix_rtc_local_membership(&memberships, own_user_id.as_str(), session)?;
        Self::matrix_rtc_key_recipients(
            &memberships,
            own_user_id.as_str(),
            session.device_id.as_str(),
        )
    }

    async fn current_matrix_rtc_local_session(
        sessions: &Arc<Mutex<HashMap<(String, String), MatrixRtcLocalSession>>>,
        room_id: &str,
        session_id: &str,
        member_id: &str,
    ) -> BackendResult<MatrixRtcLocalSession> {
        let session = sessions
            .lock()
            .await
            .get(&(room_id.to_owned(), session_id.to_owned()))
            .cloned()
            .ok_or_else(|| {
                BackendError::NotFound("MatrixRTC local session is not active".into())
            })?;
        if session.member_id != member_id || !session.ready {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC local session epoch is not active".into(),
            ));
        }
        Ok(session)
    }

    fn matrix_rtc_pending_activation_snapshot(
        runtime: &MatrixRtcMediaKeyRuntime,
        room_id: &str,
        session_id: &str,
        member_id: &str,
        activation_id: &str,
        phase: MatrixRtcActivationPhase,
        now: u64,
    ) -> BackendResult<MatrixRtcPendingActivationSnapshot> {
        let pending = runtime
            .pending_activations
            .get(&(room_id.to_owned(), session_id.to_owned()))
            .ok_or_else(|| {
                BackendError::NotFound("MatrixRTC media-key activation is not pending".into())
            })?;
        if pending.room_id != room_id
            || pending.session_id != session_id
            || pending.member_id != member_id
            || pending.activation_id != activation_id
            || pending.phase != phase
        {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC media-key activation acknowledgement did not match".into(),
            ));
        }
        if pending.expires_at <= now {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC media-key activation expired".into(),
            ));
        }
        Ok(MatrixRtcPendingActivationSnapshot {
            activation_id: pending.activation_id.clone(),
            key_index: pending.key_index,
            key: pending.key,
            recipients: pending.recipients.clone(),
            recipient_fingerprint: pending.recipient_fingerprint.clone(),
            expires_at: pending.expires_at,
        })
    }

    async fn ack_matrix_rtc_media_key_pause_inner(
        &self,
        room_id: &str,
        session_id: &str,
        member_id: &str,
        activation_id: &str,
    ) -> BackendResult<MatrixRtcMediaKey> {
        let session = Self::current_matrix_rtc_local_session(
            &self.rtc_sessions,
            room_id,
            session_id,
            member_id,
        )
        .await?;
        let client = self.client().await?;
        let now = Self::matrix_rtc_monotonic_now_ms();
        let distributed_retry = {
            let runtime = self.rtc_media_keys.lock().await;
            runtime
                .pending_activations
                .get(&(room_id.to_owned(), session_id.to_owned()))
                .and_then(|pending| {
                    (pending.activation_id == activation_id
                        && pending.member_id == member_id
                        && pending.expires_at > now)
                        .then_some(pending.phase)
                })
        };
        if let Some(MatrixRtcActivationPhase::Distributed { sent_ts }) = distributed_retry {
            let snapshot = {
                let runtime = self.rtc_media_keys.lock().await;
                Self::matrix_rtc_pending_activation_snapshot(
                    &runtime,
                    room_id,
                    session_id,
                    member_id,
                    activation_id,
                    MatrixRtcActivationPhase::Distributed { sent_ts },
                    now,
                )?
            };
            let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
            return Self::matrix_rtc_local_media_key(
                own_user_id.as_str(),
                &session,
                snapshot.key_index,
                &snapshot.key,
                sent_ts,
                Some(snapshot.activation_id.clone()),
            );
        }
        let snapshot = {
            let runtime = self.rtc_media_keys.lock().await;
            Self::matrix_rtc_pending_activation_snapshot(
                &runtime,
                room_id,
                session_id,
                member_id,
                activation_id,
                MatrixRtcActivationPhase::AwaitingPauseAck,
                now,
            )?
        };
        let recipients = Self::current_matrix_rtc_recipients(&client, &session).await?;
        if recipients != snapshot.recipients
            || Self::matrix_rtc_recipient_fingerprint(&recipients)?
                != snapshot.recipient_fingerprint
        {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC recipients changed before key distribution".into(),
            ));
        }
        let sent_ts = Self::matrix_rtc_key_now_ms();
        Self::distribute_matrix_rtc_media_key(
            &client,
            &session,
            &snapshot.recipients,
            snapshot.key_index,
            &snapshot.key,
            sent_ts,
        )
        .await?;
        tokio::time::sleep(MATRIX_RTC_KEY_DISTRIBUTION_DELAY).await;
        let recipients = Self::current_matrix_rtc_recipients(&client, &session).await?;
        if recipients != snapshot.recipients
            || Self::matrix_rtc_recipient_fingerprint(&recipients)?
                != snapshot.recipient_fingerprint
        {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC recipients changed during key distribution".into(),
            ));
        }
        let now = Self::matrix_rtc_monotonic_now_ms();
        {
            let mut runtime = self.rtc_media_keys.lock().await;
            let current = Self::matrix_rtc_pending_activation_snapshot(
                &runtime,
                room_id,
                session_id,
                member_id,
                activation_id,
                MatrixRtcActivationPhase::AwaitingPauseAck,
                now,
            )?;
            if current.key_index != snapshot.key_index
                || current.recipients != snapshot.recipients
                || current.recipient_fingerprint != snapshot.recipient_fingerprint
                || current.expires_at != snapshot.expires_at
            {
                return Err(BackendError::PermissionDenied(
                    "MatrixRTC media-key activation was superseded".into(),
                ));
            }
            let pending = runtime
                .pending_activations
                .get_mut(&(room_id.to_owned(), session_id.to_owned()))
                .expect("validated pending activation exists");
            pending.phase = MatrixRtcActivationPhase::Distributed { sent_ts };
        }
        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        Self::matrix_rtc_local_media_key(
            own_user_id.as_str(),
            &session,
            snapshot.key_index,
            &snapshot.key,
            sent_ts,
            Some(snapshot.activation_id.clone()),
        )
    }

    async fn ack_matrix_rtc_media_key_inner(
        &self,
        room_id: &str,
        session_id: &str,
        member_id: &str,
        activation_id: &str,
        key_index: u8,
        sent_ts: u64,
    ) -> BackendResult<()> {
        let session = Self::current_matrix_rtc_local_session(
            &self.rtc_sessions,
            room_id,
            session_id,
            member_id,
        )
        .await?;
        let client = self.client().await?;
        let phase = MatrixRtcActivationPhase::Distributed { sent_ts };
        {
            let mut runtime = self.rtc_media_keys.lock().await;
            let now = Self::matrix_rtc_monotonic_now_ms();
            runtime.completed_activations.retain(|_, completed| {
                now.saturating_sub(completed.completed_at)
                    <= MATRIX_RTC_COMPLETED_ACTIVATION_TTL.as_millis() as u64
            });
            if runtime
                .completed_activations
                .get(&(room_id.to_owned(), session_id.to_owned()))
                .is_some_and(|completed| {
                    completed.activation_id == activation_id
                        && completed.member_id == member_id
                        && completed.key_index == key_index
                        && completed.sent_ts == sent_ts
                })
            {
                return Ok(());
            }
        }
        let snapshot = {
            let runtime = self.rtc_media_keys.lock().await;
            Self::matrix_rtc_pending_activation_snapshot(
                &runtime,
                room_id,
                session_id,
                member_id,
                activation_id,
                phase,
                Self::matrix_rtc_monotonic_now_ms(),
            )?
        };
        if snapshot.key_index != key_index {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC media-key acknowledgement used the wrong key index".into(),
            ));
        }
        let recipients = Self::current_matrix_rtc_recipients(&client, &session).await?;
        if recipients != snapshot.recipients
            || Self::matrix_rtc_recipient_fingerprint(&recipients)?
                != snapshot.recipient_fingerprint
        {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC recipients changed before key activation".into(),
            ));
        }
        let state_key = (room_id.to_owned(), session_id.to_owned());
        let mut runtime = self.rtc_media_keys.lock().await;
        let current = Self::matrix_rtc_pending_activation_snapshot(
            &runtime,
            room_id,
            session_id,
            member_id,
            activation_id,
            phase,
            Self::matrix_rtc_monotonic_now_ms(),
        )?;
        if current.key_index != key_index
            || current.recipients != snapshot.recipients
            || current.recipient_fingerprint != snapshot.recipient_fingerprint
        {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC media-key activation was superseded".into(),
            ));
        }
        runtime.pending_activations.remove(&state_key);
        runtime.lease_blocked.remove(&state_key);
        runtime.outbound.insert(
            state_key.clone(),
            MatrixRtcOutboundMediaKey {
                key_index,
                key: snapshot.key,
                recipients: snapshot.recipients.clone(),
            },
        );
        runtime.completed_activations.insert(
            state_key,
            MatrixRtcCompletedActivation {
                activation_id: activation_id.to_owned(),
                member_id: member_id.to_owned(),
                key_index,
                sent_ts,
                completed_at: Self::matrix_rtc_monotonic_now_ms(),
            },
        );
        Ok(())
    }

    fn revoke_matrix_rtc_publication(
        runtime: &mut MatrixRtcMediaKeyRuntime,
        state_key: &(String, String),
    ) {
        runtime.outbound.remove(state_key);
        runtime.pending_activations.remove(state_key);
        runtime.completed_activations.remove(state_key);
        runtime.lease_blocked.remove(state_key);
    }

    fn matrix_rtc_local_lease_state(
        runtime: &mut MatrixRtcMediaKeyRuntime,
        state_key: &(String, String),
        now: u64,
    ) -> BackendResult<MatrixRtcLocalLeaseState> {
        if runtime.lease_blocked.contains(state_key) {
            return Ok(MatrixRtcLocalLeaseState::Paused);
        }
        if runtime
            .pending_activations
            .get(state_key)
            .is_some_and(|pending| pending.expires_at <= now)
        {
            runtime.pending_activations.remove(state_key);
            runtime.outbound.remove(state_key);
            runtime.completed_activations.remove(state_key);
            runtime.lease_blocked.insert(state_key.clone());
            return Ok(MatrixRtcLocalLeaseState::Expired);
        }
        if runtime.pending_activations.contains_key(state_key) {
            return Ok(MatrixRtcLocalLeaseState::Paused);
        }
        let key_index = runtime
            .outbound
            .get(state_key)
            .map(|outbound| outbound.key_index)
            .ok_or_else(|| {
                BackendError::PermissionDenied(
                    "MatrixRTC publisher has no activated media key".into(),
                )
            })?;
        Ok(MatrixRtcLocalLeaseState::Active { key_index })
    }

    async fn renew_matrix_rtc_media_key_lease_inner(
        &self,
        room_id: &str,
        session_id: &str,
        member_id: &str,
    ) -> BackendResult<MatrixRtcMediaKeyLease> {
        let session = Self::current_matrix_rtc_local_session(
            &self.rtc_sessions,
            room_id,
            session_id,
            member_id,
        )
        .await?;
        let state_key = (room_id.to_owned(), session_id.to_owned());
        let monotonic_now = Self::matrix_rtc_monotonic_now_ms();
        let last_sync_success =
            Self::lock_matrix_sync_freshness(&self.matrix_sync_freshness).last_success_ms;
        if !Self::matrix_rtc_sync_is_fresh(last_sync_success, monotonic_now) {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC publisher lease requires a recent successful Matrix sync".into(),
            ));
        }
        let lease_state = {
            let mut runtime = self.rtc_media_keys.lock().await;
            Self::matrix_rtc_local_lease_state(&mut runtime, &state_key, monotonic_now)?
        };
        let key_index = match lease_state {
            MatrixRtcLocalLeaseState::Active { key_index } => key_index,
            MatrixRtcLocalLeaseState::Paused => {
                return Err(BackendError::PermissionDenied(
                    "MatrixRTC publisher is paused for media-key activation".into(),
                ))
            }
            MatrixRtcLocalLeaseState::Expired => {
                if let Some(active) = self.rtc_sessions.lock().await.get_mut(&state_key) {
                    if active.member_id == member_id {
                        active.ready = false;
                    }
                }
                session.cancellation.cancel();
                Self::reconcile_matrix_sync_cadence(
                    &self.rtc_sessions,
                    &self.matrix_sync_control,
                    &self.matrix_sync_freshness,
                )
                .await;
                let cleared = Self::clear_current_matrix_rtc_membership(
                    &session,
                    &self.rtc_sessions,
                    &self.rtc_membership_writes,
                )
                .await
                .unwrap_or(false);
                {
                    let mut runtime = self.rtc_media_keys.lock().await;
                    runtime.outbound.remove(&state_key);
                    runtime.completed_activations.remove(&state_key);
                    if cleared {
                        runtime.lease_blocked.remove(&state_key);
                    }
                }
                Self::dispatch_backend_event(
                    &self.event_callback,
                    MatrixBackendEvent::RtcMediaKeyFailure(MatrixRtcMediaKeyFailure {
                        room_id: room_id.to_owned(),
                        code: "activation-expired".into(),
                    }),
                );
                return Err(BackendError::PermissionDenied(
                    "MatrixRTC media-key activation expired".into(),
                ));
            }
        };
        Ok(MatrixRtcMediaKeyLease {
            room_id: room_id.to_owned(),
            session_id: session_id.to_owned(),
            member_id: member_id.to_owned(),
            key_index,
            expires_at: Self::matrix_rtc_key_now_ms()
                .saturating_add(MATRIX_RTC_KEY_LEASE_TTL.as_millis() as u64),
        })
    }

    async fn handle_matrix_rtc_media_key_event(
        raw: Raw<AnyToDeviceEvent>,
        encryption_info: Option<EncryptionInfo>,
        client: Client,
        sessions: Arc<Mutex<HashMap<(String, String), MatrixRtcLocalSession>>>,
        runtime: Arc<Mutex<MatrixRtcMediaKeyRuntime>>,
        callback: Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
    ) -> BackendResult<()> {
        if raw.json().get().len() > MATRIX_RTC_MAX_TO_DEVICE_BYTES {
            return Err(BackendError::RateLimited(
                "MatrixRTC media key event exceeded the size limit".into(),
            ));
        }
        if raw
            .get_field::<String>("type")
            .map_err(|error| BackendError::Serialization(error.to_string()))?
            .as_deref()
            != Some(MATRIX_RTC_KEY_TO_DEVICE_EVENT_TYPE)
        {
            return Ok(());
        }
        let envelope: MatrixRtcToDeviceEnvelope = serde_json::from_str(raw.json().get())
            .map_err(|error| BackendError::Serialization(error.to_string()))?;
        if envelope.event_type != MATRIX_RTC_KEY_TO_DEVICE_EVENT_TYPE {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC media key used an unexpected event type".into(),
            ));
        }
        let encryption_info = encryption_info.ok_or_else(|| {
            BackendError::PermissionDenied(
                "MatrixRTC media key was not decrypted from an Olm to-device event".into(),
            )
        })?;
        let curve25519_public_key_base64 = match &encryption_info.algorithm_info {
            AlgorithmInfo::OlmV1Curve25519AesSha2 {
                curve25519_public_key_base64,
            } => curve25519_public_key_base64,
            _ => {
                return Err(BackendError::PermissionDenied(
                    "MatrixRTC media key did not use Olm v1".into(),
                ))
            }
        };
        let sender_device = encryption_info.sender_device.as_ref().ok_or_else(|| {
            BackendError::PermissionDenied(
                "MatrixRTC media key Olm metadata omitted its sender device".into(),
            )
        })?;
        if envelope.sender != encryption_info.sender.as_str() {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC media key sender did not match its Olm metadata".into(),
            ));
        }
        let room_id =
            matrix_sdk::ruma::RoomId::parse(&envelope.content.room_id).map_err(Self::map_error)?;
        let room =
            Self::protected_joined_room(&client, &room_id, "accepting a MatrixRTC media key")
                .await?;
        let local_ready = sessions
            .lock()
            .await
            .values()
            .filter(|session| session.room.room_id() == room.room_id())
            .map(|session| session.ready)
            .reduce(|left, right| left || right);
        let Some(local_ready) = local_ready else {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC media key has no active local RTC session".into(),
            ));
        };
        let now_ms = Self::matrix_rtc_key_now_ms();
        {
            let mut runtime = runtime.lock().await;
            Self::record_matrix_rtc_key_attempt(
                &mut runtime,
                encryption_info.sender.as_str(),
                sender_device.as_str(),
                now_ms,
            )?;
        }

        let known_device = client
            .encryption()
            .get_device(&encryption_info.sender, sender_device)
            .await
            .map_err(Self::map_error)?
            .ok_or_else(|| {
                BackendError::PermissionDenied(
                    "MatrixRTC media key sender device is not in the encrypted device store".into(),
                )
            })?;
        if known_device
            .curve25519_key()
            .is_none_or(|key| key.to_base64() != curve25519_public_key_base64.trim_end_matches('='))
        {
            return Err(BackendError::PermissionDenied(
                "MatrixRTC media key Olm identity did not match the current sender device".into(),
            ));
        }
        let memberships = Self::active_matrix_rtc_memberships(&room).await?;
        let mut runtime = runtime.lock().await;
        let key = Self::validate_matrix_rtc_media_key(
            envelope.content,
            &envelope.sender,
            encryption_info.sender.as_str(),
            sender_device.as_str(),
            &memberships,
            now_ms,
            &mut runtime,
        )?;
        if local_ready {
            drop(runtime);
            Self::dispatch_backend_event(&callback, MatrixBackendEvent::RtcMediaKey(key));
        } else {
            let pending_count = runtime.pending.values().map(Vec::len).sum::<usize>();
            if pending_count >= MATRIX_RTC_MAX_PENDING_KEYS {
                return Err(BackendError::RateLimited(
                    "MatrixRTC pending media key limit reached".into(),
                ));
            }
            runtime
                .pending
                .entry(room.room_id().to_string())
                .or_default()
                .push(key);
        }
        Ok(())
    }

    async fn emit_matrix_rtc_membership(
        room: &Room,
        callback: &Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
    ) {
        if let Err(error) = Self::require_protected_room(room, "reading MatrixRTC membership").await
        {
            tracing::warn!(
                target: "mesh::security",
                room_id = %room.room_id(),
                "Suppressed MatrixRTC membership for an unprotected room: {error}"
            );
            return;
        }
        match Self::matrix_rtc_members_for_room(room).await {
            Ok(members) => Self::dispatch_backend_event(
                callback,
                MatrixBackendEvent::RtcMembership(MatrixRtcMembershipUpdate {
                    room_id: room.room_id().to_string(),
                    members,
                }),
            ),
            Err(error) => tracing::warn!(
                target: "mesh::matrixrtc",
                room_id = %room.room_id(),
                "Could not refresh MatrixRTC memberships: {error}"
            ),
        }
    }

    async fn select_matrix_rtc_service_url(
        room: &Room,
        configured_service_url: &str,
    ) -> BackendResult<String> {
        let memberships = Self::active_matrix_rtc_memberships(room).await?;
        let Some(oldest) = memberships.first() else {
            return Ok(configured_service_url.to_owned());
        };
        let selected = oldest.livekit_service_url.as_deref().ok_or_else(|| {
            BackendError::InvalidConfiguration(
                "the oldest active MatrixRTC membership does not advertise a LiveKit focus".into(),
            )
        })?;
        let selected = VoiceServiceStatus::secure_url(
            "oldest MatrixRTC membership livekit_service_url",
            selected,
            "https",
        )
        .map_err(BackendError::InvalidConfiguration)?;
        let configured = VoiceServiceStatus::secure_url(
            "MESH_MATRIXRTC_LIVEKIT_SERVICE_URL",
            configured_service_url,
            "https",
        )
        .map_err(BackendError::InvalidConfiguration)?;
        if selected != configured {
            return Err(BackendError::InvalidConfiguration(
                "the oldest active MatrixRTC membership selected a different focus; federated focus authorization is not verified in this client"
                    .into(),
            ));
        }
        Ok(configured.to_string())
    }

    async fn publish_matrix_rtc_membership(
        session: &MatrixRtcLocalSession,
        active: bool,
    ) -> BackendResult<()> {
        Self::require_protected_room(&session.room, "updating MatrixRTC membership").await?;
        CallMemberStateKey::from_str(&session.state_key).map_err(Self::map_error)?;
        let content = if active {
            let created_ts = u64::from(session.created_ts.get());
            let now = u64::from(matrix_sdk::ruma::MilliSecondsSinceUnixEpoch::now().get());
            Self::matrix_rtc_membership_content(
                session.device_id.as_str(),
                &session.member_id,
                &session.livekit_service_url,
                created_ts,
                now,
            )?
        } else {
            serde_json::json!({})
        };
        let body = Raw::<AnyStateEventContent>::from_json(
            serde_json::value::to_raw_value(&content)
                .map_err(|error| BackendError::Serialization(error.to_string()))?,
        );
        session
            .room
            .client()
            .send(send_state_event::v3::Request::new_raw(
                session.room.room_id().to_owned(),
                StateEventType::CallMember,
                session.state_key.clone(),
                body,
            ))
            .await
            .map_err(Self::map_error)?;
        Ok(())
    }

    async fn publish_current_matrix_rtc_membership(
        session: &MatrixRtcLocalSession,
        sessions: &Arc<Mutex<HashMap<(String, String), MatrixRtcLocalSession>>>,
        writes: &Arc<Mutex<()>>,
        active: bool,
    ) -> BackendResult<bool> {
        let _write_guard = writes.lock().await;
        let key = (
            session.room.room_id().to_string(),
            session.session_id.clone(),
        );
        let is_current = sessions
            .lock()
            .await
            .get(&key)
            .is_some_and(|current| current.member_id == session.member_id);
        if !is_current {
            return Ok(false);
        }
        Self::publish_matrix_rtc_membership(session, active).await?;
        Ok(true)
    }

    async fn clear_current_matrix_rtc_membership(
        session: &MatrixRtcLocalSession,
        sessions: &Arc<Mutex<HashMap<(String, String), MatrixRtcLocalSession>>>,
        writes: &Arc<Mutex<()>>,
    ) -> BackendResult<bool> {
        let _write_guard = writes.lock().await;
        let key = (
            session.room.room_id().to_string(),
            session.session_id.clone(),
        );
        let is_current = sessions
            .lock()
            .await
            .get(&key)
            .is_some_and(|current| current.member_id == session.member_id);
        if !is_current {
            return Ok(false);
        }
        Self::publish_matrix_rtc_membership(session, false).await?;
        let mut sessions = sessions.lock().await;
        if sessions
            .get(&key)
            .is_some_and(|current| current.member_id == session.member_id)
        {
            sessions.remove(&key);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn spawn_matrix_rtc_membership_refresh(
        session: MatrixRtcLocalSession,
        sessions: Arc<Mutex<HashMap<(String, String), MatrixRtcLocalSession>>>,
        writes: Arc<Mutex<()>>,
        callback: Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
    ) {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(MATRIX_RTC_MEMBERSHIP_REFRESH_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            interval.tick().await;
            loop {
                tokio::select! {
                    _ = session.cancellation.cancelled() => break,
                    _ = interval.tick() => {
                        match Self::publish_current_matrix_rtc_membership(
                            &session, &sessions, &writes, true
                        ).await {
                            Ok(true) => {}
                            Ok(false) => break,
                            Err(error) => {
                                tracing::warn!(
                                    target: "mesh::matrixrtc",
                                    room_id = %session.room.room_id(),
                                    "MatrixRTC membership refresh stopped: {error}"
                                );
                                break;
                            }
                        }
                        Self::emit_matrix_rtc_membership(&session.room, &callback).await;
                    }
                }
            }
        });
    }

    async fn exchange_matrix_rtc_token(
        client: &Client,
        room_id: &str,
        member_id: &str,
        user_id: &OwnedUserId,
        device_id: &OwnedDeviceId,
        livekit_service_url: &str,
        expected_sfu_url: &str,
    ) -> BackendResult<MatrixRtcTokenResponse> {
        let openid = client
            .send(request_openid_token::v3::Request::new(user_id.clone()))
            .await
            .map_err(Self::map_error)?;
        let request = MatrixRtcTokenRequest {
            room_id: room_id.to_owned(),
            slot_id: MATRIX_RTC_SLOT_ID.to_owned(),
            openid_token: MatrixRtcOpenIdToken {
                access_token: openid.access_token,
                token_type: openid.token_type.to_string(),
                matrix_server_name: openid.matrix_server_name.to_string(),
                expires_in: openid.expires_in.as_secs(),
            },
            member: MatrixRtcTokenMember {
                id: member_id.to_owned(),
                claimed_user_id: user_id.to_string(),
                claimed_device_id: device_id.to_string(),
            },
        };
        let endpoint = format!("{}/get_token", livekit_service_url.trim_end_matches('/'));
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(MATRIX_RTC_TOKEN_TIMEOUT)
            .build()
            .map_err(|error| BackendError::Network(error.to_string()))?;
        let mut response = http
            .post(endpoint)
            .json(&request)
            .send()
            .await
            .map_err(|error| BackendError::Network(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => BackendError::PermissionDenied(
                    "MatrixRTC authorization service rejected the request".into(),
                ),
                429 => BackendError::RateLimited(
                    "MatrixRTC authorization service rate limited the request".into(),
                ),
                _ => BackendError::Network(format!(
                    "MatrixRTC authorization service returned HTTP {status}"
                )),
            });
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| BackendError::Network(error.to_string()))?
        {
            if bytes.len().saturating_add(chunk.len()) > MATRIX_RTC_TOKEN_RESPONSE_MAX_BYTES {
                return Err(BackendError::Serialization(
                    "MatrixRTC authorization response exceeded 64 KiB".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let response: MatrixRtcTokenResponse = serde_json::from_slice(&bytes)
            .map_err(|error| BackendError::Serialization(error.to_string()))?;
        if response.jwt.trim().is_empty() {
            return Err(BackendError::Serialization(
                "MatrixRTC authorization response omitted the LiveKit JWT".into(),
            ));
        }
        let returned_sfu = Self::validate_matrix_rtc_sfu_url(&response.url, expected_sfu_url)?;
        Ok(MatrixRtcTokenResponse {
            url: returned_sfu,
            jwt: response.jwt,
        })
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

    fn managed_homeserver_config_from(
        homeserver: Option<&str>,
        server_name: Option<&str>,
    ) -> BackendResult<ManagedHomeserverConfig> {
        let homeserver = homeserver
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(BackendError::ManagedHomeserverUnconfigured)?;
        let homeserver = Self::normalize_homeserver_input(homeserver)?;

        let derived_server_name = if let Some(server_name) =
            server_name.map(str::trim).filter(|value| !value.is_empty())
        {
            server_name.to_owned()
        } else if homeserver.contains("://") {
            let url = url::Url::parse(&homeserver).map_err(|error| {
                BackendError::InvalidConfiguration(format!(
                    "invalid managed homeserver URL: {error}"
                ))
            })?;
            let host = url.host_str().ok_or_else(|| {
                BackendError::InvalidConfiguration(
                    "managed homeserver URL has no server name".into(),
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
        Ok(ManagedHomeserverConfig {
            homeserver,
            server_name,
        })
    }

    fn managed_homeserver_config() -> BackendResult<ManagedHomeserverConfig> {
        let homeserver = std::env::var(MANAGED_HOMESERVER_ENV)
            .ok()
            .or_else(|| option_env!("MESH_MANAGED_HOMESERVER").map(str::to_owned));
        let server_name = std::env::var(MANAGED_SERVER_NAME_ENV)
            .ok()
            .or_else(|| option_env!("MESH_MANAGED_SERVER_NAME").map(str::to_owned));
        Self::managed_homeserver_config_from(homeserver.as_deref(), server_name.as_deref())
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

    fn qualify_user_input(
        input: &str,
        managed: &ManagedHomeserverConfig,
    ) -> BackendResult<OwnedUserId> {
        let input = input.trim();
        if input.starts_with('@') {
            return UserId::parse(input).map_err(Self::map_error);
        }
        let username = Self::normalize_product_username(input)?;
        UserId::parse(format!("@{username}:{}", managed.server_name)).map_err(Self::map_error)
    }

    fn qualify_public_link_input(
        input: &str,
        managed: &ManagedHomeserverConfig,
    ) -> BackendResult<OwnedRoomAliasId> {
        let input = input.trim();
        if input.starts_with('#') {
            return RoomAliasId::parse(input).map_err(Self::map_error);
        }
        let slug = Self::normalize_public_link_slug(input)?;
        RoomAliasId::parse(format!("#{slug}:{}", managed.server_name)).map_err(Self::map_error)
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

    fn uiaa_can_complete_with_dummy(info: &UiaaInfo) -> bool {
        info.flows.iter().any(|flow| {
            let mut incomplete_count = 0_u8;
            let only_dummy = flow
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
                });
            incomplete_count > 0 && only_dummy
        })
    }

    fn map_registration_error(error: matrix_sdk::Error) -> BackendError {
        if let Some(info) = error.as_uiaa_response() {
            if Self::uiaa_has_incomplete_stage(info, AuthType::Terms) {
                return BackendError::RegistrationTermsRequired;
            }
            return BackendError::RegistrationAdditionalAuthRequired;
        }
        match error.client_api_error_kind() {
            Some(ErrorKind::UserInUse) => BackendError::UsernameUnavailable,
            Some(ErrorKind::InvalidUsername) => BackendError::InvalidConfiguration(
                "the managed account service rejected that username".into(),
            ),
            Some(ErrorKind::WeakPassword) => BackendError::InvalidConfiguration(
                "password does not meet the managed account service requirements".into(),
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

    fn map_error(error: impl std::fmt::Display) -> BackendError {
        BackendError::from_sdk_error(error)
    }

    fn map_secure_storage_error(error: impl std::fmt::Display) -> BackendError {
        BackendError::Crypto(format!(
            "the operating-system secure store is unavailable or corrupt: {error}"
        ))
    }

    fn normalize_display_name(display_name: &str) -> BackendResult<String> {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "display name cannot be empty".into(),
            ));
        }
        if display_name.chars().count() > 100 {
            return Err(BackendError::InvalidConfiguration(
                "display name must be 100 characters or fewer".into(),
            ));
        }
        if display_name.chars().any(char::is_control) {
            return Err(BackendError::InvalidConfiguration(
                "display name cannot contain control characters".into(),
            ));
        }
        Ok(display_name.to_owned())
    }

    fn ensure_room_is_encrypted(
        room_id: &str,
        action: &str,
        is_encrypted: bool,
    ) -> BackendResult<()> {
        if is_encrypted {
            return Ok(());
        }

        Err(BackendError::NotEncrypted(format!(
            "Mesh blocked {action} in unencrypted Matrix room {room_id}. Ask a community \
             administrator to enable end-to-end encryption, then leave and rejoin the room"
        )))
    }

    fn encrypted_room_initial_state() -> Raw<AnyInitialStateEvent> {
        InitialStateEvent::with_empty_state_key(RoomEncryptionEventContent::new(
            EventEncryptionAlgorithm::MegolmV1AesSha2,
        ))
        .to_raw_any()
    }

    fn ensure_room_is_joined(room_id: &str, action: &str, is_joined: bool) -> BackendResult<()> {
        if is_joined {
            return Ok(());
        }

        Err(BackendError::PermissionDenied(format!(
            "Mesh blocked {action} because Matrix room {room_id} is not joined"
        )))
    }

    async fn require_protected_room(room: &Room, action: &str) -> BackendResult<()> {
        Self::ensure_room_is_joined(
            room.room_id().as_str(),
            action,
            room.state() == RoomState::Joined,
        )?;
        let is_encrypted = room
            .latest_encryption_state()
            .await
            .map_err(|error| {
                BackendError::InvalidConfiguration(format!(
                    "Mesh could not verify end-to-end encryption before {action} in Matrix room \
                     {}: {error}. Resynchronize the room and try again",
                    room.room_id()
                ))
            })?
            .is_encrypted();
        Self::ensure_room_is_encrypted(room.room_id().as_str(), action, is_encrypted)
    }

    async fn protected_joined_room(
        client: &Client,
        room_id: &matrix_sdk::ruma::RoomId,
        action: &str,
    ) -> BackendResult<Room> {
        let room = client.get_room(room_id).ok_or_else(|| {
            BackendError::NotFound("room is not present in the local Matrix store".into())
        })?;
        Self::require_protected_room(&room, action).await?;
        Ok(room)
    }

    async fn room_for_cleanup_redaction(
        client: &Client,
        room_id: &matrix_sdk::ruma::RoomId,
    ) -> BackendResult<Room> {
        let room = client.get_room(room_id).ok_or_else(|| {
            BackendError::NotFound("room is not present in the local Matrix store".into())
        })?;
        Self::ensure_room_is_joined(
            room.room_id().as_str(),
            "removing previously exposed content",
            room.state() == RoomState::Joined,
        )?;
        let is_encrypted = room
            .latest_encryption_state()
            .await
            .map_err(Self::map_error)?
            .is_encrypted();
        if !is_encrypted {
            tracing::warn!(
                target: "mesh::security",
                room_id = %room.room_id(),
                "Using the cleanup-only redaction exception for an unencrypted room"
            );
        }
        Ok(room)
    }

    fn verification_snapshot(
        verification_id: String,
        flow: &DeviceVerificationFlow,
    ) -> BackendResult<MatrixVerificationSession> {
        match flow {
            DeviceVerificationFlow::Request { request, device_id } => {
                let mut cancellation_reason = None;
                let phase = match request.state() {
                    VerificationRequestState::Created { .. }
                    | VerificationRequestState::Requested { .. } => "waiting-for-device",
                    VerificationRequestState::Ready { .. }
                    | VerificationRequestState::Transitioned { .. } => "choose-method",
                    VerificationRequestState::Done => "done",
                    VerificationRequestState::Cancelled(info) => {
                        cancellation_reason = Some(info.reason().to_owned());
                        "cancelled"
                    }
                };
                Ok(MatrixVerificationSession {
                    verification_id,
                    device_id: device_id.clone(),
                    phase: phase.into(),
                    method: None,
                    emojis: Vec::new(),
                    decimals: None,
                    qr_svg: None,
                    cancellation_reason,
                })
            }
            DeviceVerificationFlow::Sas(sas) => {
                Ok(Self::sas_verification_snapshot(verification_id, sas))
            }
            DeviceVerificationFlow::Qr(qr) => Self::qr_verification_snapshot(verification_id, qr),
        }
    }

    fn sas_verification_snapshot(
        verification_id: String,
        sas: &SasVerification,
    ) -> MatrixVerificationSession {
        let device_id = sas.other_device().device_id().to_string();
        let mut emojis = Vec::new();
        let mut decimals = None;
        let mut cancellation_reason = None;
        let phase = match sas.state() {
            SasState::Created { .. } => "waiting-for-device",
            SasState::Started { .. } => "started",
            SasState::Accepted { .. } => "accepted",
            SasState::KeysExchanged {
                emojis: sas_emojis,
                decimals: sas_decimals,
            } => {
                if let Some(sas_emojis) = sas_emojis {
                    emojis = sas_emojis
                        .emojis
                        .into_iter()
                        .map(|emoji| VerificationEmoji {
                            symbol: emoji.symbol.to_owned(),
                            description: emoji.description.to_owned(),
                        })
                        .collect();
                }
                decimals = Some([sas_decimals.0, sas_decimals.1, sas_decimals.2]);
                "compare"
            }
            SasState::Confirmed => "confirmed",
            SasState::Done { .. } => "done",
            SasState::Cancelled(info) => {
                cancellation_reason = Some(info.reason().to_owned());
                "cancelled"
            }
        };
        MatrixVerificationSession {
            verification_id,
            device_id,
            phase: phase.to_owned(),
            method: Some("sas".into()),
            emojis,
            decimals,
            qr_svg: None,
            cancellation_reason,
        }
    }

    fn qr_verification_snapshot(
        verification_id: String,
        qr: &QrVerification,
    ) -> BackendResult<MatrixVerificationSession> {
        let mut cancellation_reason = None;
        let phase = match qr.state() {
            QrVerificationState::Started | QrVerificationState::Reciprocated => "qr-show",
            QrVerificationState::Scanned => "qr-scanned",
            QrVerificationState::Confirmed => "confirmed",
            QrVerificationState::Done { .. } => "done",
            QrVerificationState::Cancelled(info) => {
                cancellation_reason = Some(info.reason().to_owned());
                "cancelled"
            }
        };
        let qr_svg = if matches!(phase, "qr-show" | "qr-scanned") && qr.we_started() {
            let code = qr.to_qr_code().map_err(Self::map_error)?;
            Some(
                code.render::<svg::Color>()
                    .min_dimensions(280, 280)
                    .dark_color(svg::Color("#111827"))
                    .light_color(svg::Color("#ffffff"))
                    .build(),
            )
        } else {
            None
        };
        Ok(MatrixVerificationSession {
            verification_id,
            device_id: qr.other_device().device_id().to_string(),
            phase: phase.into(),
            method: Some("qr".into()),
            emojis: Vec::new(),
            decimals: None,
            qr_svg,
            cancellation_reason,
        })
    }

    fn recovery_state_name(state: RecoveryState) -> &'static str {
        match state {
            RecoveryState::Unknown => "unknown",
            RecoveryState::Enabled => "enabled",
            RecoveryState::Disabled => "disabled",
            RecoveryState::Incomplete => "incomplete",
        }
    }

    fn backup_state_name(state: BackupState) -> &'static str {
        match state {
            BackupState::Unknown => "unknown",
            BackupState::Creating => "creating",
            BackupState::Enabling => "enabling",
            BackupState::Resuming => "resuming",
            BackupState::Enabled => "enabled",
            BackupState::Downloading => "downloading",
            BackupState::Disabling => "disabling",
        }
    }

    fn avatar_color(seed: &str) -> String {
        let digest = Sha256::digest(seed.as_bytes());
        format!("#{:02x}{:02x}{:02x}", digest[0], digest[1], digest[2])
    }

    fn timestamp_from_millis(timestamp: Option<u64>) -> String {
        timestamp
            .and_then(|millis| {
                chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis as i64)
            })
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339()
    }

    fn event_timestamp(value: &serde_json::Value) -> String {
        Self::timestamp_from_millis(
            value
                .get("origin_server_ts")
                .and_then(serde_json::Value::as_u64),
        )
    }

    fn is_base_text_message(value: &serde_json::Value) -> bool {
        if value.get("type").and_then(serde_json::Value::as_str) != Some("m.room.message") {
            return false;
        }
        let Some(content) = value.get("content") else {
            return false;
        };
        if content
            .get("m.relates_to")
            .and_then(|relation| relation.get("rel_type"))
            .and_then(serde_json::Value::as_str)
            == Some("m.replace")
        {
            return false;
        }
        let msgtype = content.get("msgtype").and_then(serde_json::Value::as_str);
        matches!(
            msgtype,
            Some("m.text" | "m.notice" | "m.emote" | "m.file" | "m.image" | "m.audio" | "m.video")
        ) && content
            .get("body")
            .and_then(serde_json::Value::as_str)
            .is_some()
    }

    fn encrypted_file_sha256(encrypted_file: &EncryptedFile) -> Option<String> {
        match encrypted_file
            .hashes
            .get(&EncryptedFileHashAlgorithm::Sha256)?
        {
            EncryptedFileHash::Sha256(hash) => Some(hash.to_string()),
            _ => None,
        }
    }

    fn resolved_matrix_thumbnail_from_content(
        content: &serde_json::Value,
    ) -> Option<ResolvedMatrixThumbnail> {
        let info = content.get("info")?;
        // Plain `thumbnail_url` metadata is never accepted for encrypted-room
        // attachments. Key material remains Rust-only and is recovered again
        // from the authoritative event when a preview is requested.
        let encrypted_file: EncryptedFile =
            serde_json::from_value(info.get("thumbnail_file")?.clone()).ok()?;
        if !encrypted_file.url.as_str().starts_with("mxc://") {
            return None;
        }
        let sha256 = Self::encrypted_file_sha256(&encrypted_file)?;
        let thumbnail_info = info.get("thumbnail_info")?;
        let size = thumbnail_info.get("size")?.as_u64()?;
        let width = u32::try_from(thumbnail_info.get("w")?.as_u64()?).ok()?;
        let height = u32::try_from(thumbnail_info.get("h")?.as_u64()?).ok()?;
        let content_type = thumbnail_info.get("mimetype")?.as_str()?;
        let pixels = u64::from(width).checked_mul(u64::from(height))?;
        if size == 0
            || size > MAX_THUMBNAIL_BYTES as u64
            || width == 0
            || height == 0
            || width > MAX_THUMBNAIL_DIMENSION
            || height > MAX_THUMBNAIL_DIMENSION
            || pixels > u64::from(MAX_THUMBNAIL_DIMENSION).pow(2)
            || content_type != "image/png"
        {
            return None;
        }
        Some(ResolvedMatrixThumbnail {
            metadata: AttachmentThumbnailDto {
                file_hash: format!("matrix-sha256:{sha256}"),
                size,
                width,
                height,
                content_type: content_type.to_owned(),
            },
            encrypted_file,
        })
    }

    fn resolved_matrix_attachment_from_content(
        content: &serde_json::Value,
    ) -> Option<ResolvedMatrixAttachment> {
        let msgtype = content.get("msgtype").and_then(serde_json::Value::as_str)?;
        if !matches!(msgtype, "m.file" | "m.image" | "m.audio" | "m.video") {
            return None;
        }
        let filename = content
            .get("filename")
            .and_then(serde_json::Value::as_str)
            .or_else(|| content.get("body").and_then(serde_json::Value::as_str))?
            .trim();
        if filename.is_empty() {
            return None;
        }
        let encrypted_file: EncryptedFile =
            serde_json::from_value(content.get("file")?.clone()).ok()?;
        if !encrypted_file.url.as_str().starts_with("mxc://") {
            return None;
        }
        let sha256 = Self::encrypted_file_sha256(&encrypted_file)?;
        let size = content
            .get("info")
            .and_then(|info| info.get("size"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default();
        let content_type = content
            .get("info")
            .and_then(|info| info.get("mimetype"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let thumbnail = Self::resolved_matrix_thumbnail_from_content(content);
        Some(ResolvedMatrixAttachment {
            metadata: AttachmentDto {
                file_hash: format!("matrix-sha256:{sha256}"),
                filename: filename.to_owned(),
                size,
                chunks: 1,
                source_peer_id: "matrix".into(),
                content_type,
                thumbnail: thumbnail
                    .as_ref()
                    .map(|thumbnail| thumbnail.metadata.clone()),
            },
            encrypted_file,
            thumbnail,
        })
    }

    fn matrix_attachment_from_content(content: &serde_json::Value) -> Option<AttachmentDto> {
        Self::resolved_matrix_attachment_from_content(content).map(|attachment| attachment.metadata)
    }

    fn resolved_matrix_attachment_from_event(
        event: &serde_json::Value,
        attachment_index: u32,
    ) -> BackendResult<ResolvedMatrixAttachment> {
        if attachment_index != 0 {
            return Err(BackendError::NotFound(
                "attachment index is not present in this message".into(),
            ));
        }
        if event.get("type").and_then(serde_json::Value::as_str) != Some("m.room.message")
            || event
                .get("unsigned")
                .and_then(|unsigned| unsigned.get("redacted_because"))
                .is_some()
        {
            return Err(BackendError::NotFound(
                "attachment message is unavailable".into(),
            ));
        }
        let content = event
            .get("content")
            .ok_or_else(|| BackendError::NotFound("attachment message has no content".into()))?;
        Self::resolved_matrix_attachment_from_content(content).ok_or_else(|| {
            BackendError::NotFound(
                "message does not contain a supported encrypted attachment".into(),
            )
        })
    }

    #[cfg(test)]
    fn matrix_attachment_from_event(
        event: &serde_json::Value,
        attachment_index: u32,
    ) -> BackendResult<AttachmentDto> {
        Self::resolved_matrix_attachment_from_event(event, attachment_index)
            .map(|attachment| attachment.metadata)
    }

    async fn resolve_protected_attachment(
        client: &Client,
        room_id: &matrix_sdk::ruma::RoomId,
        event_id: &matrix_sdk::ruma::EventId,
        attachment_index: u32,
    ) -> BackendResult<ResolvedMatrixAttachment> {
        let room =
            Self::protected_joined_room(client, room_id, "downloading an attachment").await?;
        let event = room
            .load_or_fetch_event(event_id, None)
            .await
            .map_err(Self::map_error)?;
        let value: serde_json::Value =
            serde_json::from_str(event.raw().json().get()).map_err(Self::map_error)?;
        if value.get("event_id").and_then(serde_json::Value::as_str) != Some(event_id.as_str()) {
            return Err(BackendError::PermissionDenied(
                "attachment event did not match the requested event".into(),
            ));
        }
        Self::resolved_matrix_attachment_from_event(&value, attachment_index)
    }

    async fn resolve_protected_thumbnail(
        client: &Client,
        room_id: &matrix_sdk::ruma::RoomId,
        event_id: &matrix_sdk::ruma::EventId,
        attachment_index: u32,
    ) -> BackendResult<ResolvedMatrixThumbnail> {
        Self::resolve_protected_attachment(client, room_id, event_id, attachment_index)
            .await?
            .thumbnail
            .ok_or_else(|| {
                BackendError::NotFound(
                    "attachment does not contain a protected inline preview".into(),
                )
            })
    }

    async fn timeline_values(
        room: &Room,
        minimum_base_messages: usize,
        before_id: Option<&str>,
    ) -> BackendResult<Vec<serde_json::Value>> {
        const PAGE_SIZE: u32 = 100;
        const MAX_EVENTS: usize = 10_000;

        let mut values = Vec::new();
        let mut from = None;
        let mut anchor_seen = before_id.is_none();
        let mut qualifying_messages = 0_usize;

        loop {
            let mut options = MessagesOptions::backward();
            options.limit = PAGE_SIZE.into();
            options.from = from;
            let response = room.messages(options).await.map_err(Self::map_error)?;
            if response.chunk.is_empty() {
                break;
            }

            for event in response.chunk {
                let value = match event.raw().deserialize_as::<serde_json::Value>() {
                    Ok(value) => value,
                    Err(error) => {
                        tracing::warn!(target: "mesh::matrix", "Skipping malformed timeline event: {error}");
                        continue;
                    }
                };
                let event_id = value.get("event_id").and_then(serde_json::Value::as_str);
                let legacy_message_id = Self::legacy_message_id(&value);
                if !anchor_seen
                    && (event_id == before_id || legacy_message_id.as_deref() == before_id)
                {
                    anchor_seen = true;
                } else if anchor_seen
                    && (Self::is_base_text_message(&value) || legacy_message_id.is_some())
                {
                    qualifying_messages += 1;
                }
                values.push(value);
            }

            if qualifying_messages >= minimum_base_messages || values.len() >= MAX_EVENTS {
                break;
            }
            let Some(next) = response.end else {
                break;
            };
            from = Some(next);
        }

        Ok(values)
    }

    fn visible_message_body(content: &serde_json::Value) -> Option<String> {
        let body = content.get("body")?.as_str()?;
        let is_reply = content
            .get("m.relates_to")
            .and_then(|relation| relation.get("m.in_reply_to"))
            .is_some();
        if is_reply && body.starts_with('>') {
            if let Some((_, visible)) = body.split_once("\n\n") {
                return Some(visible.to_owned());
            }
        }
        Some(body.to_owned())
    }

    fn project_legacy_message(room_id: &str, value: &serde_json::Value) -> Option<MessageDto> {
        if value.get("type").and_then(serde_json::Value::as_str)
            != Some(crate::backend::LEGACY_MATRIX_EVENT_TYPE)
        {
            return None;
        }
        let content = value.get("content")?;
        let status = content
            .get("conflictStatus")
            .and_then(serde_json::Value::as_str)?;
        if status == "approved_non_selected_variant" {
            return None;
        }
        let record = content.get("record")?;
        if record.get("kind").and_then(serde_json::Value::as_str) != Some("message") {
            return None;
        }
        let payload = record.get("payload")?;
        let id = Self::legacy_message_id(value)?;
        let author = payload
            .get("authorPublicKey")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("legacy:unknown")
            .to_owned();
        let attachments = payload
            .get("attachments")
            .cloned()
            .and_then(|attachments| serde_json::from_value::<Vec<AttachmentDto>>(attachments).ok())
            .unwrap_or_default();
        let original_timestamp = record
            .get("originalTimestamp")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| Self::event_timestamp(value));
        let deleted_at = payload
            .get("deletedAt")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);

        Some(MessageDto {
            id,
            channel_id: room_id.to_owned(),
            author_public_key: author.clone(),
            author_display_name: payload
                .get("authorDisplayName")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Legacy member")
                .to_owned(),
            author_avatar_color: payload
                .get("authorAvatarColor")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| Self::avatar_color(&author)),
            content: if deleted_at.is_some() {
                String::new()
            } else {
                payload
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            },
            attachments,
            reactions: payload
                .get("reactions")
                .cloned()
                .and_then(|reactions| serde_json::from_value(reactions).ok())
                .unwrap_or_default(),
            timestamp: original_timestamp,
            signature: record
                .get("originalSignature")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            edited_at: payload
                .get("editedAt")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            deleted_at,
            reply_to_id: payload
                .get("replyToId")
                .and_then(serde_json::Value::as_str)
                .map(|reply| format!("legacy-reply:{reply}")),
            delivery_status: Some("imported".into()),
        })
    }

    fn legacy_message_id(value: &serde_json::Value) -> Option<String> {
        if value.get("type").and_then(serde_json::Value::as_str)
            != Some(crate::backend::LEGACY_MATRIX_EVENT_TYPE)
        {
            return None;
        }
        let content = value.get("content")?;
        if content
            .get("conflictStatus")
            .and_then(serde_json::Value::as_str)
            == Some("approved_non_selected_variant")
        {
            return None;
        }
        let record = content.get("record")?;
        if record.get("kind").and_then(serde_json::Value::as_str) != Some("message") {
            return None;
        }
        record
            .get("entityId")
            .and_then(serde_json::Value::as_str)
            .map(|entity_id| format!("legacy:{entity_id}"))
    }

    fn project_timeline(
        room_id: &str,
        members: &HashMap<String, String>,
        mut values: Vec<serde_json::Value>,
    ) -> Vec<MessageDto> {
        values.sort_by(|left, right| {
            left.get("origin_server_ts")
                .and_then(serde_json::Value::as_u64)
                .cmp(
                    &right
                        .get("origin_server_ts")
                        .and_then(serde_json::Value::as_u64),
                )
                .then_with(|| {
                    left.get("event_id")
                        .and_then(serde_json::Value::as_str)
                        .cmp(&right.get("event_id").and_then(serde_json::Value::as_str))
                })
        });

        let mut messages = HashMap::<String, MessageDto>::new();
        let mut ordered_ids = Vec::new();

        for value in &values {
            if let Some(message) = Self::project_legacy_message(room_id, value) {
                ordered_ids.push(message.id.clone());
                messages.insert(message.id.clone(), message);
                continue;
            }
            if !Self::is_base_text_message(value) {
                continue;
            }
            let Some(event_id) = value
                .get("event_id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
            else {
                continue;
            };
            let Some(content) = value.get("content") else {
                continue;
            };
            let Some(body) = Self::visible_message_body(content) else {
                continue;
            };
            let sender = value
                .get("sender")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("@unknown:invalid")
                .to_owned();
            let timestamp = Self::event_timestamp(value);
            let redacted = value
                .get("unsigned")
                .and_then(|unsigned| unsigned.get("redacted_because"))
                .is_some();
            let reply_to_id = content
                .get("m.relates_to")
                .and_then(|relation| relation.get("m.in_reply_to"))
                .and_then(|reply| reply.get("event_id"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);

            ordered_ids.push(event_id.clone());
            messages.insert(
                event_id.clone(),
                MessageDto {
                    id: event_id,
                    channel_id: room_id.to_owned(),
                    author_public_key: sender.clone(),
                    author_display_name: members.get(&sender).cloned().unwrap_or_else(|| {
                        sender
                            .split(':')
                            .next()
                            .unwrap_or(&sender)
                            .trim_start_matches('@')
                            .to_owned()
                    }),
                    author_avatar_color: Self::avatar_color(&sender),
                    content: if redacted { String::new() } else { body },
                    attachments: Self::matrix_attachment_from_content(content)
                        .into_iter()
                        .collect(),
                    reactions: HashMap::new(),
                    timestamp: timestamp.clone(),
                    signature: String::new(),
                    edited_at: None,
                    deleted_at: redacted.then_some(timestamp),
                    reply_to_id,
                    delivery_status: Some("sent".into()),
                },
            );
        }

        let mut reaction_events = HashMap::<String, (String, String, String)>::new();
        let mut redacted_events = HashSet::<String>::new();
        for value in &values {
            let event_type = value
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let event_id = value
                .get("event_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let sender = value
                .get("sender")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("@unknown:invalid");
            let timestamp = Self::event_timestamp(value);

            match event_type {
                "m.room.message" => {
                    let Some(content) = value.get("content") else {
                        continue;
                    };
                    let relation = content.get("m.relates_to");
                    if relation
                        .and_then(|relation| relation.get("rel_type"))
                        .and_then(serde_json::Value::as_str)
                        != Some("m.replace")
                    {
                        continue;
                    }
                    let Some(target_id) = relation
                        .and_then(|relation| relation.get("event_id"))
                        .and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    let Some(message) = messages.get_mut(target_id) else {
                        continue;
                    };
                    if message.author_public_key != sender || message.deleted_at.is_some() {
                        continue;
                    }
                    let replacement = relation
                        .and_then(|relation| relation.get("m.new_content"))
                        .or_else(|| content.get("m.new_content"));
                    if let Some(body) = replacement
                        .and_then(|content| content.get("body"))
                        .and_then(serde_json::Value::as_str)
                    {
                        message.content = body.to_owned();
                        message.edited_at = Some(timestamp);
                    }
                }
                "m.reaction" => {
                    let redacted = value
                        .get("unsigned")
                        .and_then(|unsigned| unsigned.get("redacted_because"))
                        .is_some();
                    let relation = value
                        .get("content")
                        .and_then(|content| content.get("m.relates_to"));
                    let Some(target_id) = relation
                        .and_then(|relation| relation.get("event_id"))
                        .and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    let Some(key) = relation
                        .and_then(|relation| relation.get("key"))
                        .and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    reaction_events.insert(
                        event_id.to_owned(),
                        (target_id.to_owned(), key.to_owned(), sender.to_owned()),
                    );
                    if !redacted {
                        if let Some(message) = messages.get_mut(target_id) {
                            let authors = message.reactions.entry(key.to_owned()).or_default();
                            if !authors.iter().any(|author| author == sender) {
                                authors.push(sender.to_owned());
                            }
                        }
                    }
                }
                "m.room.redaction" => {
                    let target_id = value
                        .get("redacts")
                        .or_else(|| {
                            value
                                .get("content")
                                .and_then(|content| content.get("redacts"))
                        })
                        .and_then(serde_json::Value::as_str);
                    if let Some(target_id) = target_id {
                        redacted_events.insert(target_id.to_owned());
                        if let Some(message) = messages.get_mut(target_id) {
                            message.content.clear();
                            message.deleted_at = Some(timestamp);
                        }
                    }
                }
                _ => {}
            }
        }

        for reaction_event_id in redacted_events {
            let Some((target_id, key, sender)) = reaction_events.get(&reaction_event_id) else {
                continue;
            };
            let Some(message) = messages.get_mut(target_id) else {
                continue;
            };
            if let Some(authors) = message.reactions.get_mut(key) {
                authors.retain(|author| author != sender);
                if authors.is_empty() {
                    message.reactions.remove(key);
                }
            }
        }

        let mut projected = ordered_ids
            .into_iter()
            .filter_map(|event_id| messages.remove(&event_id))
            .collect::<Vec<_>>();
        projected.sort_by(|left, right| {
            left.timestamp
                .cmp(&right.timestamp)
                .then_with(|| left.id.cmp(&right.id))
        });
        projected
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

        Client::builder()
            // Accept either a Matrix server name (for .well-known discovery)
            // or an explicit homeserver URL for advanced/self-hosted setups.
            .server_name_or_homeserver_url(homeserver)
            .sqlite_store(&storage.store_root, Some(&passphrase))
            .handle_refresh_tokens()
            .with_encryption_settings(EncryptionSettings {
                auto_enable_cross_signing: true,
                auto_enable_backups: true,
                backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
            })
            .build()
            .await
            .map_err(Self::map_error)
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

        Client::builder()
            .server_name_or_homeserver_url(homeserver)
            .sqlite_store(store.path(), Some(&encoded_passphrase))
            .handle_refresh_tokens()
            .with_encryption_settings(EncryptionSettings {
                auto_enable_cross_signing: true,
                auto_enable_backups: true,
                backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
            })
            .build()
            .await
            .map_err(Self::map_error)
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

    fn configured_oidc_client_id() -> Result<Option<String>, String> {
        let Some(value) = std::env::var_os(OIDC_CLIENT_ID_ENV) else {
            return Ok(None);
        };
        let value = value
            .into_string()
            .map_err(|_| format!("{OIDC_CLIENT_ID_ENV} must be valid UTF-8"))?;
        Self::normalize_oidc_client_id(Some(value))
    }

    fn normalize_oidc_client_id(value: Option<String>) -> Result<Option<String>, String> {
        let Some(value) = value else {
            return Ok(None);
        };
        let value = value.trim();
        if value.is_empty() {
            return Ok(None);
        }
        if value.len() > 512 || value.chars().any(char::is_control) {
            return Err(format!(
                "{OIDC_CLIENT_ID_ENV} must be 1-512 characters and contain no control characters"
            ));
        }
        Ok(Some(value.to_owned()))
    }

    fn oidc_metadata_supports_native_flow(metadata: &AuthorizationServerMetadata) -> bool {
        Self::has_required_oidc_capabilities(
            metadata
                .response_types_supported
                .contains(&ResponseType::Code),
            metadata
                .response_modes_supported
                .contains(&ResponseMode::Query),
            metadata
                .grant_types_supported
                .contains(&GrantType::AuthorizationCode),
            metadata
                .grant_types_supported
                .contains(&GrantType::RefreshToken),
            metadata
                .code_challenge_methods_supported
                .contains(&CodeChallengeMethod::S256),
        )
    }

    fn has_required_oidc_capabilities(
        code_response: bool,
        query_response_mode: bool,
        authorization_code_grant: bool,
        refresh_token_grant: bool,
        s256_pkce: bool,
    ) -> bool {
        code_response
            && query_response_mode
            && authorization_code_grant
            && refresh_token_grant
            && s256_pkce
    }

    async fn discover_oidc(&self, homeserver: String) -> BackendResult<MatrixOidcStatus> {
        let homeserver = Self::normalize_homeserver_input(&homeserver)?;
        let redirect_uri = OIDC_REDIRECT_URI.to_owned();
        let configured_client_id = match Self::configured_oidc_client_id() {
            Ok(client_id) => client_id,
            Err(reason) => {
                return Ok(MatrixOidcStatus {
                    homeserver,
                    availability: MatrixOidcAvailability::InvalidConfiguration,
                    issuer: None,
                    authorization_endpoint: None,
                    registration_mode: None,
                    client_id_configured: false,
                    redirect_uri,
                    authorization_code_pkce: false,
                    native_callback_ready: false,
                    ready: false,
                    reason,
                });
            }
        };

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
                return Ok(MatrixOidcStatus {
                    homeserver: resolved_homeserver,
                    availability: MatrixOidcAvailability::NotSupported,
                    issuer: None,
                    authorization_endpoint: None,
                    registration_mode: None,
                    client_id_configured: configured_client_id.is_some(),
                    redirect_uri,
                    authorization_code_pkce: false,
                    native_callback_ready: false,
                    ready: false,
                    reason: "This homeserver does not advertise Matrix OAuth/OIDC metadata".into(),
                });
            }
            Err(error) => {
                return Ok(MatrixOidcStatus {
                    homeserver: resolved_homeserver,
                    availability: MatrixOidcAvailability::InvalidConfiguration,
                    issuer: None,
                    authorization_endpoint: None,
                    registration_mode: None,
                    client_id_configured: configured_client_id.is_some(),
                    redirect_uri,
                    authorization_code_pkce: false,
                    native_callback_ready: false,
                    ready: false,
                    reason: format!("OAuth/OIDC metadata could not be validated: {error}"),
                });
            }
        };
        if !Self::oidc_metadata_supports_native_flow(&metadata) {
            return Ok(MatrixOidcStatus {
                homeserver: resolved_homeserver,
                availability: MatrixOidcAvailability::InvalidConfiguration,
                issuer: Some(metadata.issuer.to_string()),
                authorization_endpoint: Some(metadata.authorization_endpoint.to_string()),
                registration_mode: None,
                client_id_configured: configured_client_id.is_some(),
                redirect_uri,
                authorization_code_pkce: false,
                native_callback_ready: false,
                ready: false,
                reason: "OAuth/OIDC metadata must explicitly include response type code, response mode query, authorization_code and refresh_token grants, and S256 PKCE".into(),
            });
        }

        let registration_mode = if configured_client_id.is_some() {
            Some("static".into())
        } else if metadata.registration_endpoint.is_some() {
            Some("dynamic".into())
        } else {
            None
        };
        let ready = configured_client_id.is_some();
        let registration_reason = if ready {
            "Continue with Mesh is ready for this provider".to_owned()
        } else {
            format!(
                "An operator must register {OIDC_REDIRECT_URI} and set {OIDC_CLIENT_ID_ENV}; managed sign-in does not use dynamic client registration"
            )
        };

        Ok(MatrixOidcStatus {
            homeserver: resolved_homeserver,
            availability: MatrixOidcAvailability::Supported,
            issuer: Some(metadata.issuer.to_string()),
            authorization_endpoint: Some(metadata.authorization_endpoint.to_string()),
            registration_mode,
            client_id_configured: configured_client_id.is_some(),
            redirect_uri,
            authorization_code_pkce: true,
            native_callback_ready: true,
            ready,
            reason: registration_reason,
        })
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
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut failure_count: u32 = 0;
            loop {
                let callback_freshness = Arc::clone(&freshness);
                let result = client
                    .sync_with_result_callback(
                        SyncSettings::default()
                            .timeout(cadence.timeout())
                            .set_presence(presence.clone()),
                        move |result| {
                            let freshness = Arc::clone(&callback_freshness);
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

    async fn apply_wire_privacy(&self, preferences: &UserPreferences) {
        let next = WirePrivacyPreferences::from(preferences);
        let previous = {
            let mut current = self.wire_privacy.write().await;
            let previous = *current;
            *current = next;
            previous
        };
        if previous.send_typing_indicators && !next.send_typing_indicators {
            self.clear_sent_typing_notices().await;
        }

        let mut control = self.matrix_sync_control.lock().await;
        let presence = next.presence();
        if control.presence == presence {
            return;
        }
        control.presence = presence;
        Self::restart_matrix_sync_locked(&mut control, &self.matrix_sync_freshness).await;
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

        let mut runtime = self.runtime.write().await;
        if let Some(previous) = runtime.session_task.take() {
            previous.abort();
        }
        if let Some(previous) = runtime.room_updates_task.take() {
            previous.abort();
        }
        runtime.client = Some(client.clone());
        runtime.homeserver = Some(homeserver);
        runtime.profile_id = Some(profile_id);
        runtime.session_task = session_task;
        runtime.room_updates_task = Some(room_updates_task);
        drop(runtime);

        let mut sync = self.matrix_sync_control.lock().await;
        sync.client = Some(client);
        sync.cadence = MatrixSyncCadence::Normal;
        sync.paused = false;
        Self::restart_matrix_sync_locked(&mut sync, &self.matrix_sync_freshness).await;
    }

    async fn stop_runtime(&self) -> Option<Client> {
        {
            let mut sync = self.matrix_sync_control.lock().await;
            sync.paused = true;
            sync.client = None;
            sync.cadence = MatrixSyncCadence::Normal;
            sync.presence = PresenceState::Offline;
            Self::restart_matrix_sync_locked(&mut sync, &self.matrix_sync_freshness).await;
        }
        *self.wire_privacy.write().await = WirePrivacyPreferences::default();
        self.sent_typing_notices.lock().await.clear();
        let (client, session_task, room_updates_task) = {
            let mut runtime = self.runtime.write().await;
            let client = runtime.client.take();
            let session_task = runtime.session_task.take();
            let room_updates_task = runtime.room_updates_task.take();
            runtime.homeserver = None;
            runtime.profile_id = None;
            (client, session_task, room_updates_task)
        };

        if let Some(task) = session_task {
            task.abort();
            let _ = task.await;
        }
        if let Some(task) = room_updates_task {
            task.abort();
            let _ = task.await;
        }
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

    async fn space_child_ids(&self, space: &Room) -> BackendResult<Vec<OwnedRoomId>> {
        let response = self
            .client()
            .await?
            .send(get_state_events::v3::Request::new(
                space.room_id().to_owned(),
            ))
            .await
            .map_err(Self::map_error)?;

        Ok(response
            .room_state
            .into_iter()
            .filter_map(|event| {
                let event_type = event.get_field::<String>("type").ok().flatten()?;
                if event_type != "m.space.child" {
                    return None;
                }
                let state_key = event.get_field::<String>("state_key").ok().flatten()?;
                matrix_sdk::ruma::RoomId::parse(state_key).ok()
            })
            .collect())
    }

    async fn community_rooms(&self, community_id: &str) -> BackendResult<Vec<Room>> {
        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(community_id).map_err(Self::map_error)?;
        let space =
            Self::protected_joined_room(&client, &space_id, "opening this community").await?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community ID does not identify a Matrix Space".into(),
            ));
        }

        let mut rooms = vec![space];
        for child_id in self.space_child_ids(&rooms[0]).await? {
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
            if !room.is_space() {
                rooms.push(room);
            }
        }
        Ok(rooms)
    }

    fn direct_rooms(client: &Client, user_id: &matrix_sdk::ruma::UserId) -> Vec<Room> {
        let mut rooms: Vec<Room> = client
            .joined_rooms()
            .into_iter()
            .filter(|room| {
                let targets = room.direct_targets();
                targets.len() == 1
                    && targets
                        .iter()
                        .any(|target| target.as_str() == user_id.as_str())
            })
            .collect();
        rooms.sort_by(|left, right| left.room_id().cmp(right.room_id()));
        rooms
    }

    async fn inferred_direct_rooms(
        client: &Client,
        user_id: &matrix_sdk::ruma::UserId,
    ) -> BackendResult<Vec<Room>> {
        let Some(own_user_id) = client.user_id() else {
            return Err(BackendError::NotAuthenticated);
        };
        let mut rooms = Vec::new();
        for room in client.joined_rooms() {
            if room.is_space() {
                continue;
            }
            let members = room
                .members(RoomMemberships::JOIN)
                .await
                .map_err(Self::map_error)?;
            if members.len() != 2
                || !members.iter().any(|member| member.user_id() == own_user_id)
                || !members.iter().any(|member| member.user_id() == user_id)
            {
                continue;
            }
            Self::require_protected_room(&room, "opening this direct message").await?;
            rooms.push(room);
        }
        rooms.sort_by(|left, right| left.room_id().cmp(right.room_id()));
        Ok(rooms)
    }

    fn canonical_direct_room_id(mut room_ids: Vec<OwnedRoomId>) -> Option<OwnedRoomId> {
        room_ids.sort();
        room_ids.into_iter().next()
    }

    fn merge_direct_room_ids(target: &mut Vec<OwnedRoomId>, source: &[OwnedRoomId]) -> bool {
        let mut additions = source
            .iter()
            .filter(|room_id| !target.contains(room_id))
            .cloned()
            .collect::<Vec<_>>();
        additions.sort();
        let changed = !additions.is_empty();
        target.extend(additions);
        changed
    }

    fn merge_direct_content_preserving_mappings(
        target: &mut DirectEventContent,
        source: &DirectEventContent,
    ) -> bool {
        let mut changed = false;
        for (user_id, source_room_ids) in source.iter() {
            if let Some(target_room_ids) = target.get_mut(user_id) {
                changed |= Self::merge_direct_room_ids(target_room_ids, source_room_ids);
            } else {
                target.insert(user_id.clone(), source_room_ids.clone());
                changed = true;
            }
        }
        changed
    }

    fn direct_content_preserves(
        observed: &DirectEventContent,
        required: &DirectEventContent,
    ) -> bool {
        required.iter().all(|(user_id, required_room_ids)| {
            observed.get(user_id).is_some_and(|observed_room_ids| {
                required_room_ids
                    .iter()
                    .all(|room_id| observed_room_ids.contains(room_id))
            })
        })
    }

    async fn reconcile_direct_duplicates(
        client: &Client,
        user_id: &matrix_sdk::ruma::UserId,
        local_room_ids: &[OwnedRoomId],
        preserved_content: Option<&DirectEventContent>,
        allow_missing_user_mapping: bool,
    ) -> BackendResult<bool> {
        let direct_user = <&DirectUserIdentifier>::from(user_id);
        let mut accumulated = preserved_content.cloned();
        let mut wrote = false;

        for _ in 0..DIRECT_ACCOUNT_DATA_MERGE_ATTEMPTS {
            let Some(first_raw) = client
                .account()
                .fetch_account_data_static::<DirectEventContent>()
                .await
                .map_err(Self::map_error)?
            else {
                return Ok(wrote);
            };
            let first = first_raw.deserialize().map_err(Self::map_error)?;

            let Some(second_raw) = client
                .account()
                .fetch_account_data_static::<DirectEventContent>()
                .await
                .map_err(Self::map_error)?
            else {
                if let Some(accumulated_content) = accumulated.as_mut() {
                    Self::merge_direct_content_preserving_mappings(accumulated_content, &first);
                } else {
                    accumulated = Some(first);
                }
                continue;
            };
            let second = second_raw.deserialize().map_err(Self::map_error)?;

            let snapshots_match = serde_json::to_vec(&first).map_err(Self::map_error)?
                == serde_json::to_vec(&second).map_err(Self::map_error)?;
            let accumulated_content = accumulated.get_or_insert_with(|| first.clone());
            Self::merge_direct_content_preserving_mappings(accumulated_content, &first);
            Self::merge_direct_content_preserving_mappings(accumulated_content, &second);
            if !snapshots_match {
                continue;
            }

            let mut candidate = second;
            Self::merge_direct_content_preserving_mappings(&mut candidate, accumulated_content);
            let room_ids = if let Some(room_ids) = candidate.get_mut(direct_user) {
                room_ids
            } else if allow_missing_user_mapping {
                candidate.insert(direct_user.to_owned(), Vec::new());
                candidate
                    .get_mut(direct_user)
                    .expect("the direct-user mapping was just inserted")
            } else {
                // A remote device removed this entire peer mapping. Do not
                // recreate it from a possibly stale local SDK snapshot.
                return Ok(wrote);
            };
            Self::merge_direct_room_ids(room_ids, local_room_ids);

            if Self::direct_content_preserves(&first, &candidate) {
                return Ok(wrote);
            }

            client
                .account()
                .set_account_data(candidate.clone())
                .await
                .map_err(Self::map_error)?;
            wrote = true;

            let Some(verification_raw) = client
                .account()
                .fetch_account_data_static::<DirectEventContent>()
                .await
                .map_err(Self::map_error)?
            else {
                continue;
            };
            let verification = verification_raw.deserialize().map_err(Self::map_error)?;
            if Self::direct_content_preserves(&verification, &candidate) {
                return Ok(true);
            }
            Self::merge_direct_content_preserving_mappings(accumulated_content, &candidate);
            Self::merge_direct_content_preserving_mappings(accumulated_content, &verification);
        }

        Err(BackendError::Other(
            "Matrix direct-message account data changed repeatedly; retry after other devices finish updating"
                .into(),
        ))
    }

    async fn is_ignored_user(
        client: &Client,
        user_id: &matrix_sdk::ruma::UserId,
    ) -> BackendResult<bool> {
        let Some(raw_content) = client
            .account()
            .fetch_account_data_static::<IgnoredUserListEventContent>()
            .await
            .map_err(Self::map_error)?
        else {
            return Ok(false);
        };
        let content = raw_content.deserialize().map_err(Self::map_error)?;
        Ok(content.ignored_users.contains_key(user_id))
    }

    async fn direct_room(
        &self,
        client: &Client,
        user_id: &matrix_sdk::ruma::UserId,
    ) -> BackendResult<Room> {
        let mut direct_rooms = Self::direct_rooms(client, user_id);
        let inferred = direct_rooms.is_empty();
        if inferred {
            direct_rooms = Self::inferred_direct_rooms(client, user_id).await?;
        }
        let duplicate_count = direct_rooms.len();
        let direct_room_ids = direct_rooms
            .iter()
            .map(|room| room.room_id().to_owned())
            .collect::<Vec<_>>();
        let canonical_room_id = Self::canonical_direct_room_id(direct_room_ids.clone());
        let room = if let Some(canonical_room_id) = canonical_room_id {
            let room = direct_rooms
                .into_iter()
                .find(|room| room.room_id() == canonical_room_id)
                .expect("canonical direct room must come from the candidate set");
            if inferred || duplicate_count > 1 {
                Self::reconcile_direct_duplicates(
                    client,
                    user_id,
                    &direct_room_ids,
                    None,
                    inferred,
                )
                .await?;
            }
            room
        } else {
            // A second device can have a stale local account-data snapshot even
            // while the homeserver already contains valid m.direct mappings
            // written by another device. Preserve the authoritative snapshot
            // before create_dm updates last-write-wins account data, then merge
            // and verify it alongside the newly created room.
            let preserved_content = client
                .account()
                .fetch_account_data_static::<DirectEventContent>()
                .await
                .map_err(Self::map_error)?
                .map(|raw| raw.deserialize().map_err(Self::map_error))
                .transpose()?;
            let room = client.create_dm(user_id).await.map_err(Self::map_error)?;
            Self::reconcile_direct_duplicates(
                client,
                user_id,
                &[room.room_id().to_owned()],
                preserved_content.as_ref(),
                true,
            )
            .await?;
            room
        };
        Self::require_protected_room(&room, "opening this direct message").await?;
        Ok(room)
    }

    fn safe_media_filename(filename: &str) -> BackendResult<String> {
        let safe = Path::new(filename.trim())
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("attachment.bin")
            .to_owned();
        if has_blocked_attachment_extension(Path::new(&safe)) {
            return Err(BackendError::InvalidConfiguration(
                "refusing to write an executable Matrix attachment".into(),
            ));
        }
        Ok(safe)
    }

    fn validate_transfer_id(transfer_id: &str) -> BackendResult<()> {
        if transfer_id.len() != 36 || uuid::Uuid::parse_str(transfer_id).is_err() {
            return Err(BackendError::InvalidConfiguration(
                "Matrix transfer id must be a UUID".into(),
            ));
        }
        Ok(())
    }

    fn validate_transaction_id(transaction_id: &str) -> BackendResult<OwnedTransactionId> {
        if transaction_id.is_empty()
            || transaction_id.len() > 255
            || !transaction_id
                .chars()
                .all(|character| !character.is_control() && !character.is_whitespace())
        {
            return Err(BackendError::InvalidConfiguration(
                "message delivery identifier is invalid".into(),
            ));
        }
        Ok(transaction_id.to_owned().into())
    }

    fn new_message_composer_draft(body: String) -> BackendResult<Option<ComposerDraft>> {
        if body.len() > MAX_COMPOSER_DRAFT_BYTES {
            return Err(BackendError::InvalidConfiguration(
                "message draft cannot exceed 16 KiB".into(),
            ));
        }
        if body.is_empty() {
            return Ok(None);
        }
        Ok(Some(ComposerDraft {
            plain_text: body,
            html_text: None,
            draft_type: ComposerDraftType::NewMessage,
            attachments: Vec::new(),
        }))
    }

    fn new_message_composer_draft_body(draft: ComposerDraft) -> BackendResult<Option<String>> {
        let ComposerDraft {
            plain_text,
            draft_type,
            ..
        } = draft;
        if !matches!(draft_type, ComposerDraftType::NewMessage) {
            return Ok(None);
        }
        if plain_text.len() > MAX_COMPOSER_DRAFT_BYTES {
            return Err(BackendError::InvalidConfiguration(
                "saved message draft exceeds 16 KiB".into(),
            ));
        }
        Ok((!plain_text.is_empty()).then_some(plain_text))
    }

    fn emit_transfer_progress(
        progress: &MatrixTransferProgressCallback,
        transfer_id: &str,
        direction: MatrixTransferDirection,
        transferred_bytes: u64,
        total_bytes: Option<u64>,
        state: MatrixTransferState,
        result: Option<MatrixTransferResult>,
    ) {
        let terminal_retry = matches!(
            state,
            MatrixTransferState::Cancelled | MatrixTransferState::Failed
        );
        let error = match state {
            MatrixTransferState::Cancelled => {
                Some("Transfer cancelled. Restarting begins again from zero.".into())
            }
            MatrixTransferState::Failed => {
                Some("Transfer failed. Restarting begins again from zero.".into())
            }
            _ => None,
        };
        progress(MatrixTransferProgress {
            transfer_id: transfer_id.to_owned(),
            direction,
            transferred_bytes,
            total_bytes,
            state,
            retryable: terminal_retry,
            retry_mode: terminal_retry.then_some(MatrixTransferRetryMode::RestartFromZero),
            result,
            error,
        });
    }

    fn validate_media_payload(
        data: &[u8],
        content_type: Option<&str>,
        filename: &str,
    ) -> BackendResult<()> {
        let blocked_content_type = content_type.is_some_and(|content_type| {
            BLOCKED_MEDIA_CONTENT_TYPES
                .iter()
                .any(|blocked| blocked.eq_ignore_ascii_case(content_type.trim()))
        });
        let executable_header = data.starts_with(b"MZ")
            || data.starts_with(b"\x7fELF")
            || data.starts_with(b"\xfe\xed\xfa\xce")
            || data.starts_with(b"\xce\xfa\xed\xfe")
            || data.starts_with(b"\xfe\xed\xfa\xcf")
            || data.starts_with(b"\xcf\xfa\xed\xfe");
        if blocked_content_type || executable_header {
            return Err(BackendError::InvalidConfiguration(format!(
                "refusing to cache or send executable Matrix attachment payload: {filename}"
            )));
        }
        Ok(())
    }

    fn attachment_size_limit_error() -> BackendError {
        BackendError::InvalidConfiguration("attachment exceeds the 100 MB limit".into())
    }

    fn validate_attachment_size(size: u64) -> BackendResult<()> {
        if size > MAX_ATTACHMENT_BYTES {
            return Err(Self::attachment_size_limit_error());
        }
        Ok(())
    }

    fn thumbnail_image_format(content_type: &str) -> Option<image::ImageFormat> {
        match content_type.trim().to_ascii_lowercase().as_str() {
            "image/jpeg" => Some(image::ImageFormat::Jpeg),
            "image/png" => Some(image::ImageFormat::Png),
            "image/webp" => Some(image::ImageFormat::WebP),
            _ => None,
        }
    }

    fn generate_sanitized_thumbnail(
        data: &[u8],
        content_type: &str,
    ) -> BackendResult<Option<GeneratedThumbnail>> {
        let Some(format) = Self::thumbnail_image_format(content_type) else {
            return Ok(None);
        };
        let dimensions = image::ImageReader::with_format(Cursor::new(data), format)
            .into_dimensions()
            .map_err(|_| {
                BackendError::InvalidConfiguration(
                    "image attachment does not match its declared content type".into(),
                )
            })?;
        let pixels = u64::from(dimensions.0)
            .checked_mul(u64::from(dimensions.1))
            .ok_or_else(|| {
                BackendError::InvalidConfiguration(
                    "image attachment dimensions overflow the thumbnail limit".into(),
                )
            })?;
        if dimensions.0 == 0
            || dimensions.1 == 0
            || dimensions.0 > MAX_THUMBNAIL_SOURCE_DIMENSION
            || dimensions.1 > MAX_THUMBNAIL_SOURCE_DIMENSION
            || pixels > MAX_THUMBNAIL_SOURCE_PIXELS
        {
            return Err(BackendError::InvalidConfiguration(format!(
                "image attachment exceeds the {MAX_THUMBNAIL_SOURCE_PIXELS}-pixel thumbnail limit"
            )));
        }

        let mut decode_limits = image::Limits::default();
        decode_limits.max_image_width = Some(MAX_THUMBNAIL_SOURCE_DIMENSION);
        decode_limits.max_image_height = Some(MAX_THUMBNAIL_SOURCE_DIMENSION);
        decode_limits.max_alloc = Some(MAX_THUMBNAIL_DECODE_BYTES);
        let mut reader = image::ImageReader::with_format(Cursor::new(data), format);
        reader.limits(decode_limits);
        let decoded = reader.decode().map_err(|_| {
            BackendError::InvalidConfiguration(
                "image attachment could not be decoded within thumbnail limits".into(),
            )
        })?;
        if decoded.width() != dimensions.0 || decoded.height() != dimensions.1 {
            return Err(BackendError::InvalidConfiguration(
                "decoded image dimensions do not match its header".into(),
            ));
        }
        let thumbnail = decoded.thumbnail(MAX_THUMBNAIL_DIMENSION, MAX_THUMBNAIL_DIMENSION);
        let width = thumbnail.width();
        let height = thumbnail.height();
        let mut output = Cursor::new(Vec::new());
        thumbnail
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|_| BackendError::Other("failed to encode sanitized thumbnail".into()))?;
        let bytes = output.into_inner();
        if bytes.is_empty()
            || bytes.len() > MAX_THUMBNAIL_BYTES
            || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        {
            return Err(BackendError::Other(
                "sanitized thumbnail exceeded its encoded-size limit".into(),
            ));
        }
        let verified_dimensions =
            image::ImageReader::with_format(Cursor::new(&bytes), image::ImageFormat::Png)
                .into_dimensions()
                .map_err(|_| BackendError::Other("sanitized thumbnail validation failed".into()))?;
        if verified_dimensions != (width, height)
            || width == 0
            || height == 0
            || width > MAX_THUMBNAIL_DIMENSION
            || height > MAX_THUMBNAIL_DIMENSION
        {
            return Err(BackendError::Other(
                "sanitized thumbnail dimensions failed validation".into(),
            ));
        }
        Ok(Some(GeneratedThumbnail {
            bytes,
            width,
            height,
        }))
    }

    fn sanitize_inline_thumbnail(
        data: &[u8],
        thumbnail: &AttachmentThumbnailDto,
    ) -> BackendResult<Vec<u8>> {
        if thumbnail.content_type != "image/png"
            || data.is_empty()
            || data.len() > MAX_THUMBNAIL_BYTES
            || data.len() as u64 != thumbnail.size
        {
            return Err(BackendError::InvalidConfiguration(
                "inline preview bytes do not match protected PNG metadata".into(),
            ));
        }
        let dimensions =
            image::ImageReader::with_format(Cursor::new(data), image::ImageFormat::Png)
                .into_dimensions()
                .map_err(|_| {
                    BackendError::InvalidConfiguration("inline preview is not a valid PNG".into())
                })?;
        let pixels = u64::from(dimensions.0)
            .checked_mul(u64::from(dimensions.1))
            .ok_or_else(|| {
                BackendError::InvalidConfiguration("inline preview dimensions overflowed".into())
            })?;
        if dimensions != (thumbnail.width, thumbnail.height)
            || dimensions.0 == 0
            || dimensions.1 == 0
            || dimensions.0 > MAX_THUMBNAIL_DIMENSION
            || dimensions.1 > MAX_THUMBNAIL_DIMENSION
            || pixels > u64::from(MAX_THUMBNAIL_DIMENSION).pow(2)
        {
            return Err(BackendError::InvalidConfiguration(
                "inline preview dimensions do not match its protected metadata".into(),
            ));
        }

        let mut decode_limits = image::Limits::default();
        decode_limits.max_image_width = Some(MAX_THUMBNAIL_DIMENSION);
        decode_limits.max_image_height = Some(MAX_THUMBNAIL_DIMENSION);
        decode_limits.max_alloc = Some(MAX_INLINE_THUMBNAIL_DECODE_BYTES);
        let mut reader =
            image::ImageReader::with_format(Cursor::new(data), image::ImageFormat::Png);
        reader.limits(decode_limits);
        let decoded = reader.decode().map_err(|_| {
            BackendError::InvalidConfiguration(
                "inline preview could not be decoded within safe limits".into(),
            )
        })?;
        if (decoded.width(), decoded.height()) != dimensions {
            return Err(BackendError::InvalidConfiguration(
                "decoded inline preview dimensions changed unexpectedly".into(),
            ));
        }

        let mut output = Cursor::new(Vec::new());
        decoded
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|_| BackendError::Other("failed to sanitize inline preview".into()))?;
        let bytes = output.into_inner();
        if bytes.is_empty()
            || bytes.len() > MAX_THUMBNAIL_BYTES
            || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        {
            return Err(BackendError::InvalidConfiguration(
                "sanitized inline preview failed PNG validation".into(),
            ));
        }
        let verified_dimensions =
            image::ImageReader::with_format(Cursor::new(&bytes), image::ImageFormat::Png)
                .into_dimensions()
                .map_err(|_| {
                    BackendError::InvalidConfiguration(
                        "sanitized inline preview could not be verified".into(),
                    )
                })?;
        if verified_dimensions != dimensions {
            return Err(BackendError::InvalidConfiguration(
                "sanitized inline preview dimensions changed unexpectedly".into(),
            ));
        }
        Ok(bytes)
    }

    async fn upload_encrypted_media_bytes(
        client: &Client,
        data: &[u8],
        cancellation: &CancellationToken,
        progress: &MatrixTransferProgressCallback,
        transfer_id: &str,
        transferred_bytes: &Arc<AtomicU64>,
        progress_range: (u64, u64),
    ) -> BackendResult<EncryptedFile> {
        let (offset, total_bytes) = progress_range;
        let mut reader = Cursor::new(data);
        let upload = client.upload_encrypted_file(&mut reader);
        let mut upload_progress = upload.subscribe_to_send_progress();
        let progress_callback = progress.clone();
        let progress_transfer_id = transfer_id.to_owned();
        let progress_bytes = transferred_bytes.clone();
        let progress_task = tokio::spawn(async move {
            while let Some(update) = upload_progress.next().await {
                let current = offset.saturating_add(update.current as u64);
                progress_bytes.store(current, Ordering::Relaxed);
                Self::emit_transfer_progress(
                    &progress_callback,
                    &progress_transfer_id,
                    MatrixTransferDirection::Upload,
                    current,
                    Some(total_bytes),
                    MatrixTransferState::Uploading,
                    None,
                );
            }
        });
        let result = tokio::select! {
            result = upload => result.map_err(Self::map_error),
            _ = cancellation.cancelled() => {
                Err(BackendError::Other("Matrix attachment upload cancelled".into()))
            }
        };
        progress_task.abort();
        if result.is_ok() {
            transferred_bytes.store(offset.saturating_add(data.len() as u64), Ordering::Relaxed);
        }
        result
    }

    /// Buffers a media transfer while the cap is checked against bytes actually
    /// received. `info.size` is sender-controlled, so the only honest bound is
    /// the running count of the live stream: the loop stops pulling the moment
    /// it is crossed, before the payload is materialised. `size_hint` (e.g. a
    /// transport `Content-Length`) only sizes the initial allocation and is
    /// clamped to `limit` and, since the hint itself is an unverified remote
    /// claim, to `MEDIA_DOWNLOAD_INITIAL_CAPACITY_BYTES`; the cap is still
    /// enforced against real bytes as they arrive regardless of what the hint
    /// claims.
    async fn collect_bounded_media(
        source: &mut dyn MediaChunkSource,
        limit: u64,
        size_hint: Option<u64>,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> BackendResult<Vec<u8>> {
        let mut buffer = match size_hint {
            Some(hint) => Vec::with_capacity(
                hint.min(limit).min(MEDIA_DOWNLOAD_INITIAL_CAPACITY_BYTES) as usize,
            ),
            None => Vec::new(),
        };
        let mut received = 0_u64;
        let mut reported = 0_u64;
        while let Some(chunk) = source.next_chunk().await? {
            received = received.saturating_add(chunk.len() as u64);
            if received > limit {
                return Err(Self::attachment_size_limit_error());
            }
            buffer.extend_from_slice(&chunk);
            if received.saturating_sub(reported) >= MEDIA_DOWNLOAD_PROGRESS_INTERVAL_BYTES {
                reported = received;
                on_progress(received);
            }
        }
        on_progress(received);
        Ok(buffer)
    }

    /// matrix-sdk 0.18's `Media::get_media_content` reads the whole response
    /// body into memory before any size check can run, so the download is
    /// issued directly against the same endpoint ruma would have used.
    #[allow(deprecated)]
    fn media_download_endpoint(
        homeserver: &str,
        access_token: Option<&str>,
        supported_versions: &SupportedVersions,
        url: &MxcUri,
    ) -> BackendResult<(String, reqwest::header::HeaderMap)> {
        use matrix_sdk::ruma::api::client::{authenticated_media, media};

        let access_token = access_token.map_or(SendAccessToken::None, SendAccessToken::IfRequired);
        let request = if authenticated_media::get_content::v1::Request::PATH_BUILDER
            .is_supported(supported_versions)
        {
            authenticated_media::get_content::v1::Request::from_uri(url)
                .map_err(Self::map_error)?
                .try_into_http_request::<Vec<u8>>(
                    homeserver,
                    access_token,
                    Cow::Borrowed(supported_versions),
                )
        } else {
            media::get_content::v3::Request::from_url(url)
                .map_err(Self::map_error)?
                .try_into_http_request::<Vec<u8>>(
                    homeserver,
                    access_token,
                    Cow::Borrowed(supported_versions),
                )
        }
        .map_err(Self::map_error)?;
        let (parts, _) = request.into_parts();
        Ok((parts.uri.to_string(), parts.headers))
    }

    async fn download_bounded_encrypted_media(
        client: &Client,
        encrypted_file: &EncryptedFile,
        limit: u64,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> BackendResult<Vec<u8>> {
        let supported_versions = client.supported_versions().await.map_err(Self::map_error)?;
        let (url, headers) = Self::media_download_endpoint(
            client.homeserver().as_str(),
            client.access_token().as_deref(),
            &supported_versions,
            &encrypted_file.url,
        )?;
        let http = reqwest::Client::builder()
            .min_tls_version(reqwest::tls::Version::TLS_1_2)
            .connect_timeout(MEDIA_DOWNLOAD_CONNECT_TIMEOUT)
            .read_timeout(MEDIA_DOWNLOAD_READ_TIMEOUT)
            .build()
            .map_err(|error| BackendError::Network(error.to_string()))?;
        let response = http
            .get(url)
            .headers(headers)
            .send()
            .await
            .map_err(|error| BackendError::Network(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => BackendError::PermissionDenied(
                    "the homeserver refused this attachment download".into(),
                ),
                429 => BackendError::RateLimited(
                    "the homeserver rate limited this attachment download".into(),
                ),
                _ => BackendError::Network(format!("attachment download returned HTTP {status}")),
            });
        }
        let content_length = response.content_length();
        if content_length.is_some_and(|length| length > limit) {
            return Err(BackendError::InvalidConfiguration(
                "encrypted media exceeds its transfer limit".into(),
            ));
        }
        let ciphertext = Self::collect_bounded_media(
            &mut HttpMediaChunkSource(response),
            limit,
            content_length,
            on_progress,
        )
        .await?;

        // Matrix attachment encryption is AES-CTR, a stream cipher, so the
        // decrypted plaintext is exactly as long as the ciphertext feeding it
        // (see matrix-sdk 0.18.0's media.rs:473 for the same reasoning). Size
        // the output buffer from that known length instead of growing it from
        // empty, so the final reallocation doesn't briefly hold both the old
        // and new backing storage on top of the settled ciphertext buffer.
        let ciphertext_len = ciphertext.len();
        let mut ciphertext = Cursor::new(ciphertext);
        let mut decryptor =
            AttachmentDecryptor::new(&mut ciphertext, encrypted_file.clone().into())
                .map_err(Self::map_error)?;
        let mut data = Vec::with_capacity(ciphertext_len);
        decryptor
            .read_to_end(&mut data)
            .map_err(|error| BackendError::Crypto(error.to_string()))?;
        Ok(data)
    }

    async fn enforce_media_cache_quota(cache_root: &Path, protected: &Path) -> BackendResult<()> {
        Self::enforce_media_cache_quota_with_limit(cache_root, protected, MAX_MEDIA_CACHE_BYTES)
            .await
    }

    async fn enforce_media_cache_quota_with_limit(
        cache_root: &Path,
        protected: &Path,
        max_bytes: u64,
    ) -> BackendResult<()> {
        let mut entries = Vec::new();
        let mut total = 0u64;
        let mut read_dir = tokio::fs::read_dir(cache_root)
            .await
            .map_err(Self::map_error)?;
        while let Some(entry) = read_dir.next_entry().await.map_err(Self::map_error)? {
            let file_type = entry.file_type().await.map_err(Self::map_error)?;
            if !file_type.is_file() {
                continue;
            }
            let metadata = entry.metadata().await.map_err(Self::map_error)?;
            total = total.saturating_add(metadata.len());
            entries.push((
                entry.path(),
                metadata.len(),
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            ));
        }
        if total <= max_bytes {
            return Ok(());
        }

        entries.sort_by_key(|(_, _, modified)| *modified);
        for (path, size, _) in entries {
            if total <= max_bytes {
                break;
            }
            if path.as_path() == protected {
                continue;
            }
            tokio::fs::remove_file(&path)
                .await
                .map_err(Self::map_error)?;
            total = total.saturating_sub(size);
        }
        Ok(())
    }

    fn direct_message_from_message(message: MessageDto) -> DirectMessageDto {
        DirectMessageDto {
            id: message.id,
            conversation_id: message.channel_id,
            author_public_key: message.author_public_key,
            author_display_name: message.author_display_name,
            author_avatar_color: message.author_avatar_color,
            content: message.content,
            timestamp: message.timestamp,
            signature: message.signature,
            attachments: message.attachments,
            reactions: message.reactions,
            edited_at: message.edited_at,
            deleted_at: message.deleted_at,
            reply_to_id: message.reply_to_id,
            delivery_status: message.delivery_status,
        }
    }
}

#[async_trait]
impl MeshBackend for MatrixBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Matrix
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

    async fn matrix_room_notification_mode(
        &self,
        room_id: String,
    ) -> BackendResult<MatrixRoomNotificationMode> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room =
            Self::protected_joined_room(&client, &room_id, "reading notification settings").await?;
        let mode = room.notification_mode().await.ok_or_else(|| {
            BackendError::Other("Matrix notification mode is not available for this room".into())
        })?;
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
        client
            .notification_settings()
            .await
            .set_room_notification_mode(&room_id, mode)
            .await
            .map_err(Self::map_error)
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

    async fn register_account(
        &self,
        username: String,
        mut password: String,
    ) -> BackendResult<BackendStatus> {
        let username = match Self::normalize_product_username(&username) {
            Ok(username) => username,
            Err(error) => {
                password.zeroize();
                return Err(error);
            }
        };
        if password.len() < 8 {
            password.zeroize();
            return Err(BackendError::InvalidConfiguration(
                "password must be at least 8 characters".into(),
            ));
        }
        let managed = match Self::managed_homeserver_config() {
            Ok(managed) => managed,
            Err(error) => {
                password.zeroize();
                return Err(error);
            }
        };
        let profile_id = if self.dynamic_accounts {
            Self::profile_id(&managed.homeserver, &username)
        } else {
            self.profile_hint.clone()
        };
        let storage = self.storage_for_profile(&profile_id);

        let operation =
            match tokio::time::timeout(Duration::from_secs(REGISTRATION_TIMEOUT_SECONDS), async {
                let client = self.build_client(&managed.homeserver, &storage).await?;
                let registration_request = |auth: Option<AuthData>| {
                    let mut request = RegistrationRequest::new();
                    request.username = Some(username.clone());
                    request.password = Some(password.clone());
                    request.initial_device_display_name = Some("Mesh desktop".into());
                    request.auth = auth;
                    request.refresh_token = true;
                    request
                };

                let first_result = client
                    .matrix_auth()
                    .register(registration_request(None))
                    .await;
                match first_result {
                    Ok(_) => {}
                    Err(error) => {
                        let dummy_session = error
                            .as_uiaa_response()
                            .filter(|info| Self::uiaa_can_complete_with_dummy(info))
                            .map(|info| info.session.clone());
                        if let Some(session) = dummy_session {
                            let mut dummy = Dummy::new();
                            dummy.session = session;
                            client
                                .matrix_auth()
                                .register(registration_request(Some(AuthData::Dummy(dummy))))
                                .await
                                .map_err(Self::map_registration_error)?;
                        } else {
                            return Err(Self::map_registration_error(error));
                        }
                    }
                }

                let session = client.matrix_auth().session().ok_or_else(|| {
                    BackendError::Other(
                        "managed account registration returned no usable session".into(),
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

        let (client, resolved_homeserver, profile_id) = operation?;
        self.stop_runtime().await;
        self.install_client(client, resolved_homeserver, profile_id)
            .await;
        Ok(self.status().await)
    }

    async fn check_username_available(&self, username: String) -> BackendResult<bool> {
        let username = Self::normalize_product_username(&username)?;
        let managed = Self::managed_homeserver_config()?;
        let client = Client::builder()
            .server_name_or_homeserver_url(&managed.homeserver)
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

    async fn oidc_status(&self, homeserver: String) -> BackendResult<MatrixOidcStatus> {
        self.discover_oidc(homeserver).await
    }

    async fn start_oidc_login(&self, homeserver: String) -> BackendResult<()> {
        let status = self.discover_oidc(homeserver).await?;
        if status.availability != MatrixOidcAvailability::Supported
            || !status.authorization_code_pkce
            || !status.client_id_configured
        {
            return Err(BackendError::InvalidConfiguration(format!(
                "Matrix browser sign-in is unavailable: {}. Password sign-in remains available for an existing account",
                status.reason
            )));
        }
        let client_id = Self::configured_oidc_client_id()
            .map_err(BackendError::InvalidConfiguration)?
            .ok_or_else(|| {
                BackendError::InvalidConfiguration(format!(
                    "{OIDC_CLIENT_ID_ENV} is required for managed browser sign-in"
                ))
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
            oauth.restore_registered_client(ClientId::new(client_id));
            let redirect_uri = url::Url::parse(OIDC_REDIRECT_URI).map_err(Self::map_error)?;
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
            client
                .sync_once(SyncSettings::default().set_presence(PresenceState::Offline))
                .await
                .map_err(Self::map_error)?;
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
            client
                .sync_once(SyncSettings::default().set_presence(PresenceState::Offline))
                .await
                .map_err(Self::map_error)?;
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
        channel_request.initial_state = vec![
            Self::encrypted_room_initial_state(),
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
        if channel_type == "voice" {
            let mut creation = CreationContent::new();
            creation.room_type = Some("org.mesh.voice".into());
            request.creation_content = Some(Raw::new(&creation).map_err(Self::map_error)?);
        }
        request.initial_state = vec![
            Self::encrypted_room_initial_state(),
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
        let room = Self::protected_joined_room(&client, &room_id, action).await?;
        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let base_content = RoomMessageEventContentWithoutRelation::text_plain(body.clone())
            .add_mentions(Self::mentions_for_body(body.as_str(), Some(own_user_id)));

        let content = match reply_to_id.as_deref() {
            Some(event_id) => {
                let event_id =
                    matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
                room.make_reply_event(
                    base_content,
                    Reply {
                        event_id,
                        enforce_thread: EnforceThread::Unthreaded,
                        add_mentions: AddMentions::Yes,
                    },
                )
                .await
                .map_err(Self::map_error)?
            }
            None => base_content.into(),
        };
        let transaction_id = Self::validate_transaction_id(&transaction_id)?;
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
            content: body,
            attachments: Vec::new(),
            reactions: HashMap::new(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            signature: String::new(),
            edited_at: None,
            deleted_at: None,
            reply_to_id,
            delivery_status: Some("sent".into()),
        })
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
                    mime::Mime::from_str("application/octet-stream").expect("valid MIME")
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
                    room.make_reply_event(
                        base_content,
                        Reply {
                            event_id,
                            enforce_thread: EnforceThread::Unthreaded,
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
                delivery_status: Some("sent".into()),
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
        Ok(self
            .messages(conversation_id, limit, before_timestamp, before_id)
            .await?
            .into_iter()
            .map(Self::direct_message_from_message)
            .collect())
    }

    async fn send_dm(
        &self,
        recipient_user_id: String,
        body: String,
        reply_to_id: Option<String>,
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
        let message = <Self as MeshBackend>::send_message(
            self,
            room.room_id().to_string(),
            body,
            reply_to_id,
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
        let values =
            Self::timeline_values(&room, limit.clamp(1, 5_000) as usize, before_id.as_deref())
                .await?;
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
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
        let room = Self::protected_joined_room(&client, &room_id, "editing a message").await?;
        let replacement = RoomMessageEventContent::text_plain(body)
            .make_replacement(ReplacementMetadata::new(event_id, None));
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

    async fn mark_read(&self, room_id: String) -> BackendResult<()> {
        let send_read_receipts = self.wire_privacy.read().await.send_read_receipts;
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
        let event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
        let mut receipts = Receipts::new().fully_read_marker(event_id.clone());
        if send_read_receipts {
            receipts = receipts.private_read_receipt(event_id);
        }
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
        let user_id = if user_id.trim().starts_with('@') {
            UserId::parse(user_id.trim()).map_err(Self::map_error)?
        } else {
            let managed = Self::managed_homeserver_config()?;
            Self::qualify_user_input(&user_id, &managed)?
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
                let managed = Self::managed_homeserver_config()?;
                Self::qualify_public_link_input(&alias, &managed)?
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
    ) -> BackendResult<CommunityAccessResult> {
        let client = self.client().await?;
        let value = room_or_alias.trim();
        let identifier = RoomOrAliasId::parse(value).map_err(Self::map_error)?;
        let (room_id, via) = if value.starts_with('#') {
            let alias = RoomAliasId::parse(value).map_err(Self::map_error)?;
            let room_id = client
                .resolve_room_alias(&alias)
                .await
                .map_err(Self::map_error)?
                .room_id;
            (room_id, vec![alias.server_name().to_owned()])
        } else {
            (
                matrix_sdk::ruma::RoomId::parse(value).map_err(Self::map_error)?,
                Vec::new(),
            )
        };

        if let Some(room) = client.get_room(&room_id) {
            if room.state() == RoomState::Invited {
                return Ok(CommunityAccessResult {
                    status: "joined".into(),
                    community: Some(self.join_community(room_or_alias).await?),
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

    async fn join_community(&self, room_or_alias: String) -> BackendResult<CommunityDto> {
        let client = self.client().await?;
        let identifier = RoomOrAliasId::parse(room_or_alias.trim()).map_err(Self::map_error)?;
        let space = client
            .join_room_by_id_or_alias(&identifier, &[])
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

    async fn update_member_role(
        &self,
        community_id: String,
        user_id: String,
        role: String,
    ) -> BackendResult<()> {
        let level = match role.as_str() {
            "admin" => int!(50),
            "member" => int!(0),
            _ => {
                return Err(BackendError::InvalidConfiguration(
                    "role must be admin or member; ownership transfer is not supported".into(),
                ))
            }
        };
        let user_id = matrix_sdk::ruma::UserId::parse(user_id).map_err(Self::map_error)?;
        let mut rooms = self.community_rooms(&community_id).await?;
        rooms.reverse();
        for room in rooms {
            room.update_power_levels(vec![(&user_id, level)])
                .await
                .map_err(Self::map_error)?;
        }
        Ok(())
    }

    async fn kick_member(
        &self,
        community_id: String,
        user_id: String,
        reason: Option<String>,
    ) -> BackendResult<()> {
        let user_id = matrix_sdk::ruma::UserId::parse(user_id).map_err(Self::map_error)?;
        let mut rooms = self.community_rooms(&community_id).await?;
        rooms.reverse();
        for room in rooms {
            room.kick_user(&user_id, reason.as_deref())
                .await
                .map_err(Self::map_error)?;
        }
        Ok(())
    }

    async fn ban_member(
        &self,
        community_id: String,
        user_id: String,
        reason: Option<String>,
    ) -> BackendResult<()> {
        let user_id = matrix_sdk::ruma::UserId::parse(user_id).map_err(Self::map_error)?;
        let mut rooms = self.community_rooms(&community_id).await?;
        rooms.reverse();
        for room in rooms {
            room.ban_user(&user_id, reason.as_deref())
                .await
                .map_err(Self::map_error)?;
        }
        Ok(())
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
            self.apply_wire_privacy(preferences).await;
        }
        Ok(preferences)
    }

    async fn update_user_preferences(
        &self,
        preferences: UserPreferences,
    ) -> BackendResult<UserPreferences> {
        let client = self.client().await?;
        let preferences = preferences.normalized();
        self.apply_wire_privacy(&preferences).await;
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
        self.client()
            .await?
            .join_room_by_id(&room_id)
            .await
            .map(|_| ())
            .map_err(Self::map_error)
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
                    .timeout(sync.cadence.timeout())
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
        }
        if !sync.paused {
            if let Some(client) = sync.client.clone() {
                sync.task = Some(Self::spawn_matrix_sync(
                    client,
                    sync.cadence,
                    sync.presence.clone(),
                    task_epoch,
                    Arc::clone(&self.matrix_sync_freshness),
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
mod tests {
    use super::*;
    use matrix_sdk::{authentication::SessionTokens, SessionMeta};
    use serde_json::json;

    #[test]
    fn composer_drafts_are_plain_bounded_and_new_message_only() {
        let at_limit = "😀".repeat(MAX_COMPOSER_DRAFT_BYTES / 4);
        let draft = MatrixBackend::new_message_composer_draft(at_limit.clone())
            .unwrap()
            .unwrap();
        assert_eq!(draft.plain_text, at_limit);
        assert_eq!(draft.html_text, None);
        assert!(draft.attachments.is_empty());
        assert!(matches!(&draft.draft_type, ComposerDraftType::NewMessage));
        assert_eq!(
            MatrixBackend::new_message_composer_draft_body(draft).unwrap(),
            Some(at_limit)
        );

        assert!(MatrixBackend::new_message_composer_draft(String::new())
            .unwrap()
            .is_none());
        assert!(MatrixBackend::new_message_composer_draft(
            "😀".repeat((MAX_COMPOSER_DRAFT_BYTES / 4) + 1)
        )
        .is_err());

        let edit = ComposerDraft {
            plain_text: "must not appear in the new-message composer".into(),
            html_text: Some("<strong>must not render</strong>".into()),
            draft_type: ComposerDraftType::Edit {
                event_id: "$event:example.org".try_into().unwrap(),
            },
            attachments: Vec::new(),
        };
        assert_eq!(
            MatrixBackend::new_message_composer_draft_body(edit).unwrap(),
            None
        );
    }

    #[test]
    fn wire_privacy_presence_requires_sharing_without_invisible_mode() {
        let visible = WirePrivacyPreferences {
            share_presence: true,
            invisible_mode: false,
            ..WirePrivacyPreferences::default()
        };
        let private = WirePrivacyPreferences {
            share_presence: false,
            ..visible
        };
        let invisible = WirePrivacyPreferences {
            invisible_mode: true,
            ..visible
        };

        assert_eq!(visible.presence(), PresenceState::Online);
        assert_eq!(private.presence(), PresenceState::Offline);
        assert_eq!(invisible.presence(), PresenceState::Offline);
    }

    #[test]
    fn typing_privacy_only_sends_opt_in_or_required_cleanup() {
        let private = WirePrivacyPreferences::default();
        let opted_in = WirePrivacyPreferences {
            send_typing_indicators: true,
            ..private
        };

        assert!(!private.should_send_typing_notice(false, true));
        assert!(!private.should_send_typing_notice(false, false));
        assert!(private.should_send_typing_notice(true, false));
        assert!(opted_in.should_send_typing_notice(false, true));
    }

    fn password_session() -> MatrixSession {
        MatrixSession {
            meta: SessionMeta {
                user_id: "@alice:example.org".try_into().unwrap(),
                device_id: "MESHDEVICE".into(),
            },
            tokens: SessionTokens {
                access_token: "access-token".into(),
                refresh_token: Some("refresh-token".into()),
            },
        }
    }

    fn matrix_rtc_test_membership(
        user_id: &str,
        device_id: &str,
        member_id: &str,
    ) -> ActiveMatrixRtcMembership {
        ActiveMatrixRtcMembership {
            member: MatrixRtcMember {
                room_id: "!room:example.org".into(),
                user_id: user_id.into(),
                device_id: device_id.into(),
                session_id: format!("_{user_id}_{device_id}_m.call"),
                display_name: user_id.into(),
                avatar_url: None,
            },
            member_id: member_id.into(),
            created_ts: matrix_sdk::ruma::MilliSecondsSinceUnixEpoch::now(),
            livekit_service_url: None,
        }
    }

    fn matrix_rtc_test_key_content(
        member_id: &str,
        index: u8,
        key_byte: u8,
        sent_ts: u64,
    ) -> MatrixRtcToDeviceKeyContent {
        MatrixRtcToDeviceKeyContent {
            keys: MatrixRtcMediaKeyEntry {
                index,
                key: BASE64_STANDARD.encode([key_byte; MATRIX_RTC_MEDIA_KEY_BYTES]),
            },
            room_id: "!room:example.org".into(),
            member: MatrixRtcMediaKeyMember {
                claimed_device_id: "BOBDEVICE".into(),
                id: member_id.into(),
            },
            session: MatrixRtcMediaKeySession {
                application: "m.call".into(),
                call_id: String::new(),
                scope: "m.room".into(),
            },
            sent_ts,
        }
    }

    #[test]
    fn matrix_rtc_media_key_wire_shape_matches_current_matrix_js() {
        let content = matrix_rtc_test_key_content("member-bob", 7, 42, 1_000);
        let value = serde_json::to_value(content).unwrap();
        assert!(value["keys"].is_object());
        assert_eq!(value["keys"]["index"], 7);
        assert!(!value["keys"]["key"].as_str().unwrap().contains('='));
        assert_eq!(value["member"]["claimed_device_id"], "BOBDEVICE");
        assert_eq!(value["member"]["id"], "member-bob");
        assert_eq!(value["session"]["application"], "m.call");
        assert_eq!(value["session"]["call_id"], "");
        assert_eq!(value["session"]["scope"], "m.room");
    }

    #[test]
    fn matrix_rtc_media_key_requires_canonical_16_byte_unpadded_base64() {
        let canonical = BASE64_STANDARD.encode([9_u8; MATRIX_RTC_MEDIA_KEY_BYTES]);
        assert_eq!(
            MatrixBackend::decode_matrix_rtc_media_key(&canonical).unwrap(),
            [9_u8; MATRIX_RTC_MEDIA_KEY_BYTES]
        );
        assert!(MatrixBackend::decode_matrix_rtc_media_key(&format!("{canonical}==")).is_err());
        assert!(
            MatrixBackend::decode_matrix_rtc_media_key(&BASE64_STANDARD.encode([9_u8; 15]))
                .is_err()
        );
    }

    #[test]
    fn matrix_rtc_media_key_validation_binds_olm_sender_device_and_membership() {
        let memberships = vec![matrix_rtc_test_membership(
            "@bob:example.org",
            "BOBDEVICE",
            "member-bob",
        )];
        let now = 1_000_000;
        let mut runtime = MatrixRtcMediaKeyRuntime::default();
        assert!(MatrixBackend::validate_matrix_rtc_media_key(
            matrix_rtc_test_key_content("member-bob", 0, 1, now),
            "@mallory:example.org",
            "@bob:example.org",
            "BOBDEVICE",
            &memberships,
            now,
            &mut runtime,
        )
        .is_err());
        assert!(MatrixBackend::validate_matrix_rtc_media_key(
            matrix_rtc_test_key_content("old-member", 0, 1, now),
            "@bob:example.org",
            "@bob:example.org",
            "BOBDEVICE",
            &memberships,
            now,
            &mut runtime,
        )
        .is_err());
        assert!(MatrixBackend::validate_matrix_rtc_media_key(
            matrix_rtc_test_key_content("member-bob", 0, 1, now),
            "@bob:example.org",
            "@bob:example.org",
            "OTHERDEVICE",
            &memberships,
            now,
            &mut runtime,
        )
        .is_err());
    }

    #[test]
    fn matrix_rtc_media_key_rejects_replay_stale_and_backward_generations() {
        let memberships = vec![matrix_rtc_test_membership(
            "@bob:example.org",
            "BOBDEVICE",
            "member-bob",
        )];
        let now = 1_000_000;
        let mut runtime = MatrixRtcMediaKeyRuntime::default();
        MatrixBackend::validate_matrix_rtc_media_key(
            matrix_rtc_test_key_content("member-bob", 250, 1, now - 3),
            "@bob:example.org",
            "@bob:example.org",
            "BOBDEVICE",
            &memberships,
            now,
            &mut runtime,
        )
        .unwrap();
        assert!(MatrixBackend::validate_matrix_rtc_media_key(
            matrix_rtc_test_key_content("member-bob", 250, 1, now - 3),
            "@bob:example.org",
            "@bob:example.org",
            "BOBDEVICE",
            &memberships,
            now,
            &mut runtime,
        )
        .is_err());
        MatrixBackend::validate_matrix_rtc_media_key(
            matrix_rtc_test_key_content("member-bob", 252, 2, now - 2),
            "@bob:example.org",
            "@bob:example.org",
            "BOBDEVICE",
            &memberships,
            now,
            &mut runtime,
        )
        .expect("a lost intermediate generation must not wedge the publisher");
        assert!(MatrixBackend::validate_matrix_rtc_media_key(
            matrix_rtc_test_key_content("member-bob", 251, 3, now - 1),
            "@bob:example.org",
            "@bob:example.org",
            "BOBDEVICE",
            &memberships,
            now,
            &mut runtime,
        )
        .is_err());
        assert!(MatrixBackend::validate_matrix_rtc_media_key(
            matrix_rtc_test_key_content(
                "member-bob",
                253,
                4,
                now - MATRIX_RTC_KEY_MAX_AGE.as_millis() as u64 - 1,
            ),
            "@bob:example.org",
            "@bob:example.org",
            "BOBDEVICE",
            &memberships,
            now,
            &mut runtime,
        )
        .is_err());
    }

    #[test]
    fn matrix_rtc_media_key_generation_wraps_from_255_to_zero() {
        let memberships = vec![matrix_rtc_test_membership(
            "@bob:example.org",
            "BOBDEVICE",
            "member-bob",
        )];
        let now = 1_000_000;
        let mut runtime = MatrixRtcMediaKeyRuntime::default();
        for (index, key_byte, sent_ts) in [(255, 1, now - 1), (0, 2, now)] {
            MatrixBackend::validate_matrix_rtc_media_key(
                matrix_rtc_test_key_content("member-bob", index, key_byte, sent_ts),
                "@bob:example.org",
                "@bob:example.org",
                "BOBDEVICE",
                &memberships,
                now,
                &mut runtime,
            )
            .unwrap();
        }
    }

    #[test]
    fn matrix_rtc_recipient_set_tracks_exact_current_membership_epochs() {
        let own = matrix_rtc_test_membership("@alice:example.org", "ALICEDEVICE", "member-alice");
        let old = matrix_rtc_test_membership("@bob:example.org", "BOBDEVICE", "old-member");
        let current = matrix_rtc_test_membership("@bob:example.org", "BOBDEVICE", "new-member");
        let before = MatrixBackend::matrix_rtc_key_recipients(
            &[own.clone(), old],
            "@alice:example.org",
            "ALICEDEVICE",
        )
        .unwrap();
        let after = MatrixBackend::matrix_rtc_key_recipients(
            &[own, current],
            "@alice:example.org",
            "ALICEDEVICE",
        )
        .unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(after.len(), 1);
        assert_ne!(before, after);
        assert!(after
            .iter()
            .any(|recipient| recipient.member_id == "new-member"));
    }

    #[test]
    fn matrix_rtc_key_attempts_are_rate_limited_and_expire() {
        let mut runtime = MatrixRtcMediaKeyRuntime::default();
        for _ in 0..MATRIX_RTC_KEY_ATTEMPTS_PER_MINUTE {
            MatrixBackend::record_matrix_rtc_key_attempt(
                &mut runtime,
                "@bob:example.org",
                "BOBDEVICE",
                1_000,
            )
            .unwrap();
        }
        assert!(MatrixBackend::record_matrix_rtc_key_attempt(
            &mut runtime,
            "@bob:example.org",
            "BOBDEVICE",
            1_000,
        )
        .is_err());
        MatrixBackend::record_matrix_rtc_key_attempt(
            &mut runtime,
            "@bob:example.org",
            "BOBDEVICE",
            61_001,
        )
        .unwrap();
    }

    #[test]
    fn matrix_rtc_media_key_debug_is_redacted() {
        let key = MatrixRtcMediaKey {
            room_id: "!room:example.org".into(),
            user_id: "@bob:example.org".into(),
            device_id: "BOBDEVICE".into(),
            member_id: "member-bob".into(),
            session_id: None,
            activation_id: None,
            participant_identity: "identity".into(),
            key_index: 0,
            key: "super-secret-key".into(),
            sent_ts: 1_000,
        };
        let debug = format!("{key:?}");
        assert!(!debug.contains("super-secret-key"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn matrix_rtc_pending_activation_rejects_wrong_ack_without_mutation() {
        let state_key = ("!room:example.org".into(), "local-session".into());
        let recipients = HashSet::from([MatrixRtcKeyParticipant {
            user_id: "@bob:example.org".into(),
            device_id: "BOBDEVICE".into(),
            member_id: "member-bob".into(),
        }]);
        let mut runtime = MatrixRtcMediaKeyRuntime::default();
        runtime.pending_activations.insert(
            state_key.clone(),
            MatrixRtcPendingActivation {
                activation_id: "expected-activation".into(),
                room_id: state_key.0.clone(),
                session_id: state_key.1.clone(),
                member_id: "member-alice".into(),
                key_index: 4,
                key: [7; MATRIX_RTC_MEDIA_KEY_BYTES],
                recipient_fingerprint: MatrixBackend::matrix_rtc_recipient_fingerprint(&recipients)
                    .unwrap(),
                recipients,
                expires_at: 2_000,
                phase: MatrixRtcActivationPhase::AwaitingPauseAck,
            },
        );
        assert!(MatrixBackend::matrix_rtc_pending_activation_snapshot(
            &runtime,
            &state_key.0,
            &state_key.1,
            "member-alice",
            "wrong-activation",
            MatrixRtcActivationPhase::AwaitingPauseAck,
            1_000,
        )
        .is_err());
        assert_eq!(runtime.pending_activations.len(), 1);
        assert_eq!(
            runtime
                .pending_activations
                .get(&state_key)
                .unwrap()
                .activation_id,
            "expected-activation"
        );
    }

    #[test]
    fn matrix_rtc_pending_activation_never_renews_and_expiry_is_terminal() {
        let state_key = ("!room:example.org".into(), "local-session".into());
        let mut runtime = MatrixRtcMediaKeyRuntime::default();
        runtime.outbound.insert(
            state_key.clone(),
            MatrixRtcOutboundMediaKey {
                key_index: 3,
                key: [3; MATRIX_RTC_MEDIA_KEY_BYTES],
                recipients: HashSet::new(),
            },
        );
        assert!(matches!(
            MatrixBackend::matrix_rtc_local_lease_state(&mut runtime, &state_key, 1_000).unwrap(),
            MatrixRtcLocalLeaseState::Active { key_index: 3 }
        ));
        runtime.pending_activations.insert(
            state_key.clone(),
            MatrixRtcPendingActivation {
                activation_id: "activation".into(),
                room_id: state_key.0.clone(),
                session_id: state_key.1.clone(),
                member_id: "member-alice".into(),
                key_index: 4,
                key: [4; MATRIX_RTC_MEDIA_KEY_BYTES],
                recipients: HashSet::new(),
                recipient_fingerprint: MatrixBackend::matrix_rtc_recipient_fingerprint(
                    &HashSet::new(),
                )
                .unwrap(),
                expires_at: 2_000,
                phase: MatrixRtcActivationPhase::AwaitingPauseAck,
            },
        );
        assert!(matches!(
            MatrixBackend::matrix_rtc_local_lease_state(&mut runtime, &state_key, 1_000).unwrap(),
            MatrixRtcLocalLeaseState::Paused
        ));
        assert!(matches!(
            MatrixBackend::matrix_rtc_local_lease_state(&mut runtime, &state_key, 2_000).unwrap(),
            MatrixRtcLocalLeaseState::Expired
        ));
        assert!(!runtime.pending_activations.contains_key(&state_key));
        assert!(!runtime.outbound.contains_key(&state_key));
        assert!(runtime.lease_blocked.contains(&state_key));
        assert!(matches!(
            MatrixBackend::matrix_rtc_local_lease_state(&mut runtime, &state_key, 2_001).unwrap(),
            MatrixRtcLocalLeaseState::Paused
        ));
    }

    #[test]
    fn matrix_rtc_failed_leave_clear_cannot_restore_local_lease() {
        let state_key = ("!room:example.org".into(), "local-session".into());
        let mut runtime = MatrixRtcMediaKeyRuntime::default();
        runtime.outbound.insert(
            state_key.clone(),
            MatrixRtcOutboundMediaKey {
                key_index: 3,
                key: [3; MATRIX_RTC_MEDIA_KEY_BYTES],
                recipients: HashSet::new(),
            },
        );
        runtime.pending_activations.insert(
            state_key.clone(),
            MatrixRtcPendingActivation {
                activation_id: "activation".into(),
                room_id: state_key.0.clone(),
                session_id: state_key.1.clone(),
                member_id: "member-alice".into(),
                key_index: 4,
                key: [4; MATRIX_RTC_MEDIA_KEY_BYTES],
                recipients: HashSet::new(),
                recipient_fingerprint: MatrixBackend::matrix_rtc_recipient_fingerprint(
                    &HashSet::new(),
                )
                .unwrap(),
                expires_at: 2_000,
                phase: MatrixRtcActivationPhase::AwaitingPauseAck,
            },
        );
        runtime.completed_activations.insert(
            state_key.clone(),
            MatrixRtcCompletedActivation {
                activation_id: "previous-activation".into(),
                member_id: "member-alice".into(),
                key_index: 3,
                sent_ts: 900,
                completed_at: 900,
            },
        );
        runtime.lease_blocked.insert(state_key.clone());

        MatrixBackend::revoke_matrix_rtc_publication(&mut runtime, &state_key);
        let membership_clear_result: BackendResult<bool> =
            Err(BackendError::Other("simulated Matrix state failure".into()));
        assert!(membership_clear_result.is_err());

        assert!(!runtime.outbound.contains_key(&state_key));
        assert!(!runtime.pending_activations.contains_key(&state_key));
        assert!(!runtime.completed_activations.contains_key(&state_key));
        assert!(!runtime.lease_blocked.contains(&state_key));
        assert!(
            MatrixBackend::matrix_rtc_local_lease_state(&mut runtime, &state_key, 1_000).is_err()
        );
    }

    #[test]
    fn matrix_rtc_publication_lease_rejects_frozen_sync() {
        let freshness = MATRIX_RTC_SYNC_FRESHNESS.as_millis() as u64;
        assert!(!MatrixBackend::matrix_rtc_sync_is_fresh(0, 1_000));
        assert!(MatrixBackend::matrix_rtc_sync_is_fresh(
            1_000,
            1_000 + freshness
        ));
        assert!(!MatrixBackend::matrix_rtc_sync_is_fresh(
            1_000,
            1_001 + freshness
        ));
    }

    #[test]
    fn matrix_rtc_active_sync_cadence_bounds_final_publication_lease() {
        assert_eq!(
            MatrixBackend::matrix_sync_cadence_for_active_call(false),
            MatrixSyncCadence::Normal
        );
        assert_eq!(
            MatrixBackend::matrix_sync_cadence_for_active_call(true),
            MatrixSyncCadence::ActiveCall
        );
        assert_eq!(MatrixSyncCadence::Normal.timeout(), Duration::from_secs(30));
        assert_eq!(
            MatrixSyncCadence::ActiveCall.timeout(),
            Duration::from_secs(1)
        );
        assert_eq!(
            MATRIX_RTC_SYNC_FRESHNESS + MATRIX_RTC_KEY_LEASE_TTL,
            Duration::from_secs(5)
        );
        assert!(MATRIX_RTC_SYNC_FRESHNESS + MATRIX_RTC_KEY_LEASE_TTL <= Duration::from_secs(6));
    }

    #[test]
    fn matrix_sync_stale_epoch_cannot_refresh_freshness() {
        let freshness = StdMutex::new(MatrixSyncFreshness {
            epoch: 7,
            last_success_ms: 0,
        });
        assert!(!MatrixBackend::record_matrix_sync_success(
            &freshness, 6, 1_000,
        ));
        assert_eq!(freshness.lock().unwrap().last_success_ms, 0);
        assert!(MatrixBackend::record_matrix_sync_success(
            &freshness, 7, 1_001,
        ));
        assert_eq!(freshness.lock().unwrap().last_success_ms, 1_001);
        freshness.lock().unwrap().epoch = 8;
        assert!(!MatrixBackend::record_matrix_sync_success(
            &freshness, 7, 1_002,
        ));
        assert_eq!(freshness.lock().unwrap().last_success_ms, 1_001);
    }

    #[test]
    fn matrix_sync_status_requires_recent_success() {
        let freshness = MATRIX_SYNC_STATUS_FRESHNESS.as_millis() as u64;
        assert!(!MatrixBackend::matrix_sync_is_fresh(0, 1_000));
        assert!(MatrixBackend::matrix_sync_is_fresh(
            1_000,
            1_000 + freshness
        ));
        assert!(!MatrixBackend::matrix_sync_is_fresh(
            1_000,
            1_001 + freshness
        ));
    }

    #[test]
    fn matrix_sync_retry_delay_is_bounded_and_exponential() {
        assert_eq!(
            MatrixBackend::matrix_sync_retry_delay(0),
            Duration::from_secs(1)
        );
        assert_eq!(
            MatrixBackend::matrix_sync_retry_delay(2),
            Duration::from_secs(2)
        );
        assert_eq!(
            MatrixBackend::matrix_sync_retry_delay(6),
            Duration::from_secs(32).min(MATRIX_SYNC_RETRY_MAX_DELAY)
        );
        assert_eq!(
            MatrixBackend::matrix_sync_retry_delay(u32::MAX),
            MATRIX_SYNC_RETRY_MAX_DELAY
        );
    }

    #[tokio::test]
    async fn matrix_sync_cadence_transitions_are_idempotent_and_reset_freshness() {
        let backend = MatrixBackend::new(tempfile::tempdir().unwrap().path().to_owned());
        backend
            .matrix_sync_freshness
            .lock()
            .unwrap()
            .last_success_ms = 1_000;
        MatrixBackend::set_matrix_sync_cadence(
            &backend.matrix_sync_control,
            &backend.matrix_sync_freshness,
            MatrixSyncCadence::ActiveCall,
        )
        .await;
        let active_epoch = backend.matrix_sync_freshness.lock().unwrap().epoch;
        assert!(active_epoch > 0);
        assert_eq!(
            backend
                .matrix_sync_freshness
                .lock()
                .unwrap()
                .last_success_ms,
            0,
        );
        assert_eq!(
            backend.matrix_sync_control.lock().await.cadence,
            MatrixSyncCadence::ActiveCall
        );

        MatrixBackend::set_matrix_sync_cadence(
            &backend.matrix_sync_control,
            &backend.matrix_sync_freshness,
            MatrixSyncCadence::ActiveCall,
        )
        .await;
        assert_eq!(
            backend.matrix_sync_freshness.lock().unwrap().epoch,
            active_epoch
        );

        backend.pause_sync().await;
        let paused_epoch = backend.matrix_sync_freshness.lock().unwrap().epoch;
        assert!(paused_epoch > active_epoch);
        assert!(backend.matrix_sync_control.lock().await.paused);
        backend.pause_sync().await;
        assert_eq!(
            backend.matrix_sync_freshness.lock().unwrap().epoch,
            paused_epoch
        );
    }

    #[tokio::test]
    async fn matrix_sync_freshness_lock_recovers_after_panic_while_held() {
        let backend = MatrixBackend::new(tempfile::tempdir().unwrap().path().to_owned());
        let freshness = Arc::clone(&backend.matrix_sync_freshness);

        let panicked = std::thread::spawn(move || {
            let _guard = freshness.lock().unwrap();
            panic!("simulated panic while holding the sync freshness lock");
        })
        .join();
        assert!(
            panicked.is_err(),
            "expected the spawned thread to panic while holding the lock"
        );
        assert!(
            backend.matrix_sync_freshness.is_poisoned(),
            "lock should be poisoned by the panic above"
        );

        // A poisoned lock must not permanently break every future reader; two
        // calls prove recovery isn't a one-shot side effect of the first read.
        let first = backend.status().await;
        assert!(!first.sync_running);
        let second = backend.status().await;
        assert!(!second.sync_running);
    }

    #[test]
    fn matrix_rtc_pause_generation_is_the_candidate_key_index() {
        let pause = MatrixRtcMediaKeyPause {
            room_id: "!room:example.org".into(),
            session_id: "local-session".into(),
            member_id: "member-alice".into(),
            activation_id: "activation".into(),
            key_index: 9,
        };
        let value = serde_json::to_value(pause).unwrap();
        assert_eq!(value["keyIndex"], 9);
        assert_eq!(value["activationId"], "activation");
    }

    #[test]
    fn matrix_rtc_membership_matches_current_matrix_js_shape_and_renews_expiry() {
        let initial = MatrixBackend::matrix_rtc_membership_content(
            "MESHDEVICE",
            "@alice:example.org:MESHDEVICE",
            "https://rtc.example.org/livekit/jwt",
            1_000,
            1_000,
        )
        .unwrap();
        assert_eq!(initial["application"], "m.call");
        assert_eq!(initial["call_id"], "");
        assert_eq!(initial["scope"], "m.room");
        assert_eq!(initial["device_id"], "MESHDEVICE");
        assert_eq!(initial["membershipID"], "@alice:example.org:MESHDEVICE");
        assert_eq!(initial["focus_active"]["type"], "livekit");
        assert_eq!(
            initial["focus_active"]["focus_selection"],
            "oldest_membership"
        );
        assert_eq!(
            initial["foci_preferred"][0]["livekit_service_url"],
            "https://rtc.example.org/livekit/jwt"
        );
        assert_eq!(initial["m.call.intent"], "audio");
        assert_eq!(initial["created_ts"], 1_000);
        assert_eq!(initial["expires"], 120_000);

        let refreshed = MatrixBackend::matrix_rtc_membership_content(
            "MESHDEVICE",
            "@alice:example.org:MESHDEVICE",
            "https://rtc.example.org/livekit/jwt",
            1_000,
            61_000,
        )
        .unwrap();
        assert_eq!(refreshed["created_ts"], initial["created_ts"]);
        assert_eq!(refreshed["expires"], 180_000);
    }

    #[test]
    fn matrix_rtc_state_key_and_token_request_use_interoperable_contract() {
        let user_id = matrix_sdk::ruma::UserId::parse("@alice:example.org").unwrap();
        let state_key = CallMemberStateKey::new(user_id, Some("MESHDEVICE_m.call".into()), true);
        assert_eq!(state_key.as_ref(), "_@alice:example.org_MESHDEVICE_m.call");

        let request = MatrixRtcTokenRequest {
            room_id: "!room:example.org".into(),
            slot_id: MATRIX_RTC_SLOT_ID.into(),
            openid_token: MatrixRtcOpenIdToken {
                access_token: "openid".into(),
                token_type: "Bearer".into(),
                matrix_server_name: "example.org".into(),
                expires_in: 3_600,
            },
            member: MatrixRtcTokenMember {
                id: "@alice:example.org:MESHDEVICE".into(),
                claimed_user_id: "@alice:example.org".into(),
                claimed_device_id: "MESHDEVICE".into(),
            },
        };
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["slot_id"], "m.call#ROOM");
        assert_eq!(value["openid_token"]["access_token"], "openid");
        assert_eq!(value["member"]["claimed_device_id"], "MESHDEVICE");
        assert!(value.get("room").is_none());
        assert!(value.get("device_id").is_none());
    }

    #[test]
    fn matrix_rtc_alias_and_identity_are_standard_unpadded_base64() {
        let room_name = MatrixBackend::matrix_rtc_room_name("!room:example.org").unwrap();
        let identity = MatrixBackend::matrix_rtc_participant_identity(
            "@alice:example.org",
            "MESHDEVICE",
            "@alice:example.org:MESHDEVICE",
        )
        .unwrap();
        assert!(!room_name.contains('='));
        assert!(!identity.contains('='));
        assert_ne!(room_name, identity);
        assert_eq!(
            room_name,
            MatrixBackend::matrix_rtc_room_name("!room:example.org").unwrap()
        );
    }

    #[test]
    fn matrix_rtc_authenticated_discovery_parses_livekit_transport() {
        let transport = serde_json::from_value::<RtcTransport>(json!({
            "type": "livekit",
            "livekit_service_url": "https://rtc.example.org/livekit/jwt"
        }))
        .unwrap();

        let discovery = MatrixBackend::parse_matrix_rtc_transports(
            vec![transport],
            MatrixRtcDiscoverySource::AuthenticatedEndpoint,
        )
        .unwrap();

        assert_eq!(discovery.service_url, "https://rtc.example.org/livekit/jwt");
        assert_eq!(
            discovery.source,
            MatrixRtcDiscoverySource::AuthenticatedEndpoint
        );
    }

    #[test]
    fn matrix_rtc_well_known_fallback_ignores_unknown_transports() {
        let custom = serde_json::from_value::<RtcTransport>(json!({
            "type": "org.example.custom",
            "service_url": "https://custom.example.org"
        }))
        .unwrap();
        let livekit = serde_json::from_value::<RtcTransport>(json!({
            "type": "livekit",
            "livekit_service_url": "https://rtc.example.org/livekit/jwt"
        }))
        .unwrap();

        let discovery = MatrixBackend::parse_matrix_rtc_transports(
            vec![custom, livekit],
            MatrixRtcDiscoverySource::WellKnownFallback,
        )
        .unwrap();

        assert_eq!(
            discovery.source,
            MatrixRtcDiscoverySource::WellKnownFallback
        );
        assert_eq!(discovery.service_url, "https://rtc.example.org/livekit/jwt");
    }

    #[test]
    fn matrix_rtc_discovery_rejects_missing_or_insecure_livekit_urls() {
        let missing_url = serde_json::from_value::<RtcTransport>(json!({
            "type": "livekit"
        }));
        assert!(missing_url.is_err());

        let insecure_url = serde_json::from_value::<RtcTransport>(json!({
            "type": "livekit",
            "livekit_service_url": "http://rtc.example.org/livekit/jwt"
        }))
        .unwrap();
        assert!(matches!(
            MatrixBackend::parse_matrix_rtc_transports(
                vec![insecure_url],
                MatrixRtcDiscoverySource::WellKnownFallback,
            ),
            Err(BackendError::InvalidConfiguration(_))
        ));

        let unsupported = serde_json::from_value::<RtcTransport>(json!({
            "type": "org.example.custom"
        }))
        .unwrap();
        assert!(matches!(
            MatrixBackend::parse_matrix_rtc_transports(
                vec![unsupported],
                MatrixRtcDiscoverySource::WellKnownFallback,
            ),
            Err(BackendError::NotFound(_))
        ));
    }

    #[test]
    fn matrix_rtc_endpoint_fallback_only_covers_404_or_unrecognized() {
        assert_eq!(
            MatrixBackend::classify_matrix_rtc_endpoint_failure(Some(404), None),
            MatrixRtcEndpointFailure::FallbackToWellKnown
        );
        assert_eq!(
            MatrixBackend::classify_matrix_rtc_endpoint_failure(
                Some(400),
                Some(&ErrorKind::Unrecognized),
            ),
            MatrixRtcEndpointFailure::FallbackToWellKnown
        );
        assert_eq!(
            MatrixBackend::classify_matrix_rtc_endpoint_failure(Some(401), None),
            MatrixRtcEndpointFailure::Unauthorized
        );
        assert_eq!(
            MatrixBackend::classify_matrix_rtc_endpoint_failure(Some(429), None),
            MatrixRtcEndpointFailure::RateLimited
        );
        assert_eq!(
            MatrixBackend::classify_matrix_rtc_endpoint_failure(Some(500), None),
            MatrixRtcEndpointFailure::Other
        );
    }

    #[test]
    fn matrix_rtc_token_response_requires_the_exact_configured_sfu_endpoint() {
        assert_eq!(
            MatrixBackend::validate_matrix_rtc_sfu_url(
                "wss://livekit.example.org/livekit/sfu",
                "wss://livekit.example.org/livekit/sfu",
            )
            .unwrap(),
            "wss://livekit.example.org/livekit/sfu"
        );
        assert!(MatrixBackend::validate_matrix_rtc_sfu_url(
            "wss://livekit.example.org/attacker-controlled",
            "wss://livekit.example.org/livekit/sfu",
        )
        .is_err());
        assert!(MatrixBackend::validate_matrix_rtc_sfu_url(
            "wss://other.example.org/livekit/sfu",
            "wss://livekit.example.org/livekit/sfu",
        )
        .is_err());
        assert!(MatrixBackend::validate_matrix_rtc_sfu_url(
            "wss://livekit.example.org/livekit/sfu?token=leak",
            "wss://livekit.example.org/livekit/sfu",
        )
        .is_err());
    }

    #[tokio::test]
    async fn matrix_rtc_leave_is_idempotent_for_renderer_cleanup() {
        let backend = MatrixBackend::new(tempfile::tempdir().unwrap().path().to_owned());
        backend
            .matrix_rtc_leave(
                "!room:example.org".into(),
                "_@alice:example.org_MESHDEVICE_m.call".into(),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn matrix_rtc_join_fails_before_authentication_without_verified_media_e2ee() {
        let backend = MatrixBackend::new(tempfile::tempdir().unwrap().path().to_owned());
        let error = backend
            .matrix_rtc_join("!room:example.org".into())
            .await
            .unwrap_err();
        assert!(matches!(error, BackendError::Unsupported(_)));
        assert!(backend.rtc_sessions.lock().await.is_empty());
    }

    #[test]
    fn notification_preview_is_single_line_and_bounded() {
        assert_eq!(
            MatrixBackend::notification_preview("  hello\n\nMatrix\tworld  "),
            "hello Matrix world"
        );
        let preview = MatrixBackend::notification_preview(&"a".repeat(300));
        assert_eq!(preview.chars().count(), 241);
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn explicit_matrix_mentions_parse_safely_and_filter_self() {
        let own_user_id = UserId::parse("@self:example.org").unwrap();
        let mentions = MatrixBackend::mentions_for_body(
            "hello @alice:example.org, <@bob:example.net> @everyone foo@ignored.example @self:example.org.",
            Some(&own_user_id),
        );
        let user_ids = mentions
            .user_ids
            .iter()
            .map(|user_id| user_id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(user_ids, vec!["@alice:example.org", "@bob:example.net"]);
        assert!(!mentions.room);

        let mut body = String::new();
        for index in 0..80 {
            body.push_str(&format!(" @user{index}:example.org"));
        }
        assert_eq!(
            MatrixBackend::mentions_for_body(&body, None).user_ids.len(),
            64
        );
    }

    #[test]
    fn mention_metadata_serializes_on_plain_messages_and_replies() {
        let body = "hello @alice:example.org";
        let content = RoomMessageEventContent::text_plain(body)
            .add_mentions(MatrixBackend::mentions_for_body(body, None));
        let serialized = serde_json::to_value(content).unwrap();
        assert_eq!(
            serialized["m.mentions"]["user_ids"],
            json!(["@alice:example.org"])
        );
        assert!(serialized["m.mentions"].get("room").is_none());

        let event_id = matrix_sdk::ruma::EventId::parse("$event:example.org").unwrap();
        let sender = UserId::parse("@sender:example.org").unwrap();
        let reply = RoomMessageEventContentWithoutRelation::text_plain("reply")
            .add_mentions(Mentions::new())
            .make_reply_to(
                matrix_sdk::ruma::events::room::message::ReplyMetadata::new(
                    &event_id, &sender, None,
                ),
                matrix_sdk::ruma::events::room::message::ForwardThread::No,
                AddMentions::Yes,
            );
        let reply_json = serde_json::to_value(reply).unwrap();
        assert_eq!(
            reply_json["m.mentions"]["user_ids"],
            json!(["@sender:example.org"])
        );

        let empty = RoomMessageEventContent::text_plain("no explicit mention").add_mentions(
            MatrixBackend::mentions_for_body("no explicit mention", None),
        );
        assert_eq!(
            serde_json::to_value(empty).unwrap()["m.mentions"],
            json!({})
        );
    }

    #[test]
    fn oidc_client_id_configuration_fails_closed() {
        assert_eq!(MatrixBackend::normalize_oidc_client_id(None).unwrap(), None);
        assert_eq!(
            MatrixBackend::normalize_oidc_client_id(Some("  mesh-desktop  ".into())).unwrap(),
            Some("mesh-desktop".into())
        );
        assert!(MatrixBackend::normalize_oidc_client_id(Some("bad\nclient".into())).is_err());
        assert!(MatrixBackend::normalize_oidc_client_id(Some("x".repeat(513))).is_err());
    }

    #[test]
    fn oidc_requires_every_native_authorization_capability() {
        assert!(MatrixBackend::has_required_oidc_capabilities(
            true, true, true, true, true
        ));
        for missing in 0..5 {
            let mut capabilities = [true; 5];
            capabilities[missing] = false;
            assert!(!MatrixBackend::has_required_oidc_capabilities(
                capabilities[0],
                capabilities[1],
                capabilities[2],
                capabilities[3],
                capabilities[4],
            ));
        }
    }

    #[test]
    fn persisted_sessions_record_auth_kind_and_migrate_password_v1() {
        let current = PersistedSession {
            homeserver: "https://matrix.example.org/".into(),
            authentication: PersistedAuthentication::Password {
                session: password_session(),
            },
        };
        let current_json = serde_json::to_value(&current).unwrap();
        assert_eq!(
            current_json.pointer("/authentication/kind"),
            Some(&json!("password"))
        );

        let legacy_json = json!({
            "homeserver": "https://matrix.example.org/",
            "session": password_session()
        });
        let migrated =
            MatrixBackend::decode_persisted_session(&serde_json::to_vec(&legacy_json).unwrap())
                .unwrap();
        assert!(matches!(
            migrated.authentication,
            PersistedAuthentication::Password { .. }
        ));
    }

    #[test]
    fn matrix_display_names_are_trimmed_and_bounded() {
        assert_eq!(
            MatrixBackend::normalize_display_name("  Alice Example  ").unwrap(),
            "Alice Example"
        );
        assert!(matches!(
            MatrixBackend::normalize_display_name(" \t "),
            Err(BackendError::InvalidConfiguration(_))
        ));
        assert!(matches!(
            MatrixBackend::normalize_display_name(&"a".repeat(101)),
            Err(BackendError::InvalidConfiguration(_))
        ));
        assert!(matches!(
            MatrixBackend::normalize_display_name("Alice\nAdmin"),
            Err(BackendError::InvalidConfiguration(_))
        ));
    }

    #[test]
    fn encrypted_room_guard_allows_encrypted_rooms() {
        assert!(MatrixBackend::ensure_room_is_encrypted(
            "!safe:example.org",
            "sending a message",
            true,
        )
        .is_ok());
    }

    #[test]
    fn secure_store_failures_use_the_typed_crypto_boundary() {
        let error = MatrixBackend::map_secure_storage_error("credential store is locked");

        assert!(matches!(error, BackendError::Crypto(_)));
        assert!(error.to_string().contains("secure store is unavailable"));
    }

    #[test]
    fn every_room_creation_uses_the_canonical_encryption_initial_state() {
        let encryption = MatrixBackend::encrypted_room_initial_state();
        assert_eq!(
            encryption.get_field::<String>("type").unwrap().as_deref(),
            Some("m.room.encryption")
        );
        let content = encryption
            .get_field::<serde_json::Value>("content")
            .unwrap()
            .unwrap();
        assert_eq!(
            content.get("algorithm").and_then(serde_json::Value::as_str),
            Some("m.megolm.v1.aes-sha2")
        );

        let source = include_str!("matrix.rs")
            .split("\n#[cfg(test)]")
            .next()
            .expect("production source precedes the test module");
        assert_eq!(
            source.matches("create_room(").count(),
            source.matches("encrypted_room_initial_state()").count() - 1,
            "each direct room creation must include the canonical encryption initial state"
        );
    }

    #[test]
    fn encrypted_room_guard_fails_closed_with_actionable_room_context() {
        let protected_actions = [
            "reading unread message counts",
            "processing MatrixRTC media keys",
            "activating a MatrixRTC media key",
            "accepting a MatrixRTC media key",
            "reading MatrixRTC membership",
            "updating MatrixRTC membership",
            "showing a notification",
            "reading typing status",
            "sending a message",
            "sending a reply",
            "sending an attachment",
            "downloading an attachment",
            "editing a message",
            "changing a reaction",
            "updating message receipts",
            "updating typing status",
            "reading messages",
            "reading recent messages",
            "waiting for message updates",
            "importing legacy provenance",
            "opening this community",
            "opening this community channel",
            "adding a community channel",
            "listing communities",
            "joining this community",
            "opening this direct message",
            "listing direct messages",
            "reading direct messages",
            "updating direct-message receipts",
            "reading community access settings",
            "updating community access settings",
            "reading community applications",
            "responding to a community application",
            "reading notification settings",
            "updating notification settings",
            "inviting a room member",
        ];

        for action in protected_actions {
            let error =
                MatrixBackend::ensure_room_is_encrypted("!plaintext:example.org", action, false)
                    .expect_err("unencrypted rooms must be rejected");
            let BackendError::NotEncrypted(message) = error else {
                panic!("encryption guard must return a typed not-encrypted error");
            };
            assert!(message.contains(action));
            assert!(message.contains("!plaintext:example.org"));
            assert!(message.contains("enable end-to-end encryption"));
            assert!(message.contains("leave and rejoin"));
        }
    }

    #[test]
    fn protected_room_guard_requires_joined_membership() {
        let error =
            MatrixBackend::ensure_room_is_joined("!invited:example.org", "reading messages", false)
                .expect_err("non-joined rooms must be rejected");
        let BackendError::PermissionDenied(message) = error else {
            panic!("membership guard must return a typed permission error");
        };
        assert!(message.contains("reading messages"));
        assert!(message.contains("!invited:example.org"));
        assert!(message.contains("not joined"));
    }

    #[test]
    fn direct_room_lookups_are_limited_to_guard_or_prejoin_paths() {
        let allowed = [
            "protected_joined_room",
            "room_for_cleanup_redaction",
            "matrix_room_is_encrypted",
            "knock_community",
            "join_community",
            "direct_room_lookups_are_limited_to_guard_or_prejoin_paths",
        ];
        let mut current_function = "";
        for (line_number, line) in include_str!("matrix.rs").lines().enumerate() {
            let trimmed = line.trim_start();
            if let Some(signature) = trimmed
                .strip_prefix("async fn ")
                .or_else(|| trimmed.strip_prefix("fn "))
            {
                current_function = signature.split('(').next().unwrap_or_default();
            }
            if line.contains(".get_room(") {
                assert!(
                    allowed.contains(&current_function),
                    "direct room lookup in {current_function} at line {}; use protected_joined_room",
                    line_number + 1
                );
            }
        }
    }

    #[test]
    fn managed_usernames_are_normalized_and_protocol_addresses_are_rejected() {
        assert_eq!(
            MatrixBackend::normalize_product_username("  Alice_Smith  ").unwrap(),
            "alice_smith"
        );
        assert!(MatrixBackend::normalize_product_username("@alice:example.org").is_err());
        assert!(MatrixBackend::normalize_product_username("two words").is_err());
        assert!(MatrixBackend::normalize_product_username("ab").is_err());
    }

    #[test]
    fn managed_configuration_fails_closed_and_qualifies_product_inputs_in_rust() {
        assert!(matches!(
            MatrixBackend::managed_homeserver_config_from(None, None),
            Err(BackendError::ManagedHomeserverUnconfigured)
        ));
        let managed = MatrixBackend::managed_homeserver_config_from(
            Some("https://matrix.example.org"),
            Some("example.org"),
        )
        .unwrap();
        assert_eq!(managed.homeserver, "https://matrix.example.org");
        assert_eq!(managed.server_name.as_str(), "example.org");
        assert_eq!(
            MatrixBackend::qualify_user_input("Alice", &managed)
                .unwrap()
                .as_str(),
            "@alice:example.org"
        );
        assert_eq!(
            MatrixBackend::qualify_user_input("@expert:elsewhere.org", &managed)
                .unwrap()
                .as_str(),
            "@expert:elsewhere.org"
        );
        assert_eq!(
            MatrixBackend::qualify_public_link_input("Garden-Club", &managed)
                .unwrap()
                .as_str(),
            "#garden-club:example.org"
        );
        assert_eq!(
            MatrixBackend::qualify_public_link_input("#raw:elsewhere.org", &managed)
                .unwrap()
                .as_str(),
            "#raw:elsewhere.org"
        );
    }

    #[test]
    fn registration_uiaa_only_auto_completes_dummy_and_classifies_terms() {
        let dummy = UiaaInfo::new(vec![uiaa::AuthFlow::new(vec![AuthType::Dummy])]);
        assert!(MatrixBackend::uiaa_can_complete_with_dummy(&dummy));

        let terms = UiaaInfo::new(vec![uiaa::AuthFlow::new(vec![AuthType::Terms])]);
        assert!(!MatrixBackend::uiaa_can_complete_with_dummy(&terms));
        assert!(MatrixBackend::uiaa_has_incomplete_stage(
            &terms,
            AuthType::Terms
        ));

        let recaptcha = UiaaInfo::new(vec![uiaa::AuthFlow::new(vec![AuthType::ReCaptcha])]);
        assert!(!MatrixBackend::uiaa_can_complete_with_dummy(&recaptcha));
    }

    #[test]
    fn homeserver_input_accepts_discovery_names_and_secure_urls() {
        assert_eq!(
            MatrixBackend::normalize_homeserver_input(" matrix.example.org ").unwrap(),
            "matrix.example.org"
        );
        assert_eq!(
            MatrixBackend::normalize_homeserver_input("https://matrix.example.org").unwrap(),
            "https://matrix.example.org"
        );
        assert_eq!(
            MatrixBackend::normalize_homeserver_input("http://127.0.0.1:8008").unwrap(),
            "http://127.0.0.1:8008"
        );
        assert_eq!(
            MatrixBackend::normalize_homeserver_input("localhost:8009").unwrap(),
            "http://localhost:8009"
        );
        assert_eq!(
            MatrixBackend::normalize_homeserver_input("[::1]:8010").unwrap(),
            "http://[::1]:8010"
        );
    }

    #[test]
    fn homeserver_input_rejects_insecure_remote_urls_and_embedded_credentials() {
        assert!(MatrixBackend::normalize_homeserver_input("http://matrix.example.org").is_err());
        let credentialed_url = ["https://alice:", "secret", "@matrix.example.org"].concat();
        assert!(MatrixBackend::normalize_homeserver_input(&credentialed_url).is_err());
    }

    #[test]
    fn production_account_removal_is_scoped_to_a_dedicated_matrix_directory() {
        let root = tempfile::tempdir().unwrap();
        let safe = MatrixBackend::new(root.path().join("matrix"));
        let safe_storage = safe.storage_for_profile("default");
        assert!(safe.validate_store_root_for_removal(&safe_storage).is_ok());

        let unsafe_backend = MatrixBackend::new(root.path().to_owned());
        let unsafe_storage = unsafe_backend.storage_for_profile("default");
        assert!(unsafe_backend
            .validate_store_root_for_removal(&unsafe_storage)
            .is_err());
    }

    #[test]
    fn production_accounts_use_stable_separate_store_and_key_namespaces() {
        let root = tempfile::tempdir().unwrap();
        let backend = MatrixBackend::new(root.path().join("matrix"));
        let alice_id = MatrixBackend::profile_id("matrix.example.org", "@alice:example.org");
        let bob_id = MatrixBackend::profile_id("matrix.example.org", "@bob:example.org");
        let alice = backend.storage_for_profile(&alice_id);
        let bob = backend.storage_for_profile(&bob_id);

        assert_ne!(alice.profile_id, bob.profile_id);
        assert_ne!(alice.store_root, bob.store_root);
        assert_ne!(
            MatrixBackend::session_key(&alice),
            MatrixBackend::session_key(&bob)
        );
        assert_ne!(
            MatrixBackend::trusted_devices_key(&alice),
            MatrixBackend::trusted_devices_key(&bob)
        );
        assert_ne!(
            MatrixBackend::recovery_test_key(&alice),
            MatrixBackend::recovery_test_key(&bob)
        );
        assert!(alice
            .store_root
            .starts_with(root.path().join("matrix").join("accounts")));
        assert_eq!(
            alice_id,
            MatrixBackend::profile_id("MATRIX.EXAMPLE.ORG", "@ALICE:EXAMPLE.ORG")
        );
        assert_eq!(
            alice_id,
            MatrixBackend::profile_id("matrix.example.org", "alice")
        );
    }

    #[test]
    fn local_account_removal_erases_every_account_artifact_and_preserves_other_accounts() {
        use std::cell::RefCell;

        let root = tempfile::tempdir().unwrap();
        let backend = MatrixBackend::new(root.path().join("matrix"));
        let target_profile = format!("wipe-target-{}", uuid::Uuid::new_v4());
        let other_profile = format!("wipe-keep-{}", uuid::Uuid::new_v4());
        let target = backend.storage_for_profile(&target_profile);
        let other = backend.storage_for_profile(&other_profile);

        std::fs::create_dir_all(target.store_root.join("media-cache")).unwrap();
        std::fs::create_dir_all(target.store_root.join("local-search")).unwrap();
        std::fs::write(
            target.store_root.join("matrix-sdk-crypto.sqlite3"),
            b"encrypted SDK store",
        )
        .unwrap();
        std::fs::write(
            target.store_root.join("media-cache").join("decrypted-file"),
            b"cached plaintext",
        )
        .unwrap();
        std::fs::write(
            target
                .store_root
                .join("local-search")
                .join("decrypted-index"),
            b"search data",
        )
        .unwrap();
        std::fs::create_dir_all(&other.store_root).unwrap();
        std::fs::write(other.store_root.join("keep"), b"other account").unwrap();

        let plan = backend.local_account_removal_plan(&target).unwrap();
        let target_keys = plan.key_names.clone();
        let other_keys = [
            MatrixBackend::session_key(&other),
            MatrixBackend::store_passphrase_key(&other),
            MatrixBackend::trusted_devices_key(&other),
            MatrixBackend::recovery_test_key(&other),
        ];
        let secrets = RefCell::new(
            target_keys
                .iter()
                .chain(other_keys.iter())
                .cloned()
                .collect::<HashSet<_>>(),
        );

        MatrixBackend::erase_local_account_artifacts_with(
            &plan,
            |key| Ok(secrets.borrow().contains(key)),
            |key| {
                secrets.borrow_mut().remove(key);
                Ok(())
            },
        )
        .unwrap();

        assert!(!target.store_root.exists());
        assert_eq!(
            std::fs::read(other.store_root.join("keep")).unwrap(),
            b"other account"
        );
        for key in target_keys {
            assert!(!secrets.borrow().contains(&key));
        }
        for key in other_keys {
            assert!(secrets.borrow().contains(&key));
        }

        let mut registry = AccountRegistry {
            active_profile_id: Some(target_profile.clone()),
            accounts: vec![
                SavedAccount {
                    profile_id: target_profile.clone(),
                    user_id: "@target:example.org".into(),
                    homeserver: "https://example.org".into(),
                    device_id: "TARGET".into(),
                    last_used_at: "2026-07-24T00:00:00Z".into(),
                },
                SavedAccount {
                    profile_id: other_profile.clone(),
                    user_id: "@other:example.org".into(),
                    homeserver: "https://example.org".into(),
                    device_id: "OTHER".into(),
                    last_used_at: "2026-07-23T00:00:00Z".into(),
                },
            ],
        };
        MatrixBackend::remove_account_from_registry(&mut registry, &target_profile);
        assert_eq!(registry.active_profile_id, None);
        assert_eq!(registry.accounts.len(), 1);
        assert_eq!(registry.accounts[0].profile_id, other_profile);
    }

    #[test]
    fn local_account_removal_fails_closed_when_keychain_erasure_cannot_be_verified() {
        let root = tempfile::tempdir().unwrap();
        let backend = MatrixBackend::new(root.path().join("matrix"));
        let storage = backend.storage_for_profile("verification-failure");
        std::fs::create_dir_all(&storage.store_root).unwrap();
        let plan = backend.local_account_removal_plan(&storage).unwrap();

        let error = MatrixBackend::erase_local_account_artifacts_with(
            &plan,
            |key| Ok(key == plan.key_names[0]),
            |_key| Ok(()),
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("remained after local account cleanup"));
    }

    #[test]
    fn projects_standard_edits_reactions_redactions_and_replies() {
        let members = HashMap::from([
            ("@alice:example.org".into(), "Alice".into()),
            ("@bob:example.org".into(), "Bob".into()),
        ]);
        let events = vec![
            json!({
                "type": "m.room.message",
                "event_id": "$one",
                "sender": "@alice:example.org",
                "origin_server_ts": 1,
                "content": { "msgtype": "m.text", "body": "original" }
            }),
            json!({
                "type": "m.room.message",
                "event_id": "$edit",
                "sender": "@alice:example.org",
                "origin_server_ts": 2,
                "content": {
                    "msgtype": "m.text",
                    "body": "* edited",
                    "m.new_content": { "msgtype": "m.text", "body": "edited" },
                    "m.relates_to": { "rel_type": "m.replace", "event_id": "$one" }
                }
            }),
            json!({
                "type": "m.reaction",
                "event_id": "$reaction-one",
                "sender": "@bob:example.org",
                "origin_server_ts": 3,
                "content": { "m.relates_to": { "rel_type": "m.annotation", "event_id": "$one", "key": "thumbsup" } }
            }),
            json!({
                "type": "m.room.message",
                "event_id": "$reply",
                "sender": "@bob:example.org",
                "origin_server_ts": 4,
                "content": {
                    "msgtype": "m.text",
                    "body": "> <@alice:example.org> edited\n\nreply body",
                    "m.relates_to": { "m.in_reply_to": { "event_id": "$one" } }
                }
            }),
            json!({
                "type": "m.room.redaction",
                "event_id": "$redact-reaction",
                "sender": "@bob:example.org",
                "origin_server_ts": 5,
                "redacts": "$reaction-one",
                "content": {}
            }),
            json!({
                "type": "m.room.redaction",
                "event_id": "$redact-message",
                "sender": "@alice:example.org",
                "origin_server_ts": 6,
                "content": { "redacts": "$one" }
            }),
        ];

        let projected = MatrixBackend::project_timeline("!room:example.org", &members, events);
        assert_eq!(projected.len(), 2);
        assert_eq!(projected[0].id, "$one");
        assert_eq!(projected[0].content, "");
        assert!(projected[0].edited_at.is_some());
        assert!(projected[0].deleted_at.is_some());
        assert!(projected[0].reactions.is_empty());
        assert_eq!(projected[1].content, "reply body");
        assert_eq!(projected[1].reply_to_id.as_deref(), Some("$one"));
    }

    #[test]
    fn ignores_replacements_from_a_different_sender() {
        let members = HashMap::new();
        let events = vec![
            json!({
                "type": "m.room.message",
                "event_id": "$one",
                "sender": "@alice:example.org",
                "origin_server_ts": 1,
                "content": { "msgtype": "m.text", "body": "original" }
            }),
            json!({
                "type": "m.room.message",
                "event_id": "$bad-edit",
                "sender": "@mallory:example.org",
                "origin_server_ts": 2,
                "content": {
                    "msgtype": "m.text",
                    "body": "* forged",
                    "m.new_content": { "msgtype": "m.text", "body": "forged" },
                    "m.relates_to": { "rel_type": "m.replace", "event_id": "$one" }
                }
            }),
        ];

        let projected = MatrixBackend::project_timeline("!room:example.org", &members, events);
        assert_eq!(projected[0].content, "original");
        assert!(projected[0].edited_at.is_none());
    }

    #[test]
    fn projects_only_the_approved_legacy_message_variant_with_original_provenance() {
        let events = vec![
            json!({
                "type": crate::backend::LEGACY_MATRIX_EVENT_TYPE,
                "event_id": "$selected",
                "sender": "@importer:example.org",
                "origin_server_ts": 200,
                "content": {
                    "conflictStatus": "approved_selected",
                    "record": {
                        "kind": "message",
                        "entityId": "legacy-message",
                        "recordSha256": "selected-hash",
                        "originalTimestamp": "2020-01-02T03:04:05Z",
                        "originalSignature": "legacy-signature",
                        "payload": {
                            "authorPublicKey": "legacy-author",
                            "authorDisplayName": "Legacy Alice",
                            "authorAvatarColor": "#123456",
                            "content": "selected history",
                            "attachments": [],
                            "reactions": {}
                        }
                    }
                }
            }),
            json!({
                "type": crate::backend::LEGACY_MATRIX_EVENT_TYPE,
                "event_id": "$non-selected",
                "sender": "@importer:example.org",
                "origin_server_ts": 201,
                "content": {
                    "conflictStatus": "approved_non_selected_variant",
                    "record": {
                        "kind": "message",
                        "entityId": "legacy-message",
                        "recordSha256": "other-hash",
                        "payload": { "content": "other history" }
                    }
                }
            }),
        ];

        let projected =
            MatrixBackend::project_timeline("!room:example.org", &HashMap::new(), events);
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].id, "legacy:legacy-message");
        assert_eq!(projected[0].content, "selected history");
        assert_eq!(projected[0].author_public_key, "legacy-author");
        assert_eq!(projected[0].timestamp, "2020-01-02T03:04:05Z");
        assert_eq!(projected[0].signature, "legacy-signature");
        assert_eq!(projected[0].delivery_status.as_deref(), Some("imported"));
    }

    #[test]
    fn encrypted_attachment_ciphertext_tampering_is_rejected() {
        use matrix_sdk_crypto::{AttachmentDecryptor, AttachmentEncryptor};
        use std::io::{Cursor, Read};

        let plaintext = b"mesh encrypted attachment";
        let mut input = Cursor::new(plaintext.to_vec());
        let mut encryptor = AttachmentEncryptor::new(&mut input);
        let mut ciphertext = Vec::new();
        encryptor.read_to_end(&mut ciphertext).unwrap();
        let encryption_info = encryptor.finish();

        ciphertext[0] ^= 0x01;
        let mut tampered = Cursor::new(ciphertext);
        let mut decryptor = AttachmentDecryptor::new(&mut tampered, encryption_info).unwrap();
        let mut decrypted = Vec::new();
        assert!(decryptor.read_to_end(&mut decrypted).is_err());
    }

    #[test]
    fn encrypted_matrix_attachment_projection_requires_encrypted_file_metadata() {
        let encrypted = json!({
            "msgtype": "m.file",
            "body": "Quarterly report",
            "filename": "report.pdf",
            "file": {
                "url": "mxc://example.org/media",
                "key": { "kty": "oct", "alg": "A256CTR", "ext": true, "k": "TLlG_OpX807zzQuuwv4QZGJ21_u7weemFGYJFszMn9A", "key_ops": ["encrypt", "decrypt"] },
                "iv": "S22dq3NAX8wAAAAAAAAAAA",
                "hashes": { "sha256": "aWOHudBnDkJ9IwaR1Nd8XKoI7DOrqDTwt6xDPfVGN6Q" },
                "v": "v2"
            },
            "info": {
                "size": 42,
                "mimetype": "application/pdf",
                "thumbnail_file": {
                    "url": "mxc://example.org/thumbnail",
                    "key": { "kty": "oct", "alg": "A256CTR", "ext": true, "k": "TLlG_OpX807zzQuuwv4QZGJ21_u7weemFGYJFszMn9A", "key_ops": ["encrypt", "decrypt"] },
                    "iv": "S22dq3NAX8wAAAAAAAAAAA",
                    "hashes": { "sha256": "aWOHudBnDkJ9IwaR1Nd8XKoI7DOrqDTwt6xDPfVGN6Q" },
                    "v": "v2"
                },
                "thumbnail_info": {
                    "w": 320,
                    "h": 180,
                    "size": 12000,
                    "mimetype": "image/png"
                }
            }
        });
        let resolved = MatrixBackend::resolved_matrix_attachment_from_content(&encrypted).unwrap();
        assert_eq!(
            resolved.encrypted_file.url.as_str(),
            "mxc://example.org/media"
        );
        assert!(resolved.thumbnail.is_some());
        let attachment = resolved.metadata;
        assert_eq!(attachment.filename, "report.pdf");
        assert_eq!(attachment.size, 42);
        assert_eq!(
            attachment.file_hash,
            "matrix-sha256:aWOHudBnDkJ9IwaR1Nd8XKoI7DOrqDTwt6xDPfVGN6Q"
        );
        assert_eq!(attachment.content_type.as_deref(), Some("application/pdf"));
        let thumbnail = attachment.thumbnail.unwrap();
        assert_eq!(thumbnail.width, 320);
        assert_eq!(thumbnail.height, 180);
        assert_eq!(
            thumbnail.file_hash,
            "matrix-sha256:aWOHudBnDkJ9IwaR1Nd8XKoI7DOrqDTwt6xDPfVGN6Q"
        );

        let plain = json!({
            "msgtype": "m.file",
            "body": "report.pdf",
            "url": "mxc://example.org/media"
        });
        assert!(MatrixBackend::matrix_attachment_from_content(&plain).is_none());
    }

    #[test]
    fn attachment_download_metadata_is_resolved_from_the_requested_event() {
        let event = json!({
            "type": "m.room.message",
            "event_id": "$file",
            "sender": "@alice:example.org",
            "origin_server_ts": 10,
            "content": {
                "msgtype": "m.file",
                "body": "Quarterly report",
                "filename": "report.pdf",
                "file": {
                    "url": "mxc://example.org/media",
                    "key": { "kty": "oct", "alg": "A256CTR", "ext": true, "k": "TLlG_OpX807zzQuuwv4QZGJ21_u7weemFGYJFszMn9A", "key_ops": ["encrypt", "decrypt"] },
                    "iv": "S22dq3NAX8wAAAAAAAAAAA",
                    "hashes": { "sha256": "aWOHudBnDkJ9IwaR1Nd8XKoI7DOrqDTwt6xDPfVGN6Q" },
                    "v": "v2"
                },
                "info": { "size": 42, "mimetype": "application/pdf" }
            }
        });

        let attachment = MatrixBackend::matrix_attachment_from_event(&event, 0).unwrap();
        assert_eq!(
            attachment.file_hash,
            "matrix-sha256:aWOHudBnDkJ9IwaR1Nd8XKoI7DOrqDTwt6xDPfVGN6Q"
        );
        assert_eq!(attachment.filename, "report.pdf");
        assert!(MatrixBackend::matrix_attachment_from_event(&event, 1).is_err());

        let mut redacted = event.clone();
        redacted["unsigned"] = json!({ "redacted_because": {} });
        assert!(MatrixBackend::matrix_attachment_from_event(&redacted, 0).is_err());

        let mut plaintext = event;
        plaintext["content"].as_object_mut().unwrap().remove("file");
        plaintext["content"]["url"] = json!("mxc://example.org/plain");
        assert!(MatrixBackend::matrix_attachment_from_event(&plaintext, 0).is_err());
    }

    #[test]
    fn encrypted_attachment_projection_ignores_plain_or_oversized_thumbnails() {
        let base = json!({
            "msgtype": "m.file",
            "body": "report.pdf",
            "file": {
                "url": "mxc://example.org/media",
                "key": { "kty": "oct", "alg": "A256CTR", "ext": true, "k": "TLlG_OpX807zzQuuwv4QZGJ21_u7weemFGYJFszMn9A", "key_ops": ["encrypt", "decrypt"] },
                "iv": "S22dq3NAX8wAAAAAAAAAAA",
                "hashes": { "sha256": "aWOHudBnDkJ9IwaR1Nd8XKoI7DOrqDTwt6xDPfVGN6Q" },
                "v": "v2"
            },
            "info": {
                "size": 42,
                "mimetype": "application/pdf",
                "thumbnail_url": "mxc://example.org/plain-thumbnail",
                "thumbnail_info": {
                    "w": 320,
                    "h": 180,
                    "size": 12000,
                    "mimetype": "image/png"
                }
            }
        });
        assert!(MatrixBackend::matrix_attachment_from_content(&base)
            .unwrap()
            .thumbnail
            .is_none());

        let mut oversized = base;
        oversized["info"]["thumbnail_url"] = serde_json::Value::Null;
        oversized["info"]["thumbnail_file"] = json!({
            "url": "mxc://example.org/encrypted-thumbnail",
            "hashes": { "sha256": "thumbnail-hash" }
        });
        oversized["info"]["thumbnail_info"]["w"] = json!(513);
        assert!(MatrixBackend::matrix_attachment_from_content(&oversized)
            .unwrap()
            .thumbnail
            .is_none());
    }

    #[test]
    fn projects_encrypted_file_messages_with_attachment_metadata() {
        let events = vec![json!({
            "type": "m.room.message",
            "event_id": "$file",
            "sender": "@alice:example.org",
            "origin_server_ts": 10,
            "content": {
                "msgtype": "m.file",
                "body": "Quarterly report",
                "filename": "report.pdf",
                "file": {
                    "url": "mxc://example.org/media",
                    "key": { "kty": "oct", "alg": "A256CTR", "ext": true, "k": "TLlG_OpX807zzQuuwv4QZGJ21_u7weemFGYJFszMn9A", "key_ops": ["encrypt", "decrypt"] },
                    "iv": "S22dq3NAX8wAAAAAAAAAAA",
                    "hashes": { "sha256": "aWOHudBnDkJ9IwaR1Nd8XKoI7DOrqDTwt6xDPfVGN6Q" },
                    "v": "v2"
                },
                "info": { "size": 42, "mimetype": "application/pdf" }
            }
        })];
        let projected =
            MatrixBackend::project_timeline("!room:example.org", &HashMap::new(), events);
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].content, "Quarterly report");
        assert_eq!(projected[0].attachments.len(), 1);
        assert_eq!(projected[0].attachments[0].filename, "report.pdf");
    }

    #[test]
    fn direct_message_projection_reuses_matrix_message_and_attachment_fields() {
        let message = MessageDto {
            id: "$dm".into(),
            channel_id: "!dm:example.org".into(),
            author_public_key: "@alice:example.org".into(),
            author_display_name: "Alice".into(),
            author_avatar_color: "#123456".into(),
            content: "hello".into(),
            attachments: vec![AttachmentDto {
                file_hash: "matrix-sha256:hash".into(),
                filename: "note.txt".into(),
                size: 5,
                chunks: 1,
                source_peer_id: "matrix:mxc://example.org/note".into(),
                content_type: Some("text/plain".into()),
                thumbnail: None,
            }],
            reactions: HashMap::from([("like".into(), vec!["@alice:example.org".into()])]),
            timestamp: "2026-07-23T00:00:00Z".into(),
            signature: String::new(),
            edited_at: None,
            deleted_at: None,
            reply_to_id: Some("$root".into()),
            delivery_status: Some("sent".into()),
        };
        let projected = MatrixBackend::direct_message_from_message(message);
        assert_eq!(projected.conversation_id, "!dm:example.org");
        assert_eq!(projected.reply_to_id.as_deref(), Some("$root"));
        assert_eq!(projected.attachments[0].filename, "note.txt");
        assert_eq!(projected.reactions["like"], vec!["@alice:example.org"]);
    }

    #[test]
    fn matrix_media_filename_policy_rejects_executable_names() {
        assert_eq!(
            MatrixBackend::safe_media_filename("../quarterly-report.pdf").unwrap(),
            "quarterly-report.pdf"
        );
        assert!(MatrixBackend::safe_media_filename("payload.EXE").is_err());
        assert!(MatrixBackend::safe_media_filename("scripts/run.ps1").is_err());
        assert_eq!(
            MatrixBackend::safe_media_filename(" ").unwrap(),
            "attachment.bin"
        );
    }

    #[test]
    fn matrix_message_transaction_ids_are_bounded_and_retry_safe() {
        let first_attempt = "pending-123-abc";
        let retry_id = MatrixBackend::validate_transaction_id(first_attempt).unwrap();
        let same_retry_id: OwnedTransactionId = first_attempt.to_owned().into();
        assert_eq!(retry_id, same_retry_id);
        assert!(MatrixBackend::validate_transaction_id("").is_err());
        assert!(MatrixBackend::validate_transaction_id("contains whitespace").is_err());
        assert!(MatrixBackend::validate_transaction_id("contains\nnewline").is_err());
        assert!(MatrixBackend::validate_transaction_id(&"x".repeat(256)).is_err());
    }

    #[test]
    fn matrix_media_payload_sniffing_rejects_executable_headers_and_mimes() {
        assert!(MatrixBackend::validate_media_payload(b"MZ\x90\0", None, "report.pdf").is_err());
        assert!(MatrixBackend::validate_media_payload(
            b"#!/bin/sh\necho unsafe",
            Some("application/x-shellscript"),
            "notes.txt"
        )
        .is_err());
        assert!(MatrixBackend::validate_media_payload(
            b"%PDF-1.7\n",
            Some("application/pdf"),
            "report.pdf"
        )
        .is_ok());
    }

    /// Never stops yielding bytes, and fails the test if the download asks for
    /// more once the cap has already been crossed.
    struct EndlessMediaStream {
        chunk_size: usize,
        cap: u64,
        served: u64,
    }

    #[async_trait]
    impl MediaChunkSource for EndlessMediaStream {
        async fn next_chunk(&mut self) -> BackendResult<Option<Vec<u8>>> {
            assert!(
                self.served <= self.cap,
                "download kept pulling bytes after the cap was already exceeded"
            );
            self.served = self.served.saturating_add(self.chunk_size as u64);
            Ok(Some(vec![0_u8; self.chunk_size]))
        }
    }

    struct ScriptedMediaStream(VecDeque<Vec<u8>>);

    #[async_trait]
    impl MediaChunkSource for ScriptedMediaStream {
        async fn next_chunk(&mut self) -> BackendResult<Option<Vec<u8>>> {
            Ok(self.0.pop_front())
        }
    }

    #[tokio::test]
    async fn matrix_attachment_download_aborts_mid_transfer_when_real_bytes_exceed_the_cap() {
        const CAP: u64 = 64 * 1024;
        const CHUNK: usize = 4096;

        // The crafted event claims a tiny payload, so the pre-flight metadata
        // check passes while the real stream never ends.
        assert!(MatrixBackend::validate_attachment_size(16).is_ok());

        let mut stream = EndlessMediaStream {
            chunk_size: CHUNK,
            cap: CAP,
            served: 0,
        };
        let error = MatrixBackend::collect_bounded_media(&mut stream, CAP, None, &mut |_| {})
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            BackendError::InvalidConfiguration(message) if message.contains("100 MB")
        ));
        assert_eq!(stream.served, CAP + CHUNK as u64);
    }

    #[tokio::test]
    async fn matrix_attachment_download_accepts_streams_up_to_the_cap() {
        let mut stream =
            ScriptedMediaStream(VecDeque::from(vec![b"mesh".to_vec(), b"-media".to_vec()]));
        let mut reported = Vec::new();
        let data = MatrixBackend::collect_bounded_media(&mut stream, 10, None, &mut |received| {
            reported.push(received);
        })
        .await
        .unwrap();

        assert_eq!(data, b"mesh-media");
        assert_eq!(reported, vec![10]);

        let mut stream = ScriptedMediaStream(VecDeque::from(vec![b"mesh-media!".to_vec()]));
        assert!(
            MatrixBackend::collect_bounded_media(&mut stream, 10, None, &mut |_| {})
                .await
                .is_err()
        );
    }

    #[test]
    fn matrix_media_download_endpoint_prefers_authenticated_media() {
        let url = matrix_sdk::ruma::OwnedMxcUri::from("mxc://example.org/abc123");

        let authenticated = SupportedVersions::from_parts(
            &["v1.11".to_owned()],
            &std::collections::BTreeMap::new(),
        );
        let (endpoint, headers) = MatrixBackend::media_download_endpoint(
            "https://matrix.example.org/",
            Some("secret-token"),
            &authenticated,
            &url,
        )
        .unwrap();
        assert!(endpoint.starts_with(
            "https://matrix.example.org/_matrix/client/v1/media/download/example.org/abc123"
        ));
        assert_eq!(headers["authorization"], "Bearer secret-token");

        let legacy =
            SupportedVersions::from_parts(&["v1.1".to_owned()], &std::collections::BTreeMap::new());
        let (endpoint, headers) = MatrixBackend::media_download_endpoint(
            "https://matrix.example.org/",
            Some("secret-token"),
            &legacy,
            &url,
        )
        .unwrap();
        assert!(endpoint.contains("/_matrix/media/v3/download/example.org/abc123"));
        assert!(!headers.contains_key("authorization"));
    }

    #[test]
    fn matrix_attachment_size_limit_is_fail_closed() {
        assert!(MatrixBackend::validate_attachment_size(0).is_ok());
        assert!(MatrixBackend::validate_attachment_size(MAX_ATTACHMENT_BYTES).is_ok());
        let error = MatrixBackend::validate_attachment_size(MAX_ATTACHMENT_BYTES + 1).unwrap_err();
        assert!(matches!(
            error,
            BackendError::InvalidConfiguration(message) if message.contains("100 MB")
        ));
    }

    #[test]
    fn matrix_thumbnail_generation_is_bounded_and_reencodes_to_png() {
        let source = image::DynamicImage::new_rgb8(1024, 512);
        let mut encoded = Cursor::new(Vec::new());
        source
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        let encoded = encoded.into_inner();

        let thumbnail = MatrixBackend::generate_sanitized_thumbnail(&encoded, "image/png")
            .unwrap()
            .unwrap();
        assert_eq!((thumbnail.width, thumbnail.height), (512, 256));
        assert!(thumbnail.bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(thumbnail.bytes.len() <= MAX_THUMBNAIL_BYTES);
        assert!(
            MatrixBackend::generate_sanitized_thumbnail(&encoded, "image/webp").is_err(),
            "declared MIME and decoder format must agree"
        );
        assert!(
            MatrixBackend::generate_sanitized_thumbnail(b"<svg/>", "image/svg+xml")
                .unwrap()
                .is_none(),
            "active vector content must never enter thumbnail decoding"
        );
    }

    #[test]
    fn inline_thumbnail_sanitization_requires_exact_protected_metadata() {
        let source = image::DynamicImage::new_rgb8(64, 32);
        let mut encoded = Cursor::new(Vec::new());
        source
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        let encoded = encoded.into_inner();
        let metadata = AttachmentThumbnailDto {
            file_hash: "matrix-sha256:protected-thumbnail".into(),
            size: encoded.len() as u64,
            width: 64,
            height: 32,
            content_type: "image/png".into(),
        };

        let sanitized = MatrixBackend::sanitize_inline_thumbnail(&encoded, &metadata).unwrap();
        assert!(sanitized.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(sanitized.len() <= MAX_THUMBNAIL_BYTES);

        let mut wrong_size = metadata.clone();
        wrong_size.size += 1;
        assert!(MatrixBackend::sanitize_inline_thumbnail(&encoded, &wrong_size).is_err());

        let mut wrong_dimensions = metadata;
        wrong_dimensions.width += 1;
        assert!(MatrixBackend::sanitize_inline_thumbnail(&encoded, &wrong_dimensions).is_err());

        let oversized_source = image::DynamicImage::new_rgb8(1024, 512);
        let mut oversized = Cursor::new(Vec::new());
        oversized_source
            .write_to(&mut oversized, image::ImageFormat::Png)
            .unwrap();
        let oversized = oversized.into_inner();
        let forged_metadata = AttachmentThumbnailDto {
            file_hash: "matrix-sha256:forged-thumbnail".into(),
            size: oversized.len() as u64,
            width: 512,
            height: 256,
            content_type: "image/png".into(),
        };
        assert!(
            MatrixBackend::sanitize_inline_thumbnail(&oversized, &forged_metadata).is_err(),
            "received previews must never be resized into matching forged metadata"
        );
    }

    #[tokio::test]
    async fn inline_thumbnail_scheduler_caps_concurrent_work() {
        let backend = MatrixBackend::with_profile(
            std::env::temp_dir().join("mesh-thumbnail-scheduler-test"),
            "thumbnail-scheduler",
        );
        assert_eq!(
            backend.thumbnail_loads.available_permits(),
            MAX_CONCURRENT_THUMBNAIL_LOADS
        );
        let permits = backend
            .thumbnail_loads
            .acquire_many(MAX_CONCURRENT_THUMBNAIL_LOADS as u32)
            .await
            .unwrap();
        assert!(backend.thumbnail_loads.try_acquire().is_err());
        drop(permits);
        assert_eq!(
            backend.thumbnail_loads.available_permits(),
            MAX_CONCURRENT_THUMBNAIL_LOADS
        );
    }

    #[test]
    fn matrix_dm_duplicate_resolution_is_deterministic_and_non_destructive() {
        let rooms = vec![
            matrix_sdk::ruma::RoomId::parse("!zeta:example.org").unwrap(),
            matrix_sdk::ruma::RoomId::parse("!alpha:example.org").unwrap(),
        ];
        let canonical = MatrixBackend::canonical_direct_room_id(rooms).unwrap();
        assert_eq!(canonical.as_str(), "!alpha:example.org");
    }

    #[test]
    fn matrix_dm_account_data_merge_preserves_every_observed_mapping() {
        let mut local: DirectEventContent = serde_json::from_value(json!({
            "@alice:example.org": [
                "!local:example.org",
                "!shared:example.org"
            ],
            "@carol:example.org": ["!carol:example.org"]
        }))
        .unwrap();
        let remote: DirectEventContent = serde_json::from_value(json!({
            "@alice:example.org": [
                "!remote:example.org",
                "!shared:example.org"
            ],
            "@bob:example.org": ["!bob:example.org"]
        }))
        .unwrap();

        assert!(MatrixBackend::merge_direct_content_preserving_mappings(
            &mut local, &remote
        ));
        assert!(MatrixBackend::direct_content_preserves(&local, &remote));
        assert!(!MatrixBackend::merge_direct_content_preserving_mappings(
            &mut local, &remote
        ));

        let serialized = serde_json::to_value(local).unwrap();
        assert_eq!(
            serialized["@alice:example.org"],
            json!([
                "!local:example.org",
                "!shared:example.org",
                "!remote:example.org"
            ])
        );
        assert_eq!(serialized["@bob:example.org"], json!(["!bob:example.org"]));
        assert_eq!(
            serialized["@carol:example.org"],
            json!(["!carol:example.org"])
        );
    }

    #[test]
    fn matrix_dm_account_data_compare_detects_and_repairs_lost_concurrent_rooms() {
        let required: DirectEventContent = serde_json::from_value(json!({
            "@alice:example.org": [
                "!first:example.org",
                "!concurrent:example.org"
            ],
            "@bob:example.org": ["!bob:example.org"]
        }))
        .unwrap();
        let mut overwritten: DirectEventContent = serde_json::from_value(json!({
            "@alice:example.org": ["!first:example.org"]
        }))
        .unwrap();

        assert!(!MatrixBackend::direct_content_preserves(
            &overwritten,
            &required
        ));
        assert!(MatrixBackend::merge_direct_content_preserving_mappings(
            &mut overwritten,
            &required
        ));
        assert!(MatrixBackend::direct_content_preserves(
            &overwritten,
            &required
        ));
    }

    #[tokio::test]
    async fn matrix_media_cache_evicts_old_entries_without_deleting_new_download() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old.bin");
        let new = root.path().join("new.bin");
        tokio::fs::write(&old, b"old").await.unwrap();
        tokio::fs::write(&new, b"new").await.unwrap();

        MatrixBackend::enforce_media_cache_quota_with_limit(root.path(), &new, 3)
            .await
            .unwrap();

        assert!(!old.exists());
        assert_eq!(tokio::fs::read(&new).await.unwrap(), b"new");
    }

    #[tokio::test]
    async fn matrix_attachment_cancellation_is_idempotent_and_signals_active_download() {
        let backend = MatrixBackend::new(tempfile::tempdir().unwrap().path().to_owned());
        let cancellation = CancellationToken::new();
        backend
            .media_downloads
            .lock()
            .await
            .insert("matrix-sha256:test".into(), cancellation.clone());

        backend
            .cancel_attachment_download("matrix-sha256:test".into())
            .await
            .unwrap();
        backend
            .cancel_attachment_download("matrix-sha256:test".into())
            .await
            .unwrap();
        assert!(cancellation.is_cancelled());
        assert!(backend
            .media_downloads
            .lock()
            .await
            .contains_key("matrix-sha256:test"));
    }

    #[tokio::test]
    async fn matrix_attachment_upload_cancellation_is_idempotent_and_uuid_scoped() {
        let backend = MatrixBackend::new(tempfile::tempdir().unwrap().path().to_owned());
        let transfer_id = uuid::Uuid::new_v4().to_string();
        let cancellation = CancellationToken::new();
        backend
            .media_uploads
            .lock()
            .await
            .insert(transfer_id.clone(), cancellation.clone());

        backend
            .cancel_attachment_upload(transfer_id.clone())
            .await
            .unwrap();
        backend.cancel_attachment_upload(transfer_id).await.unwrap();
        assert!(cancellation.is_cancelled());
        assert_eq!(backend.media_uploads.lock().await.len(), 1);
        assert!(backend
            .cancel_attachment_upload("not-a-transfer-id".into())
            .await
            .is_err());
    }

    #[test]
    fn matrix_transfer_failure_is_typed_as_restart_from_zero() {
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = events.clone();
        let progress: MatrixTransferProgressCallback = Arc::new(move |event| {
            captured.lock().unwrap().push(event);
        });
        let transfer_id = uuid::Uuid::new_v4().to_string();

        MatrixBackend::emit_transfer_progress(
            &progress,
            &transfer_id,
            MatrixTransferDirection::Download,
            17,
            Some(100),
            MatrixTransferState::Failed,
            None,
        );

        let event = events.lock().unwrap().pop().unwrap();
        assert_eq!(event.transferred_bytes, 17);
        assert!(event.retryable);
        assert_eq!(
            event.retry_mode,
            Some(MatrixTransferRetryMode::RestartFromZero)
        );
        let serialized = serde_json::to_value(event).unwrap();
        assert_eq!(serialized["state"], "failed");
        assert_eq!(serialized["retryMode"], "restart-from-zero");
        assert_eq!(serialized["totalBytes"], 100);
    }
}
