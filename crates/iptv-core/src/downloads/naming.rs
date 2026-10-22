//! File naming and destination reservation.
//!
//! Policy (old app `docs/architecture/download-manager.md`, "Destination
//! collision policy"):
//! - existing files are never overwritten, inspected, or deleted;
//! - a new transfer atomically reserves a free numbered `<name>.part`
//!   (`create_new`) while the final path stays absent;
//! - completion moves the `.part` to the final path without overwriting; when
//!   the final path got occupied meanwhile, the next free numbered name wins.

use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

/// Suffix appended to the final path while a transfer is in progress.
pub const PART_SUFFIX: &str = ".part";
/// Extension used when neither the hint nor the URL carries one.
pub const DEFAULT_EXTENSION: &str = "mp4";
/// Extensions a download may keep. Anything else is saved as `.bin`, so a
/// download can never become an executable, script, or HTML page on disk
/// (or be served as one by the server's `/api/files`).
pub const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mkv", "ts", "m3u8", "avi", "mov", "webm", "mpg", "mpeg", "wmv", "flv", "mp3",
    "aac", "flac", "m4a", "ogg", "opus", "wav", "srt", "vtt", "jpg", "png",
];
/// Extension used for downloads whose extension is not in [`MEDIA_EXTENSIONS`].
pub const FALLBACK_EXTENSION: &str = "bin";
/// Stem length cap in characters. Leaves room for ` (999)`, the extension, and
/// `.part` inside the 255-character component limit of NTFS and ext4.
pub const MAX_STEM_CHARS: usize = 150;
/// Stem length cap in UTF-8 bytes. ext4 limits a name to 255 bytes and NTFS
/// to 255 UTF-16 units (never more than the UTF-8 byte count), so 200 bytes
/// plus ` (10000)`, a dot, an 8-character extension and `.part` always fit:
/// 150 emoji or CJK characters would not.
pub const MAX_STEM_BYTES: usize = 200;
/// Highest numbered suffix tried before giving up.
const MAX_SUFFIX: u32 = 10_000;

/// Device names Windows reserves in every directory, with or without extension.
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "COM¹", "COM²", "COM³", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6",
    "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³", "CONIN$", "CONOUT$",
];

/// Makes `raw` safe as a file-name stem on Windows (and therefore everywhere):
/// replaces `<>:"/\|?*` and control characters with `_`, collapses whitespace,
/// strips trailing dots and spaces, prefixes reserved device names with `_`,
/// and caps the length. Never returns an empty string.
pub fn sanitize_stem(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_space = false;
    for c in raw.chars() {
        let c = match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => ' ',
            c => c,
        };
        if c.is_whitespace() {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    let mut s: String = out
        .trim()
        .trim_end_matches(['.', ' '])
        .trim_start_matches(' ')
        .chars()
        .take(MAX_STEM_CHARS)
        .scan(0usize, |bytes, c| {
            *bytes += c.len_utf8();
            (*bytes <= MAX_STEM_BYTES).then_some(c)
        })
        .collect();
    s = s.trim_end_matches(['.', ' ']).to_string();
    if s.is_empty() {
        s = "download".to_string();
    }
    if is_reserved(&s) {
        s.insert(0, '_');
    }
    s
}

/// True when the part before the first dot is a Windows reserved device name.
fn is_reserved(stem: &str) -> bool {
    let base = stem.split('.').next().unwrap_or(stem).trim_end();
    RESERVED_NAMES.iter().any(|r| r.eq_ignore_ascii_case(base))
}

/// Normalizes an extension: ASCII alphanumerics only, 1..=8 chars, lowercase.
fn clean_extension(ext: &str) -> Option<String> {
    let ext = ext.trim().trim_start_matches('.');
    if ext.is_empty() || ext.len() > 8 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// Extension of the URL path (`.../movie/1.mkv?x=y` -> `mkv`), if plausible.
pub fn extension_from_url(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let last = parsed.path_segments()?.next_back()?.to_string();
    let decoded = percent_encoding::percent_decode_str(&last).decode_utf8_lossy();
    let (_, ext) = decoded.rsplit_once('.')?;
    clean_extension(ext)
}

/// Splits `name` into (stem, extension) when the extension looks real.
fn split_name(name: &str) -> (String, Option<String>) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.trim().is_empty() => match clean_extension(ext) {
            Some(ext) => (stem.to_string(), Some(ext)),
            None => (name.to_string(), None),
        },
        _ => (name.to_string(), None),
    }
}

