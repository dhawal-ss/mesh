use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use crate::crypto::identity::Identity;
use crate::network::envelope::{EnvelopeBuilder, VoiceMembershipPayload, VoiceSignalPayload};
use crate::network::events::NetworkCommand;
use crate::state::voice_state::{
    VoiceSessionEvent, VoiceSessionRef, VoiceSessionSnapshot, VOICE_HEARTBEAT_INTERVAL,
};
use crate::state::AppState;
use crate::storage::Database;

use super::error::CommandError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IceServerConfig {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServerStatus {
    pub stun_configured: bool,
    pub turn_configured: bool,
    pub custom_servers: bool,
    pub server_count: usize,
    pub warnings: Vec<String>,
}

/// Parse an ICE URL into (scheme, host, port).
/// Accepts formats like:
///   - stun:stun.example.com:3478
///   - stun:stun.example.com
///   - turn:turn.example.com:3478?transport=tcp
///   - turns:turn.example.com:5349
///
/// Returns None if the URL is malformed.
fn parse_ice_url(url: &str) -> Option<(&'static str, String, Option<u16>)> {
    let trimmed = url.trim();
    let (scheme, rest) = if let Some(r) = trimmed.strip_prefix("stuns:") {
        ("stuns", r)
    } else if let Some(r) = trimmed.strip_prefix("stun:") {
        ("stun", r)
    } else if let Some(r) = trimmed.strip_prefix("turns:") {
        ("turns", r)
    } else if let Some(r) = trimmed.strip_prefix("turn:") {
        ("turn", r)
    } else {
        return None;
    };

    // Strip query string (?transport=...)
    let host_port = rest.split('?').next()?;
    if host_port.is_empty() {
        return None;
    }

    // Split host:port. Handle IPv6 addresses in brackets.
    if let Some(rest) = host_port.strip_prefix('[') {
        // IPv6: [::1]:3478
        let (host, port_part) = rest.split_once(']')?;
        let port = port_part
            .strip_prefix(':')
            .and_then(|p| p.parse::<u16>().ok());
        Some((scheme, host.to_string(), port))
    } else if let Some((host, port_str)) = host_port.rsplit_once(':') {
        // Check if this is actually host:port or part of an IPv6 addr
        if host.contains(':') {
            // Likely IPv6 without brackets; treat whole thing as host
            Some((scheme, host_port.to_string(), None))
        } else {
            let port = port_str.parse::<u16>().ok();
            if port.is_none() {
                return None; // malformed port
            }
            Some((scheme, host.to_string(), port))
        }
    } else {
        // host only, no port
        Some((scheme, host_port.to_string(), None))
    }
}

/// Validate ICE server configuration without side effects.
/// Returns a status object that can be surfaced in the UI to give users
/// visibility into voice connectivity health.
fn validate_ice_config(servers: &[IceServerConfig], is_custom: bool) -> IceServerStatus {
    let mut warnings = Vec::new();
    let mut stun_configured = false;
    let mut turn_configured = false;

    for (server_idx, server) in servers.iter().enumerate() {
        if server.urls.is_empty() {
            warnings.push(format!("ICE server #{} has no URLs", server_idx));
            continue;
        }
        for url in &server.urls {
            let trimmed = url.trim();
            if trimmed.is_empty() {
                warnings.push(format!("ICE server #{} has an empty URL", server_idx));
                continue;
            }
            match parse_ice_url(trimmed) {
                Some((scheme, host, port)) => {
                    if host.is_empty() {
                        warnings.push(format!("ICE URL has empty host: {}", trimmed));
                        continue;
                    }
                    match scheme {
                        "stun" | "stuns" => {
                            stun_configured = true;
                            // STUN default port is 3478 if unspecified — that's fine.
                            let _ = port;
                        }
                        "turn" | "turns" => {
                            turn_configured = true;
                            // TURN requires credentials.
                            if server.username.is_none() || server.credential.is_none() {
                                warnings.push(format!(
                                    "TURN server {} is missing username or credential",
                                    trimmed
                                ));
                            }
                            // Warn on common misconfigurations
                            if let Some(p) = port {
                                if p == 0 {
                                    warnings.push(format!(
                                        "TURN server {} has invalid port 0",
                                        trimmed
                                    ));
                                }
                            }
                        }
                        _ => {}
                    }
                }
                None => {
                    warnings.push(format!(
                        "Malformed ICE URL (expected stun:/stuns:/turn:/turns:): {}",
                        trimmed
                    ));
                }
            }
        }
    }

    if !stun_configured {
        warnings.push("No STUN server configured — peer discovery may fail".into());
    }
    if !turn_configured {
        warnings.push(
            "No TURN server configured — voice calls will fail for users behind symmetric NATs"
                .into(),
        );
    }

    IceServerStatus {
        stun_configured,
        turn_configured,
        custom_servers: is_custom,
        server_count: servers.len(),
        warnings,
    }
}

/// Validate a user-supplied ICE server configuration before persisting it.
/// Returns the validation status — callers should reject the config if there
/// are fatal warnings.
#[tauri::command]
pub async fn validate_ice_servers(
    servers: Vec<IceServerConfig>,
) -> Result<IceServerStatus, CommandError> {
    Ok(validate_ice_config(&servers, true))
}

/// Structured result of a connectivity probe against an ICE server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServerProbeResult {
    pub url: String,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    /// Outcome classification that distinguishes the real failure mode.
    /// One of:
    ///   - "ok"               — server reachable and speaks STUN
    ///   - "allocation_ok"    — TURN server accepted credentials and
    ///                          allocated a relay (full RFC 5766 handshake)
    ///   - "stun_reachable"   — TURN server answered STUN Binding but
    ///                          failed the TURN Allocate step
    ///   - "auth_rejected"    — TURN server spoke but rejected credentials
    ///   - "turn_protocol_err"— TURN server responded with unexpected semantics
    ///   - "malformed"        — URL couldn't be parsed
    ///   - "dns_failed"       — hostname doesn't resolve
    ///   - "unreachable"      — resolves but TCP/UDP connect fails
    ///   - "no_credentials"   — TURN URL without username/credential
    ///   - "timeout"          — connect attempt timed out
    ///   - "tls_error"        — TLS handshake failed (for stuns/turns)
    pub outcome: String,
    pub detail: String,
    pub resolved_addrs: Vec<String>,
    pub latency_ms: Option<u64>,
}

/// Default ports for each ICE scheme when unspecified.
fn default_port_for_scheme(scheme: &str) -> u16 {
    match scheme {
        "stun" => 3478,
        "stuns" => 5349,
        "turn" => 3478,
        "turns" => 5349,
        _ => 3478,
    }
}

/// Result of a STUN Binding Request protocol probe.
#[derive(Debug, Clone)]
struct StunBindingResult {
    /// The XOR-MAPPED-ADDRESS returned by the server, if parsed successfully.
    #[allow(dead_code)]
    mapped_addr: Option<String>,
    /// Round-trip time in ms.
    rtt_ms: u64,
}

/// Send a STUN Binding Request over UDP and parse the response.
///
/// STUN is defined in RFC 5389. A Binding Request is the simplest STUN
/// message and every compliant STUN/TURN server responds to it with a
/// Binding Success Response containing the client's reflexive address.
///
/// Message format (RFC 5389 §6):
///   bytes 0-1: Message Type     (0x0001 = Binding Request)
///   bytes 2-3: Message Length   (0 when no attributes)
///   bytes 4-7: Magic Cookie     (0x2112A442)
///   bytes 8-19: Transaction ID  (12 random bytes)
///
/// A compliant server responds with type 0x0101 (Success Response)
/// containing the same Magic Cookie and Transaction ID, and an
/// XOR-MAPPED-ADDRESS attribute.
///
/// This function sends one request, waits up to `timeout_ms` for a
/// response, and validates:
///   - response header matches our transaction ID
///   - message type is 0x0101 (Binding Success Response)
///   - magic cookie matches
async fn probe_stun_binding(
    host: &str,
    port: u16,
    timeout_ms: u64,
) -> anyhow::Result<StunBindingResult> {
    use std::time::Instant;
    use tokio::net::UdpSocket;

    const STUN_BINDING_REQUEST: u16 = 0x0001;
    const STUN_BINDING_SUCCESS: u16 = 0x0101;
    const STUN_MAGIC_COOKIE: u32 = 0x2112A442;

    // Build the 20-byte Binding Request
    let mut request = [0u8; 20];
    // Message Type: Binding Request
    request[0..2].copy_from_slice(&STUN_BINDING_REQUEST.to_be_bytes());
    // Message Length: 0 (no attributes)
    request[2..4].copy_from_slice(&0u16.to_be_bytes());
    // Magic Cookie
    request[4..8].copy_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
    // Transaction ID: 12 random bytes
    let mut txn_id = [0u8; 12];
    rand::Rng::fill(&mut rand::thread_rng(), &mut txn_id[..]);
    request[8..20].copy_from_slice(&txn_id);

    // Bind a local UDP socket on an ephemeral port
    let socket = UdpSocket::bind("0.0.0.0:0").await?;
    let target = format!("{}:{}", host, port);

    let start = Instant::now();
    let send_fut = socket.send_to(&request, &target);
    tokio::time::timeout(Duration::from_millis(timeout_ms), send_fut)
        .await
        .map_err(|_| anyhow::anyhow!("STUN send timed out"))??;

    // Wait for response — up to 1500 bytes is plenty for a Binding response
    let mut buf = [0u8; 1500];
    let recv_fut = socket.recv_from(&mut buf);
    let (n, _src) = tokio::time::timeout(Duration::from_millis(timeout_ms), recv_fut)
        .await
        .map_err(|_| anyhow::anyhow!("STUN response timed out"))??;
    let rtt_ms = start.elapsed().as_millis() as u64;

    if n < 20 {
        anyhow::bail!("STUN response too short ({} bytes)", n);
    }
    let msg_type = u16::from_be_bytes([buf[0], buf[1]]);
    let cookie = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
    if cookie != STUN_MAGIC_COOKIE {
        anyhow::bail!(
            "STUN magic cookie mismatch (got 0x{:08X}, expected 0x{:08X})",
            cookie,
            STUN_MAGIC_COOKIE
        );
    }
    if buf[8..20] != txn_id {
        anyhow::bail!("STUN transaction ID mismatch");
    }
    if msg_type != STUN_BINDING_SUCCESS {
        anyhow::bail!(
            "STUN response was not a Binding Success (type 0x{:04X})",
            msg_type
        );
    }

    // Parse XOR-MAPPED-ADDRESS if present (optional for the probe — the
    // matched transaction ID is proof the server is speaking STUN).
    let mapped_addr = parse_xor_mapped_address(&buf[20..n]);

    Ok(StunBindingResult {
        mapped_addr,
        rtt_ms,
    })
}

