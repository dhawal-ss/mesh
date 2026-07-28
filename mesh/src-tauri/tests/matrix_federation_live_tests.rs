#![cfg(feature = "matrix-backend")]

use std::{
    io::{Cursor, Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::Command,
    time::Duration,
};

use matrix_sdk::{
    config::SyncSettings,
    ruma::{
        events::{
            fully_read::FullyReadEventContent,
            receipt::{ReceiptThread, ReceiptType},
        },
        presence::PresenceState,
        RoomId, UserId,
    },
    Client,
};
use mesh_lib::backend::{
    MatrixBackend, MatrixLogin, MatrixRoomNotificationMode, MeshBackend, UserPreferences,
};

struct PausedSynapse {
    compose_root: PathBuf,
    active: bool,
}

impl PausedSynapse {
    fn stop_first_homeserver() -> Self {
        let compose_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../infra/matrix-spike");
        let status = Command::new("docker")
            .args(["compose", "stop", "synapse1"])
            .current_dir(&compose_root)
            .status()
            .expect("docker compose must be available for the Matrix spike");
        assert!(status.success(), "failed to stop the first test homeserver");
        Self {
            compose_root,
            active: true,
        }
    }

    fn resume(&mut self) {
        let status = Command::new("docker")
            .args(["compose", "start", "synapse1"])
            .current_dir(&self.compose_root)
            .status()
            .expect("docker compose must be available for the Matrix spike");
        assert!(
            status.success(),
            "failed to restart the first test homeserver"
        );
        self.active = false;
    }
}

impl Drop for PausedSynapse {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let _ = Command::new("docker")
            .args(["compose", "start", "synapse1"])
            .current_dir(&self.compose_root)
            .status();
    }
}

