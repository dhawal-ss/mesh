mod app_runtime;
mod commands;
pub mod crypto;
pub mod network;
mod state;
mod storage;
mod types;

use state::AppState;
use storage::Database;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize structured logging
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("mesh=info,libp2p=warn")),
        )
        .init();

    tracing::info!("Starting Mesh...");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Initialize SQLite database
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let db = Database::new(app_data_dir).expect("failed to initialize database");

            // Register database as managed state
            app.manage(db);

            // Initialize application state
            let app_state = AppState::new();
            app.manage(app_state);

            app_runtime::spawn_voice_sweeper(app.handle().clone());

            // Start the P2P network in a background task
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = app_handle.state::<AppState>();
                let identity_state = state.identity.clone();
                let network_state = state.network.clone();

                // Try to load existing identity for the network keypair
                let identity_loaded = crate::crypto::identity::Identity::exists();
                if identity_loaded {
                    if let Ok(identity) = crate::crypto::identity::Identity::load() {
                        *identity_state.write().await = Some(identity);

                        if let Err(e) = app_runtime::ensure_network_started(
                            app_handle.clone(),
                            identity_state,
                            network_state,
                        )
                        .await
                        {
                            tracing::error!("Failed to start network: {}", e);
                        } else {
                            tracing::info!("Network started successfully");
                        }
                    }
                } else {
                    tracing::info!("No identity found, waiting for onboarding...");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Identity
            commands::identity::create_identity,
            commands::identity::generate_identity,
            commands::identity::get_identity,
            commands::identity::update_profile,
            commands::identity::update_display_name,
            commands::identity::export_identity,
            commands::identity::import_identity,
            // Communities
            commands::community::create_community,
            commands::community::get_communities,
            commands::community::get_channels,
            commands::community::sync_local_channel,
            commands::community::create_channel,
            commands::community::update_community_metadata,
            commands::community::join_community,
            commands::community::leave_community,
            commands::community::delete_community,
            commands::community::generate_invite_link,
            commands::community::subscribe_channel,
            commands::community::unsubscribe_channel,
            commands::control::request_control_log_sync,
            // Messaging
            commands::messaging::send_message,
            commands::messaging::get_messages,
            commands::messaging::mark_channel_read,
            commands::messaging::request_message_history,
            commands::messaging::add_reaction,
            commands::messaging::edit_message,
            commands::messaging::delete_message,
            commands::messaging::search_messages,
            // Voice
            commands::voice::join_voice,
            commands::voice::leave_voice,
            commands::voice::set_muted,
            commands::voice::set_deafened,
            commands::voice::send_voice_signal,
            // Files
            commands::files::upload_file,
            commands::files::request_file,
            // Moderation
            commands::moderation::ban_user,
            commands::moderation::update_member_role,
            commands::moderation::get_members,
            // Direct Messages
            commands::dm::send_dm,
            commands::dm::get_dm_conversations,
            commands::dm::get_dm_messages,
            commands::dm::mark_dm_read,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
