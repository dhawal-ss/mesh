use std::{
    collections::{HashMap, HashSet},
    io::Cursor,
    path::{Component, Path, PathBuf},
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime},
};

use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use matrix_sdk::{
    authentication::{
        matrix::MatrixSession,
        oauth::{ClientId, OAuthSession, UrlOrQuery, UserSession},
        AuthApi, AuthSession,
    },
    config::SyncSettings,
    encryption::{
        backups::BackupState,
        recovery::RecoveryState,
        verification::{
            QrVerification, QrVerificationState, SasState, SasVerification, Verification,
            VerificationRequest, VerificationRequestState,
        },
        BackupDownloadStrategy, EncryptionSettings,
    },
    media::{MediaFormat, MediaRequestParameters},
    room::{
        reply::{EnforceThread, Reply},
        MessagesOptions, RoomMemberRole,
    },
    ruma::{
        api::client::{
            directory::get_public_rooms_filtered,
            discovery::get_authorization_server_metadata::v1::{
                AuthorizationServerMetadata, CodeChallengeMethod, GrantType, ResponseMode,
                ResponseType,
            },
            receipt::create_receipt::v3::ReceiptType,
            room::{
                create_room::v3::{CreationContent, Request as CreateRoomRequest, RoomPreset},
                Visibility,
            },
            state::get_state_events,
            uiaa,
        },
        directory::{Filter, RoomTypeFilter},
        events::{
            direct::{DirectEventContent, DirectUserIdentifier},
            ignored_user_list::{IgnoredUser, IgnoredUserListEventContent},
            presence::PresenceEvent,
            reaction::ReactionEventContent,
            receipt::ReceiptThread,
            relation::Annotation,
            room::{
                encryption::RoomEncryptionEventContent,
                join_rules::JoinRule,
                message::{
                    FileInfo, FileMessageEventContent, MessageType, ReplacementMetadata,
                    RoomMessageEventContent, RoomMessageEventContentWithoutRelation,
                },
                EncryptedFile, MediaSource,
            },
            space::{child::SpaceChildEventContent, parent::SpaceParentEventContent},
            typing::SyncTypingEvent,
            AnyGlobalAccountDataEventContent, GlobalAccountDataEventType, InitialStateEvent,
        },
        int,
        room::RoomType,
        serde::Raw,
        EventEncryptionAlgorithm, OwnedDeviceId, OwnedRoomId, RoomAliasId, RoomOrAliasId,
        ServerName,
    },
    store::RoomLoadSettings,
    Client, Room, RoomMemberships, RoomState, SessionChange,
};
use qrcode::render::svg;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroize;

use crate::crypto::keychain;
use crate::types::{
    community::{ChannelDto, CommunityDto},
    dm::{DirectMessageDto, DmConversationDto},
    message::{AttachmentDto, MessageDto},
};

use super::{
    BackendError, BackendKind, BackendResult, BackendStatus, CommunityAccessResult,
    CommunityAccessSettings, CommunityApplication, CommunityDirectoryEntry, CommunityMember,
    CreatedCommunity, MatrixAccount, MatrixDevice, MatrixLogin, MatrixOidcAvailability,
    MatrixOidcStatus, MatrixProfile, MatrixRecoveryHealth, MatrixVerificationSession, MeshBackend,
    SentMessage, TypingUser, UserPreferences, VerificationEmoji,
};

mod oidc;

