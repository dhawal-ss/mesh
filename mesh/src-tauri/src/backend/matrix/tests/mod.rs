use super::*;
use matrix_sdk::{authentication::SessionTokens, SessionMeta};
use serde_json::json;

#[test]
fn managed_invitation_parser_accepts_only_the_configured_service_origin() {
    let expected = MatrixBackend::normalize_admission_origin("https://mesh.example").unwrap();
    let code = "abcdefghijklmnopqrstuvwxyzABCDEFG_123456789";

    let public = MatrixBackend::parse_managed_invitation(
        &format!("https://mesh.example/invite/{code}"),
        &expected,
    )
    .unwrap();
    assert_eq!(public.code, code);
    assert_eq!(public.api_origin.as_str(), "https://mesh.example/");

    let deep_link = MatrixBackend::parse_managed_invitation(
        &format!("mesh://join?v=4&kind=managed&code={code}&api=https%3A%2F%2Fmesh.example"),
        &expected,
    )
    .unwrap();
    assert_eq!(deep_link, public);

    assert!(matches!(
        MatrixBackend::parse_managed_invitation(
            &format!("https://other.example/invite/{code}"),
            &expected,
        ),
        Err(BackendError::PermissionDenied(_))
    ));
    assert!(MatrixBackend::parse_managed_invitation(
        &format!(
            "mesh://join?v=4&kind=managed&code={code}&code={code}&api=https%3A%2F%2Fmesh.example"
        ),
        &expected,
    )
    .is_err());
}

#[test]
fn managed_invitation_origins_require_https_except_for_loopback_development() {
    assert!(MatrixBackend::normalize_admission_origin("https://mesh.example").is_ok());
    assert!(MatrixBackend::normalize_admission_origin("http://127.0.0.1:8090").is_ok());
    assert!(MatrixBackend::normalize_admission_origin("http://mesh.example").is_err());
    assert!(MatrixBackend::normalize_admission_origin("https://mesh.example/private").is_err());
    assert!(MatrixBackend::normalize_admission_origin("https://user:secret@mesh.example").is_err());
}

#[test]
fn managed_invitation_response_is_bound_to_the_managed_account_service() {
    let managed = MatrixBackend::managed_homeserver_config_from(
        Some("https://matrix.mesh.example"),
        Some("mesh.example"),
    )
    .unwrap();
    let response = AdmissionServiceResponse {
        version: 4,
        registration_token: Some("registration-token".into()),
        room_id: "!community:mesh.example".into(),
        service: "https://matrix.mesh.example".into(),
        via: vec!["mesh.example".into()],
        expires_at: Some(1_800_000_000_000),
    };
    let admission = MatrixBackend::validate_admission_response(response, &managed, true).unwrap();
    assert_eq!(
        admission.registration_token.as_deref(),
        Some("registration-token")
    );

    let wrong_service = AdmissionServiceResponse {
        version: 4,
        registration_token: Some("registration-token".into()),
        room_id: "!community:mesh.example".into(),
        service: "https://matrix.other.example".into(),
        via: vec!["mesh.example".into()],
        expires_at: Some(1_800_000_000_000),
    };
    assert!(matches!(
        MatrixBackend::validate_admission_response(wrong_service, &managed, true),
        Err(BackendError::PermissionDenied(_))
    ));
}

const MATRIX_PRODUCTION_SOURCES: &[(&str, &str)] = &[
    ("matrix.rs", include_str!("../../matrix.rs")),
    ("attachments.rs", include_str!("../attachments.rs")),
    ("dm.rs", include_str!("../dm.rs")),
    ("emoji.rs", include_str!("../emoji.rs")),
    ("encryption.rs", include_str!("../encryption.rs")),
    ("messages.rs", include_str!("../messages.rs")),
    ("moderation.rs", include_str!("../moderation.rs")),
    ("oidc.rs", include_str!("../oidc.rs")),
    ("personal_data.rs", include_str!("../personal_data.rs")),
    ("rooms.rs", include_str!("../rooms.rs")),
    ("rtc.rs", include_str!("../rtc.rs")),
];

