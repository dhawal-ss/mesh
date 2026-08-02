#![cfg(feature = "matrix-backend")]

use std::{
    ffi::{OsStr, OsString},
    future::Future,
    io::{Cursor, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::Command,
    time::{Duration, Instant as StdInstant},
};

use matrix_sdk::{
    config::SyncSettings,
    ruma::{
        api::client::room::upgrade_room::v3::Request as UpgradeRoomRequest,
        events::{
            fully_read::FullyReadEventContent,
            receipt::{ReceiptThread, ReceiptType},
        },
        presence::PresenceState,
        RoomId, RoomVersionId, UserId,
    },
    Client,
};
use mesh_lib::backend::{
    BackendError, MatrixBackend, MatrixLogin, MatrixRegistration, MatrixRoomNotificationMode,
    MeshBackend, ReadReceiptMode, UserPreferences,
};
use tokio::time::Instant as TokioInstant;

const REGISTRATION_TEST_OUTER_LIMIT: Duration = Duration::from_secs(2 * 60);
const FEDERATION_TEST_OUTER_LIMIT: Duration = Duration::from_secs(14 * 60);

#[derive(Clone, Copy)]
struct PresenceWaitPolicy {
    total: Duration,
    sync_attempt: Duration,
    observation: Duration,
    poll: Duration,
    max_rate_limit_backoff: Duration,
    max_attempts: usize,
}

const LIVE_PRESENCE_WAIT_POLICY: PresenceWaitPolicy = PresenceWaitPolicy {
    // Five presence transitions are exercised by the live suite. Each one is
    // capped at 20 seconds, instead of nesting a 30-second sync inside 90 tries.
    // Twelve polls at this cadence cover roughly 18 seconds, so the attempt cap
    // remains useful without accidentally shrinking the wall-clock deadline.
    total: Duration::from_secs(20),
    sync_attempt: Duration::from_secs(2),
    observation: Duration::from_secs(1),
    poll: Duration::from_millis(1_500),
    max_rate_limit_backoff: Duration::from_secs(3),
    max_attempts: 12,
};

#[derive(Clone, Debug, PartialEq, Eq)]
struct MemberPresenceSnapshot {
    membership: String,
    ban_status: String,
    online: Option<bool>,
}

impl MemberPresenceSnapshot {
    fn missing() -> Self {
        Self {
            membership: "missing".into(),
            ban_status: "unknown".into(),
            online: None,
        }
    }

    fn summary(&self) -> String {
        format!(
            "membership={} ban={} online={}",
            sanitized_state_label(&self.membership),
            sanitized_state_label(&self.ban_status),
            self.online
                .map(|online| online.to_string())
                .unwrap_or_else(|| "unknown".into())
        )
    }
}

struct LiveTestRunRecord {
    test: &'static str,
    source_sha: String,
    worktree_state: &'static str,
    started: StdInstant,
    result: &'static str,
}

impl LiveTestRunRecord {
    fn start(test: &'static str, outer_limit: Duration) -> Self {
        let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let source_sha = git_output(&source_root, &["rev-parse", "HEAD"])
            .filter(|value| value.len() == 40)
            .unwrap_or_else(|| "unavailable".into());
        let worktree_state = match git_output(
            &source_root,
            &["status", "--porcelain", "--untracked-files=all"],
        ) {
            Some(value) if value.is_empty() => "clean",
            Some(_) => "dirty",
            None => "unavailable",
        };
        eprintln!(
            "[matrix-spike] run_start test={test} timestamp={} source_sha={source_sha} worktree={worktree_state} outer_deadline_seconds={}",
            chrono::Utc::now().to_rfc3339(),
            outer_limit.as_secs()
        );
        Self {
            test,
            source_sha,
            worktree_state,
            started: StdInstant::now(),
            result: "failed-or-cancelled",
        }
    }

    fn set_result(&mut self, result: &'static str) {
        self.result = result;
    }
}

impl Drop for LiveTestRunRecord {
    fn drop(&mut self) {
        eprintln!(
            "[matrix-spike] run_end test={} timestamp={} source_sha={} worktree={} elapsed_ms={} result={}",
            self.test,
            chrono::Utc::now().to_rfc3339(),
            self.source_sha,
            self.worktree_state,
            self.started.elapsed().as_millis(),
            self.result
        );
    }
}

fn git_output(source_root: &std::path::Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(source_root)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn sanitized_state_label(value: &str) -> String {
    let sanitized = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(32)
        .collect::<String>();
    if sanitized.is_empty() {
        "unknown".into()
    } else {
        sanitized
    }
}

fn sanitized_backend_error(error: &BackendError) -> &'static str {
    match error {
        BackendError::NotAuthenticated => "not-authenticated",
        BackendError::Network(_) => "network",
        BackendError::RateLimited(_) => "rate-limited",
        BackendError::PermissionDenied(_) => "permission-denied",
        BackendError::NotFound(_) => "not-found",
        BackendError::Crypto(_) => "crypto",
        BackendError::Serialization(_) => "serialization",
        BackendError::NotEncrypted(_) => "not-encrypted",
        BackendError::DecryptionFailed(_) => "decryption-failed",
        BackendError::Cancelled(_) => "cancelled",
        BackendError::Unsupported(_) => "unsupported",
        BackendError::InvalidConfiguration(_) => "invalid-configuration",
        BackendError::CommunityHomeserverUnconfigured => "community-service-unconfigured",
        BackendError::UsernameUnavailable => "username-unavailable",
        BackendError::RegistrationTermsRequired => "registration-terms-required",
        BackendError::RegistrationAdditionalAuthRequired => "registration-additional-auth-required",
        BackendError::RegistrationInvitationRequired => "registration-invitation-required",
        BackendError::RegistrationInvitationInvalid => "registration-invitation-invalid",
        BackendError::RegistrationTimedOut(_) => "registration-timed-out",
        BackendError::Other(_) => "other",
        BackendError::LoginCancelled => "login-cancelled",
        BackendError::LoginTimedOut(_) => "login-timed-out",
    }
}

fn retry_after_from_rate_limit(error: &BackendError) -> Option<Duration> {
    let BackendError::RateLimited(detail) = error else {
        return None;
    };
    parse_unsigned_after_marker(detail, "retry_after_ms").map(Duration::from_millis)
}

fn parse_unsigned_after_marker(detail: &str, marker: &str) -> Option<u64> {
    let normalized = detail.to_ascii_lowercase();
    let marker_offset = normalized.find(marker)? + marker.len();
    let suffix = &normalized[marker_offset..];
    let digits = suffix
        .trim_start_matches(|character: char| {
            character.is_ascii_whitespace() || matches!(character, '"' | '\'' | ':' | '=')
        })
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    (!digits.is_empty())
        .then(|| digits.parse::<u64>().ok())
        .flatten()
}

struct EnvironmentOverride {
    name: &'static str,
    previous: Option<OsString>,
}

impl EnvironmentOverride {
    fn new(name: &'static str, value: impl AsRef<OsStr>) -> Self {
        let previous = std::env::var_os(name);
        std::env::set_var(name, value);
        Self { name, previous }
    }
}

impl Drop for EnvironmentOverride {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.as_ref() {
            std::env::set_var(self.name, previous);
        } else {
            std::env::remove_var(self.name);
        }
    }
}