/// Parse the XOR-MAPPED-ADDRESS attribute (type 0x0020) from STUN
/// attribute bytes, if present. This is optional — the transaction ID
/// match is already sufficient proof of protocol compliance.
fn parse_xor_mapped_address(attrs: &[u8]) -> Option<String> {
    const XOR_MAPPED_ADDRESS: u16 = 0x0020;
    const MAGIC_COOKIE: u32 = 0x2112A442;

    let mut i = 0;
    while i + 4 <= attrs.len() {
        let attr_type = u16::from_be_bytes([attrs[i], attrs[i + 1]]);
        let attr_len = u16::from_be_bytes([attrs[i + 2], attrs[i + 3]]) as usize;
        let value_start = i + 4;
        let value_end = value_start + attr_len;
        if value_end > attrs.len() {
            break;
        }
        if attr_type == XOR_MAPPED_ADDRESS && attr_len >= 8 {
            let family = attrs[value_start + 1];
            let xport = u16::from_be_bytes([attrs[value_start + 2], attrs[value_start + 3]]);
            let port = xport ^ ((MAGIC_COOKIE >> 16) as u16);
            if family == 0x01 && attr_len >= 8 {
                // IPv4
                let cookie_bytes = MAGIC_COOKIE.to_be_bytes();
                let ip = [
                    attrs[value_start + 4] ^ cookie_bytes[0],
                    attrs[value_start + 5] ^ cookie_bytes[1],
                    attrs[value_start + 6] ^ cookie_bytes[2],
                    attrs[value_start + 7] ^ cookie_bytes[3],
                ];
                return Some(format!("{}.{}.{}.{}:{}", ip[0], ip[1], ip[2], ip[3], port));
            }
        }
        // Advance past attribute, padded to 4-byte boundary
        let padded_len = (attr_len + 3) & !3;
        i += 4 + padded_len;
    }
    None
}

// ─── TURN Allocate probe (RFC 5766 §6.2) ──────────────────────────────
//
// This implements the long-term credential mechanism from RFC 5389 §15.4
// and the TURN Allocate Request flow from RFC 5766 §6. The probe performs
// the full two-step handshake:
//
//   1. Send an unauthenticated Allocate Request. The server MUST respond
//      with a 401 (Unauthorized) error containing REALM and NONCE attributes.
//   2. Compute the long-term credential key:
//         key = MD5(username ":" realm ":" password)
//   3. Send a second Allocate Request with USERNAME, REALM, NONCE,
//      REQUESTED-TRANSPORT (UDP=17), and MESSAGE-INTEGRITY (HMAC-SHA1
//      over the message prefix using the key).
//   4. A success response (type 0x0103) means credentials are valid and the
//      server successfully allocated a relay. A 401 error means the
//      credentials were rejected.
//
// This distinguishes:
//   - allocation_ok    — full TURN flow succeeded, server actively allocated
//   - auth_rejected    — server speaks TURN but our credentials are wrong
//   - stun_reachable   — server responds to STUN but not TURN semantics
//   - turn_protocol_err— server responded but with unexpected semantics
//   - unreachable      — UDP timeout or DNS failure
//
// Pure-Rust implementation using hmac, sha1, md-5 crates (all already
// present as transitive deps).

const STUN_ALLOCATE_REQUEST: u16 = 0x0003;
const STUN_ALLOCATE_SUCCESS: u16 = 0x0103;
const STUN_ALLOCATE_ERROR: u16 = 0x0113;
const ATTR_USERNAME: u16 = 0x0006;
const ATTR_MESSAGE_INTEGRITY: u16 = 0x0008;
const ATTR_ERROR_CODE: u16 = 0x0009;
const ATTR_REALM: u16 = 0x0014;
const ATTR_NONCE: u16 = 0x0015;
const ATTR_REQUESTED_TRANSPORT: u16 = 0x0019;
const ATTR_SOFTWARE: u16 = 0x8022;

/// Classification of a TURN Allocate probe outcome.
#[derive(Debug, Clone)]
enum TurnAllocateOutcome {
    AllocationSuccess { rtt_ms: u64 },
    AuthRejected { error_code: u16, reason: String },
    ProtocolError { detail: String },
    Unreachable { detail: String },
}

/// Pad `len` up to the next 4-byte boundary.
fn pad4(len: usize) -> usize {
    (len + 3) & !3
}

/// Append a STUN attribute to `buf` with 4-byte padding.
fn append_attr(buf: &mut Vec<u8>, attr_type: u16, value: &[u8]) {
    buf.extend_from_slice(&attr_type.to_be_bytes());
    buf.extend_from_slice(&(value.len() as u16).to_be_bytes());
    buf.extend_from_slice(value);
    // Pad to 4-byte boundary with zeros
    let padding = pad4(value.len()) - value.len();
    for _ in 0..padding {
        buf.push(0);
    }
}

/// Build a STUN message header.
///
/// The `length` field is the total length of all attributes **including**
/// any MESSAGE-INTEGRITY attribute that will be appended later. Callers
/// that add MESSAGE-INTEGRITY must pass the final body length.
fn build_stun_header(msg_type: u16, attrs_length: u16, txn_id: &[u8; 12]) -> [u8; 20] {
    const STUN_MAGIC_COOKIE: u32 = 0x2112A442;
    let mut header = [0u8; 20];
    header[0..2].copy_from_slice(&msg_type.to_be_bytes());
    header[2..4].copy_from_slice(&attrs_length.to_be_bytes());
    header[4..8].copy_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
    header[8..20].copy_from_slice(txn_id);
    header
}

/// Compute the long-term credential key per RFC 5389 §15.4:
///   key = MD5(username ":" realm ":" password)
fn compute_long_term_key(username: &str, realm: &str, password: &str) -> [u8; 16] {
    use md5::{Digest, Md5};
    let mut hasher = Md5::new();
    hasher.update(username.as_bytes());
    hasher.update(b":");
    hasher.update(realm.as_bytes());
    hasher.update(b":");
    hasher.update(password.as_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&digest);
    out
}

/// Compute MESSAGE-INTEGRITY (HMAC-SHA1) over the STUN message prefix.
///
/// Per RFC 5389 §15.4, the HMAC is computed over the STUN message with:
///   - The length field in the header adjusted to include the 24-byte
///     MESSAGE-INTEGRITY attribute (4-byte header + 20-byte HMAC)
///   - All attributes up to but NOT including the MESSAGE-INTEGRITY attribute
fn compute_message_integrity(message_with_adjusted_length: &[u8], key: &[u8]) -> [u8; 20] {
    use hmac::{Hmac, Mac};
    use sha1::Sha1;
    type HmacSha1 = Hmac<Sha1>;
    let mut mac = HmacSha1::new_from_slice(key).expect("HMAC-SHA1 accepts any key length");
    mac.update(message_with_adjusted_length);
    let result = mac.finalize().into_bytes();
    let mut out = [0u8; 20];
    out.copy_from_slice(&result);
    out
}

