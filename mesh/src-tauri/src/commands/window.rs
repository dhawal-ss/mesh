use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

/*
  Two things the operating system is entitled to know about a window, and Mesh
  was telling it neither.

  The title bar said "Mesh" whatever you were reading. The renderer already
  computes a precise one for `document.title` (`#general | Acme | Mesh`), but
  in a Tauri app that string reaches the browser tab that does not exist and
  never reaches the OS, so Alt-Tab, the taskbar preview and the window list all
  showed the same four letters for every room.

  And the window opened centred at 1100x700 on every launch, discarding
  whatever size and position had been chosen. On a multi-monitor desk that is a
  drag across screens after every restart.
*/

/// Long enough for `#a-long-room-name | A Long Community Name | Mesh`, short
/// enough that a room named to overflow a title bar cannot.
const MAX_WINDOW_TITLE_CHARS: usize = 120;

const GEOMETRY_FILE: &str = "window-geometry.json";

/// The smallest window Mesh is willing to restore, matching the `minWidth` and
/// `minHeight` in tauri.conf.json. A stored geometry below this came from a
/// different build or a corrupted file, and restoring it would open a window
/// too small to use.
const MIN_RESTORE_WIDTH: f64 = 800.0;
const MIN_RESTORE_HEIGHT: f64 = 500.0;

/// Room names and community names come from other people, so the title is
/// attacker-influenced text on a trusted OS surface. Control characters can
/// break a taskbar label out of one line; the rest is a length bound.
fn sanitize_window_title(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return "Mesh".to_owned();
    }
    match trimmed.char_indices().nth(MAX_WINDOW_TITLE_CHARS) {
        Some((index, _)) => format!("{}…", &trimmed[..index]),
        None => trimmed.to_owned(),
    }
}

/// Puts what the renderer already computed for `document.title` on the window.
#[tauri::command]
pub fn set_window_title(window: WebviewWindow, title: String) -> Result<(), String> {
    window
        .set_title(&sanitize_window_title(&title))
        .map_err(|error| error.to_string())
}

/// Where the window was, in logical pixels, and whether it was maximized.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Restored separately: a maximized window's inner size is the size of the
    /// monitor, so replaying it as an explicit size would leave an unmaximized
    /// window filling the screen with no way back to its previous size.
    pub maximized: bool,
}

impl WindowGeometry {
    /// Rejects a geometry that would open a window nobody can use: smaller than
    /// the configured minimum, or with a non-finite coordinate from a corrupted
    /// file.
    fn is_usable(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            && self.width >= MIN_RESTORE_WIDTH
            && self.height >= MIN_RESTORE_HEIGHT
    }
}

/// The last known geometry, kept in memory and written once on close.
///
/// A window emits `Moved` and `Resized` for every frame of a drag, so writing
/// the file on each one would mean hundreds of writes to put a window down
/// somewhere. The events update this instead, and the file is written when the
/// window closes.
#[derive(Default)]
pub struct WindowGeometryStore {
    latest: Mutex<Option<WindowGeometry>>,
    path: Mutex<Option<PathBuf>>,
}

impl WindowGeometryStore {
    pub fn with_data_dir(data_dir: &Path) -> Self {
        Self {
            latest: Mutex::new(None),
            path: Mutex::new(Some(data_dir.join(GEOMETRY_FILE))),
        }
    }

    fn file(&self) -> Option<PathBuf> {
        self.path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn record(&self, geometry: WindowGeometry) {
        *self
            .latest
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(geometry);
    }

    pub fn persist(&self) {
        let Some(path) = self.file() else { return };
        let geometry = *self
            .latest
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(geometry) = geometry else { return };
        match serde_json::to_vec_pretty(&geometry) {
            Ok(encoded) => {
                if let Err(error) = std::fs::write(&path, encoded) {
                    tracing::warn!(target: "mesh::window", "Could not save the window geometry: {error}");
                }
            }
            Err(error) => {
                tracing::warn!(target: "mesh::window", "Could not encode the window geometry: {error}")
            }
        }
    }

    pub fn load(&self) -> Option<WindowGeometry> {
        let path = self.file()?;
        let raw = std::fs::read(&path).ok()?;
        let geometry: WindowGeometry = serde_json::from_slice(&raw).ok()?;
        geometry.is_usable().then_some(geometry)
    }
}

/// Reads the window's current geometry, or None while it is minimized.
///
/// A minimized window reports a position far outside every monitor, so
/// recording it would store a location the window can never be restored to.
pub fn current_geometry(window: &WebviewWindow) -> Option<WindowGeometry> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(WindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    })
}

