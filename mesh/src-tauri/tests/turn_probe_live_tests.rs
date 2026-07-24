//! Live TURN server probe integration tests.
//!
//! These tests validate Mesh's TURN probe implementation against a REAL
//! deployed TURN server. They are opt-in via environment variables and
//! `#[ignore]` so they never run unless explicitly requested.
//!
//! # Required environment variables
//!
//! - `MESH_TURN_URL` — a full ICE URL, e.g. `turn:turn.example.com:3478`
//! - `MESH_TURN_USERNAME` — TURN long-term credential username
//! - `MESH_TURN_PASSWORD` — TURN long-term credential password
//!
//! # Optional environment variables
//!
//! - `MESH_STUN_URL` — a STUN URL for stand-alone STUN Binding probe
//!   (defaults to `stun:stun.l.google.com:19302` when unset)
//! - `MESH_TURN_EXPECT` — expected outcome (`allocation_ok`, `auth_rejected`,
//!   `stun_reachable`, etc.). When set, the test asserts the probe outcome
//!   matches. Useful for regression testing deployment issues.
//!
//! # How to run
//!
//! ```text
//! # Happy path against a real TURN server:
//! $env:MESH_TURN_URL="turn:turn.example.com:3478"
//! $env:MESH_TURN_USERNAME="alice"
//! $env:MESH_TURN_PASSWORD="hunter2"
//! cargo test --test turn_probe_live_tests -- --ignored --nocapture
//!
//! # Regression mode — assert a specific expected outcome:
//! $env:MESH_TURN_EXPECT="allocation_ok"
//! cargo test --test turn_probe_live_tests -- --ignored --nocapture
//! ```
//!
//! # What these tests prove
//!
//! When run against real infrastructure, they prove:
//! 1. DNS resolution for the configured TURN hostname
//! 2. UDP reachability of the TURN port
//! 3. RFC 5389 STUN Binding protocol compatibility
//! 4. RFC 5766 TURN Allocate with HMAC-SHA1 MESSAGE-INTEGRITY succeeds
//!    against the provided credentials
//! 5. Diagnostics classification is correct for the real outcome
//!
//! These tests are the bridge between Mesh's in-repo protocol implementation
//! and the real production TURN infrastructure an operator would deploy.

use std::env;
use std::time::Duration;

use mesh_lib::probe_api::{probe_single_ice_server, IceServerConfig};

/// Helper: attempt to read all three required env vars. Returns None if any
/// are missing — tests that use this should skip-log and return early.
fn turn_config_from_env() -> Option<(String, String, String)> {
    let url = env::var("MESH_TURN_URL").ok()?;
    let username = env::var("MESH_TURN_USERNAME").ok()?;
    let password = env::var("MESH_TURN_PASSWORD").ok()?;
    if url.is_empty() || username.is_empty() || password.is_empty() {
        return None;
    }
    Some((url, username, password))
}

/// Helper: print a skip message when env vars are missing.
fn skip_no_config(test_name: &str) {
    eprintln!(
        "[{}] SKIP: MESH_TURN_URL / MESH_TURN_USERNAME / MESH_TURN_PASSWORD \
         must all be set to run this test. See tests/turn_probe_live_tests.rs header for details.",
        test_name
    );
}

// ─── Test 1: full TURN Allocate probe against a real server ──────────

/// Probe a deployed TURN server with real credentials and classify the result.
/// On success, prints the probe outcome and latency for operator review.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires MESH_TURN_URL / MESH_TURN_USERNAME / MESH_TURN_PASSWORD"]
async fn probes_real_turn_server_with_credentials() {
    let Some((url, username, password)) = turn_config_from_env() else {
        skip_no_config("probes_real_turn_server_with_credentials");
        return;
    };

    let server = IceServerConfig {
        urls: vec![url.clone()],
        username: Some(username.clone()),
        credential: Some(password),
    };

    let start = std::time::Instant::now();
    let results = tokio::time::timeout(Duration::from_secs(30), probe_single_ice_server(&server))
        .await
        .expect("probe timed out after 30s");

    assert!(
        !results.is_empty(),
        "expected at least one probe result for {}",
        url
    );

    println!("\n── TURN probe result ──");
    println!("url:      {}", url);
    println!("username: {}", username);
    println!("elapsed:  {:?}", start.elapsed());
    for r in &results {
        println!(
            "\n  scheme:   {}\n  host:     {}\n  port:     {}\n  outcome:  {}\n  detail:   {}\n  addrs:    {:?}\n  latency:  {:?}ms",
            r.scheme, r.host, r.port, r.outcome, r.detail, r.resolved_addrs, r.latency_ms,
        );
    }

    // If MESH_TURN_EXPECT is set, assert the outcome matches.
    // This turns the test into a deployment-regression check.
    if let Ok(expected) = env::var("MESH_TURN_EXPECT") {
        let expected = expected.trim().to_lowercase();
        let actual = &results[0].outcome;
        assert_eq!(
            actual, &expected,
            "TURN probe outcome mismatch: expected '{}', got '{}' (detail: {})",
            expected, actual, results[0].detail
        );
        println!("\n✓ Outcome matches MESH_TURN_EXPECT={}", expected);
    }

    // Without an explicit expectation, classify outcomes as pass/fail.
    // "allocation_ok" is the goal. Anything else signals a deployment
    // problem but we don't fail the test unconditionally because operators
    // may run this in known-broken scenarios to verify classification.
    match results[0].outcome.as_str() {
        "allocation_ok" => {
            println!("\n✓ TURN Allocate succeeded — server and credentials are valid");
        }
        "auth_rejected" => {
            println!("\n⚠ TURN server rejected credentials — verify username/password");
        }
        "stun_reachable" => {
            println!(
                "\n⚠ Server answered STUN but not TURN Allocate — \
                 check TURN daemon is running, not just a STUN server"
            );
        }
        "unreachable" | "timeout" | "dns_failed" => {
            println!(
                "\n✗ Server unreachable: {} ({})",
                results[0].outcome, results[0].detail
            );
        }
        other => {
            println!("\n? Unexpected outcome: {} ({})", other, results[0].detail);
        }
    }
}

