//! Durable communication backend boundary.
//!
//! The React application continues to use typed Tauri IPC while the Rust
//! backend can select Matrix (the production default) or the legacy libp2p
//! engine. Product code should depend on [`MeshBackend`], not on a transport.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::types::{
    community::{ChannelDto, CommunityDto},
    dm::{DirectMessageDto, DmConversationDto},
    message::{AttachmentDto, MessageDto},
};

pub const LEGACY_MATRIX_EVENT_TYPE: &str = "org.mesh.legacy_archive.v1";

#[cfg(feature = "legacy-p2p")]
mod legacy;
#[cfg(feature = "matrix-backend")]
mod matrix;

#[cfg(feature = "legacy-p2p")]
pub use legacy::LegacyP2pBackend;
#[cfg(feature = "matrix-backend")]
pub use matrix::MatrixBackend;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub kind: BackendKind,
    pub capabilities: BackendCapabilities,
    pub voice_service: VoiceServiceStatus,
    pub authenticated: bool,
    pub user_id: Option<String>,
    pub device_id: Option<String>,
    pub homeserver: Option<String>,
    pub sync_running: bool,
    pub durable_history: bool,
    pub end_to_end_encryption: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceProvider {
    MatrixRtc,
    LegacySimplePeer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceServiceStatus {
    pub provider: VoiceProvider,
    pub availability: VoiceServiceAvailability,
    pub discovery_key: Option<String>,
    pub livekit_service_url: Option<String>,
    pub token_endpoint: Option<String>,
    pub livekit_sfu_url: Option<String>,
    pub csp_ready: bool,
    pub media_e2ee_verified: bool,
    pub reason: Option<String>,
}

impl VoiceServiceStatus {
    const MATRIXRTC_DISCOVERY_KEY: &'static str = "org.matrix.msc4143.rtc_foci";
    const MATRIXRTC_SERVICE_ENV: &'static str = "MESH_MATRIXRTC_LIVEKIT_SERVICE_URL";
    const MATRIXRTC_SFU_ENV: &'static str = "MESH_MATRIXRTC_LIVEKIT_SFU_URL";
    const TAURI_CSP: &'static str = include_str!("../../tauri.conf.json");

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
                media_e2ee_verified: false,
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
            media_e2ee_verified: false,
            reason: None,
        };

        if livekit_service_url.is_none() && livekit_sfu_url.is_none() {
            return Self {
                reason: Some(format!(
                    "Discover {}.livekit_service_url or set {}; also set {} to the expected WSS origin returned by MSC4195",
                    Self::MATRIXRTC_DISCOVERY_KEY,
                    Self::MATRIXRTC_SERVICE_ENV,
                    Self::MATRIXRTC_SFU_ENV
                )),
                ..base
            };
        }

        if livekit_service_url.is_none() || livekit_sfu_url.is_none() {
            return Self {
                availability: VoiceServiceAvailability::InvalidConfiguration,
                reason: Some(format!(
                    "{} and {} must be configured together",
                    Self::MATRIXRTC_SERVICE_ENV,
                    Self::MATRIXRTC_SFU_ENV
                )),
                ..base
            };
        }

        let service = match Self::secure_url(
            Self::MATRIXRTC_SERVICE_ENV,
            livekit_service_url.as_deref().unwrap(),
            "https",
        ) {
            Ok(url) => url,
            Err(reason) => {
                return Self {
                    availability: VoiceServiceAvailability::InvalidConfiguration,
                    reason: Some(reason),
                    ..base
                };
            }
        };
        let sfu = match Self::secure_url(
            Self::MATRIXRTC_SFU_ENV,
            livekit_sfu_url.as_deref().unwrap(),
            "wss",
        ) {
            Ok(url) => url,
            Err(reason) => {
                return Self {
                    availability: VoiceServiceAvailability::InvalidConfiguration,
                    reason: Some(reason),
                    ..base
                };
            }
        };
        let token_endpoint = format!("{}/get_token", service.as_str().trim_end_matches('/'));
        let service_origin = service.origin().ascii_serialization();
        let sfu_origin = sfu.origin().ascii_serialization();
        let csp_ready = Self::connect_src_allows(tauri_config, &[&service_origin, &sfu_origin]);
        let base = Self {
            token_endpoint: Some(token_endpoint),
            csp_ready,
            ..base
        };

        if !csp_ready {
            return Self {
                availability: VoiceServiceAvailability::InvalidConfiguration,
                reason: Some(format!(
                    "Tauri connect-src must explicitly allow {service_origin} and {sfu_origin} before MatrixRTC network access"
                )),
                ..base
            };
        }

        Self {
            availability: VoiceServiceAvailability::ClientUnavailable,
            reason: Some(
                "Discovery, MSC4195 /get_token, and CSP origins are configured, but the MatrixRTC client and media E2EE verification are not implemented"
                    .into(),
            ),
            ..base
        }
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
        required_origins
            .iter()
            .all(|required| allowed.clone().any(|candidate| candidate == *required))
    }

    fn non_empty(value: String) -> Option<String> {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_owned())
    }
}

