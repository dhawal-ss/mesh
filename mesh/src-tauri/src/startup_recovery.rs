use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{App, AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[cfg(target_os = "windows")]
#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(
        window: *mut std::ffi::c_void,
        text: *const u16,
        caption: *const u16,
        message_type: u32,
    ) -> i32;
}

const MARKER_FILE: &str = "startup-recovery.json";
const REPEAT_WINDOW_SECONDS: u64 = 10 * 60;
const LOOP_COOLDOWN_SECONDS: u64 = 30 * 60;
const MAX_RECORDED_ATTEMPTS: u8 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartupFailureKind {
    AppData,
    Permission,
    Keychain,
    DatabaseOpen,
    Migration,
    CorruptState,
    Runtime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartupFailure {
    pub kind: StartupFailureKind,
}

impl StartupFailure {
    pub const fn new(kind: StartupFailureKind) -> Self {
        Self { kind }
    }

    pub fn from_app_data_io(error: &std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            Self::new(StartupFailureKind::Permission)
        } else if error.kind() == std::io::ErrorKind::InvalidData {
            Self::new(StartupFailureKind::CorruptState)
        } else {
            Self::new(StartupFailureKind::AppData)
        }
    }

    #[cfg(feature = "legacy-p2p")]
    pub fn from_database(error: &anyhow::Error) -> Self {
        if error.chain().any(|cause| {
            cause
                .downcast_ref::<std::io::Error>()
                .is_some_and(|io| io.kind() == std::io::ErrorKind::PermissionDenied)
        }) {
            return Self::new(StartupFailureKind::Permission);
        }
        let classification = error.to_string().to_ascii_lowercase();
        if classification.contains("migration") || classification.contains("schema version") {
            Self::new(StartupFailureKind::Migration)
        } else if classification.contains("malformed")
            || classification.contains("corrupt")
            || classification.contains("not a database")
        {
            Self::new(StartupFailureKind::CorruptState)
        } else if classification.contains("keyring") || classification.contains("credential") {
            Self::new(StartupFailureKind::Keychain)
        } else {
            Self::new(StartupFailureKind::DatabaseOpen)
        }
    }

    pub fn from_backend(error: &crate::backend::BackendError) -> Self {
        match error {
            crate::backend::BackendError::PermissionDenied(_) => {
                Self::new(StartupFailureKind::Permission)
            }
            crate::backend::BackendError::Crypto(_) => Self::new(StartupFailureKind::Keychain),
            crate::backend::BackendError::Serialization(_) => {
                Self::new(StartupFailureKind::CorruptState)
            }
            _ => Self::new(StartupFailureKind::Runtime),
        }
    }

    pub fn public_copy(self) -> &'static str {
        match self.kind {
            StartupFailureKind::AppData => {
                "Mesh could not open its app data. Close Mesh, check available storage, and try again."
            }
            StartupFailureKind::Permission => {
                "Mesh does not have permission to open its local data. Close Mesh, review folder access, and try again."
            }
            StartupFailureKind::Keychain => {
                "Mesh could not access secure account storage. Close Mesh, unlock the operating system credential store, and try again."
            }
            StartupFailureKind::DatabaseOpen => {
                "Mesh could not open its local database. Close Mesh and contact support before changing or deleting local data."
            }
            StartupFailureKind::Migration => {
                "Mesh could not safely update its local data. Close Mesh and contact support; automatic repair was not attempted."
            }
            StartupFailureKind::CorruptState => {
                "Mesh detected unreadable local state. Close Mesh and contact support; automatic repair was not attempted."
            }
            StartupFailureKind::Runtime => {
                "Mesh could not start its native runtime. Close Mesh and try again; if this repeats, contact support."
            }
        }
    }

    fn code(self) -> &'static str {
        match self.kind {
            StartupFailureKind::AppData => "app-data",
            StartupFailureKind::Permission => "permission",
            StartupFailureKind::Keychain => "keychain",
            StartupFailureKind::DatabaseOpen => "database-open",
            StartupFailureKind::Migration => "migration",
            StartupFailureKind::CorruptState => "corrupt-state",
            StartupFailureKind::Runtime => "runtime",
        }
    }
}

impl std::fmt::Display for StartupFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.public_copy())
    }
}

