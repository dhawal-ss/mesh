#![cfg(feature = "matrix-backend")]

use std::time::Duration;

use matrix_sdk::{config::SyncSettings, ruma::presence::PresenceState, Client};

/// Real managed-service authentication check.
///
/// Run explicitly with operator-owned credentials:
/// MESH_TEST_USERNAME=... MESH_TEST_PASSWORD=... \
/// cargo test --no-default-features --features matrix-backend \
///   --test managed_homeserver_live_tests -- --ignored
#[tokio::test]
#[ignore = "requires the public managed homeserver and operator credentials"]
async fn managed_homeserver_accepts_password_login_and_initial_sync() {
    let server_name =
        std::env::var("MESH_TEST_SERVER_NAME").unwrap_or_else(|_| "mesh.dhawal.org".into());
    let homeserver = std::env::var("MESH_TEST_HOMESERVER").ok();
    let username =
        std::env::var("MESH_TEST_USERNAME").expect("MESH_TEST_USERNAME must be provided");
    let password =
        std::env::var("MESH_TEST_PASSWORD").expect("MESH_TEST_PASSWORD must be provided");

    let builder = Client::builder();
    let builder = if let Some(homeserver) = homeserver {
        builder.homeserver_url(homeserver)
    } else {
        builder.server_name_or_homeserver_url(server_name)
    };
    let client = builder
        .build()
        .await
        .expect("managed homeserver discovery must succeed");

    client
        .matrix_auth()
        .login_username(&username, &password)
        .initial_device_display_name("Mesh managed-service verification")
        .send()
        .await
        .expect("managed homeserver password login must succeed");

    let user_id = client
        .user_id()
        .expect("successful login must install a Matrix session");
    assert_eq!(user_id.localpart(), username);
    assert_eq!(user_id.server_name().as_str(), "mesh.dhawal.org");

    tokio::time::timeout(
        Duration::from_secs(30),
        client.sync_once(SyncSettings::default().set_presence(PresenceState::Offline)),
    )
    .await
    .expect("initial sync must complete before the timeout")
    .expect("initial sync must succeed");

    client
        .matrix_auth()
        .logout()
        .await
        .expect("verification device logout must succeed");
}
