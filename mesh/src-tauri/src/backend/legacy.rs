use async_trait::async_trait;

use super::{
    BackendError, BackendKind, BackendResult, BackendStatus, CreatedCommunity, MatrixLogin,
    MatrixRecoverySetupResult, MeshBackend, SentMessage,
};

/// Compatibility adapter for the existing libp2p implementation.
///
/// Existing commands continue to drive the mature libp2p code path while it
/// is migrated behind this interface. Matrix-only account operations fail
/// closed instead of accidentally writing to the proprietary protocol.
pub struct LegacyP2pBackend;

impl LegacyP2pBackend {
    pub fn new() -> Self {
        Self
    }
}

impl Default for LegacyP2pBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MeshBackend for LegacyP2pBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::LegacyP2p
    }

    async fn start(&self) -> BackendResult<()> {
        Ok(())
    }

    async fn status(&self) -> BackendStatus {
        BackendStatus {
            kind: BackendKind::LegacyP2p,
            capabilities: super::BackendCapabilities::for_kind(BackendKind::LegacyP2p),
            voice_service: super::VoiceServiceStatus::for_kind(BackendKind::LegacyP2p),
            authenticated: false,
            user_id: None,
            device_id: None,
            homeserver: None,
            sync_running: false,
            durable_history: false,
            supports_e2ee: true,
            session_e2ee_ready: false,
            warnings: vec![
                "Legacy libp2p mode requires another Mesh peer for delivery and history".into(),
            ],
        }
    }

    async fn login(
        &self,
        _request: MatrixLogin,
        _attempt_id: String,
    ) -> BackendResult<BackendStatus> {
        Err(BackendError::Unsupported("legacy-p2p"))
    }

    async fn restore_session(&self) -> BackendResult<BackendStatus> {
        Err(BackendError::Unsupported("legacy-p2p"))
    }

    async fn logout(&self) -> BackendResult<()> {
        Ok(())
    }

    async fn create_community(
        &self,
        _name: String,
        _description: String,
    ) -> BackendResult<CreatedCommunity> {
        Err(BackendError::Unsupported("legacy-p2p"))
    }

    async fn send_text(&self, _room_id: String, _body: String) -> BackendResult<SentMessage> {
        Err(BackendError::Unsupported("legacy-p2p"))
    }

    async fn invite_user(&self, _room_id: String, _user_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("legacy-p2p"))
    }

    async fn join_room(&self, _room_id: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("legacy-p2p"))
    }

    async fn recent_texts(&self, _room_id: String, _limit: u32) -> BackendResult<Vec<String>> {
        Err(BackendError::Unsupported("legacy-p2p"))
    }

    async fn enable_recovery(
        &self,
        _passphrase: Option<String>,
    ) -> BackendResult<MatrixRecoverySetupResult> {
        Err(BackendError::Unsupported("legacy-p2p"))
    }

    async fn recover(&self, _recovery_key_or_passphrase: String) -> BackendResult<()> {
        Err(BackendError::Unsupported("legacy-p2p"))
    }

    async fn sync_once(&self) -> BackendResult<()> {
        Err(BackendError::Unsupported("legacy-p2p"))
    }
}