impl std::error::Error for StartupFailure {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartupRecoveryMarker {
    schema_version: u8,
    category: String,
    attempt_count: u8,
    first_failure_epoch_seconds: u64,
    last_failure_epoch_seconds: u64,
    cooldown_until_epoch_seconds: u64,
    automatic_restart_allowed: bool,
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn marker_path(directory: &Path) -> PathBuf {
    directory.join(MARKER_FILE)
}

fn record_failure_at(
    directory: &Path,
    failure: StartupFailure,
    now: u64,
) -> std::io::Result<StartupRecoveryMarker> {
    std::fs::create_dir_all(directory)?;
    let existing = std::fs::read(marker_path(directory))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<StartupRecoveryMarker>(&bytes).ok())
        .filter(|marker| {
            marker.category == failure.code()
                && now.saturating_sub(marker.last_failure_epoch_seconds) <= REPEAT_WINDOW_SECONDS
        });
    let attempt_count = existing
        .as_ref()
        .map_or(1, |marker| marker.attempt_count.saturating_add(1))
        .min(MAX_RECORDED_ATTEMPTS);
    let marker = StartupRecoveryMarker {
        schema_version: 1,
        category: failure.code().to_owned(),
        attempt_count,
        first_failure_epoch_seconds: existing
            .as_ref()
            .map_or(now, |marker| marker.first_failure_epoch_seconds),
        last_failure_epoch_seconds: now,
        cooldown_until_epoch_seconds: if attempt_count >= MAX_RECORDED_ATTEMPTS {
            now.saturating_add(LOOP_COOLDOWN_SECONDS)
        } else {
            now
        },
        automatic_restart_allowed: false,
    };
    let serialized = serde_json::to_vec(&marker).map_err(std::io::Error::other)?;
    debug_assert!(serialized.len() < 512);
    std::fs::write(marker_path(directory), serialized)?;
    Ok(marker)
}

fn record_failure(directory: &Path, failure: StartupFailure) {
    if record_failure_at(directory, failure, epoch_seconds()).is_err() {
        tracing::warn!(target: "mesh::startup", "Could not write the sanitized startup recovery marker");
    }
}

fn show_dialog<R: Runtime>(handle: AppHandle<R>, failure: StartupFailure) {
    let result = std::thread::spawn(move || {
        handle
            .dialog()
            .message(failure.public_copy())
            .title("Mesh could not start")
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::Ok)
            .blocking_show()
    })
    .join();
    if result.is_err() {
        tracing::warn!(target: "mesh::startup", "The native startup recovery dialog could not be completed");
    }
}

pub fn fallback_marker_directory() -> PathBuf {
    std::env::temp_dir().join("mesh-startup-recovery")
}

pub fn report_and_exit<R: Runtime>(app: &App<R>, marker_directory: &Path, failure: StartupFailure) {
    record_failure(marker_directory, failure);
    show_dialog(app.handle().clone(), failure);
    app.handle().exit(78);
}

pub fn report_handle_and_exit<R: Runtime>(
    handle: &AppHandle<R>,
    marker_directory: &Path,
    failure: StartupFailure,
) {
    record_failure(marker_directory, failure);
    show_dialog(handle.clone(), failure);
    handle.exit(78);
}

pub fn show_runtime_build_failure() {
    let failure = StartupFailure::new(StartupFailureKind::Runtime);
    record_failure(&fallback_marker_directory(), failure);
    show_system_fallback_dialog(failure.public_copy());
}

#[cfg(target_os = "windows")]
fn show_system_fallback_dialog(copy: &str) {
    const MB_OK: u32 = 0;
    const MB_ICONERROR: u32 = 0x10;
    const MB_SETFOREGROUND: u32 = 0x0001_0000;
    let text = copy
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let caption = "Mesh could not start"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both UTF-16 buffers are NUL-terminated and remain alive for the
    // duration of the synchronous operating-system call. A null owner window
    // is explicitly supported for a process that failed before Tauri started.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn show_system_fallback_dialog(_copy: &str) {
    tracing::error!(target: "mesh::startup", "Mesh could not start; the native runtime was unavailable");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_injected_startup_category_has_bounded_actionable_copy() {
        for kind in [
            StartupFailureKind::AppData,
            StartupFailureKind::Permission,
            StartupFailureKind::Keychain,
            StartupFailureKind::DatabaseOpen,
            StartupFailureKind::Migration,
            StartupFailureKind::CorruptState,
            StartupFailureKind::Runtime,
        ] {
            let copy = StartupFailure::new(kind).public_copy();
            assert!(copy.len() < 240);
            assert!(copy.contains("Mesh"));
            assert!(!copy.contains("\\Users\\"));
            assert!(!copy.contains("/home/"));
            assert!(!copy.contains("backtrace"));
            assert!(!copy.contains("@"));
        }
    }

    #[test]
    fn marker_is_sanitized_bounded_and_suppresses_restart_loops() {
        let directory = tempfile::tempdir().unwrap();
        let failure = StartupFailure::new(StartupFailureKind::CorruptState);
        for now in [100, 101, 102, 103] {
            record_failure_at(directory.path(), failure, now).unwrap();
        }
        let bytes = std::fs::read(marker_path(directory.path())).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        let marker: StartupRecoveryMarker = serde_json::from_slice(&bytes).unwrap();
        assert!(bytes.len() < 512);
        assert_eq!(marker.attempt_count, MAX_RECORDED_ATTEMPTS);
        assert!(!marker.automatic_restart_allowed);
        assert!(marker.cooldown_until_epoch_seconds > marker.last_failure_epoch_seconds);
        assert!(!text.contains("secret"));
        assert!(!text.contains("\\Users\\"));
        assert!(!text.contains("/home/"));
    }

    #[test]
    fn app_data_io_failures_are_typed_without_exposing_the_cause() {
        let permission = std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            r"C:\Users\person\private\account.db secret",
        );
        let failure = StartupFailure::from_app_data_io(&permission);
        assert_eq!(failure.kind, StartupFailureKind::Permission);
        assert!(!failure.to_string().contains("person"));
        assert!(!failure.to_string().contains("secret"));
    }
}
