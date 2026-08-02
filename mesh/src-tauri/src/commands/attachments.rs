use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::error::CommandError;
use crate::backend::{BackendError, BackendKind};
use crate::security::{
    classify_attachment, is_file_in_named_directory_under, AttachmentDisposition,
};
use crate::state::AppState;

/// Retained only for the validation regression test proving the removed
/// renderer byte-staging boundary stayed bounded.
#[cfg(test)]
const MAX_STAGED_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;
const STAGED_ATTACHMENT_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const ATTACHMENT_GRANT_TTL: Duration = Duration::from_secs(60 * 60);
const UNCLAIMED_DROP_GRANT_TTL: Duration = Duration::from_secs(30);
const HEADER_INSPECTION_BYTES: usize = 4 * 1024;
const MAX_PENDING_ATTACHMENTS: usize = 10;

#[derive(Clone, Debug)]
struct AttachmentGrant {
    token: String,
    path: PathBuf,
    filename: String,
    size: u64,
    content_type: String,
    expires_at: Instant,
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
}

#[derive(Clone, Debug, Serialize)]
pub struct NativeAttachmentIntake {
    pub files: Vec<AttachmentGrantDto>,
    pub errors: Vec<String>,
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
}

fn staging_root(app: &AppHandle) -> Result<PathBuf, CommandError> {
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
        let limit = max_bytes / 1024 / 1024;
        return Err(CommandError::Validation(format!(
            "Attachment exceeds the {limit} MB limit"
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

async fn inspect_native_path(
    path: PathBuf,
) -> Result<(PathBuf, String, u64, String), CommandError> {
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
    validate_attachment_payload(
        &filename,
        metadata.len(),
        &header[..header_len],
        MAX_ATTACHMENT_BYTES,
    )?;
    let content_type = content_type_for_filename(&filename);
    Ok((canonical, filename, metadata.len(), content_type))
}

impl AttachmentGrantStore {
    fn schedule_expiration(&self, token: String, ttl: Duration) {
        let store = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(ttl).await;
            let mut grants = store.grants.lock().await;
            if grants
                .get(&token)
                .is_some_and(|grant| grant.expires_at <= Instant::now())
            {
                grants.remove(&token);
            }
        });
    }

    async fn issue(
        &self,
        path: PathBuf,
        filename: String,
        size: u64,
        content_type: String,
        expose_legacy_path: bool,
        ttl: Duration,
    ) -> AttachmentGrantDto {
        let token = Uuid::new_v4().to_string();
        let grant = AttachmentGrant {
            token: token.clone(),
            path: path.clone(),
            filename: filename.clone(),
            size,
            content_type: content_type.clone(),
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

    pub async fn claim(&self, token: &str) -> Result<ClaimedAttachment, CommandError> {
        Uuid::parse_str(token)
            .map_err(|_| CommandError::Validation("Invalid attachment grant".into()))?;
        let grant = self.grants.lock().await.remove(token).ok_or_else(|| {
            CommandError::Validation(
                "Attachment access expired or was already used; choose the file again".into(),
            )
        })?;
        if grant.expires_at <= Instant::now() {
            return Err(CommandError::Validation(
                "Attachment access expired; choose the file again".into(),
            ));
        }
        let (canonical, filename, size, content_type) =
            inspect_native_path(grant.path.clone()).await?;
        if canonical != grant.path
            || filename != grant.filename
            || size != grant.size
            || content_type != grant.content_type
        {
            return Err(CommandError::Validation(
                "The selected attachment changed; choose it again".into(),
            ));
        }
        Ok(ClaimedAttachment { grant })
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
        self.grants.lock().await.remove(token);
        Ok(())
    }

    pub async fn accept_drop_grants(&self, tokens: &[String]) -> Result<(), CommandError> {
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
}

async fn grant_native_paths(
    store: &AttachmentGrantStore,
    paths: Vec<PathBuf>,
    expose_legacy_path: bool,
    ttl: Duration,
) -> (Vec<AttachmentGrantDto>, Vec<String>) {
    let mut files = Vec::new();
    let mut errors = Vec::new();
    let selected_count = paths.len();
    for path in paths.into_iter().take(MAX_PENDING_ATTACHMENTS) {
        match inspect_native_path(path).await {
            Ok((path, filename, size, content_type)) => {
                files.push(
                    store
                        .issue(path, filename, size, content_type, expose_legacy_path, ttl)
                        .await,
                );
            }
            Err(error) => errors.push(error.to_string()),
        }
    }
    if selected_count > MAX_PENDING_ATTACHMENTS {
        errors.push(format!(
            "Mesh allows up to {MAX_PENDING_ATTACHMENTS} pending attachments at once."
        ));
    }
    (files, errors)
}

pub async fn grant_native_drop(
    store: &AttachmentGrantStore,
    drop_id: String,
    paths: Vec<PathBuf>,
    x: f64,
    y: f64,
    expose_legacy_path: bool,
) -> NativeAttachmentDrop {
    let (files, errors) =
        grant_native_paths(store, paths, expose_legacy_path, UNCLAIMED_DROP_GRANT_TTL).await;
    NativeAttachmentDrop {
        drop_id,
        position: NativeDropPosition { x, y },
        files,
        errors,
    }
}

/// Open a trusted native picker and mint opaque, time-limited capabilities for
/// the exact files chosen by the user.
#[tauri::command]
pub async fn pick_attachment_grants(
    app: AppHandle,
    store: State<'_, AttachmentGrantStore>,
    state: State<'_, AppState>,
) -> Result<NativeAttachmentIntake, CommandError> {
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
    let expose_legacy_path = state.backend.kind() == BackendKind::LegacyP2p;
    let (files, errors) =
        grant_native_paths(&store, paths, expose_legacy_path, ATTACHMENT_GRANT_TTL).await;
    Ok(NativeAttachmentIntake { files, errors })
}

#[tauri::command]
pub async fn accept_attachment_drop_grants(
    grants: Vec<String>,
    store: State<'_, AttachmentGrantStore>,
) -> Result<(), CommandError> {
    store.accept_drop_grants(&grants).await
}

#[tauri::command]
pub async fn open_downloaded_file(
    local_path: String,
    _app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let path = tokio::fs::canonicalize(local_path).await.map_err(|_| {
        CommandError::NotFound("Downloaded attachment is no longer available".into())
    })?;
    let allowed = match state.backend.kind() {
        BackendKind::Matrix => {
            let active_account_root = state
                .backend
                .backend()
                .active_account_storage_root()
                .await
                .map_err(|error| match error {
                    BackendError::NotAuthenticated => CommandError::NotAuthenticated,
                    _ => CommandError::NotFound("Local account cache is unavailable".into()),
                })?;
            let active_account_root = tokio::fs::canonicalize(active_account_root)
                .await
                .map_err(|_| CommandError::NotFound("Local account cache is unavailable".into()))?;
            is_file_in_named_directory_under(&path, &active_account_root, "media-cache")
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
        let (path, filename, size, content_type) = inspect_native_path(path).await.unwrap();
        let dto = store
            .issue(
                path,
                filename,
                size,
                content_type,
                false,
                ATTACHMENT_GRANT_TTL,
            )
            .await;

        let claimed = store.claim(&dto.grant).await.unwrap();
        assert!(store.claim(&dto.grant).await.is_err());
        store.restore(claimed).await;
        assert!(store.claim(&dto.grant).await.is_ok());
        assert!(store.claim(&dto.grant).await.is_err());
    }

    #[tokio::test]
    async fn security_boundary_attachment_grant_rejects_a_file_changed_after_selection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.txt");
        tokio::fs::write(&path, b"safe report").await.unwrap();
        let store = AttachmentGrantStore::default();
        let (path, filename, size, content_type) = inspect_native_path(path.clone()).await.unwrap();
        let dto = store
            .issue(
                path,
                filename,
                size,
                content_type,
                false,
                ATTACHMENT_GRANT_TTL,
            )
            .await;
        tokio::fs::write(directory.path().join("report.txt"), b"changed report")
            .await
            .unwrap();

        assert!(store.claim(&dto.grant).await.is_err());
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
        let operating_system_open = opener.find("tauri_plugin_opener::open_path").unwrap();
        assert!(classification < denial);
        assert!(denial < operating_system_open);
        assert!(opener.contains("HEADER_INSPECTION_BYTES"));
    }
}