/// A display's logical bounds: x, y, width, height.
pub type MonitorBounds = (f64, f64, f64, f64);

/// How much of the window's top edge has to land on a display for the window to
/// be reachable. Below this there is not enough title bar left to grab.
const MIN_VISIBLE_WIDTH: f64 = 120.0;
const MIN_VISIBLE_HEIGHT: f64 = 32.0;

/*
  A monitor that was there last time may not be there now.

  Restoring a window onto a display that has been unplugged, or onto the part of
  a display that a resolution change has taken away, puts it somewhere with no
  title bar to drag and no way back short of editing this file by hand. So the
  stored rectangle is tested against the displays that exist before the window
  is moved, rather than moved first and rescued afterwards: `current_monitor`
  cannot be that test, because Windows resolves a window to its *nearest*
  monitor and so names one for a window that is nowhere near it.
*/
pub fn is_reachable_on(geometry: &WindowGeometry, monitors: &[MonitorBounds]) -> bool {
    monitors.iter().any(|(x, y, width, height)| {
        let overlap_width = (geometry.x + geometry.width).min(x + width) - geometry.x.max(*x);
        let overlap_height = (geometry.y + geometry.height).min(y + height) - geometry.y.max(*y);
        overlap_width >= MIN_VISIBLE_WIDTH && overlap_height >= MIN_VISIBLE_HEIGHT
    })
}

/// The logical bounds of every connected display.
fn connected_monitors(window: &WebviewWindow) -> Vec<MonitorBounds> {
    let Ok(monitors) = window.available_monitors() else {
        return Vec::new();
    };
    monitors
        .into_iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let position = monitor.position().to_logical::<f64>(scale);
            let size = monitor.size().to_logical::<f64>(scale);
            (position.x, position.y, size.width, size.height)
        })
        .collect()
}

