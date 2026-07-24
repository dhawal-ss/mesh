use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use tauri::{AppHandle, State};

use crate::app_runtime;
use crate::backend::BackendKind;
use crate::crypto::identity::Identity;
use crate::state::AppState;
use crate::storage::Database;
use crate::types::identity::IdentityDto;

use super::error::CommandError;

async fn load_identity_public_key(
    state: &State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    if let Some(identity) = state.identity.read().await.as_ref() {
        return Ok(Some(identity.public_key_b64.clone()));
    }

    if !Identity::exists() {
        return Ok(None);
    }

    let identity = Identity::load().map_err(|e| CommandError::Other(e.to_string()))?;
    let public_key = identity.public_key_b64.clone();
    *state.identity.write().await = Some(identity);

    Ok(Some(public_key))
}

async fn ensure_identity_public_key(state: &State<'_, AppState>) -> Result<String, CommandError> {
    if let Some(public_key) = load_identity_public_key(state).await? {
        return Ok(public_key);
    }

    let identity = Identity::generate().map_err(|e| CommandError::Other(e.to_string()))?;
    let public_key = identity.public_key_b64.clone();
    *state.identity.write().await = Some(identity);

    Ok(public_key)
}

async fn read_profile_or_default(
    public_key: String,
    db: &State<'_, Database>,
) -> Result<IdentityDto, CommandError> {
    let public_key_c = public_key.clone();
    let profile = db
        .run_blocking(move |db| db.get_local_profile(&public_key_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    Ok(profile
        .map(|p| IdentityDto {
            public_key: p.public_key,
            display_name: p.display_name,
            avatar_color: p.avatar_color,
        })
        .unwrap_or(IdentityDto {
            public_key,
            display_name: String::new(),
            avatar_color: String::new(),
        }))
}

#[tauri::command]
pub async fn create_identity(
    state: State<'_, AppState>,
    db: State<'_, Database>,
    app_handle: AppHandle,
) -> Result<IdentityDto, CommandError> {
    let public_key = ensure_identity_public_key(&state).await?;

    if state.backend.kind() == BackendKind::LegacyP2p {
        if let Err(err) = app_runtime::ensure_network_started(
            app_handle,
            state.identity.clone(),
            state.network.clone(),
        )
        .await
        {
            tracing::error!("Failed to start legacy network: {}", err);
        }
    }

    read_profile_or_default(public_key, &db).await
}

#[tauri::command]
pub async fn generate_identity(
    display_name: String,
    avatar_color: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
    app_handle: AppHandle,
) -> Result<IdentityDto, CommandError> {
    let public_key = ensure_identity_public_key(&state).await?;

    if state.backend.kind() == BackendKind::LegacyP2p {
        if let Err(err) = app_runtime::ensure_network_started(
            app_handle,
            state.identity.clone(),
            state.network.clone(),
        )
        .await
        {
            tracing::error!("Failed to start legacy network: {}", err);
        }
    }

    let public_key_c = public_key.clone();
    let display_name_c = display_name.clone();
    let avatar_color_c = avatar_color.clone();
    db.run_blocking(move |db| {
        db.set_local_profile(&public_key_c, &display_name_c, &avatar_color_c)
    })
    .await
    .map_err(|e| CommandError::Other(e.to_string()))?;

    Ok(IdentityDto {
        public_key,
        display_name,
        avatar_color,
    })
}

#[tauri::command]
pub async fn get_identity(
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<Option<IdentityDto>, CommandError> {
    let public_key = match load_identity_public_key(&state).await? {
        Some(public_key) => public_key,
        None => return Ok(None),
    };

    Ok(Some(read_profile_or_default(public_key, &db).await?))
}

#[tauri::command]
pub async fn update_profile(
    display_name: String,
    avatar_color: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<IdentityDto, CommandError> {
    let public_key = load_identity_public_key(&state)
        .await?
        .ok_or(CommandError::Identity("No identity loaded".into()))?;

    let public_key_c = public_key.clone();
    let display_name_c = display_name.clone();
    let avatar_color_c = avatar_color.clone();
    db.run_blocking(move |db| {
        db.set_local_profile(&public_key_c, &display_name_c, &avatar_color_c)
    })
    .await
    .map_err(|e| CommandError::Other(e.to_string()))?;

    Ok(IdentityDto {
        public_key,
        display_name,
        avatar_color,
    })
}

#[tauri::command]
pub async fn update_display_name(
    name: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<(), CommandError> {
    let public_key = load_identity_public_key(&state)
        .await?
        .ok_or(CommandError::Identity("No identity loaded".into()))?;

    let public_key_c = public_key.clone();
    let profile = db
        .run_blocking(move |db| db.get_local_profile(&public_key_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    let avatar_color = profile
        .map(|p| p.avatar_color)
        .unwrap_or_else(|| "#c8b89a".into());

    let public_key_c = public_key.clone();
    let name_c = name.clone();
    let avatar_color_c = avatar_color.clone();
    db.run_blocking(move |db| db.set_local_profile(&public_key_c, &name_c, &avatar_color_c))
        .await
        .map_err(|e| CommandError::Other(e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub async fn export_identity(
    passphrase: String,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    let identity = state.identity.read().await;
    let identity = identity
        .as_ref()
        .ok_or(CommandError::Identity("No identity loaded".into()))?;
    let bundle = identity
        .export_bundle(&passphrase)
        .map_err(|e| CommandError::Other(e.to_string()))?;
    Ok(BASE64.encode(&bundle))
}

#[tauri::command]
pub async fn import_identity(
    bundle_b64: String,
    passphrase: String,
    state: State<'_, AppState>,
    db: State<'_, Database>,
    app_handle: AppHandle,
) -> Result<IdentityDto, CommandError> {
    let bundle = BASE64
        .decode(&bundle_b64)
        .map_err(|e| CommandError::Other(e.to_string()))?;
    let identity = Identity::import_bundle(&bundle, &passphrase)
        .map_err(|e| CommandError::Other(e.to_string()))?;
    let public_key = identity.public_key_b64.clone();
    *state.identity.write().await = Some(identity);

    // Restart network with new identity
    *state.network.write().await = None;

    if state.backend.kind() == BackendKind::LegacyP2p {
        if let Err(err) = app_runtime::ensure_network_started(
            app_handle,
            state.identity.clone(),
            state.network.clone(),
        )
        .await
        {
            tracing::error!("Failed to restart legacy network after import: {}", err);
        }
    }

    read_profile_or_default(public_key, &db).await
}