const SESSION_KEY: &str = "matrix-session-v1";
const STORE_PASSPHRASE_KEY: &str = "matrix-store-passphrase-v1";
const ACCOUNT_REGISTRY_KEY: &str = "matrix-account-registry-v1";
const TRUSTED_DEVICES_KEY: &str = "matrix-trusted-devices-v1";
const RECOVERY_TEST_KEY: &str = "matrix-recovery-test-v1";
const PREFERENCES_EVENT_TYPE: &str = "org.mesh.preferences.v1";
const LOGIN_TIMEOUT_SECONDS: u64 = 45;
const OIDC_REDIRECT_URI: &str = "http://127.0.0.1:8418/oauth/callback";
const OIDC_CLIENT_ID_ENV: &str = "MESH_OAUTH_CLIENT_ID";
const MAX_MEDIA_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const DIRECT_ACCOUNT_DATA_MERGE_ATTEMPTS: usize = 3;
const BLOCKED_MEDIA_EXTENSIONS: &[&str] = &[
    "bat", "cpl", "cmd", "com", "dll", "exe", "hta", "js", "jse", "lnk", "msi", "pif", "ps1",
    "reg", "scr", "sys", "url", "vbe", "vbs", "wasm", "wsf", "wsh",
];
const BLOCKED_MEDIA_CONTENT_TYPES: &[&str] = &[
    "application/x-msdownload",
    "application/x-msdos-program",
    "application/x-sh",
    "application/x-shellscript",
    "text/x-shellscript",
];

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
    sync_task: Option<JoinHandle<()>>,
    session_task: Option<JoinHandle<()>>,
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
    media_downloads: Mutex<HashMap<String, CancellationToken>>,
    typing_users: Arc<RwLock<HashMap<String, Vec<String>>>>,
    presence: Arc<RwLock<HashMap<String, String>>>,
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
            media_downloads: Mutex::new(HashMap::new()),
            typing_users: Arc::new(RwLock::new(HashMap::new())),
            presence: Arc::new(RwLock::new(HashMap::new())),
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
            media_downloads: Mutex::new(HashMap::new()),
            typing_users: Arc::new(RwLock::new(HashMap::new())),
            presence: Arc::new(RwLock::new(HashMap::new())),
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
        if !keychain::secret_exists(&key) {
            return Ok(TrustedDeviceRegistry::default());
        }
        let serialized = keychain::load_secret(&key).map_err(Self::map_error)?;
        serde_json::from_slice(&serialized).map_err(Self::map_error)
    }

    fn persist_trusted_devices(
        storage: &AccountStorage,
        devices: &TrustedDeviceRegistry,
    ) -> BackendResult<()> {
        let serialized = serde_json::to_vec(devices).map_err(Self::map_error)?;
        keychain::store_secret(&Self::trusted_devices_key(storage), &serialized)
            .map_err(Self::map_error)
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

    fn load_last_recovery_test(storage: &AccountStorage) -> Option<String> {
        let key = Self::recovery_test_key(storage);
        keychain::secret_exists(&key)
            .then(|| keychain::load_secret(&key).ok())
            .flatten()
            .and_then(|bytes| String::from_utf8(bytes).ok())
    }

    fn persist_last_recovery_test(storage: &AccountStorage, tested_at: &str) -> BackendResult<()> {
        keychain::store_secret(&Self::recovery_test_key(storage), tested_at.as_bytes())
            .map_err(Self::map_error)
    }

    fn account_registry_key(&self) -> String {
        if self.dynamic_accounts {
            ACCOUNT_REGISTRY_KEY.to_owned()
        } else {
            format!("{ACCOUNT_REGISTRY_KEY}-{}", self.profile_hint)
        }
    }

    fn load_registry(&self) -> BackendResult<AccountRegistry> {
        let key = self.account_registry_key();
        if !keychain::secret_exists(&key) {
            return Ok(AccountRegistry::default());
        }
        let serialized = keychain::load_secret(&key).map_err(Self::map_error)?;
        serde_json::from_slice(&serialized).map_err(Self::map_error)
    }

    fn persist_registry(&self, registry: &AccountRegistry) -> BackendResult<()> {
        let serialized = serde_json::to_vec(registry).map_err(Self::map_error)?;
        keychain::store_secret(&self.account_registry_key(), &serialized).map_err(Self::map_error)
    }

    fn register_account(
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
        let registry_exists = keychain::secret_exists(&self.account_registry_key());
        let registry = self.load_registry()?;
        match registry.active_profile_id.as_deref() {
            Some(profile_id) => Ok(self.storage_for_profile(profile_id)),
            None if registry_exists => Err(BackendError::NotAuthenticated),
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
        BackendError::Other(error.to_string())
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

        Err(BackendError::InvalidConfiguration(format!(
            "Mesh blocked {action} in unencrypted Matrix room {room_id}. Ask a community \
             administrator to enable end-to-end encryption, then leave and rejoin the room"
        )))
    }

    async fn require_encrypted_room(room: &Room, action: &str) -> BackendResult<()> {
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

    fn matrix_attachment_from_content(content: &serde_json::Value) -> Option<AttachmentDto> {
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
        let source = content.get("file")?.clone();
        let url = source.get("url")?.as_str()?;
        let sha256 = source
            .get("hashes")
            .and_then(|hashes| hashes.get("sha256"))
            .and_then(serde_json::Value::as_str)?;
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
        Some(AttachmentDto {
            file_hash: format!("matrix-sha256:{sha256}"),
            filename: filename.to_owned(),
            size,
            chunks: 1,
            source_peer_id: format!("matrix:{url}"),
            media_source: Some(source),
            content_type,
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
        if keychain::secret_exists(&key) {
            let bytes = keychain::load_secret(&key).map_err(Self::map_error)?;
            return Ok(BASE64.encode(bytes));
        }

        let mut bytes = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        keychain::store_secret(&key, &bytes).map_err(Self::map_error)?;
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
        keychain::store_secret(&Self::session_key(storage), &serialized).map_err(Self::map_error)
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
        keychain::store_secret(&Self::session_key(storage), &serialized).map_err(Self::map_error)
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
        let serialized =
            keychain::load_secret(&Self::session_key(storage)).map_err(Self::map_error)?;
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

    async fn install_client(&self, client: Client, homeserver: String, profile_id: String) {
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

        let sync_client = client.clone();
        let sync_task = tokio::spawn(async move {
            if let Err(error) = sync_client.sync(SyncSettings::default()).await {
                tracing::error!(target: "mesh::matrix", "Matrix sync stopped: {error}");
            }
        });

        let mut runtime = self.runtime.write().await;
        if let Some(previous) = runtime.sync_task.take() {
            previous.abort();
        }
        if let Some(previous) = runtime.session_task.take() {
            previous.abort();
        }
        runtime.client = Some(client);
        runtime.homeserver = Some(homeserver);
        runtime.profile_id = Some(profile_id);
        runtime.sync_task = Some(sync_task);
        runtime.session_task = session_task;
    }

    async fn stop_runtime(&self) -> Option<Client> {
        let (client, sync_task, session_task) = {
            let mut runtime = self.runtime.write().await;
            let client = runtime.client.take();
            let sync_task = runtime.sync_task.take();
            let session_task = runtime.session_task.take();
            runtime.homeserver = None;
            runtime.profile_id = None;
            (client, sync_task, session_task)
        };

        if let Some(task) = sync_task {
            task.abort();
            let _ = task.await;
        }
        if let Some(task) = session_task {
            task.abort();
            let _ = task.await;
        }
        self.typing_users.write().await.clear();
        self.presence.write().await.clear();
        self.verification_sessions.write().await.clear();
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
        if let Some(task) = self.runtime.write().await.sync_task.take() {
            task.abort();
        }
    }

    pub async fn resume_sync(&self) -> BackendResult<()> {
        let client = self.client().await?;
        let homeserver = self
            .runtime
            .read()
            .await
            .homeserver
            .clone()
            .ok_or(BackendError::NotAuthenticated)?;
        let profile_id = self
            .runtime
            .read()
            .await
            .profile_id
            .clone()
            .or_else(|| self.load_registry().ok()?.active_profile_id)
            .unwrap_or_else(|| "default".into());
        self.install_client(client, homeserver, profile_id).await;
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
        let space = client.get_room(&space_id).ok_or_else(|| {
            BackendError::Other("community Space is not present in the local Matrix store".into())
        })?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community ID does not identify a Matrix Space".into(),
            ));
        }

        let mut rooms = vec![space];
        for child_id in self.space_child_ids(&rooms[0]).await? {
            if let Some(room) = client.get_room(&child_id) {
                if !room.is_space() {
                    rooms.push(room);
                }
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
    ) -> BackendResult<bool> {
        let direct_user = <&DirectUserIdentifier>::from(user_id);
        let mut accumulated: Option<DirectEventContent> = None;
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
            let Some(room_ids) = candidate.get_mut(direct_user) else {
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
        let direct_rooms = Self::direct_rooms(client, user_id);
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
            if duplicate_count > 1 {
                Self::reconcile_direct_duplicates(client, user_id, &direct_room_ids).await?;
            }
            room
        } else {
            client.create_dm(user_id).await.map_err(Self::map_error)?
        };
        Self::require_encrypted_room(&room, "opening this direct message").await?;
        Ok(room)
    }

    fn safe_media_filename(filename: &str) -> BackendResult<String> {
        let safe = Path::new(filename.trim())
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("attachment.bin")
            .to_owned();
        let extension = Path::new(&safe)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase());
        if extension
            .as_deref()
            .is_some_and(|extension| BLOCKED_MEDIA_EXTENSIONS.contains(&extension))
        {
            return Err(BackendError::InvalidConfiguration(
                "refusing to write an executable Matrix attachment".into(),
            ));
        }
        Ok(safe)
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

    async fn start(&self) -> BackendResult<()> {
        let storage = match self.active_storage_from_registry() {
            Ok(storage) => storage,
            Err(BackendError::NotAuthenticated) => return Ok(()),
            Err(error) => return Err(error),
        };
        if keychain::secret_exists(&Self::session_key(&storage)) {
            self.restore_session().await?;
        }
        Ok(())
    }

    async fn status(&self) -> BackendStatus {
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
        let sync_running = runtime
            .sync_task
            .as_ref()
            .is_some_and(|task| !task.is_finished());

        let warnings = if authenticated {
            Vec::new()
        } else {
            vec!["Sign in to a Matrix homeserver to synchronize communities and messages".into()]
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
                .sync_once(SyncSettings::default())
                .await
                .map_err(Self::map_error)?;
            self.persist_session(&storage, &resolved_homeserver, &session)?;
            self.register_account(&storage, &resolved_homeserver, &session)?;
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

            let callback = match oidc::receive_callback(listener, cancellation.clone()).await {
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
                    durable_client.sync_once(SyncSettings::default()),
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
                .sync_once(SyncSettings::default())
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
        if keychain::secret_exists(&session_key) {
            keychain::delete_secret(&session_key).map_err(Self::map_error)?;
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
                    uiaa::UserIdentifier::UserIdOrLocalpart(user_id),
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
        result
    }

    async fn remove_local_account(&self) -> BackendResult<()> {
        let profile_id = self
            .runtime
            .read()
            .await
            .profile_id
            .clone()
            .or_else(|| self.load_registry().ok()?.active_profile_id)
            .unwrap_or_else(|| "default".into());
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
                .sync_once(SyncSettings::default())
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
        let last_successful_test_at = Self::load_last_recovery_test(&storage);
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
        let space = client
            .create_room(space_request)
            .await
            .map_err(Self::map_error)?;

        let encryption = RoomEncryptionEventContent::new(EventEncryptionAlgorithm::MegolmV1AesSha2);
        let mut parent = SpaceParentEventContent::new(via.clone());
        parent.canonical = true;

        let mut channel_request = CreateRoomRequest::new();
        channel_request.name = Some("general".into());
        channel_request.topic = Some(format!("General discussion for {}", name.trim()));
        channel_request.preset = Some(RoomPreset::PrivateChat);
        channel_request.initial_state = vec![
            InitialStateEvent::with_empty_state_key(encryption).to_raw_any(),
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
        let space = client.get_room(&space_id).ok_or_else(|| {
            BackendError::Other("community Space is not present in the local Matrix store".into())
        })?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community ID does not identify a Matrix Space".into(),
            ));
        }

        let mut channels = Vec::new();
        for child_id in self.space_child_ids(&space).await? {
            let Some(room) = client.get_room(&child_id) else {
                continue;
            };
            if room.state() != RoomState::Joined || room.is_space() {
                continue;
            }
            Self::require_encrypted_room(&room, "opening this community channel").await?;

            channels.push(ChannelDto {
                id: room.room_id().to_string(),
                community_id: community_id.clone(),
                name: room.name().unwrap_or_else(|| "unnamed".into()),
                channel_type: "text".into(),
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
        if channel_type != "text" {
            return Err(BackendError::Unsupported(
                "Matrix voice channels (MatrixRTC migration pending)",
            ));
        }
        if name.trim().is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "channel name cannot be empty".into(),
            ));
        }

        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(&community_id).map_err(Self::map_error)?;
        let space = client.get_room(&space_id).ok_or_else(|| {
            BackendError::Other("community Space is not present in the local Matrix store".into())
        })?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community ID does not identify a Matrix Space".into(),
            ));
        }

        let user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let via = vec![user_id.server_name().to_owned()];
        let encryption = RoomEncryptionEventContent::new(EventEncryptionAlgorithm::MegolmV1AesSha2);
        let mut parent = SpaceParentEventContent::new(via.clone());
        parent.canonical = true;

        let mut request = CreateRoomRequest::new();
        request.name = Some(name.trim().to_owned());
        request.preset = Some(RoomPreset::PrivateChat);
        request.initial_state = vec![
            InitialStateEvent::with_empty_state_key(encryption).to_raw_any(),
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
            channel_type: "text".into(),
            unread_count: 0,
        })
    }

    async fn send_text(&self, room_id: String, body: String) -> BackendResult<SentMessage> {
        if body.trim().is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "message body cannot be empty".into(),
            ));
        }
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other("room is not present in the local Matrix store".into())
        })?;
        Self::require_encrypted_room(&room, "sending a message").await?;
        let response = room
            .send(RoomMessageEventContent::text_plain(body))
            .await
            .map_err(Self::map_error)?;
        Ok(SentMessage {
            event_id: response.event_id.to_string(),
            room_id: room.room_id().to_string(),
        })
    }

    async fn send_message(
        &self,
        room_id: String,
        body: String,
        reply_to_id: Option<String>,
    ) -> BackendResult<MessageDto> {
        if body.trim().is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "message body cannot be empty".into(),
            ));
        }

        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other("room is not present in the local Matrix store".into())
        })?;
        let action = if reply_to_id.is_some() {
            "sending a reply"
        } else {
            "sending a message"
        };
        Self::require_encrypted_room(&room, action).await?;

        let content = match reply_to_id.as_deref() {
            Some(event_id) => {
                let event_id =
                    matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
                room.make_reply_event(
                    RoomMessageEventContentWithoutRelation::text_plain(body.clone()),
                    Reply {
                        event_id,
                        enforce_thread: EnforceThread::Unthreaded,
                    },
                )
                .await
                .map_err(Self::map_error)?
            }
            None => RoomMessageEventContent::text_plain(body.clone()),
        };
        let response = room.send(content).await.map_err(Self::map_error)?;

        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let display_name = room
            .get_member(own_user_id)
            .await
            .map_err(Self::map_error)?
            .map(|member| member.name().to_owned())
            .unwrap_or_else(|| own_user_id.localpart().to_owned());

        Ok(MessageDto {
            id: response.event_id.to_string(),
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

    async fn send_attachment(
        &self,
        room_id: String,
        file_path: String,
        filename: String,
        content_type: Option<String>,
        body: String,
        reply_to_id: Option<String>,
    ) -> BackendResult<MessageDto> {
        const MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;

        let path = PathBuf::from(file_path);
        let metadata = tokio::fs::metadata(&path).await.map_err(Self::map_error)?;
        if !metadata.is_file() {
            return Err(BackendError::InvalidConfiguration(
                "attachment path is not a regular file".into(),
            ));
        }
        if metadata.len() > MAX_ATTACHMENT_BYTES {
            return Err(BackendError::InvalidConfiguration(
                "attachment exceeds the 100 MB limit".into(),
            ));
        }
        let filename = Self::safe_media_filename(&filename)?;
        let content_type = content_type
            .as_deref()
            .and_then(|value| mime::Mime::from_str(value).ok())
            .unwrap_or_else(|| {
                mime::Mime::from_str("application/octet-stream").expect("valid MIME")
            });
        let data = tokio::fs::read(&path).await.map_err(Self::map_error)?;
        let content_type_string = content_type.to_string();
        Self::validate_media_payload(&data, Some(&content_type_string), &filename)?;

        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other("room is not present in the local Matrix store".into())
        })?;
        Self::require_encrypted_room(&room, "sending an attachment").await?;

        let mut reader = Cursor::new(data);
        let encrypted_file = client
            .upload_encrypted_file(&mut reader)
            .await
            .map_err(Self::map_error)?;
        let sha256 = encrypted_file
            .hashes
            .get("sha256")
            .map(ToString::to_string)
            .ok_or_else(|| {
                BackendError::Other("Matrix encrypted attachment omitted SHA-256".into())
            })?;
        let media_source = serde_json::to_value(&encrypted_file).map_err(Self::map_error)?;
        let mut info = FileInfo::new();
        info.mimetype = Some(content_type.to_string());
        info.size = metadata.len().try_into().ok();
        let caption = if body.trim().is_empty() {
            filename.clone()
        } else {
            body.trim().to_owned()
        };
        let mut file_content = FileMessageEventContent::encrypted(caption.clone(), encrypted_file);
        file_content.filename = Some(filename.clone());
        file_content.info = Some(Box::new(info));
        let base_content =
            RoomMessageEventContentWithoutRelation::new(MessageType::File(file_content));
        let content = match reply_to_id.as_deref() {
            Some(event_id) => {
                let event_id =
                    matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
                room.make_reply_event(
                    base_content,
                    Reply {
                        event_id,
                        enforce_thread: EnforceThread::Unthreaded,
                    },
                )
                .await
                .map_err(Self::map_error)?
            }
            None => base_content.into(),
        };
        let response = room.send(content).await.map_err(Self::map_error)?;
        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let display_name = room
            .get_member(own_user_id)
            .await
            .map_err(Self::map_error)?
            .map(|member| member.name().to_owned())
            .unwrap_or_else(|| own_user_id.localpart().to_owned());

        Ok(MessageDto {
            id: response.event_id.to_string(),
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
                size: metadata.len(),
                chunks: 1,
                source_peer_id: format!(
                    "matrix:{}",
                    media_source
                        .get("url")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                ),
                media_source: Some(media_source),
                content_type: Some(content_type.to_string()),
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

    async fn download_attachment(&self, attachment: AttachmentDto) -> BackendResult<String> {
        let source = attachment.media_source.ok_or_else(|| {
            BackendError::InvalidConfiguration(
                "attachment has no Matrix encrypted-file metadata".into(),
            )
        })?;
        let encrypted_file: EncryptedFile =
            serde_json::from_value(source).map_err(Self::map_error)?;
        let request = MediaRequestParameters {
            source: MediaSource::Encrypted(Box::new(encrypted_file)),
            format: MediaFormat::File,
        };
        let client = self.client().await?;
        let file_hash = attachment.file_hash.clone();
        let cancellation = CancellationToken::new();
        {
            let mut downloads = self.media_downloads.lock().await;
            if downloads.contains_key(&file_hash) {
                return Err(BackendError::Other(
                    "this Matrix attachment is already downloading".into(),
                ));
            }
            downloads.insert(file_hash.clone(), cancellation.clone());
        }

        let result = async {
            let media = client.media();
            let data = tokio::select! {
                result = media.get_media_content(&request, false) => {
                    result.map_err(Self::map_error)?
                }
                _ = cancellation.cancelled() => {
                    return Err(BackendError::Other("Matrix attachment download cancelled".into()))
                }
            };
            if cancellation.is_cancelled() {
                return Err(BackendError::Other(
                    "Matrix attachment download cancelled".into(),
                ));
            }
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
            tokio::fs::create_dir_all(&cache_root)
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
            tokio::fs::write(&destination, data)
                .await
                .map_err(Self::map_error)?;
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
        result
    }

    async fn cancel_attachment_download(&self, file_hash: String) -> BackendResult<()> {
        if let Some(cancellation) = self.media_downloads.lock().await.remove(&file_hash) {
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
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other(
                "direct-message room is not present in the local Matrix store".into(),
            )
        })?;
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
        )
        .await?;
        Ok(Self::direct_message_from_message(message))
    }

    async fn send_dm_attachment(
        &self,
        recipient_user_id: String,
        file_path: String,
        filename: String,
        content_type: Option<String>,
        body: String,
        reply_to_id: Option<String>,
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
            file_path,
            filename,
            content_type,
            body,
            reply_to_id,
        )
        .await?;
        Ok(Self::direct_message_from_message(message))
    }

    async fn mark_dm_read(&self, conversation_id: String) -> BackendResult<()> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(&conversation_id).map_err(Self::map_error)?;
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other(
                "direct-message room is not present in the local Matrix store".into(),
            )
        })?;
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
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other("room is not present in the local Matrix store".into())
        })?;

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
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other("room is not present in the local Matrix store".into())
        })?;
        Self::require_encrypted_room(&room, "editing a message").await?;
        let replacement = RoomMessageEventContent::text_plain(body)
            .make_replacement(ReplacementMetadata::new(event_id, None));
        room.send(replacement).await.map_err(Self::map_error)?;
        Ok(())
    }

    async fn redact_message(&self, room_id: String, event_id: String) -> BackendResult<()> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other("room is not present in the local Matrix store".into())
        })?;
        // Keep explicit redaction available for legacy plaintext rooms so users can remove
        // previously exposed content. Reaction removal is guarded in `toggle_reaction`.
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
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other("room is not present in the local Matrix store".into())
        })?;
        Self::require_encrypted_room(&room, "changing a reaction").await?;

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
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other("room is not present in the local Matrix store".into())
        })?;
        let values = Self::timeline_values(&room, 1, None).await?;
        let Some(event_id) = values
            .iter()
            .find_map(|value| value.get("event_id").and_then(serde_json::Value::as_str))
        else {
            return Ok(());
        };
        let event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
        room.send_single_receipt(ReceiptType::Read, ReceiptThread::Unthreaded, event_id)
            .await
            .map_err(Self::map_error)
    }

    async fn set_typing(&self, room_id: String, typing: bool) -> BackendResult<()> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other("room is not present in the local Matrix store".into())
        })?;
        room.typing_notice(typing).await.map_err(Self::map_error)
    }

    async fn typing_users(&self, room_id: String) -> BackendResult<Vec<TypingUser>> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other("room is not present in the local Matrix store".into())
        })?;
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
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other("room is not present in the local Matrix store".into())
        })?;
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
        let user_id = matrix_sdk::ruma::UserId::parse(user_id).map_err(Self::map_error)?;
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
        let space = client.get_room(&space_id).ok_or_else(|| {
            BackendError::Other("community Space is not present in the local Matrix store".into())
        })?;
        if !space.is_space() || space.state() != RoomState::Joined {
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
        let space = client.get_room(&space_id).ok_or_else(|| {
            BackendError::Other("community Space is not present in the local Matrix store".into())
        })?;
        if !space.is_space() || space.state() != RoomState::Joined {
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
            let alias = RoomAliasId::parse(alias).map_err(Self::map_error)?;
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
        let space = client.get_room(&space_id).ok_or_else(|| {
            BackendError::Other("community Space is not present in the local Matrix store".into())
        })?;
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
        let space = client.get_room(&space_id).ok_or_else(|| {
            BackendError::Other("community Space is not present in the local Matrix store".into())
        })?;
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
        client
            .sync_once(SyncSettings::default())
            .await
            .map_err(Self::map_error)?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "join target is not a Matrix Space".into(),
            ));
        }

        let space = client.get_room(space.room_id()).ok_or_else(|| {
            BackendError::Other(
                "joined community Space is absent from the local Matrix store".into(),
            )
        })?;
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
            .sync_once(SyncSettings::default())
            .await
            .map_err(Self::map_error)?;

        for child_id in opened_child_ids {
            let room = client.get_room(&child_id).ok_or_else(|| {
                BackendError::InvalidConfiguration(format!(
                    "Mesh could not validate end-to-end encryption for Space child room \
                     {child_id} after joining. The community was not opened"
                ))
            })?;
            if !room.is_space() {
                Self::require_encrypted_room(&room, "joining this community").await?;
            }
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

        content
            .map(|raw| {
                raw.deserialize_as_unchecked::<UserPreferences>()
                    .map_err(Self::map_error)
            })
            .transpose()
    }

    async fn update_user_preferences(
        &self,
        preferences: UserPreferences,
    ) -> BackendResult<UserPreferences> {
        let client = self.client().await?;
        let preferences = preferences.normalized();
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
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other("room is not present in the local Matrix store".into())
        })?;
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
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other("room is not present in the local Matrix store".into())
        })?;
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
        self.client()
            .await?
            .sync_once(SyncSettings::default())
            .await
            .map(|_| ())
            .map_err(Self::map_error)
    }

    async fn import_legacy_event(
        &self,
        room_id: String,
        content: serde_json::Value,
    ) -> BackendResult<String> {
        let client = self.client().await?;
        let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(Self::map_error)?;
        let room = client.get_room(&room_id).ok_or_else(|| {
            BackendError::Other(
                "legacy import target is not present in the local Matrix store".into(),
            )
        })?;
        Self::require_encrypted_room(&room, "importing legacy provenance").await?;
        let response = room
            .send_raw(crate::backend::LEGACY_MATRIX_EVENT_TYPE, content)
            .await
            .map_err(Self::map_error)?;
        Ok(response.event_id.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::{authentication::SessionTokens, SessionMeta};
    use serde_json::json;

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
    fn encrypted_room_guard_fails_closed_with_actionable_room_context() {
        let protected_actions = [
            "sending a message",
            "sending a reply",
            "sending an attachment",
            "editing a message",
            "changing a reaction",
            "importing legacy provenance",
            "opening this community channel",
            "joining this community",
            "opening this direct message",
        ];

        for action in protected_actions {
            let error =
                MatrixBackend::ensure_room_is_encrypted("!plaintext:example.org", action, false)
                    .expect_err("unencrypted rooms must be rejected");
            let BackendError::InvalidConfiguration(message) = error else {
                panic!("encryption guard must return an actionable configuration error");
            };
            assert!(message.contains(action));
            assert!(message.contains("!plaintext:example.org"));
            assert!(message.contains("enable end-to-end encryption"));
            assert!(message.contains("leave and rejoin"));
        }
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
                "key": { "kty": "oct", "alg": "A256CTR", "ext": true, "k": "key", "key_ops": ["encrypt", "decrypt"] },
                "iv": "iv",
                "hashes": { "sha256": "ciphertext-hash" },
                "v": "v2"
            },
            "info": { "size": 42, "mimetype": "application/pdf" }
        });
        let attachment = MatrixBackend::matrix_attachment_from_content(&encrypted).unwrap();
        assert_eq!(attachment.filename, "report.pdf");
        assert_eq!(attachment.size, 42);
        assert_eq!(attachment.file_hash, "matrix-sha256:ciphertext-hash");
        assert_eq!(attachment.content_type.as_deref(), Some("application/pdf"));
        assert!(attachment.media_source.is_some());

        let plain = json!({
            "msgtype": "m.file",
            "body": "report.pdf",
            "url": "mxc://example.org/media"
        });
        assert!(MatrixBackend::matrix_attachment_from_content(&plain).is_none());
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
                    "key": { "kty": "oct", "alg": "A256CTR", "ext": true, "k": "key", "key_ops": ["encrypt", "decrypt"] },
                    "iv": "iv",
                    "hashes": { "sha256": "ciphertext-hash" },
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
                media_source: Some(json!({ "url": "mxc://example.org/note" })),
                content_type: Some("text/plain".into()),
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
    }
}
