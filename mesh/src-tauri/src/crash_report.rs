use chrono::{DateTime, Utc};
use serde::Serialize;
use std::{
    fs, panic,
    path::{Path, PathBuf},
    sync::OnceLock,
};

const CRASH_MARKER_DIRECTORY: &str = "crash-diagnostics";
const CRASH_MARKER_FILE: &str = "last-crash.json";

struct CrashContext {
    marker_path: PathBuf,
    app_version: String,
}

static CRASH_CONTEXT: OnceLock<CrashContext> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashMarker {
    schema_version: u8,
    occurred_at: DateTime<Utc>,
    app_version: String,
    operating_system: &'static str,
    architecture: &'static str,
    source_file: Option<String>,
    source_line: Option<u32>,
}

impl CrashMarker {
    fn capture(app_version: &str, location: Option<(&str, u32)>) -> Self {
        let (source_file, source_line) = location
            .map(|(file, line)| {
                (
                    Path::new(file)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .map(ToOwned::to_owned),
                    Some(line),
                )
            })
            .unwrap_or((None, None));

        Self {
            schema_version: 1,
            occurred_at: Utc::now(),
            app_version: app_version.to_owned(),
            operating_system: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            source_file,
            source_line,
        }
    }
}

pub fn install(app_data_dir: &Path, app_version: &str) {
    let marker_directory = app_data_dir.join(CRASH_MARKER_DIRECTORY);
    let _ = fs::create_dir_all(&marker_directory);
    if CRASH_CONTEXT
        .set(CrashContext {
            marker_path: marker_directory.join(CRASH_MARKER_FILE),
            app_version: app_version.to_owned(),
        })
        .is_err()
    {
        return;
    }

    let previous_hook = panic::take_hook();
    panic::set_hook(Box::new(move |panic_info| {
        if let Some(context) = CRASH_CONTEXT.get() {
            let location = panic_info
                .location()
                .map(|location| (location.file(), location.line()));
            let marker = CrashMarker::capture(&context.app_version, location);
            if let Ok(serialized) = serde_json::to_vec_pretty(&marker) {
                let _ = fs::write(&context.marker_path, serialized);
            }
        }

        previous_hook(panic_info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_marker_keeps_only_a_source_basename() {
        let marker = CrashMarker::capture("1.2.3", Some(("/home/alice/private/sync.rs", 42)));

        assert_eq!(marker.source_file.as_deref(), Some("sync.rs"));
        assert_eq!(marker.source_line, Some(42));
        let serialized = serde_json::to_string(&marker).expect("marker should serialize");
        assert!(!serialized.contains("/home/alice"));
    }

    #[test]
    fn crash_marker_has_no_payload_or_communication_fields() {
        let serialized = serde_json::to_value(CrashMarker::capture("1.2.3", None))
            .expect("marker should serialize");
        let fields = serialized.as_object().expect("marker should be an object");

        assert_eq!(fields.len(), 7);
        for forbidden in [
            "payload",
            "backtrace",
            "message",
            "userId",
            "roomId",
            "accessToken",
            "processArguments",
        ] {
            assert!(!fields.contains_key(forbidden));
        }
    }
}
