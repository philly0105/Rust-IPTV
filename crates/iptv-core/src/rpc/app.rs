//! `app.*` commands (C4): `app.info`, `app.openLogDir`, `app.openPath`, `app.ping`,
//! `app.pendingDeepLinks`.

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
    r.add(
        "app.pendingDeepLinks",
        |s: Arc<AppState>, _: ()| async move { Ok(take_pending_deep_links(&s)) },
    );
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
    let desktop = s.ext::<DesktopInfo>(DESKTOP_INFO_KEY);
    AppInfo {
        version: AppState::version().to_string(),
        data_dir: s.data_dir.display().to_string(),
        platform: std::env::consts::OS.to_string(),
        is_desktop: s.is_desktop,
        log_file: crate::logging::current_log_file(&s.logs_dir())
            .display()
            .to_string(),
        proxy_base: desktop
            .as_ref()
            .and_then(|d| d.proxy_base.clone())
            .filter(|_| s.is_desktop),
        updater_available: s.is_desktop && desktop.is_some_and(|d| d.updater_available),
    }
}

/// `AppState.extensions` key of [`DesktopInfo`].
pub const DESKTOP_INFO_KEY: &str = "app.desktop_info";

/// Facts only the desktop shell knows, reported by `app.info`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DesktopInfo {
    /// Loopback media proxy base (`http://127.0.0.1:<port>/<token>/api/proxy`, where
    /// `<token>` is a per-launch secret path segment).
    pub proxy_base: Option<String>,
    /// Built with the `updater` feature.
    pub updater_available: bool,
}

/// Registers the desktop shell's facts (called by iptv-tauri at boot).
pub fn set_desktop_info(s: &AppState, info: DesktopInfo) {
    s.set_ext(DESKTOP_INFO_KEY, Arc::new(info));
}

/// `AppState.extensions` key of [`PendingDeepLinks`].
pub const PENDING_DEEPLINKS_KEY: &str = "app.pending_deeplinks";

/// Deep links that arrived before the UI asked for them.
#[derive(Default)]
pub struct PendingDeepLinks {
    inner: parking_lot::Mutex<(bool, Vec<String>)>,
}

fn pending(s: &AppState) -> Arc<PendingDeepLinks> {
    s.ext_or_insert_with(PENDING_DEEPLINKS_KEY, || {
        Arc::new(PendingDeepLinks::default())
    })
}

/// Hands deep links to the UI. Until the UI has called
/// `app.pendingDeepLinks` once they are queued (the webview is not listening
/// yet on a cold start); afterwards they go out live as `deeplink.open`.
pub fn deliver_deep_links(s: &AppState, urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }
    let p = pending(s);
    let mut g = p.inner.lock();
    if g.0 {
        drop(g);
        s.emit("deeplink.open", serde_json::json!({ "urls": urls }));
    } else {
        g.1.extend(urls);
    }
}

/// `app.pendingDeepLinks`: returns and clears the queue and switches
/// [`deliver_deep_links`] to live delivery.
pub fn take_pending_deep_links(s: &AppState) -> Vec<String> {
    let p = pending(s);
    let mut g = p.inner.lock();
    g.0 = true;
    std::mem::take(&mut g.1)
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

    #[tokio::test]
    async fn deep_links_queue_until_pulled_then_go_live() {
        let dir = tempfile::tempdir().unwrap();
        let (sink, mut rx) = crate::events::BroadcastSink::channel(16);
        let s = AppState::new(dir.path().to_path_buf(), Arc::new(sink), true)
            .await
            .unwrap();
        deliver_deep_links(&s, vec!["iptv://a".into()]);
        deliver_deep_links(&s, vec!["iptv://b".into()]);
        assert!(rx.try_recv().is_err(), "queued links must not be emitted");
        assert_eq!(take_pending_deep_links(&s), ["iptv://a", "iptv://b"]);
        assert!(take_pending_deep_links(&s).is_empty());
        deliver_deep_links(&s, vec!["iptv://c".into()]);
        let ev = rx.recv().await.unwrap();
        assert_eq!(ev.kind, "deeplink.open");
        assert_eq!(ev.payload["urls"][0], "iptv://c");
        assert!(take_pending_deep_links(&s).is_empty());

        // app.info reports the shell's facts only on desktop.
        assert_eq!(info(&s).proxy_base, None);
        set_desktop_info(
            &s,
            DesktopInfo {
                proxy_base: Some("http://127.0.0.1:1/api/proxy".into()),
                updater_available: true,
            },
        );
        let i = info(&s);
        assert_eq!(
            i.proxy_base.as_deref(),
            Some("http://127.0.0.1:1/api/proxy")
        );
        assert!(i.updater_available);
    }

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