fn spawn_registration_admission_service() -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .expect("a loopback admission test listener must be available");
    let address = listener
        .local_addr()
        .expect("the admission test listener must have an address");
    listener
        .set_nonblocking(true)
        .expect("the admission test listener must support a bounded wait");
    let origin = format!("http://{address}");
    let server = std::thread::spawn(move || {
        let deadline = StdInstant::now() + Duration::from_secs(10);
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(connection) => break connection,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && StdInstant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => {
                    panic!("registration must resolve the native pending invitation: {error}")
                }
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("the admission test socket timeout must be configurable");
        let mut request = [0u8; 4_096];
        let received = stream
            .read(&mut request)
            .expect("the admission request must be readable");
        let request = String::from_utf8_lossy(&request[..received]);
        assert!(request.starts_with("POST /_mesh/admission/v1/invitations/resolve HTTP/1.1"));
        assert!(!request.contains("mesh-registration-passphrase"));

        let body = serde_json::json!({
            "version": 4,
            "registration_token": "mesh-spike-registration",
            "room_id": "!registration:hs1.mesh.test",
            "service": "http://localhost:8008",
            "via": ["hs1.mesh.test"],
            "community_name": "Registration acceptance"
        })
        .to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream
            .write_all(response.as_bytes())
            .expect("the admission response must be writable");
    });
    (origin, server)
}

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
    privacy_preferences_with_receipt_mode(
        if send_read_receipts {
            ReadReceiptMode::Private
        } else {
            ReadReceiptMode::Off
        },
        send_typing_indicators,
        share_presence,
        invisible_mode,
    )
}

fn privacy_preferences_with_receipt_mode(
    read_receipt_mode: ReadReceiptMode,
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
        show_notification_content: false,
        quiet_hours_enabled: false,
        quiet_hours_start: Some("22:00".into()),
        quiet_hours_end: Some("08:00".into()),
        muted_channels: Vec::new(),
        muted_communities: Vec::new(),
        muted_channel_until: std::collections::HashMap::new(),
        muted_community_until: std::collections::HashMap::new(),
        channel_notification_levels: std::collections::HashMap::new(),
        send_read_receipts: read_receipt_mode == ReadReceiptMode::Private,
        read_receipt_mode: Some(read_receipt_mode),
        send_typing_indicators,
        conversation_privacy: std::collections::BTreeMap::new(),
        share_presence,
        invisible_mode,
        updated_at: String::new(),
    }
}

