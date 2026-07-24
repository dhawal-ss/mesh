//! Provenance-preserving export and controlled import for the legacy libp2p store.
//!
//! An archive is one peer's observation, not a canonical community history.
//! Records are content-addressed independently of the observing peer so dry runs
//! can identify agreement and divergence across several peer archives.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::storage::Database;

pub const LEGACY_ARCHIVE_SCHEMA_VERSION: u32 = 1;
pub use crate::backend::LEGACY_MATRIX_EVENT_TYPE;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyArchiveSource {
    pub peer_id: String,
    pub public_key: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyRecordKind {
    Community,
    Channel,
    Membership,
    Message,
    ControlEvent,
    File,
}

impl LegacyRecordKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Community => "community",
            Self::Channel => "channel",
            Self::Membership => "membership",
            Self::Message => "message",
            Self::ControlEvent => "control_event",
            Self::File => "file",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRecord {
    pub kind: LegacyRecordKind,
    pub entity_id: String,
    pub community_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub source_peer_id: String,
    pub observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_signature: Option<String>,
    pub payload: Value,
    pub record_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyFileBlob {
    pub file_hash: String,
    pub filename: String,
    pub size: u64,
    #[serde(default)]
    pub source_peer_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyArchive {
    pub schema_version: u32,
    pub archive_id: String,
    pub exported_at: String,
    pub source: LegacyArchiveSource,
    pub records: Vec<LegacyRecord>,
    pub files: Vec<LegacyFileBlob>,
    pub archive_sha256: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyExportRequest {
    #[serde(default)]
    pub community_id: Option<String>,
    /// Optional paths for locally available attachment bytes, keyed by the
    /// legacy SHA-256 file hash. Unavailable bytes remain explicit in the
    /// archive instead of being silently treated as migrated.
    #[serde(default)]
    pub file_paths: HashMap<String, String>,
    /// User-selected candidate files. Their SHA-256 hashes are computed and
    /// matched to archived attachment metadata, so operators do not need to
    /// know content hashes when exporting available legacy bytes.
    #[serde(default)]
    pub file_candidates: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyArchiveSummary {
    pub archive_id: String,
    pub archive_sha256: String,
    pub source_peer_id: String,
    pub communities: Vec<LegacyCommunitySummary>,
    pub record_count: usize,
    pub embedded_file_count: usize,
    pub missing_file_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyCommunitySummary {
    pub id: String,
    pub name: String,
    pub channels: Vec<LegacyChannelSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyChannelSummary {
    pub id: String,
    pub name: String,
    pub channel_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyTargetMapping {
    pub legacy_community_id: String,
    pub matrix_space_id: String,
    #[serde(default)]
    pub channel_rooms: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyConflictResolution {
    pub conflict_key: String,
    pub selected_record_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportRequest {
    pub archive_paths: Vec<String>,
    #[serde(default)]
    pub include_community_ids: Vec<String>,
    pub mappings: Vec<LegacyTargetMapping>,
    #[serde(default)]
    pub resolutions: Vec<LegacyConflictResolution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyConflictVariant {
    pub record_sha256: String,
    pub source_peer_ids: Vec<String>,
    pub archive_ids: Vec<String>,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyConflict {
    pub conflict_key: String,
    pub kind: LegacyRecordKind,
    pub entity_id: String,
    pub variants: Vec<LegacyConflictVariant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_record_sha256: Option<String>,
    pub resolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDryRunReport {
    pub plan_sha256: String,
    pub archives: Vec<LegacyArchiveSummary>,
    pub peer_count: usize,
    pub record_group_count: usize,
    pub variant_count: usize,
    pub conflicts: Vec<LegacyConflict>,
    pub unresolved_conflict_count: usize,
    pub unmapped_record_count: usize,
    pub missing_file_count: usize,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_phrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportEvent {
    pub target_room_id: String,
    pub import_key: String,
    pub content: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportResult {
    pub plan_sha256: String,
    pub imported_events: usize,
    pub previously_imported_events: usize,
    pub matrix_event_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct Variant {
    record: LegacyRecord,
    source_peer_ids: BTreeSet<String>,
    archive_ids: BTreeSet<String>,
}

#[derive(Debug, Clone)]
struct Group {
    key: String,
    variants: BTreeMap<String, Variant>,
}

pub fn export_legacy_archive(
    db: &Database,
    source: LegacyArchiveSource,
    request: &LegacyExportRequest,
) -> anyhow::Result<LegacyArchive> {
    if source.peer_id.trim().is_empty() || source.public_key.trim().is_empty() {
        anyhow::bail!("legacy export requires a source peer ID and public key");
    }

    let exported_at = chrono::Utc::now().to_rfc3339();
    let mut provided_file_paths = request.file_paths.clone();
    for candidate in &request.file_candidates {
        let bytes = fs::read(candidate)?;
        provided_file_paths.insert(sha256_hex(&bytes), candidate.clone());
    }
    let mut records = Vec::new();
    let mut file_metadata: BTreeMap<String, LegacyFileBlob> = BTreeMap::new();
    let conn = db.conn.lock().map_err(|e| anyhow::anyhow!("lock: {e}"))?;

    let community_filter = request.community_id.as_deref();
    {
        let mut stmt = conn.prepare(
            "SELECT id, name, description, joined_at, our_role, owner_public_key, group_key_epoch
             FROM communities WHERE (?1 IS NULL OR id = ?1) ORDER BY id",
        )?;
        let rows = stmt.query_map([community_filter], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<i64>>(6)?,
            ))
        })?;
        for row in rows {
            let (id, name, description, joined_at, role, owner, epoch) = row?;
            records.push(make_record(
                LegacyRecordKind::Community,
                id.clone(),
                id,
                None,
                &source.peer_id,
                &exported_at,
                Some(joined_at.clone()),
                None,
                json!({
                    "name": name,
                    "description": description,
                    "joinedAt": joined_at,
                    "ourRole": role,
                    "ownerPublicKey": owner,
                    "groupKeyEpoch": epoch,
                }),
            ));
        }
    }

    let community_ids: HashSet<String> = records
        .iter()
        .filter(|record| record.kind == LegacyRecordKind::Community)
        .map(|record| record.community_id.clone())
        .collect();
    if let Some(requested) = community_filter {
        if !community_ids.contains(requested) {
            anyhow::bail!("legacy community {requested} was not found");
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT id, community_id, name, channel_type, created_at FROM channels ORDER BY id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        for row in rows {
            let (id, community_id, name, channel_type, created_at) = row?;
            if !community_ids.contains(&community_id) {
                continue;
            }
            records.push(make_record(
                LegacyRecordKind::Channel,
                id.clone(),
                community_id,
                Some(id),
                &source.peer_id,
                &exported_at,
                Some(created_at.clone()),
                None,
                json!({"name": name, "channelType": channel_type, "createdAt": created_at}),
            ));
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT community_id, public_key, display_name, avatar_color, x25519_public_key,
                    role, join_status, ban_status, invited_by, joined_at, last_seen
             FROM members ORDER BY community_id, public_key",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, Option<String>>(10)?,
            ))
        })?;
        for row in rows {
            let (
                community_id,
                public_key,
                display_name,
                avatar_color,
                x25519,
                role,
                join_status,
                ban_status,
                invited_by,
                joined_at,
                last_seen,
            ) = row?;
            if !community_ids.contains(&community_id) {
                continue;
            }
            records.push(make_record(
                LegacyRecordKind::Membership,
                public_key.clone(),
                community_id,
                None,
                &source.peer_id,
                &exported_at,
                Some(joined_at.clone()),
                None,
                json!({
                    "publicKey": public_key,
                    "displayName": display_name,
                    "avatarColor": avatar_color,
                    "x25519PublicKey": x25519,
                    "role": role,
                    "joinStatus": join_status,
                    "banStatus": ban_status,
                    "invitedBy": invited_by,
                    "joinedAt": joined_at,
                    "lastSeen": last_seen,
                }),
            ));
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT m.id, m.channel_id, c.community_id, m.author_public_key,
                    m.author_display_name, m.author_avatar_color, m.content, m.attachments,
                    m.reactions, m.timestamp, m.signature, m.edited_at, m.deleted_at, m.reply_to_id
             FROM messages m JOIN channels c ON c.id = m.channel_id
             ORDER BY m.timestamp, m.id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, Option<String>>(13)?,
            ))
        })?;
        for row in rows {
            let (
                id,
                channel_id,
                community_id,
                author_public_key,
                author_display_name,
                author_avatar_color,
                content,
                attachments_json,
                reactions_json,
                timestamp,
                signature,
                edited_at,
                deleted_at,
                reply_to_id,
            ) = row?;
            if !community_ids.contains(&community_id) {
                continue;
            }
            let attachments: Value = serde_json::from_str(&attachments_json)
                .unwrap_or_else(|_| Value::Array(Vec::new()));
            collect_attachment_metadata(&attachments, &mut file_metadata);
            let reactions: Value = serde_json::from_str(&reactions_json)
                .unwrap_or_else(|_| Value::Object(Default::default()));
            records.push(make_record(
                LegacyRecordKind::Message,
                id,
                community_id,
                Some(channel_id),
                &source.peer_id,
                &exported_at,
                Some(timestamp.clone()),
                Some(signature),
                json!({
                    "authorPublicKey": author_public_key,
                    "authorDisplayName": author_display_name,
                    "authorAvatarColor": author_avatar_color,
                    "content": content,
                    "attachments": attachments,
                    "reactions": reactions,
                    "editedAt": edited_at,
                    "deletedAt": deleted_at,
                    "replyToId": reply_to_id,
                }),
            ));
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT id, community_id, event_type, payload, signed_by, signature, timestamp
             FROM control_log ORDER BY timestamp, id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;
        for row in rows {
            let (id, community_id, event_type, payload_json, signed_by, signature, timestamp) =
                row?;
            if !community_ids.contains(&community_id) {
                continue;
            }
            let payload =
                serde_json::from_str(&payload_json).unwrap_or(Value::String(payload_json));
            records.push(make_record(
                LegacyRecordKind::ControlEvent,
                id,
                community_id,
                None,
                &source.peer_id,
                &exported_at,
                Some(timestamp.clone()),
                Some(signature),
                json!({"eventType": event_type, "payload": payload, "signedBy": signed_by}),
            ));
        }
    }

    // Seeder observations are part of file provenance. They do not imply that
    // this exporting peer has the bytes.
    {
        let mut stmt = conn.prepare(
            "SELECT file_hash, peer_id, filename, size FROM file_availability
             ORDER BY file_hash, peer_id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;
        for row in rows {
            let (hash, peer_id, filename, size) = row?;
            if let Some(file) = file_metadata.get_mut(&hash) {
                if file.filename.is_empty() {
                    file.filename = filename;
                }
                file.size = file.size.max(size.max(0) as u64);
                file.source_peer_ids.push(peer_id);
            }
        }
    }
    drop(conn);

    let file_communities = file_communities(&records);
    let mut files = Vec::new();
    for (hash, mut file) in file_metadata {
        file.source_peer_ids.sort();
        file.source_peer_ids.dedup();
        if let Some(path) = provided_file_paths.get(&hash) {
            let bytes = fs::read(path)?;
            let actual = sha256_hex(&bytes);
            if actual != hash {
                anyhow::bail!("attachment {path} hashes to {actual}, expected {hash}");
            }
            if file.size != 0 && file.size != bytes.len() as u64 {
                anyhow::bail!(
                    "attachment {path} has {} bytes, expected {}",
                    bytes.len(),
                    file.size
                );
            }
            file.size = bytes.len() as u64;
            file.bytes_sha256 = Some(actual);
            file.bytes_base64 = Some(BASE64.encode(bytes));
        }
        for community_id in file_communities.get(&hash).into_iter().flatten() {
            records.push(make_record(
                LegacyRecordKind::File,
                hash.clone(),
                community_id.clone(),
                None,
                &source.peer_id,
                &exported_at,
                None,
                None,
                json!({
                    "filename": file.filename,
                    "size": file.size,
                    "sourcePeerIds": file.source_peer_ids,
                    "bytesAvailable": file.bytes_base64.is_some(),
                    "bytesSha256": file.bytes_sha256,
                }),
            ));
        }
        files.push(file);
    }

    records.sort_by(|left, right| record_sort_key(left).cmp(&record_sort_key(right)));
    let mut archive = LegacyArchive {
        schema_version: LEGACY_ARCHIVE_SCHEMA_VERSION,
        archive_id: uuid::Uuid::new_v4().to_string(),
        exported_at,
        source,
        records,
        files,
        archive_sha256: String::new(),
    };
    archive.archive_sha256 = archive_hash(&archive)?;
    Ok(archive)
}

pub fn write_archive_atomic(archive: &LegacyArchive, path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("mesharchive.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(archive)?)?;
    if path.exists() {
        anyhow::bail!("refusing to overwrite existing archive {}", path.display());
    }
    fs::rename(temp, path)?;
    Ok(())
}

pub fn read_archive(path: &Path) -> anyhow::Result<LegacyArchive> {
    let archive: LegacyArchive = serde_json::from_slice(&fs::read(path)?)?;
    validate_archive(&archive)?;
    Ok(archive)
}

pub fn validate_archive(archive: &LegacyArchive) -> anyhow::Result<()> {
    if archive.schema_version != LEGACY_ARCHIVE_SCHEMA_VERSION {
        anyhow::bail!(
            "unsupported legacy archive schema {}, expected {}",
            archive.schema_version,
            LEGACY_ARCHIVE_SCHEMA_VERSION
        );
    }
    if archive.source.peer_id.trim().is_empty() {
        anyhow::bail!("archive source peer ID is empty");
    }
    let expected_archive_hash = archive_hash(archive)?;
    if expected_archive_hash != archive.archive_sha256 {
        anyhow::bail!("archive SHA-256 mismatch");
    }
    let mut identities = HashSet::new();
    for record in &archive.records {
        if record.source_peer_id != archive.source.peer_id {
            anyhow::bail!("record {} names a different source peer", record.entity_id);
        }
        if record.record_sha256 != record_hash(record)? {
            anyhow::bail!("record SHA-256 mismatch for {}", record.entity_id);
        }
        let identity = (
            record.kind,
            record.entity_id.clone(),
            record.community_id.clone(),
            record.parent_id.clone(),
        );
        if !identities.insert(identity) {
            anyhow::bail!("archive contains duplicate record {}", record.entity_id);
        }
    }
    for file in &archive.files {
        match (&file.bytes_base64, &file.bytes_sha256) {
            (Some(encoded), Some(expected)) => {
                let bytes = BASE64.decode(encoded)?;
                let actual = sha256_hex(&bytes);
                if &actual != expected || actual != file.file_hash {
                    anyhow::bail!("embedded file hash mismatch for {}", file.file_hash);
                }
                if bytes.len() as u64 != file.size {
                    anyhow::bail!("embedded file size mismatch for {}", file.file_hash);
                }
            }
            (None, None) => {}
            _ => anyhow::bail!(
                "file {} has incomplete embedded-byte metadata",
                file.file_hash
            ),
        }
    }
    Ok(())
}

pub fn inspect_archives(paths: &[String]) -> anyhow::Result<Vec<LegacyArchiveSummary>> {
    read_archives(paths).map(|archives| archives.iter().map(summarize_archive).collect())
}

pub fn dry_run(request: &LegacyImportRequest) -> LegacyDryRunReport {
    let mut errors = Vec::new();
    let archives = match read_archives(&request.archive_paths) {
        Ok(archives) => archives,
        Err(error) => {
            errors.push(error.to_string());
            Vec::new()
        }
    };
    let summaries = archives.iter().map(summarize_archive).collect::<Vec<_>>();
    let groups = merge_groups_filtered(&archives, &request.include_community_ids);
    let mapping_map = request
        .mappings
        .iter()
        .map(|mapping| (mapping.legacy_community_id.as_str(), mapping))
        .collect::<HashMap<_, _>>();
    let resolutions = request
        .resolutions
        .iter()
        .map(|resolution| {
            (
                resolution.conflict_key.as_str(),
                resolution.selected_record_sha256.as_str(),
            )
        })
        .collect::<HashMap<_, _>>();

    let mut conflicts = Vec::new();
    let mut unmapped = 0usize;
    let mut variant_count = 0usize;
    for group in groups.values() {
        variant_count += group.variants.len();
        if let Some(record) = group
            .variants
            .values()
            .next()
            .map(|variant| &variant.record)
        {
            if target_room(record, &mapping_map).is_none() {
                unmapped += group.variants.len();
            }
        }
        if group.variants.len() > 1 {
            let selected = resolutions
                .get(group.key.as_str())
                .copied()
                .map(str::to_owned);
            let selected_exists = selected
                .as_ref()
                .is_some_and(|hash| group.variants.contains_key(hash));
            conflicts.push(LegacyConflict {
                conflict_key: group.key.clone(),
                kind: group
                    .variants
                    .values()
                    .next()
                    .expect("group has variant")
                    .record
                    .kind,
                entity_id: group
                    .variants
                    .values()
                    .next()
                    .expect("group has variant")
                    .record
                    .entity_id
                    .clone(),
                variants: group
                    .variants
                    .iter()
                    .map(|(hash, variant)| LegacyConflictVariant {
                        record_sha256: hash.clone(),
                        source_peer_ids: variant.source_peer_ids.iter().cloned().collect(),
                        archive_ids: variant.archive_ids.iter().cloned().collect(),
                        preview: preview(&variant.record),
                    })
                    .collect(),
                selected_record_sha256: selected,
                resolved: selected_exists,
            });
        }
    }
    conflicts.sort_by(|a, b| a.conflict_key.cmp(&b.conflict_key));
    let unresolved = conflicts
        .iter()
        .filter(|conflict| !conflict.resolved)
        .count();
    let missing_files = archives
        .iter()
        .flat_map(|archive| &archive.files)
        .filter(|file| file.bytes_base64.is_none())
        .map(|file| file.file_hash.as_str())
        .collect::<HashSet<_>>()
        .len();
    let peer_count = archives
        .iter()
        .map(|archive| archive.source.peer_id.as_str())
        .collect::<HashSet<_>>()
        .len();

    if archives.is_empty() && errors.is_empty() {
        errors.push("select at least one legacy archive".into());
    }
    if unmapped > 0 {
        errors.push(format!(
            "{unmapped} record variant(s) do not have a Matrix target mapping"
        ));
    }
    let mut warnings = Vec::new();
    if peer_count == 1 {
        warnings.push(
            "Only one peer archive is present; divergent peer history cannot be detected".into(),
        );
    }
    if missing_files > 0 {
        warnings.push(format!(
            "{missing_files} attachment file(s) have provenance metadata but no embedded bytes"
        ));
    }
    if unresolved > 0 {
        warnings.push(format!(
            "{unresolved} divergent history conflict(s) require an explicit selection"
        ));
    }

    let plan_sha256 = plan_hash(
        &archives,
        &request.include_community_ids,
        &request.mappings,
        &request.resolutions,
    )
    .unwrap_or_else(|_| String::new());
    let ready = errors.is_empty() && unresolved == 0 && !plan_sha256.is_empty();
    let approval_token =
        ready.then(|| sha256_hex(format!("mesh-legacy-import:{plan_sha256}").as_bytes()));
    let approval_phrase = approval_token
        .as_ref()
        .map(|token| format!("APPROVE LEGACY IMPORT {}", &token[..12]));

    LegacyDryRunReport {
        plan_sha256,
        archives: summaries,
        peer_count,
        record_group_count: groups.len(),
        variant_count,
        conflicts,
        unresolved_conflict_count: unresolved,
        unmapped_record_count: unmapped,
        missing_file_count: missing_files,
        errors,
        warnings,
        approval_token,
        approval_phrase,
    }
}

pub fn approved_import_events(
    request: &LegacyImportRequest,
    approval_token: &str,
    approval_phrase: &str,
) -> anyhow::Result<(String, Vec<LegacyImportEvent>)> {
    let report = dry_run(request);
    if !report.errors.is_empty() || report.unresolved_conflict_count != 0 {
        anyhow::bail!("legacy import plan is not ready; run and resolve the dry-run report first");
    }
    let expected_token = report
        .approval_token
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("plan has no approval token"))?;
    let expected_phrase = report
        .approval_phrase
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("plan has no approval phrase"))?;
    if approval_token != expected_token || approval_phrase.trim() != expected_phrase {
        anyhow::bail!("explicit legacy import approval did not match the current plan");
    }

    let archives = read_archives(&request.archive_paths)?;
    let groups = merge_groups_filtered(&archives, &request.include_community_ids);
    let mappings = request
        .mappings
        .iter()
        .map(|mapping| (mapping.legacy_community_id.as_str(), mapping))
        .collect::<HashMap<_, _>>();
    let resolutions = request
        .resolutions
        .iter()
        .map(|resolution| {
            (
                resolution.conflict_key.as_str(),
                resolution.selected_record_sha256.as_str(),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut events = Vec::new();

    for group in groups.values() {
        let selected = resolutions.get(group.key.as_str()).copied();
        for (record_hash, variant) in &group.variants {
            let target = target_room(&variant.record, &mappings).ok_or_else(|| {
                anyhow::anyhow!("record {} has no Matrix target", variant.record.entity_id)
            })?;
            let conflict_status = if group.variants.len() == 1 {
                "not_divergent"
            } else if selected == Some(record_hash.as_str()) {
                "approved_selected"
            } else {
                "approved_non_selected_variant"
            };
            let import_key =
                sha256_hex(format!("{}:{}:{}", report.plan_sha256, target, record_hash).as_bytes());
            events.push(LegacyImportEvent {
                target_room_id: target.to_owned(),
                import_key,
                content: json!({
                    "schemaVersion": LEGACY_ARCHIVE_SCHEMA_VERSION,
                    "planSha256": report.plan_sha256,
                    "conflictKey": group.key,
                    "conflictStatus": conflict_status,
                    "selectedRecordSha256": selected,
                    "sourcePeerIds": variant.source_peer_ids,
                    "sourceArchiveIds": variant.archive_ids,
                    "record": variant.record,
                }),
            });
        }
    }
    events.sort_by(|a, b| {
        a.target_room_id
            .cmp(&b.target_room_id)
            .then_with(|| a.import_key.cmp(&b.import_key))
    });
    Ok((report.plan_sha256, events))
}

pub fn import_receipt(
    db: &Database,
    plan_sha256: &str,
    import_key: &str,
) -> anyhow::Result<Option<String>> {
    let conn = db.conn.lock().map_err(|e| anyhow::anyhow!("lock: {e}"))?;
    conn.query_row(
        "SELECT matrix_event_id FROM legacy_import_receipts WHERE plan_sha256 = ?1 AND import_key = ?2",
        params![plan_sha256, import_key],
        |row| row.get(0),
    ).optional().map_err(Into::into)
}

pub fn store_import_receipt(
    db: &Database,
    plan_sha256: &str,
    event: &LegacyImportEvent,
    matrix_event_id: &str,
) -> anyhow::Result<()> {
    let conn = db.conn.lock().map_err(|e| anyhow::anyhow!("lock: {e}"))?;
    conn.execute(
        "INSERT OR IGNORE INTO legacy_import_receipts
         (plan_sha256, import_key, target_room_id, matrix_event_id)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            plan_sha256,
            event.import_key,
            event.target_room_id,
            matrix_event_id
        ],
    )?;
    Ok(())
}

fn make_record(
    kind: LegacyRecordKind,
    entity_id: String,
    community_id: String,
    parent_id: Option<String>,
    source_peer_id: &str,
    observed_at: &str,
    original_timestamp: Option<String>,
    original_signature: Option<String>,
    payload: Value,
) -> LegacyRecord {
    let mut record = LegacyRecord {
        kind,
        entity_id,
        community_id,
        parent_id,
        source_peer_id: source_peer_id.to_owned(),
        observed_at: observed_at.to_owned(),
        original_timestamp,
        original_signature,
        payload,
        record_sha256: String::new(),
    };
    record.record_sha256 = record_hash(&record).expect("serializable legacy record");
    record
}

fn record_hash(record: &LegacyRecord) -> anyhow::Result<String> {
    // Source peer and observation time are deliberately excluded. Two peers
    // that observed identical signed history should agree on this hash.
    hash_json(&json!({
        "kind": record.kind,
        "entityId": record.entity_id,
        "communityId": record.community_id,
        "parentId": record.parent_id,
        "originalTimestamp": record.original_timestamp,
        "originalSignature": record.original_signature,
        "payload": record.payload,
    }))
}

fn archive_hash(archive: &LegacyArchive) -> anyhow::Result<String> {
    hash_json(&json!({
        "schemaVersion": archive.schema_version,
        "archiveId": archive.archive_id,
        "exportedAt": archive.exported_at,
        "source": archive.source,
        "records": archive.records,
        "files": archive.files,
    }))
}

fn plan_hash(
    archives: &[LegacyArchive],
    included_communities: &[String],
    mappings: &[LegacyTargetMapping],
    resolutions: &[LegacyConflictResolution],
) -> anyhow::Result<String> {
    let mut archive_hashes = archives
        .iter()
        .map(|archive| archive.archive_sha256.clone())
        .collect::<Vec<_>>();
    archive_hashes.sort();
    let mut included_communities = included_communities.to_vec();
    included_communities.sort();
    included_communities.dedup();
    let mut mappings = mappings.to_vec();
    mappings.sort_by(|a, b| a.legacy_community_id.cmp(&b.legacy_community_id));
    let mut resolutions = resolutions.to_vec();
    resolutions.sort_by(|a, b| a.conflict_key.cmp(&b.conflict_key));
    hash_json(&json!({
        "archives": archive_hashes,
        "includedCommunities": included_communities,
        "mappings": mappings,
        "resolutions": resolutions,
    }))
}

fn hash_json(value: &Value) -> anyhow::Result<String> {
    Ok(sha256_hex(&serde_json::to_vec(&canonical_json(value))?))
}

fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let mut canonical = serde_json::Map::new();
            for key in keys {
                canonical.insert(key.clone(), canonical_json(&map[key]));
            }
            Value::Object(canonical)
        }
        Value::Array(values) => Value::Array(values.iter().map(canonical_json).collect()),
        _ => value.clone(),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn collect_attachment_metadata(value: &Value, files: &mut BTreeMap<String, LegacyFileBlob>) {
    let Some(attachments) = value.as_array() else {
        return;
    };
    for attachment in attachments {
        let Some(hash) = attachment.get("fileHash").and_then(Value::as_str) else {
            continue;
        };
        let filename = attachment
            .get("filename")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let size = attachment.get("size").and_then(Value::as_u64).unwrap_or(0);
        let source = attachment
            .get("sourcePeerId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let file = files
            .entry(hash.to_owned())
            .or_insert_with(|| LegacyFileBlob {
                file_hash: hash.to_owned(),
                filename: filename.to_owned(),
                size,
                source_peer_ids: Vec::new(),
                bytes_base64: None,
                bytes_sha256: None,
            });
        if !source.is_empty() {
            file.source_peer_ids.push(source.to_owned());
        }
    }
}

fn file_communities(records: &[LegacyRecord]) -> BTreeMap<String, BTreeSet<String>> {
    let mut result = BTreeMap::<String, BTreeSet<String>>::new();
    for record in records
        .iter()
        .filter(|record| record.kind == LegacyRecordKind::Message)
    {
        if let Some(attachments) = record.payload.get("attachments").and_then(Value::as_array) {
            for attachment in attachments {
                if let Some(hash) = attachment.get("fileHash").and_then(Value::as_str) {
                    result
                        .entry(hash.to_owned())
                        .or_default()
                        .insert(record.community_id.clone());
                }
            }
        }
    }
    result
}

fn record_sort_key(record: &LegacyRecord) -> (String, String, String, String, String) {
    (
        record.community_id.clone(),
        record.kind.as_str().into(),
        record.parent_id.clone().unwrap_or_default(),
        record.entity_id.clone(),
        record.record_sha256.clone(),
    )
}

fn conflict_key(record: &LegacyRecord) -> String {
    format!(
        "{}:{}:{}:{}",
        record.kind.as_str(),
        record.community_id,
        record.parent_id.as_deref().unwrap_or("-"),
        record.entity_id
    )
}

#[cfg(test)]
fn merge_groups(archives: &[LegacyArchive]) -> BTreeMap<String, Group> {
    merge_groups_filtered(archives, &[])
}

fn merge_groups_filtered(
    archives: &[LegacyArchive],
    included_communities: &[String],
) -> BTreeMap<String, Group> {
    let included = included_communities
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut groups = BTreeMap::<String, Group>::new();
    for archive in archives {
        for record in &archive.records {
            if !included.is_empty() && !included.contains(record.community_id.as_str()) {
                continue;
            }
            let key = conflict_key(record);
            let group = groups.entry(key.clone()).or_insert_with(|| Group {
                key,
                variants: BTreeMap::new(),
            });
            let variant = group
                .variants
                .entry(record.record_sha256.clone())
                .or_insert_with(|| Variant {
                    record: record.clone(),
                    source_peer_ids: BTreeSet::new(),
                    archive_ids: BTreeSet::new(),
                });
            variant
                .source_peer_ids
                .insert(record.source_peer_id.clone());
            variant.archive_ids.insert(archive.archive_id.clone());
        }
    }
    groups
}

fn target_room<'a>(
    record: &LegacyRecord,
    mappings: &HashMap<&str, &'a LegacyTargetMapping>,
) -> Option<&'a str> {
    let mapping = mappings.get(record.community_id.as_str())?;
    match record.kind {
        LegacyRecordKind::Channel | LegacyRecordKind::Message => record
            .parent_id
            .as_deref()
            .and_then(|channel_id| mapping.channel_rooms.get(channel_id))
            .map(String::as_str),
        // Spaces created by the current Matrix slice are not encrypted. Route
        // community-wide provenance to a deterministic encrypted child room
        // rather than leaking membership/control history into Space events.
        _ => mapping.channel_rooms.values().map(String::as_str).min(),
    }
}

fn preview(record: &LegacyRecord) -> String {
    if let Some(content) = record.payload.get("content").and_then(Value::as_str) {
        return content.chars().take(160).collect();
    }
    let serialized = serde_json::to_string(&record.payload).unwrap_or_default();
    serialized.chars().take(160).collect()
}

fn read_archives(paths: &[String]) -> anyhow::Result<Vec<LegacyArchive>> {
    if paths.is_empty() {
        anyhow::bail!("select at least one legacy archive");
    }
    let mut archives = Vec::new();
    let mut hashes = HashSet::new();
    let mut source_peers = HashSet::new();
    for path in paths {
        let archive = read_archive(Path::new(path))
            .map_err(|error| anyhow::anyhow!("{}: {error}", PathBuf::from(path).display()))?;
        if !hashes.insert(archive.archive_sha256.clone()) {
            anyhow::bail!("the same archive was supplied more than once");
        }
        if !source_peers.insert(archive.source.peer_id.clone()) {
            anyhow::bail!(
                "more than one archive was supplied for source peer {}; select one observation per peer",
                archive.source.peer_id
            );
        }
        archives.push(archive);
    }
    Ok(archives)
}

fn summarize_archive(archive: &LegacyArchive) -> LegacyArchiveSummary {
    let mut communities = BTreeMap::<String, LegacyCommunitySummary>::new();
    for record in &archive.records {
        match record.kind {
            LegacyRecordKind::Community => {
                communities
                    .entry(record.community_id.clone())
                    .or_insert_with(|| LegacyCommunitySummary {
                        id: record.community_id.clone(),
                        name: record
                            .payload
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("Unnamed community")
                            .to_owned(),
                        channels: Vec::new(),
                    });
            }
            LegacyRecordKind::Channel => {
                communities
                    .entry(record.community_id.clone())
                    .or_insert_with(|| LegacyCommunitySummary {
                        id: record.community_id.clone(),
                        name: "Unnamed community".into(),
                        channels: Vec::new(),
                    })
                    .channels
                    .push(LegacyChannelSummary {
                        id: record.entity_id.clone(),
                        name: record
                            .payload
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("unnamed")
                            .to_owned(),
                        channel_type: record
                            .payload
                            .get("channelType")
                            .and_then(Value::as_str)
                            .unwrap_or("text")
                            .to_owned(),
                    });
            }
            _ => {}
        }
    }
    for community in communities.values_mut() {
        community
            .channels
            .sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    }
    LegacyArchiveSummary {
        archive_id: archive.archive_id.clone(),
        archive_sha256: archive.archive_sha256.clone(),
        source_peer_id: archive.source.peer_id.clone(),
        communities: communities.into_values().collect(),
        record_count: archive.records.len(),
        embedded_file_count: archive
            .files
            .iter()
            .filter(|file| file.bytes_base64.is_some())
            .count(),
        missing_file_count: archive
            .files
            .iter()
            .filter(|file| file.bytes_base64.is_none())
            .count(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn archive(peer: &str, message_body: &str) -> LegacyArchive {
        let record = make_record(
            LegacyRecordKind::Message,
            "message-1".into(),
            "community-1".into(),
            Some("channel-1".into()),
            peer,
            "2026-07-22T00:00:00Z",
            Some("2026-07-21T23:59:00Z".into()),
            Some("signature".into()),
            json!({"content": message_body, "attachments": []}),
        );
        let mut archive = LegacyArchive {
            schema_version: 1,
            archive_id: format!("archive-{peer}"),
            exported_at: "2026-07-22T00:00:00Z".into(),
            source: LegacyArchiveSource {
                peer_id: peer.into(),
                public_key: format!("pk-{peer}"),
                display_name: peer.into(),
            },
            records: vec![record],
            files: vec![],
            archive_sha256: String::new(),
        };
        archive.archive_sha256 = archive_hash(&archive).unwrap();
        archive
    }

    #[test]
    fn identical_peer_observations_share_a_record_hash() {
        let left = archive("peer-a", "same");
        let right = archive("peer-b", "same");
        assert_eq!(
            left.records[0].record_sha256,
            right.records[0].record_sha256
        );
        assert_eq!(
            merge_groups(&[left, right])
                .values()
                .next()
                .unwrap()
                .variants
                .len(),
            1
        );
    }

    #[test]
    fn divergent_observations_are_not_canonicalized() {
        let groups = merge_groups(&[archive("peer-a", "left"), archive("peer-b", "right")]);
        let group = groups.values().next().unwrap();
        assert_eq!(group.variants.len(), 2);
        assert_eq!(
            group
                .variants
                .values()
                .flat_map(|variant| &variant.source_peer_ids)
                .count(),
            2
        );
    }

    #[test]
    fn archive_hash_detects_tampering() {
        let mut value = archive("peer-a", "original");
        value.records[0].payload["content"] = Value::String("tampered".into());
        assert!(validate_archive(&value).is_err());
    }

    #[test]
    fn canonical_json_hash_is_independent_of_object_key_order() {
        let left = serde_json::from_str::<Value>(r#"{"b":2,"a":1}"#).unwrap();
        let right = serde_json::from_str::<Value>(r#"{"a":1,"b":2}"#).unwrap();
        assert_eq!(hash_json(&left).unwrap(), hash_json(&right).unwrap());
    }

    #[test]
    fn approval_requires_resolution_and_preserves_both_variants() {
        let temp = tempfile::tempdir().unwrap();
        let left = archive("peer-a", "left");
        let right = archive("peer-b", "right");
        let left_path = temp.path().join("left.mesharchive.json");
        let right_path = temp.path().join("right.mesharchive.json");
        write_archive_atomic(&left, &left_path).unwrap();
        write_archive_atomic(&right, &right_path).unwrap();

        let mut request = LegacyImportRequest {
            archive_paths: vec![
                left_path.to_string_lossy().into_owned(),
                right_path.to_string_lossy().into_owned(),
            ],
            include_community_ids: vec!["community-1".into()],
            mappings: vec![LegacyTargetMapping {
                legacy_community_id: "community-1".into(),
                matrix_space_id: "!space:mesh.test".into(),
                channel_rooms: BTreeMap::from([("channel-1".into(), "!room:mesh.test".into())]),
            }],
            resolutions: vec![],
        };

        let unresolved = dry_run(&request);
        assert_eq!(unresolved.unresolved_conflict_count, 1);
        assert!(unresolved.approval_token.is_none());
        let conflict = &unresolved.conflicts[0];
        request.resolutions.push(LegacyConflictResolution {
            conflict_key: conflict.conflict_key.clone(),
            selected_record_sha256: conflict.variants[0].record_sha256.clone(),
        });

        let ready = dry_run(&request);
        let token = ready.approval_token.clone().unwrap();
        let phrase = ready.approval_phrase.clone().unwrap();
        assert!(approved_import_events(&request, &token, "APPROVE LEGACY IMPORT wrong").is_err());

        let (_, events) = approved_import_events(&request, &token, &phrase).unwrap();
        assert_eq!(
            events.len(),
            2,
            "neither divergent peer variant may be discarded"
        );
        let statuses = events
            .iter()
            .filter_map(|event| event.content["conflictStatus"].as_str())
            .collect::<HashSet<_>>();
        assert!(statuses.contains("approved_selected"));
        assert!(statuses.contains("approved_non_selected_variant"));
    }

    #[test]
    fn exports_all_required_legacy_records_and_verified_file_bytes_without_secrets() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::storage::schema::run_migrations(&connection).unwrap();
        connection.execute(
            "INSERT INTO communities
             (id, name, description, community_private_key, group_key, owner_public_key, group_key_epoch)
             VALUES ('community-1', 'Community', 'Description', 'private-secret', 'group-secret', 'owner-key', 7)",
            [],
        ).unwrap();
        connection
            .execute(
                "INSERT INTO channels (id, community_id, name, channel_type)
             VALUES ('channel-1', 'community-1', 'general', 'text')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO members (community_id, public_key, display_name)
             VALUES ('community-1', 'member-key', 'Member')",
                [],
            )
            .unwrap();

        let temp = tempfile::tempdir().unwrap();
        let file_path = temp.path().join("attachment.txt");
        fs::write(&file_path, b"archived attachment").unwrap();
        let file_hash = sha256_hex(b"archived attachment");
        let attachments = json!([{
            "fileHash": file_hash,
            "filename": "attachment.txt",
            "size": 19,
            "chunks": 1,
            "sourcePeerId": "peer-a"
        }]);
        connection
            .execute(
                "INSERT INTO messages
             (id, channel_id, author_public_key, author_display_name, author_avatar_color,
              content, attachments, reactions, timestamp, signature)
             VALUES (?1, 'channel-1', 'member-key', 'Member', '#123456', 'hello', ?2,
                     '{}', '2026-07-22T00:00:00Z', 'message-signature')",
                params!["message-1", attachments.to_string()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO control_log
             (id, community_id, event_type, payload, signed_by, signature, timestamp)
             VALUES ('control-1', 'community-1', 'role_changed', '{}', 'owner-key',
                     'control-signature', '2026-07-22T00:00:01Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO file_availability (file_hash, peer_id, filename, size)
             VALUES (?1, 'peer-a', 'attachment.txt', 19)",
                [file_hash.as_str()],
            )
            .unwrap();

        let db = Database {
            conn: Arc::new(Mutex::new(connection)),
        };
        let archive = export_legacy_archive(
            &db,
            LegacyArchiveSource {
                peer_id: "peer-a".into(),
                public_key: "public-key".into(),
                display_name: "Alice".into(),
            },
            &LegacyExportRequest {
                community_id: Some("community-1".into()),
                file_candidates: vec![file_path.to_string_lossy().into_owned()],
                ..Default::default()
            },
        )
        .unwrap();

        validate_archive(&archive).unwrap();
        for kind in [
            LegacyRecordKind::Community,
            LegacyRecordKind::Channel,
            LegacyRecordKind::Membership,
            LegacyRecordKind::Message,
            LegacyRecordKind::ControlEvent,
            LegacyRecordKind::File,
        ] {
            assert!(archive.records.iter().any(|record| record.kind == kind));
        }
        let serialized = serde_json::to_string(&archive).unwrap();
        assert!(!serialized.contains("private-secret"));
        assert!(!serialized.contains("group-secret"));
        assert!(archive.files[0].bytes_base64.is_some());
        assert_eq!(
            archive.files[0].bytes_sha256.as_deref(),
            Some(file_hash.as_str())
        );
    }
}
