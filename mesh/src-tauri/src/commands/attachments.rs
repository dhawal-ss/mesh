use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::error::CommandError;
use crate::backend::{BackendError, BackendKind};
use crate::security::{classify_attachment, is_file_directly_under, AttachmentDisposition};
use crate::state::{
    native_requests::{NativeRequestError, NativeUiInteractionGuard},
    AppState,
};

/// Retained only for the validation regression test proving the removed
/// renderer byte-staging boundary stayed bounded.
#[cfg(test)]
const MAX_STAGED_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_CUSTOM_EMOJI_BYTES: u64 = 512 * 1024;
const STAGED_ATTACHMENT_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const ATTACHMENT_GRANT_TTL: Duration = Duration::from_secs(60 * 60);
const CUSTOM_EMOJI_GRANT_TTL: Duration = Duration::from_secs(15 * 60);
const UNCLAIMED_DROP_GRANT_TTL: Duration = Duration::from_secs(30);
const HEADER_INSPECTION_BYTES: usize = 4 * 1024;
const MAX_PENDING_ATTACHMENTS: usize = 10;

fn is_picker_invisible(character: char) -> bool {
    matches!(
        character,
        '\u{061c}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{206f}'
            | '\u{feff}'
            | '\u{fff9}'..='\u{fffb}'
    )
}

fn sanitize_picker_label(value: &str, max_chars: usize) -> String {
    let label = value
        .chars()
        .filter(|character| !character.is_control() && !is_picker_invisible(*character))
        .take(max_chars)
        .collect::<String>();
    if label.trim().is_empty() {
        "unknown".into()
    } else {
        label
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum AttachmentGrantPurpose {
    MessageAttachment {
        account_generation: u64,
        user_id: String,
    },
    CustomEmoji {
        community_id: String,
        account_generation: u64,
        user_id: String,
    },
}

impl AttachmentGrantPurpose {
    fn message_attachment(account_generation: u64, user_id: impl Into<String>) -> Self {
        Self::MessageAttachment {
            account_generation,
            user_id: user_id.into(),
        }
    }
}

#[derive(Clone, Debug)]
struct AttachmentGrant {
    token: String,
    path: PathBuf,
    filename: String,
    size: u64,
    content_type: String,
    sha256: [u8; 32],
    purpose: AttachmentGrantPurpose,
    staged_root: Option<PathBuf>,
    expires_at: Instant,
}

#[derive(Debug)]
struct InspectedAttachment {
    path: PathBuf,
    filename: String,
    size: u64,
    content_type: String,
    sha256: [u8; 32],
}

#[derive(Clone, Default)]
pub struct AttachmentGrantStore {
    grants: Arc<Mutex<HashMap<String, AttachmentGrant>>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentGrantDto {
    grant: String,
    name: String,
    size: u64,
    content_type: String,
    /// Kept only for the explicitly enabled legacy backend. Matrix upload
    /// commands never accept or trust this renderer-visible path.
    #[serde(skip_serializing_if = "Option::is_none")]
    legacy_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAttachmentDrop {
    pub drop_id: String,
    pub position: NativeDropPosition,
    pub files: Vec<AttachmentGrantDto>,
    pub errors: Vec<String>,
    pub account_scope: Option<NativeAttachmentAccountScope>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAttachmentIntake {
    pub files: Vec<AttachmentGrantDto>,
    pub errors: Vec<String>,
    pub account_scope: NativeAttachmentAccountScope,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAttachmentAccountScope {
    pub account_generation: u64,
    pub user_id: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct NativeDropPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAttachmentDropStart {
    pub drop_id: String,
    pub position: NativeDropPosition,
    pub account_generation: u64,
}

pub(crate) fn staging_root(app: &AppHandle) -> Result<PathBuf, CommandError> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|error| CommandError::Other(error.to_string()))?
        .join("attachment-staging"))
}

fn validate_filename(filename: &str) -> Result<&str, CommandError> {
    let trimmed = filename.trim();
    if trimmed != filename
        || trimmed.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
        || trimmed.ends_with(['.', ' '])
        || matches!(trimmed, "." | "..")
        || Path::new(trimmed).is_absolute()
        || Path::new(trimmed).components().count() != 1
    {
        return Err(CommandError::Validation(
            "Attachment filename is not safe on this platform".into(),
        ));
    }
    let safe_name = Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| CommandError::Validation("Attachment filename is missing".into()))?;
    if safe_name.chars().any(char::is_control) {
        return Err(CommandError::Validation(
            "Attachment filename contains unsupported control characters".into(),
        ));
    }
    let device_basename = safe_name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved_device = matches!(device_basename.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || device_basename.strip_prefix("COM").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        })
        || device_basename.strip_prefix("LPT").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        });
    if reserved_device {
        return Err(CommandError::Validation(
            "Attachment filename uses a reserved device name".into(),
        ));
    }
    if classify_attachment(safe_name, None, &[]).disposition == AttachmentDisposition::Active {
        return Err(CommandError::Validation(
            "This executable or script file type cannot be attached".into(),
        ));
    }
    Ok(safe_name)
}

fn validate_attachment_payload(
    filename: &str,
    size: u64,
    header: &[u8],
    max_bytes: u64,
) -> Result<(), CommandError> {
    validate_filename(filename)?;
    if size == 0 {
        return Err(CommandError::Validation("Attachment is empty".into()));
    }
    if size > max_bytes {
        let limit = if max_bytes < 1024 * 1024 {
            format!("{} KB", max_bytes / 1024)
        } else {
            format!("{} MB", max_bytes / 1024 / 1024)
        };
        return Err(CommandError::Validation(format!(
            "Attachment exceeds the {limit} limit"
        )));
    }
    let content_type = content_type_for_filename(filename);
    if classify_attachment(filename, Some(&content_type), header).disposition
        == AttachmentDisposition::Active
    {
        return Err(CommandError::Validation(
            "Active file contents cannot be attached".into(),
        ));
    }
    Ok(())
}