/// Builds the requested final file name for a download.
///
/// `hint` (only its last path component is used) wins over the title. The
/// extension comes from the hint, else the URL path, else `mp4`; one outside
/// [`MEDIA_EXTENSIONS`] becomes `bin`.
pub fn build_file_name(
    title: &str,
    subtitle: Option<&str>,
    url: &str,
    hint: Option<&str>,
) -> String {
    let hint = hint
        .map(|h| h.rsplit(['/', '\\']).next().unwrap_or(h).trim())
        .filter(|h| !h.is_empty());
    let (stem, ext) = match hint {
        Some(h) => {
            let (stem, ext) = split_name(h);
            (stem, ext.or_else(|| extension_from_url(url)))
        }
        None => {
            let stem = match subtitle.map(str::trim).filter(|s| !s.is_empty()) {
                Some(sub) => format!("{} - {sub}", title.trim()),
                None => title.to_string(),
            };
            (stem, extension_from_url(url))
        }
    };
    let ext = ext.unwrap_or_else(|| DEFAULT_EXTENSION.to_string());
    let ext = if MEDIA_EXTENSIONS.contains(&ext.as_str()) {
        ext
    } else {
        FALLBACK_EXTENSION.to_string()
    };
    format!("{}.{ext}", sanitize_stem(&stem))
}

/// `<final>.part`.
pub fn part_path(final_path: &Path) -> PathBuf {
    let mut s = final_path.as_os_str().to_owned();
    s.push(PART_SUFFIX);
    PathBuf::from(s)
}

/// `Movie.mp4`, suffix 2 -> `Movie (2).mp4`.
fn numbered(name: &str, suffix: u32) -> String {
    if suffix == 0 {
        return name.to_string();
    }
    match split_name(name) {
        (stem, Some(ext)) => format!("{stem} ({suffix}).{ext}"),
        (stem, None) => format!("{stem} ({suffix})"),
    }
}

/// True when anything (file, dir, symlink, even a dangling one) sits at `p`.
pub fn occupied(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

/// A reserved destination: the `.part` exists (empty, created by us), the
/// final path does not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reservation {
    pub file_name: String,
    pub final_path: PathBuf,
    pub part_path: PathBuf,
}

/// Reserves the first free `name`, `name (1)`, ... in `dir`: the final path must
/// be absent and the `.part` is created with `create_new`, so two concurrent
/// reservations can never share a name.
pub fn reserve(dir: &Path, name: &str) -> io::Result<Reservation> {
    for suffix in 0..=MAX_SUFFIX {
        let file_name = numbered(name, suffix);
        let final_path = dir.join(&file_name);
        if occupied(&final_path) {
            continue;
        }
        let part = part_path(&final_path);
        match OpenOptions::new().write(true).create_new(true).open(&part) {
            Ok(_) => {
                // A fresh `.part` never inherits the segment layout of an
                // earlier one under its name (deleted while paused).
                super::segments::remove(&part);
                return Ok(Reservation {
                    file_name,
                    final_path,
                    part_path: part,
                });
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!("no free file name for {name}"),
    ))
}

/// Size of a regular (non-symlink) file at `p`; `Ok(None)` when absent;
/// an error when something else occupies the path.
pub fn regular_file_len(p: &Path) -> io::Result<Option<u64>> {
    match fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_file() => Ok(Some(m.len())),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not a regular file", p.display()),
        )),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// True when `p` is a regular file and not a symlink.