#[test]
fn personal_data_export_keeps_only_authored_content_and_redaction_state() {
    let own_message = json!({
        "type": "m.room.message",
        "sender": "@alice:example.org",
        "content": {"msgtype": "m.text", "body": "mine"}
    });
    let other_message = json!({
        "type": "m.room.message",
        "sender": "@bob:example.org",
        "content": {"msgtype": "m.text", "body": "not mine"}
    });
    let own_edit = json!({
        "type": "m.room.message",
        "sender": "@alice:example.org",
        "content": {"m.relates_to": {"rel_type": "m.replace"}}
    });
    let moderator_redaction = json!({
        "type": "m.room.redaction",
        "sender": "@moderator:example.org",
        "redacts": "$mine:example.org",
        "content": {}
    });

    assert!(MatrixBackend::personal_export_event_is_relevant(
        &own_message,
        "@alice:example.org"
    ));
    assert!(MatrixBackend::personal_export_event_is_relevant(
        &own_edit,
        "@alice:example.org"
    ));
    assert!(MatrixBackend::personal_export_event_is_relevant(
        &moderator_redaction,
        "@alice:example.org"
    ));
    assert!(!MatrixBackend::personal_export_event_is_relevant(
        &other_message,
        "@alice:example.org"
    ));
}

#[test]
fn personal_data_export_cache_prefix_matches_the_private_media_cache_contract() {
    assert_eq!(
        MatrixBackend::personal_export_cache_prefix("matrix-sha256:ab+/="),
        "matrix_sha256_ab___-"
    );
}

#[tokio::test]
async fn personal_data_export_copies_only_matching_private_media() {
    let root = tempfile::tempdir().unwrap();
    let cache = root.path().join("media-cache");
    let export = root.path().join("export");
    tokio::fs::create_dir_all(&cache).await.unwrap();
    tokio::fs::create_dir_all(&export).await.unwrap();
    tokio::fs::write(cache.join("matrix_sha256_abc-photo.png"), b"owned media")
        .await
        .unwrap();
    tokio::fs::write(cache.join("matrix_sha256_other-photo.png"), b"other media")
        .await
        .unwrap();

    let mut warnings = Vec::new();
    let copied = MatrixBackend::copy_personal_export_media(
        &cache,
        &export,
        &HashSet::from(["matrix-sha256:abc".to_owned()]),
        &mut warnings,
    )
    .await
    .unwrap();

    assert_eq!(copied, 1);
    assert!(warnings.is_empty());
    assert_eq!(
        tokio::fs::read(export.join("media").join("matrix_sha256_abc-photo.png"))
            .await
            .unwrap(),
        b"owned media"
    );
    assert!(!export
        .join("media")
        .join("matrix_sha256_other-photo.png")
        .exists());
}

#[test]
fn native_room_pins_are_unique_bounded_and_removable_at_capacity() {
    let first = matrix_sdk::ruma::EventId::parse("$first:example.org").unwrap();
    let second = matrix_sdk::ruma::EventId::parse("$second:example.org").unwrap();
    let (unpinned, now_pinned) =
        MatrixBackend::updated_room_pins(vec![first.clone(), first.clone(), second.clone()], first)
            .unwrap();
    assert!(!now_pinned);
    assert_eq!(unpinned, vec![second.clone()]);

    let third = matrix_sdk::ruma::EventId::parse("$third:example.org").unwrap();
    let (pinned, now_pinned) = MatrixBackend::updated_room_pins(unpinned, third.clone()).unwrap();
    assert!(now_pinned);
    assert_eq!(pinned, vec![second, third]);

    let at_capacity = (0..MAX_PINNED_EVENTS)
        .map(|index| matrix_sdk::ruma::EventId::parse(format!("$pin-{index}:example.org")).unwrap())
        .collect::<Vec<_>>();
    let overflow = matrix_sdk::ruma::EventId::parse("$overflow:example.org").unwrap();
    assert!(MatrixBackend::updated_room_pins(at_capacity.clone(), overflow).is_err());
    assert!(MatrixBackend::updated_room_pins(at_capacity.clone(), at_capacity[0].clone()).is_ok());
}