fn content_type_for_filename(filename: &str) -> String {
    let content_type = match Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("gif") => "image/gif",
        Some("jpeg" | "jpg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("txt" | "md") => "text/plain",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    };
    content_type.to_owned()
}

async fn inspect_native_path_with_limit(
    path: PathBuf,
    max_bytes: u64,
) -> Result<InspectedAttachment, CommandError> {
    let canonical = tokio::fs::canonicalize(path)
        .await
        .map_err(|error| CommandError::Validation(format!("Could not open that file: {error}")))?;
    let metadata = tokio::fs::metadata(&canonical).await.map_err(|error| {
        CommandError::Validation(format!("Could not inspect that file: {error}"))
    })?;
    if !metadata.is_file() {
        return Err(CommandError::Validation(
            "Only regular files can be attached".into(),
        ));
    }
    let filename = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| CommandError::Validation("Attachment filename is not valid UTF-8".into()))?
        .to_owned();
    let mut file = tokio::fs::File::open(&canonical)
        .await
        .map_err(|error| CommandError::Validation(format!("Could not read that file: {error}")))?;
    let mut header = [0_u8; HEADER_INSPECTION_BYTES];
    let header_len = file
        .read(&mut header)
        .await
        .map_err(|error| CommandError::Validation(format!("Could not read that file: {error}")))?;
    validate_attachment_payload(&filename, metadata.len(), &header[..header_len], max_bytes)?;
    let mut digest = Sha256::new();
    digest.update(&header[..header_len]);
    let mut observed_size = header_len as u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).await.map_err(|error| {
            CommandError::Validation(format!("Could not read that file: {error}"))
        })?;
        if read == 0 {
            break;
        }
        observed_size = observed_size.saturating_add(read as u64);
        if observed_size > max_bytes {
            return Err(CommandError::Validation(
                "Attachment changed while Mesh was inspecting it".into(),
            ));
        }
        digest.update(&buffer[..read]);
    }
    if observed_size != metadata.len() {
        return Err(CommandError::Validation(
            "Attachment changed while Mesh was inspecting it".into(),
        ));
    }
    let content_type = content_type_for_filename(&filename);
    Ok(InspectedAttachment {
        path: canonical,
        filename,
        size: metadata.len(),
        content_type,
        sha256: digest.finalize().into(),
    })
}

async fn inspect_native_path(path: PathBuf) -> Result<InspectedAttachment, CommandError> {
    inspect_native_path_with_limit(path, MAX_ATTACHMENT_BYTES).await
}

fn validate_custom_emoji(inspected: &InspectedAttachment) -> Result<(), CommandError> {
    if !matches!(
        inspected.content_type.as_str(),
        "image/png" | "image/jpeg" | "image/webp"
    ) {
        return Err(CommandError::Validation(
            "Choose a PNG, JPEG, or WebP image".into(),
        ));
    }
    Ok(())
}