async fn wait_for_member_presence_with<Sync, SyncFuture, Observe, ObserveFuture>(
    phase: &'static str,
    expected_online: bool,
    policy: PresenceWaitPolicy,
    mut sync: Sync,
    mut observe: Observe,
) -> Result<(), String>
where
    Sync: FnMut() -> SyncFuture,
    SyncFuture: Future<Output = Result<(), BackendError>>,
    Observe: FnMut() -> ObserveFuture,
    ObserveFuture: Future<Output = Result<MemberPresenceSnapshot, BackendError>>,
{
    let started = TokioInstant::now();
    let deadline = started + policy.total;
    let mut attempts = 0usize;
    let mut last_state = MemberPresenceSnapshot::missing();
    let mut last_error = "none".to_owned();

    eprintln!(
        "[matrix-spike] phase={phase} state=started deadline_ms={}",
        policy.total.as_millis()
    );

    while attempts < policy.max_attempts && TokioInstant::now() < deadline {
        attempts += 1;
        let remaining = deadline.saturating_duration_since(TokioInstant::now());
        if remaining.is_zero() {
            break;
        }

        let sync_budget = policy.sync_attempt.min(remaining);
        let mut retry_delay = policy.poll;
        match tokio::time::timeout(sync_budget, sync()).await {
            Ok(Ok(())) => {
                last_error = "none".into();
            }
            Ok(Err(error)) => {
                let category = sanitized_backend_error(&error);
                if let Some(server_delay) = retry_after_from_rate_limit(&error) {
                    retry_delay = server_delay.min(policy.max_rate_limit_backoff);
                    last_error = format!(
                        "{category}(server_retry_after_ms={},bounded_retry_ms={})",
                        server_delay.as_millis(),
                        retry_delay.as_millis()
                    );
                } else {
                    last_error = category.into();
                }
            }
            Err(_) => {
                last_error = format!("sync-timeout({}ms)", sync_budget.as_millis());
            }
        }

        let remaining = deadline.saturating_duration_since(TokioInstant::now());
        if remaining.is_zero() {
            break;
        }
        let observation_budget = policy.observation.min(remaining);
        match tokio::time::timeout(observation_budget, observe()).await {
            Ok(Ok(observed)) => {
                last_state = observed;
                if last_state.online == Some(expected_online) {
                    eprintln!(
                        "[matrix-spike] phase={phase} state=complete attempts={attempts} elapsed_ms={} last_observation={}",
                        started.elapsed().as_millis(),
                        last_state.summary()
                    );
                    return Ok(());
                }
            }
            Ok(Err(error)) => {
                last_error = format!("observation-{}", sanitized_backend_error(&error));
            }
            Err(_) => {
                last_error = format!("observation-timeout({}ms)", observation_budget.as_millis());
            }
        }

        eprintln!(
            "[matrix-spike] phase={phase} state=waiting attempt={attempts} elapsed_ms={} last_observation={} last_error={last_error}",
            started.elapsed().as_millis(),
            last_state.summary()
        );

        let remaining = deadline.saturating_duration_since(TokioInstant::now());
        if remaining.is_zero() {
            break;
        }
        tokio::time::sleep(retry_delay.min(remaining)).await;
    }

    Err(format!(
        "phase={phase} timed out after {}ms (attempts={attempts}, expected_online={expected_online}, last_observation={}, last_error={last_error})",
        started.elapsed().as_millis(),
        last_state.summary()
    ))
}

async fn wait_for_member_presence(
    phase: &'static str,
    observer: &MatrixBackend,
    community_id: &str,
    user_id: &str,
    expected_online: bool,
) -> Result<(), String> {
    wait_for_member_presence_with(
        phase,
        expected_online,
        LIVE_PRESENCE_WAIT_POLICY,
        || observer.sync_once(),
        || async {
            observer
                .list_members(community_id.to_owned())
                .await
                .map(|members| {
                    members
                        .iter()
                        .find(|member| member.public_key == user_id)
                        .map(|member| MemberPresenceSnapshot {
                            membership: member.join_status.clone(),
                            ban_status: member.ban_status.clone(),
                            online: Some(member.online),
                        })
                        .unwrap_or_else(MemberPresenceSnapshot::missing)
                })
        },
    )
    .await
}

#[tokio::test(start_paused = true)]
async fn member_presence_wait_reports_phase_and_last_state_when_progress_stalls() {
    let policy = PresenceWaitPolicy {
        total: Duration::from_millis(40),
        sync_attempt: Duration::from_millis(5),
        observation: Duration::from_millis(5),
        poll: Duration::from_millis(10),
        max_rate_limit_backoff: Duration::from_millis(20),
        max_attempts: 3,
    };
    let error = wait_for_member_presence_with(
        "forced-no-progress",
        true,
        policy,
        || async { Ok::<(), BackendError>(()) },
        || async {
            Ok::<MemberPresenceSnapshot, BackendError>(MemberPresenceSnapshot {
                membership: "joined".into(),
                ban_status: "none".into(),
                online: Some(false),
            })
        },
    )
    .await
    .expect_err("a stalled observation must fail closed");
    assert!(error.contains("phase=forced-no-progress"));
    assert!(error.contains("membership=joined ban=none online=false"));
    assert!(error.contains("attempts=3"));
    assert!(error.contains("timed out after 30ms"));
}

