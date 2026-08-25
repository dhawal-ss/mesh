use super::*;

impl MatrixBackend {
    /// Classify an SDK error from what the protocol said. See `errors.rs`.
    pub(super) fn map_error<E: errors::MatrixErrorClassification>(error: E) -> BackendError {
        classify_matrix_error(error)
    }

    /// Classify an error that carries no protocol answer at all -- a parse
    /// failure, an IO error, a library that only implements Display.
    ///
    /// Keyword-searching a message is a poor way to decide what went wrong, and
    /// for these it is the only way available. Prefer `map_error` wherever the
    /// error is an SDK error, because that one cannot be talked into the wrong
    /// answer by a message.
    pub(super) fn map_display_error(error: impl std::fmt::Display) -> BackendError {
        BackendError::from_sdk_error(error)
    }

    pub(super) fn map_matrix_send_error(error: matrix_sdk::Error) -> BackendError {
        if matches!(
            &error,
            matrix_sdk::Error::OlmError(olm)
                if matches!(
                    olm.as_ref(),
                    OlmError::SessionRecipientCollectionError(
                        SessionRecipientCollectionError::SendingFromUnverifiedDevice
                            | SessionRecipientCollectionError::CrossSigningNotSetup
                    )
                )
        ) {
            BackendError::device_verification_required()
        } else {
            Self::map_error(error)
        }
    }

    pub(super) fn map_secure_storage_error(error: anyhow::Error) -> BackendError {
        if error
            .downcast_ref::<crate::crypto::keychain::CredentialBlobTooLarge>()
            .is_some()
        {
            return BackendError::InvalidConfiguration(
                "Mesh could not save this security data because the Windows secure-store size limit was reached. Remove an old account or trusted device, or use a shorter recovery passphrase, then try again"
                    .into(),
            );
        }
        BackendError::Crypto(format!(
            "the operating-system secure store is unavailable or corrupt: {error}"
        ))
    }

    pub(super) fn normalize_display_name(display_name: &str) -> BackendResult<String> {
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

    pub(super) fn ensure_room_is_encrypted(
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

    pub(super) fn encrypted_room_initial_state() -> Raw<AnyInitialStateEvent> {
        InitialStateEvent::with_empty_state_key(RoomEncryptionEventContent::new(
            EventEncryptionAlgorithm::MegolmV1AesSha2,
        ))
        .to_raw_any()
    }

    pub(super) fn ensure_room_is_joined(
        room_id: &str,
        action: &str,
        is_joined: bool,
    ) -> BackendResult<()> {
        if is_joined {
            return Ok(());
        }

        Err(BackendError::PermissionDenied(format!(
            "Mesh blocked {action} because Matrix room {room_id} is not joined"
        )))
    }

    pub(super) async fn require_protected_room(room: &Room, action: &str) -> BackendResult<()> {
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

    pub(super) async fn protected_joined_room(
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

    /**
        This account's membership of a room, and nothing else.

        A room listing has to tell "not in this room" apart from "in this room
        and something is wrong with it", and the protected-room guard answers
        both with an error. This answers only the first question, and
        deliberately returns the membership rather than the room, so no caller
        can reach a room's contents through it: reading anything still means
        going through `protected_joined_room`. A room absent from the local
        store is one this account has never been in, which is `Left` for every
        purpose a caller has.
    */
    pub(super) fn account_room_membership(
        client: &Client,
        room_id: &matrix_sdk::ruma::RoomId,
    ) -> RoomState {
        client
            .get_room(room_id)
            .map(|room| room.state())
            .unwrap_or(RoomState::Left)
    }

    pub(super) async fn protected_joined_room_if_available(
        client: &Client,
        room_id: &matrix_sdk::ruma::RoomId,
        action: &str,
    ) -> BackendResult<Option<Room>> {
        let Some(room) = client.get_room(room_id) else {
            return Ok(None);
        };
        if room.state() != RoomState::Joined {
            return Ok(None);
        }
        Self::require_protected_room(&room, action).await?;
        Ok(Some(room))
    }

    pub(super) async fn existing_protected_text_channel(
        client: &Client,
        room_id: &matrix_sdk::ruma::RoomId,
        action: &str,
    ) -> BackendResult<Room> {
        let room = Self::protected_joined_room(client, room_id, action).await?;
        if room.is_space() || room.room_type().is_some() || !room.direct_targets().is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "message delivery requires an existing protected text channel".into(),
            ));
        }

        let mut parents = room.parent_spaces().await.map_err(Self::map_error)?;
        while let Some(parent) = parents.next().await {
            let Ok(ParentSpace::Reciprocal(parent)) = parent else {
                continue;
            };
            if parent.is_space()
                && Self::require_protected_room(&parent, "authorizing a protected text channel")
                    .await
                    .is_ok()
            {
                drop(parents);
                return Ok(room);
            }
        }
        Err(BackendError::PermissionDenied(
            "message delivery requires a verified protected server channel".into(),
        ))
    }

    pub(super) async fn room_for_cleanup_redaction(
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

    pub(super) fn verification_snapshot(
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
            let code = qr.to_qr_code().map_err(Self::map_display_error)?;
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

    pub(super) fn recovery_state_name(state: RecoveryState) -> &'static str {
        match state {
            RecoveryState::Unknown => "unknown",
            RecoveryState::Enabled => "enabled",
            RecoveryState::Disabled => "disabled",
            RecoveryState::Incomplete => "incomplete",
        }
    }

    pub(super) fn backup_state_name(state: BackupState) -> &'static str {
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
}