impl AttachmentGrantStore {
    fn schedule_expiration(&self, token: String, ttl: Duration) {
        let store = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(ttl).await;
            let mut grants = store.grants.lock().await;
            let staged_root = if grants
                .get(&token)
                .is_some_and(|grant| grant.expires_at <= Instant::now())
            {
                grants.remove(&token).and_then(|grant| grant.staged_root)
            } else {
                None
            };
            drop(grants);
            if let Some(root) = staged_root {
                let _ = tokio::fs::remove_dir_all(root).await;
            }
        });
    }

    async fn issue(
        &self,
        inspected: InspectedAttachment,
        expose_legacy_path: bool,
        ttl: Duration,
        purpose: AttachmentGrantPurpose,
    ) -> AttachmentGrantDto {
        let InspectedAttachment {
            path,
            filename,
            size,
            content_type,
            sha256,
        } = inspected;
        let token = Uuid::new_v4().to_string();
        let grant = AttachmentGrant {
            token: token.clone(),
            path: path.clone(),
            filename: filename.clone(),
            size,
            content_type: content_type.clone(),
            sha256,
            purpose,
            staged_root: None,
            expires_at: Instant::now() + ttl,
        };
        let mut grants = self.grants.lock().await;
        grants.retain(|_, grant| grant.expires_at > Instant::now());
        grants.insert(token.clone(), grant);
        self.schedule_expiration(token.clone(), ttl);
        AttachmentGrantDto {
            grant: token,
            name: filename,
            size,
            content_type,
            legacy_path: expose_legacy_path.then(|| path.to_string_lossy().into_owned()),
        }
    }

    pub async fn claim_to_staging(
        &self,
        token: &str,
        staging_base: &Path,
        account_generation: u64,
        user_id: &str,
    ) -> Result<ClaimedAttachment, CommandError> {
        Uuid::parse_str(token)
            .map_err(|_| CommandError::Validation("Invalid attachment grant".into()))?;
        let grant = {
            let mut grants = self.grants.lock().await;
            let Some(grant) = grants.get(token) else {
                return Err(CommandError::Validation(
                    "Attachment access expired or was already used; choose the file again".into(),
                ));
            };
            if grant.expires_at <= Instant::now() {
                grants.remove(token);
                return Err(CommandError::Validation(
                    "Attachment access expired; choose the file again".into(),
                ));
            }
            match &grant.purpose {
                AttachmentGrantPurpose::MessageAttachment {
                    account_generation: grant_generation,
                    user_id: grant_user_id,
                } if *grant_generation == account_generation && grant_user_id == user_id => {}
                AttachmentGrantPurpose::MessageAttachment { .. } => {
                    return Err(CommandError::Cancelled(
                        "That file was selected for a different account. Choose it again.".into(),
                    ));
                }
                AttachmentGrantPurpose::CustomEmoji { .. } => {
                    return Err(CommandError::Validation(
                        "That file selection cannot be used as a message attachment".into(),
                    ));
                }
            }
            grants
                .remove(token)
                .expect("validated attachment grant must remain present")
        };
        let inspected = inspect_native_path(grant.path.clone()).await?;
        if inspected.path != grant.path
            || inspected.filename != grant.filename
            || inspected.size != grant.size
            || inspected.content_type != grant.content_type
            || inspected.sha256 != grant.sha256
        {
            return Err(CommandError::Validation(
                "The selected attachment changed; choose it again".into(),
            ));
        }
        if grant.staged_root.is_some() {
            return Ok(ClaimedAttachment { grant });
        }
        let staged_root = staging_base.join(token);
        tokio::fs::create_dir_all(&staged_root)
            .await
            .map_err(|error| CommandError::Other(error.to_string()))?;
        let staged_path = staged_root.join(&grant.filename);
        let copy_result: Result<[u8; 32], CommandError> = async {
            let mut source = tokio::fs::File::open(&inspected.path)
                .await
                .map_err(|error| {
                    CommandError::Validation(format!("Could not read that file: {error}"))
                })?;
            let mut target = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged_path)
                .await
                .map_err(|error| CommandError::Other(error.to_string()))?;
            let mut digest = Sha256::new();
            let mut copied = 0_u64;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = source.read(&mut buffer).await.map_err(|error| {
                    CommandError::Validation(format!("Could not read that file: {error}"))
                })?;
                if read == 0 {
                    break;
                }
                copied = copied.saturating_add(read as u64);
                if copied > grant.size {
                    return Err(CommandError::Validation(
                        "The selected attachment changed; choose it again".into(),
                    ));
                }
                digest.update(&buffer[..read]);
                target
                    .write_all(&buffer[..read])
                    .await
                    .map_err(|error| CommandError::Other(error.to_string()))?;
            }
            target
                .sync_all()
                .await
                .map_err(|error| CommandError::Other(error.to_string()))?;
            if copied != grant.size {
                return Err(CommandError::Validation(
                    "The selected attachment changed; choose it again".into(),
                ));
            }
            Ok(digest.finalize().into())
        }
        .await;
        let staged_sha256 = match copy_result {
            Ok(digest) if digest == grant.sha256 => digest,
            Ok(_) => {
                let _ = tokio::fs::remove_dir_all(&staged_root).await;
                return Err(CommandError::Validation(
                    "The selected attachment changed; choose it again".into(),
                ));
            }
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&staged_root).await;
                return Err(error);
            }
        };
        debug_assert_eq!(staged_sha256, grant.sha256);
        let staged_path = tokio::fs::canonicalize(&staged_path)
            .await
            .map_err(|error| CommandError::Other(error.to_string()))?;
        let mut grant = grant;
        grant.path = staged_path;
        grant.staged_root = Some(staged_root);
        Ok(ClaimedAttachment { grant })
    }

    pub async fn claim_custom_emoji(
        &self,
        token: &str,
        community_id: &str,
        account_generation: u64,
        user_id: &str,
    ) -> Result<(String, String, Vec<u8>), CommandError> {
        Uuid::parse_str(token)
            .map_err(|_| CommandError::Validation("Invalid custom emoji selection".into()))?;
        let grant = {
            let mut grants = self.grants.lock().await;
            let Some(grant) = grants.get(token) else {
                return Err(CommandError::Validation(
                    "Image access expired or was already used; choose the image again".into(),
                ));
            };
            if grant.expires_at <= Instant::now() {
                grants.remove(token);
                return Err(CommandError::Validation(
                    "Image access expired; choose the image again".into(),
                ));
            }
            let scope_matches = matches!(
                &grant.purpose,
                AttachmentGrantPurpose::CustomEmoji {
                    community_id: expected_community,
                    account_generation: expected_generation,
                    user_id: expected_user,
                } if expected_community == community_id
                    && *expected_generation == account_generation
                    && expected_user == user_id
            );
            if !scope_matches {
                return Err(CommandError::Validation(
                    "That image selection belongs to a different account or community; choose it again"
                        .into(),
                ));
            }
            grants
                .remove(token)
                .expect("validated custom emoji grant must remain present")
        };
        if grant.size == 0 || grant.size > MAX_CUSTOM_EMOJI_BYTES {
            return Err(CommandError::Validation(
                "Custom emoji images must be 512 KB or smaller".into(),
            ));
        }

        let inspected =
            inspect_native_path_with_limit(grant.path.clone(), MAX_CUSTOM_EMOJI_BYTES).await?;
        validate_custom_emoji(&inspected)?;
        if inspected.path != grant.path
            || inspected.filename != grant.filename
            || inspected.size != grant.size
            || inspected.content_type != grant.content_type
            || inspected.sha256 != grant.sha256
        {
            return Err(CommandError::Validation(
                "The selected image changed; choose it again".into(),
            ));
        }
        let file = tokio::fs::File::open(&inspected.path)
            .await
            .map_err(|error| {
                CommandError::Validation(format!("Could not read that image: {error}"))
            })?;
        let mut bounded_file = file.take(MAX_CUSTOM_EMOJI_BYTES + 1);
        let mut bytes = Vec::with_capacity(grant.size as usize);
        bounded_file
            .read_to_end(&mut bytes)
            .await
            .map_err(|error| {
                CommandError::Validation(format!("Could not read that image: {error}"))
            })?;
        let bytes_sha256: [u8; 32] = Sha256::digest(&bytes).into();
        if bytes.len() as u64 != grant.size
            || bytes.len() as u64 > MAX_CUSTOM_EMOJI_BYTES
            || bytes_sha256 != grant.sha256
        {
            return Err(CommandError::Validation(
                "The selected image changed; choose it again".into(),
            ));
        }

        Ok((grant.filename, grant.content_type, bytes))
    }

    pub async fn restore(&self, mut claimed: ClaimedAttachment) {
        let token = claimed.grant.token.clone();
        claimed.grant.expires_at = Instant::now() + ATTACHMENT_GRANT_TTL;
        self.grants
            .lock()
            .await
            .insert(token.clone(), claimed.grant);
        self.schedule_expiration(token, ATTACHMENT_GRANT_TTL);
    }

    pub async fn revoke(&self, token: &str) -> Result<(), CommandError> {
        Uuid::parse_str(token)
            .map_err(|_| CommandError::Validation("Invalid attachment grant".into()))?;
        let staged_root = self
            .grants
            .lock()
            .await
            .remove(token)
            .and_then(|grant| grant.staged_root);
        if let Some(root) = staged_root {
            let _ = tokio::fs::remove_dir_all(root).await;
        }
        Ok(())
    }

    pub async fn accept_drop_grants(
        &self,
        tokens: &[String],
        account_generation: u64,
        user_id: &str,
    ) -> Result<(), CommandError> {
        if tokens.len() > MAX_PENDING_ATTACHMENTS {
            return Err(CommandError::Validation(
                "Too many attachment grants".into(),
            ));
        }
        let now = Instant::now();
        let mut grants = self.grants.lock().await;
        for token in tokens {
            Uuid::parse_str(token)
                .map_err(|_| CommandError::Validation("Invalid attachment grant".into()))?;
            let grant = grants
                .get(token)
                .ok_or_else(|| CommandError::Validation("Native attachment drop expired".into()))?;
            if grant.expires_at <= now {
                return Err(CommandError::Validation(
                    "Native attachment drop expired".into(),
                ));
            }
            match &grant.purpose {
                AttachmentGrantPurpose::MessageAttachment {
                    account_generation: grant_generation,
                    user_id: grant_user_id,
                } if *grant_generation == account_generation && grant_user_id == user_id => {}
                AttachmentGrantPurpose::MessageAttachment { .. } => {
                    return Err(CommandError::Cancelled(
                        "That file drop belongs to a different account. Drop the files again."
                            .into(),
                    ));
                }
                AttachmentGrantPurpose::CustomEmoji { .. } => {
                    return Err(CommandError::Validation(
                        "That file selection cannot be used as a message attachment".into(),
                    ));
                }
            }
        }
        for token in tokens {
            if let Some(grant) = grants.get_mut(token) {
                grant.expires_at = now + ATTACHMENT_GRANT_TTL;
            }
        }
        drop(grants);
        for token in tokens {
            self.schedule_expiration(token.clone(), ATTACHMENT_GRANT_TTL);
        }
        Ok(())
    }
}