#[tokio::test]
async fn member_presence_wait_honors_bounded_server_retry_after() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    let policy = PresenceWaitPolicy {
        total: Duration::from_secs(4),
        sync_attempt: Duration::from_millis(100),
        observation: Duration::from_millis(100),
        poll: Duration::from_millis(10),
        max_rate_limit_backoff: Duration::from_secs(2),
        max_attempts: 3,
    };
    let sync_attempts = Arc::new(AtomicUsize::new(0));
    let observe_attempts = Arc::clone(&sync_attempts);
    let started = TokioInstant::now();
    wait_for_member_presence_with(
        "rate-limited-presence",
        true,
        policy,
        || {
            let attempt = sync_attempts.fetch_add(1, Ordering::SeqCst);
            async move {
                if attempt == 0 {
                    Err(BackendError::RateLimited(
                        r#"M_LIMIT_EXCEEDED {"retry_after_ms":1250}"#.into(),
                    ))
                } else {
                    Ok(())
                }
            }
        },
        || {
            let online = observe_attempts.load(Ordering::SeqCst) >= 2;
            async move {
                Ok::<MemberPresenceSnapshot, BackendError>(MemberPresenceSnapshot {
                    membership: "joined".into(),
                    ban_status: "none".into(),
                    online: Some(online),
                })
            }
        },
    )
    .await
    .expect("the second attempt should observe online presence");
    assert!(started.elapsed() >= Duration::from_millis(1_250));
    assert!(started.elapsed() < Duration::from_secs(2));
}

