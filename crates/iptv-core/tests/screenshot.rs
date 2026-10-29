//! `screenshot.*` (Run 3 C6): file naming and uniqueness, the folder and its
//! fallback, `screenshot.save` validation through the router, the
//! `screenshot.open` / `screenshot.reveal` path checks, and the mpv command.
//!
//! Every test points the screenshot folder at a temp dir before anything
//! runs, so nothing is written to the real Pictures folder. No test opens a
//! file or folder in the OS shell: `screenshot.open` and `screenshot.reveal`
//! are only dispatched with paths they refuse, and paths that pass are
//! checked by calling `validate_open_path` directly.

use base64::Engine as _;
use chrono::TimeZone;
use iptv_core::error::RpcErrorCode;
use iptv_core::player::embedded;
use iptv_core::rpc::RpcRouter;
use iptv_core::screenshot::{self, ImageFormat, MAX_SCREENSHOT_BYTES};
use iptv_core::{AppState, CoreError, NoopSink};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// A real 1x1 PNG.
const PNG_B64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/// JPEG magic bytes and a few more (only the magic is checked).
const JPEG: &[u8] = &[
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00,
];

fn png() -> Vec<u8> {
    b64().decode(PNG_B64).unwrap()
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    screenshot::rpc::register(&mut r);
    r
}

struct Ctx {
    _data: tempfile::TempDir,
    shots: tempfile::TempDir,
    state: Arc<AppState>,
    r: RpcRouter,
}

impl Ctx {
    async fn new(is_desktop: bool) -> Self {
        let data = tempfile::tempdir().unwrap();
        let shots = tempfile::tempdir().unwrap();
        let state = AppState::new(data.path().to_path_buf(), Arc::new(NoopSink), is_desktop)
            .await
            .unwrap();
        // First, before any command: never the real Pictures folder.
        screenshot::set_folder_override(&state, shots.path().to_path_buf());
        Self {
            _data: data,
            shots,
            state,
            r: router(),
        }
    }

    fn dir(&self) -> &Path {
        self.shots.path()
    }

    async fn call(&self, cmd: &str, args: Value) -> Result<Value, iptv_core::RpcError> {
        self.r.dispatch(Arc::clone(&self.state), cmd, args).await
    }

    async fn err(&self, cmd: &str, args: Value) -> iptv_core::RpcError {
        match self.call(cmd, args).await {
            Ok(v) => panic!("{cmd} should fail, got {v}"),
            Err(e) => e,
        }
    }

