#![recursion_limit = "512"]

#[cfg(all(feature = "matrix-backend", feature = "legacy-p2p"))]
compile_error!(
    "matrix-backend and legacy-p2p are mutually exclusive; build separate Mesh artifacts"
);

#[cfg(feature = "legacy-p2p")]
mod app_runtime;
pub mod backend;
mod commands;
pub mod crypto;
#[cfg(feature = "legacy-p2p")]
pub mod migration;
#[cfg(feature = "legacy-p2p")]
pub mod network;
mod security;
mod state;
#[cfg(feature = "legacy-p2p")]
mod storage;
pub mod types;

// Re-export the TURN/STUN probe helpers so integration tests and operator
// tooling can validate real TURN infrastructure without going through the
// full Tauri command/state layer. See tests/turn_probe_live_tests.rs.
#[cfg(feature = "legacy-p2p")]
pub mod probe_api {
    pub use crate::commands::voice::{
        probe_single_ice_server, IceServerConfig, IceServerProbeResult,
    };
}

use backend::BackendKind;
use state::AppState;
use tauri::{Emitter, Manager};
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize structured logging
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("mesh=info")),
        )
        .init();

    tracing::info!("Starting Mesh...");

    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // Single-instance must be registered before deep-link so an invitation
        // opened while Mesh is running is delivered to this process.
        builder = builder.plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _working_directory| {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.unminimize() {
                        tracing::warn!("Could not restore Mesh for an invitation: {error}");
                    }
                    if let Err(error) = window.show() {
                        tracing::warn!("Could not show Mesh for an invitation: {error}");
                    }
                    if let Err(error) = window.set_focus() {
                        tracing::warn!("Could not focus Mesh for an invitation: {error}");
                    }
                }
            },
        ));
    }
    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_webview_event(|webview, event| {
            let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) =
                event
            else {
                return;
            };
            let app = webview.app_handle().clone();
            let drop_id = uuid::Uuid::new_v4().to_string();
            let start = commands::attachments::NativeAttachmentDropStart {
                drop_id: drop_id.clone(),
                position: commands::attachments::NativeDropPosition {
                    x: position.x,
                    y: position.y,
                },
            };
            if let Err(error) = app.emit("mesh-native-attachment-drop-start", start) {
                tracing::warn!("Could not deliver native attachment drop start: {error}");
                return;
            }
            let store = app
                .state::<commands::attachments::AttachmentGrantStore>()
                .inner()
                .clone();
            let expose_legacy_path =
                app.state::<AppState>().backend.kind() == BackendKind::LegacyP2p;
            let paths = paths.clone();
            let (x, y) = (position.x, position.y);
            tauri::async_runtime::spawn(async move {
                let payload = commands::attachments::grant_native_drop(
                    &store,
                    drop_id,
                    paths,
                    x,
                    y,
                    expose_legacy_path,
                )
                .await;
                if let Err(error) = app.emit("mesh-native-attachment-drop", payload) {
                    tracing::warn!("Could not deliver native attachment drop: {error}");
                }
            });
        });
    let builder = builder.plugin(tauri_plugin_notification::init());
    let builder = builder.setup(|app| {
        #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
        {
            use tauri_plugin_deep_link::DeepLinkExt;
            app.deep_link().register_all()?;
        }

        // Initialize SQLite database
        let app_data_dir = app
            .path()
            .app_data_dir()
            .expect("failed to resolve app data dir");
        app.manage(commands::attachments::AttachmentGrantStore::default());
        commands::attachments::schedule_startup_cleanup(app.handle().clone());
        #[cfg(feature = "legacy-p2p")]
        let db = storage::Database::new(app_data_dir.clone())
            .expect("failed to initialize legacy database");

        // Purge any stale entries from the pending_messages queue.
        // Previous versions queued messages on gossipsub InsufficientPeers,
        // which is the normal solo-peer state — not a real failure.
        // Those messages are already in the main messages table, so the
        // pending entry is dead state. Clear it on startup so the
        // diagnostics panel doesn't show phantom "N messages pending".
        #[cfg(feature = "legacy-p2p")]
        match db.clear_pending_messages() {
            Ok(cleared) if cleared > 0 => {
                tracing::info!(
                    target: "mesh::startup",
                    "Cleared {} stale pending message(s) from previous InsufficientPeers queueing",
                    cleared
                );
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(
                    target: "mesh::startup",
                    "Failed to clear stale pending messages: {}",
                    e
                );
            }
        }

        // Register database as managed state
        #[cfg(feature = "legacy-p2p")]
        app.manage(db);

        // Initialize application state
        app.manage(commands::notifications::NotificationRuntimeState::default());
        commands::notifications::configure_tray(app);

        let app_state = AppState::with_data_dir(app_data_dir);
        #[cfg(feature = "legacy-p2p")]
        let backend_kind = app_state.backend.kind();
        let notification_app = app.handle().clone();
        app_state
            .backend
            .backend()
            .set_matrix_event_callback(Some(std::sync::Arc::new(move |event| {
                commands::notifications::handle_matrix_backend_event(&notification_app, event);
            })));
        app.manage(app_state);

        #[cfg(feature = "legacy-p2p")]
        if backend_kind == BackendKind::LegacyP2p {
            app_runtime::spawn_voice_sweeper(app.handle().clone());
            app_runtime::spawn_download_timeout_checker(app.handle().clone());
            app_runtime::spawn_network_health_monitor(app.handle().clone());
            app_runtime::spawn_reconnect_watchdog(app.handle().clone());
        }

        // Log ICE server validation status at startup for operator visibility.
        // This makes missing/invalid TURN configuration obvious immediately
        // rather than only when a user tries to make a voice call.
        #[cfg(feature = "legacy-p2p")]
        {
            let db_ref = app.state::<storage::Database>();
            let custom = db_ref.conn.lock().ok().and_then(|conn| {
                conn.query_row(
                    "SELECT value FROM kv_store WHERE key = 'ice_servers'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .ok()
            });
            let has_custom = custom
                .as_deref()
                .and_then(|json| serde_json::from_str::<Vec<serde_json::Value>>(json).ok())
                .map(|v| !v.is_empty())
                .unwrap_or(false);
            if has_custom {
                tracing::info!(
                    target: "mesh::startup",
                    "ICE server configuration: custom servers loaded from settings"
                );
            } else {
                tracing::warn!(
                    target: "mesh::startup",
                    "ICE server configuration: using STUN-only defaults. \
                     No TURN server configured — voice will fail behind symmetric NATs. \
                     Configure a TURN server in Settings > Voice & Audio."
                );
            }
        }

        // Start the selected durable communication backend. Matrix is the
        // production default; libp2p starts only when explicitly selected.
        let app_handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            let state = app_handle.state::<AppState>();
            if let Err(error) = state.backend.backend().start().await {
                tracing::error!(
                    target: "mesh::startup",
                    backend = state.backend.kind().as_str(),
                    "Failed to start backend: {error}"
                );
            }

            if state.backend.kind() != BackendKind::LegacyP2p {
                tracing::info!(
                    target: "mesh::startup",
                    "Matrix backend selected; legacy libp2p engine is dormant"
                );
            }

            #[cfg(feature = "legacy-p2p")]
            if state.backend.kind() == BackendKind::LegacyP2p {
                let identity_state = state.identity.clone();
                let network_state = state.network.clone();

                // Try to load existing identity for the network keypair
                match crate::crypto::identity::Identity::exists() {
                    Ok(true) => {
                        match crate::crypto::identity::Identity::load() {
                            Ok(identity) => {
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
                            Err(error) => {
                                tracing::error!(
                                    "Could not load the local identity from the OS credential store: {error}"
                                );
                            }
                        }
                    }
                    Ok(false) => {
                        tracing::info!("No identity found, waiting for onboarding...");
                    }
                    Err(error) => {
                        tracing::error!(
                            "Could not inspect the OS credential store for the local identity: {error}"
                        );
                    }
                }
            }
        });

        Ok(())
    });

    // The tray reflects unread state. Closing still exits normally; close-to-tray
    // behavior remains disabled until a recovery menu and lifecycle are tested.
    #[cfg(not(feature = "legacy-p2p"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::attachments::pick_attachment_grants,
        commands::attachments::accept_attachment_drop_grants,
        commands::attachments::stage_attachment_bytes,
        commands::attachments::discard_attachment_grant,
        commands::attachments::discard_staged_attachment,
        commands::attachments::open_downloaded_file,
        commands::backend::get_backend_status,
        commands::notifications::set_notification_context,
        commands::notifications::send_test_notification,
        commands::pending_invitation::store_pending_invitation,
        commands::pending_invitation::read_pending_invitation,
        commands::pending_invitation::take_pending_invitation,
        commands::pending_invitation::peek_pending_invitation,
        commands::pending_invitation::resolve_pending_invitation,
        commands::pending_invitation::clear_pending_invitation,
        commands::backend::matrix_room_is_encrypted,
        commands::backend::matrix_room_upgrade,
        commands::backend::matrix_get_room_notification_mode,
        commands::backend::matrix_set_room_notification_mode,
        commands::backend::matrix_login,
        commands::backend::register_account,
        commands::backend::check_username_available,
        commands::backend::matrix_service_capabilities,
        commands::backend::matrix_oidc_status,
        commands::backend::matrix_start_oidc_login,
        commands::backend::matrix_cancel_login,
        commands::backend::matrix_restore_session,
        commands::backend::matrix_logout,
        commands::backend::matrix_devices,
        commands::backend::matrix_revoke_device,
        commands::backend::matrix_remove_local_account,
        commands::backend::matrix_export_personal_data,
        commands::backend::matrix_deactivate_account,
        commands::backend::matrix_accounts,
        commands::backend::matrix_get_profile,
        commands::backend::matrix_update_profile_display_name,
        commands::backend::matrix_switch_account,
        commands::backend::matrix_recovery_health,
        commands::backend::matrix_test_recovery,
        commands::backend::matrix_test_stored_recovery,
        commands::backend::matrix_start_device_verification,
        commands::backend::matrix_device_verification_status,
        commands::backend::matrix_select_device_verification_method,
        commands::backend::matrix_confirm_device_verification,
        commands::backend::matrix_cancel_device_verification,
        commands::backend::matrix_user_preferences,
        commands::backend::matrix_update_user_preferences,
        commands::backend::matrix_create_community,
        commands::backend::matrix_list_communities,
        commands::backend::matrix_list_channels,
        commands::backend::matrix_create_channel,
        commands::backend::matrix_list_custom_emoji,
        commands::backend::matrix_upload_custom_emoji,
        commands::backend::matrix_remove_custom_emoji,
        commands::backend::matrix_load_custom_emoji_image,
        commands::backend::matrix_rtc_join,
        commands::backend::matrix_rtc_ack_media_key_pause,
        commands::backend::matrix_rtc_ack_media_key,
        commands::backend::matrix_rtc_renew_media_key_lease,
        commands::backend::matrix_rtc_refresh_membership,
        commands::backend::matrix_rtc_leave,
        commands::backend::matrix_rtc_members,
        commands::backend::matrix_send_message,
        commands::backend::matrix_queued_messages,
        commands::backend::matrix_retry_queued_message,
        commands::backend::matrix_cancel_queued_message,
        commands::backend::matrix_save_composer_draft,
        commands::backend::matrix_load_composer_draft,
        commands::backend::matrix_clear_composer_draft,
        commands::backend::matrix_send_attachment,
        commands::backend::matrix_cancel_attachment_upload,
        commands::backend::matrix_download_attachment,
        commands::backend::matrix_load_attachment_thumbnail,
        commands::backend::matrix_load_attachment_image,
        commands::backend::matrix_cancel_attachment_download,
        commands::backend::matrix_dm_conversations,
        commands::backend::matrix_ensure_dm,
        commands::backend::matrix_dm_messages,
        commands::backend::matrix_send_dm,
        commands::backend::matrix_send_dm_attachment,
        commands::backend::matrix_mark_dm_read,
        commands::backend::matrix_set_dm_blocked,
        commands::backend::matrix_dm_blocked,
        commands::backend::matrix_get_messages,
        commands::backend::matrix_edit_message,
        commands::backend::matrix_redact_message,
        commands::backend::matrix_report_message,
        commands::backend::matrix_toggle_reaction,
        commands::backend::matrix_room_pins,
        commands::backend::matrix_toggle_room_pin,
        commands::backend::matrix_mark_read,
        commands::backend::matrix_set_typing,
        commands::backend::matrix_typing_users,
        commands::backend::matrix_search_messages,
        commands::backend::matrix_wait_for_room_update,
        commands::backend::matrix_list_members,
        commands::backend::matrix_get_community_permission_projection,
        commands::backend::matrix_invite_to_community,
        commands::backend::matrix_create_community_invite,
        commands::backend::matrix_resolve_community_invite,
        commands::backend::matrix_claim_community_invite,
        commands::backend::matrix_community_access_settings,
        commands::backend::matrix_update_community_access,
        commands::backend::matrix_search_community_directory,
        commands::backend::matrix_knock_community,
        commands::backend::matrix_list_community_applications,
        commands::backend::matrix_respond_community_application,
        commands::backend::matrix_join_community,
        commands::backend::matrix_join_room,
        commands::backend::matrix_leave_community,
        commands::backend::matrix_update_community,
        commands::backend::matrix_update_member_role,
        commands::backend::matrix_kick_member,
        commands::backend::matrix_ban_member,
        commands::backend::matrix_list_moderation_audit,
        commands::backend::matrix_sync_once,
        commands::backend::matrix_enable_recovery,
        commands::backend::matrix_recover,
    ]);

    #[cfg(feature = "legacy-p2p")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::attachments::pick_attachment_grants,
        commands::attachments::accept_attachment_drop_grants,
        commands::attachments::stage_attachment_bytes,
        commands::attachments::discard_attachment_grant,
        commands::attachments::discard_staged_attachment,
        commands::attachments::open_downloaded_file,
        // Backend / Matrix architecture spike
        commands::backend::get_backend_status,
        commands::notifications::set_notification_context,
        commands::notifications::send_test_notification,
        commands::pending_invitation::store_pending_invitation,
        commands::pending_invitation::read_pending_invitation,
        commands::pending_invitation::take_pending_invitation,
        commands::pending_invitation::peek_pending_invitation,
        commands::pending_invitation::resolve_pending_invitation,
        commands::pending_invitation::clear_pending_invitation,
        commands::backend::matrix_room_is_encrypted,
        commands::backend::matrix_room_upgrade,
        commands::backend::matrix_get_room_notification_mode,
        commands::backend::matrix_set_room_notification_mode,
        commands::backend::matrix_login,
        commands::backend::register_account,
        commands::backend::check_username_available,
        commands::backend::matrix_service_capabilities,
        commands::backend::matrix_oidc_status,
        commands::backend::matrix_start_oidc_login,
        commands::backend::matrix_cancel_login,
        commands::backend::matrix_restore_session,
        commands::backend::matrix_logout,
        commands::backend::matrix_devices,
        commands::backend::matrix_revoke_device,
        commands::backend::matrix_remove_local_account,
        commands::backend::matrix_export_personal_data,
        commands::backend::matrix_deactivate_account,
        commands::backend::matrix_accounts,
        commands::backend::matrix_get_profile,
        commands::backend::matrix_update_profile_display_name,
        commands::backend::matrix_switch_account,
        commands::backend::matrix_recovery_health,
        commands::backend::matrix_test_recovery,
        commands::backend::matrix_test_stored_recovery,
        commands::backend::matrix_start_device_verification,
        commands::backend::matrix_device_verification_status,
        commands::backend::matrix_select_device_verification_method,
        commands::backend::matrix_confirm_device_verification,
        commands::backend::matrix_cancel_device_verification,
        commands::backend::matrix_user_preferences,
        commands::backend::matrix_update_user_preferences,
        commands::backend::matrix_create_community,
        commands::backend::matrix_list_communities,
        commands::backend::matrix_list_channels,
        commands::backend::matrix_create_channel,
        commands::backend::matrix_list_custom_emoji,
        commands::backend::matrix_upload_custom_emoji,
        commands::backend::matrix_remove_custom_emoji,
        commands::backend::matrix_load_custom_emoji_image,
        commands::backend::matrix_rtc_join,
        commands::backend::matrix_rtc_ack_media_key_pause,
        commands::backend::matrix_rtc_ack_media_key,
        commands::backend::matrix_rtc_renew_media_key_lease,
        commands::backend::matrix_rtc_refresh_membership,
        commands::backend::matrix_rtc_leave,
        commands::backend::matrix_rtc_members,
        commands::backend::matrix_send_message,
        commands::backend::matrix_queued_messages,
        commands::backend::matrix_retry_queued_message,
        commands::backend::matrix_cancel_queued_message,
        commands::backend::matrix_save_composer_draft,
        commands::backend::matrix_load_composer_draft,
        commands::backend::matrix_clear_composer_draft,
        commands::backend::matrix_send_attachment,
        commands::backend::matrix_cancel_attachment_upload,
        commands::backend::matrix_download_attachment,
        commands::backend::matrix_load_attachment_thumbnail,
        commands::backend::matrix_load_attachment_image,
        commands::backend::matrix_cancel_attachment_download,
        commands::backend::matrix_dm_conversations,
        commands::backend::matrix_ensure_dm,
        commands::backend::matrix_dm_messages,
        commands::backend::matrix_send_dm,
        commands::backend::matrix_send_dm_attachment,
        commands::backend::matrix_mark_dm_read,
        commands::backend::matrix_set_dm_blocked,
        commands::backend::matrix_dm_blocked,
        commands::backend::matrix_get_messages,
        commands::backend::matrix_edit_message,
        commands::backend::matrix_redact_message,
        commands::backend::matrix_report_message,
        commands::backend::matrix_toggle_reaction,
        commands::backend::matrix_room_pins,
        commands::backend::matrix_toggle_room_pin,
        commands::backend::matrix_mark_read,
        commands::backend::matrix_set_typing,
        commands::backend::matrix_typing_users,
        commands::backend::matrix_search_messages,
        commands::backend::matrix_wait_for_room_update,
        commands::backend::matrix_list_members,
        commands::backend::matrix_get_community_permission_projection,
        commands::backend::matrix_invite_to_community,
        commands::backend::matrix_create_community_invite,
        commands::backend::matrix_resolve_community_invite,
        commands::backend::matrix_claim_community_invite,
        commands::backend::matrix_community_access_settings,
        commands::backend::matrix_update_community_access,
        commands::backend::matrix_search_community_directory,
        commands::backend::matrix_knock_community,
        commands::backend::matrix_list_community_applications,
        commands::backend::matrix_respond_community_application,
        commands::backend::matrix_join_community,
        commands::backend::matrix_join_room,
        commands::backend::matrix_leave_community,
        commands::backend::matrix_update_community,
        commands::backend::matrix_update_member_role,
        commands::backend::matrix_kick_member,
        commands::backend::matrix_ban_member,
        commands::backend::matrix_list_moderation_audit,
        commands::backend::matrix_sync_once,
        commands::backend::matrix_enable_recovery,
        commands::backend::matrix_recover,
        // Provenance-preserving legacy archive migration
        commands::migration::export_legacy_archive,
        commands::migration::inspect_legacy_archives,
        commands::migration::dry_run_legacy_import,
        commands::migration::approve_legacy_import,
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
        commands::messaging::broadcast_typing,
        commands::messaging::get_channel_event_log,
        // Voice
        commands::voice::join_voice,
        commands::voice::leave_voice,
        commands::voice::set_muted,
        commands::voice::set_deafened,
        commands::voice::send_voice_signal,
        commands::voice::get_ice_servers,
        commands::voice::get_ice_server_status,
        commands::voice::validate_ice_servers,
        commands::voice::set_ice_servers,
        commands::voice::probe_ice_servers,
        commands::diagnostics::get_diagnostics,
        commands::voice::set_kv,
        // Files
        commands::files::upload_file,
        commands::files::upload_dm_file,
        commands::files::request_file,
        commands::files::get_community_files,
        // Moderation
        commands::moderation::ban_user,
        commands::moderation::kick_user,
        commands::moderation::timeout_user,
        commands::moderation::update_member_role,
        commands::moderation::get_members,
        // Direct Messages
        commands::dm::send_dm,
        commands::dm::get_dm_conversations,
        commands::dm::get_dm_messages,
        commands::dm::mark_dm_read,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