pub fn is_regular_file(p: &Path) -> bool {
    matches!(fs::symlink_metadata(p), Ok(m) if m.file_type().is_file())
}

/// Moves `part` to `final_path` without ever overwriting. When `final_path`
/// is occupied, the next free numbered name (final and `.part` both free) is
/// used. Returns the path actually written.
pub fn finalize(part: &Path, final_path: &Path) -> io::Result<PathBuf> {
    let dir = final_path.parent().unwrap_or(Path::new("."));
    let name = final_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    for suffix in 0..=MAX_SUFFIX {
        let candidate = dir.join(numbered(&name, suffix));
        if occupied(&candidate) || (suffix > 0 && occupied(&part_path(&candidate))) {
            continue;
        }
        match move_no_replace(part, &candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!("no free destination for {name}"),
    ))
}

/// Renames without replacing an existing destination.
///
/// `std::fs::rename` replaces on every platform, so the primary path is the
/// platform's no-replace rename ([`rename_no_replace`]): it fails atomically
/// with `AlreadyExists` and works on file systems without hard links
/// (FAT/exFAT, many network shares), where the copy below would rewrite the
/// whole file and need its size again in free space. Where that call is
/// unsupported, a hard link (also atomic) is followed by removing the source,
/// and file systems without either fall back to [`copy_no_replace`], which is
/// just as atomic about the destination at the cost of one extra pass over
/// the data.
fn move_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    match rename_no_replace(from, to) {
        Ok(()) => return Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Err(e),
        Err(e) => tracing::debug!(error = %e, "no-replace rename unavailable; trying a hard link"),
    }
    match fs::hard_link(from, to) {
        Ok(()) => {
            if let Err(e) = fs::remove_file(from) {
                tracing::warn!(error = %e, "could not remove .part after linking the final file");
            }
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(e),
        Err(e) => {
            tracing::debug!(error = %e, "hard link unavailable; falling back to copy");
            copy_no_replace(from, to)
        }
    }
}

/// Renames `from` to `to` in one step, failing with `AlreadyExists` when `to`
/// exists: `renameat2(RENAME_NOREPLACE)` on Linux, `renamex_np(RENAME_EXCL)`
/// on macOS, `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` on Windows.
/// Any other error (an old kernel, a file system or share that rejects the
/// flag) means "use another way".
#[cfg(target_os = "linux")]
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let from = std::ffi::CString::new(from.as_os_str().as_bytes())?;
    let to = std::ffi::CString::new(to.as_os_str().as_bytes())?;
    // The raw syscall: glibc only gained a renameat2 wrapper in 2.28.
    // SAFETY: both paths are NUL-terminated and outlive the call.
    let r = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if r == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let from = std::ffi::CString::new(from.as_os_str().as_bytes())?;
    let to = std::ffi::CString::new(to.as_os_str().as_bytes())?;
    // SAFETY: both paths are NUL-terminated and outlive the call.
    if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let wide = |p: &Path| p.as_os_str().encode_wide().chain([0]).collect::<Vec<u16>>();
    let (from, to) = (wide(from), wide(to));
    // Without MOVEFILE_REPLACE_EXISTING (flags 0) an existing target fails
    // with ERROR_ALREADY_EXISTS or ERROR_FILE_EXISTS, which std maps to
    // `AlreadyExists`.
    // SAFETY: both buffers are NUL-terminated UTF-16 and outlive the call.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn rename_no_replace(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}

/// Copies `from` into a destination created with `create_new` (so an
/// existing file is never replaced, even one created a moment ago), syncs it,
/// then deletes `from`. A failed copy removes only the file it created.
fn copy_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    let mut src = fs::File::open(from)?;
    let mut dst = OpenOptions::new().write(true).create_new(true).open(to)?;
    let copied = io::copy(&mut src, &mut dst).and_then(|_| dst.sync_all());
    drop(dst);
    if let Err(e) = copied {
        let _ = fs::remove_file(to);
        return Err(e);
    }
    drop(src);
    if let Err(e) = fs::remove_file(from) {
        tracing::warn!(error = %e, "could not remove .part after copying the final file");
    }
    Ok(())
}