/// Authoritative product capabilities for the selected backend. The frontend
/// renders unavailable features from this contract instead of probing legacy
/// commands or duplicating backend-mode conditionals.
#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixLogin {
    pub homeserver: String,
    pub username: String,
    pub password: String,
    pub device_name: Option<String>,
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixOidcStatus {
    pub homeserver: String,
    pub availability: MatrixOidcAvailability,
    pub issuer: Option<String>,
    pub authorization_endpoint: Option<String>,
    pub registration_mode: Option<String>,
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

/// Public profile metadata owned by the authenticated Matrix account.
///
/// `avatar_url` is an MXC URI. Matrix profile avatars are not end-to-end
/// encrypted, so Mesh currently exposes the URI as read-only metadata and does
/// not upload profile images.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixProfile {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRecoveryHealth {
    pub recovery_state: String,
    pub backup_state: String,
    pub backup_exists_on_server: bool,
    pub backup_enabled: bool,
    pub healthy: bool,
    pub checked_at: String,
    pub last_successful_test_at: Option<String>,
    pub warnings: Vec<String>,
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
    pub role: String,
    pub join_status: String,
    pub ban_status: String,
    pub last_seen: Option<String>,
    pub online: bool,
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

/// Portable, non-secret preferences synchronized through Matrix account data.
/// Device credentials, recovery material, and machine-local network settings
/// are intentionally outside this contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPreferences {
    pub schema_version: u32,
    pub notifications_enabled: bool,
    pub notification_sound: bool,
    #[serde(default)]
    pub muted_channels: Vec<String>,
    #[serde(default)]
    pub muted_communities: Vec<String>,
    pub updated_at: String,
}

impl UserPreferences {
    pub const SCHEMA_VERSION: u32 = 1;

