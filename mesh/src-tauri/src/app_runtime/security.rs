use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use tauri::{AppHandle, Manager};

use crate::crypto::encryption;
use crate::state::rate_limits::RateLimitBucket;
use crate::state::AppState;
use crate::storage::Database;

/// Build the Associated Authenticated Data (AAD) for a given gossipsub topic.
///
/// The AAD is `community_id:channel_id` for per-channel topics, or
/// `community_id:` when there is no channel context (meta, presence, legacy).
/// This binds ciphertext to its intended topic so that replaying it on a
/// different channel fails authentication.
pub(super) fn aad_from_topic(topic: &str) -> Option<Vec<u8>> {
    let parts: Vec<&str> = topic.split('/').collect();
    if parts.len() < 3 {
        return None;
    }
    let community_id = parts[2];
    // Per-channel topics: mesh/community/{id}/channel/{ch}/messages
    let channel_id = if parts.len() >= 6 && parts[3] == "channel" {
        parts[4]
    } else {
        ""
    };
    Some(encryption::build_community_aad(community_id, channel_id))
}

/// Try to decrypt a gossipsub payload using the community group key.
/// Extracts the community ID from the topic string. Supports all community
/// topic patterns:
///   - `mesh/community/{id}/messages`       (legacy)
///   - `mesh/community/{id}/meta`            (control events)
///   - `mesh/community/{id}/channel/{ch}/messages` (per-channel)
///   - `mesh/community/{id}/presence`
/// Returns None if no key is available or decryption fails (e.g. plaintext message).
pub(super) fn try_decrypt_community_payload(
    app_handle: &AppHandle,
    topic: &str,
    data: &[u8],
) -> Option<Vec<u8>> {
    // Extract community_id from topic — always at index 2 in the path segments
    let parts: Vec<&str> = topic.split('/').collect();
    if parts.len() < 3 {
        return None;
    }
    let community_id = parts[2];

    let aad = aad_from_topic(topic)?;

    let db = app_handle.try_state::<Database>()?;
    let key_b64 = db.get_group_key(community_id).ok()??;
    let group_key = encryption::group_key_from_b64(&key_b64).ok()?;
    encryption::decrypt_community_payload(&group_key, data, &aad).ok()
}

/// Check if a community has a stored group key (i.e., is encrypted).
/// Used by the decrypt-reject logic to decide whether decryption failure is fatal.
/// Supports all community topic patterns (community_id is always at index 2).
pub(super) fn community_has_group_key(app_handle: &AppHandle, topic: &str) -> bool {
    let parts: Vec<&str> = topic.split('/').collect();
    if parts.len() < 3 {
        return false;
    }
    let community_id = parts[2];
    let Some(db) = app_handle.try_state::<Database>() else {
        return false;
    };
    db.get_group_key(community_id)
        .ok()
        .flatten()
        .filter(|k| !k.is_empty())
        .is_some()
}

/// Check if a user is in the ban list for a given community.
pub(super) fn is_banned(app_handle: &AppHandle, community_id: &str, public_key: &str) -> bool {
    let Some(db) = app_handle.try_state::<Database>() else {
        return false;
    };
    db.is_banned(community_id, public_key).unwrap_or(false)
}

pub(super) async fn enforce_rate_limit(
    app_handle: &AppHandle,
    bucket: RateLimitBucket,
    community_id: &str,
    actor: &str,
) -> bool {
    if community_id.is_empty() || actor.is_empty() {
        return true;
    }
    let Some(state) = app_handle.try_state::<AppState>() else {
        return true;
    };
    state.rate_limits.allow(bucket, community_id, actor).await
}

/// Check if a user is an active member of a community.
/// Returns `Some(true)` if confirmed member, `Some(false)` if roster
/// is loaded and user is NOT a member, `None` if roster is unavailable
/// (fail-open for communities still syncing their membership).
pub(super) fn is_active_member(
    app_handle: &AppHandle,
    community_id: &str,
    public_key: &str,
) -> Option<bool> {
    let state = app_handle.try_state::<AppState>()?;
    state.membership.is_active_member(community_id, public_key).ok()?
}

pub(super) fn trusted_owner_public_key(
    app_handle: &AppHandle,
    community_id: &str,
) -> Option<String> {
    let db = app_handle.try_state::<Database>()?;
    let owner_public_key = db.get_community_owner_public_key(community_id).ok()??;
    let owner_key_bytes = BASE64.decode(&owner_public_key).ok()?;
    let community_id_bytes = BASE64.decode(community_id).ok()?;
    if owner_key_bytes.get(..16)? == community_id_bytes.as_slice() {
        Some(owner_public_key)
    } else {
        tracing::warn!(
            "Owner key for community {} does not match the community ID prefix",
            community_id
        );
        None
    }
}
