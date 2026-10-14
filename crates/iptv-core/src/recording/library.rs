//! Recordings in My Videos: scheduled recordings with files, plus loose
//! media files in the recordings folder (manual mpv recordings).
//!
//! Entry ids never carry a path: `r.<recording id>.<hex file name>` for a
//! scheduled recording's file, `f.<hex file name>` for a loose file in the
//! recordings folder. Part ids name the file, not its position, so an id
//! listed before another part was deleted still means the same file. The core turns an id back into a path and checks it is
//! a regular file before playing, revealing or deleting it.

use super::store::{self, RecordingRow};
use super::{RecordingStatus, EVENT_RECORDINGS_UPDATE};
use crate::downloads::naming::is_regular_file;
use crate::error::{CoreError, CoreResult};
use crate::model::{PlayerKind, PlayerSource};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Extensions listed from the recordings folder.
pub const MEDIA_EXTENSIONS: &[&str] = &["ts", "m2ts", "mkv", "mp4"];

/// `recordings.library` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFile {
    pub id: String,
    pub file_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 1-based part number when the recording has several files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part: Option<u32>,
    pub size_bytes: i64,
    /// RFC 3339: the recording's start, or the file's modification time.
    pub date: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<i64>,
    pub file_available: bool,
    /// `recording` while it is still being written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<RecordingStatus>,
}

fn path_key(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn is_media(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MEDIA_EXTENSIONS.iter().any(|m| m.eq_ignore_ascii_case(e)))
}

fn modified_rfc3339(meta: &std::fs::Metadata) -> String {
    meta.modified()
        .ok()
        .map(|t| {
            chrono::DateTime::<chrono::Utc>::from(t)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        })
        .unwrap_or_default()
}

/// Builds the library from recording rows and the folder listing.
pub fn build(rows: &[RecordingRow], dir: &Path) -> Vec<RecordingFile> {
    let mut out = Vec::new();
    let mut known = HashSet::new();
    for row in rows {
        if matches!(row.status, RecordingStatus::Scheduled) || row.parts.is_empty() {
            continue;
        }
        let several = row.parts.len() > 1;
        for (i, part) in row.parts.iter().enumerate() {
            let path = PathBuf::from(part);
            let name = super::file_name(part);
            known.insert(path_key(&path));
            let meta = std::fs::symlink_metadata(&path)
                .ok()
                .filter(|m| m.is_file());
            let duration = match (row.started_at, row.ended_at) {
                (Some(s), Some(e)) if !several && e > s => Some(e - s),
                _ => None,
            };
            out.push(RecordingFile {
                id: part_id(&row.id, &name),
                file_name: name,
                recording_id: Some(row.id.clone()),
                channel_name: Some(row.channel_name.clone()),
                title: row.title.clone(),
                part: several.then_some(i as u32 + 1),
                size_bytes: meta.as_ref().map(|m| m.len() as i64).unwrap_or(0),
                date: super::rfc3339(row.started_at.unwrap_or(row.start_at)),
                duration_seconds: duration,
                file_available: meta.is_some(),
                status: (row.status == RecordingStatus::Recording).then_some(row.status),
            });
        }
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if !meta.is_file() || !is_media(&path) || known.contains(&path_key(&path)) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            out.push(RecordingFile {
                id: format!("f.{}", hex::encode(name.as_bytes())),
                file_name: name,
                recording_id: None,
                channel_name: None,
                title: None,
                part: None,
                size_bytes: meta.len() as i64,
                date: modified_rfc3339(&meta),
                duration_seconds: None,
                file_available: true,
                status: None,
            });
        }
    }
    out.sort_by(|a, b| {
        b.date
            .cmp(&a.date)
            .then_with(|| a.file_name.cmp(&b.file_name))
    });
    out
}

/// `recordings.library`.
pub async fn list(state: &Arc<AppState>) -> CoreResult<Vec<RecordingFile>> {
    let rows = state.db_call(|c| store::recordings(c)).await?;
    let dir = super::dir(state);
    tokio::task::spawn_blocking(move || build(&rows, &dir))
        .await
        .map_err(|e| CoreError::Other(anyhow::anyhow!(e.to_string())))
}

/// What an entry id points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Part {
        row: Box<RecordingRow>,
        index: usize,
        path: PathBuf,
    },
    Loose {
        path: PathBuf,
    },
}

impl Target {
    pub fn path(&self) -> &Path {
        match self {
            Target::Part { path, .. } | Target::Loose { path } => path,
        }
    }
}

