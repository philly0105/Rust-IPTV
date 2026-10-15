//! `screenshot` module (Run 3 contract C6): player frames saved as files in
//! `dirs::picture_dir()/Tsrust IPTV` (falling back to `data_dir/screenshots`
//! when there is no Pictures folder, or when it cannot be created or written),
//! named `<sanitised title> <YYYY-MM-DD HH-MM-SS>.png` in local time and made
//! unique like the recording files (`name (1).png`, ...). Every command is
//! desktop-only; server mode answers `unsupported`, and the web UI downloads
//! the frame instead.
//!
//! Two ways in: `screenshot.save` writes an image the UI captured (the HTML5
//! player's canvas), `screenshot.mpv` asks the embedded mpv to write the frame
//! it shows. `screenshot.open` and `screenshot.reveal` only ever open files
//! inside the screenshot folders.

pub mod rpc;

use crate::error::{CoreError, CoreResult};
use crate::state::AppState;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine as _;
use chrono::{DateTime, TimeZone};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// Folder created under the user's Pictures folder.
pub const FOLDER_NAME: &str = "Tsrust IPTV";
/// Folder under the data dir used when there is no Pictures folder.
pub const FALLBACK_DIR_NAME: &str = "screenshots";
/// Largest decoded image `screenshot.save` accepts (25 MB).
pub const MAX_SCREENSHOT_BYTES: usize = 25 * 1024 * 1024;
/// File-name stem used when there is no usable title.
pub const DEFAULT_TITLE: &str = "Screenshot";
/// Titles are cut to this many characters before sanitising.
pub const MAX_TITLE_CHARS: usize = 80;
/// `AppState.extensions` key of the folder override ([`set_folder_override`]).
pub const FOLDER_OVERRIDE_KEY: &str = "screenshot.folder";

/// Highest `(n)` suffix tried for a taken file name.
const MAX_UNIQUE_SUFFIX: u32 = 999;

/// How long `screenshot.mpv` keeps waiting for the file after mpv's IPC reply
/// timed out (a very large frame can take longer than the reply timeout).
const MPV_WRITE_GRACE: Duration = Duration::from_secs(10);

/// Standard alphabet; padding optional (some encoders drop it).
const BASE64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// `screenshot.save` / `screenshot.mpv` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotResult {
    /// Absolute path of the saved file.
    pub path: String,
    /// File name only, for the toast.
    pub file_name: String,
}

/// Image format `screenshot.save` accepts (`"png"` / `"jpeg"` on the wire).
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Png,
    Jpeg,
}

impl ImageFormat {
    /// File extension, without the dot.
    pub fn ext(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
        }
    }

    /// Leading bytes every file of this format starts with.
    pub fn magic(self) -> &'static [u8] {
        match self {
            Self::Png => &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A],
            Self::Jpeg => &[0xFF, 0xD8, 0xFF],
        }
    }

    /// True when `bytes` start with this format's magic bytes.
    pub fn matches(self, bytes: &[u8]) -> bool {
        bytes.starts_with(self.magic())
    }

    fn label(self) -> &'static str {
        match self {
            Self::Png => "PNG",
            Self::Jpeg => "JPEG",
        }
    }
}

// ---------------------------------------------------------------------------
// Folder

/// The screenshot folder for a Pictures folder (`None` when the system has
/// none) and a data dir: `<pictures>/Tsrust IPTV`, else
/// `<data_dir>/screenshots`.
pub fn folder_for(picture_dir: Option<PathBuf>, data_dir: &Path) -> PathBuf {
    match picture_dir {
        Some(p) => p.join(FOLDER_NAME),
        None => data_dir.join(FALLBACK_DIR_NAME),
    }
}

/// `<data_dir>/screenshots`: used when the screenshot folder cannot be
/// created or written.
pub fn fallback_folder(state: &AppState) -> PathBuf {
    state.data_dir.join(FALLBACK_DIR_NAME)
}

/// The screenshot folder: the override when one is set, else
/// [`folder_for`] with the system's Pictures folder.
pub fn folder(state: &AppState) -> PathBuf {
    match state.ext::<PathBuf>(FOLDER_OVERRIDE_KEY) {
        Some(dir) => dir.as_ref().clone(),
        None => folder_for(dirs::picture_dir(), &state.data_dir),
    }
}

