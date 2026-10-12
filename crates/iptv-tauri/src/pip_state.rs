//! The window geometry from before picture-in-picture, kept on the Rust side.
//!
//! PiP shrinks the main window to a small borderless always-on-top corner
//! window. `tauri-plugin-window-state` writes whatever the window looks like
//! when the app exits, so quitting from PiP would relaunch the app as that
//! corner window, without a title bar. While PiP is on, the webview hands the
//! normal geometry to [`PipState`]; on `RunEvent::Exit`, after the plugin has
//! written its file (plugins see the event before the app callback),
//! [`persist_on_exit`] puts the normal geometry back into that file.
//!
//! The webview also reads the geometry back after a reload
//! (`pip_window_saved`), so a reload while in PiP can restore the window
//! instead of leaving it stuck small.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

/// Label of the main window (tauri.conf.json).
pub const MAIN_WINDOW: &str = "main";

/// The window as it was before PiP, in physical pixels. `x`/`y` are the
/// outer (frame) position and `width`/`height` the inner (client) size, the
/// same spaces `tauri-plugin-window-state` stores. When `maximized` is set,
/// the rectangle is the normal (restored) one under the maximized window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// Managed state: `Some` while the main window is in PiP.
#[derive(Default)]
pub struct PipState(Mutex<Option<NormalGeometry>>);

impl PipState {
    /// Records the geometry to restore. A second call while PiP is already on
    /// keeps the first geometry: by then the window is already small.
    pub fn begin(&self, geometry: NormalGeometry) {
        self.0.lock().get_or_insert(geometry);
    }

    /// PiP is over; nothing to restore any more.
    pub fn end(&self) {
        *self.0.lock() = None;
    }

    /// The geometry to restore, if PiP is on.
    pub fn saved(&self) -> Option<NormalGeometry> {
        *self.0.lock()
    }
}

/// Writes `geometry` over the `label` entry of a parsed window-state file,
/// creating the entry when missing. PiP-only traits (no decorations,
/// fullscreen) are cleared so the window comes back as a normal framed window.
pub fn patch_saved_state(states: &mut Value, label: &str, geometry: &NormalGeometry) {
    if !states.is_object() {
        *states = json!({});
    }
    let Some(map) = states.as_object_mut() else {
        return;
    };
    let entry = map.entry(label.to_owned()).or_insert_with(|| json!({}));
    if !entry.is_object() {
        *entry = json!({});
    }
    let Some(entry) = entry.as_object_mut() else {
        return;
    };
    let fields = [
        ("width", json!(geometry.width)),
        ("height", json!(geometry.height)),
        ("x", json!(geometry.x)),
        ("y", json!(geometry.y)),
        ("prev_x", json!(geometry.x)),
        ("prev_y", json!(geometry.y)),
        ("maximized", json!(geometry.maximized)),
        ("visible", json!(true)),
        ("decorated", json!(true)),
        ("fullscreen", json!(false)),
    ];
    for (key, value) in fields {
        entry.insert(key.to_owned(), value);
    }
}

/// Rewrites the window-state file at `path` with `geometry` for `label` when
/// PiP was on (`Some`). Returns whether the file was written. With `None` the
/// file is left exactly as the plugin wrote it.
pub fn fix_state_file(
    path: &Path,
    label: &str,
    geometry: Option<NormalGeometry>,
) -> std::io::Result<bool> {
    let Some(geometry) = geometry else {
        return Ok(false);
    };
    let mut states = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(err) => return Err(err),
    };
    patch_saved_state(&mut states, label, &geometry);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let bytes = serde_json::to_vec_pretty(&states).map_err(std::io::Error::other)?;
    std::fs::write(path, bytes)?;
    Ok(true)
}