    pub fn normalized(mut self) -> Self {
        self.schema_version = Self::SCHEMA_VERSION;
        self.muted_channels.sort();
        self.muted_channels.dedup();
        self.muted_communities.sort();
        self.muted_communities.dedup();
        self.updated_at = chrono::Utc::now().to_rfc3339();
        self
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("backend is not authenticated")]
    NotAuthenticated,
    #[error("operation is unavailable on the {0} backend")]
    Unsupported(&'static str),
    #[error("invalid backend configuration: {0}")]
    InvalidConfiguration(String),
    #[error("backend error: {0}")]
    Other(String),
    #[error("Matrix sign-in was cancelled")]
    LoginCancelled,
    #[error("Matrix sign-in timed out after {0} seconds")]
    LoginTimedOut(u64),
}

pub type BackendResult<T> = Result<T, BackendError>;

#[async_trait]
pub trait MeshBackend: Send + Sync {
    fn kind(&self) -> BackendKind;
    async fn start(&self) -> BackendResult<()>;
    async fn status(&self) -> BackendStatus;
    async fn login(&self, request: MatrixLogin) -> BackendResult<BackendStatus>;
    async fn oidc_status(&self, _homeserver: String) -> BackendResult<MatrixOidcStatus> {
        Err(BackendError::Unsupported("Matrix OIDC discovery"))
    }
    async fn start_oidc_login(&self, _homeserver: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("Matrix OIDC login"))
    }
    async fn cancel_login(&self) -> BackendResult<()> {
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
    async fn list_communities(&self) -> BackendResult<Vec<CommunityDto>> {
        Err(BackendError::Unsupported("community listing"))
    }
    async fn list_channels(&self, _community_id: String) -> BackendResult<Vec<ChannelDto>> {
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
    async fn send_text(&self, room_id: String, body: String) -> BackendResult<SentMessage>;
    async fn send_message(
        &self,
        _room_id: String,
        _body: String,
        _reply_to_id: Option<String>,
    ) -> BackendResult<MessageDto> {
        Err(BackendError::Unsupported("message delivery"))
    }
    async fn send_attachment(
        &self,
        _room_id: String,
        _file_path: String,
        _filename: String,
        _content_type: Option<String>,
        _body: String,
        _reply_to_id: Option<String>,
    ) -> BackendResult<MessageDto> {
        Err(BackendError::Unsupported("encrypted Matrix attachments"))
    }
    async fn download_attachment(&self, _attachment: AttachmentDto) -> BackendResult<String> {
        Err(BackendError::Unsupported("encrypted Matrix attachments"))
    }
    async fn cancel_attachment_download(&self, _file_hash: String) -> BackendResult<()> {
        Err(BackendError::Unsupported(
            "encrypted Matrix attachment cancellation",
        ))
    }
    async fn dm_conversations(&self) -> BackendResult<Vec<DmConversationDto>> {
        Err(BackendError::Unsupported("Matrix direct messages"))
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
    ) -> BackendResult<DirectMessageDto> {
        Err(BackendError::Unsupported("Matrix direct messages"))
    }
    async fn send_dm_attachment(
        &self,
        _recipient_user_id: String,
        _file_path: String,
        _filename: String,
        _content_type: Option<String>,
        _body: String,
        _reply_to_id: Option<String>,
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
    async fn edit_message(
        &self,
        _room_id: String,
        _event_id: String,
        _body: String,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("message editing"))
    }
    async fn redact_message(&self, _room_id: String, _event_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("message redaction"))
    }
    async fn toggle_reaction(
        &self,
        _room_id: String,
        _event_id: String,
        _key: String,
    ) -> BackendResult<bool> {
        Err(BackendError::Unsupported("message reactions"))
    }
    async fn mark_read(&self, _room_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("read receipts"))
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
        _query: String,
        _limit: u32,
    ) -> BackendResult<Vec<MessageDto>> {
        Err(BackendError::Unsupported("message search"))
    }
    async fn wait_for_room_update(
        &self,
        _room_id: String,
        _timeout_ms: u64,
    ) -> BackendResult<bool> {
        Err(BackendError::Unsupported("room update subscription"))
    }
    async fn list_members(&self, _community_id: String) -> BackendResult<Vec<CommunityMember>> {
        Err(BackendError::Unsupported("community membership"))
    }
    async fn invite_to_community(
        &self,
        _community_id: String,
        _user_id: String,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("community invitations"))
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
    ) -> BackendResult<CommunityAccessSettings> {
        Err(BackendError::Unsupported("community access settings"))
    }
    async fn search_community_directory(
        &self,
        _query: String,
        _server: Option<String>,
        _limit: u32,
    ) -> BackendResult<Vec<CommunityDirectoryEntry>> {
        Err(BackendError::Unsupported("community directory"))
    }
    async fn knock_community(
        &self,
        _room_or_alias: String,
        _reason: Option<String>,
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
    async fn join_community(&self, _room_or_alias: String) -> BackendResult<CommunityDto> {
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
    async fn update_member_role(
        &self,
        _community_id: String,
        _user_id: String,
        _role: String,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("community roles"))
    }
    async fn kick_member(
        &self,
        _community_id: String,
        _user_id: String,
        _reason: Option<String>,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("community kicks"))
    }
    async fn ban_member(
        &self,
        _community_id: String,
        _user_id: String,
        _reason: Option<String>,
    ) -> BackendResult<()> {
        Err(BackendError::Unsupported("community bans"))
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
    async fn enable_recovery(&self, passphrase: Option<String>) -> BackendResult<String>;
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
    fn portable_preferences_are_versioned_and_deduplicated() {
        let preferences = UserPreferences {
            schema_version: 99,
            notifications_enabled: true,
            notification_sound: false,
            muted_channels: vec!["!b:example.org".into(), "!b:example.org".into()],
            muted_communities: vec!["!space:example.org".into()],
            updated_at: "stale".into(),
        }
        .normalized();

        assert_eq!(preferences.schema_version, UserPreferences::SCHEMA_VERSION);
        assert_eq!(preferences.muted_channels, vec!["!b:example.org"]);
        assert_ne!(preferences.updated_at, "stale");
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
    fn matrix_rtc_configuration_requires_service_and_sfu_endpoints() {
        let missing_sfu = VoiceServiceStatus::matrix_rtc(
            Some("https://rtc.example.org".into()),
            None,
            "connect-src https://rtc.example.org wss://livekit.example.org",
        );
        assert_eq!(
            missing_sfu.availability,
            VoiceServiceAvailability::InvalidConfiguration
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
    fn configured_matrix_rtc_remains_unavailable_until_client_and_e2ee_are_verified() {
        let status = VoiceServiceStatus::matrix_rtc(
            Some("https://rtc.example.org/livekit/jwt".into()),
            Some("wss://livekit.example.org".into()),
            "connect-src https://rtc.example.org wss://livekit.example.org",
        );

        assert_eq!(
            status.availability,
            VoiceServiceAvailability::ClientUnavailable
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
        assert!(!status.media_e2ee_verified);
        assert!(!BackendCapabilities::for_kind(BackendKind::Matrix).voice);
    }

    #[test]
    fn matrix_rtc_fails_closed_when_tauri_csp_omits_media_origins() {
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
    fn matrix_rtc_rejects_credentials_and_only_accepts_connect_src_origins() {
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
    fn legacy_voice_is_explicitly_separate_from_matrix_rtc() {
        let status = VoiceServiceStatus::for_kind(BackendKind::LegacyP2p);
        assert_eq!(status.provider, VoiceProvider::LegacySimplePeer);
        assert_eq!(status.availability, VoiceServiceAvailability::Ready);
        assert!(!status.media_e2ee_verified);
    }
}
