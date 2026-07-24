use libp2p::PeerId;
use tauri::{AppHandle, Manager, State};

use crate::backend::BackendKind;
use crate::crypto::identity::Identity;
use crate::migration::{
    self, LegacyArchiveSource, LegacyArchiveSummary, LegacyDryRunReport, LegacyExportRequest,
    LegacyImportRequest, LegacyImportResult,
};
use crate::state::AppState;
use crate::storage::Database;

use super::error::CommandError;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyExportResult {
    pub archive_path: String,
    pub summary: LegacyArchiveSummary,
}

#[tauri::command]
pub async fn export_legacy_archive(
    request: LegacyExportRequest,
    app_handle: AppHandle,
    db: State<'_, Database>,
) -> Result<LegacyExportResult, CommandError> {
    let identity = Identity::load().map_err(|error| {
        CommandError::Identity(format!(
            "a legacy identity is required to bind this archive to its source peer: {error}"
        ))
    })?;
    let peer_id = peer_id(&identity)?;
    let public_key = identity.public_key_b64.clone();
    let profile_key = public_key.clone();
    let display_name = db
        .run_blocking(move |db| db.get_local_profile(&profile_key))
        .await?
        .map(|profile| profile.display_name)
        .unwrap_or_else(|| "Legacy peer".into());
    let source = LegacyArchiveSource {
        peer_id,
        public_key,
        display_name,
    };

    let db_conn = db.conn.clone();
    let archive = tokio::task::spawn_blocking(move || {
        let db = Database { conn: db_conn };
        migration::export_legacy_archive(&db, source, &request)
    })
    .await
    .map_err(|error| CommandError::Other(format!("legacy export task failed: {error}")))??;

    let archive_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| CommandError::Other(error.to_string()))?
        .join("legacy-archives");
    let path = archive_dir.join(format!("{}.mesharchive.json", archive.archive_id));
    let archive_for_write = archive.clone();
    let path_for_write = path.clone();
    tokio::task::spawn_blocking(move || {
        migration::write_archive_atomic(&archive_for_write, &path_for_write)
    })
    .await
    .map_err(|error| CommandError::Other(format!("legacy archive write failed: {error}")))??;

    let summary = migration::inspect_archives(&[path.to_string_lossy().into_owned()])?
        .into_iter()
        .next()
        .ok_or_else(|| CommandError::Other("exported archive could not be summarized".into()))?;
    Ok(LegacyExportResult {
        archive_path: path.to_string_lossy().into_owned(),
        summary,
    })
}

#[tauri::command]
pub async fn inspect_legacy_archives(
    archive_paths: Vec<String>,
) -> Result<Vec<LegacyArchiveSummary>, CommandError> {
    tokio::task::spawn_blocking(move || migration::inspect_archives(&archive_paths))
        .await
        .map_err(|error| CommandError::Other(format!("legacy archive inspection failed: {error}")))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn dry_run_legacy_import(
    request: LegacyImportRequest,
) -> Result<LegacyDryRunReport, CommandError> {
    Ok(
        tokio::task::spawn_blocking(move || migration::dry_run(&request))
            .await
            .map_err(|error| CommandError::Other(format!("legacy dry run failed: {error}")))?,
    )
}

#[tauri::command]
pub async fn approve_legacy_import(
    request: LegacyImportRequest,
    approval_token: String,
    approval_phrase: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<LegacyImportResult, CommandError> {
    if state.backend.kind() != BackendKind::Matrix {
        return Err(CommandError::Validation(
            "legacy archives can only be imported while the Matrix backend is selected".into(),
        ));
    }
    let (plan_sha256, events) = tokio::task::spawn_blocking(move || {
        migration::approved_import_events(&request, &approval_token, &approval_phrase)
    })
    .await
    .map_err(|error| CommandError::Other(format!("legacy import approval failed: {error}")))??;

    let mut imported_events = 0usize;
    let mut previously_imported_events = 0usize;
    let mut matrix_event_ids = Vec::new();
    for event in events {
        let receipt_plan = plan_sha256.clone();
        let receipt_key = event.import_key.clone();
        if let Some(event_id) = db
            .run_blocking(move |db| migration::import_receipt(db, &receipt_plan, &receipt_key))
            .await?
        {
            previously_imported_events += 1;
            matrix_event_ids.push(event_id);
            continue;
        }

        let matrix_event_id = state
            .backend
            .backend()
            .import_legacy_event(event.target_room_id.clone(), event.content.clone())
            .await
            .map_err(|error| CommandError::Network(error.to_string()))?;
        let receipt_plan = plan_sha256.clone();
        let receipt_event = event.clone();
        let receipt_event_id = matrix_event_id.clone();
        db.run_blocking(move |db| {
            migration::store_import_receipt(db, &receipt_plan, &receipt_event, &receipt_event_id)
        })
        .await?;
        imported_events += 1;
        matrix_event_ids.push(matrix_event_id);
    }

    Ok(LegacyImportResult {
        plan_sha256,
        imported_events,
        previously_imported_events,
        matrix_event_ids,
    })
}

fn peer_id(identity: &Identity) -> Result<String, CommandError> {
    let secret = libp2p::identity::ed25519::SecretKey::try_from_bytes(identity.private_key_bytes())
        .map_err(|error| CommandError::Crypto(error.to_string()))?;
    let keypair = libp2p::identity::Keypair::from(libp2p::identity::ed25519::Keypair::from(secret));
    Ok(PeerId::from_public_key(&keypair.public()).to_string())
}