#[test]
fn custom_emoji_shortcodes_and_sanitized_media_are_bounded() {
    assert_eq!(
        MatrixBackend::normalize_custom_emoji_shortcode(":Party_2:").unwrap(),
        "party_2"
    );
    for invalid in ["x", "has space", "slash/name", "punctuation!"] {
        assert!(MatrixBackend::normalize_custom_emoji_shortcode(invalid).is_err());
    }
    assert!(MatrixBackend::normalize_custom_emoji_shortcode(&"a".repeat(33)).is_err());

    let mut source = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(256, 64)
        .write_to(&mut source, image::ImageFormat::Png)
        .unwrap();
    let sanitized =
        MatrixBackend::sanitize_custom_emoji(source.get_ref(), "image/png", "../party.png")
            .unwrap();
    assert_eq!((sanitized.width, sanitized.height), (128, 32));
    assert!(sanitized.bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    assert!(sanitized.bytes.len() <= MAX_CUSTOM_EMOJI_UPLOAD_BYTES);
}

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
        MatrixBackend::decode_matrix_rtc_media_key(&BASE64_STANDARD.encode([9_u8; 15])).is_err()
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
            recipient_fingerprint: MatrixBackend::matrix_rtc_recipient_fingerprint(&HashSet::new())
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
            recipient_fingerprint: MatrixBackend::matrix_rtc_recipient_fingerprint(&HashSet::new())
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
    assert!(MatrixBackend::matrix_rtc_local_lease_state(&mut runtime, &state_key, 1_000).is_err());
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
            matrix_sdk::ruma::events::room::message::ReplyMetadata::new(&event_id, &sender, None),
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

    let create_room_calls = MATRIX_PRODUCTION_SOURCES
        .iter()
        .map(|(_, source)| source.matches("create_room(").count())
        .sum::<usize>();
    let encryption_initial_state_calls = MATRIX_PRODUCTION_SOURCES
        .iter()
        .map(|(_, source)| source.matches("encrypted_room_initial_state()").count())
        .sum::<usize>();
    assert_eq!(
        create_room_calls,
        encryption_initial_state_calls - 1,
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
    for (file_name, source) in MATRIX_PRODUCTION_SOURCES {
        let mut current_function = "";
        for (line_number, line) in source.lines().enumerate() {
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
                    "direct room lookup in {current_function} at {file_name}:{}; use \
                     protected_joined_room",
                    line_number + 1
                );
            }
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
fn production_managed_defaults_preserve_the_stable_mesh_identity() {
    let managed = MatrixBackend::managed_homeserver_config_from(
        Some(DEFAULT_MANAGED_HOMESERVER),
        Some(DEFAULT_MANAGED_SERVER_NAME),
    )
    .unwrap();

    assert_eq!(managed.homeserver, "https://matrix.mesh.dhawal.org");
    assert_eq!(managed.server_name.as_str(), "mesh.dhawal.org");
}

#[test]
fn registration_tokens_are_normalized_without_accepting_arbitrary_input() {
    assert_eq!(
        MatrixBackend::normalize_registration_token(Some("  aB3xK9._~-  ".into())).unwrap(),
        Some("aB3xK9._~-".into())
    );
    assert_eq!(
        MatrixBackend::normalize_registration_token(Some("   ".into())).unwrap(),
        None
    );
    assert!(MatrixBackend::normalize_registration_token(Some("contains spaces".into())).is_err());
    assert!(MatrixBackend::normalize_registration_token(Some("a".repeat(65))).is_err());
}

#[test]
fn registration_uiaa_only_auto_completes_the_selected_single_stage() {
    let dummy = UiaaInfo::new(vec![uiaa::AuthFlow::new(vec![AuthType::Dummy])]);
    assert!(MatrixBackend::uiaa_can_complete_with_stage(
        &dummy,
        AuthType::Dummy
    ));
    assert!(!MatrixBackend::uiaa_can_complete_with_stage(
        &dummy,
        AuthType::RegistrationToken
    ));

    let invite = UiaaInfo::new(vec![uiaa::AuthFlow::new(vec![AuthType::RegistrationToken])]);
    assert!(MatrixBackend::uiaa_can_complete_with_stage(
        &invite,
        AuthType::RegistrationToken
    ));
    let invite_then_dummy = UiaaInfo::new(vec![uiaa::AuthFlow::new(vec![
        AuthType::RegistrationToken,
        AuthType::Dummy,
    ])]);
    assert!(MatrixBackend::uiaa_has_supported_registration_flow(
        &invite_then_dummy,
        true
    ));
    assert!(!MatrixBackend::uiaa_has_supported_registration_flow(
        &invite_then_dummy,
        false
    ));

    let terms = UiaaInfo::new(vec![uiaa::AuthFlow::new(vec![AuthType::Terms])]);
    assert!(!MatrixBackend::uiaa_can_complete_with_stage(
        &terms,
        AuthType::Dummy
    ));
    assert!(MatrixBackend::uiaa_has_incomplete_stage(
        &terms,
        AuthType::Terms
    ));

    let recaptcha = UiaaInfo::new(vec![uiaa::AuthFlow::new(vec![AuthType::ReCaptcha])]);
    assert!(!MatrixBackend::uiaa_can_complete_with_stage(
        &recaptcha,
        AuthType::Dummy
    ));
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

#[tokio::test]
async fn active_account_storage_root_uses_only_the_authenticated_profile() {
    let root = tempfile::tempdir().unwrap();
    let backend = MatrixBackend::new(root.path().join("matrix"));
    let active_profile = "active-profile";
    let other_profile = "other-profile";
    backend.runtime.write().await.profile_id = Some(active_profile.into());

    assert_eq!(
        backend.active_account_storage_root().await.unwrap(),
        backend.storage_for_profile(active_profile).store_root
    );
    assert_ne!(
        backend.active_account_storage_root().await.unwrap(),
        backend.storage_for_profile(other_profile).store_root
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

    let projected = MatrixBackend::project_timeline("!room:example.org", &HashMap::new(), events);
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
    let projected = MatrixBackend::project_timeline("!room:example.org", &HashMap::new(), events);
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
        transaction_id: None,
        client_request_id: None,
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
fn durable_queue_accepts_only_bounded_nonempty_text_content() {
    let valid = json!({
        "msgtype": "m.text",
        "body": "saved privately",
        (CLIENT_REQUEST_ID_KEY): "request-123"
    });
    assert!(MatrixBackend::is_supported_queued_content(&valid));

    let reply = json!({
        "msgtype": "m.text",
        "body": "> <@bob:example.org> quoted\n\nvisible reply",
        "m.relates_to": {
            "m.in_reply_to": { "event_id": "$root:example.org" }
        },
        (CLIENT_REQUEST_ID_KEY): "reply-123"
    });
    assert!(MatrixBackend::is_supported_queued_content(&reply));
    assert_eq!(
        MatrixBackend::visible_message_body(&reply).as_deref(),
        Some("visible reply")
    );

    for rejected in [
        json!({
            "msgtype": "m.file",
            "body": "not a text queue item",
            (CLIENT_REQUEST_ID_KEY): "request-123"
        }),
        json!({ "msgtype": "m.text", "body": "missing identifier" }),
        json!({
            "msgtype": "m.text",
            "body": "invalid identifier",
            (CLIENT_REQUEST_ID_KEY): "contains whitespace"
        }),
        json!({
            "msgtype": "m.text",
            "body": "   ",
            (CLIENT_REQUEST_ID_KEY): "request-123"
        }),
    ] {
        assert!(!MatrixBackend::is_supported_queued_content(&rejected));
    }
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

    let authenticated =
        SupportedVersions::from_parts(&["v1.11".to_owned()], &std::collections::BTreeMap::new());
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
fn lightbox_image_validation_requires_a_supported_matching_image() {
    let source = image::DynamicImage::new_rgb8(64, 32);
    let mut encoded = Cursor::new(Vec::new());
    source
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    let encoded = encoded.into_inner();

    assert!(MatrixBackend::validate_lightbox_image(&encoded, "image/png").is_ok());
    assert!(MatrixBackend::validate_lightbox_image(&encoded, "image/webp").is_err());
    assert!(MatrixBackend::validate_lightbox_image(b"<svg/>", "image/svg+xml").is_err());
}

#[tokio::test]
async fn lightbox_image_scheduler_limits_full_image_reads() {
    let backend = MatrixBackend::with_profile(
        std::env::temp_dir().join("mesh-lightbox-image-scheduler-test"),
        "lightbox-image-scheduler",
    );
    assert_eq!(
        backend.lightbox_image_loads.available_permits(),
        MAX_CONCURRENT_LIGHTBOX_IMAGE_LOADS
    );
    let permit = backend.lightbox_image_loads.acquire().await.unwrap();
    assert_eq!(backend.lightbox_image_loads.available_permits(), 0);
    drop(permit);
    assert_eq!(
        backend.lightbox_image_loads.available_permits(),
        MAX_CONCURRENT_LIGHTBOX_IMAGE_LOADS
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