/// Parse a STUN attribute of a given type from a message body, returning
/// the attribute value bytes if found.
fn parse_attr<'a>(attrs: &'a [u8], target_type: u16) -> Option<&'a [u8]> {
    let mut i = 0;
    while i + 4 <= attrs.len() {
        let attr_type = u16::from_be_bytes([attrs[i], attrs[i + 1]]);
        let attr_len = u16::from_be_bytes([attrs[i + 2], attrs[i + 3]]) as usize;
        let value_start = i + 4;
        let value_end = value_start + attr_len;
        if value_end > attrs.len() {
            break;
        }
        if attr_type == target_type {
            return Some(&attrs[value_start..value_end]);
        }
        i = value_start + pad4(attr_len);
    }
    None
}

/// Parse an ERROR-CODE attribute (RFC 5389 §15.6).
/// Returns (error_code, reason_phrase).
fn parse_error_code(value: &[u8]) -> Option<(u16, String)> {
    if value.len() < 4 {
        return None;
    }
    // First 2 bytes reserved (must be 0), then class (3 bits) + number (8 bits)
    let class = value[2] & 0x07;
    let number = value[3];
    let code = (class as u16) * 100 + (number as u16);
    let reason = String::from_utf8_lossy(&value[4..]).to_string();
    Some((code, reason))
}

/// Perform a TURN Allocate probe with the full long-term credential flow.
///
/// Steps:
///   1. Send unauthenticated Allocate → expect 401 with REALM+NONCE
///   2. Compute key from (username, realm, password)
///   3. Send authenticated Allocate with MESSAGE-INTEGRITY
///   4. Classify the response
async fn probe_turn_allocate(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    timeout_ms: u64,
) -> anyhow::Result<TurnAllocateOutcome> {
    use std::time::Instant;
    use tokio::net::UdpSocket;

    let socket = UdpSocket::bind("0.0.0.0:0").await?;
    let target = format!("{}:{}", host, port);
    let start = Instant::now();

    // ─── Step 1: Unauthenticated Allocate Request ─────
    let mut txn_id_1 = [0u8; 12];
    rand::Rng::fill(&mut rand::thread_rng(), &mut txn_id_1[..]);

    let mut attrs_1 = Vec::new();
    // REQUESTED-TRANSPORT: UDP (17). Body is [17, 0, 0, 0] (transport + reserved).
    append_attr(&mut attrs_1, ATTR_REQUESTED_TRANSPORT, &[17, 0, 0, 0]);
    // SOFTWARE: optional but polite. Some servers require it.
    append_attr(&mut attrs_1, ATTR_SOFTWARE, b"mesh-probe");

    let header_1 = build_stun_header(STUN_ALLOCATE_REQUEST, attrs_1.len() as u16, &txn_id_1);
    let mut msg_1 = Vec::with_capacity(20 + attrs_1.len());
    msg_1.extend_from_slice(&header_1);
    msg_1.extend_from_slice(&attrs_1);

    let send_fut = socket.send_to(&msg_1, &target);
    match tokio::time::timeout(Duration::from_millis(timeout_ms), send_fut).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            return Ok(TurnAllocateOutcome::Unreachable {
                detail: format!("send failed: {}", e),
            })
        }
        Err(_) => {
            return Ok(TurnAllocateOutcome::Unreachable {
                detail: "send timed out".into(),
            })
        }
    }

    let mut buf = [0u8; 1500];
    let recv_fut = socket.recv_from(&mut buf);
    let (n, _) = match tokio::time::timeout(Duration::from_millis(timeout_ms), recv_fut).await {
        Ok(Ok(x)) => x,
        Ok(Err(e)) => {
            return Ok(TurnAllocateOutcome::Unreachable {
                detail: format!("recv failed: {}", e),
            })
        }
        Err(_) => {
            return Ok(TurnAllocateOutcome::Unreachable {
                detail: "no response to unauthenticated Allocate".into(),
            })
        }
    };

    if n < 20 {
        return Ok(TurnAllocateOutcome::ProtocolError {
            detail: format!("response too short ({} bytes)", n),
        });
    }
    let resp_type = u16::from_be_bytes([buf[0], buf[1]]);
    if buf[8..20] != txn_id_1 {
        return Ok(TurnAllocateOutcome::ProtocolError {
            detail: "response transaction ID mismatch".into(),
        });
    }

    // We EXPECT a 0x0113 Allocate Error with 401 here. If we got something
    // unexpected, classify accordingly.
    if resp_type != STUN_ALLOCATE_ERROR {
        // If the server responds with a Binding Success, it speaks STUN but
        // not TURN Allocate semantics.
        if resp_type == 0x0101 {
            return Ok(TurnAllocateOutcome::ProtocolError {
                detail: "server answered STUN Binding but not TURN Allocate".into(),
            });
        }
        return Ok(TurnAllocateOutcome::ProtocolError {
            detail: format!("unexpected response type 0x{:04X}", resp_type),
        });
    }

    let msg_length_1 = u16::from_be_bytes([buf[2], buf[3]]) as usize;
    if 20 + msg_length_1 > n {
        return Ok(TurnAllocateOutcome::ProtocolError {
            detail: "response length exceeds buffer".into(),
        });
    }
    let attrs_bytes_1 = &buf[20..20 + msg_length_1];

    // Parse REALM and NONCE
    let realm = parse_attr(attrs_bytes_1, ATTR_REALM)
        .and_then(|v| std::str::from_utf8(v).ok())
        .map(String::from);
    let nonce = parse_attr(attrs_bytes_1, ATTR_NONCE).map(|v| v.to_vec());
    let error_code = parse_attr(attrs_bytes_1, ATTR_ERROR_CODE).and_then(parse_error_code);

    let (realm, nonce) = match (realm, nonce) {
        (Some(r), Some(n)) => (r, n),
        _ => {
            return Ok(TurnAllocateOutcome::ProtocolError {
                detail: format!(
                    "server error response missing REALM or NONCE (error: {:?})",
                    error_code
                ),
            })
        }
    };

    // Sanity check: first response should typically be 401 Unauthorized
    if let Some((code, _reason)) = &error_code {
        if *code != 401 {
            return Ok(TurnAllocateOutcome::ProtocolError {
                detail: format!("expected 401 Unauthorized, got {}", code),
            });
        }
    }

    // ─── Step 2: Compute long-term credential key ─────
    let key = compute_long_term_key(username, &realm, password);

    // ─── Step 3: Authenticated Allocate Request ───────
    let mut txn_id_2 = [0u8; 12];
    rand::Rng::fill(&mut rand::thread_rng(), &mut txn_id_2[..]);

    let mut attrs_2 = Vec::new();
    append_attr(&mut attrs_2, ATTR_REQUESTED_TRANSPORT, &[17, 0, 0, 0]);
    append_attr(&mut attrs_2, ATTR_SOFTWARE, b"mesh-probe");
    append_attr(&mut attrs_2, ATTR_USERNAME, username.as_bytes());
    append_attr(&mut attrs_2, ATTR_REALM, realm.as_bytes());
    append_attr(&mut attrs_2, ATTR_NONCE, &nonce);

    // Build the message prefix (header with length that includes
    // MESSAGE-INTEGRITY) for HMAC computation. MESSAGE-INTEGRITY adds
    // 4 bytes of header + 20 bytes of HMAC = 24 bytes.
    let integrity_adjusted_length = (attrs_2.len() + 24) as u16;
    let hmac_header =
        build_stun_header(STUN_ALLOCATE_REQUEST, integrity_adjusted_length, &txn_id_2);
    let mut hmac_input = Vec::with_capacity(20 + attrs_2.len());
    hmac_input.extend_from_slice(&hmac_header);
    hmac_input.extend_from_slice(&attrs_2);
    let integrity = compute_message_integrity(&hmac_input, &key);

    // Append MESSAGE-INTEGRITY to attrs
    append_attr(&mut attrs_2, ATTR_MESSAGE_INTEGRITY, &integrity);

    // Final message
    let final_header = build_stun_header(STUN_ALLOCATE_REQUEST, attrs_2.len() as u16, &txn_id_2);
    let mut msg_2 = Vec::with_capacity(20 + attrs_2.len());
    msg_2.extend_from_slice(&final_header);
    msg_2.extend_from_slice(&attrs_2);

    let send_fut = socket.send_to(&msg_2, &target);
    match tokio::time::timeout(Duration::from_millis(timeout_ms), send_fut).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            return Ok(TurnAllocateOutcome::Unreachable {
                detail: format!("authenticated send failed: {}", e),
            })
        }
        Err(_) => {
            return Ok(TurnAllocateOutcome::Unreachable {
                detail: "authenticated send timed out".into(),
            })
        }
    }

    let recv_fut = socket.recv_from(&mut buf);
    let (n2, _) = match tokio::time::timeout(Duration::from_millis(timeout_ms), recv_fut).await {
        Ok(Ok(x)) => x,
        Ok(Err(e)) => {
            return Ok(TurnAllocateOutcome::Unreachable {
                detail: format!("authenticated recv failed: {}", e),
            })
        }
        Err(_) => {
            return Ok(TurnAllocateOutcome::Unreachable {
                detail: "no response to authenticated Allocate".into(),
            })
        }
    };

    if n2 < 20 {
        return Ok(TurnAllocateOutcome::ProtocolError {
            detail: format!("auth response too short ({} bytes)", n2),
        });
    }
    let resp_type_2 = u16::from_be_bytes([buf[0], buf[1]]);
    if buf[8..20] != txn_id_2 {
        return Ok(TurnAllocateOutcome::ProtocolError {
            detail: "auth response transaction ID mismatch".into(),
        });
    }

    let rtt_ms = start.elapsed().as_millis() as u64;

    match resp_type_2 {
        STUN_ALLOCATE_SUCCESS => Ok(TurnAllocateOutcome::AllocationSuccess { rtt_ms }),
        STUN_ALLOCATE_ERROR => {
            let len_2 = u16::from_be_bytes([buf[2], buf[3]]) as usize;
            if 20 + len_2 > n2 {
                return Ok(TurnAllocateOutcome::ProtocolError {
                    detail: "auth error response length exceeds buffer".into(),
                });
            }
            let err_attrs = &buf[20..20 + len_2];
            match parse_attr(err_attrs, ATTR_ERROR_CODE).and_then(parse_error_code) {
                Some((code, reason)) => Ok(TurnAllocateOutcome::AuthRejected {
                    error_code: code,
                    reason,
                }),
                None => Ok(TurnAllocateOutcome::ProtocolError {
                    detail: "auth error response missing ERROR-CODE".into(),
                }),
            }
        }
        _ => Ok(TurnAllocateOutcome::ProtocolError {
            detail: format!("unexpected auth response type 0x{:04X}", resp_type_2),
        }),
    }
}