/// Replaces the screenshot folder for this `AppState`. The hook tests and
/// embedders use so nothing is written to the user's Pictures folder; the
/// app itself never sets it.
pub fn set_folder_override(state: &AppState, dir: PathBuf) {
    state.set_ext(FOLDER_OVERRIDE_KEY, Arc::new(dir));
}

/// Creates the screenshot folder and returns it; when that fails, logs a
/// warning and uses the fallback folder instead. Blocking.
pub fn ensure_folder(state: &AppState) -> CoreResult<PathBuf> {
    let (primary, fallback) = (folder(state), fallback_folder(state));
    in_folder(&primary, &fallback, |_| Ok(()))
        .map(|(dir, ())| dir)
        .map_err(|e| e.into_core("Cannot create the screenshot folder"))
}

/// Why [`in_folder`] failed: the folder(s) tried with their errors.
struct FolderError(Vec<(PathBuf, std::io::Error)>);

impl FolderError {
    fn into_core(self, what: &str) -> CoreError {
        let tried = self
            .0
            .iter()
            .map(|(dir, e)| format!("{} ({e})", dir.display()))
            .collect::<Vec<_>>()
            .join(" or ");
        CoreError::Io(std::io::Error::other(format!("{what} {tried}.")))
    }
}

/// Runs `op` on the created `primary` folder; when creating it or `op` fails,
/// on the created `fallback` folder (unless it is the same folder). Windows'
/// Controlled Folder Access, for one, can refuse writes under Pictures.
fn in_folder<T>(
    primary: &Path,
    fallback: &Path,
    op: impl Fn(&Path) -> std::io::Result<T>,
) -> Result<(PathBuf, T), FolderError> {
    let attempt = |dir: &Path| std::fs::create_dir_all(dir).and_then(|()| op(dir));
    match attempt(primary) {
        Ok(v) => Ok((primary.to_path_buf(), v)),
        Err(e) if primary != fallback => {
            tracing::warn!(
                folder = %primary.display(),
                error = %e,
                "screenshot folder unavailable; using the fallback folder"
            );
            match attempt(fallback) {
                Ok(v) => Ok((fallback.to_path_buf(), v)),
                Err(e2) => Err(FolderError(vec![
                    (primary.to_path_buf(), e),
                    (fallback.to_path_buf(), e2),
                ])),
            }
        }
        Err(e) => Err(FolderError(vec![(primary.to_path_buf(), e)])),
    }
}

// ---------------------------------------------------------------------------
// Naming

/// `<sanitised title> <YYYY-MM-DD HH-MM-SS>.<ext>`. The title is trimmed,
/// cut to [`MAX_TITLE_CHARS`] characters and made safe for Windows file names
/// ([`crate::downloads::naming::sanitize_stem`]); a missing or blank title
/// (or one with nothing but dots, spaces and control characters) becomes
/// [`DEFAULT_TITLE`].
pub fn file_name<Tz: TimeZone>(title: Option<&str>, now: DateTime<Tz>, ext: &str) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let cut: String = title
        .unwrap_or_default()
        .trim()
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect();
    let meaningful = cut
        .chars()
        .any(|c| !(c.is_whitespace() || c.is_control() || c == '.'));
    let stem = if meaningful {
        crate::downloads::naming::sanitize_stem(&cut)
    } else {
        DEFAULT_TITLE.to_string()
    };
    format!("{stem} {}.{ext}", now.format("%Y-%m-%d %H-%M-%S"))
}

/// Creates a new, empty file for `name` in `dir`: `name`, else `stem (1).ext`
/// up to `(999)`. Each candidate is claimed with `create_new`, so two saves in
/// the same second never pick the same name. Blocking.
pub fn create_unique(dir: &Path, name: &str) -> std::io::Result<(PathBuf, File)> {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) => (stem, Some(ext)),
        None => (name, None),
    };
    for i in 0..=MAX_UNIQUE_SUFFIX {
        let candidate = match (i, ext) {
            (0, _) => name.to_string(),
            (i, Some(ext)) => format!("{stem} ({i}).{ext}"),
            (i, None) => format!("{stem} ({i})"),
        };
        let path = dir.join(candidate);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        ErrorKind::AlreadyExists,
        format!("{name} and its numbered copies up to ({MAX_UNIQUE_SUFFIX}) already exist"),
    ))
}

