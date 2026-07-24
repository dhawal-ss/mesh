#![cfg(feature = "matrix-backend")]

use std::time::Duration;

use mesh_lib::backend::{MatrixBackend, MatrixLogin, MeshBackend, UserPreferences};

/// Two real Synapse homeservers, real federation, E2EE, offline catch-up, and
/// same-device session restoration. Run through `npm run test:matrix-spike`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires infra/matrix-spike"]
async fn matrix_backend_federates_and_recovers_offline_history_once() {
    macro_rules! checkpoint {
        ($message:literal) => {
            eprintln!("[matrix-spike] {}", $message);
        };
    }

    let nonce = uuid::Uuid::new_v4().to_string();
    let alice_store = tempfile::tempdir().unwrap();
    let bob_store = tempfile::tempdir().unwrap();
    let alice_profile = format!("matrix-spike-alice-{nonce}");
    let bob_profile = format!("matrix-spike-bob-{nonce}");

    let alice = MatrixBackend::with_profile(alice_store.path().to_owned(), &alice_profile);
    let bob = MatrixBackend::with_profile(bob_store.path().to_owned(), &bob_profile);

    alice
        .login(MatrixLogin {
            homeserver: "http://localhost:8008".into(),
            username: "alice".into(),
            password: "mesh-alice".into(),
            device_name: Some("Mesh spike Alice".into()),
        })
        .await
        .unwrap();
    bob.login(MatrixLogin {
        homeserver: "http://localhost:8009".into(),
        username: "bob".into(),
        password: "mesh-bob".into(),
        device_name: Some("Mesh spike Bob".into()),
    })
    .await
    .unwrap();
    checkpoint!("both users authenticated");

    let alice_user = "@alice:hs1.mesh.test".to_owned();
    let bob_user = "@bob:hs2.mesh.test".to_owned();
    if alice.dm_blocked(bob_user.clone()).await.unwrap() {
        assert!(!alice.set_dm_blocked(bob_user.clone(), false).await.unwrap());
    }
    let alice_dm = alice.ensure_dm(bob_user.clone()).await.unwrap();
    let mut bob_joined_dm = false;
    for _ in 0..20 {
        bob.sync_once().await.unwrap();
        if bob.join_room(alice_dm.id.clone()).await.is_ok() {
            bob_joined_dm = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(bob_joined_dm, "Bob never received the federated DM invite");
    bob.sync_once().await.unwrap();
    let bob_dm = bob.ensure_dm(alice_user.clone()).await.unwrap();
    assert_eq!(bob_dm.id, alice_dm.id);
    checkpoint!("federated encrypted DM room discovered and joined");

    let dm_body = format!("dm-online-{nonce}");
    let dm_message = alice
        .send_dm(bob_user.clone(), dm_body.clone(), None)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    bob.sync_once().await.unwrap();
    let bob_dm_messages = bob
        .dm_messages(alice_dm.id.clone(), 20, None, None)
        .await
        .unwrap();
    assert!(bob_dm_messages
        .iter()
        .any(|message| { message.id == dm_message.id && message.content == dm_body }));

    let dm_reply_body = format!("dm-reply-{nonce}");
    let dm_reply = bob
        .send_dm(
            alice_user.clone(),
            dm_reply_body.clone(),
            Some(dm_message.id.clone()),
        )
        .await
        .unwrap();
    assert_eq!(
        dm_reply.reply_to_id.as_deref(),
        Some(dm_message.id.as_str())
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    alice.sync_once().await.unwrap();
    let edited_dm_body = format!("dm-edited-{nonce}");
    alice
        .edit_message(
            alice_dm.id.clone(),
            dm_message.id.clone(),
            edited_dm_body.clone(),
        )
        .await
        .unwrap();
    alice
        .toggle_reaction(alice_dm.id.clone(), dm_reply.id.clone(), "thumbsup".into())
        .await
        .unwrap();
    alice.mark_dm_read(alice_dm.id.clone()).await.unwrap();
    alice.set_typing(alice_dm.id.clone(), true).await.unwrap();
    let mut saw_alice_dm_typing = false;
    for _ in 0..20 {
        let typing_users = bob.typing_users(alice_dm.id.clone()).await.unwrap();
        if typing_users.iter().any(|user| user.user_id == alice_user) {
            saw_alice_dm_typing = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(saw_alice_dm_typing);
    alice.set_typing(alice_dm.id.clone(), false).await.unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    bob.sync_once().await.unwrap();
    let bob_dm_messages = bob
        .dm_messages(alice_dm.id.clone(), 20, None, None)
        .await
        .unwrap();
    assert!(bob_dm_messages.iter().any(|message| {
        message.id == dm_message.id
            && message.content == edited_dm_body
            && message.edited_at.is_some()
    }));
    assert!(bob_dm_messages.iter().any(|message| {
        message.id == dm_reply.id
            && message.reply_to_id.as_deref() == Some(dm_message.id.as_str())
            && message
                .reactions
                .get("thumbsup")
                .is_some_and(|authors| authors.iter().any(|author| author == &alice_user))
    }));

    assert!(!alice.dm_blocked(bob_user.clone()).await.unwrap());
    assert!(alice.set_dm_blocked(bob_user.clone(), true).await.unwrap());
    assert!(alice.dm_blocked(bob_user.clone()).await.unwrap());
    assert!(alice
        .send_dm(bob_user.clone(), "blocked-dm".into(), None)
        .await
        .is_err());
    assert!(!alice.set_dm_blocked(bob_user.clone(), false).await.unwrap());
    assert!(!alice.dm_blocked(bob_user.clone()).await.unwrap());
    checkpoint!(
        "DM history, replies, edits, reactions, receipts, typing, and block controls verified"
    );

    let community = alice
        .create_community(
            format!("Federated spike {nonce}"),
            "Two homeserver acceptance test".into(),
        )
        .await
        .unwrap();
    alice.sync_once().await.unwrap();
    let community_alias = format!("#mesh-{nonce}:hs1.mesh.test");
    let access_settings = alice
        .update_community_access(
            community.space_id.clone(),
            Some(community_alias.clone()),
            true,
        )
        .await
        .unwrap();
    assert_eq!(
        access_settings.alias.as_deref(),
        Some(community_alias.as_str())
    );
    assert!(access_settings.discoverable);
    assert_eq!(access_settings.join_rule, "knock");

    let mut directory = Vec::new();
    for _ in 0..10 {
        directory = bob
            .search_community_directory(
                format!("Federated spike {nonce}"),
                Some("hs1.mesh.test".into()),
                20,
            )
            .await
            .unwrap();
        if directory
            .iter()
            .any(|entry| entry.alias.as_deref() == Some(community_alias.as_str()))
        {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert!(directory.iter().any(|entry| {
        entry.id == community.space_id
            && entry.alias.as_deref() == Some(community_alias.as_str())
            && entry.join_rule == "knock"
    }));

    let access_request = bob
        .knock_community(
            community_alias.clone(),
            Some("Live federation application".into()),
        )
        .await
        .unwrap();
    assert_eq!(access_request.status, "knocked");
    assert!(access_request.community.is_none());

    let mut applications = Vec::new();
    for _ in 0..10 {
        alice.sync_once().await.unwrap();
        applications = alice
            .list_community_applications(community.space_id.clone())
            .await
            .unwrap();
        if applications
            .iter()
            .any(|application| application.user_id == bob_user)
        {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert!(applications.iter().any(|application| {
        application.user_id == bob_user
            && application.reason.as_deref() == Some("Live federation application")
    }));
    alice
        .respond_community_application(community.space_id.clone(), bob_user.clone(), true, None)
        .await
        .unwrap();
    bob.sync_once().await.unwrap();

    let joined = bob
        .knock_community(community_alias.clone(), None)
        .await
        .unwrap();
    checkpoint!("directory discovery, knock approval, and coordinated join completed");
    assert_eq!(joined.status, "joined");
    assert_eq!(
        joined
            .community
            .as_ref()
            .map(|community| community.id.as_str()),
        Some(community.space_id.as_str())
    );
    bob.sync_once().await.unwrap();

    let alice_communities = alice.list_communities().await.unwrap();
    assert!(alice_communities
        .iter()
        .any(|item| item.id == community.space_id));
    let bob_communities = bob.list_communities().await.unwrap();
    assert!(bob_communities
        .iter()
        .any(|item| item.id == community.space_id));
    let bob_channels = bob.list_channels(community.space_id.clone()).await.unwrap();
    assert!(bob_channels
        .iter()
        .any(|item| item.id == community.channel_id));
    let alice_members = alice
        .list_members(community.space_id.clone())
        .await
        .unwrap();
    assert!(alice_members.iter().any(|member| {
        member.public_key == bob_user
            && member.join_status == "joined"
            && member.ban_status == "none"
    }));
    checkpoint!("federated community, channel, and roster projections verified");

    alice
        .update_member_role(community.space_id.clone(), bob_user.clone(), "admin".into())
        .await
        .unwrap();
    let updated_name = format!("Federated community {nonce}");
    let updated_description = "Matrix-native community orchestration".to_owned();
    alice
        .update_community(
            community.space_id.clone(),
            updated_name.clone(),
            updated_description.clone(),
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    bob.sync_once().await.unwrap();
    let bob_members = bob.list_members(community.space_id.clone()).await.unwrap();
    assert!(bob_members
        .iter()
        .any(|member| member.public_key == bob_user && member.role == "admin"));
    let bob_communities = bob.list_communities().await.unwrap();
    assert!(bob_communities.iter().any(|item| {
        item.id == community.space_id
            && item.name == updated_name
            && item.description == updated_description
    }));
    checkpoint!("power levels and Space metadata propagated");

    let extra_channel = alice
        .create_channel(
            community.space_id.clone(),
            format!("architecture-{nonce}"),
            "text".into(),
        )
        .await
        .unwrap();
    assert_eq!(extra_channel.community_id, community.space_id);

    let online_body = format!("online-{nonce}");
    let online_message = alice
        .send_message(community.channel_id.clone(), online_body.clone(), None)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    bob.sync_once().await.unwrap();
    assert!(bob
        .recent_texts(community.channel_id.clone(), 20)
        .await
        .unwrap()
        .contains(&online_body));
    let bob_messages = bob
        .messages(community.channel_id.clone(), 20, None, None)
        .await
        .unwrap();
    assert!(bob_messages
        .iter()
        .any(|message| { message.id == online_message.id && message.content == online_body }));
    checkpoint!("encrypted federated message delivered");

    let legacy_body = format!("legacy-import-{nonce}");
    let legacy_entity_id = format!("legacy-message-{nonce}");
    alice
        .import_legacy_event(
            community.channel_id.clone(),
            serde_json::json!({
                "schemaVersion": 1,
                "planSha256": "matrix-spike-plan",
                "conflictKey": format!("message:legacy-community:legacy-channel:{legacy_entity_id}"),
                "conflictStatus": "not_divergent",
                "selectedRecordSha256": null,
                "sourcePeerIds": ["legacy-peer"],
                "sourceArchiveIds": ["legacy-archive"],
                "record": {
                    "kind": "message",
                    "entityId": legacy_entity_id,
                    "communityId": "legacy-community",
                    "parentId": "legacy-channel",
                    "sourcePeerId": "legacy-peer",
                    "observedAt": "2026-07-22T00:00:00Z",
                    "originalTimestamp": "2020-01-02T03:04:05Z",
                    "originalSignature": "legacy-signature",
                    "recordSha256": "legacy-record-hash",
                    "payload": {
                        "authorPublicKey": "legacy-author",
                        "authorDisplayName": "Legacy member",
                        "authorAvatarColor": "#123456",
                        "content": legacy_body,
                        "attachments": [],
                        "reactions": {}
                    }
                }
            }),
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    bob.sync_once().await.unwrap();
    assert!(bob
        .messages(community.channel_id.clone(), 50, None, None)
        .await
        .unwrap()
        .iter()
        .any(|message| {
            message.content == legacy_body
                && message.author_public_key == "legacy-author"
                && message.signature == "legacy-signature"
                && message.timestamp == "2020-01-02T03:04:05Z"
        }));
    checkpoint!("encrypted legacy provenance event federated and projected");

    let reply_body = format!("reply-{nonce}");
    let reply = bob
        .send_message(
            community.channel_id.clone(),
            reply_body.clone(),
            Some(online_message.id.clone()),
        )
        .await
        .unwrap();
    assert_eq!(
        reply.reply_to_id.as_deref(),
        Some(online_message.id.as_str())
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    alice.sync_once().await.unwrap();
    let alice_messages = alice
        .messages(community.channel_id.clone(), 20, None, None)
        .await
        .unwrap();
    assert!(alice_messages.iter().any(|message| {
        message.id == reply.id
            && message.content == reply_body
            && message.reply_to_id.as_deref() == Some(online_message.id.as_str())
    }));

    let edited_body = format!("edited-{nonce}");
    alice
        .edit_message(
            community.channel_id.clone(),
            online_message.id.clone(),
            edited_body.clone(),
        )
        .await
        .unwrap();
    alice
        .toggle_reaction(
            community.channel_id.clone(),
            reply.id.clone(),
            "thumbsup".into(),
        )
        .await
        .unwrap();
    alice.mark_read(community.channel_id.clone()).await.unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    bob.sync_once().await.unwrap();
    let bob_messages = bob
        .messages(community.channel_id.clone(), 20, None, None)
        .await
        .unwrap();
    assert!(bob_messages.iter().any(|message| {
        message.id == online_message.id
            && message.content == edited_body
            && message.edited_at.is_some()
    }));
    assert!(bob_messages.iter().any(|message| {
        message.id == reply.id
            && message.reactions.get("thumbsup").is_some_and(|authors| {
                authors
                    .iter()
                    .any(|author| author == "@alice:hs1.mesh.test")
            })
    }));
    alice
        .set_typing(community.channel_id.clone(), true)
        .await
        .unwrap();
    let mut saw_alice_typing = false;
    for _ in 0..20 {
        let typing_users = bob
            .typing_users(community.channel_id.clone())
            .await
            .unwrap();
        if typing_users
            .iter()
            .any(|user| user.user_id == "@alice:hs1.mesh.test")
        {
            saw_alice_typing = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(saw_alice_typing);
    alice
        .set_typing(community.channel_id.clone(), false)
        .await
        .unwrap();
    checkpoint!("relations, receipts, and typing verified");

    let search_results = alice
        .search_messages(community.space_id.clone(), edited_body.clone(), 20)
        .await
        .unwrap();
    assert!(search_results
        .iter()
        .any(|message| message.id == online_message.id));

    let update_body = format!("subscription-{nonce}");
    let (updated, sent) = tokio::join!(
        alice.wait_for_room_update(community.channel_id.clone(), 10_000),
        async {
            tokio::time::sleep(Duration::from_millis(250)).await;
            bob.send_message(community.channel_id.clone(), update_body, None)
                .await
        }
    );
    assert!(updated.unwrap());
    sent.unwrap();

    alice
        .redact_message(community.channel_id.clone(), online_message.id.clone())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    bob.sync_once().await.unwrap();
    let after_redaction = bob
        .messages(community.channel_id.clone(), 20, None, None)
        .await
        .unwrap();
    assert!(!after_redaction
        .iter()
        .any(|message| { message.id == online_message.id && !message.content.is_empty() }));
    checkpoint!("subscription and redaction verified");

    bob.pause_sync().await;
    let missed_body = format!("missed-{nonce}");
    alice
        .send_text(community.channel_id.clone(), missed_body.clone())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;

    bob.sync_once().await.unwrap();
    let recovered = bob
        .recent_texts(community.channel_id.clone(), 50)
        .await
        .unwrap();
    assert_eq!(
        recovered
            .iter()
            .filter(|body| *body == &missed_body)
            .count(),
        1
    );
    checkpoint!("offline catch-up verified");

    let recovery_passphrase = format!("mesh-recovery-{nonce}");
    let recovery_key = bob
        .enable_recovery(Some(recovery_passphrase))
        .await
        .unwrap();

    let bob_second_store = tempfile::tempdir().unwrap();
    let bob_second = MatrixBackend::with_profile(
        bob_second_store.path().to_owned(),
        format!("matrix-spike-bob-second-{nonce}"),
    );
    bob_second
        .login(MatrixLogin {
            homeserver: "http://localhost:8009".into(),
            username: "bob".into(),
            password: "mesh-bob".into(),
            device_name: Some("Mesh spike Bob second device".into()),
        })
        .await
        .unwrap();
    bob_second.recover(recovery_key).await.unwrap();
    bob_second.sync_once().await.unwrap();
    checkpoint!("second device authenticated and recovery imported");

    let mut second_device_texts = Vec::new();
    for _ in 0..10 {
        second_device_texts = bob_second
            .recent_texts(community.channel_id.clone(), 50)
            .await
            .unwrap();
        if second_device_texts.contains(&missed_body) {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert!(second_device_texts.contains(&missed_body));
    checkpoint!("second device decrypted historical message");

    let second_device_dm = bob_second
        .dm_conversations()
        .await
        .unwrap()
        .into_iter()
        .find(|conversation| conversation.peer_public_key == alice_user)
        .expect("recovered second device should rediscover the Matrix DM");
    assert_eq!(second_device_dm.id, alice_dm.id);

    let mut second_device_dm_messages = Vec::new();
    for _ in 0..10 {
        second_device_dm_messages = bob_second
            .dm_messages(second_device_dm.id.clone(), 20, None, None)
            .await
            .unwrap();
        let decrypted_original = second_device_dm_messages.iter().any(|message| {
            message.id == dm_message.id
                && message.content == edited_dm_body
                && message.edited_at.is_some()
        });
        let decrypted_reply = second_device_dm_messages.iter().any(|message| {
            message.id == dm_reply.id
                && message.content == dm_reply_body
                && message.reply_to_id.as_deref() == Some(dm_message.id.as_str())
        });
        if decrypted_original && decrypted_reply {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert!(
        second_device_dm_messages.iter().any(|message| {
            message.id == dm_message.id
                && message.content == edited_dm_body
                && message.edited_at.is_some()
        }),
        "recovered second device did not decrypt the edited DM history"
    );
    assert!(
        second_device_dm_messages.iter().any(|message| {
            message.id == dm_reply.id
                && message.content == dm_reply_body
                && message.reply_to_id.as_deref() == Some(dm_message.id.as_str())
        }),
        "recovered second device did not decrypt the DM reply history"
    );
    checkpoint!("second device rediscovered and decrypted the historical DM");

    let saved_preferences = bob
        .update_user_preferences(UserPreferences {
            schema_version: 0,
            notifications_enabled: false,
            notification_sound: true,
            muted_channels: vec![community.channel_id.clone(), community.channel_id.clone()],
            muted_communities: vec![community.space_id.clone()],
            updated_at: String::new(),
        })
        .await
        .unwrap();
    assert_eq!(saved_preferences.schema_version, 1);
    assert_eq!(saved_preferences.muted_channels.len(), 1);

    let second_device_preferences = bob_second.user_preferences().await.unwrap().unwrap();
    assert_eq!(second_device_preferences, saved_preferences);
    checkpoint!("Matrix account-data preferences propagated across devices");

    bob.pause_sync().await;
    drop(bob);
    let restored = MatrixBackend::with_profile(bob_store.path().to_owned(), &bob_profile);
    restored.restore_session().await.unwrap();
    let after_restore = restored
        .recent_texts(community.channel_id.clone(), 50)
        .await
        .unwrap();
    assert_eq!(
        after_restore
            .iter()
            .filter(|body| *body == &missed_body)
            .count(),
        1
    );
    checkpoint!("same-device session restoration verified");

    bob_second
        .leave_community(community.space_id.clone())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    alice
        .ban_member(
            community.space_id.clone(),
            bob_user.clone(),
            Some("Matrix moderation acceptance test".into()),
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    alice.sync_once().await.unwrap();
    let final_members = alice
        .list_members(community.space_id.clone())
        .await
        .unwrap();
    assert!(final_members.iter().any(|member| {
        member.public_key == bob_user
            && member.join_status == "left"
            && member.ban_status == "banned"
    }));
    checkpoint!("leave and coordinated ban verified");

    alice.logout().await.unwrap();
    restored.logout().await.unwrap();
    bob_second.logout().await.unwrap();
}