pub struct ClaimedAttachment {
    grant: AttachmentGrant,
}

impl ClaimedAttachment {
    pub fn path(&self) -> String {
        self.grant.path.to_string_lossy().into_owned()
    }

    pub fn filename(&self) -> String {
        self.grant.filename.clone()
    }

    pub fn content_type(&self) -> String {
        self.grant.content_type.clone()
    }

    pub async fn cleanup(&self) {
        if let Some(root) = &self.grant.staged_root {
            let _ = tokio::fs::remove_dir_all(root).await;
        }
    }
}

async fn attachment_account_id(state: &AppState) -> Result<String, CommandError> {
    if let Some(user_id) = state
        .backend
        .backend()
        .active_user_id()
        .await
        .filter(|user_id| !user_id.trim().is_empty())
    {
        return Ok(user_id);
    }
    if state.backend.kind() == BackendKind::LegacyP2p {
        return Ok(BackendKind::LegacyP2p.as_str().into());
    }
    Err(CommandError::NotAuthenticated)
}

fn begin_native_picker(
    state: &AppState,
    account_generation: u64,
) -> Result<NativeUiInteractionGuard, CommandError> {
    match state
        .native_requests
        .begin_native_ui_interaction(account_generation)
    {
        Ok(guard) => Ok(guard),
        Err(NativeRequestError::CapacityExceeded) => Err(CommandError::RateLimited),
        Err(_) => Err(CommandError::Cancelled(
            "Your account changed before Mesh could open the picker. Try again.".into(),
        )),
    }
}

async fn inspect_native_paths(paths: Vec<PathBuf>) -> (Vec<InspectedAttachment>, Vec<String>) {
    let mut inspected_files = Vec::new();
    let mut errors = Vec::new();
    let selected_count = paths.len();
    for path in paths.into_iter().take(MAX_PENDING_ATTACHMENTS) {
        match inspect_native_path(path).await {
            Ok(inspected) => inspected_files.push(inspected),
            Err(error) => errors.push(error.to_string()),
        }
    }
    if selected_count > MAX_PENDING_ATTACHMENTS {
        errors.push(format!(
            "Mesh allows up to {MAX_PENDING_ATTACHMENTS} pending attachments at once."
        ));
    }
    (inspected_files, errors)
}

async fn issue_message_attachment_grants(
    store: &AttachmentGrantStore,
    inspected_files: Vec<InspectedAttachment>,
    expose_legacy_path: bool,
    ttl: Duration,
    account_generation: u64,
    user_id: &str,
) -> Vec<AttachmentGrantDto> {
    let mut files = Vec::with_capacity(inspected_files.len());
    for inspected in inspected_files {
        files.push(
            store
                .issue(
                    inspected,
                    expose_legacy_path,
                    ttl,
                    AttachmentGrantPurpose::message_attachment(account_generation, user_id),
                )
                .await,
        );
    }
    files
}

pub async fn grant_native_drop(
    store: &AttachmentGrantStore,
    state: &AppState,
    drop: NativeAttachmentDropStart,
    paths: Vec<PathBuf>,
    expose_legacy_path: bool,
) -> Result<NativeAttachmentDrop, CommandError> {
    let account_generation = drop.account_generation;
    let initial_user_id = {
        let _account_guard = state
            .native_requests
            .begin_account_mutation(account_generation)
            .map_err(|_| {
                CommandError::Cancelled(
                    "Your account changed before Mesh could read that file drop. Drop it again."
                        .into(),
                )
            })?;
        attachment_account_id(state).await?
    };
    let (inspected_files, errors) = inspect_native_paths(paths).await;
    let _account_guard = state
        .native_requests
        .begin_account_mutation(account_generation)
        .map_err(|_| {
            CommandError::Cancelled(
                "Your account changed while Mesh was reading that file drop. Drop it again.".into(),
            )
        })?;
    let current_user_id = attachment_account_id(state).await?;
    if current_user_id != initial_user_id {
        return Err(CommandError::Cancelled(
            "Your account changed while Mesh was reading that file drop. Drop it again.".into(),
        ));
    }
    let files = issue_message_attachment_grants(
        store,
        inspected_files,
        expose_legacy_path,
        UNCLAIMED_DROP_GRANT_TTL,
        account_generation,
        &initial_user_id,
    )
    .await;
    let NativeAttachmentDropStart {
        drop_id, position, ..
    } = drop;
    Ok(NativeAttachmentDrop {
        drop_id,
        position,
        files,
        errors,
        account_scope: Some(NativeAttachmentAccountScope {
            account_generation,
            user_id: initial_user_id,
        }),
    })
}