/// Writes `bytes` to a new file named after `name` ([`create_unique`]) in
/// `folder`, or in `fallback` when `folder` cannot be created or written.
/// A partly written file is removed. Blocking.
pub fn write_screenshot(
    folder: &Path,
    fallback: &Path,
    name: &str,
    bytes: &[u8],
) -> CoreResult<PathBuf> {
    let (_, (path, mut file)) = in_folder(folder, fallback, |dir| create_unique(dir, name))
        .map_err(|e| e.into_core("Cannot save the screenshot in"))?;
    if let Err(e) = file.write_all(bytes) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(CoreError::Io(std::io::Error::new(
            e.kind(),
            format!("Cannot write the screenshot {}: {e}", path.display()),
        )));
    }
    Ok(path)
}

fn result_for(path: &Path) -> ScreenshotResult {
    let path = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    ScreenshotResult {
        file_name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.display().to_string(),
    }
}

// ---------------------------------------------------------------------------
// screenshot.save

fn too_large() -> CoreError {
    CoreError::invalid("The screenshot is larger than 25 MB.")
}

fn not_base64() -> CoreError {
    CoreError::invalid("The screenshot is not valid base64 data.")
}

/// Decodes `screenshot.save` data: base64 (standard alphabet, padding
/// optional), optionally as a `data:image/...;base64,` URL. Refuses empty
/// data, more than [`MAX_SCREENSHOT_BYTES`] decoded bytes (checked from the
/// encoded length before decoding, so a huge string is never decoded), and
/// bytes that do not start with `format`'s magic bytes. Every refusal is
/// Invalid.
pub fn decode_image(data_base64: &str, format: ImageFormat) -> CoreResult<Vec<u8>> {
    let mut data = data_base64.trim();
    if data
        .get(..5)
        .is_some_and(|p| p.eq_ignore_ascii_case("data:"))
    {
        let (header, payload) = data[5..].split_once(',').ok_or_else(not_base64)?;
        let header = header.trim().to_ascii_lowercase();
        if !header.starts_with("image/") || !header.ends_with(";base64") {
            return Err(CoreError::invalid(
                "The screenshot data URL must hold a base64-encoded image.",
            ));
        }
        data = payload.trim();
    }
    if data.is_empty() {
        return Err(CoreError::invalid("The screenshot is empty."));
    }
    // Exact decoded size of valid base64 (4 characters carry 3 bytes).
    let digits = data.trim_end_matches('=').len();
    if digits / 4 * 3 + digits % 4 * 3 / 4 > MAX_SCREENSHOT_BYTES {
        return Err(too_large());
    }
    let bytes = BASE64.decode(data).map_err(|_| not_base64())?;
    if bytes.is_empty() {
        return Err(CoreError::invalid("The screenshot is empty."));
    }
    if bytes.len() > MAX_SCREENSHOT_BYTES {
        return Err(too_large());
    }
    if !format.matches(&bytes) {
        return Err(CoreError::invalid(format!(
            "The screenshot data is not a {} image.",
            format.label()
        )));
    }
    Ok(bytes)
}

/// `screenshot.save`: decodes and checks the image ([`decode_image`]) and
/// writes it to a new file in the screenshot folder ([`write_screenshot`]),
/// named with [`file_name`] at the current local time.
pub async fn save(
    state: &AppState,
    data_base64: String,
    format: ImageFormat,
    title: Option<String>,
) -> CoreResult<ScreenshotResult> {
    let (primary, fallback) = (folder(state), fallback_folder(state));
    let path = tokio::task::spawn_blocking(move || {
        let bytes = decode_image(&data_base64, format)?;
        drop(data_base64);
        let name = file_name(title.as_deref(), chrono::Local::now(), format.ext());
        write_screenshot(&primary, &fallback, &name, &bytes)
    })
    .await??;
    tracing::info!(folder = ?path.parent(), "screenshot saved");
    Ok(result_for(&path))
}

// ---------------------------------------------------------------------------
// screenshot.mpv