fn homeserver_ready(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(
            b"GET /_matrix/client/versions HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok() && response.starts_with("HTTP/1.1 200")
}

async fn wait_for_homeserver(port: u16, expected_ready: bool) {
    for _ in 0..120 {
        if homeserver_ready(port) == expected_ready {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!(
        "homeserver on port {port} did not become {}",
        if expected_ready {
            "ready"
        } else {
            "unavailable"
        }
    );
}

fn privacy_preferences(
    send_read_receipts: bool,
    send_typing_indicators: bool,
    share_presence: bool,
    invisible_mode: bool,
) -> UserPreferences {
    UserPreferences {
        schema_version: UserPreferences::SCHEMA_VERSION,
        notifications_enabled: true,
        notification_sound: true,
        notification_sound_id: Some("mesh".into()),
        do_not_disturb: false,
        quiet_hours_enabled: false,
        quiet_hours_start: Some("22:00".into()),
        quiet_hours_end: Some("08:00".into()),
        muted_channels: Vec::new(),
        muted_communities: Vec::new(),
        muted_channel_until: std::collections::HashMap::new(),
        muted_community_until: std::collections::HashMap::new(),
        channel_notification_levels: std::collections::HashMap::new(),
        send_read_receipts,
        send_typing_indicators,
        share_presence,
        invisible_mode,
        updated_at: String::new(),
    }
}

async fn wait_for_member_presence(
    observer: &MatrixBackend,
    community_id: &str,
    user_id: &str,
    expected_online: bool,
) -> bool {
    for _ in 0..20 {
        observer.sync_once().await.unwrap();
        if observer
            .list_members(community_id.to_owned())
            .await
            .unwrap()
            .iter()
            .find(|member| member.public_key == user_id)
            .is_some_and(|member| member.online == expected_online)
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    false
}

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
    let bob_stale_store = tempfile::tempdir().unwrap();
    let charlie_store = tempfile::tempdir().unwrap();
    let alice_profile = format!("matrix-spike-alice-{nonce}");
    let bob_profile = format!("matrix-spike-bob-{nonce}");
    let bob_stale_profile = format!("matrix-spike-bob-stale-{nonce}");
    let charlie_profile = format!("matrix-spike-charlie-{nonce}");

    let alice = MatrixBackend::with_profile(alice_store.path().to_owned(), &alice_profile);
    let bob = MatrixBackend::with_profile(bob_store.path().to_owned(), &bob_profile);
    let bob_stale =
        MatrixBackend::with_profile(bob_stale_store.path().to_owned(), &bob_stale_profile);
    let charlie = MatrixBackend::with_profile(charlie_store.path().to_owned(), &charlie_profile);

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
    let charlie_user = "@charlie:hs1.mesh.test".to_owned();
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

    bob_stale
        .login(MatrixLogin {
            homeserver: "http://localhost:8009".into(),
            username: "bob".into(),
            password: "mesh-bob".into(),
            device_name: Some("Mesh spike Bob stale device".into()),
        })
        .await
        .unwrap();
    bob_stale.pause_sync().await;
    charlie
        .login(MatrixLogin {
            homeserver: "http://localhost:8008".into(),
            username: "charlie".into(),
            password: "mesh-charlie".into(),
            device_name: Some("Mesh spike Charlie".into()),
        })
        .await
        .unwrap();

    let bob_charlie_dm = bob.ensure_dm(charlie_user.clone()).await.unwrap();
    let stale_created_dm = bob_stale.ensure_dm(charlie_user.clone()).await.unwrap();
    bob.sync_once().await.unwrap();
    bob_stale.sync_once().await.unwrap();

    let bob_after_stale_write = bob.dm_conversations().await.unwrap();
    assert!(
        bob_after_stale_write
            .iter()
            .any(|conversation| conversation.id == bob_charlie_dm.id),
        "a stale device erased the valid Charlie DM mapping"
    );
    let stale_after_reconciliation = bob_stale.dm_conversations().await.unwrap();
    assert!(
        stale_after_reconciliation
            .iter()
            .any(|conversation| conversation.id == bob_charlie_dm.id),
        "the stale device did not receive the preserved Charlie DM mapping"
    );

    let canonical_dm = bob.ensure_dm(charlie_user.clone()).await.unwrap();
    let expected_canonical = [bob_charlie_dm.id, stale_created_dm.id]
        .into_iter()
        .min()
        .unwrap();
    assert_eq!(canonical_dm.id, expected_canonical);
    checkpoint!("stale-device m.direct write preserved and reconciled every valid mapping");

    let dm_body = format!("dm-online-{nonce}");
    let dm_message = alice
        .send_dm(
            bob_user.clone(),
            dm_body.clone(),
            None,
            uuid::Uuid::new_v4().to_string(),
        )
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
            uuid::Uuid::new_v4().to_string(),
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

    let alice_observer = Client::builder()
        .homeserver_url("http://localhost:8008")
        .build()
        .await
        .unwrap();
    alice_observer
        .matrix_auth()
        .login_username("alice", "mesh-alice")
        .initial_device_display_name("Mesh privacy observer")
        .send()
        .await
        .unwrap();
    alice_observer
        .sync_once(
            SyncSettings::default()
                .timeout(Duration::ZERO)
                .set_presence(PresenceState::Offline),
        )
        .await
        .unwrap();
    let observer_dm = alice_observer
        .get_room(&RoomId::parse(&alice_dm.id).unwrap())
        .expect("privacy observer did not receive the DM room");
    assert!(
        observer_dm
            .account_data_static::<FullyReadEventContent>()
            .await
            .unwrap()
            .is_some(),
        "read-receipt opt-out did not preserve the private fully-read marker"
    );
    let alice_user_id = UserId::parse(&alice_user).unwrap();
    assert!(
        observer_dm
            .load_user_receipt(
                ReceiptType::ReadPrivate,
                ReceiptThread::Unthreaded,
                &alice_user_id,
            )
            .await
            .unwrap()
            .is_none(),
        "read-receipt opt-out emitted a private receipt"
    );

    alice.set_typing(alice_dm.id.clone(), true).await.unwrap();
    let mut leaked_disabled_typing = false;
    for _ in 0..10 {
        let typing_users = bob.typing_users(alice_dm.id.clone()).await.unwrap();
        if typing_users.iter().any(|user| user.user_id == alice_user) {
            leaked_disabled_typing = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(
        !leaked_disabled_typing,
        "typing opt-out emitted a federated typing event"
    );

    alice
        .update_user_preferences(privacy_preferences(true, true, true, false))
        .await
        .unwrap();
    alice.mark_dm_read(alice_dm.id.clone()).await.unwrap();
    let mut private_receipt = None;
    for _ in 0..10 {
        alice_observer
            .sync_once(
                SyncSettings::default()
                    .timeout(Duration::ZERO)
                    .set_presence(PresenceState::Offline),
            )
            .await
            .unwrap();
        private_receipt = observer_dm
            .load_user_receipt(
                ReceiptType::ReadPrivate,
                ReceiptThread::Unthreaded,
                &alice_user_id,
            )
            .await
            .unwrap();
        if private_receipt.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(
        private_receipt.is_some(),
        "enabled private read receipt did not reach the user's second device"
    );

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
    alice
        .update_user_preferences(privacy_preferences(true, false, true, false))
        .await
        .unwrap();
    let mut typing_cleared_after_opt_out = false;
    for _ in 0..20 {
        let typing_users = bob.typing_users(alice_dm.id.clone()).await.unwrap();
        if typing_users.iter().all(|user| user.user_id != alice_user) {
            typing_cleared_after_opt_out = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(
        typing_cleared_after_opt_out,
        "typing opt-out did not clear a previously sent typing notice"
    );
    alice
        .update_user_preferences(privacy_preferences(true, true, true, false))
        .await
        .unwrap();
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
        .send_dm(
            bob_user.clone(),
            "blocked-dm".into(),
            None,
            uuid::Uuid::new_v4().to_string(),
        )
        .await
        .is_err());
    assert!(!alice.set_dm_blocked(bob_user.clone(), false).await.unwrap());
    assert!(!alice.dm_blocked(bob_user.clone()).await.unwrap());
    checkpoint!("DM history, relations, privacy-controlled receipts/typing, and blocks verified");

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

    assert!(
        wait_for_member_presence(&bob, &community.space_id, &alice_user, true).await,
        "presence sharing did not publish Alice as online"
    );
    alice
        .update_user_preferences(privacy_preferences(true, true, true, true))
        .await
        .unwrap();
    assert!(
        wait_for_member_presence(&bob, &community.space_id, &alice_user, false).await,
        "invisible mode did not publish Alice as offline"
    );
    alice
        .update_user_preferences(privacy_preferences(true, true, true, false))
        .await
        .unwrap();
    assert!(
        wait_for_member_presence(&bob, &community.space_id, &alice_user, true).await,
        "disabling invisible mode did not restore Alice's online presence"
    );
    alice
        .update_user_preferences(privacy_preferences(true, true, false, false))
        .await
        .unwrap();
    assert!(
        wait_for_member_presence(&bob, &community.space_id, &alice_user, false).await,
        "presence opt-out did not publish Alice as offline"
    );
    alice
        .update_user_preferences(privacy_preferences(true, true, true, false))
        .await
        .unwrap();
    assert!(
        wait_for_member_presence(&bob, &community.space_id, &alice_user, true).await,
        "restoring presence sharing did not publish Alice as online"
    );
    checkpoint!("presence sharing and invisible-mode wire behavior verified");

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

    let emoji_shortcode = format!("party_{}", &nonce[..8]);
    let mut emoji_source = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(64, 32)
        .write_to(&mut emoji_source, image::ImageFormat::Png)
        .unwrap();
    let uploaded_emoji = alice
        .upload_custom_emoji(
            community.space_id.clone(),
            emoji_shortcode.clone(),
            "party.png".into(),
            "image/png".into(),
            emoji_source.into_inner(),
        )
        .await
        .unwrap();
    assert_eq!(uploaded_emoji.shortcode, emoji_shortcode);
    alice.sync_once().await.unwrap();

    let mut bob_emoji = Vec::new();
    for _ in 0..20 {
        bob.sync_once().await.unwrap();
        bob_emoji = bob
            .list_custom_emoji(community.space_id.clone())
            .await
            .unwrap();
        if bob_emoji
            .iter()
            .any(|emoji| emoji.shortcode == emoji_shortcode)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(bob_emoji
        .iter()
        .any(|emoji| emoji.shortcode == emoji_shortcode));
    let federated_emoji = bob
        .load_custom_emoji_image(community.space_id.clone(), emoji_shortcode.clone())
        .await
        .unwrap();
    assert!(federated_emoji.starts_with(b"\x89PNG\r\n\x1a\n"));

    let emoji_body = format!("federated :{emoji_shortcode}:");
    bob.send_message(
        community.channel_id.clone(),
        emoji_body.clone(),
        None,
        uuid::Uuid::new_v4().to_string(),
    )
    .await
    .unwrap();
    let mut emoji_message = None;
    for _ in 0..30 {
        alice.sync_once().await.unwrap();
        emoji_message = alice
            .messages(community.channel_id.clone(), 20, None, None)
            .await
            .unwrap()
            .into_iter()
            .find(|message| message.content == emoji_body);
        if emoji_message.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let emoji_message = emoji_message.expect("custom emoji message did not federate");
    let reaction_key = format!(":{emoji_shortcode}:");
    alice
        .toggle_reaction(
            community.channel_id.clone(),
            emoji_message.id.clone(),
            reaction_key.clone(),
        )
        .await
        .unwrap();
    let mut reaction_federated = false;
    for _ in 0..20 {
        bob.sync_once().await.unwrap();
        reaction_federated = bob
            .messages(community.channel_id.clone(), 20, None, None)
            .await
            .unwrap()
            .iter()
            .any(|message| {
                message.id == emoji_message.id
                    && message
                        .reactions
                        .get(&reaction_key)
                        .is_some_and(|users| users.iter().any(|user| user == &alice_user))
            });
        if reaction_federated {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(reaction_federated);
    checkpoint!("custom emoji state, media, message, and reaction federated");

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
    let online_request_id = uuid::Uuid::new_v4().to_string();
    let queued_online_message = alice
        .send_message(
            community.channel_id.clone(),
            online_body.clone(),
            None,
            online_request_id.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        queued_online_message.delivery_status.as_deref(),
        Some("pending")
    );
    assert_eq!(
        queued_online_message.client_request_id.as_deref(),
        Some(online_request_id.as_str())
    );
    assert!(queued_online_message.transaction_id.is_some());

    let mut online_message = None;
    for _ in 0..30 {
        bob.sync_once().await.unwrap();
        online_message = bob
            .messages(community.channel_id.clone(), 20, None, None)
            .await
            .unwrap()
            .into_iter()
            .find(|message| message.content == online_body);
        if online_message.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let online_message = online_message.expect("durable online message did not federate");
    assert_eq!(
        online_message.client_request_id.as_deref(),
        Some(online_request_id.as_str())
    );
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
    let reply_request_id = uuid::Uuid::new_v4().to_string();
    let queued_reply = bob
        .send_message(
            community.channel_id.clone(),
            reply_body.clone(),
            Some(online_message.id.clone()),
            reply_request_id.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        queued_reply.reply_to_id.as_deref(),
        Some(online_message.id.as_str())
    );
    assert_eq!(
        queued_reply.client_request_id.as_deref(),
        Some(reply_request_id.as_str())
    );
    let mut reply = None;
    for _ in 0..30 {
        alice.sync_once().await.unwrap();
        reply = alice
            .messages(community.channel_id.clone(), 20, None, None)
            .await
            .unwrap()
            .into_iter()
            .find(|message| {
                message.content == reply_body
                    && message.reply_to_id.as_deref() == Some(online_message.id.as_str())
            });
        if reply.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let reply = reply.expect("durable reply did not federate");
    assert_eq!(
        reply.client_request_id.as_deref(),
        Some(reply_request_id.as_str())
    );

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
            bob.send_message(
                community.channel_id.clone(),
                update_body,
                None,
                uuid::Uuid::new_v4().to_string(),
            )
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

    let mut paused_synapse = PausedSynapse::stop_first_homeserver();
    wait_for_homeserver(8008, false).await;
    let offline_body = format!("durable-offline-{nonce}");
    let offline_request_id = uuid::Uuid::new_v4().to_string();
    let offline_message = tokio::time::timeout(
        Duration::from_secs(5),
        alice.send_message(
            community.channel_id.clone(),
            offline_body.clone(),
            None,
            offline_request_id.clone(),
        ),
    )
    .await
    .expect("saving an offline message must not wait for the network")
    .unwrap();
    assert_eq!(offline_message.delivery_status.as_deref(), Some("pending"));
    assert_eq!(
        offline_message.client_request_id.as_deref(),
        Some(offline_request_id.as_str())
    );
    let offline_transaction_id = offline_message
        .transaction_id
        .clone()
        .expect("durable local echo must expose its SDK transaction");

    let duplicate = alice
        .send_message(
            community.channel_id.clone(),
            offline_body.clone(),
            None,
            offline_request_id.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        duplicate.transaction_id.as_deref(),
        Some(offline_transaction_id.as_str()),
        "retrying a lost IPC response created a second local echo"
    );
    let queued_before_restart = alice.queued_messages().await.unwrap();
    assert_eq!(
        queued_before_restart
            .iter()
            .filter(|message| {
                message.channel_id == community.channel_id
                    && message.client_request_id.as_deref() == Some(offline_request_id.as_str())
            })
            .count(),
        1
    );
    bob.sync_once().await.unwrap();
    assert!(!bob
        .messages(community.channel_id.clone(), 100, None, None)
        .await
        .unwrap()
        .iter()
        .any(|message| message.content == offline_body));

    alice.shutdown_for_test().await;
    drop(alice);
    let alice = MatrixBackend::with_profile(alice_store.path().to_owned(), &alice_profile);
    tokio::time::timeout(Duration::from_secs(20), alice.restore_session())
        .await
        .expect("offline encrypted session restoration exceeded its bounded window")
        .unwrap();
    let queued_after_restart = alice.queued_messages().await.unwrap();
    let restored_echo = queued_after_restart
        .iter()
        .find(|message| {
            message.channel_id == community.channel_id
                && message.client_request_id.as_deref() == Some(offline_request_id.as_str())
        })
        .expect("restart lost the encrypted durable local echo");
    assert_eq!(
        restored_echo.transaction_id.as_deref(),
        Some(offline_transaction_id.as_str())
    );

    paused_synapse.resume();
    wait_for_homeserver(8008, true).await;
    alice.sync_once().await.unwrap();
    let mut delivered_offline = Vec::new();
    for _ in 0..40 {
        bob.sync_once().await.unwrap();
        delivered_offline = bob
            .messages(community.channel_id.clone(), 100, None, None)
            .await
            .unwrap()
            .into_iter()
            .filter(|message| message.content == offline_body)
            .collect();
        if !delivered_offline.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert_eq!(
        delivered_offline.len(),
        1,
        "the restart-safe local echo did not deliver exactly once"
    );
    assert_eq!(
        delivered_offline[0].client_request_id.as_deref(),
        Some(offline_request_id.as_str())
    );
    for _ in 0..20 {
        if alice
            .queued_messages()
            .await
            .unwrap()
            .iter()
            .all(|message| {
                message.client_request_id.as_deref() != Some(offline_request_id.as_str())
            })
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(alice
        .queued_messages()
        .await
        .unwrap()
        .iter()
        .all(|message| {
            message.client_request_id.as_deref() != Some(offline_request_id.as_str())
        }));
    checkpoint!("offline send survived restart and delivered exactly once after recovery");

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
            notification_sound_id: Some("mesh".into()),
            do_not_disturb: true,
            quiet_hours_enabled: true,
            quiet_hours_start: Some("22:00".into()),
            quiet_hours_end: Some("07:00".into()),
            muted_channels: vec![community.channel_id.clone(), community.channel_id.clone()],
            muted_communities: vec![community.space_id.clone()],
            muted_channel_until: std::collections::HashMap::from([(
                community.channel_id.clone(),
                None,
            )]),
            muted_community_until: std::collections::HashMap::from([(
                community.space_id.clone(),
                Some("2026-07-26T00:00:00Z".into()),
            )]),
            channel_notification_levels: std::collections::HashMap::from([(
                community.channel_id.clone(),
                MatrixRoomNotificationMode::Mentions,
            )]),
            send_read_receipts: false,
            send_typing_indicators: true,
            share_presence: false,
            invisible_mode: true,
            updated_at: String::new(),
        })
        .await
        .unwrap();
    assert_eq!(
        saved_preferences.schema_version,
        UserPreferences::SCHEMA_VERSION
    );
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
    bob_stale.logout().await.unwrap();
    charlie.logout().await.unwrap();
    bob_second.logout().await.unwrap();
}