/// Entry id of a recording's part file.
pub fn part_id(recording_id: &str, file_name: &str) -> String {
    format!("r.{recording_id}.{}", hex::encode(file_name.as_bytes()))
}

/// Index of the part whose file name is hex-encoded in `key`.
fn part_index(parts: &[String], key: &str) -> Option<usize> {
    let name = String::from_utf8(hex::decode(key).ok()?).ok()?;
    if name.is_empty() {
        return None;
    }
    parts.iter().position(|p| super::file_name(p) == name)
}

/// A loose file name from an `f.` id: one plain path component.
fn loose_name(hex_name: &str) -> CoreResult<String> {
    let bad = || CoreError::invalid("not a recording id");
    let bytes = hex::decode(hex_name).map_err(|_| bad())?;
    let name = String::from_utf8(bytes).map_err(|_| bad())?;
    let p = Path::new(&name);
    let plain = p.components().count() == 1
        && matches!(p.components().next(), Some(std::path::Component::Normal(_)))
        && !name.contains(['/', '\\', ':']);
    if !plain || !is_media(p) {
        return Err(bad());
    }
    Ok(name)
}

/// Resolves an entry id. The file must exist as a regular file.
pub async fn resolve(state: &Arc<AppState>, id: &str) -> CoreResult<Target> {
    let target = locate(state, id).await?;
    if !is_regular_file(target.path()) {
        return Err(CoreError::NotFound(
            "The recording file is missing; it may have been moved or deleted.".into(),
        ));
    }
    Ok(target)
}

/// Resolves an entry id to its path, whether or not the file is there.
async fn locate(state: &Arc<AppState>, id: &str) -> CoreResult<Target> {
    Ok(if let Some(rest) = id.strip_prefix("r.") {
        let (rec, name_key) = rest
            .rsplit_once('.')
            .ok_or_else(|| CoreError::invalid("not a recording id"))?;
        let key = rec.to_string();
        let row = state
            .db_call(move |c| store::recording_by_id(c, &key))
            .await?
            .ok_or_else(|| CoreError::NotFound("This recording no longer exists.".into()))?;
        let index = part_index(&row.parts, name_key)
            .ok_or_else(|| CoreError::NotFound("This recording no longer has that file.".into()))?;
        let path = PathBuf::from(&row.parts[index]);
        Target::Part {
            row: Box::new(row),
            index,
            path,
        }
    } else if let Some(hex_name) = id.strip_prefix("f.") {
        let name = loose_name(hex_name)?;
        Target::Loose {
            path: super::dir(state).join(name),
        }
    } else {
        return Err(CoreError::invalid("not a recording id"));
    })
}

/// Player source for an entry: the path on desktop, `/api/recordings/{id}`
/// on the server.
pub async fn play_source(state: &Arc<AppState>, id: &str) -> CoreResult<PlayerSource> {
    let target = resolve(state, id).await?;
    let title = match &target {
        Target::Part { row, .. } => match &row.title {
            Some(t) => format!("{} - {t}", row.channel_name),
            None => row.channel_name.clone(),
        },
        Target::Loose { path } => path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
    };
    let url = if state.is_desktop {
        target.path().to_string_lossy().into_owned()
    } else {
        format!("/api/recordings/{id}")
    };
    Ok(PlayerSource {
        url,
        kind: PlayerKind::File,
        headers: None,
        title,
        subtitle: None,
        poster_url: None,
        item_ref: None,
        episode_id: None,
        resume_seconds: None,
        is_live: false,
        is_radio: false,
    })
}

/// Opens the folder with the file selected. Desktop only.
pub async fn reveal(state: &Arc<AppState>, id: &str) -> CoreResult<()> {
    if !state.is_desktop {
        return Err(CoreError::Unsupported(
            "Showing files in a folder is only available in the desktop app.".into(),
        ));
    }
    let target = resolve(state, id).await?;
    let path = target.path().to_path_buf();
    let dir = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| super::dir(state));
    crate::downloads::open_folder(&dir, Some(&path))
}