/// Open a trusted native picker and mint opaque, time-limited capabilities for
/// the exact files chosen by the user.
#[tauri::command]
pub async fn pick_attachment_grants(
    app: AppHandle,
    store: State<'_, AttachmentGrantStore>,
    state: State<'_, AppState>,
) -> Result<NativeAttachmentIntake, CommandError> {
    let account_generation = state.native_requests.account_generation();
    let native_ui = begin_native_picker(&state, account_generation)?;
    let initial_user_id = attachment_account_id(&state).await?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |paths| {
        let _ = sender.send(paths);
    });
    let selected = receiver
        .await
        .map_err(|_| CommandError::Other("Native file picker closed unexpectedly".into()))?
        .unwrap_or_default();
    let paths = selected
        .into_iter()
        .map(|path| {
            path.into_path()
                .map_err(|_| CommandError::Validation("Only local files can be attached".into()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    drop(native_ui);
    if paths.is_empty() {
        return Ok(NativeAttachmentIntake {
            files: Vec::new(),
            errors: Vec::new(),
            account_scope: NativeAttachmentAccountScope {
                account_generation,
                user_id: initial_user_id,
            },
        });
    }
    let expose_legacy_path = state.backend.kind() == BackendKind::LegacyP2p;
    let (inspected_files, errors) = inspect_native_paths(paths).await;
    let _account_guard = state
        .native_requests
        .begin_account_mutation(account_generation)
        .map_err(|_| {
            CommandError::Cancelled(
                "Your account changed while Mesh was reading the selected files. Choose them again."
                    .into(),
            )
        })?;
    let current_user_id = attachment_account_id(&state).await?;
    if current_user_id != initial_user_id {
        return Err(CommandError::Cancelled(
            "Your account changed while Mesh was reading the selected files. Choose them again."
                .into(),
        ));
    }
    let files = issue_message_attachment_grants(
        &store,
        inspected_files,
        expose_legacy_path,
        ATTACHMENT_GRANT_TTL,
        account_generation,
        &initial_user_id,
    )
    .await;
    Ok(NativeAttachmentIntake {
        files,
        errors,
        account_scope: NativeAttachmentAccountScope {
            account_generation,
            user_id: initial_user_id,
        },
    })
}

/// Open a trusted native picker for one custom emoji. The WebView receives an
/// opaque, short-lived capability, never the file path or image bytes.
#[tauri::command]
pub async fn pick_custom_emoji_grant(
    community_id: String,
    app: AppHandle,
    store: State<'_, AttachmentGrantStore>,
    state: State<'_, AppState>,
) -> Result<Option<AttachmentGrantDto>, CommandError> {
    if state.backend.kind() != BackendKind::Matrix {
        return Err(CommandError::Unsupported(
            "Custom emoji require the production backend".into(),
        ));
    }
    if community_id.trim() != community_id || community_id.is_empty() || community_id.len() > 255 {
        return Err(CommandError::Validation(
            "That community is not available; reopen its settings and try again".into(),
        ));
    }
    let account_generation = state.native_requests.account_generation();
    let native_ui = begin_native_picker(&state, account_generation)?;
    let initial_user_id;
    let community_name;
    {
        initial_user_id = attachment_account_id(&state).await?;
        let communities = state
            .backend
            .backend()
            .list_communities()
            .await
            .map_err(super::backend::map_error)?;
        community_name = communities
            .entities
            .into_iter()
            .find(|community| community.id == community_id)
            .map(|community| sanitize_picker_label(&community.name, 80))
            .ok_or_else(|| {
                CommandError::NotFound(
                    "That community is no longer available; reopen its settings and try again"
                        .into(),
                )
            })?;
    }
    let picker_community_id = sanitize_picker_label(&community_id, 255);
    let picker_account_service = initial_user_id
        .rsplit_once(':')
        .map(|(_, service)| sanitize_picker_label(service, 255))
        .unwrap_or_else(|| "unknown".into());
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(format!(
            "Choose an emoji for {community_name} · community {picker_community_id} · account service {picker_account_service}"
        ))
        .add_filter("Custom emoji images", &["png", "jpg", "jpeg", "webp"])
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(selected) = receiver
        .await
        .map_err(|_| CommandError::Other("Native file picker closed unexpectedly".into()))?
    else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| CommandError::Validation("Only local image files can be selected".into()))?;
    drop(native_ui);
    let inspected = inspect_native_path_with_limit(path, MAX_CUSTOM_EMOJI_BYTES).await?;
    validate_custom_emoji(&inspected)?;
    let _account_guard = state
        .native_requests
        .begin_account_mutation(account_generation)
        .map_err(|_| {
            CommandError::Cancelled(
                "Your account changed while choosing the image; choose it again".into(),
            )
        })?;
    let current_user_id = attachment_account_id(&state).await?;
    if current_user_id != initial_user_id {
        return Err(CommandError::Cancelled(
            "Your account changed while choosing the image; choose it again".into(),
        ));
    }
    Ok(Some(
        store
            .issue(
                inspected,
                false,
                CUSTOM_EMOJI_GRANT_TTL,
                AttachmentGrantPurpose::CustomEmoji {
                    community_id,
                    account_generation,
                    user_id: initial_user_id,
                },
            )
            .await,
    ))
}

#[tauri::command]
pub async fn accept_attachment_drop_grants(
    grants: Vec<String>,
    store: State<'_, AttachmentGrantStore>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let account_generation = state.native_requests.account_generation();
    let _account_guard = state
        .native_requests
        .begin_account_mutation(account_generation)
        .map_err(|_| {
            CommandError::Cancelled(
                "Your account changed before Mesh could accept that file drop. Drop it again."
                    .into(),
            )
        })?;
    let user_id = attachment_account_id(&state).await?;
    store
        .accept_drop_grants(&grants, account_generation, &user_id)
        .await
}

#[tauri::command]
pub async fn open_downloaded_file(
    local_path: String,
    _app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let _account_guard = if state.backend.kind() == BackendKind::Matrix {
        let account_generation = state.native_requests.account_generation();
        Some(
            state
                .native_requests
                .begin_account_mutation(account_generation)
                .map_err(|_| {
                    CommandError::Cancelled(
                        "Your account changed before Mesh could open that file. Try again.".into(),
                    )
                })?,
        )
    } else {
        None
    };
    let path = tokio::fs::canonicalize(local_path).await.map_err(|_| {
        CommandError::NotFound("Downloaded attachment is no longer available".into())
    })?;
    let allowed = match state.backend.kind() {
        BackendKind::Matrix => {
            let active_cache_root = state
                .backend
                .backend()
                .active_account_media_cache_root()
                .await
                .map_err(|error| match error {
                    BackendError::NotAuthenticated => CommandError::NotAuthenticated,
                    _ => CommandError::NotFound("Local account cache is unavailable".into()),
                })?;
            let active_cache_root = tokio::fs::canonicalize(active_cache_root)
                .await
                .map_err(|_| CommandError::NotFound("Local account cache is unavailable".into()))?;
            is_file_directly_under(&path, &active_cache_root)
        }
        BackendKind::LegacyP2p => {
            #[cfg(feature = "legacy-p2p")]
            {
                let downloads = tokio::fs::canonicalize(super::files::downloads_root())
                    .await
                    .map_err(|_| {
                        CommandError::NotFound("Legacy download folder is unavailable".into())
                    })?;
                path.parent().is_some_and(|parent| parent == downloads)
            }
            #[cfg(not(feature = "legacy-p2p"))]
            {
                false
            }
        }
    };
    if !allowed {
        return Err(CommandError::PermissionDenied(
            "Mesh can open only files created by its attachment downloader".into(),
        ));
    }

    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| CommandError::Validation("Attachment filename is unavailable".into()))?;
    let mut file = tokio::fs::File::open(&path).await.map_err(|_| {
        CommandError::NotFound("Downloaded attachment is no longer available".into())
    })?;
    let mut prefix = vec![0_u8; HEADER_INSPECTION_BYTES];
    let prefix_len = file.read(&mut prefix).await.map_err(|_| {
        CommandError::NotFound("Downloaded attachment is no longer available".into())
    })?;
    prefix.truncate(prefix_len);
    let content_type = content_type_for_filename(filename);
    let classification = classify_attachment(filename, Some(&content_type), &prefix);
    if classification.disposition != AttachmentDisposition::Safe {
        return Err(CommandError::Validation(match classification.disposition {
            AttachmentDisposition::Active => {
                "This attachment contains active content. Save it only if you trust the sender; Mesh will not open it directly."
                    .into()
            }
            AttachmentDisposition::Ambiguous => {
                "Mesh cannot verify this attachment as passive content. Save it only if you trust the sender; Mesh will not open it directly."
                    .into()
            }
            AttachmentDisposition::Safe => unreachable!("safe attachments pass the opening guard"),
        }));
    }
    // Windows can refuse account-cache cleanup while this inspection handle
    // remains open. Release it before handing the validated path to the OS.
    drop(file);

    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|error| CommandError::Other(error.to_string()))
}