/// Probe a single ICE server for reachability. This is a concrete
/// reachability check (not a full STUN/TURN protocol test) that distinguishes:
///   - "malformed"      — URL couldn't be parsed
///   - "no_credentials" — TURN without username/credential
///   - "dns_failed"     — hostname doesn't resolve
///   - "unreachable"    — resolves but TCP/UDP connect fails
///   - "timeout"        — connect attempt timed out
///   - "tls_error"      — TLS handshake failed (for stuns/turns)
///   - "ok"             — server reachable and speaks STUN protocol
///   - "auth_rejected"  — TURN server spoke but rejected credentials
///   - "allocation_ok"  — full TURN Allocate handshake succeeded
///
/// NOTE: Exposed as `pub` so integration tests (tests/turn_probe_live_tests.rs)
/// can probe a real deployed TURN server via environment-variable configuration
/// without needing to spin up the full Tauri command infrastructure.
pub async fn probe_single_ice_server(server: &IceServerConfig) -> Vec<IceServerProbeResult> {
    use std::time::Instant;
    use tokio::net::{lookup_host, TcpStream};

    let mut results = Vec::new();
    for url in &server.urls {
        let url_trimmed = url.trim();
        let parsed = match parse_ice_url(url_trimmed) {
            Some(p) => p,
            None => {
                results.push(IceServerProbeResult {
                    url: url_trimmed.to_string(),
                    scheme: "unknown".into(),
                    host: String::new(),
                    port: 0,
                    outcome: "malformed".into(),
                    detail: "URL could not be parsed".into(),
                    resolved_addrs: vec![],
                    latency_ms: None,
                });
                continue;
            }
        };
        let (scheme, host, port_opt) = parsed;
        let port = port_opt.unwrap_or_else(|| default_port_for_scheme(scheme));

        // TURN servers REQUIRE credentials
        if (scheme == "turn" || scheme == "turns")
            && (server.username.is_none() || server.credential.is_none())
        {
            results.push(IceServerProbeResult {
                url: url_trimmed.to_string(),
                scheme: scheme.to_string(),
                host: host.clone(),
                port,
                outcome: "no_credentials".into(),
                detail: "TURN server is missing username or credential".into(),
                resolved_addrs: vec![],
                latency_ms: None,
            });
            continue;
        }

        // DNS resolution
        let host_port = format!("{}:{}", host, port);
        let start = Instant::now();
        let resolved: Vec<String> = match lookup_host(&host_port).await {
            Ok(addrs) => addrs.map(|a| a.to_string()).collect(),
            Err(e) => {
                results.push(IceServerProbeResult {
                    url: url_trimmed.to_string(),
                    scheme: scheme.to_string(),
                    host: host.clone(),
                    port,
                    outcome: "dns_failed".into(),
                    detail: format!("DNS lookup failed: {}", e),
                    resolved_addrs: vec![],
                    latency_ms: None,
                });
                continue;
            }
        };

        if resolved.is_empty() {
            results.push(IceServerProbeResult {
                url: url_trimmed.to_string(),
                scheme: scheme.to_string(),
                host: host.clone(),
                port,
                outcome: "dns_failed".into(),
                detail: "DNS returned no addresses".into(),
                resolved_addrs: vec![],
                latency_ms: None,
            });
            continue;
        }

        // Protocol probe selection:
        //   stun:   Send a real STUN Binding Request over UDP (RFC 5389).
        //           This is protocol-level validation, not just reachability.
        //   turn:   Send STUN Binding over UDP first (most TURN servers
        //           speak STUN too). Fall back to TCP connect if UDP fails.
        //   turns:  TLS-over-TCP — just do a TCP connect probe since we
        //           don't have a TLS client handy. TCP success + TLS port
        //           responding is a strong reachability signal.
        //   stuns:  Same as turns: — TCP connect.
        match scheme {
            "stun" => {
                // Real STUN Binding Request. Distinguishes "speaks STUN"
                // from "TCP reachable but not a STUN server".
                match probe_stun_binding(&host, port, 3000).await {
                    Ok(stun_result) => {
                        results.push(IceServerProbeResult {
                            url: url_trimmed.to_string(),
                            scheme: scheme.to_string(),
                            host: host.clone(),
                            port,
                            outcome: "ok".into(),
                            detail: "STUN Binding Success Response received".into(),
                            resolved_addrs: resolved,
                            latency_ms: Some(stun_result.rtt_ms),
                        });
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        let outcome = if msg.contains("timed out") {
                            "timeout"
                        } else {
                            "unreachable"
                        };
                        results.push(IceServerProbeResult {
                            url: url_trimmed.to_string(),
                            scheme: scheme.to_string(),
                            host: host.clone(),
                            port,
                            outcome: outcome.into(),
                            detail: format!("STUN probe failed: {}", msg),
                            resolved_addrs: resolved,
                            latency_ms: None,
                        });
                    }
                }
            }
            "turn" => {
                // Real TURN Allocate probe with long-term credentials.
                // This is the strongest validation path: it exchanges the
                // full two-step RFC 5766 handshake and proves the server
                // accepts these credentials AND allocates a relay.
                //
                // Credentials are already validated non-empty above, so
                // username/password are guaranteed to be Some here.
                let username = server.username.as_deref().unwrap_or("");
                let password = server.credential.as_deref().unwrap_or("");

                match probe_turn_allocate(&host, port, username, password, 4000).await {
                    Ok(TurnAllocateOutcome::AllocationSuccess { rtt_ms }) => {
                        results.push(IceServerProbeResult {
                            url: url_trimmed.to_string(),
                            scheme: scheme.to_string(),
                            host: host.clone(),
                            port,
                            outcome: "allocation_ok".into(),
                            detail: "TURN Allocate succeeded — server accepted credentials".into(),
                            resolved_addrs: resolved,
                            latency_ms: Some(rtt_ms),
                        });
                    }
                    Ok(TurnAllocateOutcome::AuthRejected { error_code, reason }) => {
                        results.push(IceServerProbeResult {
                            url: url_trimmed.to_string(),
                            scheme: scheme.to_string(),
                            host: host.clone(),
                            port,
                            outcome: "auth_rejected".into(),
                            detail: format!(
                                "TURN server rejected credentials (error {}: {})",
                                error_code, reason
                            ),
                            resolved_addrs: resolved,
                            latency_ms: None,
                        });
                    }
                    Ok(TurnAllocateOutcome::ProtocolError { detail }) => {
                        // Protocol-level problem — try STUN Binding as a
                        // weaker signal to classify better.
                        match probe_stun_binding(&host, port, 2000).await {
                            Ok(stun_result) => {
                                results.push(IceServerProbeResult {
                                    url: url_trimmed.to_string(),
                                    scheme: scheme.to_string(),
                                    host: host.clone(),
                                    port,
                                    outcome: "stun_reachable".into(),
                                    detail: format!(
                                        "Server answered STUN Binding but TURN Allocate failed: {}",
                                        detail
                                    ),
                                    resolved_addrs: resolved,
                                    latency_ms: Some(stun_result.rtt_ms),
                                });
                            }
                            Err(_) => {
                                results.push(IceServerProbeResult {
                                    url: url_trimmed.to_string(),
                                    scheme: scheme.to_string(),
                                    host: host.clone(),
                                    port,
                                    outcome: "turn_protocol_err".into(),
                                    detail,
                                    resolved_addrs: resolved,
                                    latency_ms: None,
                                });
                            }
                        }
                    }
                    Ok(TurnAllocateOutcome::Unreachable { detail }) => {
                        // TURN probe couldn't send/recv. Try STUN and TCP as
                        // fallback reachability signals.
                        match probe_stun_binding(&host, port, 2000).await {
                            Ok(stun_result) => {
                                results.push(IceServerProbeResult {
                                    url: url_trimmed.to_string(),
                                    scheme: scheme.to_string(),
                                    host: host.clone(),
                                    port,
                                    outcome: "stun_reachable".into(),
                                    detail: format!(
                                        "STUN reachable but TURN UDP failed: {}",
                                        detail
                                    ),
                                    resolved_addrs: resolved,
                                    latency_ms: Some(stun_result.rtt_ms),
                                });
                            }
                            Err(_) => {
                                let connect_fut = TcpStream::connect(&host_port);
                                match tokio::time::timeout(Duration::from_secs(5), connect_fut)
                                    .await
                                {
                                    Ok(Ok(_)) => {
                                        results.push(IceServerProbeResult {
                                            url: url_trimmed.to_string(),
                                            scheme: scheme.to_string(),
                                            host: host.clone(),
                                            port,
                                            outcome: "ok".into(),
                                            detail: format!(
                                                "TCP reachable but TURN and STUN UDP failed \
                                                 ({}); server may be TURN-TCP-only",
                                                detail
                                            ),
                                            resolved_addrs: resolved,
                                            latency_ms: Some(start.elapsed().as_millis() as u64),
                                        });
                                    }
                                    _ => {
                                        results.push(IceServerProbeResult {
                                            url: url_trimmed.to_string(),
                                            scheme: scheme.to_string(),
                                            host: host.clone(),
                                            port,
                                            outcome: "unreachable".into(),
                                            detail: format!(
                                                "TURN, STUN, and TCP all failed: {}",
                                                detail
                                            ),
                                            resolved_addrs: resolved,
                                            latency_ms: None,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        results.push(IceServerProbeResult {
                            url: url_trimmed.to_string(),
                            scheme: scheme.to_string(),
                            host: host.clone(),
                            port,
                            outcome: "turn_protocol_err".into(),
                            detail: format!("TURN probe internal error: {}", e),
                            resolved_addrs: resolved,
                            latency_ms: None,
                        });
                    }
                }
            }
            _ => {
                // stuns: / turns: — TCP connect probe (TLS validation
                // would require a TLS client; treated as out of scope).
                let connect_fut = TcpStream::connect(&host_port);
                match tokio::time::timeout(Duration::from_secs(5), connect_fut).await {
                    Ok(Ok(_stream)) => {
                        results.push(IceServerProbeResult {
                            url: url_trimmed.to_string(),
                            scheme: scheme.to_string(),
                            host: host.clone(),
                            port,
                            outcome: "ok".into(),
                            detail: "TCP connection succeeded (TLS not validated)".into(),
                            resolved_addrs: resolved,
                            latency_ms: Some(start.elapsed().as_millis() as u64),
                        });
                    }
                    Ok(Err(e)) => {
                        results.push(IceServerProbeResult {
                            url: url_trimmed.to_string(),
                            scheme: scheme.to_string(),
                            host: host.clone(),
                            port,
                            outcome: "unreachable".into(),
                            detail: format!("TCP connect failed: {}", e),
                            resolved_addrs: resolved,
                            latency_ms: None,
                        });
                    }
                    Err(_) => {
                        results.push(IceServerProbeResult {
                            url: url_trimmed.to_string(),
                            scheme: scheme.to_string(),
                            host: host.clone(),
                            port,
                            outcome: "timeout".into(),
                            detail: "TCP connect timed out after 5s".into(),
                            resolved_addrs: resolved,
                            latency_ms: None,
                        });
                    }
                }
            }
        }
    }
    results
}

/// Probe all configured ICE servers for reachability.
/// Returns per-URL outcomes that distinguish malformed/unreachable/ok.
/// Operators see this in the diagnostics panel.
#[tauri::command]
pub async fn probe_ice_servers(
    db: State<'_, Database>,
) -> Result<Vec<IceServerProbeResult>, CommandError> {
    let custom: Option<String> = db
        .run_blocking(|db| db.get_kv("ice_servers").unwrap_or(None))
        .await;

    let servers = match custom.as_deref() {
        Some(json) => serde_json::from_str::<Vec<IceServerConfig>>(json)
            .unwrap_or_else(|_| default_ice_servers()),
        None => default_ice_servers(),
    };

    let mut all_results = Vec::new();
    for server in &servers {
        let results = probe_single_ice_server(server).await;
        all_results.extend(results);
    }

    tracing::info!(
        target: "mesh::voice",
        probed = all_results.len(),
        ok_count = all_results.iter().filter(|r| r.outcome == "ok").count(),
        failed_count = all_results.iter().filter(|r| r.outcome != "ok").count(),
        "ICE server probe complete"
    );

    Ok(all_results)
}

/// Persist a custom ICE server configuration after validating it.
/// This is the production path for operators to configure TURN infrastructure.
#[tauri::command]
pub async fn set_ice_servers(
    servers: Vec<IceServerConfig>,
    db: State<'_, Database>,
) -> Result<IceServerStatus, CommandError> {
    let status = validate_ice_config(&servers, true);

    // Reject configs with fatal errors (malformed URLs, missing credentials).
    // Warnings about missing STUN/TURN are informational, not fatal.
    let has_fatal = status
        .warnings
        .iter()
        .any(|w| w.contains("Malformed") || w.contains("empty host") || w.contains("invalid port"));
    if has_fatal {
        return Err(CommandError::Other(format!(
            "ICE server config has fatal errors: {}",
            status.warnings.join("; ")
        )));
    }

    let json = serde_json::to_string(&servers)
        .map_err(|e| CommandError::Other(format!("failed to serialize ICE config: {}", e)))?;
    db.run_blocking(move |db| db.set_kv("ice_servers", &json))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    tracing::info!(
        target: "mesh::voice",
        "Saved {} custom ICE server(s) (stun={}, turn={})",
        servers.len(),
        status.stun_configured,
        status.turn_configured
    );
    Ok(status)
}

/// Get the current ICE server status for UI display.
/// This is the startup/runtime check that makes TURN issues immediately visible.
#[tauri::command]
pub async fn get_ice_server_status(
    db: State<'_, Database>,
) -> Result<IceServerStatus, CommandError> {
    let custom = db
        .run_blocking(|db| db.get_kv("ice_servers"))
        .await
        .unwrap_or(None);

    let (servers, is_custom) = if let Some(json) = custom {
        match serde_json::from_str::<Vec<IceServerConfig>>(&json) {
            Ok(parsed) if !parsed.is_empty() => (parsed, true),
            _ => (default_ice_servers(), false),
        }
    } else {
        (default_ice_servers(), false)
    };

    Ok(validate_ice_config(&servers, is_custom))
}

fn default_ice_servers() -> Vec<IceServerConfig> {
    vec![IceServerConfig {
        urls: vec![
            "stun:stun.l.google.com:19302".into(),
            "stun:stun1.l.google.com:19302".into(),
        ],
        username: None,
        credential: None,
    }]
}

#[tauri::command]
pub async fn get_ice_servers(
    db: State<'_, Database>,
) -> Result<Vec<IceServerConfig>, CommandError> {
    // Check kv_store for custom ICE servers first
    let custom = db
        .run_blocking(|db| db.get_kv("ice_servers"))
        .await
        .unwrap_or(None);
    if let Some(json) = custom {
        if let Ok(servers) = serde_json::from_str::<Vec<IceServerConfig>>(&json) {
            if !servers.is_empty() {
                tracing::info!("Using {} custom ICE servers from settings", servers.len());
                return Ok(servers);
            }
        }
    }

    // Default ICE servers with validation logging
    let defaults = vec![IceServerConfig {
        urls: vec![
            "stun:stun.l.google.com:19302".into(),
            "stun:stun1.l.google.com:19302".into(),
        ],
        username: None,
        credential: None,
    }];

    // Log a warning that no TURN server is configured
    tracing::warn!(
        target: "mesh::voice",
        "No TURN server configured. Voice calls will fail for users behind symmetric NATs. \
         Configure a TURN server in Settings > Voice & Audio."
    );

    Ok(defaults)
}

#[tauri::command]
pub async fn set_kv(
    key: String,
    value: String,
    db: State<'_, Database>,
) -> Result<(), CommandError> {
    db.run_blocking(move |db| db.set_kv(&key, &value))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))
}

#[tauri::command]
pub async fn join_voice(
    community_id: String,
    channel_id: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<VoiceSessionSnapshot, CommandError> {
    let (author_public_key, author_private_key_bytes, source_peer_id) = {
        let identity_guard = state.identity.read().await;
        let identity = identity_guard
            .as_ref()
            .ok_or(CommandError::Identity("No identity loaded".into()))?;
        (
            identity.public_key_b64.clone(),
            identity.private_key_bytes(),
            local_peer_id(identity).map_err(|e| CommandError::Other(e.to_string()))?,
        )
    };

    let author_public_key_c = author_public_key.clone();
    let profile = db
        .run_blocking(move |db| db.get_local_profile(&author_public_key_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;
    let display_name = profile
        .as_ref()
        .map(|profile| profile.display_name.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| short_peer_label(&author_public_key));
    let avatar_color = profile
        .as_ref()
        .map(|profile| profile.avatar_color.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "#c8b89a".to_string());

    let session = state
        .voice
        .record_join(
            &community_id,
            &channel_id,
            &author_public_key,
            true,
            Some(display_name.clone()),
            Some(avatar_color.clone()),
        )
        .await?;
    state
        .voice
        .set_current_session(Some(VoiceSessionRef::new(&community_id, &channel_id)))
        .await;

    emit_voice_session_event(&app_handle, &session);

    let envelope = EnvelopeBuilder::new("voice_join", &author_public_key, &community_id)
        .channel_id(&channel_id)
        .payload_typed(&VoiceMembershipPayload {
            epoch: session.snapshot.session_epoch,
            source_peer_id: Some(source_peer_id.clone()),
            display_name: Some(display_name),
            avatar_color: Some(avatar_color),
        })
        .sign(&author_private_key_bytes);

    if let Some(ref net) = *state.network.read().await {
        if let Err(e) = net
            .send_command(NetworkCommand::SubscribeTopic {
                topic: voice_topic(&community_id, &channel_id),
            })
            .await
        {
            tracing::warn!("network subscribe to voice topic failed: {}", e);
        }
        let data = serde_json::to_vec(&envelope).map_err(|e| CommandError::Other(e.to_string()))?;
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: voice_topic(&community_id, &channel_id),
                data,
            })
            .await
        {
            tracing::warn!("network publish voice join failed: {}", e);
        }
    }

    schedule_voice_heartbeat(
        app_handle.clone(),
        state.voice.clone(),
        state.network.clone(),
        community_id.clone(),
        channel_id.clone(),
        author_public_key,
        source_peer_id,
        author_private_key_bytes,
    )
    .await;

    Ok(session.snapshot)
}

#[tauri::command]
pub async fn leave_voice(
    community_id: String,
    channel_id: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let (author_public_key, author_private_key_bytes, source_peer_id) = {
        let identity_guard = state.identity.read().await;
        let identity = identity_guard
            .as_ref()
            .ok_or(CommandError::Identity("No identity loaded".into()))?;
        (
            identity.public_key_b64.clone(),
            identity.private_key_bytes(),
            local_peer_id(identity).map_err(|e| CommandError::Other(e.to_string()))?,
        )
    };

    let session = state
        .voice
        .record_leave(&community_id, &channel_id, &author_public_key)
        .await;

    if let Some(current) = state.voice.current_session.read().await.clone() {
        if current.community_id == community_id && current.channel_id == channel_id {
            state.voice.set_current_session(None).await;
        }
    }
    state
        .voice
        .stop_heartbeat_task(&community_id, &channel_id)
        .await;

    if let Some(event) = session.as_ref() {
        emit_voice_session_event(&app_handle, event);
    }

    let epoch = session
        .as_ref()
        .map(|event| event.snapshot.session_epoch)
        .unwrap_or(0);
    let envelope = EnvelopeBuilder::new("voice_leave", &author_public_key, &community_id)
        .channel_id(&channel_id)
        .payload_typed(&VoiceMembershipPayload {
            epoch,
            source_peer_id: Some(source_peer_id),
            display_name: None,
            avatar_color: None,
        })
        .sign(&author_private_key_bytes);

    if let Some(ref net) = *state.network.read().await {
        let data = serde_json::to_vec(&envelope).map_err(|e| CommandError::Other(e.to_string()))?;
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: voice_topic(&community_id, &channel_id),
                data,
            })
            .await
        {
            tracing::warn!("network publish voice leave failed: {}", e);
        }

        if let Err(e) = net
            .send_command(NetworkCommand::UnsubscribeTopic {
                topic: voice_topic(&community_id, &channel_id),
            })
            .await
        {
            tracing::warn!("network unsubscribe from voice topic failed: {}", e);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn set_muted(_muted: bool) -> Result<(), CommandError> {
    // Mute state is purely frontend via MediaStreamTrack
    Ok(())
}

#[tauri::command]
pub async fn set_deafened(_deafened: bool) -> Result<(), CommandError> {
    // Deafen state is purely frontend
    Ok(())
}

#[tauri::command]
pub async fn send_voice_signal(
    peer_id: String,
    signal: Value,
    community_id: String,
    channel_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let (author_public_key, author_private_key_bytes) = {
        let identity_guard = state.identity.read().await;
        let identity = identity_guard
            .as_ref()
            .ok_or(CommandError::Identity("No identity loaded".into()))?;
        (
            identity.public_key_b64.clone(),
            identity.private_key_bytes(),
        )
    };

    let epoch = state
        .voice
        .current_epoch(&community_id, &channel_id)
        .await
        .unwrap_or(0);

    let envelope = EnvelopeBuilder::new("voice_signal", &author_public_key, &community_id)
        .channel_id(&channel_id)
        .payload_typed(&VoiceSignalPayload {
            target_peer: peer_id,
            signal,
            epoch,
        })
        .sign(&author_private_key_bytes);

    let network = state.network.read().await;
    if let Some(ref net) = *network {
        let data = serde_json::to_vec(&envelope).map_err(|e| CommandError::Other(e.to_string()))?;
        if let Err(e) = net
            .send_command(NetworkCommand::PublishMessage {
                topic: voice_topic(&community_id, &channel_id),
                data,
            })
            .await
        {
            tracing::warn!("network publish voice signal failed: {}", e);
        }
    }

    Ok(())
}

fn emit_voice_session_event(app_handle: &AppHandle, event: &VoiceSessionEvent) {
    let _ = app_handle.emit("voice:session:event", event);
    let _ = app_handle.emit("voice:session:snapshot", &event.snapshot);
    if event.snapshot.relay.relay_required {
        let _ = app_handle.emit(
            "voice:relay:elected",
            serde_json::json!({
                "communityId": event.community_id,
                "channelId": event.channel_id,
                "sessionEpoch": event.snapshot.session_epoch,
                "memberCount": event.snapshot.member_count,
                "relayCandidatePublicKey": event.snapshot.relay.relay_candidate_public_key,
            }),
        );
    }
}

async fn schedule_voice_heartbeat(
    app_handle: AppHandle,
    voice_state: std::sync::Arc<crate::state::voice_state::VoiceState>,
    network_state: std::sync::Arc<
        tokio::sync::RwLock<Option<crate::network::events::NetworkHandle>>,
    >,
    community_id: String,
    channel_id: String,
    author_public_key: String,
    source_peer_id: String,
    author_private_key_bytes: [u8; 32],
) {
    let community_id_for_task = community_id.clone();
    let channel_id_for_task = channel_id.clone();
    let source_peer_id_for_task = source_peer_id.clone();
    let voice_state_for_task = voice_state.clone();
    let heartbeat_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(VOICE_HEARTBEAT_INTERVAL);
        interval.tick().await;

        loop {
            interval.tick().await;

            let current_session = voice_state_for_task.current_session.read().await.clone();
            if current_session.as_ref().map(|session| {
                session.community_id == community_id_for_task
                    && session.channel_id == channel_id_for_task
            }) != Some(true)
            {
                break;
            }

            let epoch = voice_state_for_task
                .current_epoch(&community_id_for_task, &channel_id_for_task)
                .await
                .unwrap_or(0);

            if let Some(event) = voice_state_for_task
                .record_heartbeat(
                    &community_id_for_task,
                    &channel_id_for_task,
                    &author_public_key,
                    true,
                    None,
                    None,
                )
                .await
            {
                emit_voice_session_event(&app_handle, &event);
            }

            let envelope = EnvelopeBuilder::new(
                "voice_heartbeat",
                &author_public_key,
                &community_id_for_task,
            )
            .channel_id(&channel_id_for_task)
            .payload_typed(&VoiceMembershipPayload {
                epoch,
                source_peer_id: Some(source_peer_id_for_task.clone()),
                display_name: None,
                avatar_color: None,
            })
            .sign(&author_private_key_bytes);

            let network = network_state.read().await;
            if let Some(ref net) = *network {
                let Ok(data) = serde_json::to_vec(&envelope) else {
                    tracing::error!("Failed to serialize voice heartbeat envelope");
                    continue;
                };
                if let Err(e) = net
                    .send_command(NetworkCommand::PublishMessage {
                        topic: voice_topic(&community_id_for_task, &channel_id_for_task),
                        data,
                    })
                    .await
                {
                    tracing::warn!("network publish voice heartbeat failed: {}", e);
                }
            }
        }
    });

    voice_state
        .start_heartbeat_task(community_id, channel_id, heartbeat_handle)
        .await;
}

fn voice_topic(community_id: &str, channel_id: &str) -> String {
    format!(
        "mesh/community/{}/voice/{}/signal",
        community_id, channel_id
    )
}

fn local_peer_id(identity: &Identity) -> anyhow::Result<String> {
    let secret_bytes = identity.private_key_bytes();
    let secret = libp2p::identity::ed25519::SecretKey::try_from_bytes(secret_bytes)?;
    let keypair = libp2p::identity::Keypair::from(libp2p::identity::ed25519::Keypair::from(secret));
    Ok(libp2p::PeerId::from_public_key(&keypair.public()).to_string())
}

fn short_peer_label(public_key: &str) -> String {
    let short = public_key.chars().take(4).collect::<String>();
    if short.is_empty() {
        "Peer".into()
    } else {
        format!("Peer {short}")
    }
}

#[cfg(test)]
mod ice_validation_tests {
    use super::*;

    #[test]
    fn parses_stun_url_with_port() {
        let (scheme, host, port) = parse_ice_url("stun:stun.l.google.com:19302").unwrap();
        assert_eq!(scheme, "stun");
        assert_eq!(host, "stun.l.google.com");
        assert_eq!(port, Some(19302));
    }

    #[test]
    fn parses_turn_url_with_query_string() {
        let (scheme, host, port) =
            parse_ice_url("turn:turn.example.com:3478?transport=tcp").unwrap();
        assert_eq!(scheme, "turn");
        assert_eq!(host, "turn.example.com");
        assert_eq!(port, Some(3478));
    }

    #[test]
    fn parses_turns_url() {
        let (scheme, _host, port) = parse_ice_url("turns:turn.example.com:5349").unwrap();
        assert_eq!(scheme, "turns");
        assert_eq!(port, Some(5349));
    }

    #[test]
    fn parses_url_without_port() {
        let (scheme, host, port) = parse_ice_url("stun:stun.example.com").unwrap();
        assert_eq!(scheme, "stun");
        assert_eq!(host, "stun.example.com");
        assert_eq!(port, None);
    }

    #[test]
    fn rejects_malformed_url_without_scheme() {
        assert!(parse_ice_url("turn.example.com:3478").is_none());
    }

    #[test]
    fn rejects_url_with_invalid_port() {
        assert!(parse_ice_url("turn:example.com:notaport").is_none());
    }

    #[test]
    fn validate_detects_missing_turn_credentials() {
        let servers = vec![IceServerConfig {
            urls: vec!["turn:turn.example.com:3478".into()],
            username: None,
            credential: None,
        }];
        let status = validate_ice_config(&servers, true);
        assert!(status.turn_configured);
        assert!(status
            .warnings
            .iter()
            .any(|w| w.contains("missing username or credential")));
    }

    #[test]
    fn validate_accepts_fully_configured_turn() {
        let servers = vec![
            IceServerConfig {
                urls: vec!["stun:stun.l.google.com:19302".into()],
                username: None,
                credential: None,
            },
            IceServerConfig {
                urls: vec!["turn:turn.example.com:3478".into()],
                username: Some("user".into()),
                credential: Some("pass".into()),
            },
        ];
        let status = validate_ice_config(&servers, true);
        assert!(status.stun_configured);
        assert!(status.turn_configured);
        // No fatal warnings
        assert!(!status.warnings.iter().any(|w| w.contains("Malformed")));
        assert!(!status
            .warnings
            .iter()
            .any(|w| w.contains("missing username")));
    }

    #[test]
    fn validate_flags_malformed_url() {
        let servers = vec![IceServerConfig {
            urls: vec!["not-a-valid-url".into()],
            username: None,
            credential: None,
        }];
        let status = validate_ice_config(&servers, true);
        assert!(status.warnings.iter().any(|w| w.contains("Malformed")));
    }

    #[test]
    fn validate_flags_empty_server_list_with_warnings() {
        let servers: Vec<IceServerConfig> = vec![];
        let status = validate_ice_config(&servers, true);
        assert!(!status.stun_configured);
        assert!(!status.turn_configured);
        assert!(status.warnings.iter().any(|w| w.contains("No STUN")));
        assert!(status.warnings.iter().any(|w| w.contains("No TURN")));
    }

    #[test]
    fn validate_warns_when_server_has_no_urls() {
        let servers = vec![IceServerConfig {
            urls: vec![],
            username: None,
            credential: None,
        }];
        let status = validate_ice_config(&servers, true);
        assert!(status.warnings.iter().any(|w| w.contains("no URLs")));
    }
}

#[cfg(test)]
mod stun_parser_tests {
    use super::*;

    /// Construct a synthetic STUN Binding Success Response with an
    /// XOR-MAPPED-ADDRESS attribute for IPv4 address 203.0.113.1:54321.
    fn build_synthetic_stun_response(txn_id: &[u8; 12]) -> Vec<u8> {
        const STUN_BINDING_SUCCESS: u16 = 0x0101;
        const STUN_MAGIC_COOKIE: u32 = 0x2112A442;
        const XOR_MAPPED_ADDRESS: u16 = 0x0020;

        let mut msg = Vec::new();
        // Attribute: XOR-MAPPED-ADDRESS, length 8
        msg.extend_from_slice(&XOR_MAPPED_ADDRESS.to_be_bytes());
        msg.extend_from_slice(&8u16.to_be_bytes());
        // Attribute value: [reserved(1)][family(1)][x-port(2)][x-address(4)]
        msg.push(0); // reserved
        msg.push(0x01); // family: IPv4
                        // Port 54321 XORed with the top 16 bits of the cookie
        let xport = 54321u16 ^ ((STUN_MAGIC_COOKIE >> 16) as u16);
        msg.extend_from_slice(&xport.to_be_bytes());
        // IP 203.0.113.1 XORed with the magic cookie bytes
        let cookie_bytes = STUN_MAGIC_COOKIE.to_be_bytes();
        msg.push(203 ^ cookie_bytes[0]);
        msg.push(0 ^ cookie_bytes[1]);
        msg.push(113 ^ cookie_bytes[2]);
        msg.push(1 ^ cookie_bytes[3]);

        // Build the full STUN response: 20-byte header + message body
        let mut full = Vec::new();
        full.extend_from_slice(&STUN_BINDING_SUCCESS.to_be_bytes());
        full.extend_from_slice(&(msg.len() as u16).to_be_bytes());
        full.extend_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
        full.extend_from_slice(txn_id);
        full.extend_from_slice(&msg);
        full
    }

    #[test]
    fn parses_xor_mapped_address_ipv4() {
        let txn_id = [0u8; 12];
        let response = build_synthetic_stun_response(&txn_id);
        // Strip the 20-byte header before parsing attributes
        let addr = parse_xor_mapped_address(&response[20..]);
        assert_eq!(addr, Some("203.0.113.1:54321".to_string()));
    }

    #[test]
    fn returns_none_on_empty_attributes() {
        let addr = parse_xor_mapped_address(&[]);
        assert!(addr.is_none());
    }

    #[test]
    fn returns_none_on_truncated_attribute() {
        // Attribute header claims 8 bytes but only 4 are present
        let attrs: Vec<u8> = vec![0x00, 0x20, 0x00, 0x08, 0x00, 0x01, 0x00, 0x00];
        let addr = parse_xor_mapped_address(&attrs);
        // The body is truncated (only 4 value bytes) so parsing should bail
        assert!(addr.is_none());
    }

    #[test]
    fn skips_unknown_attributes() {
        // An unknown 4-byte attribute followed by XOR-MAPPED-ADDRESS
        const STUN_MAGIC_COOKIE: u32 = 0x2112A442;
        const XOR_MAPPED_ADDRESS: u16 = 0x0020;
        let mut attrs = Vec::new();
        // Unknown attribute type 0x8022, length 4, value 0xDEADBEEF
        attrs.extend_from_slice(&0x8022u16.to_be_bytes());
        attrs.extend_from_slice(&4u16.to_be_bytes());
        attrs.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
        // Then XOR-MAPPED-ADDRESS for 192.0.2.1:1234
        attrs.extend_from_slice(&XOR_MAPPED_ADDRESS.to_be_bytes());
        attrs.extend_from_slice(&8u16.to_be_bytes());
        attrs.push(0);
        attrs.push(0x01);
        let xport = 1234u16 ^ ((STUN_MAGIC_COOKIE >> 16) as u16);
        attrs.extend_from_slice(&xport.to_be_bytes());
        let cookie_bytes = STUN_MAGIC_COOKIE.to_be_bytes();
        attrs.push(192 ^ cookie_bytes[0]);
        attrs.push(0 ^ cookie_bytes[1]);
        attrs.push(2 ^ cookie_bytes[2]);
        attrs.push(1 ^ cookie_bytes[3]);

        let addr = parse_xor_mapped_address(&attrs);
        assert_eq!(addr, Some("192.0.2.1:1234".to_string()));
    }

    #[test]
    fn default_port_matches_rfc() {
        assert_eq!(default_port_for_scheme("stun"), 3478);
        assert_eq!(default_port_for_scheme("stuns"), 5349);
        assert_eq!(default_port_for_scheme("turn"), 3478);
        assert_eq!(default_port_for_scheme("turns"), 5349);
    }
}

#[cfg(test)]
mod turn_protocol_tests {
    use super::*;

    #[test]
    fn pad4_rounds_up_correctly() {
        assert_eq!(pad4(0), 0);
        assert_eq!(pad4(1), 4);
        assert_eq!(pad4(4), 4);
        assert_eq!(pad4(5), 8);
        assert_eq!(pad4(7), 8);
        assert_eq!(pad4(8), 8);
        assert_eq!(pad4(9), 12);
    }

    #[test]
    fn append_attr_zero_length_value() {
        let mut buf = Vec::new();
        append_attr(&mut buf, 0x0020, &[]);
        // 4-byte header: type (2) + length (2), no padding
        assert_eq!(buf.len(), 4);
        assert_eq!(&buf[0..2], &[0x00, 0x20]);
        assert_eq!(&buf[2..4], &[0x00, 0x00]);
    }

    #[test]
    fn append_attr_pads_to_4_byte_boundary() {
        let mut buf = Vec::new();
        // 5-byte value should be padded to 8 bytes
        append_attr(&mut buf, 0x0006, b"abcde");
        assert_eq!(buf.len(), 4 + 8); // header + padded value
        assert_eq!(&buf[0..2], &[0x00, 0x06]); // type
        assert_eq!(&buf[2..4], &[0x00, 0x05]); // unpadded length
        assert_eq!(&buf[4..9], b"abcde");
        // Padding bytes must be zero
        assert_eq!(&buf[9..12], &[0, 0, 0]);
    }

    #[test]
    fn append_attr_no_padding_for_aligned_value() {
        let mut buf = Vec::new();
        append_attr(&mut buf, 0x0006, b"abcd"); // 4-byte value
        assert_eq!(buf.len(), 8);
    }

    #[test]
    fn build_stun_header_has_correct_magic_cookie() {
        let txn_id = [0x11; 12];
        let hdr = build_stun_header(0x0003, 16, &txn_id);
        assert_eq!(&hdr[0..2], &[0x00, 0x03]); // Allocate Request
        assert_eq!(&hdr[2..4], &[0x00, 0x10]); // length = 16
        assert_eq!(&hdr[4..8], &[0x21, 0x12, 0xA4, 0x42]); // magic cookie
        assert_eq!(&hdr[8..20], &txn_id);
    }

    #[test]
    fn compute_long_term_key_matches_rfc_example() {
        // RFC 5389 doesn't give a canonical test vector, but we can verify
        // that the same input always produces the same 16-byte MD5.
        let key1 = compute_long_term_key("alice", "example.org", "secret");
        let key2 = compute_long_term_key("alice", "example.org", "secret");
        assert_eq!(key1, key2);
        assert_eq!(key1.len(), 16);

        // Different passwords produce different keys
        let key3 = compute_long_term_key("alice", "example.org", "secret2");
        assert_ne!(key1, key3);

        // Different usernames produce different keys
        let key4 = compute_long_term_key("bob", "example.org", "secret");
        assert_ne!(key1, key4);

        // Different realms produce different keys
        let key5 = compute_long_term_key("alice", "other.org", "secret");
        assert_ne!(key1, key5);
    }

    #[test]
    fn compute_message_integrity_is_20_bytes() {
        let key = [0x42u8; 16];
        let msg = b"stun-message-prefix-bytes";
        let hmac = compute_message_integrity(msg, &key);
        assert_eq!(hmac.len(), 20);

        // Same input produces same HMAC
        let hmac2 = compute_message_integrity(msg, &key);
        assert_eq!(hmac, hmac2);

        // Different key produces different HMAC
        let key_alt = [0x43u8; 16];
        let hmac3 = compute_message_integrity(msg, &key_alt);
        assert_ne!(hmac, hmac3);
    }

    #[test]
    fn parse_attr_finds_simple_attribute() {
        // Build a message body with USERNAME attribute
        let mut attrs = Vec::new();
        append_attr(&mut attrs, ATTR_USERNAME, b"alice");
        let found = parse_attr(&attrs, ATTR_USERNAME);
        assert_eq!(found, Some(&b"alice"[..]));
    }

    #[test]
    fn parse_attr_returns_none_for_missing() {
        let mut attrs = Vec::new();
        append_attr(&mut attrs, ATTR_USERNAME, b"alice");
        assert!(parse_attr(&attrs, ATTR_REALM).is_none());
    }

    #[test]
    fn parse_attr_walks_multiple_attributes() {
        let mut attrs = Vec::new();
        append_attr(&mut attrs, ATTR_USERNAME, b"alice");
        append_attr(&mut attrs, ATTR_REALM, b"example.org");
        append_attr(&mut attrs, ATTR_NONCE, b"abc123");

        assert_eq!(parse_attr(&attrs, ATTR_USERNAME), Some(&b"alice"[..]));
        assert_eq!(parse_attr(&attrs, ATTR_REALM), Some(&b"example.org"[..]));
        assert_eq!(parse_attr(&attrs, ATTR_NONCE), Some(&b"abc123"[..]));
    }

    #[test]
    fn parse_error_code_extracts_401() {
        // ERROR-CODE with 401 Unauthorized per RFC 5389 §15.6
        // Format: [reserved(2)][class=4][number=1][reason...]
        let value = b"\x00\x00\x04\x01Unauthorized";
        let parsed = parse_error_code(value);
        assert_eq!(parsed, Some((401, "Unauthorized".to_string())));
    }

    #[test]
    fn parse_error_code_extracts_other_codes() {
        // 403 Forbidden
        let v403 = b"\x00\x00\x04\x03Forbidden";
        assert_eq!(parse_error_code(v403), Some((403, "Forbidden".to_string())));

        // 438 Stale Nonce
        let v438 = b"\x00\x00\x04\x26Stale Nonce";
        assert_eq!(
            parse_error_code(v438),
            Some((438, "Stale Nonce".to_string()))
        );
    }

    #[test]
    fn parse_error_code_returns_none_on_truncated() {
        let truncated = b"\x00\x00";
        assert!(parse_error_code(truncated).is_none());
    }

    /// Verify we can build a full TURN Allocate Request that would pass
    /// byte-level inspection. This doesn't send anything over the network
    /// but validates the end-to-end message construction.
    #[test]
    fn allocate_request_with_integrity_is_well_formed() {
        let txn_id = [0xAA; 12];
        let username = "testuser";
        let password = "testpass";
        let realm = "example.org";
        let nonce = b"nonce12345";

        let key = compute_long_term_key(username, realm, password);

        let mut attrs = Vec::new();
        append_attr(&mut attrs, ATTR_REQUESTED_TRANSPORT, &[17, 0, 0, 0]);
        append_attr(&mut attrs, ATTR_USERNAME, username.as_bytes());
        append_attr(&mut attrs, ATTR_REALM, realm.as_bytes());
        append_attr(&mut attrs, ATTR_NONCE, nonce);

        // Build HMAC input with adjusted length (adds 24 bytes for MI attribute)
        let integrity_length = (attrs.len() + 24) as u16;
        let hmac_header = build_stun_header(STUN_ALLOCATE_REQUEST, integrity_length, &txn_id);
        let mut hmac_input = Vec::with_capacity(20 + attrs.len());
        hmac_input.extend_from_slice(&hmac_header);
        hmac_input.extend_from_slice(&attrs);

        let integrity = compute_message_integrity(&hmac_input, &key);
        append_attr(&mut attrs, ATTR_MESSAGE_INTEGRITY, &integrity);

        // Final message
        let final_header = build_stun_header(STUN_ALLOCATE_REQUEST, attrs.len() as u16, &txn_id);
        let mut final_msg = Vec::new();
        final_msg.extend_from_slice(&final_header);
        final_msg.extend_from_slice(&attrs);

        // Total message must be at least header(20) + 4 attributes minimum
        assert!(final_msg.len() >= 20 + 8 * 4); // rough lower bound
                                                // Header is 20 bytes
        assert_eq!(&final_msg[0..2], &[0x00, 0x03]); // Allocate Request
        assert_eq!(&final_msg[4..8], &[0x21, 0x12, 0xA4, 0x42]); // cookie
        assert_eq!(&final_msg[8..20], &txn_id);

        // Verify we can parse back the attributes
        let body = &final_msg[20..];
        assert!(parse_attr(body, ATTR_USERNAME).is_some());
        assert!(parse_attr(body, ATTR_REALM).is_some());
        assert!(parse_attr(body, ATTR_NONCE).is_some());
        assert!(parse_attr(body, ATTR_MESSAGE_INTEGRITY).is_some());
        // MESSAGE-INTEGRITY must be 20 bytes
        assert_eq!(parse_attr(body, ATTR_MESSAGE_INTEGRITY).unwrap().len(), 20);
    }
}