/// Removes `p` when it is a regular file. Missing is success.
pub fn remove_regular_file(p: &Path) -> io::Result<bool> {
    match regular_file_len(p) {
        Ok(Some(_)) => fs::remove_file(p).map(|_| true),
        Ok(None) => Ok(false),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_for_windows() {
        assert_eq!(
            sanitize_stem("a<b>c:d\"e/f\\g|h?i*j"),
            "a_b_c_d_e_f_g_h_i_j"
        );
        assert_eq!(sanitize_stem("  Movie   Title.  "), "Movie Title");
        assert_eq!(sanitize_stem("CON"), "_CON");
        assert_eq!(sanitize_stem("com1.backup"), "_com1.backup");
        assert_eq!(sanitize_stem("Console"), "Console");
        assert_eq!(sanitize_stem(""), "download");
        assert_eq!(sanitize_stem("..."), "download");
        assert_eq!(sanitize_stem("tab\there\nnew"), "tab here new");
        let long = "x".repeat(400);
        assert_eq!(sanitize_stem(&long).chars().count(), MAX_STEM_CHARS);
        // Two-byte characters: the byte cap wins (100 characters).
        let multi = "é".repeat(400);
        assert_eq!(sanitize_stem(&multi).len(), MAX_STEM_BYTES);
        // Four-byte emoji (two UTF-16 units each) and three-byte CJK.
        for wide in ["😀".repeat(150), "中".repeat(150)] {
            let s = sanitize_stem(&wide);
            assert!(s.len() <= MAX_STEM_BYTES, "{}", s.len());
            let full = format!("{s} (10000).mkv.part");
            assert!(full.len() <= 255 && full.encode_utf16().count() <= 255);
        }
    }

    #[test]
    fn builds_names() {
        assert_eq!(
            build_file_name(
                "The Movie (2019)",
                None,
                "http://h/movie/u/p/1.mkv?token=a",
                None
            ),
            "The Movie (2019).mkv"
        );
        assert_eq!(
            build_file_name("Live", None, "http://h/stream", None),
            "Live.mp4"
        );
        assert_eq!(
            build_file_name("Show", Some("S01E02"), "http://h/s/1.mp4", None),
            "Show - S01E02.mp4"
        );
        assert_eq!(
            build_file_name(
                "ignored",
                None,
                "http://h/x.ts",
                Some("../../evil/name.avi")
            ),
            "name.avi"
        );
        assert_eq!(
            build_file_name("t", None, "http://h/x.ts", Some("plain")),
            "plain.ts"
        );
        assert_eq!(
            build_file_name("a:b", None, "http://h/x.m:p4", None),
            "a_b.mp4"
        );
        assert_eq!(
            build_file_name("Evil", None, "http://h/x.exe", None),
            "Evil.bin"
        );
        assert_eq!(
            build_file_name("t", None, "http://h/x.mp4", Some("page.HTML")),
            "page.bin"
        );
        assert_eq!(
            build_file_name("Sub", None, "http://h/x.SRT", None),
            "Sub.srt"
        );
        assert_eq!(extension_from_url("http://h/a%20b.MKV"), Some("mkv".into()));
        assert_eq!(extension_from_url("not a url"), None);
    }

    #[test]
    fn reserves_numbered_parts_and_finalizes_without_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let a = reserve(dir.path(), "Movie.mp4").unwrap();
        assert_eq!(a.file_name, "Movie.mp4");
        assert!(a.part_path.ends_with("Movie.mp4.part"));
        assert!(!occupied(&a.final_path));
        let b = reserve(dir.path(), "Movie.mp4").unwrap();
        assert_eq!(b.file_name, "Movie (1).mp4");

        // A user file occupies the final path of `a` while it downloads.
        fs::write(&a.final_path, b"mine").unwrap();
        fs::write(&a.part_path, b"data").unwrap();
        let done = finalize(&a.part_path, &a.final_path).unwrap();
        // (1) is taken by b's .part, so (2) wins.
        assert!(done.ends_with("Movie (2).mp4"));
        assert_eq!(fs::read(&a.final_path).unwrap(), b"mine");
        assert_eq!(fs::read(&done).unwrap(), b"data");
        assert!(!occupied(&a.part_path));

        let c = reserve(dir.path(), "Movie.mp4").unwrap();
        assert_eq!(c.file_name, "Movie (3).mp4");
        assert_eq!(numbered("noext", 2), "noext (2)");
    }

    #[test]
    fn copy_fallback_never_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("a.part");
        let taken = dir.path().join("taken.mp4");
        let free = dir.path().join("free.mp4");
        fs::write(&part, b"payload").unwrap();
        fs::write(&taken, b"user").unwrap();
        let err = copy_no_replace(&part, &taken).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&taken).unwrap(), b"user");
        assert!(part.is_file(), "source kept when the copy is refused");
        copy_no_replace(&part, &free).unwrap();
        assert_eq!(fs::read(&free).unwrap(), b"payload");
        assert!(!occupied(&part));
    }

    #[test]
    fn no_replace_rename_moves_and_never_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("a.part");
        let taken = dir.path().join("taken.mp4");
        let free = dir.path().join("free.mp4");
        fs::write(&part, b"payload").unwrap();
        fs::write(&taken, b"user").unwrap();
        let err = rename_no_replace(&part, &taken).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&taken).unwrap(), b"user");
        assert!(part.is_file(), "source kept when the rename is refused");
        rename_no_replace(&part, &free).unwrap();
        assert_eq!(fs::read(&free).unwrap(), b"payload");
        assert!(!occupied(&part), "a rename leaves no .part behind");
    }

    /// DL-4 measurement on a file system without hard links. Mount an exFAT
    /// image and point `IPTV_EXFAT_DIR` at it, then run
    /// `cargo test -p iptv-core --lib finalize_on_exfat -- --ignored --nocapture`.
    /// Prints how long finalizing a 1 GiB `.part` takes, and checks that it
    /// succeeds with less free space left than the file's size.
    #[test]
    #[ignore = "needs an exFAT mount in IPTV_EXFAT_DIR"]
    fn finalize_on_exfat() {
        let Ok(dir) = std::env::var("IPTV_EXFAT_DIR") else {
            return;
        };
        let dir = Path::new(&dir);
        let part = dir.join("big.mp4.part");
        let final_path = dir.join("big.mp4");
        let _ = fs::remove_file(&final_path);
        {
            use std::io::Write;
            let mut f = fs::File::create(&part).unwrap();
            let chunk = vec![7u8; 1 << 20];
            for _ in 0..1024 {
                f.write_all(&chunk).unwrap();
            }
            f.sync_all().unwrap();
        }
        let started = std::time::Instant::now();
        let done = finalize(&part, &final_path);
        let took = started.elapsed();
        eprintln!("DL-4 finalize of 1 GiB on exFAT: {took:?}, result {done:?}");
        let done = done.expect("finalize succeeds with less free space than the file");
        assert_eq!(fs::metadata(&done).unwrap().len(), 1 << 30);
        assert!(!occupied(&part));
        fs::remove_file(&done).unwrap();
    }

    #[test]
    fn regular_file_checks() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("f");
        assert_eq!(regular_file_len(&f).unwrap(), None);
        fs::write(&f, b"abc").unwrap();
        assert_eq!(regular_file_len(&f).unwrap(), Some(3));
        assert!(is_regular_file(&f));
        assert!(!is_regular_file(dir.path()));
        assert!(regular_file_len(dir.path()).is_err());
        assert!(remove_regular_file(&f).unwrap());
        assert!(!remove_regular_file(&f).unwrap());
    }
}