/// On `RunEvent::Exit`: if the app quits while in PiP, replace the PiP
/// geometry the window-state plugin just saved with the normal geometry.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn persist_on_exit(app: &tauri::AppHandle) {
    use tauri::Manager;
    use tauri_plugin_window_state::AppHandleExt;

    let Some(state) = app.try_state::<PipState>() else {
        return;
    };
    let geometry = state.saved();
    if geometry.is_none() {
        return;
    }
    let dir = match app.path().app_config_dir() {
        Ok(dir) => dir,
        Err(err) => {
            tracing::warn!(%err, "no config dir; quit-in-PiP window state not fixed");
            return;
        }
    };
    let path = dir.join(app.filename());
    match fix_state_file(&path, MAIN_WINDOW, geometry) {
        Ok(_) => tracing::info!("quit in picture-in-picture; saved the normal window geometry"),
        Err(err) => tracing::warn!(%err, "could not fix the window state saved in PiP"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NORMAL: NormalGeometry = NormalGeometry {
        x: 120,
        y: 80,
        width: 1280,
        height: 800,
        maximized: false,
    };

    /// What the plugin writes when the app quits from PiP.
    fn pip_file() -> Value {
        json!({
            "main": {
                "width": 480, "height": 270, "x": 1416, "y": 786,
                "prev_x": 1400, "prev_y": 780,
                "maximized": false, "visible": true, "decorated": false, "fullscreen": false
            },
            "other": { "width": 10 }
        })
    }

    #[test]
    fn quitting_in_pip_saves_the_normal_window() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".window-state.json");
        std::fs::write(&path, serde_json::to_vec(&pip_file()).unwrap()).unwrap();

        assert!(fix_state_file(&path, MAIN_WINDOW, Some(NORMAL)).unwrap());

        let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let main = &saved["main"];
        assert_eq!(main["width"], 1280);
        assert_eq!(main["height"], 800);
        assert_eq!(main["x"], 120);
        assert_eq!(main["y"], 80);
        assert_eq!(main["prev_x"], 120);
        assert_eq!(main["decorated"], true);
        assert_eq!(main["maximized"], false);
        assert_eq!(main["fullscreen"], false);
        assert_eq!(saved["other"]["width"], 10, "other windows are untouched");
    }

    #[test]
    fn quitting_outside_pip_leaves_the_plugin_file_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".window-state.json");
        let original = serde_json::to_vec(&pip_file()).unwrap();
        std::fs::write(&path, &original).unwrap();

        assert!(!fix_state_file(&path, MAIN_WINDOW, None).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn a_maximized_window_comes_back_maximized_over_its_normal_rect() {
        let mut states = pip_file();
        let geometry = NormalGeometry {
            maximized: true,
            ..NORMAL
        };
        patch_saved_state(&mut states, MAIN_WINDOW, &geometry);
        assert_eq!(states["main"]["maximized"], true);
        assert_eq!(states["main"]["width"], 1280);
    }

    #[test]
    fn missing_or_corrupt_files_get_a_fresh_entry() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("sub").join(".window-state.json");
        assert!(fix_state_file(&missing, MAIN_WINDOW, Some(NORMAL)).unwrap());
        let saved: Value = serde_json::from_slice(&std::fs::read(&missing).unwrap()).unwrap();
        assert_eq!(saved["main"]["width"], 1280);

        let corrupt = dir.path().join("corrupt.json");
        std::fs::write(&corrupt, b"{not json").unwrap();
        assert!(fix_state_file(&corrupt, MAIN_WINDOW, Some(NORMAL)).unwrap());
        let saved: Value = serde_json::from_slice(&std::fs::read(&corrupt).unwrap()).unwrap();
        assert_eq!(saved["main"]["decorated"], true);

        let mut wrong_shape = json!([1, 2]);
        patch_saved_state(&mut wrong_shape, MAIN_WINDOW, &NORMAL);
        assert_eq!(wrong_shape["main"]["height"], 800);
    }

    #[test]
    fn the_first_geometry_wins_until_pip_ends() {
        let state = PipState::default();
        assert_eq!(state.saved(), None);
        state.begin(NORMAL);
        state.begin(NormalGeometry {
            width: 480,
            height: 270,
            ..NORMAL
        });
        assert_eq!(state.saved(), Some(NORMAL));
        state.end();
        assert_eq!(state.saved(), None);
        state.begin(NormalGeometry { x: 5, ..NORMAL });
        assert_eq!(state.saved().map(|g| g.x), Some(5));
    }

    #[test]
    fn geometry_uses_the_webview_field_names() {
        let g: NormalGeometry = serde_json::from_value(
            json!({ "x": -1900, "y": 10, "width": 1600, "height": 900, "maximized": true }),
        )
        .unwrap();
        assert_eq!(g.x, -1900);
        assert!(g.maximized);
    }
}