/// Puts the window back where it was, if it can still go there.
pub fn restore_geometry(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let store = app.state::<WindowGeometryStore>();
    let Some(geometry) = store.load() else { return };

    if let Err(error) = window.set_size(LogicalSize::new(geometry.width, geometry.height)) {
        tracing::warn!(target: "mesh::window", "Could not restore the window size: {error}");
        return;
    }

    let monitors = connected_monitors(&window);
    // An empty list means the displays could not be enumerated, not that there
    // are none. Restoring the position is the better guess there: the size is
    // already restored, and the alternative is centering a window that was
    // probably fine where it was.
    if monitors.is_empty() || is_reachable_on(&geometry, &monitors) {
        if let Err(error) = window.set_position(LogicalPosition::new(geometry.x, geometry.y)) {
            tracing::warn!(target: "mesh::window", "Could not restore the window position: {error}");
        }
    } else {
        tracing::info!(
            target: "mesh::window",
            "The stored window position is not on any connected display; centering instead"
        );
        if let Err(error) = window.center() {
            tracing::warn!(target: "mesh::window", "Could not center the window: {error}");
        }
    }

    if geometry.maximized {
        if let Err(error) = window.maximize() {
            tracing::warn!(target: "mesh::window", "Could not restore the maximized window: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_title_drops_control_characters_a_room_name_could_carry() {
        assert_eq!(
            sanitize_window_title("#general\n| Acme | Mesh"),
            "#general| Acme | Mesh"
        );
        assert_eq!(sanitize_window_title("a\u{0007}b"), "ab");
    }

    #[test]
    fn an_empty_or_blank_title_falls_back_to_the_product_name() {
        assert_eq!(sanitize_window_title(""), "Mesh");
        assert_eq!(sanitize_window_title("   \t "), "Mesh");
        assert_eq!(sanitize_window_title("\u{0000}"), "Mesh");
    }

    #[test]
    fn a_title_long_enough_to_overflow_the_taskbar_is_bounded() {
        let title = "a".repeat(500);
        let sanitized = sanitize_window_title(&title);
        assert_eq!(sanitized.chars().count(), MAX_WINDOW_TITLE_CHARS + 1);
        assert!(sanitized.ends_with('…'));
    }

    #[test]
    fn bounding_a_title_never_splits_a_character() {
        // Truncating by byte index would panic here, and a room name is exactly
        // the kind of text that carries multi-byte characters.
        let sanitized = sanitize_window_title(&"é".repeat(300));
        assert_eq!(sanitized.chars().count(), MAX_WINDOW_TITLE_CHARS + 1);
    }

    #[test]
    fn a_geometry_smaller_than_the_configured_minimum_is_refused() {
        let usable = WindowGeometry {
            x: 10.0,
            y: 10.0,
            width: 1100.0,
            height: 700.0,
            maximized: false,
        };
        assert!(usable.is_usable());
        assert!(!WindowGeometry {
            width: 100.0,
            ..usable
        }
        .is_usable());
        assert!(!WindowGeometry {
            height: 40.0,
            ..usable
        }
        .is_usable());
        assert!(!WindowGeometry {
            x: f64::NAN,
            ..usable
        }
        .is_usable());
        assert!(!WindowGeometry {
            y: f64::INFINITY,
            ..usable
        }
        .is_usable());
    }

    #[test]
    fn geometry_survives_a_round_trip_through_the_file() {
        let directory = tempfile::tempdir().expect("temp dir");
        let store = WindowGeometryStore::with_data_dir(directory.path());
        assert_eq!(store.load(), None, "nothing stored yet");

        let geometry = WindowGeometry {
            x: 240.0,
            y: 120.0,
            width: 1440.0,
            height: 900.0,
            maximized: true,
        };
        store.record(geometry);
        store.persist();

        let reopened = WindowGeometryStore::with_data_dir(directory.path());
        assert_eq!(reopened.load(), Some(geometry));
    }

    #[test]
    fn a_corrupted_geometry_file_opens_the_default_window_instead_of_failing() {
        let directory = tempfile::tempdir().expect("temp dir");
        std::fs::write(directory.path().join(GEOMETRY_FILE), b"{not json").expect("write");
        assert_eq!(
            WindowGeometryStore::with_data_dir(directory.path()).load(),
            None
        );
    }

    const LAPTOP: MonitorBounds = (0.0, 0.0, 1920.0, 1080.0);
    const SECOND_SCREEN_TO_THE_LEFT: MonitorBounds = (-2560.0, -200.0, 2560.0, 1440.0);

    fn at(x: f64, y: f64) -> WindowGeometry {
        WindowGeometry {
            x,
            y,
            width: 1100.0,
            height: 700.0,
            maximized: false,
        }
    }

    #[test]
    fn a_window_on_a_connected_display_keeps_its_position() {
        assert!(is_reachable_on(&at(100.0, 100.0), &[LAPTOP]));
        assert!(is_reachable_on(
            &at(-2000.0, 0.0),
            &[LAPTOP, SECOND_SCREEN_TO_THE_LEFT]
        ));
    }

    #[test]
    fn a_window_on_a_display_that_was_unplugged_is_not_restored_there() {
        // The same position, with and without the second screen present.
        assert!(is_reachable_on(
            &at(-2000.0, 0.0),
            &[LAPTOP, SECOND_SCREEN_TO_THE_LEFT]
        ));
        assert!(!is_reachable_on(&at(-2000.0, 0.0), &[LAPTOP]));
    }

    #[test]
    fn a_window_with_too_little_left_on_screen_to_grab_is_refused() {
        // Hanging off the right edge with 100px showing: less than a title bar
        // worth of window to drag it back by.
        assert!(!is_reachable_on(&at(1820.0, 100.0), &[LAPTOP]));
        assert!(is_reachable_on(&at(1800.0, 100.0), &[LAPTOP]));
        // Pushed down past the bottom edge the same way.
        assert!(!is_reachable_on(&at(100.0, 1060.0), &[LAPTOP]));
    }

    #[test]
    fn no_enumerated_display_is_not_the_same_as_no_display() {
        // With an empty list the caller restores the position rather than
        // centering, so this must report unreachable and not panic.
        assert!(!is_reachable_on(&at(100.0, 100.0), &[]));
    }

    #[test]
    fn persisting_before_anything_is_recorded_writes_no_file() {
        let directory = tempfile::tempdir().expect("temp dir");
        WindowGeometryStore::with_data_dir(directory.path()).persist();
        assert!(!directory.path().join(GEOMETRY_FILE).exists());
    }
}