/// Revoke an unused native-picker or native-drop capability. This never deletes
/// the user's original file.
#[tauri::command]
pub async fn discard_attachment_grant(
    grant: String,
    store: State<'_, AttachmentGrantStore>,
) -> Result<(), CommandError> {
    store.revoke(&grant).await
}

/// Delete only a file derived from a validated opaque staging token. Renderer
/// supplied paths are never accepted.
#[tauri::command]
pub async fn discard_staged_attachment(
    token: String,
    app: AppHandle,
    store: State<'_, AttachmentGrantStore>,
) -> Result<(), CommandError> {
    let token = Uuid::parse_str(&token)
        .map_err(|_| CommandError::Validation("Invalid staged attachment token".into()))?;
    store.grants.lock().await.remove(&token.to_string());
    let path = staging_root(&app)?.join(token.to_string());
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CommandError::Other(error.to_string())),
    }
}

async fn purge_expired_staged_attachments(root: &Path) -> usize {
    let Ok(mut entries) = tokio::fs::read_dir(root).await else {
        return 0;
    };
    let mut removed = 0;
    let now = SystemTime::now();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if !path.is_dir()
            || entry
                .file_name()
                .to_str()
                .and_then(|name| Uuid::parse_str(name).ok())
                .is_none()
        {
            continue;
        }
        let expired = entry
            .metadata()
            .await
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= STAGED_ATTACHMENT_TTL);
        if expired && tokio::fs::remove_dir_all(path).await.is_ok() {
            removed += 1;
        }
    }
    removed
}