/// `screenshot.mpv`: the embedded mpv writes the frame it shows to a new
/// `.png` in the screenshot folder. `title` falls back to the playing item's
/// title, then [`DEFAULT_TITLE`]. The file name is claimed first (an empty
/// placeholder mpv overwrites); on any failure the placeholder is removed.
/// Unsupported off Windows; Conflict without a session, with nothing loaded,
/// or without a video frame.
pub async fn mpv(
    state: &AppState,
    title: Option<&str>,
    with_subtitles: bool,
) -> CoreResult<ScreenshotResult> {
    let playing = crate::player::embedded::playing_title(state)?;
    let title = title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .unwrap_or(playing);
    let name = file_name(Some(&title), chrono::Local::now(), ImageFormat::Png.ext());
    let (primary, fallback) = (folder(state), fallback_folder(state));
    let path = tokio::task::spawn_blocking(move || {
        in_folder(&primary, &fallback, |dir| create_unique(dir, &name))
            .map(|(_, (path, _placeholder))| path)
            .map_err(|e| e.into_core("Cannot save the screenshot in"))
    })
    .await??;
    // The placeholder's handle is closed here, before mpv opens the path.
    if let Err(e) = capture(state, &path, with_subtitles).await {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(e);
    }
    tracing::info!(folder = ?path.parent(), "mpv screenshot saved");
    Ok(result_for(&path))
}

async fn capture(state: &AppState, path: &Path, with_subtitles: bool) -> CoreResult<()> {
    match crate::player::embedded::screenshot_to_file(state, path, with_subtitles).await {
        Ok(()) => {}
        Err(CoreError::Timeout(_)) => {
            if !wait_for_file(path, MPV_WRITE_GRACE).await {
                return Err(CoreError::Timeout(
                    "mpv did not save the screenshot in time. Try again.".into(),
                ));
            }
        }
        Err(e) => return Err(e),
    }
    if file_len(path).await == 0 {
        return Err(CoreError::Io(std::io::Error::other(
            "mpv reported the screenshot as saved but wrote no data.",
        )));
    }
    Ok(())
}

async fn file_len(path: &Path) -> u64 {
    tokio::fs::metadata(path)
        .await
        .map(|m| m.len())
        .unwrap_or(0)
}

/// Waits up to `limit` for `path` to hold data whose size stopped changing.
async fn wait_for_file(path: &Path, limit: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + limit;
    let mut last = 0;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let len = file_len(path).await;
        if len > 0 && len == last {
            return true;
        }
        last = len;
    }
    false
}

// ---------------------------------------------------------------------------
// screenshot.open / screenshot.reveal

/// File extensions `screenshot.open` accepts (compared ignoring case).
pub const OPEN_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg"];

/// Folders a screenshot may live in: the screenshot folder and the fallback.
fn roots(state: &AppState) -> Vec<PathBuf> {
    let mut v = vec![folder(state), fallback_folder(state)];
    v.dedup();
    v
}

/// Whether absolute `path` is inside absolute `root`, comparing lexically
/// (no filesystem access; separators unified and case ignored on Windows).
fn lexically_within(path: &Path, root: &Path) -> bool {
    let unify = |p: &Path| {
        let s = p.to_string_lossy().into_owned();
        if cfg!(windows) {
            PathBuf::from(s.replace('/', "\\").to_lowercase())
        } else {
            PathBuf::from(s)
        }
    };
    let root = std::path::absolute(root).unwrap_or_else(|_| root.to_path_buf());
    let (path, root) = (unify(path), unify(&root));
    path != root && path.starts_with(&root)
}

fn outside() -> CoreError {
    CoreError::invalid("Only screenshots in the screenshot folder can be opened.")
}

