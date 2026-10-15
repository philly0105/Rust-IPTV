//! Recording file names: `<Channel> - <Programme> - <YYYY-MM-DD HHmm>.ts`.

use crate::downloads::naming::sanitize_stem;
use chrono::{DateTime, TimeZone};
use std::fs::OpenOptions;
use std::io::{self, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Extension of every scheduled recording (MPEG-TS, written as received).
pub const EXTENSION: &str = "ts";

/// Longest name part kept from a channel or programme title, so the date
/// always survives [`sanitize_stem`]'s length cap.
const MAX_PART_CHARS: usize = 60;
/// Byte cap of one part (two parts plus the date stay under the 200-byte
/// stem limit even for CJK titles).
const MAX_PART_BYTES: usize = 80;

fn part(raw: &str) -> String {
    let collapsed: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .chars()
        .take(MAX_PART_CHARS)
        .scan(0usize, |bytes, c| {
            *bytes += c.len_utf8();
            (*bytes <= MAX_PART_BYTES).then_some(c)
        })
        .collect::<String>()
}

/// File stem for a recording that starts at `start` (shown in the local time
/// zone). A blank programme title (a channel recording) leaves it out.
pub fn file_stem<Tz: TimeZone>(
    channel: &str,
    programme: Option<&str>,
    start: DateTime<Tz>,
) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let channel = part(channel);
    let channel = if channel.trim().is_empty() {
        "Recording".to_string()
    } else {
        channel
    };
    let stamp = start.format("%Y-%m-%d %H%M").to_string();
    let raw = match programme.map(part).filter(|p| !p.trim().is_empty()) {
        Some(p) => format!("{channel} - {p} - {stamp}"),
        None => format!("{channel} - {stamp}"),
    };
    sanitize_stem(&raw)
}

/// Name of part `index` (0-based): the first part is `<stem>.ts`, later
/// ones (after the stream dropped and recording resumed) `<stem> (part N).ts`.
pub fn part_name(stem: &str, index: usize) -> String {
    if index == 0 {
        format!("{stem}.{EXTENSION}")
    } else {
        format!("{stem} (part {}).{EXTENSION}", index + 1)
    }
}

/// Creates the file for part `index` in `dir` without replacing anything:
/// an occupied name gets ` (1)`, ` (2)`, ... before the extension.
pub fn create_part(dir: &Path, stem: &str, index: usize) -> io::Result<PathBuf> {
    let base = part_name(stem, index);
    let (name_stem, ext) = base
        .rsplit_once('.')
        .map(|(s, e)| (s.to_string(), e.to_string()))
        .unwrap_or((base.clone(), EXTENSION.to_string()));
    for n in 0..1000u32 {
        let name = if n == 0 {
            base.clone()
        } else {
            format!("{name_stem} ({n}).{ext}")
        };
        let path = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(path),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!("no free file name for {base}"),
    ))
}

/// Appends the reconnect part `from` to the end of `into` (MPEG-TS joins
/// byte for byte) and syncs it; `from` is left for the caller to delete. On
/// failure `into` is cut back to its old length, so both files stay as they
/// were.
pub fn append_part(from: &Path, into: &Path) -> io::Result<()> {
    let mut src = std::fs::File::open(from)?;
    // Write access, not append-only: cutting back needs it on Windows.
    let mut dst = OpenOptions::new().write(true).open(into)?;
    let before = dst.seek(SeekFrom::End(0))?;
    let copied = io::copy(&mut src, &mut dst).and_then(|_| dst.sync_data());
    if let Err(e) = copied {
        let _ = dst.set_len(before);
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, TimeZone, Utc};

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    #[test]
    fn programme_name_has_channel_title_and_local_start() {
        let start = FixedOffset::east_opt(2 * 3600)
            .unwrap()
            .from_utc_datetime(&at(2026, 10, 12, 18, 5).naive_utc());
        assert_eq!(
            file_stem("BBC One", Some("The News"), start),
            "BBC One - The News - 2026-10-12 2005"
        );
    }

    #[test]
    fn channel_recording_leaves_out_the_programme() {
        assert_eq!(
            file_stem("Sport 1", None, at(2026, 1, 2, 3, 4)),
            "Sport 1 - 2026-01-02 0304"
        );
        assert_eq!(
            file_stem("Sport 1", Some("   "), at(2026, 1, 2, 3, 4)),
            "Sport 1 - 2026-01-02 0304"
        );
    }

    #[test]
    fn windows_unsafe_characters_are_replaced() {
        let stem = file_stem(
            "UK: Sky|News",
            Some("What? <Now> \"Live\"*/\\"),
            at(2026, 5, 6, 7, 8),
        );
        for bad in ['<', '>', ':', '"', '/', '\\', '|', '?', '*'] {
            assert!(!stem.contains(bad), "{stem} still has {bad}");
        }
        assert!(stem.ends_with("2026-05-06 0708"), "{stem}");
        assert!(
            stem.starts_with("UK_ Sky_News - What_ _Now_ _Live_"),
            "{stem}"
        );
    }

    #[test]
    fn reserved_and_blank_names_stay_valid() {
        assert_eq!(
            file_stem("", None, at(2026, 1, 1, 0, 0)),
            "Recording - 2026-01-01 0000"
        );
        let stem = file_stem("CON", None, at(2026, 1, 1, 0, 0));
        assert!(!stem.eq_ignore_ascii_case("con"));
        let ctl = file_stem("A\u{0007}B\nC", Some("x\ty"), at(2026, 1, 1, 0, 0));
        assert!(!ctl.chars().any(char::is_control), "{ctl:?}");
    }

    #[test]
    fn long_titles_keep_the_date() {
        let long = "x".repeat(400);
        let stem = file_stem(&long, Some(&long), at(2026, 3, 4, 5, 6));
        assert!(stem.ends_with("2026-03-04 0506"), "{stem}");
        assert!(stem.chars().count() <= 150);
        let cjk = "節".repeat(100);
        let stem = file_stem(&cjk, Some(&cjk), at(2026, 3, 4, 5, 6));
        assert!(stem.ends_with("2026-03-04 0506"), "{stem}");
    }

    #[test]
    fn parts_are_numbered_and_never_overwrite() {
        assert_eq!(part_name("A - 2026", 0), "A - 2026.ts");
        assert_eq!(part_name("A - 2026", 1), "A - 2026 (part 2).ts");
        let dir = tempfile::tempdir().unwrap();
        let first = create_part(dir.path(), "Show", 0).unwrap();
        assert_eq!(first.file_name().unwrap(), "Show.ts");
        std::fs::write(&first, b"keep").unwrap();
        let again = create_part(dir.path(), "Show", 0).unwrap();
        assert_eq!(again.file_name().unwrap(), "Show (1).ts");
        assert_eq!(std::fs::read(&first).unwrap(), b"keep");
        let second = create_part(dir.path(), "Show", 1).unwrap();
        assert_eq!(second.file_name().unwrap(), "Show (part 2).ts");
    }

    #[test]
    fn a_reconnect_part_joins_the_one_before() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("Show.ts");
        let second = dir.path().join("Show (part 2).ts");
        std::fs::write(&first, b"\x47first").unwrap();
        std::fs::write(&second, b"\x47second").unwrap();
        append_part(&second, &first).unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), b"\x47first\x47second");
        // The source is the caller's to delete.
        assert!(second.exists());
        // A missing source changes nothing.
        let gone = dir.path().join("gone.ts");
        assert!(append_part(&gone, &first).is_err());
        assert_eq!(std::fs::read(&first).unwrap(), b"\x47first\x47second");
    }
}