    /// Nothing in the screenshot folder, and no fallback folder.
    fn assert_nothing_written(&self) {
        assert_eq!(names(self.dir()), Vec::<String>::new());
        assert!(!screenshot::fallback_folder(&self.state).exists());
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

fn fixed_time() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc.with_ymd_and_hms(2026, 10, 14, 9, 5, 7).unwrap()
}

/// Embedded mpv runs on Windows and macOS: elsewhere `screenshot.mpv` is Unsupported.
fn on_windows(code: RpcErrorCode) -> RpcErrorCode {
    if cfg!(any(windows, target_os = "macos")) {
        code
    } else {
        RpcErrorCode::Unsupported
    }
}

// ---------------------------------------------------------------------------
// Naming

#[test]
fn file_names_are_sanitised_and_timestamped() {
    let t = fixed_time();
    let name = |title: Option<&str>| screenshot::file_name(title, t, "png");
    assert_eq!(name(Some("Big Game")), "Big Game 2026-10-14 09-05-07.png");
    assert_eq!(
        screenshot::file_name(Some("  Big Game  "), t, "jpg"),
        "Big Game 2026-10-14 09-05-07.jpg"
    );
    // Windows-invalid characters and control characters.
    assert_eq!(
        name(Some(r#"a<b>c:d"e/f\g|h?i*j"#)),
        "a_b_c_d_e_f_g_h_i_j 2026-10-14 09-05-07.png"
    );
    assert_eq!(
        name(Some("News\u{0}\u{7}\tNow\r\n")),
        "News Now 2026-10-14 09-05-07.png"
    );
    // Missing, empty, blank, and nothing-but-dots titles.
    for title in [None, Some(""), Some("   "), Some(" . .. \u{1} ")] {
        assert_eq!(
            name(title),
            "Screenshot 2026-10-14 09-05-07.png",
            "{title:?}"
        );
    }
    // Cut to 80 characters (counted in chars, not bytes).
    let long = "x".repeat(120);
    assert_eq!(
        name(Some(&long)),
        format!("{} 2026-10-14 09-05-07.png", "x".repeat(80))
    );
    let wide = "é".repeat(100);
    assert_eq!(
        name(Some(&wide)),
        format!("{} 2026-10-14 09-05-07.png", "é".repeat(80))
    );
    // Reserved device names get a prefix; trailing dots go.
    assert_eq!(name(Some("CON")), "_CON 2026-10-14 09-05-07.png");
    assert_eq!(name(Some("nul")), "_nul 2026-10-14 09-05-07.png");
    assert_eq!(name(Some("Live...")), "Live 2026-10-14 09-05-07.png");
    // The wall time of the given zone (the app passes local time).
    let east = chrono::FixedOffset::east_opt(2 * 3600)
        .unwrap()
        .with_ymd_and_hms(2026, 12, 31, 23, 59, 59)
        .unwrap();
    assert_eq!(
        screenshot::file_name(Some("x"), east, "jpg"),
        "x 2026-12-31 23-59-59.jpg"
    );
    assert_eq!(ImageFormat::Png.ext(), "png");
    assert_eq!(ImageFormat::Jpeg.ext(), "jpg");
}

#[test]
fn same_second_saves_get_numbered_names() {
    let dir = tempfile::tempdir().unwrap();
    let name = screenshot::file_name(Some("Match"), fixed_time(), "png");
    let bytes = png();
    let paths: Vec<PathBuf> = (0..3)
        .map(|_| screenshot::write_screenshot(dir.path(), dir.path(), &name, &bytes).unwrap())
        .collect();
    let got: Vec<String> = paths
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        got,
        [
            "Match 2026-10-14 09-05-07.png",
            "Match 2026-10-14 09-05-07 (1).png",
            "Match 2026-10-14 09-05-07 (2).png",
        ]
    );
    for p in &paths {
        assert_eq!(std::fs::read(p).unwrap(), bytes);
    }

    // Concurrent saves of one name never share a file.
    let race = tempfile::tempdir().unwrap();
    let threads: Vec<_> = (0..8u8)
        .map(|i| {
            let dir = race.path().to_path_buf();
            let name = name.clone();
            std::thread::spawn(move || {
                let mut bytes = png();
                bytes.push(i);
                screenshot::write_screenshot(&dir, &dir, &name, &bytes).unwrap()
            })
        })
        .collect();
    let mut written: Vec<PathBuf> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    written.sort();
    written.dedup();
    assert_eq!(written.len(), 8);
    assert_eq!(names(race.path()).len(), 8);
}

// ---------------------------------------------------------------------------
// Folder

#[tokio::test]
async fn folder_falls_back_and_the_override_wins() {
    let data = tempfile::tempdir().unwrap();
    let pics = tempfile::tempdir().unwrap();
    assert_eq!(
        screenshot::folder_for(None, data.path()),
        data.path().join("screenshots")
    );
    assert_eq!(
        screenshot::folder_for(Some(pics.path().to_path_buf()), data.path()),
        pics.path().join("Tsrust IPTV")
    );

    let state = AppState::new(data.path().to_path_buf(), Arc::new(NoopSink), true)
        .await
        .unwrap();
    // No override: the system Pictures folder (only computed, never created).
    assert_eq!(
        screenshot::folder(&state),
        screenshot::folder_for(dirs::picture_dir(), &state.data_dir)
    );
    assert_eq!(
        screenshot::fallback_folder(&state),
        state.data_dir.join("screenshots")
    );
    let custom = pics.path().join("custom");
    screenshot::set_folder_override(&state, custom.clone());
    assert_eq!(screenshot::folder(&state), custom);
    assert_eq!(screenshot::ensure_folder(&state).unwrap(), custom);
    assert!(custom.is_dir());

    // A folder that cannot be created (its parent is a file): the fallback.
    let blocker = pics.path().join("not-a-dir");
    std::fs::write(&blocker, b"x").unwrap();
    screenshot::set_folder_override(&state, blocker.join("shots"));
    let fallback = screenshot::fallback_folder(&state);
    assert_eq!(screenshot::ensure_folder(&state).unwrap(), fallback);
    assert!(fallback.is_dir());
    let saved =
        screenshot::write_screenshot(&blocker.join("shots"), &fallback, "a.png", &png()).unwrap();
    assert_eq!(saved, fallback.join("a.png"));
    // Both unusable: an io error naming the folders.
    let err = screenshot::write_screenshot(&blocker.join("x"), &blocker.join("y"), "a.png", &png())
        .unwrap_err();
    assert!(matches!(err, CoreError::Io(_)), "{err:?}");
    let msg = err.to_string();
    assert!(msg.contains("Cannot save the screenshot in"), "{msg}");
    assert!(
        msg.contains(&blocker.join("y").display().to_string()),
        "{msg}"
    );
}

// ---------------------------------------------------------------------------
// screenshot.save

#[tokio::test]
async fn save_writes_the_exact_bytes_into_the_folder() {
    let c = Ctx::new(true).await;
    let v = c
        .call(
            "screenshot.save",
            json!({"dataBase64": PNG_B64, "format": "png", "title": "Late Show: Live"}),
        )
        .await
        .unwrap();
    let obj = v.as_object().unwrap();
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, ["fileName", "path"], "{v}");
    let file_name = v["fileName"].as_str().unwrap();
    assert!(
        file_name.starts_with("Late Show_ Live ") && file_name.ends_with(".png"),
        "{file_name}"
    );
    let path = PathBuf::from(v["path"].as_str().unwrap());
    assert!(path.is_absolute(), "{}", path.display());
    assert_eq!(path.file_name().unwrap().to_string_lossy(), file_name);
    assert_eq!(
        std::fs::canonicalize(path.parent().unwrap()).unwrap(),
        std::fs::canonicalize(c.dir()).unwrap()
    );
    assert_eq!(std::fs::read(&path).unwrap(), png());

    // JPEG as a data URL, no title.
    let jpeg_url = format!("data:image/jpeg;base64,{}", b64().encode(JPEG));
    let v = c
        .call(
            "screenshot.save",
            json!({"dataBase64": jpeg_url, "format": "jpeg"}),
        )
        .await
        .unwrap();
    let name = v["fileName"].as_str().unwrap();
    assert!(
        name.starts_with("Screenshot ") && name.ends_with(".jpg"),
        "{name}"
    );
    assert_eq!(std::fs::read(v["path"].as_str().unwrap()).unwrap(), JPEG);

    // The same title again never overwrites.
    let again = c
        .call(
            "screenshot.save",
            json!({"dataBase64": PNG_B64, "format": "png", "title": "Late Show: Live"}),
        )
        .await
        .unwrap();
    assert_ne!(again["path"], json!(path.display().to_string()));
    assert_eq!(names(c.dir()).len(), 3);
    assert!(!screenshot::fallback_folder(&c.state).exists());
}

#[tokio::test]
async fn save_refuses_bad_data_and_writes_nothing() {
    let c = Ctx::new(true).await;
    let mut too_large = png();
    too_large.resize(MAX_SCREENSHOT_BYTES + 1, 0);
    let too_large = b64().encode(&too_large);
    let cases: Vec<(Value, &str)> = vec![
        (
            json!({"dataBase64": "not base64!!", "format": "png"}),
            "not valid base64",
        ),
        (
            json!({"dataBase64": "iVBORw0KGgo*AAAA", "format": "png"}),
            "not valid base64",
        ),
        // PNG bytes sent as JPEG and the other way round.
        (
            json!({"dataBase64": PNG_B64, "format": "jpeg"}),
            "not a JPEG image",
        ),
        (
            json!({"dataBase64": b64().encode(JPEG), "format": "png"}),
            "not a PNG image",
        ),
        (
            json!({"dataBase64": b64().encode(b"GIF89a....."), "format": "png"}),
            "not a PNG image",
        ),
        (
            json!({"dataBase64": too_large, "format": "png"}),
            "larger than 25 MB",
        ),
        (json!({"dataBase64": "", "format": "png"}), "empty"),
        (json!({"dataBase64": "  \n ", "format": "png"}), "empty"),
        (
            json!({"dataBase64": "data:image/png;base64,", "format": "png"}),
            "empty",
        ),
        (
            json!({"dataBase64": format!("data:text/html;base64,{PNG_B64}"), "format": "png"}),
            "data URL",
        ),
        (
            json!({"dataBase64": PNG_B64, "format": "gif"}),
            "unknown variant",
        ),
        (
            json!({"dataBase64": PNG_B64, "format": "PNG"}),
            "unknown variant",
        ),
        (json!({"format": "png"}), "dataBase64"),
        (json!({"dataBase64": PNG_B64}), "format"),
    ];
    for (args, needle) in cases {
        let err = c.err("screenshot.save", args.clone()).await;
        let shown = args.to_string();
        let shown = &shown[..shown.len().min(120)];
        assert_eq!(err.code, RpcErrorCode::Invalid, "{shown}: {err:?}");
        assert!(err.message.contains(needle), "{shown}: {}", err.message);
    }
    c.assert_nothing_written();
}

#[tokio::test]
async fn server_mode_answers_unsupported_for_every_command() {
    let c = Ctx::new(false).await;
    // Args that are well formed; the open and reveal paths would be refused
    // anyway, so even a broken desktop check could not launch the shell.
    let missing = c.dir().join("missing.png").display().to_string();
    let outside = std::env::temp_dir().join("x.exe").display().to_string();
    for (cmd, args) in [
        (
            "screenshot.save",
            json!({"dataBase64": PNG_B64, "format": "png", "title": "t"}),
        ),
        ("screenshot.mpv", Value::Null),
        (
            "screenshot.mpv",
            json!({"title": "t", "withSubtitles": false}),
        ),
        ("screenshot.open", json!({"path": missing})),
        ("screenshot.reveal", json!({"path": outside})),
        // Malformed or missing args: the desktop check comes first, so they
        // are unsupported too, never invalid.
        ("screenshot.save", json!({})),
        ("screenshot.save", Value::Null),
        (
            "screenshot.save",
            json!({"dataBase64": PNG_B64, "format": "gif"}),
        ),
        ("screenshot.save", json!("not an object")),
        ("screenshot.mpv", json!({"withSubtitles": "yes"})),
        ("screenshot.open", json!({})),
        ("screenshot.open", Value::Null),
        ("screenshot.reveal", json!({"path": 5})),
        ("screenshot.reveal", json!([1, 2])),
    ] {
        let err = c.err(cmd, args.clone()).await;
        assert_eq!(err.code, RpcErrorCode::Unsupported, "{cmd} {args}: {err:?}");
        assert!(
            err.message.contains("desktop app"),
            "{cmd} {args}: {}",
            err.message
        );
    }
    c.assert_nothing_written();
}

#[tokio::test]
async fn desktop_args_are_still_checked() {
    let c = Ctx::new(true).await;
    for (cmd, args, needle) in [
        ("screenshot.save", json!({}), "dataBase64"),
        ("screenshot.save", Value::Null, "dataBase64"),
        (
            "screenshot.save",
            json!("not an object"),
            "invalid arguments",
        ),
        (
            "screenshot.mpv",
            json!({"withSubtitles": "yes"}),
            "invalid type",
        ),
        ("screenshot.open", json!({}), "path"),
        ("screenshot.open", Value::Null, "path"),
        ("screenshot.reveal", json!({"path": 5}), "invalid type"),
    ] {
        let err = c.err(cmd, args.clone()).await;
        assert_eq!(err.code, RpcErrorCode::Invalid, "{cmd} {args}: {err:?}");
        assert!(
            err.message
                .starts_with(&format!("invalid arguments for {cmd}: ")),
            "{cmd} {args}: {}",
            err.message
        );
        assert!(
            err.message.contains(needle),
            "{cmd} {args}: {}",
            err.message
        );
    }
    c.assert_nothing_written();
}

// ---------------------------------------------------------------------------
// screenshot.open / screenshot.reveal

#[tokio::test]
async fn open_accepts_only_screenshots_inside_the_folder() {
    let c = Ctx::new(true).await;
    let dir = c.dir();
    std::fs::create_dir(dir.join("sub")).unwrap();
    std::fs::create_dir(dir.join("folder.png")).unwrap();
    let good = ["a.png", "b.jpg", "C.JPEG", "d.Jpg", "sub/e.png"];
    for f in good {
        std::fs::write(dir.join(f), b"x").unwrap();
    }
    let bad_ext = [
        "evil.exe",
        "notes.txt",
        "link.lnk",
        "noext",
        "a.png.exe",
        "page.url",
    ];
    for f in bad_ext {
        std::fs::write(dir.join(f), b"x").unwrap();
    }
    let other = tempfile::tempdir().unwrap();
    std::fs::write(other.path().join("x.png"), b"x").unwrap();

    // Passing paths: checked directly, never dispatched (that would open them).
    for f in good {
        let raw = dir.join(f).display().to_string();
        let ok = screenshot::validate_open_path(&c.state, &raw).unwrap();
        assert!(ok.is_absolute(), "{}", ok.display());
        assert!(
            !ok.display().to_string().starts_with(r"\\?\"),
            "{}",
            ok.display()
        );
        assert_eq!(
            std::fs::canonicalize(&ok).unwrap(),
            std::fs::canonicalize(dir.join(f)).unwrap()
        );
    }
    // Surrounding whitespace is ignored.
    let padded = format!("  {}  ", dir.join("a.png").display());
    assert!(screenshot::validate_open_path(&c.state, &padded).is_ok());

    let other_name = other
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let mut refused: Vec<(String, &str)> = vec![
        (String::new(), "Choose a screenshot"),
        ("   ".into(), "Choose a screenshot"),
        (
            other.path().join("x.png").display().to_string(),
            "screenshot folder",
        ),
        // `..` out of the folder into a sibling temp dir.
        (
            dir.join("..")
                .join(&other_name)
                .join("x.png")
                .display()
                .to_string(),
            "screenshot folder",
        ),
        (
            format!("{}/sub/../../{other_name}/x.png", dir.display()),
            "screenshot folder",
        ),
        // Relative paths resolve against the working directory.
        ("a.png".into(), "screenshot folder"),
        // A folder named like an image.
        (dir.join("folder.png").display().to_string(), "not a file"),
    ];
    for f in bad_ext {
        refused.push((dir.join(f).display().to_string(), ".png and .jpg"));
    }
    if cfg!(windows) {
        // An alternate data stream of a file inside the folder.
        refused.push((
            format!("{}:hidden.png", dir.join("evil.exe").display()),
            "screenshot folder",
        ));
        refused.push((r"\\server\share\x.png".into(), "screenshot folder"));
        refused.push((
            format!(r"\\?\{}", dir.join("a.png").display()),
            "screenshot folder",
        ));
    }
    for (raw, needle) in &refused {
        let err = screenshot::validate_open_path(&c.state, raw).unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{raw}: {err:?}");
        assert!(err.to_string().contains(needle), "{raw}: {err}");
        // Through the router: refused before the shell is involved.
        let err = c.err("screenshot.open", json!({"path": raw})).await;
        assert_eq!(err.code, RpcErrorCode::Invalid, "{raw}: {err:?}");
    }

    // A screenshot that is gone: not_found.
    let missing = dir.join("gone.png").display().to_string();
    let err = screenshot::validate_open_path(&c.state, &missing).unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
    let err = c.err("screenshot.open", json!({"path": missing})).await;
    assert_eq!(err.code, RpcErrorCode::NotFound, "{err:?}");
    assert!(err.message.contains("no longer exists"), "{}", err.message);

    // The fallback folder counts as inside too.
    let fallback = screenshot::fallback_folder(&c.state);
    std::fs::create_dir_all(&fallback).unwrap();
    std::fs::write(fallback.join("f.png"), b"x").unwrap();
    let raw = fallback.join("f.png").display().to_string();
    assert!(screenshot::validate_open_path(&c.state, &raw).is_ok());

    // A symlink inside the folder that points outside it (when this
    // machine allows creating one).
    let link = dir.join("link.png");
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(other.path().join("x.png"), &link);
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(other.path().join("x.png"), &link);
    match linked {
        Ok(()) => {
            let err =
                screenshot::validate_open_path(&c.state, &link.display().to_string()).unwrap_err();
            assert!(err.to_string().contains("screenshot folder"), "{err}");
        }
        Err(e) => eprintln!("skipping the symlink case: {e}"),
    }

    // A directory junction (no privilege needed) inside the folder that
    // points outside it: lexically inside, refused once resolved.
    #[cfg(windows)]
    {
        let junction = dir.join("junction");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(other.path())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if made && junction.join("x.png").is_file() {
            let raw = junction.join("x.png").display().to_string();
            let err = screenshot::validate_open_path(&c.state, &raw).unwrap_err();
            assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
            assert!(err.to_string().contains("screenshot folder"), "{err}");
            let err = c.err("screenshot.open", json!({ "path": raw })).await;
            assert_eq!(err.code, RpcErrorCode::Invalid, "{err:?}");
        } else {
            eprintln!("skipping the junction case: mklink /J failed");
        }
    }
}

#[tokio::test]
async fn reveal_refuses_paths_outside_the_folder() {
    let c = Ctx::new(true).await;
    std::fs::write(c.dir().join("evil.exe"), b"x").unwrap();
    let other = tempfile::tempdir().unwrap();
    std::fs::write(other.path().join("x.png"), b"x").unwrap();
    let other_name = other
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    for raw in [
        other.path().join("x.png").display().to_string(),
        c.dir().join("evil.exe").display().to_string(),
        c.dir()
            .join("..")
            .join(&other_name)
            .join("x.png")
            .display()
            .to_string(),
    ] {
        let err = c.err("screenshot.reveal", json!({"path": raw})).await;
        assert_eq!(err.code, RpcErrorCode::Invalid, "{raw}: {err:?}");
    }
}

// ---------------------------------------------------------------------------
// screenshot.mpv

#[test]
fn mpv_screenshot_command_and_the_unchanged_allowlist() {
    let p = Path::new(r"C:\Pictures\Tsrust IPTV\Show, Live 2026-10-14 09-05-07.png");
    let shown = p.display().to_string();
    assert_eq!(
        embedded::screenshot_command(p, true),
        vec![
            json!("screenshot-to-file"),
            json!(shown),
            json!("subtitles")
        ]
    );
    assert_eq!(
        embedded::screenshot_command(p, false),
        vec![json!("screenshot-to-file"), json!(shown), json!("video")]
    );
    // mpv.command still refuses it, in every shape.
    for cmd in [
        vec![json!("screenshot-to-file"), json!("C:/x.png")],
        vec![
            json!("screenshot-to-file"),
            json!("C:/x.png"),
            json!("video"),
        ],
        vec![
            json!("async"),
            json!("screenshot-to-file"),
            json!("C:/x.png"),
        ],
        vec![json!("screenshot"), json!("video")],
    ] {
        assert!(embedded::validate_command(&cmd).is_err(), "{cmd:?}");
    }
}

#[tokio::test]
async fn mpv_without_a_session_is_a_conflict() {
    let c = Ctx::new(true).await;
    for args in [
        Value::Null,
        json!({}),
        json!({"title": "Match", "withSubtitles": false}),
    ] {
        let err = c.err("screenshot.mpv", args.clone()).await;
        assert_eq!(
            err.code,
            on_windows(RpcErrorCode::Conflict),
            "{args}: {err:?}"
        );
        if cfg!(any(windows, target_os = "macos")) {
            assert!(err.message.contains("not attached"), "{}", err.message);
        }
    }
    c.assert_nothing_written();
}

// ---------------------------------------------------------------------------
// Real mpv (Windows; skipped with a note when no mpv is detectable)

#[cfg(windows)]
mod real_mpv {
    use super::*;
    use iptv_core::player::{self, Bounds, ChildWindowFactory};
    use iptv_core::CoreResult;
    use std::time::{Duration, Instant};

    /// Hands mpv a dummy HWND (video output is null).
    struct FakeFactory;

    impl ChildWindowFactory for FakeFactory {
        fn create(&self, _b: Bounds) -> CoreResult<isize> {
            Ok(0)
        }
        fn set_bounds(&self, _hwnd: isize, _b: Bounds) -> CoreResult<()> {
            Ok(())
        }
        fn destroy(&self, _hwnd: isize) -> CoreResult<()> {
            Ok(())
        }
    }

    /// Encodes a lavfi source to `out` with mpv itself.
    fn encode(mpv: &str, source: &str, out: &Path) -> bool {
        std::process::Command::new(mpv)
            .args(["--no-config", source])
            .arg(format!("--o={}", out.display()))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
            && out.is_file()
    }

    /// Loads `clip` and waits until it plays with its tracks known.
    async fn load(c: &Ctx, r: &RpcRouter, clip: &Path, title: &str) {
        let src = json!({
            "url": clip.display().to_string(),
            "kind": "file", "title": title, "isLive": false, "isRadio": false
        });
        r.dispatch(Arc::clone(&c.state), "mpv.load", json!({ "source": src }))
            .await
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let st = r
                .dispatch(Arc::clone(&c.state), "mpv.state", Value::Null)
                .await
                .unwrap();
            let playing = st["loaded"] == json!(true)
                && st["timePos"].as_f64().unwrap_or(0.0) >= 0.5
                && st["tracks"].as_array().is_some_and(|t| !t.is_empty());
            if playing {
                return;
            }
            assert!(Instant::now() < deadline, "{title} did not start: {st}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mpv_screenshot_end_to_end_with_real_mpv() {
        let c = Ctx::new(true).await;
        let Some(mpv) = player::detect(&c.state.settings_snapshot()).mpv_path else {
            eprintln!("skipping: no mpv found (put one in vendor/mpv or on PATH)");
            return;
        };
        let clips = tempfile::tempdir().unwrap();
        let video = clips.path().join("video.ts");
        let audio = clips.path().join("audio.ts");
        if !encode(
            &mpv,
            "av://lavfi:testsrc=duration=30:size=160x120:rate=10",
            &video,
        ) || !encode(&mpv, "av://lavfi:sine=duration=30", &audio)
        {
            eprintln!("skipping: this mpv build cannot encode the test clips");
            return;
        }
        c.state.settings.write().mpv_args = "--vo=null --ao=null".into();
        player::set_window_factory(&c.state, Arc::new(FakeFactory));
        let mut r = router();
        player::rpc::register(&mut r);
        let state = || Arc::clone(&c.state);
        r.dispatch(
            state(),
            "mpv.attach",
            json!({"bounds": {"x": 0, "y": 0, "width": 320, "height": 180}}),
        )
        .await
        .unwrap();

        // Attached, nothing loaded: conflict, nothing written.
        let err = r
            .dispatch(state(), "screenshot.mpv", Value::Null)
            .await
            .unwrap_err();
        assert_eq!(err.code, RpcErrorCode::Conflict, "{err:?}");
        assert!(
            err.message.contains("Nothing is playing"),
            "{}",
            err.message
        );
        c.assert_nothing_written();

        // The frame on screen, named after the playing item.
        load(&c, &r, &video, "Test: Pattern").await;
        let shot = r
            .dispatch(state(), "screenshot.mpv", Value::Null)
            .await
            .unwrap();
        let name = shot["fileName"].as_str().unwrap();
        assert!(
            name.starts_with("Test_ Pattern ") && name.ends_with(".png"),
            "{shot}"
        );
        let path = PathBuf::from(shot["path"].as_str().unwrap());
        assert_eq!(
            std::fs::canonicalize(path.parent().unwrap()).unwrap(),
            std::fs::canonicalize(c.dir()).unwrap()
        );
        let bytes = std::fs::read(&path).unwrap();
        assert!(ImageFormat::Png.matches(&bytes), "not a PNG");
        assert!(bytes.len() > 100, "{} bytes", bytes.len());
        // The UI may open what it got back.
        assert!(screenshot::validate_open_path(&c.state, &path.display().to_string()).is_ok());

        // A given title wins; the bare video frame works too; nothing is
        // overwritten.
        let custom = r
            .dispatch(
                state(),
                "screenshot.mpv",
                json!({"title": "Custom", "withSubtitles": false}),
            )
            .await
            .unwrap();
        assert!(
            custom["fileName"].as_str().unwrap().starts_with("Custom "),
            "{custom}"
        );
        let again = r
            .dispatch(state(), "screenshot.mpv", json!({"title": "Custom"}))
            .await
            .unwrap();
        assert_ne!(again["path"], custom["path"]);
        assert_eq!(names(c.dir()).len(), 3);
        for n in names(c.dir()) {
            let b = std::fs::read(c.dir().join(&n)).unwrap();
            assert!(ImageFormat::Png.matches(&b), "{n} is not a PNG");
        }

        // Audio only: no frame to capture, and no placeholder left behind.
        load(&c, &r, &audio, "Radio").await;
        let err = r
            .dispatch(state(), "screenshot.mpv", Value::Null)
            .await
            .unwrap_err();
        assert_eq!(err.code, RpcErrorCode::Conflict, "{err:?}");
        assert!(err.message.contains("no video frame"), "{}", err.message);
        assert_eq!(names(c.dir()).len(), 3);

        r.dispatch(state(), "mpv.detach", Value::Null)
            .await
            .unwrap();
        let err = r
            .dispatch(state(), "screenshot.mpv", Value::Null)
            .await
            .unwrap_err();
        assert_eq!(err.code, RpcErrorCode::Conflict, "{err:?}");
    }
}