/// Checks a `screenshot.open` / `screenshot.reveal` path: not empty, a
/// `.png` / `.jpg` / `.jpeg` file inside the screenshot folder or the
/// fallback folder. The path is first checked lexically (after resolving
/// `..`), before any filesystem access, then again after resolving symlinks
/// and junctions (`canonicalize`), so nothing outside the folders passes.
/// Invalid for a refused path, NotFound when it no longer exists. Returns the
/// absolute (non-verbatim) path, which the OS shell can open.
pub fn validate_open_path(state: &AppState, raw: &str) -> CoreResult<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(CoreError::invalid("Choose a screenshot to open."));
    }
    let path = std::path::absolute(raw).map_err(|_| outside())?;
    // A `:` in the name addresses an NTFS alternate data stream.
    if path
        .file_name()
        .is_some_and(|n| n.to_string_lossy().contains(':'))
    {
        return Err(outside());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if !ext.is_some_and(|e| OPEN_EXTENSIONS.contains(&e.as_str())) {
        return Err(CoreError::invalid(
            "Only .png and .jpg screenshots can be opened.",
        ));
    }
    let roots = roots(state);
    if !roots.iter().any(|r| lexically_within(&path, r)) {
        return Err(outside());
    }
    let resolved = match std::fs::canonicalize(&path) {
        Ok(p) => p,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(CoreError::not_found(
                "The screenshot no longer exists. It may have been moved or deleted.",
            ))
        }
        Err(e) => {
            return Err(CoreError::invalid(format!(
                "The screenshot cannot be opened ({e})."
            )))
        }
    };
    let inside = roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .any(|r| resolved != r && resolved.starts_with(&r));
    if !inside {
        return Err(outside());
    }
    if !resolved.is_file() {
        return Err(CoreError::invalid("The screenshot path is not a file."));
    }
    Ok(path)
}

/// `screenshot.reveal`: opens the screenshot folder (creating it), selecting
/// `raw` when given. A given path must pass [`validate_open_path`] (Invalid
/// otherwise); one that no longer exists just opens the folder. A blank path
/// counts as none.
pub async fn reveal(state: &AppState, raw: Option<&str>) -> CoreResult<()> {
    let file = match raw.map(str::trim).filter(|r| !r.is_empty()) {
        Some(raw) => match validate_open_path(state, raw) {
            Ok(file) => Some(file),
            Err(CoreError::NotFound(_)) => None,
            Err(e) => return Err(e),
        },
        None => None,
    };
    match file {
        Some(file) => {
            let dir = file.parent().map(Path::to_path_buf).unwrap_or_default();
            crate::downloads::open_folder(&dir, Some(&file))
        }
        None => {
            let dir = ensure_folder(state)?;
            crate::downloads::open_folder(&dir, None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_serializes_camel_case() {
        let v = serde_json::to_value(ScreenshotResult {
            path: "C:/p/a.png".into(),
            file_name: "a.png".into(),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"path": "C:/p/a.png", "fileName": "a.png"})
        );
    }

    #[test]
    fn decoded_size_is_checked_before_decoding() {
        // Valid base64 alphabet but far too long: refused as too large, not
        // as bad data, which shows the decoder never ran.
        let huge = "A".repeat((MAX_SCREENSHOT_BYTES / 3 + 1) * 4);
        let err = decode_image(&huge, ImageFormat::Png).unwrap_err();
        assert!(err.to_string().contains("larger than 25 MB"), "{err}");
        // Exactly the limit is not refused by the size check.
        let at_limit = "A".repeat(MAX_SCREENSHOT_BYTES / 3 * 4);
        let err = decode_image(&at_limit, ImageFormat::Png).unwrap_err();
        assert!(err.to_string().contains("not a PNG"), "{err}");
    }

    #[test]
    fn data_urls_and_missing_padding_are_accepted() {
        // 10 bytes: not a multiple of 3, so the standard encoding is padded.
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2];
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        assert!(b64.ends_with('='));
        for data in [
            b64.clone(),
            b64.trim_end_matches('=').to_string(),
            format!("data:image/png;base64,{b64}"),
            format!("  DATA:image/png;base64,{b64}\n"),
        ] {
            assert_eq!(decode_image(&data, ImageFormat::Png).unwrap(), png);
        }
        for bad in [
            format!("data:text/plain;base64,{b64}"),
            format!("data:image/png,{b64}"),
            "data:image/png;base64".to_string(),
        ] {
            assert!(decode_image(&bad, ImageFormat::Png).is_err(), "{bad}");
        }
    }

    #[test]
    fn lexical_check_needs_a_path_strictly_inside() {
        let root = std::path::absolute("x/root").unwrap();
        assert!(lexically_within(&root.join("a.png"), &root));
        assert!(!lexically_within(&root, &root));
        assert!(!lexically_within(
            &std::path::absolute("x/root2/a.png").unwrap(),
            &root
        ));
    }
}