/// Moves an entry's file to the Recycle Bin (deletes it on a server that is
/// not Windows) and forgets it. A recording still being written cannot be
/// deleted.
pub async fn delete(state: &Arc<AppState>, id: &str) -> CoreResult<()> {
    // A part whose file is already gone is only forgotten.
    let target = match locate(state, id).await? {
        t @ Target::Part { .. } => t,
        Target::Loose { .. } => resolve(state, id).await?,
    };
    if let Target::Part { row, .. } = &target {
        if row.status == RecordingStatus::Recording {
            return Err(CoreError::Conflict(
                "Stop this recording before deleting it.".into(),
            ));
        }
    }
    let path = target.path().to_path_buf();
    if is_regular_file(&path) {
        tokio::task::spawn_blocking(move || recycle(&path))
            .await
            .map_err(|e| CoreError::Other(anyhow::anyhow!(e.to_string())))??;
    }
    if let Target::Part { row, path, .. } = target {
        let key = row.id.clone();
        let name = path.to_string_lossy().into_owned();
        state
            .db_call(move |c| {
                let Some(mut row) = store::recording_by_id(c, &key)? else {
                    return Ok(());
                };
                // By path, not position: the list may have changed since.
                row.parts.retain(|p| *p != name);
                if row.parts.is_empty() {
                    store::delete_recording(c, &key)?;
                } else {
                    let bytes = super::total_bytes(&row.parts);
                    store::set_progress(c, &key, &row.parts, bytes)?;
                }
                Ok(())
            })
            .await?;
    }
    state.emit(EVENT_RECORDINGS_UPDATE, serde_json::json!({}));
    Ok(())
}

/// Moves a regular file to the Windows Recycle Bin (no UI, no prompt).
#[cfg(all(windows, target_pointer_width = "64"))]
pub fn recycle(path: &Path) -> CoreResult<()> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    #[repr(C)]
    struct ShFileOpStructW {
        hwnd: isize,
        func: u32,
        from: *const u16,
        to: *const u16,
        flags: u16,
        any_aborted: i32,
        name_mappings: *mut c_void,
        progress_title: *const u16,
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHFileOperationW(op: *mut ShFileOpStructW) -> i32;
    }
    const FO_DELETE: u32 = 3;
    const FOF_SILENT: u16 = 0x0004;
    const FOF_NOCONFIRMATION: u16 = 0x0010;
    const FOF_ALLOWUNDO: u16 = 0x0040;
    const FOF_NOERRORUI: u16 = 0x0400;

    if !path.is_absolute() || !is_regular_file(path) {
        return Err(CoreError::NotFound(
            "The recording file is missing; it may have been moved or deleted.".into(),
        ));
    }
    // Double-NUL-terminated list with one entry.
    let mut from: Vec<u16> = path.as_os_str().encode_wide().collect();
    from.extend([0, 0]);
    let mut op = ShFileOpStructW {
        hwnd: 0,
        func: FO_DELETE,
        from: from.as_ptr(),
        to: std::ptr::null(),
        flags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
        any_aborted: 0,
        name_mappings: std::ptr::null_mut(),
        progress_title: std::ptr::null(),
    };
    // SAFETY: `op` is a valid SHFILEOPSTRUCTW (x64 layout) whose `from`
    // buffer is double-NUL-terminated and outlives the call.
    let rc = unsafe { SHFileOperationW(&mut op) };
    if rc != 0 || op.any_aborted != 0 || path.exists() {
        return Err(CoreError::Io(std::io::Error::other(format!(
            "could not move {} to the Recycle Bin (code {rc})",
            path.display()
        ))));
    }
    Ok(())
}