async fn wait_for_room_notification_mode(
    observer: &MatrixBackend,
    room_id: &str,
    expected: MatrixRoomNotificationMode,
) -> bool {
    for _ in 0..20 {
        if observer
            .matrix_room_notification_mode(room_id.to_owned())
            .await
            .is_ok_and(|mode| mode == expected)
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    false
}

async fn erase_live_test_account(label: &str, backend: &MatrixBackend) {
    backend
        .remove_local_account()
        .await
        .unwrap_or_else(|error| panic!("{label} local account cleanup failed: {error}"));
}

/// A fresh consumer account must be creatable through Mesh itself using the
/// invitation token provisioned by the federation fixture, not only through
/// the Synapse operator CLI used to prepare that fixture.
async fn run_matrix_backend_registers_a_fresh_community_hosted_account() {
    let _homeserver =
        EnvironmentOverride::new("MESH_COMMUNITY_HOMESERVER", "http://localhost:8008");
    let _server_name = EnvironmentOverride::new("MESH_COMMUNITY_SERVER_NAME", "hs1.mesh.test");
    let _loopback_invitations =
        EnvironmentOverride::new("MESH_ALLOW_INSECURE_LOOPBACK_INVITATIONS", "1");
    let store = tempfile::tempdir().unwrap();
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let username = format!("meshreg{}", &nonce[..12]);
    let backend = MatrixBackend::with_profile(store.path().to_owned(), "matrix-spike-registration");
    let (admission_origin, admission_server) = spawn_registration_admission_service();
    let invite = format!(
        "mesh://join?v=5&kind=community&room=%21registration%3Ahs1.mesh.test&via=hs1.mesh.test&community_service=http%3A%2F%2Flocalhost%3A8008&admission={}&code={}",
        urlencoding::encode(&admission_origin),
        "registration-acceptance-code-000001"
    );
    let pending = backend
        .store_pending_invitation(invite)
        .await
        .expect("the native pending invitation must be stored opaquely");

    let registration = backend
        .register_account(MatrixRegistration {
            homeserver: "http://localhost:8008".into(),
            username: username.clone(),
            password: "mesh-registration-passphrase".into(),
            pending_invitation_handle: Some(pending.handle),
            device_name: Some("mesh-spike-registration".into()),
        })
        .await;
    let admission_result = admission_server
        .join()
        .map_err(|_| "the admission test service panicked");
    admission_result.expect("the admission test service must finish cleanly");
    let status = registration
        .expect("Mesh account registration must succeed on the community-hosted local service");
    assert!(status.authenticated);
    assert_eq!(
        status.user_id.as_deref(),
        Some(format!("@{username}:hs1.mesh.test").as_str())
    );
    assert!(status.durable_history);
    assert!(status.end_to_end_encryption);

    let mut background_sync_started = false;
    for _ in 0..20 {
        if backend.status().await.sync_running {
            background_sync_started = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(
        background_sync_started,
        "the newly registered account never started continuous sync"
    );

    let community = backend
        .create_community(
            format!("Fresh account {nonce}"),
            "Registration acceptance".into(),
        )
        .await
        .expect("a newly registered account must be able to create an encrypted community");
    assert!(!community.space_id.is_empty());
    assert!(!community.channel_id.is_empty());

    backend
        .remove_local_account()
        .await
        .expect("the registration verification account must be erased locally");
}

#[tokio::test]
#[ignore = "requires infra/matrix-spike"]
async fn matrix_backend_registers_a_fresh_community_hosted_account() {
    let mut run = LiveTestRunRecord::start(
        "matrix_backend_registers_a_fresh_community_hosted_account",
        REGISTRATION_TEST_OUTER_LIMIT,
    );
    match tokio::time::timeout(
        REGISTRATION_TEST_OUTER_LIMIT,
        run_matrix_backend_registers_a_fresh_community_hosted_account(),
    )
    .await
    {
        Ok(()) => run.set_result("passed"),
        Err(_) => {
            run.set_result("timed-out");
            panic!(
                "registration live test exceeded its {} second outer deadline",
                REGISTRATION_TEST_OUTER_LIMIT.as_secs()
            );
        }
    }
}

/// Two real Synapse homeservers, real federation, E2EE, offline catch-up, and
/// same-device session restoration. Run through `npm run test:matrix-spike`.
async fn run_matrix_backend_federates_and_recovers_offline_history_once() {
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
    let alice_profile = "matrix-spike-alice";
    let bob_profile = "matrix-spike-bob";
    let bob_stale_profile = "matrix-spike-bob-stale";
    let charlie_profile = "matrix-spike-charlie";

    let alice = MatrixBackend::with_profile(alice_store.path().to_owned(), alice_profile);
    let bob = MatrixBackend::with_profile(bob_store.path().to_owned(), bob_profile);
    let bob_stale =
        MatrixBackend::with_profile(bob_stale_store.path().to_owned(), bob_stale_profile);
    let charlie = MatrixBackend::with_profile(charlie_store.path().to_owned(), charlie_profile);

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
    alice
        .update_user_preferences(privacy_preferences_with_receipt_mode(
            ReadReceiptMode::Public,
            false,
            false,
            false,
        ))
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
            None,
            uuid::Uuid::new_v4().to_string(),
        )
        .await
        .unwrap();
    let mut bob_received_dm = false;
    for _ in 0..30 {
        bob_received_dm = bob
            .dm_messages(alice_dm.id.clone(), 20, None, None)
            .await
            .unwrap()
            .iter()
            .any(|message| message.id == dm_message.id && message.content == dm_body);
        if bob_received_dm {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(
        bob_received_dm,
        "Bob did not receive and decrypt Alice's federated DM"
    );

    let dm_reply_body = format!("dm-reply-{nonce}");
    let dm_reply = bob
        .send_dm(
            alice_user.clone(),
            dm_reply_body.clone(),
            Some(dm_message.id.clone()),
            None,
            uuid::Uuid::new_v4().to_string(),
        )
        .await
        .unwrap();
    assert_eq!(
        dm_reply.reply_to_id.as_deref(),
        Some(dm_message.id.as_str())
    );
    let mut alice_received_reply = false;
    for _ in 0..30 {
        alice_received_reply = alice
            .dm_messages(alice_dm.id.clone(), 20, None, None)
            .await
            .unwrap()
            .iter()
            .any(|message| message.id == dm_reply.id && message.content == dm_reply_body);
        if alice_received_reply {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(
        alice_received_reply,
        "Alice did not receive and decrypt Bob's federated DM reply"
    );
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

    let bob_observer = Client::builder()
        .homeserver_url("http://localhost:8009")
        .build()
        .await
        .unwrap();
    bob_observer
        .matrix_auth()
        .login_username("bob", "mesh-bob")
        .initial_device_display_name("Mesh public receipt observer")
        .send()
        .await
        .unwrap();
    bob_observer
        .sync_once(
            SyncSettings::default()
                .timeout(Duration::ZERO)
                .set_presence(PresenceState::Offline),
        )
        .await
        .unwrap();
    let observer_bob_dm = bob_observer
        .get_room(&RoomId::parse(&bob_dm.id).unwrap())
        .expect("public receipt observer did not receive the DM room");
    let alice_user_id = UserId::parse(&alice_user).unwrap();
    let mut public_receipt = None;
    for _ in 0..10 {
        bob_observer
            .sync_once(
                SyncSettings::default()
                    .timeout(Duration::ZERO)
                    .set_presence(PresenceState::Offline),
            )
            .await
            .unwrap();
        public_receipt = observer_bob_dm
            .load_user_receipt(ReceiptType::Read, ReceiptThread::Unthreaded, &alice_user_id)
            .await
            .unwrap();
        if public_receipt.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(
        public_receipt.is_some(),
        "explicit public read receipt did not reach the other DM participant"
    );

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
        "public read-receipt mode did not preserve the private fully-read marker"
    );
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
        "public read-receipt mode emitted a private receipt"
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
    assert!(
        bob.typing_users(alice_dm.id.clone())
            .await
            .unwrap()
            .is_empty(),
        "typing activity was displayed before the observing account opted in"
    );
    bob.update_user_preferences(privacy_preferences(true, true, false, false))
        .await
        .unwrap();
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
    let mut bob_dm_messages = Vec::new();
    for _ in 0..30 {
        bob_dm_messages = bob
            .dm_messages(alice_dm.id.clone(), 20, None, None)
            .await
            .unwrap();
        let edit_received = bob_dm_messages.iter().any(|message| {
            message.id == dm_message.id
                && message.content == edited_dm_body
                && message.edited_at.is_some()
        });
        let reaction_received = bob_dm_messages.iter().any(|message| {
            message.id == dm_reply.id
                && message.reply_to_id.as_deref() == Some(dm_message.id.as_str())
                && message
                    .reactions
                    .get("thumbsup")
                    .is_some_and(|authors| authors.iter().any(|author| author == &alice_user))
        });
        if edit_received && reaction_received {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
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
            Vec::new(),
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
        .knock_community(community_alias.clone(), None, Vec::new())
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

    // Alice enabled sharing before Bob joined the federated community.
    // Synapse does not reliably replay that pre-existing remote presence to a
    // newly shared room, so begin with an explicit post-membership transition.
    alice
        .update_user_preferences(privacy_preferences(true, true, true, true))
        .await
        .unwrap();
    wait_for_member_presence(
        "presence-invisible-offline",
        &bob,
        &community.space_id,
        &alice_user,
        false,
    )
    .await
    .expect("invisible mode did not publish Alice as offline");
    alice
        .update_user_preferences(privacy_preferences(true, true, true, false))
        .await
        .unwrap();
    wait_for_member_presence(
        "presence-visible-online",
        &bob,
        &community.space_id,
        &alice_user,
        true,
    )
    .await
    .expect("disabling invisible mode did not restore Alice's online presence");
    alice
        .update_user_preferences(privacy_preferences(true, true, false, false))
        .await
        .unwrap();
    wait_for_member_presence(
        "presence-opt-out-offline",
        &bob,
        &community.space_id,
        &alice_user,
        false,
    )
    .await
    .expect("presence opt-out did not publish Alice as offline");
    alice
        .update_user_preferences(privacy_preferences(true, true, true, false))
        .await
        .unwrap();
    wait_for_member_presence(
        "presence-restored-online",
        &bob,
        &community.space_id,
        &alice_user,
        true,
    )
    .await
    .expect("restoring presence sharing did not publish Alice as online");
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
    alice
        .invite_user(extra_channel.id.clone(), bob_user.clone())
        .await
        .unwrap();
    bob.join_room(extra_channel.id.clone()).await.unwrap();

    let online_body = format!("online-{nonce}");
    let online_request_id = uuid::Uuid::new_v4().to_string();
    let queued_online_message = alice
        .send_message(
            community.channel_id.clone(),
            online_body.clone(),
            None,
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

    let alice_pins = alice
        .toggle_room_pin(community.channel_id.clone(), online_message.id.clone())
        .await
        .unwrap();
    assert_eq!(alice_pins.event_ids, vec![online_message.id.clone()]);
    assert!(alice_pins
        .messages
        .iter()
        .any(|message| message.id == online_message.id && message.content == online_body));

    let mut bob_pins = None;
    for _ in 0..30 {
        bob.sync_once().await.unwrap();
        let pins = bob.room_pins(community.channel_id.clone()).await.unwrap();
        if pins
            .messages
            .iter()
            .any(|message| message.id == online_message.id)
        {
            bob_pins = Some(pins);
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let bob_pins = bob_pins.expect("native room pins did not federate");
    assert!(bob_pins.can_manage);
    assert!(bob_pins.unavailable_event_ids.is_empty());

    let bob_pins = bob
        .toggle_room_pin(community.channel_id.clone(), online_message.id.clone())
        .await
        .unwrap();
    assert!(bob_pins.event_ids.is_empty());
    let mut pin_removed = false;
    for _ in 0..30 {
        alice.sync_once().await.unwrap();
        pin_removed = alice
            .room_pins(community.channel_id.clone())
            .await
            .unwrap()
            .event_ids
            .is_empty();
        if pin_removed {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(pin_removed, "native room pin removal did not federate");
    checkpoint!("native pinned-message state federated and resolved encrypted content");

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
            None,
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
    let alice = MatrixBackend::with_profile(alice_store.path().to_owned(), alice_profile);
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
    let recovery_setup = bob
        .enable_recovery(Some(recovery_passphrase))
        .await
        .unwrap();
    assert_eq!(
        recovery_setup.secure_storage_state,
        mesh_lib::backend::MatrixRecoverySecureStorageState::Saved
    );
    assert_eq!(
        recovery_setup.verification_state,
        mesh_lib::backend::MatrixRecoveryVerificationState::Verified
    );
    let recovery_key = recovery_setup.recovery_key;

    let bob_second_store = tempfile::tempdir().unwrap();
    let bob_second = MatrixBackend::with_profile(
        bob_second_store.path().to_owned(),
        "matrix-spike-bob-second",
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

    bob.matrix_set_room_notification_mode(
        community.channel_id.clone(),
        MatrixRoomNotificationMode::Nothing,
    )
    .await
    .unwrap();
    assert!(
        wait_for_room_notification_mode(
            &bob_second,
            &community.channel_id,
            MatrixRoomNotificationMode::Nothing,
        )
        .await,
        "second device did not reconcile the Matrix room mute push rule"
    );
    bob_second
        .matrix_set_room_notification_mode(
            community.channel_id.clone(),
            MatrixRoomNotificationMode::Mentions,
        )
        .await
        .unwrap();
    assert!(
        wait_for_room_notification_mode(
            &bob,
            &community.channel_id,
            MatrixRoomNotificationMode::Mentions,
        )
        .await,
        "first device did not reconcile the Matrix mention-only push rule"
    );
    checkpoint!("Matrix room notification mode reconciled across two device sessions");

    let pre_upgrade_body = format!("before-room-upgrade-{nonce}");
    let pre_upgrade_message = alice
        .send_text(extra_channel.id.clone(), pre_upgrade_body.clone())
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
    assert!(
        alice_observer
            .get_room(&RoomId::parse(&extra_channel.id).unwrap())
            .is_some(),
        "the room-upgrade client did not discover the source channel"
    );
    let upgrade_response = alice_observer
        .send(UpgradeRoomRequest::new(
            RoomId::parse(&extra_channel.id).unwrap(),
            RoomVersionId::V11,
        ))
        .await
        .unwrap();
    let replacement_channel_id = upgrade_response.replacement_room.to_string();

    let mut bob_saw_upgrade = false;
    for _ in 0..20 {
        bob_saw_upgrade = bob
            .matrix_room_upgrade(extra_channel.id.clone())
            .await
            .unwrap()
            .is_some_and(|upgrade| {
                upgrade.replacement_room_id.as_deref() == Some(&replacement_channel_id)
            });
        if bob_saw_upgrade {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(
        bob_saw_upgrade,
        "the room tombstone did not federate to the other homeserver"
    );
    let channels_before_follow = bob.list_channels(community.space_id.clone()).await.unwrap();
    assert!(
        channels_before_follow
            .iter()
            .any(|channel| channel.id == extra_channel.id),
        "the old channel signpost disappeared before the replacement was joined"
    );
    assert!(
        !channels_before_follow
            .iter()
            .any(|channel| channel.id == replacement_channel_id),
        "an unjoined replacement channel was exposed as available"
    );

    bob.join_room(replacement_channel_id.clone()).await.unwrap();
    let mut channels_after_follow = Vec::new();
    for _ in 0..20 {
        channels_after_follow = bob.list_channels(community.space_id.clone()).await.unwrap();
        if channels_after_follow
            .iter()
            .any(|channel| channel.id == replacement_channel_id)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(
        channels_after_follow
            .iter()
            .any(|channel| channel.id == replacement_channel_id),
        "the joined replacement did not become the community channel"
    );
    assert!(
        !channels_after_follow
            .iter()
            .any(|channel| channel.id == extra_channel.id),
        "the old channel remained duplicated after following the upgrade"
    );
    let replacement_upgrade = bob
        .matrix_room_upgrade(replacement_channel_id.clone())
        .await
        .unwrap()
        .expect("the replacement room did not expose its predecessor");
    assert_eq!(
        replacement_upgrade.predecessor_room_id.as_deref(),
        Some(extra_channel.id.as_str())
    );

    let mut alice_saw_replacement = false;
    for _ in 0..20 {
        alice_saw_replacement = alice
            .list_channels(community.space_id.clone())
            .await
            .unwrap()
            .iter()
            .any(|channel| channel.id == replacement_channel_id);
        if alice_saw_replacement {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(
        alice_saw_replacement,
        "the room creator did not reconcile the joined replacement"
    );
    let mut second_device_saw_replacement = false;
    for _ in 0..20 {
        second_device_saw_replacement = bob_second
            .list_channels(community.space_id.clone())
            .await
            .unwrap()
            .iter()
            .any(|channel| channel.id == replacement_channel_id);
        if second_device_saw_replacement {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(
        second_device_saw_replacement,
        "Bob's second device did not reconcile the joined replacement"
    );

    let post_upgrade_body = format!("after-room-upgrade-{nonce}");
    let post_upgrade_message = alice
        .send_text(replacement_channel_id.clone(), post_upgrade_body)
        .await
        .unwrap();
    let mut predecessor_history = Vec::new();
    for _ in 0..30 {
        predecessor_history = bob
            .messages(
                replacement_channel_id.clone(),
                50,
                None,
                Some(post_upgrade_message.event_id.clone()),
            )
            .await
            .unwrap();
        if predecessor_history.iter().any(|message| {
            message.id == pre_upgrade_message.event_id && message.content == pre_upgrade_body
        }) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(
        predecessor_history.iter().any(|message| {
            message.id == pre_upgrade_message.event_id && message.content == pre_upgrade_body
        }),
        "replacement-room pagination did not continue into encrypted predecessor history"
    );
    checkpoint!("room upgrade signpost, follow transition, and predecessor history verified");

    let saved_preferences = bob
        .update_user_preferences(UserPreferences {
            schema_version: 0,
            notifications_enabled: false,
            notification_sound: true,
            notification_sound_id: Some("mesh".into()),
            do_not_disturb: true,
            show_notification_content: false,
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
            read_receipt_mode: Some(ReadReceiptMode::Off),
            send_typing_indicators: true,
            conversation_privacy: std::collections::BTreeMap::from([(
                community.channel_id.clone(),
                mesh_lib::backend::ConversationPrivacyOverride {
                    read_receipt_mode: Some(ReadReceiptMode::Public),
                    send_typing_indicators: Some(false),
                },
            )]),
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

    // Model a real process restart: abort every task that owns an SDK Client
    // before constructing a replacement backend over the same Windows store.
    // Pausing sync alone leaves the session and room-update tasks detached and
    // their SQLite handles remain live after the backend value is dropped.
    bob.shutdown_for_test().await;
    drop(bob);
    let restored = MatrixBackend::with_profile(bob_store.path().to_owned(), bob_profile);
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
    let moderation = alice
        .ban_member(
            community.space_id.clone(),
            bob_user.clone(),
            Some("Matrix moderation acceptance test".into()),
        )
        .await
        .unwrap();
    assert!(
        !moderation.audit_recorded,
        "moderation must not claim an authoritative audit record until a trustworthy store is configured"
    );
    assert_eq!(moderation.audit.actor_user_id, alice_user);
    assert_eq!(moderation.audit.target_user_id, bob_user);
    assert_eq!(moderation.audit.action, "Banned member");
    assert_eq!(
        moderation.audit.reason.as_deref(),
        Some("Matrix moderation acceptance test")
    );
    for room_id in [
        &community.space_id,
        &community.channel_id,
        &extra_channel.id,
        &replacement_channel_id,
    ] {
        assert!(moderation
            .audit
            .room_outcomes
            .iter()
            .any(|outcome| outcome.room_id == *room_id && outcome.succeeded));
    }
    let moderation_audit_error = alice
        .list_moderation_audit(community.space_id.clone(), 20)
        .await
        .unwrap_err();
    let BackendError::InvalidConfiguration(audit_warning) = moderation_audit_error else {
        panic!("unavailable authoritative audit storage must fail closed with an actionable configuration warning");
    };
    assert!(audit_warning.contains("trustworthy moderation audit store is not configured"));
    assert!(
        audit_warning.contains("Room messages are not accepted as authoritative audit evidence")
    );
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
    restored.sync_once().await.unwrap();
    for room_id in [
        &community.channel_id,
        &extra_channel.id,
        &replacement_channel_id,
    ] {
        assert!(
            restored.join_room(room_id.clone()).await.is_err(),
            "banned member rejoined a server channel"
        );
    }
    checkpoint!("server-wide ban enforced; authoritative moderation audit correctly unavailable");

    erase_live_test_account("Alice", &alice).await;
    erase_live_test_account("Bob", &restored).await;
    erase_live_test_account("Bob stale device", &bob_stale).await;
    erase_live_test_account("Charlie", &charlie).await;
    erase_live_test_account("Bob recovered device", &bob_second).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires infra/matrix-spike"]
async fn matrix_backend_federates_and_recovers_offline_history_once() {
    let mut run = LiveTestRunRecord::start(
        "matrix_backend_federates_and_recovers_offline_history_once",
        FEDERATION_TEST_OUTER_LIMIT,
    );
    match tokio::time::timeout(
        FEDERATION_TEST_OUTER_LIMIT,
        run_matrix_backend_federates_and_recovers_offline_history_once(),
    )
    .await
    {
        Ok(()) => run.set_result("passed"),
        Err(_) => {
            run.set_result("timed-out");
            panic!(
                "federation/recovery live test exceeded its {} second outer deadline",
                FEDERATION_TEST_OUTER_LIMIT.as_secs()
            );
        }
    }
}
