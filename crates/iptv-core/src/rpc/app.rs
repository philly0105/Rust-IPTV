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
            let roots = [
                crate::downloads::dir(&s),
                crate::player::embedded::recordings_dir(&s),
            ];
            let path = validate_open_path(&a.path, &roots)?;
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

pub(crate) fn ensure_desktop(s: &AppState) -> Result<(), RpcError> {
    if s.is_desktop {
        Ok(())
    } else {
        Err(RpcError::unsupported(
            "Opening local paths is only available in the desktop app.",
        ))
    }
}

/// File types `app.openPath` hands to the OS shell: media, subtitles and
/// playlists. Everything else (programs, shortcuts, `.url`, `.chm`, `.msc`,
/// `.search-ms`, ...) could run code and is refused.
const ALLOWED_EXTENSIONS: &[&str] = &[
    // video
    "mp4", "m4v", "mkv", "webm", "avi", "mov", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts", "mts",
    "3gp", "ogv", // audio
    "mp3", "aac", "m4a", "flac", "ogg", "oga", "opus", "wav", "mka", "wma", // subtitles
    "srt", "vtt", "ass", "ssa", "sub", // playlists
    "m3u", "m3u8", "pls", "xspf",
];

/// Accepts existing local directories and media, subtitle or playlist files.
/// Network (UNC) paths are refused: opening one can reach a remote host with
/// the user's Windows credentials. The exception is a path at or under one
/// of `allowed_roots` (the downloads and recordings folders, which the user
/// chose and may keep on a share, review round 3).
fn validate_open_path(raw: &str, allowed_roots: &[PathBuf]) -> Result<PathBuf, RpcError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(RpcError::invalid("Path is empty."));
    }
    // Windows treats `/` and `\` alike, so `\/host\share` is a UNC path too:
    // unify the separators, then resolve the full path (GetFullPathNameW on
    // Windows) and refuse UNC, verbatim (`\\?\`) and device (`\\.\`) forms
    // before any filesystem call can reach the network.
    let is_network = |p: &str| p.starts_with(r"\\") || p.starts_with("//");
    // Verbatim and device forms are never opened, even under a root.
    let is_special = |p: &str| {
        let p = p.replace('/', "\\");
        p.starts_with(r"\\?\") || p.starts_with(r"\\.\")
    };
    let unified = if cfg!(windows) {
        trimmed.replace('/', "\\")
    } else {
        trimmed.to_string()
    };
    // `absolute` is a string operation (no filesystem access), so this
    // still runs before anything can reach the network.
    let path = std::path::absolute(&unified)
        .map_err(|_| RpcError::invalid("This path cannot be opened."))?;
    let shown = path.to_string_lossy();
    if is_network(&unified) || is_network(&shown) {
        let allowed = !is_special(&unified)
            && !is_special(&shown)
            && allowed_roots.iter().any(|root| is_within(&path, root));
        if !allowed {
            return Err(RpcError::invalid("Network paths cannot be opened."));
        }
    }
    let meta = std::fs::metadata(&path)
        .map_err(|_| RpcError::not_found(format!("{} does not exist.", path.display())))?;
    if meta.is_file() {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
            return Err(RpcError::invalid(
                "Only folders and media, subtitle or playlist files can be opened.",
            ));
        }
    }
    Ok(path)
}

/// Whether `path` (already absolute) is `root` or inside it, comparing
/// resolved paths component by component (case-insensitive on Windows).
fn is_within(path: &Path, root: &Path) -> bool {
    let unify = |p: &Path| {
        let s = p.to_string_lossy().into_owned();
        if cfg!(windows) {
            s.replace('/', "\\").to_lowercase()
        } else {
            s
        }
    };
    let Ok(root) = std::path::absolute(unify(root)) else {
        return false;
    };
    PathBuf::from(unify(path)).starts_with(&root)
}