pub fn schedule_startup_cleanup(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let root = match staging_root(&app) {
            Ok(root) => root,
            Err(error) => {
                tracing::warn!("Could not resolve attachment staging cache for cleanup: {error}");
                return;
            }
        };
        let removed = purge_expired_staged_attachments(&root).await;
        if removed > 0 {
            tracing::info!("Removed {removed} expired staged attachment(s)");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_EMOJI_COMMUNITY: &str = "!community:example.org";
    const TEST_EMOJI_USER: &str = "@alice:example.org";
    const TEST_ACCOUNT_GENERATION: u64 = 7;

    fn test_message_purpose() -> AttachmentGrantPurpose {
        AttachmentGrantPurpose::message_attachment(TEST_ACCOUNT_GENERATION, TEST_EMOJI_USER)
    }

    fn test_custom_emoji_purpose() -> AttachmentGrantPurpose {
        AttachmentGrantPurpose::CustomEmoji {
            community_id: TEST_EMOJI_COMMUNITY.into(),
            account_generation: TEST_ACCOUNT_GENERATION,
            user_id: TEST_EMOJI_USER.into(),
        }
    }

    #[test]
    fn security_boundary_attachment_validation_accepts_regular_images() {
        assert!(validate_attachment_payload(
            "screen.png",
            12,
            b"\x89PNG\r\n\x1a\n",
            MAX_STAGED_ATTACHMENT_BYTES as u64,
        )
        .is_ok());
    }

    #[test]
    fn security_boundary_attachment_validation_rejects_extension_and_disguised_executables() {
        assert!(validate_attachment_payload("payload.ps1", 4, b"text", 10).is_err());
        assert!(validate_attachment_payload("holiday.gif", 6, b"MZfake", 10).is_err());
        assert!(validate_attachment_payload("notes.txt", 8, b"#!/bin/sh", 10).is_err());
    }

    #[test]
    fn security_boundary_attachment_validation_rejects_unsafe_windows_filenames() {
        for filename in [
            r"C:payload.png",
            "file.txt:stream",
            "CON",
            "con.txt",
            "PRN.png",
            "AUX",
            "NUL.txt",
            "COM1.gif",
            "LPT9.png",
            "trailing.",
            "trailing ",
            r"..\escape.png",
            "../escape.png",
            "has?.png",
        ] {
            assert!(
                validate_attachment_payload(filename, 4, b"safe", 10).is_err(),
                "{filename} must be rejected"
            );
        }
    }

    #[test]
    fn security_boundary_attachment_validation_is_bounded_and_non_empty() {
        assert!(validate_attachment_payload("empty.png", 0, b"", 10).is_err());
        assert!(validate_attachment_payload("large.png", 11, b"safe", 10).is_err());
    }

    #[tokio::test]
    async fn security_boundary_attachment_grants_are_one_use_and_explicitly_restorable_after_failure(
    ) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.txt");
        tokio::fs::write(&path, b"safe report").await.unwrap();
        let store = AttachmentGrantStore::default();
        let inspected = inspect_native_path(path).await.unwrap();
        let dto = store
            .issue(
                inspected,
                false,
                ATTACHMENT_GRANT_TTL,
                test_message_purpose(),
            )
            .await;

        let staging = directory.path().join("staging");
        let claimed = store
            .claim_to_staging(
                &dto.grant,
                &staging,
                TEST_ACCOUNT_GENERATION,
                TEST_EMOJI_USER,
            )
            .await
            .unwrap();
        assert!(store
            .claim_to_staging(
                &dto.grant,
                &staging,
                TEST_ACCOUNT_GENERATION,
                TEST_EMOJI_USER,
            )
            .await
            .is_err());
        store.restore(claimed).await;
        assert!(store
            .claim_to_staging(
                &dto.grant,
                &staging,
                TEST_ACCOUNT_GENERATION + 1,
                TEST_EMOJI_USER,
            )
            .await
            .is_err());
        let claimed = store
            .claim_to_staging(
                &dto.grant,
                &staging,
                TEST_ACCOUNT_GENERATION,
                TEST_EMOJI_USER,
            )
            .await
            .unwrap();
        assert!(store
            .claim_to_staging(
                &dto.grant,
                &staging,
                TEST_ACCOUNT_GENERATION,
                TEST_EMOJI_USER,
            )
            .await
            .is_err());
        claimed.cleanup().await;
    }

    #[tokio::test]
    async fn security_boundary_message_attachment_grants_reject_other_accounts_without_consuming_the_grant(
    ) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("account-private.txt");
        tokio::fs::write(&path, b"only Alice selected this")
            .await
            .unwrap();
        let store = AttachmentGrantStore::default();
        let dto = store
            .issue(
                inspect_native_path(path).await.unwrap(),
                false,
                ATTACHMENT_GRANT_TTL,
                test_message_purpose(),
            )
            .await;
        let staging = directory.path().join("staging");

        assert!(store
            .claim_to_staging(
                &dto.grant,
                &staging,
                TEST_ACCOUNT_GENERATION + 1,
                TEST_EMOJI_USER,
            )
            .await
            .is_err());
        assert!(store
            .claim_to_staging(
                &dto.grant,
                &staging,
                TEST_ACCOUNT_GENERATION,
                "@bob:example.org",
            )
            .await
            .is_err());
        assert!(store
            .accept_drop_grants(
                std::slice::from_ref(&dto.grant),
                TEST_ACCOUNT_GENERATION,
                "@bob:example.org",
            )
            .await
            .is_err());

        let claimed = store
            .claim_to_staging(
                &dto.grant,
                &staging,
                TEST_ACCOUNT_GENERATION,
                TEST_EMOJI_USER,
            )
            .await
            .expect("scope mismatches must not consume Alice's grant");
        claimed.cleanup().await;
    }

    #[tokio::test]
    async fn security_boundary_attachment_grant_rejects_a_file_changed_after_selection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.txt");
        tokio::fs::write(&path, b"safe report").await.unwrap();
        let store = AttachmentGrantStore::default();
        let inspected = inspect_native_path(path.clone()).await.unwrap();
        let size = inspected.size;
        let dto = store
            .issue(
                inspected,
                false,
                ATTACHMENT_GRANT_TTL,
                test_message_purpose(),
            )
            .await;
        tokio::fs::write(directory.path().join("report.txt"), b"evil report")
            .await
            .unwrap();

        assert_eq!(
            size, 11,
            "fixture replacement must preserve the selected size"
        );
        assert!(store
            .claim_to_staging(
                &dto.grant,
                &directory.path().join("staging"),
                TEST_ACCOUNT_GENERATION,
                TEST_EMOJI_USER,
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn security_boundary_custom_emoji_grants_are_purpose_scoped_and_one_use() {
        let directory = tempfile::tempdir().unwrap();
        let message_path = directory.path().join("message.png");
        let emoji_path = directory.path().join("emoji.png");
        tokio::fs::write(&message_path, b"\x89PNG\r\n\x1a\nmessage")
            .await
            .unwrap();
        tokio::fs::write(&emoji_path, b"\x89PNG\r\n\x1a\nemoji")
            .await
            .unwrap();
        let store = AttachmentGrantStore::default();

        let message = store
            .issue(
                inspect_native_path(message_path).await.unwrap(),
                false,
                ATTACHMENT_GRANT_TTL,
                test_message_purpose(),
            )
            .await;
        assert!(store
            .claim_custom_emoji(
                &message.grant,
                TEST_EMOJI_COMMUNITY,
                TEST_ACCOUNT_GENERATION,
                TEST_EMOJI_USER,
            )
            .await
            .is_err());
        let message_claim = store
            .claim_to_staging(
                &message.grant,
                &directory.path().join("message-staging"),
                TEST_ACCOUNT_GENERATION,
                TEST_EMOJI_USER,
            )
            .await
            .expect("a wrong-purpose attempt must not consume the message grant");
        message_claim.cleanup().await;

        let emoji = store
            .issue(
                inspect_native_path_with_limit(emoji_path, MAX_CUSTOM_EMOJI_BYTES)
                    .await
                    .unwrap(),
                false,
                CUSTOM_EMOJI_GRANT_TTL,
                test_custom_emoji_purpose(),
            )
            .await;
        assert!(store
            .claim_custom_emoji(
                &emoji.grant,
                "!other:example.org",
                TEST_ACCOUNT_GENERATION,
                TEST_EMOJI_USER,
            )
            .await
            .is_err());
        let (_, content_type, bytes) = store
            .claim_custom_emoji(
                &emoji.grant,
                TEST_EMOJI_COMMUNITY,
                TEST_ACCOUNT_GENERATION,
                TEST_EMOJI_USER,
            )
            .await
            .unwrap();
        assert_eq!(content_type, "image/png");
        assert_eq!(bytes, b"\x89PNG\r\n\x1a\nemoji");
        assert!(store
            .claim_custom_emoji(
                &emoji.grant,
                TEST_EMOJI_COMMUNITY,
                TEST_ACCOUNT_GENERATION,
                TEST_EMOJI_USER,
            )
            .await
            .is_err());

        let emoji = store
            .issue(
                inspect_native_path_with_limit(
                    directory.path().join("message.png"),
                    MAX_CUSTOM_EMOJI_BYTES,
                )
                .await
                .unwrap(),
                false,
                CUSTOM_EMOJI_GRANT_TTL,
                test_custom_emoji_purpose(),
            )
            .await;
        assert!(store
            .claim_to_staging(
                &emoji.grant,
                &directory.path().join("staging"),
                TEST_ACCOUNT_GENERATION,
                TEST_EMOJI_USER,
            )
            .await
            .is_err());
        let (_, _, bytes) = store
            .claim_custom_emoji(
                &emoji.grant,
                TEST_EMOJI_COMMUNITY,
                TEST_ACCOUNT_GENERATION,
                TEST_EMOJI_USER,
            )
            .await
            .expect("a wrong-purpose attempt must not consume the emoji grant");
        assert_eq!(bytes, b"\x89PNG\r\n\x1a\nmessage");
    }

    #[tokio::test]
    async fn security_boundary_custom_emoji_grant_rechecks_changes_and_the_size_limit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("emoji.png");
        tokio::fs::write(&path, b"\x89PNG\r\n\x1a\noriginal")
            .await
            .unwrap();
        let store = AttachmentGrantStore::default();
        let emoji = store
            .issue(
                inspect_native_path_with_limit(path.clone(), MAX_CUSTOM_EMOJI_BYTES)
                    .await
                    .unwrap(),
                false,
                CUSTOM_EMOJI_GRANT_TTL,
                test_custom_emoji_purpose(),
            )
            .await;
        tokio::fs::write(&path, b"\x89PNG\r\n\x1a\nmodified")
            .await
            .unwrap();
        assert!(store
            .claim_custom_emoji(
                &emoji.grant,
                TEST_EMOJI_COMMUNITY,
                TEST_ACCOUNT_GENERATION,
                TEST_EMOJI_USER,
            )
            .await
            .is_err());

        let oversized_path = directory.path().join("oversized.png");
        let mut oversized = vec![0_u8; MAX_CUSTOM_EMOJI_BYTES as usize + 1];
        oversized[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        tokio::fs::write(&oversized_path, oversized).await.unwrap();
        let error = inspect_native_path_with_limit(oversized_path, MAX_CUSTOM_EMOJI_BYTES)
            .await
            .expect_err("an oversized emoji must fail before a grant is issued");
        assert!(error.to_string().contains("512 KB"));
    }

    #[test]
    fn security_boundary_custom_emoji_final_read_is_bounded_before_allocation() {
        let source = include_str!("attachments.rs");
        let claim = source
            .split("pub async fn claim_custom_emoji")
            .nth(1)
            .unwrap()
            .split("pub async fn restore")
            .next()
            .unwrap();
        let bounded_reader = claim.find(".take(MAX_CUSTOM_EMOJI_BYTES + 1)").unwrap();
        let allocation = claim
            .find("Vec::with_capacity(grant.size as usize)")
            .unwrap();
        let final_read = claim.find("read_to_end(&mut bytes)").unwrap();
        assert!(bounded_reader < allocation);
        assert!(allocation < final_read);
        assert!(!claim.contains("tokio::fs::read"));
    }

    #[test]
    fn security_boundary_custom_emoji_picker_binds_trusted_destination_and_account() {
        let source = include_str!("attachments.rs");
        let picker = source
            .split("pub async fn pick_custom_emoji_grant")
            .nth(1)
            .unwrap()
            .split("pub async fn accept_attachment_drop_grants")
            .next()
            .unwrap();
        let initial_generation = picker.find("account_generation()").unwrap();
        let community_lookup = picker.find(".list_communities()").unwrap();
        let trusted_title = picker.find(".set_title(format!(").unwrap();
        let native_picker = picker.find(".pick_file(").unwrap();
        let post_picker_guard = picker
            .rfind(".begin_account_mutation(account_generation)")
            .unwrap();
        let account_comparison = picker.find("current_user_id != initial_user_id").unwrap();
        let grant_issue = picker.find("AttachmentGrantPurpose::CustomEmoji").unwrap();
        assert!(initial_generation < community_lookup);
        assert!(community_lookup < trusted_title);
        assert!(trusted_title < native_picker);
        assert!(native_picker < post_picker_guard);
        assert!(post_picker_guard < account_comparison);
        assert!(account_comparison < grant_issue);
        assert!(picker.contains("sanitize_picker_label(&community_id, 255)"));
        assert!(picker.contains("picker_account_service"));
        assert!(picker.contains("community {picker_community_id}"));
    }

    #[test]
    fn security_boundary_picker_identity_strips_bidi_and_invisible_formatting() {
        assert_eq!(
            sanitize_picker_label("Studio\u{202e}evil\u{200b} room", 80),
            "Studioevil room"
        );
        assert_eq!(sanitize_picker_label("\u{2066}\u{2069}", 80), "unknown");
    }

    #[test]
    fn security_boundary_attachment_intake_serializes_its_account_scope_for_renderer_checks() {
        let value = serde_json::to_value(NativeAttachmentIntake {
            files: Vec::new(),
            errors: Vec::new(),
            account_scope: NativeAttachmentAccountScope {
                account_generation: TEST_ACCOUNT_GENERATION,
                user_id: TEST_EMOJI_USER.into(),
            },
        })
        .unwrap();
        assert_eq!(
            value["accountScope"]["accountGeneration"],
            TEST_ACCOUNT_GENERATION
        );
        assert_eq!(value["accountScope"]["userId"], TEST_EMOJI_USER);
        assert!(value.get("account_scope").is_none());
    }

    #[test]
    fn native_open_reclassifies_and_denies_active_or_ambiguous_files_before_os_open() {
        let source = include_str!("attachments.rs");
        let opener = source
            .split("pub async fn open_downloaded_file")
            .nth(1)
            .unwrap()
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        let classification = opener.find("classify_attachment").unwrap();
        let denial = opener
            .find("classification.disposition != AttachmentDisposition::Safe")
            .unwrap();
        let inspection_close = opener.find("drop(file)").unwrap();
        let operating_system_open = opener.find("tauri_plugin_opener::open_path").unwrap();
        assert!(classification < denial);
        assert!(denial < inspection_close);
        assert!(inspection_close < operating_system_open);
        assert!(opener.contains("HEADER_INSPECTION_BYTES"));
        assert!(opener.contains("begin_account_mutation(account_generation)"));
    }
}
