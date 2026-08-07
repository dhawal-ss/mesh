impl MatrixBackend {
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

    fn validate_matrix_rtc_sfu_url(
        returned: &str,
        expected: Option<&str>,
        tauri_config: &str,
    ) -> BackendResult<String> {
        let returned = VoiceServiceStatus::secure_url("MSC4195 LiveKit URL", returned, "wss")
            .map_err(BackendError::InvalidConfiguration)?;
        if let Some(expected) = expected {
            let expected =
                VoiceServiceStatus::secure_url("MESH_MATRIXRTC_LIVEKIT_SFU_URL", expected, "wss")
                    .map_err(BackendError::InvalidConfiguration)?;
            if returned != expected {
                return Err(BackendError::InvalidConfiguration(
                    "The calling service returned a media endpoint that is not approved by this Mesh build."
                        .into(),
                ));
            }
        }
        let returned_origin = returned.origin().ascii_serialization();
        if !VoiceServiceStatus::connect_src_allows(tauri_config, &[&returned_origin]) {
            return Err(BackendError::InvalidConfiguration(
                "The calling service returned a media endpoint that is not allowed by this Mesh build."
                    .into(),
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

    fn matrix_rtc_config(discovered_service_url: String) -> BackendResult<VoiceServiceStatus> {
        let status = VoiceServiceStatus::matrix_rtc_for_discovered_service(discovered_service_url);
        match status.availability {
            VoiceServiceAvailability::Ready
                if status.csp_ready
                    && status.media_e2ee_ready
                    && status.livekit_service_url.is_some() =>
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
        if VoiceServiceStatus::matrix_rtc_client_included() {
            Ok(())
        } else {
            Err(BackendError::Unsupported(
                "Calling is not included in this Mesh build",
            ))
        }
    }

    async fn active_matrix_rtc_memberships(
        room: &Room,
    ) -> BackendResult<Vec<ActiveMatrixRtcMembership>> {
        // The SDK still returns a Vec, but reading only the call-member event
        // type avoids repeatedly fetching unrelated room state. Voice remains
        // fail-closed if the typed store projection crosses Mesh's caps.
        let room_state = room
            .get_state_events_static::<CallMemberEventContent>()
            .await
            .map_err(Self::map_error)?;
        if room_state.len() > MATRIX_RTC_MAX_CALL_MEMBER_EVENTS {
            return Err(BackendError::InvalidConfiguration(format!(
                "Voice is unavailable because this room has more than {MATRIX_RTC_MAX_CALL_MEMBER_EVENTS} call records"
            )));
        }
        let raw_state_bytes = room_state.iter().try_fold(0_usize, |total, raw| {
            let raw_json = match raw {
                RawSyncOrStrippedState::Sync(raw) => raw.json().get(),
                RawSyncOrStrippedState::Stripped(raw) => raw.json().get(),
            };
            total
                .checked_add(raw_json.len())
                .filter(|bytes| *bytes <= MATRIX_RTC_MAX_CALL_MEMBER_STATE_BYTES)
                .ok_or_else(|| {
                    BackendError::InvalidConfiguration(
                        "Voice is unavailable because this room's call state is too large".into(),
                    )
                })
        })?;
        debug_assert!(raw_state_bytes <= MATRIX_RTC_MAX_CALL_MEMBER_STATE_BYTES);
        let mut memberships = Vec::new();

        for raw in room_state {
            let raw_event = match &raw {
                RawSyncOrStrippedState::Sync(raw) => raw.json().get().to_owned(),
                RawSyncOrStrippedState::Stripped(raw) => raw.json().get().to_owned(),
            };
            let event = raw.deserialize().map_err(Self::map_error)?;
            let SyncOrStrippedState::Sync(SyncStateEvent::Original(event)) = event else {
                continue;
            };
            if event.state_key.user_id() != event.sender {
                continue;
            }
            let Some(room_member) = room
                .get_member_no_sync(&event.sender)
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
                if memberships.len() >= MATRIX_RTC_MAX_PARTICIPANTS {
                    return Err(BackendError::InvalidConfiguration(format!(
                        "Voice is unavailable because this room has more than {MATRIX_RTC_MAX_PARTICIPANTS} active call participants"
                    )));
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
                .expect("invariant: validated pending activation remains under the same lock");
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
        local_service_url: &str,
    ) -> BackendResult<String> {
        let memberships = Self::active_matrix_rtc_memberships(room).await?;
        Self::select_matrix_rtc_service_from_memberships(
            &memberships,
            local_service_url,
            VoiceServiceStatus::TAURI_CSP,
        )
    }

    fn select_matrix_rtc_service_from_memberships(
        memberships: &[ActiveMatrixRtcMembership],
        local_service_url: &str,
        tauri_config: &str,
    ) -> BackendResult<String> {
        let Some(oldest) = memberships.first() else {
            return Ok(local_service_url.to_owned());
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
        let selected_origin = selected.origin().ascii_serialization();
        if !VoiceServiceStatus::connect_src_allows(
            tauri_config,
            &[&selected_origin],
        ) {
            return Err(BackendError::InvalidConfiguration(
                "This community selected a calling service that is not allowed by this Mesh build."
                    .into(),
            ));
        }
        Ok(selected.to_string())
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
        expected_sfu_url: Option<&str>,
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
        let returned_sfu = Self::validate_matrix_rtc_sfu_url(
            &response.url,
            expected_sfu_url,
            VoiceServiceStatus::TAURI_CSP,
        )?;
        Ok(MatrixRtcTokenResponse {
            url: returned_sfu,
            jwt: response.jwt,
        })
    }
}