/// Opens a file or directory with the OS default handler (detached).
pub(crate) fn open_with_os(path: &Path) -> Result<(), RpcError> {
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
        assert!(validate_open_path(&dir.path().display().to_string(), &[]).is_ok());
        let exe = dir.path().join("evil.exe");
        std::fs::write(&exe, b"x").unwrap();
        assert!(validate_open_path(&exe.display().to_string(), &[]).is_err());
        let mp4 = dir.path().join("movie.mp4");
        std::fs::write(&mp4, b"x").unwrap();
        assert!(validate_open_path(&mp4.display().to_string(), &[]).is_ok());
        assert!(validate_open_path("", &[]).is_err());
        assert!(
            validate_open_path(&dir.path().join("missing").display().to_string(), &[]).is_err()
        );
    }

    /// Review round 1: an allowlist, so shell-executable types a blocklist
    /// missed are refused, and network paths never reach the shell.
    #[test]
    fn open_path_allows_only_media_types_and_local_paths() {
        let dir = tempfile::tempdir().unwrap();
        for ext in [
            "url",
            "chm",
            "msc",
            "appref-ms",
            "settingcontent-ms",
            "library-ms",
            "search-ms",
            "exe",
            "lnk",
            "txt",
        ] {
            let f = dir.path().join(format!("x.{ext}"));
            std::fs::write(&f, b"x").unwrap();
            assert!(
                validate_open_path(&f.display().to_string(), &[]).is_err(),
                "{ext}"
            );
        }
        for ext in ["mkv", "ts", "srt", "m3u8", "MP4"] {
            let f = dir.path().join(format!("ok.{ext}"));
            std::fs::write(&f, b"x").unwrap();
            assert!(
                validate_open_path(&f.display().to_string(), &[]).is_ok(),
                "{ext}"
            );
        }
        let mut shapes = vec![r"\\server\share", r"\\?\UNC\server\share", "//server/share"];
        // Review round 2: mixed separators are UNC on Windows too, and the
        // verbatim and device forms never reach the filesystem.
        #[cfg(windows)]
        shapes.extend([
            r"\/localhost\share\x.mp4",
            r"/\localhost\share\x.mp4",
            r"\/localhost/share",
            r"\\?\C:\Windows",
            r"\\.\C:\Windows",
            r"//?/C:/Windows",
            r"\\.\pipe\x",
        ]);
        for unc in shapes {
            let err = validate_open_path(unc, &[]).unwrap_err();
            assert!(err.message.contains("Network paths"), "{unc}: {err:?}");
        }
    }

    /// Review round 3: a downloads or recordings folder on a share (which
    /// `downloads.setDir` accepts) can be opened, with what is inside it;
    /// every other network path is still refused.
    #[cfg(windows)]
    #[test]
    fn open_path_allows_the_configured_folders_on_a_share() {
        let roots = [
            PathBuf::from(r"\\localhost\tsrust-no-share\Downloads"),
            PathBuf::from(r"\\localhost\tsrust-no-share\Rec"),
        ];
        // Past the network check: the share does not exist here, so the
        // answer is "does not exist", not "Network paths".
        for p in [
            r"\\localhost\tsrust-no-share\Downloads",
            r"\\LOCALHOST\Tsrust-No-Share\downloads\Show\e1.mkv",
            r"//localhost/tsrust-no-share/Rec/x.ts",
            r"\/localhost\tsrust-no-share\Rec",
        ] {
            let err = validate_open_path(p, &roots).unwrap_err();
            assert!(err.message.contains("does not exist"), "{p}: {err:?}");
        }
        for p in [
            r"\\localhost\tsrust-no-share",
            r"\\localhost\tsrust-no-share\Downloads2\x.mkv",
            r"\\localhost\tsrust-no-share\Downloads\..\secret\x.mkv",
            r"\\other.invalid\media\Downloads\x.mkv",
            r"\\?\UNC\localhost\tsrust-no-share\Downloads\x.mkv",
            r"\\.\pipe\x",
        ] {
            let err = validate_open_path(p, &roots).unwrap_err();
            assert!(err.message.contains("Network paths"), "{p}: {err:?}");
        }
    }
}