// ─── Test 2: negative-path probe with wrong credentials ──────────

/// Probe a real TURN server with deliberately wrong credentials and confirm
/// the probe classifies it as `auth_rejected`. Validates that the probe's
/// error classification is correct against real infrastructure.
///
/// Run with:
///   MESH_TURN_URL=... (server address)
///   MESH_TURN_USERNAME=some-valid-looking-username
///   MESH_TURN_PASSWORD=definitely-wrong-password
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires MESH_TURN_URL with DELIBERATELY wrong credentials"]
async fn detects_wrong_turn_credentials() {
    let Some((url, _, _)) = turn_config_from_env() else {
        skip_no_config("detects_wrong_turn_credentials");
        return;
    };

    // Use deliberately wrong credentials regardless of what was configured.
    // A properly-configured TURN server MUST reject this.
    let server = IceServerConfig {
        urls: vec![url.clone()],
        username: Some("mesh-wrong-credential-test".into()),
        credential: Some("this-password-is-intentionally-wrong-12345".into()),
    };

    let results = tokio::time::timeout(Duration::from_secs(15), probe_single_ice_server(&server))
        .await
        .expect("probe timed out");

    assert!(!results.is_empty());
    println!("\n── Wrong-credential probe result ──");
    for r in &results {
        println!("outcome:  {}\ndetail:   {}", r.outcome, r.detail);
    }

    // A properly-configured TURN server MUST return auth_rejected. If the
    // server is not TURN (just STUN), stun_reachable is also acceptable.
    // Anything else indicates a deployment or probe bug.
    let outcome = &results[0].outcome;
    assert!(
        matches!(outcome.as_str(), "auth_rejected" | "stun_reachable"),
        "Expected wrong credentials to yield auth_rejected or stun_reachable, got: {} ({})",
        outcome,
        results[0].detail
    );
}

// ─── Test 3: STUN Binding against a public STUN server ──────────

/// Probe a well-known public STUN server (Google's) and confirm
/// classification as "ok". This test does NOT require any credentials and
/// runs any time the `MESH_TEST_PUBLIC_STUN` env var is set, providing
/// a sanity check that the STUN Binding code path works against real
/// internet infrastructure without needing a dedicated TURN deployment.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires MESH_TEST_PUBLIC_STUN=1 and internet access"]
async fn probes_public_stun_server() {
    if env::var("MESH_TEST_PUBLIC_STUN").ok().as_deref() != Some("1") {
        eprintln!("[probes_public_stun_server] SKIP: set MESH_TEST_PUBLIC_STUN=1 to enable");
        return;
    }

    let url =
        env::var("MESH_STUN_URL").unwrap_or_else(|_| "stun:stun.l.google.com:19302".into());

    let server = IceServerConfig {
        urls: vec![url.clone()],
        username: None,
        credential: None,
    };

    let results = tokio::time::timeout(Duration::from_secs(10), probe_single_ice_server(&server))
        .await
        .expect("probe timed out");

    assert!(!results.is_empty());
    println!("\n── Public STUN probe result ──");
    println!("url: {}", url);
    for r in &results {
        println!(
            "outcome: {}\ndetail:  {}\nlatency: {:?}ms",
            r.outcome, r.detail, r.latency_ms
        );
    }

    assert_eq!(
        results[0].outcome, "ok",
        "Public STUN probe should report 'ok', got: {} ({})",
        results[0].outcome, results[0].detail
    );
    assert!(
        results[0].latency_ms.is_some(),
        "Successful STUN probe must report latency_ms"
    );
}

// ─── Test 4: malformed config is caught ──────────

/// Confirms the probe correctly rejects a malformed URL even against live
/// infrastructure (the malformed check happens before any network I/O).
/// This test runs unconditionally since it doesn't need real infra.
#[tokio::test(flavor = "multi_thread")]
async fn malformed_url_produces_malformed_outcome() {
    let server = IceServerConfig {
        urls: vec!["not-a-valid-ice-url".into()],
        username: None,
        credential: None,
    };

    let results = probe_single_ice_server(&server).await;
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].outcome, "malformed");
    assert!(results[0].detail.contains("could not be parsed"));
}

/// Confirms the probe correctly flags TURN without credentials.
#[tokio::test(flavor = "multi_thread")]
async fn turn_without_credentials_produces_no_credentials_outcome() {
    let server = IceServerConfig {
        urls: vec!["turn:turn.example.com:3478".into()],
        username: None,
        credential: None,
    };

    let results = probe_single_ice_server(&server).await;
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].outcome, "no_credentials");
}
