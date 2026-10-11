//! `app.*` commands (C4): `app.info`, `app.openLogDir`, `app.openPath`, `app.ping`.

use super::RpcRouter;
use crate::error::RpcError;
use crate::model::AppInfo;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// `app.openPath` args.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPathArgs {
    pub path: String,
}

/// `app.ping` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pong {
    pub ok: bool,
}

/// Registers the `app.*` commands.
pub fn register(r: &mut RpcRouter) {
    r.add(
        "app.info",
        |s: Arc<AppState>, _: ()| async move { Ok(info(&s)) },
    );
    r.add("app.ping", |_s: Arc<AppState>, _: ()| async move {
        Ok(Pong { ok: true })
    });
    r.add("app.openLogDir", |s: Arc<AppState>, _: ()| async move {
        ensure_desktop(&s)?;
        let dir = s.logs_dir();
        std::fs::create_dir_all(&dir)?;
        open_with_os(&dir)
    });
    r.add(
        "app.openPath",
        |s: Arc<AppState>, a: OpenPathArgs| async move {
            ensure_desktop(&s)?;
            let path = validate_open_path(&a.path)?;
            open_with_os(&path)
        },
    );
}

/// Builds the `app.info` payload.
pub fn info(s: &AppState) -> AppInfo {
    AppInfo {
        version: AppState::version().to_string(),
        data_dir: s.data_dir.display().to_string(),
        platform: std::env::consts::OS.to_string(),
        is_desktop: s.is_desktop,
        log_file: crate::logging::current_log_file(&s.logs_dir())
            .display()
            .to_string(),
    }
}

fn ensure_desktop(s: &AppState) -> Result<(), RpcError> {
    if s.is_desktop {
        Ok(())
    } else {
        Err(RpcError::unsupported(
            "Opening local paths is only available in the desktop app.",
        ))
    }
}

/// Extensions that would execute code if handed to the OS shell.
const BLOCKED_EXTENSIONS: &[&str] = &[
    "exe", "bat", "cmd", "com", "msi", "msp", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf",
    "wsh", "scr", "lnk", "pif", "reg", "hta", "cpl", "jar", "sh", "app", "command",
];

/// Accepts existing directories and non-executable files.
fn validate_open_path(raw: &str) -> Result<PathBuf, RpcError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(RpcError::invalid("Path is empty."));
    }
    let path = PathBuf::from(trimmed);
    let meta = std::fs::metadata(&path)
        .map_err(|_| RpcError::not_found(format!("{} does not exist.", path.display())))?;
    if meta.is_file() {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if BLOCKED_EXTENSIONS.contains(&ext.as_str()) {
            return Err(RpcError::invalid("Refusing to open an executable file."));
        }
    }
    Ok(path)
}

/// Opens a file or directory with the OS default handler (detached).
fn open_with_os(path: &Path) -> Result<(), RpcError> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer");
        c.arg(path);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(path);
        c
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(path);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| {
        RpcError::from(e).with_details(serde_json::json!({ "path": path.display().to_string() }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_path_validation() {
        let dir = tempfile::tempdir().unwrap();
        assert!(validate_open_path(&dir.path().display().to_string()).is_ok());
        let exe = dir.path().join("evil.exe");
        std::fs::write(&exe, b"x").unwrap();
        assert!(validate_open_path(&exe.display().to_string()).is_err());
        let mp4 = dir.path().join("movie.mp4");
        std::fs::write(&mp4, b"x").unwrap();
        assert!(validate_open_path(&mp4.display().to_string()).is_ok());
        assert!(validate_open_path("").is_err());
        assert!(validate_open_path(&dir.path().join("missing").display().to_string()).is_err());
    }
}