/// No Recycle Bin outside Windows (a server on Linux or macOS): the file is
/// deleted.
#[cfg(not(all(windows, target_pointer_width = "64")))]
pub fn recycle(path: &Path) -> CoreResult<()> {
    crate::downloads::naming::remove_regular_file(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ContentType, ItemRef};
    use crate::recording::RecordingKind;

    fn row(id: &str, parts: Vec<String>, status: RecordingStatus) -> RecordingRow {
        RecordingRow {
            id: id.into(),
            item_ref: ItemRef::new("s", ContentType::Live, "1"),
            channel_name: "Chan".into(),
            title: Some("Show".into()),
            kind: RecordingKind::Programme,
            start_at: 1_800_000_000,
            end_at: 1_800_003_600,
            padding_before: 1,
            padding_after: 5,
            status,
            error_message: None,
            parts,
            bytes: 0,
            started_at: Some(1_800_000_000),
            ended_at: Some(1_800_003_000),
            engine: Some("mpv".into()),
            created_at: 1,
            rule_id: None,
        }
    }

    #[test]
    fn lists_rows_and_loose_files_once_and_flags_missing_ones() {
        let dir = tempfile::tempdir().unwrap();
        let rec = dir.path().join("Chan - Show - 2027-01-15 0800.ts");
        std::fs::write(&rec, b"abcd").unwrap();
        std::fs::write(dir.path().join("manual-20270101-1200.ts"), b"xy").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"skip").unwrap();
        let gone = dir.path().join("gone.ts").to_string_lossy().into_owned();
        let rows = vec![
            row(
                "a",
                vec![rec.to_string_lossy().into_owned()],
                RecordingStatus::Completed,
            ),
            row("b", vec![gone], RecordingStatus::Completed),
            row("c", vec![], RecordingStatus::Scheduled),
        ];
        let lib = build(&rows, dir.path());
        assert_eq!(lib.len(), 3, "{lib:?}");
        let a = lib
            .iter()
            .find(|f| f.recording_id.as_deref() == Some("a"))
            .unwrap();
        assert_eq!(a.id, part_id("a", "Chan - Show - 2027-01-15 0800.ts"));
        assert!(a.file_available);
        assert_eq!(a.size_bytes, 4);
        assert_eq!(a.duration_seconds, Some(3000));
        let b = lib
            .iter()
            .find(|f| f.id == part_id("b", "gone.ts"))
            .unwrap();
        assert!(!b.file_available);
        let loose = lib.iter().find(|f| f.id.starts_with("f.")).unwrap();
        assert_eq!(loose.file_name, "manual-20270101-1200.ts");
        assert_eq!(loose_name(&loose.id[2..]).unwrap(), loose.file_name);
    }

    #[test]
    fn multi_part_recordings_number_their_files() {
        let dir = tempfile::tempdir().unwrap();
        let p1 = dir.path().join("A.ts");
        let p2 = dir.path().join("A (part 2).ts");
        std::fs::write(&p1, b"1").unwrap();
        std::fs::write(&p2, b"2").unwrap();
        let rows = vec![row(
            "m",
            vec![
                p1.to_string_lossy().into_owned(),
                p2.to_string_lossy().into_owned(),
            ],
            RecordingStatus::Completed,
        )];
        let lib = build(&rows, dir.path());
        assert_eq!(lib.len(), 2);
        assert!(lib.iter().all(|f| f.duration_seconds.is_none()));
        let mut parts: Vec<_> = lib.iter().filter_map(|f| f.part).collect();
        parts.sort_unstable();
        assert_eq!(parts, vec![1, 2]);
    }

    #[test]
    fn part_ids_stay_on_their_file_after_another_part_goes() {
        let parts =
            |names: &[&str]| -> Vec<String> { names.iter().map(|n| format!("/rec/{n}")).collect() };
        let before = parts(&["A.ts", "A (part 2).ts", "A (part 3).ts"]);
        let lib = build(
            &[row("x", before.clone(), RecordingStatus::Completed)],
            Path::new("/nope"),
        );
        let ids: Vec<String> = lib.iter().map(|f| f.id.clone()).collect();
        let key = |id: &str| id.rsplit_once('.').unwrap().1.to_string();
        let id_b = ids
            .iter()
            .find(|i| part_index(&before, &key(i)) == Some(1))
            .unwrap();
        let id_c = ids
            .iter()
            .find(|i| part_index(&before, &key(i)) == Some(2))
            .unwrap();
        // Part A is deleted; ids listed earlier still point at B and C.
        let after = parts(&["A (part 2).ts", "A (part 3).ts"]);
        assert_eq!(part_index(&after, &key(id_b)), Some(0));
        assert_eq!(part_index(&after, &key(id_c)), Some(1));
        // Then B: the stale id of B no longer resolves (no other file is hit).
        let last = parts(&["A (part 3).ts"]);
        assert_eq!(part_index(&last, &key(id_b)), None);
        assert_eq!(part_index(&last, &key(id_c)), Some(0));
        assert_eq!(part_index(&last, "zz"), None);
        assert_eq!(part_index(&last, ""), None);
    }

    #[cfg(not(all(windows, target_pointer_width = "64")))]
    #[test]
    fn without_a_recycle_bin_delete_removes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.ts");
        std::fs::write(&f, b"x").unwrap();
        recycle(&f).unwrap();
        assert!(!f.exists());
    }

    #[test]
    fn loose_ids_cannot_escape_the_folder() {
        for bad in ["../x.ts", "..\\x.ts", "C:\\x.ts", "sub/x.ts", "x.exe", ""] {
            assert!(loose_name(&hex::encode(bad)).is_err(), "{bad}");
        }
        assert!(loose_name("zz").is_err());
        assert_eq!(loose_name(&hex::encode("ok.ts")).unwrap(), "ok.ts");
    }
}
