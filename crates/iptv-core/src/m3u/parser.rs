//! Streaming M3U / M3U8 parser over any `BufRead`.
//!
//! [`M3uReader`] is an iterator of [`M3uEntry`]. It reads one line at a time
//! into a reused buffer (lines longer than [`MAX_LINE`] are truncated and
//! counted as skipped), so memory stays flat no matter how large the playlist
//! is. Edge cases handled (mined from the old app's parser and real lists):
//!
//! - Gzip input (`1F 8B`) is decompressed, at most [`MAX_PLAYLIST_BYTES`] of output.
//! - UTF-8 BOM, LF / CRLF / CR-only (classic Mac) line endings, blank lines, leading junk before `#EXTM3U`,
//!   several `#EXTM3U` lines (concatenated playlists). UTF-16 LE/BE input (with
//!   a byte order mark, or BOM-less starting with `#`) is transcoded; bytes
//!   that are not valid UTF-8 are decoded as Windows-1252 (Latin-1 playlists),
//!   while the valid UTF-8 runs around them stay UTF-8.
//! - Header attributes and detected EPG URLs are deduplicated with sets and
//!   capped ([`MAX_HEADER_ATTRS`], [`MAX_EPG_URLS`]). Unquoted header values
//!   run to the next space (`url-tvg=http://a/e.xml,http://b/e.xml`), and the
//!   first header `tvg-shift` is the default of entries without their own.
//! - `#EXTINF:-1`, `#EXTINF:0`, `#EXTINF:-1.000`, `#extinf:` in any case.
//! - Attribute values quoted with `"` or `'`, unquoted (`tvg-chno=5`), and quoted
//!   values containing commas (`group-title="News, UK"`); the display name is
//!   everything after the first comma outside quotes, so names may contain commas.
//! - Missing names fall back to `tvg-name`, then to the last URL path segment.
//! - `#EXTGRP:` sets the group (wins over `group-title`, like the old app).
//! - `#EXTVLCOPT:http-user-agent=`, `http-referrer=`, `http-origin=` and
//!   `#KODIPROP:` lines; KODIPROP lines before an `#EXTINF` apply to that entry.
//! - `url|User-Agent=..&Referer=..` pipe headers (url cut at the first `|`).
//! - An `#EXTINF` with no URL before the next `#EXTINF` is skipped and counted.
//! - Bare URL lines without `#EXTINF` become entries named after the URL.

use super::body::MAX_PLAYLIST_BYTES;
use std::io::{BufRead, Read};

/// Longest line kept; longer lines are truncated (and the entry is still parsed
/// from the kept prefix, or skipped when it is a URL line).
pub const MAX_LINE: usize = 64 * 1024;

/// Playlist header information gathered from every `#EXTM3U` line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct M3uHeader {
    /// EPG URLs from `url-tvg`, `x-tvg-url`, `tvg-url` (deduplicated, in order).
    pub epg_urls: Vec<String>,
    /// Every header attribute (lowercased key, value), first occurrence wins.
    pub attrs: Vec<(String, String)>,
}

/// One playlist entry.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct M3uEntry {
    /// Display name (never empty: falls back to tvg-name, then the URL).
    pub name: String,
    /// Stream URL with any `|header` suffix removed.
    pub url: String,
    pub duration: Option<f64>,
    pub tvg_id: Option<String>,
    pub tvg_name: Option<String>,
    pub tvg_logo: Option<String>,
    pub tvg_chno: Option<i64>,
    pub tvg_shift: Option<String>,
    pub group: Option<String>,
    pub radio: bool,
    pub catchup: Option<String>,
    pub catchup_days: Option<i64>,
    pub catchup_source: Option<String>,
    pub user_agent: Option<String>,
    pub referrer: Option<String>,
    pub origin: Option<String>,
    /// `#EXTVLCOPT:key=value` pairs (keys lowercased).
    pub vlc_opts: Vec<(String, String)>,
    /// `#KODIPROP:key=value` pairs (keys lowercased).
    pub kodi_props: Vec<(String, String)>,
    /// 1-based line number of the `#EXTINF` (or bare URL) line.
    pub line: u64,
}

/// Counters for a parse.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ParseStats {
    pub lines: u64,
    pub entries: u64,
    /// Lines that could not be used (dangling `#EXTINF`, junk text, overlong URL).
    pub skipped: u64,
    /// True once an `#EXTM3U` line was seen.
    pub saw_header: bool,
    /// Bytes read from the underlying reader (after decompression for gzip input).
    pub bytes: u64,
}

/// Streaming M3U reader. Iterate to get entries; read [`M3uReader::header`]
/// and [`M3uReader::stats`] afterwards (header attrs can appear on later lines
/// in concatenated playlists).
pub struct M3uReader<R: BufRead> {
    reader: Input<R>,
    buf: Vec<u8>,
    header: M3uHeader,
    /// The first header `tvg-shift`: the default of entries without one.
    header_shift: Option<String>,
    stats: ParseStats,
    pending: Option<M3uEntry>,
    pending_kodi: Vec<(String, String)>,
    first_line: bool,
    /// The previous line ended with `\r`; a `\n` right after it belongs to
    /// the same line break (CRLF).
    after_cr: bool,
    done: bool,
    io_error: Option<std::io::Error>,
    /// Header attribute keys and EPG URLs already kept.
    seen_attrs: std::collections::HashSet<String>,
    seen_epg_urls: std::collections::HashSet<String>,
    /// The start of the input was checked for a UTF-16 byte order mark.
    sniffed: bool,
    /// `Some(little_endian)` for UTF-16 input.
    utf16_le: Option<bool>,
    /// First byte of a UTF-16 code unit split across reads.
    odd_byte: Option<u8>,
    /// A first byte the BOM check consumed that belongs to the first line.
    carry: Option<u8>,
    /// The first code unit of BOM-less UTF-16 input (the `#` of `#EXTM3U`),
    /// consumed by the check.
    first_unit: Option<u16>,
}

impl<R: BufRead> M3uReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader: Input::Plain(reader),
            buf: Vec::with_capacity(1024),
            header: M3uHeader::default(),
            header_shift: None,
            stats: ParseStats::default(),
            pending: None,
            pending_kodi: Vec::new(),
            first_line: true,
            after_cr: false,
            done: false,
            io_error: None,
            seen_attrs: Default::default(),
            seen_epg_urls: Default::default(),
            sniffed: false,
            utf16_le: None,
            odd_byte: None,
            carry: None,
            first_unit: None,
        }
    }

    pub fn header(&self) -> &M3uHeader {
        &self.header
    }

    pub fn stats(&self) -> ParseStats {
        self.stats
    }

    /// The I/O error that ended iteration early, if any.
    pub fn take_io_error(&mut self) -> Option<std::io::Error> {
        self.io_error.take()
    }

    /// Reads one line (without the terminator) into `self.buf`, keeping at
    /// most `MAX_LINE` bytes. `\n`, `\r\n` and a lone `\r` all end a line.
    /// Returns `Ok(None)` at EOF and `Ok(Some(true))` when the line was
    /// truncated.
    fn read_line(&mut self) -> std::io::Result<Option<bool>> {
        self.buf.clear();
        let mut truncated = false;
        let mut any = false;
        if let Some(b) = self.carry.take() {
            // 0xFF / 0xFE / `#` / NUL / 0x1F: never a line break.
            self.buf.push(b);
            any = true;
        }
        loop {
            let available = match self.reader.fill_buf() {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            if available.is_empty() {
                return Ok(if any { Some(truncated) } else { None });
            }
            if self.after_cr {
                self.after_cr = false;
                if available[0] == b'\n' {
                    self.reader.consume(1);
                    self.stats.bytes += 1;
                    continue;
                }
            }
            any = true;
            let (chunk, found, used) = match memchr::memchr2(b'\n', b'\r', available) {
                Some(i) => {
                    self.after_cr = available[i] == b'\r';
                    (&available[..i], true, i + 1)
                }
                None => (available, false, available.len()),
            };
            let room = MAX_LINE.saturating_sub(self.buf.len());
            if chunk.len() > room {
                truncated = true;
                self.buf.extend_from_slice(&chunk[..room]);
            } else {
                self.buf.extend_from_slice(chunk);
            }
            self.reader.consume(used);
            self.stats.bytes += used as u64;
            if found {
                return Ok(Some(truncated));
            }
        }
    }

    fn finish_pending_as_skipped(&mut self) {
        if self.pending.take().is_some() {
            self.stats.skipped += 1;
        }
    }

    fn handle_line(&mut self, raw: &str, truncated: bool) -> Option<M3uEntry> {
        let mut line = raw.trim();
        if self.first_line {
            self.first_line = false;
            line = line.trim_start_matches('\u{feff}').trim();
        }
        if line.is_empty() {
            return None;
        }
        if let Some(rest) = line.strip_prefix('#') {
            // Compared in place: no Strings per directive line (IN-10).
            let directive = |name: &str| starts_with_ignore_case(rest, name);
            if directive("EXTM3U") {
                self.stats.saw_header = true;
                self.parse_header(&rest[6..]);
            } else if directive("EXTINF:") {
                self.finish_pending_as_skipped();
                let mut entry = parse_extinf(&rest[7..]);
                entry.line = self.stats.lines;
                entry.kodi_props.append(&mut self.pending_kodi);
                self.pending = Some(entry);
            } else if directive("EXTGRP:") {
                let v = rest[7..].trim().trim_matches('"').trim();
                if let Some(p) = self.pending.as_mut() {
                    if !v.is_empty() {
                        p.group = Some(v.to_string());
                    }
                }
            } else if directive("EXTVLCOPT:") {
                if let Some((k, v)) = split_kv(&rest[10..]) {
                    if let Some(p) = self.pending.as_mut() {
                        apply_header_opt(p, &k, &v);
                        p.vlc_opts.push((k, v));
                    }
                }
            } else if directive("KODIPROP:") {
                if let Some((k, v)) = split_kv(&rest[9..]) {
                    match self.pending.as_mut() {
                        Some(p) => p.kodi_props.push((k, v)),
                        None => self.pending_kodi.push((k, v)),
                    }
                }
            }
            // Any other directive or comment is ignored.
            return None;
        }
        // A URL (or junk) line.
        if truncated {
            // A cut URL would not play; drop it.
            self.finish_pending_as_skipped();
            self.stats.skipped += 1;
            return None;
        }
        match self.pending.take() {
            Some(mut entry) => {
                set_url(&mut entry, line);
                if entry.url.is_empty() {
                    self.stats.skipped += 1;
                    return None;
                }
                self.finish_entry(&mut entry);
                Some(entry)
            }
            None if line.contains("://") => {
                let mut entry = M3uEntry {
                    line: self.stats.lines,
                    ..Default::default()
                };
                entry.kodi_props.append(&mut self.pending_kodi);
                set_url(&mut entry, line);
                if entry.url.is_empty() {
                    self.stats.skipped += 1;
                    return None;
                }
                self.finish_entry(&mut entry);
                Some(entry)
            }
            None => {
                self.stats.skipped += 1;
                None
            }
        }
    }

    /// Name fallback, the header `tvg-shift` as default, and the count.
    fn finish_entry(&mut self, entry: &mut M3uEntry) {
        finalize_name(entry);
        if entry.tvg_shift.is_none() {
            entry.tvg_shift.clone_from(&self.header_shift);
        }
        self.stats.entries += 1;
    }

    fn parse_header(&mut self, rest: &str) {
        // Linear in header size: set lookups, and nothing more is parsed once
        // both lists are full (a hostile playlist can repeat `#EXTM3U` lines
        // with thousands of attributes each).
        if self.header.attrs.len() >= MAX_HEADER_ATTRS && self.header.epg_urls.len() >= MAX_EPG_URLS
        {
            return;
        }
        let (attrs, _) = parse_attrs_in(rest, true);
        for (k, v) in attrs {
            if k == "tvg-shift" && self.header_shift.is_none() {
                self.header_shift = non_empty(&v);
            }
            if matches!(k.as_str(), "url-tvg" | "x-tvg-url" | "tvg-url") {
                for url in extract_urls(&v) {
                    if self.header.epg_urls.len() >= MAX_EPG_URLS {
                        break;
                    }
                    if self.seen_epg_urls.insert(url.clone()) {
                        self.header.epg_urls.push(url);
                    }
                }
            }
            if self.header.attrs.len() < MAX_HEADER_ATTRS && self.seen_attrs.insert(k.clone()) {
                self.header.attrs.push((k, v));
            }
        }
    }

    /// Detects UTF-16 at the very start of the input: a byte order mark, or a
    /// NUL-interleaved `#` (BOM-less UTF-16 `#EXTM3U`); see [`utf16_start`].
    ///
    /// Gzip input (the `1F 8B` magic: a `.m3u.gz`, or a server that sends a
    /// compressed playlist without `Content-Encoding`) is decompressed first,
    /// and the check runs on the decompressed text.
    fn sniff_bom(&mut self) -> std::io::Result<()> {
        self.sniffed = true;
        let first = match self.peek()? {
            Some(b @ (0xFF | 0xFE | b'#' | 0 | GZIP_MAGIC0)) => b,
            _ => return Ok(()),
        };
        // The mark may straddle two reads (tiny buffers): take the first
        // byte, and hand it back to the line reader when no mark follows.
        self.reader.consume(1);
        if first == GZIP_MAGIC0 {
            if self.peek()? == Some(GZIP_MAGIC1) && self.reader.gunzip(first) {
                return self.sniff_bom();
            }
            self.stats.bytes += 1;
            self.carry = Some(first);
            return Ok(());
        }
        self.stats.bytes += 1;
        match self.peek()?.and_then(|next| utf16_start(first, next)) {
            Some((le, bom)) => {
                self.reader.consume(1);
                self.stats.bytes += 1;
                self.utf16_le = Some(le);
                if !bom {
                    self.first_unit = Some(u16::from(b'#'));
                }
            }
            None => self.carry = Some(first),
        }
        Ok(())
    }

    /// The next byte without consuming it.
    fn peek(&mut self) -> std::io::Result<Option<u8>> {
        loop {
            match self.reader.fill_buf() {
                Ok(b) => return Ok(b.first().copied()),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
    }

    /// [`Self::read_line`] for UTF-16 input: decodes code units up to the
    /// next line break into UTF-8 in `self.buf` (unpaired surrogates become
    /// U+FFFD). At most `MAX_LINE / 2` code units are kept.
    fn read_line_utf16(&mut self, le: bool) -> std::io::Result<Option<bool>> {
        self.buf.clear();
        let mut units: Vec<u16> = Vec::new();
        let mut truncated = false;
        let mut any = false;
        if let Some(u) = self.first_unit.take() {
            // `#`: never a line break.
            units.push(u);
            any = true;
        }
        let found = loop {
            let available = match self.reader.fill_buf() {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            if available.is_empty() {
                break false;
            }
            let mut used = 0;
            let mut found = false;
            for &b in available {
                used += 1;
                let Some(first) = self.odd_byte.take() else {
                    self.odd_byte = Some(b);
                    continue;
                };
                let unit = if le {
                    u16::from_le_bytes([first, b])
                } else {
                    u16::from_be_bytes([first, b])
                };
                if std::mem::take(&mut self.after_cr) && unit == 0x0A {
                    continue;
                }
                any = true;
                if unit == 0x0A || unit == 0x0D {
                    self.after_cr = unit == 0x0D;
                    found = true;
                    break;
                }
                if units.len() < MAX_LINE / 2 {
                    units.push(unit);
                } else {
                    truncated = true;
                }
            }
            self.reader.consume(used);
            self.stats.bytes += used as u64;
            if found {
                break true;
            }
        };
        if !found && !any {
            return Ok(None);
        }
        let text: String = char::decode_utf16(units)
            .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect();
        self.buf.extend_from_slice(text.as_bytes());
        Ok(Some(truncated))
    }
}

/// Most header attributes kept (real playlists have a handful).
pub const MAX_HEADER_ATTRS: usize = 256;
/// Most EPG URLs detected from the header.
pub const MAX_EPG_URLS: usize = 32;

const GZIP_MAGIC0: u8 = 0x1F;
const GZIP_MAGIC1: u8 = 0x8B;

/// True when `bytes` start with the gzip magic (`1F 8B`).
pub fn is_gzip(bytes: &[u8]) -> bool {
    bytes.starts_with(&[GZIP_MAGIC0, GZIP_MAGIC1])
}

/// Fails once more than `left` bytes came out of `inner`, so a small gzip
/// file cannot expand past [`MAX_PLAYLIST_BYTES`] (the download limit).
struct Capped<R> {
    inner: R,
    left: u64,
}

impl<R: Read> Read for Capped<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.left = self.left.checked_sub(n as u64).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "the playlist is larger than {} MB once decompressed, which is too large to be a channel list",
                    MAX_PLAYLIST_BYTES / (1024 * 1024)
                ),
            )
        })?;
        Ok(n)
    }
}

/// Gunzipped input: the consumed first magic byte put back in front.
type Gunzip<R> = std::io::BufReader<
    Capped<flate2::bufread::MultiGzDecoder<std::io::Chain<std::io::Cursor<[u8; 1]>, R>>>,
>;

/// The bytes under [`M3uReader`]: the input as given, or decompressed
/// (boxed: the inflate state is large and most playlists are plain).
enum Input<R: BufRead> {
    Plain(R),
    Gzip(Box<Gunzip<R>>),
    /// Only while [`Input::gunzip`] swaps the reader.
    Swapping,
}

impl<R: BufRead> Input<R> {
    /// Switches plain input whose first byte (`first`, already consumed)
    /// began the gzip magic to its decompressed bytes. False when the input
    /// is already decompressed (a doubly compressed file is not unpacked twice).
    fn gunzip(&mut self, first: u8) -> bool {
        match std::mem::replace(self, Input::Swapping) {
            Input::Plain(r) => {
                let raw = std::io::Cursor::new([first]).chain(r);
                *self = Input::Gzip(Box::new(std::io::BufReader::with_capacity(
                    64 * 1024,
                    Capped {
                        inner: flate2::bufread::MultiGzDecoder::new(raw),
                        left: MAX_PLAYLIST_BYTES,
                    },
                )));
                true
            }
            other => {
                *self = other;
                false
            }
        }
    }
}

impl<R: BufRead> Read for Input<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Input::Plain(r) => r.read(buf),
            Input::Gzip(r) => r.read(buf),
            Input::Swapping => Ok(0),
        }
    }
}

impl<R: BufRead> BufRead for Input<R> {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        match self {
            Input::Plain(r) => r.fill_buf(),
            Input::Gzip(r) => r.fill_buf(),
            Input::Swapping => Ok(&[]),
        }
    }

    fn consume(&mut self, n: usize) {
        match self {
            Input::Plain(r) => r.consume(n),
            Input::Gzip(r) => r.consume(n),
            Input::Swapping => {}
        }
    }
}

/// Windows-1252 code points for bytes 0x80..=0x9F (the rest is Latin-1).
const CP1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{FFFD}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{FFFD}', '\u{017D}', '\u{FFFD}',
    '\u{FFFD}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{FFFD}', '\u{017E}', '\u{0178}',
];

/// UTF-16 recognised from the first two bytes of a playlist, as
/// `(little_endian, is_byte_order_mark)`: `FF FE` / `FE FF`, or a
/// NUL-interleaved `#` (BOM-less UTF-16 starting with `#EXTM3U`).
pub fn utf16_start(a: u8, b: u8) -> Option<(bool, bool)> {
    match (a, b) {
        (0xFF, 0xFE) => Some((true, true)),
        (0xFE, 0xFF) => Some((false, true)),
        (b'#', 0) => Some((true, false)),
        (0, b'#') => Some((false, false)),
        _ => None,
    }
}

/// `bytes` decoded as UTF-16 when [`utf16_start`] recognises its start (the
/// mark is dropped; a trailing odd byte is ignored, unpaired surrogates
/// become U+FFFD), else `None`.
pub fn utf16_text(bytes: &[u8]) -> Option<String> {
    let (le, bom) = match bytes {
        [a, b, ..] => utf16_start(*a, *b)?,
        _ => return None,
    };
    let body = if bom { &bytes[2..] } else { bytes };
    let units = body.chunks_exact(2).map(|p| {
        if le {
            u16::from_le_bytes([p[0], p[1]])
        } else {
            u16::from_be_bytes([p[0], p[1]])
        }
    });
    Some(
        char::decode_utf16(units)
            .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect(),
    )
}

/// One line's text, decoded in runs: every valid UTF-8 run stays UTF-8, and
/// each byte of an invalid sequence (a Latin-1 / Windows-1252 byte) is decoded
/// as Windows-1252, so a UTF-8 line with one stray cp1252 byte keeps its UTF-8
/// characters. An incomplete UTF-8 sequence at the very end is dropped only
/// when [`MAX_LINE`] cut the line there (`truncated`); on a whole line it is
/// Windows-1252 too (`Caf\xE9`).
fn line_text(buf: &[u8], truncated: bool) -> std::borrow::Cow<'_, str> {
    let mut rest = match std::str::from_utf8(buf) {
        Ok(s) => return s.into(),
        Err(_) => buf,
    };
    let mut out = String::with_capacity(buf.len() + 8);
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                break;
            }
            Err(e) => {
                let (valid, after) = rest.split_at(e.valid_up_to());
                // `valid` is UTF-8 by construction.
                out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                match e.error_len() {
                    Some(n) => {
                        out.push_str(&decode_windows_1252(&after[..n]));
                        rest = &after[n..];
                    }
                    // An incomplete sequence at the end of the buffer.
                    None => {
                        if !truncated {
                            out.push_str(&decode_windows_1252(after));
                        }
                        break;
                    }
                }
            }
        }
    }
    out.into()
}

/// A whole playlist file as text, decoded the way [`M3uReader`] decodes it:
/// gzip is decompressed (what decoded before a corrupt or oversized part is
/// kept), UTF-16 (byte order mark or BOM-less `#EXTM3U`) is transcoded, a
/// UTF-8 BOM is dropped, and bytes that are not valid UTF-8 are Windows-1252
/// (see [`line_text`]).
pub fn decode_playlist_text(bytes: Vec<u8>) -> String {
    let bytes = if is_gzip(&bytes) {
        let mut out = Vec::new();
        let _ = Capped {
            inner: flate2::read::MultiGzDecoder::new(&bytes[..]),
            left: MAX_PLAYLIST_BYTES,
        }
        .read_to_end(&mut out);
        out
    } else {
        bytes
    };
    if let Some(text) = utf16_text(&bytes) {
        return text;
    }
    let start = if bytes.starts_with(b"\xEF\xBB\xBF") {
        3
    } else {
        0
    };
    match std::str::from_utf8(&bytes[start..]) {
        Ok(_) => {
            let mut bytes = bytes;
            bytes.drain(..start);
            String::from_utf8(bytes).unwrap_or_default()
        }
        Err(_) => bytes[start..]
            .split_inclusive(|&b| b == b'\n')
            .map(|line| line_text(line, false))
            .collect(),
    }
}

/// Decodes Windows-1252 (a superset of the printable Latin-1 range).
pub fn decode_windows_1252(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0x80..=0x9F => CP1252_HIGH[(b - 0x80) as usize],
            _ => b as char,
        })
        .collect()
}

impl<R: BufRead> Iterator for M3uReader<R> {
    type Item = M3uEntry;

    fn next(&mut self) -> Option<M3uEntry> {
        while !self.done {
            if !self.sniffed {
                if let Err(e) = self.sniff_bom() {
                    self.done = true;
                    self.io_error = Some(e);
                    break;
                }
            }
            let line = match self.utf16_le {
                Some(le) => self.read_line_utf16(le),
                None => self.read_line(),
            };
            match line {
                Ok(Some(truncated)) => {
                    self.stats.lines += 1;
                    if truncated {
                        tracing::debug!(
                            line = self.stats.lines,
                            "m3u line longer than {MAX_LINE} bytes truncated"
                        );
                    }
                    let buf = std::mem::take(&mut self.buf);
                    let text = line_text(&buf, truncated);
                    let out = self.handle_line(&text, truncated);
                    drop(text);
                    self.buf = buf;
                    if out.is_some() {
                        return out;
                    }
                }
                Ok(None) => {
                    self.done = true;
                    self.finish_pending_as_skipped();
                }
                Err(e) => {
                    self.done = true;
                    self.io_error = Some(e);
                }
            }
        }
        None
    }
}

/// True when `s` starts with the ASCII `prefix`, in any case.
fn starts_with_ignore_case(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// Splits `key=value` (key lowercased, both trimmed, surrounding quotes removed).
fn split_kv(s: &str) -> Option<(String, String)> {
    let (k, v) = s.split_once('=')?;
    let k = k.trim().to_ascii_lowercase();
    if k.is_empty() {
        return None;
    }
    let v = v.trim().trim_matches('"').trim().to_string();
    Some((k, v))
}

fn non_empty(v: &str) -> Option<String> {
    let v = v.trim();
    (!v.is_empty()).then(|| v.to_string())
}

fn apply_header_opt(entry: &mut M3uEntry, key: &str, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    match key {
        "http-user-agent" | "user-agent" => entry.user_agent = Some(value.to_string()),
        "http-referrer" | "http-referer" | "referrer" | "referer" => {
            entry.referrer = Some(value.to_string())
        }
        "http-origin" | "origin" => entry.origin = Some(value.to_string()),
        _ => {}
    }
}

/// Parses `key=value` attributes until the first comma outside quotes.
/// Returns the attributes (keys lowercased) and the byte index just past that
/// comma (or `s.len()` when there is none).
pub(crate) fn parse_attrs(s: &str) -> (Vec<(String, String)>, Option<usize>) {
    parse_attrs_in(s, false)
}

/// [`parse_attrs`]; with `header` (an `#EXTM3U` line, which has no display
/// name) a comma ends neither the attributes nor an unquoted value, so
/// `url-tvg=http://a/e.xml,http://b/e.xml` keeps both guides.
fn parse_attrs_in(s: &str, header: bool) -> (Vec<(String, String)>, Option<usize>) {
    let bytes = s.as_bytes();
    let mut attrs = Vec::new();
    let mut i = 0;
    let n = bytes.len();
    while i < n {
        let c = bytes[i];
        if c == b',' {
            if header {
                i += 1;
                continue;
            }
            return (attrs, Some(i + 1));
        }
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        // Read a key.
        let key_start = i;
        while i < n && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' && bytes[i] != b',' {
            if bytes[i] == b'"' || bytes[i] == b'\'' {
                // Stray quote: skip the quoted run so its commas do not end the attrs.
                let q = bytes[i];
                i += 1;
                while i < n && bytes[i] != q {
                    i += 1;
                }
            }
            i += 1;
        }
        let i_key_end = i.min(n);
        let key = &s[key_start..i_key_end];
        // Skip spaces before '='.
        let mut j = i;
        while j < n && bytes[j] == b' ' {
            j += 1;
        }
        if j < n && bytes[j] == b'=' {
            j += 1;
            while j < n && bytes[j] == b' ' {
                j += 1;
            }
            let (value, next) = if j < n && (bytes[j] == b'"' || bytes[j] == b'\'') {
                let q = bytes[j];
                let start = j + 1;
                let mut k = start;
                while k < n && bytes[k] != q {
                    k += 1;
                }
                (&s[start..k.min(n)], (k + 1).min(n))
            } else {
                let start = j;
                let mut k = start;
                while k < n && !bytes[k].is_ascii_whitespace() && (header || bytes[k] != b',') {
                    k += 1;
                }
                (&s[start..k], k)
            };
            let key = key.trim().to_ascii_lowercase();
            if !key.is_empty() {
                attrs.push((key, value.to_string()));
            }
            i = next;
        } else {
            // A bare token (usually the duration); nothing to record.
            i = i_key_end;
        }
    }
    (attrs, None)
}

/// Parses everything after `#EXTINF:`.
fn parse_extinf(rest: &str) -> M3uEntry {
    let rest = rest.trim();
    // Duration: leading number token.
    let dur_end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '-' || c == '.' || c == '+'))
        .unwrap_or(rest.len());
    // A 400-digit "duration" parses as infinity; keep only finite values.
    let duration = rest[..dur_end]
        .parse::<f64>()
        .ok()
        .filter(|d| d.is_finite());
    let after = &rest[dur_end..];
    let (attrs, comma) = parse_attrs(after);
    let name = match comma {
        Some(i) => after[i..].trim().to_string(),
        None => String::new(),
    };
    let mut e = M3uEntry {
        duration,
        name,
        ..Default::default()
    };
    for (k, v) in attrs {
        match k.as_str() {
            "tvg-id" => e.tvg_id = non_empty(&v),
            "tvg-name" => e.tvg_name = non_empty(&v),
            "tvg-logo" | "logo" => {
                if e.tvg_logo.is_none() {
                    e.tvg_logo = non_empty(&v)
                }
            }
            "tvg-chno" | "channel-number" | "tvg-num" => {
                if e.tvg_chno.is_none() {
                    e.tvg_chno = v
                        .trim()
                        .parse::<i64>()
                        .ok()
                        // "NaN"/"inf" parse as f64 and would cast to 0 / i64::MAX.
                        .or_else(|| {
                            v.trim()
                                .parse::<f64>()
                                .ok()
                                .filter(|f| f.is_finite() && f.abs() < 1e15)
                                .map(|f| f as i64)
                        })
                }
            }
            "tvg-shift" => e.tvg_shift = non_empty(&v),
            "group-title" => e.group = non_empty(&v),
            "radio" => e.radio = v.trim().eq_ignore_ascii_case("true") || v.trim() == "1",
            "catchup" | "catchup-type" => e.catchup = non_empty(&v),
            "catchup-days" | "timeshift" => {
                if e.catchup_days.is_none() {
                    e.catchup_days = v.trim().parse::<i64>().ok().filter(|d| *d > 0)
                }
            }
            "catchup-source" => e.catchup_source = non_empty(&v),
            "user-agent" | "http-user-agent" => apply_header_opt(&mut e, "user-agent", &v),
            "referrer" | "referer" | "http-referrer" | "http-referer" => {
                apply_header_opt(&mut e, "referrer", &v)
            }
            "origin" | "http-origin" => apply_header_opt(&mut e, "origin", &v),
            _ => {}
        }
    }
    e
}

/// Sets `entry.url` from a URL line, applying `|Key=Value&...` pipe headers.
fn set_url(entry: &mut M3uEntry, line: &str) {
    let (url, params) = match line.split_once('|') {
        Some((u, p)) => (u.trim(), Some(p)),
        None => (line.trim(), None),
    };
    entry.url = url.to_string();
    if let Some(params) = params {
        for pair in params.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                let key = k.trim().to_ascii_lowercase();
                let v = percent_encoding::percent_decode_str(v.trim()).decode_utf8_lossy();
                apply_header_opt(entry, &key, &v);
            }
        }
    }
}

/// Name fallback chain: EXTINF name, tvg-name, last URL path segment, URL.
fn finalize_name(entry: &mut M3uEntry) {
    if !entry.name.trim().is_empty() {
        entry.name = entry.name.trim().to_string();
        return;
    }
    if let Some(n) = entry.tvg_name.as_deref().filter(|n| !n.trim().is_empty()) {
        entry.name = n.trim().to_string();
        return;
    }
    let path = entry.url.split(['?', '#']).next().unwrap_or(&entry.url);
    let seg = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let seg = percent_encoding::percent_decode_str(seg).decode_utf8_lossy();
    entry.name = if seg.trim().is_empty() || seg.contains(':') {
        entry.url.clone()
    } else {
        seg.trim().to_string()
    };
}

/// Extracts `http(s)://` / `file://` URLs from a header value (comma or space separated).
pub fn extract_urls(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for token in value.split(|c: char| c == ',' || c == ';' || c.is_whitespace()) {
        if out.len() >= MAX_EPG_URLS {
            break;
        }
        let t = token.trim().trim_matches(|c| c == '"' || c == '\'');
        let lower = t.get(..8).unwrap_or(t).to_ascii_lowercase();
        if (lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("file://"))
            && t.len() > 8
            && seen.insert(t)
        {
            out.push(t.to_string());
        }
    }
    out
}

/// True for URLs whose path ends in a typical movie container extension.
pub fn has_movie_extension(url: &str) -> bool {
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    [".mp4", ".mkv", ".avi", ".m4v", ".mov"]
        .iter()
        .any(|ext| path.ends_with(ext))
}

/// The container extension of a URL path (`mp4`), if any.
pub fn url_extension(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let last = path.rsplit('/').next()?;
    let (_, ext) = last.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    (!ext.is_empty() && ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .then_some(ext)
}

/// Parses a whole in-memory playlist (convenience for previews and tests).
pub fn parse_str(text: &str) -> (Vec<M3uEntry>, M3uHeader, ParseStats) {
    let mut r = M3uReader::new(std::io::Cursor::new(text.as_bytes()));
    let entries: Vec<M3uEntry> = r.by_ref().collect();
    let header = r.header().clone();
    let stats = r.stats();
    (entries, header, stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_entries_and_header() {
        let text = "\u{feff}#EXTM3U url-tvg=\"http://a/epg.xml,http://b/epg.xml.gz\" x-tvg-url='http://c/x.xml'\r\n\
#EXTINF:-1 tvg-id=\"bbc1.uk\" tvg-name=\"BBC One\" tvg-logo=\"http://l/bbc.png\" group-title=\"News, UK\" tvg-chno=\"101\",BBC One, HD\r\n\
http://s/1.m3u8\r\n\
#EXTINF:0,Plain\r\n\
http://s/2.ts\r\n";
        let (e, h, s) = parse_str(text);
        assert_eq!(
            h.epg_urls,
            vec!["http://a/epg.xml", "http://b/epg.xml.gz", "http://c/x.xml"]
        );
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].name, "BBC One, HD");
        assert_eq!(e[0].group.as_deref(), Some("News, UK"));
        assert_eq!(e[0].tvg_chno, Some(101));
        assert_eq!(e[0].tvg_id.as_deref(), Some("bbc1.uk"));
        assert_eq!(e[0].duration, Some(-1.0));
        assert_eq!(e[1].name, "Plain");
        assert_eq!(e[1].duration, Some(0.0));
        assert!(s.saw_header);
        assert_eq!(s.skipped, 0);
    }

    #[test]
    fn handles_options_pipes_and_fallback_names() {
        let text = "#EXTM3U\n\
#KODIPROP:inputstream.adaptive.license_type=clearkey\n\
#EXTINF:-1 tvg-name=\"Fallback\" radio=\"true\",\n\
#EXTVLCOPT:http-user-agent=VLC/3\n\
#EXTVLCOPT:http-referrer=http://ref/\n\
#EXTGRP:Radio Group\n\
http://r/stream.mp3|User-Agent=Foo%20Bar&Referer=http://x/\n\
#EXTINF:-1,\n\
http://s/path/My%20Movie.mkv?token=1\n";
        let (e, _, _) = parse_str(text);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].name, "Fallback");
        assert!(e[0].radio);
        assert_eq!(e[0].group.as_deref(), Some("Radio Group"));
        assert_eq!(e[0].url, "http://r/stream.mp3");
        assert_eq!(e[0].user_agent.as_deref(), Some("Foo Bar"));
        assert_eq!(e[0].referrer.as_deref(), Some("http://x/"));
        assert_eq!(e[0].kodi_props.len(), 1);
        assert_eq!(e[0].vlc_opts.len(), 2);
        assert_eq!(e[1].name, "My Movie.mkv");
        assert!(has_movie_extension(&e[1].url));
        assert_eq!(url_extension(&e[1].url).as_deref(), Some("mkv"));
    }

    /// IN-10: directives are matched in place, in any case; a short or
    /// non-ASCII comment is not one.
    #[test]
    fn directives_match_in_any_case() {
        let text = "#extm3u x-tvg-url=\"http://e/g.xml\"\n\
#ExtInf:-1,One\n\
#extgrp:Group\n\
#ExtVlcOpt:http-user-agent=VLC/3\n\
#kodiprop:k=v\n\
http://s/1\n\
#EXT\n\
#ÉXTINF:-1,Not\n\
http://s/2\n";
        let (e, h, s) = parse_str(text);
        assert!(s.saw_header);
        assert_eq!(h.epg_urls, ["http://e/g.xml"]);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].name, "One");
        assert_eq!(e[0].group.as_deref(), Some("Group"));
        assert_eq!(e[0].user_agent.as_deref(), Some("VLC/3"));
        assert_eq!(e[0].kodi_props.len(), 1);
        assert_eq!(e[1].url, "http://s/2");
        assert!(starts_with_ignore_case("extinf:", "EXTINF:"));
        assert!(!starts_with_ignore_case("EXTIN", "EXTINF:"));
    }

    #[test]
    fn skips_bad_lines_and_dangling_extinf() {
        let text = "garbage line\n#EXTINF:-1,No URL\n#EXTINF:-1,Good\nhttp://s/ok\nnot a url\nhttp://bare/one.ts\n#EXTINF:-1,Last without url\n";
        let (e, _, s) = parse_str(text);
        assert_eq!(
            e.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(),
            vec!["Good", "one.ts"]
        );
        assert_eq!(s.skipped, 4);
        assert!(!s.saw_header);
    }

    #[test]
    fn unquoted_and_single_quoted_attrs() {
        let (attrs, comma) = parse_attrs(" tvg-chno=7 group-title='A, B' tvg-id=\"x\",Name");
        assert_eq!(attrs[0], ("tvg-chno".into(), "7".into()));
        assert_eq!(attrs[1], ("group-title".into(), "A, B".into()));
        assert_eq!(attrs[2], ("tvg-id".into(), "x".into()));
        assert!(comma.is_some());
    }

    #[test]
    fn overlong_lines_are_bounded() {
        let mut text = String::from("#EXTM3U\n#EXTINF:-1,Long\n");
        text.push_str("http://x/");
        text.push_str(&"a".repeat(MAX_LINE * 2));
        text.push_str("\n#EXTINF:-1,Ok\nhttp://ok\n");
        let (e, _, s) = parse_str(&text);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].name, "Ok");
        assert_eq!(s.skipped, 2);
    }

    #[test]
    fn catchup_attrs() {
        let (e, _, _) = parse_str("#EXTM3U\n#EXTINF:-1 catchup=\"default\" catchup-days=\"7\" catchup-source=\"?utc={utc}\",C\nhttp://c\n");
        assert_eq!(e[0].catchup.as_deref(), Some("default"));
        assert_eq!(e[0].catchup_days, Some(7));
        assert_eq!(e[0].catchup_source.as_deref(), Some("?utc={utc}"));
    }

    /// B8-parsers: non-finite numbers used to become channel 0 / i64::MAX.
    #[test]
    fn non_finite_numbers_are_dropped() {
        let text = format!(
            "#EXTM3U\n#EXTINF:{} tvg-chno=\"NaN\",A\nhttp://a\n#EXTINF:-1 tvg-chno=\"inf\",B\nhttp://b\n#EXTINF:-1 tvg-chno=\"1e300\",C\nhttp://c\n#EXTINF:-1 tvg-chno=\"7.0\",D\nhttp://d\n",
            "9".repeat(400)
        );
        let (e, _, _) = parse_str(&text);
        assert_eq!(e.len(), 4);
        assert_eq!(e[0].duration, None);
        assert_eq!(e[0].tvg_chno, None);
        assert_eq!(e[1].tvg_chno, None);
        assert_eq!(e[2].tvg_chno, None);
        assert_eq!(e[3].tvg_chno, Some(7));
    }

    /// Review R1-1: header attributes and EPG URLs were deduplicated with
    /// linear scans, so 80k distinct header attributes took ~15 s, and every
    /// url-tvg URL was kept.
    #[test]
    fn header_heavy_playlist_is_linear_and_capped() {
        let mut text = String::new();
        for line in 0..160 {
            text.push_str("#EXTM3U");
            for i in 0..500 {
                let n = line * 500 + i;
                text.push_str(&format!(
                    " k{n}=\"v\" url-tvg=\"http://epg.example/{n}.xml\""
                ));
            }
            text.push('\n');
        }
        text.push_str("#EXTINF:-1,A\nhttp://a\n");
        let started = std::time::Instant::now();
        let (e, h, _) = parse_str(&text);
        let took = started.elapsed();
        assert_eq!(e.len(), 1);
        assert_eq!(h.attrs.len(), MAX_HEADER_ATTRS);
        assert_eq!(h.epg_urls.len(), MAX_EPG_URLS);
        assert_eq!(h.epg_urls[0], "http://epg.example/0.xml");
        assert_eq!(h.attrs[0], ("k0".to_string(), "v".to_string()));
        assert!(took < std::time::Duration::from_secs(2), "took {took:?}");
    }

    fn parse_bytes(bytes: &[u8], cap: usize) -> (Vec<M3uEntry>, M3uHeader) {
        let mut r = M3uReader::new(std::io::BufReader::with_capacity(cap, bytes));
        let e: Vec<M3uEntry> = r.by_ref().collect();
        assert!(r.take_io_error().is_none());
        (e, r.header().clone())
    }

    fn utf16(text: &str, le: bool) -> Vec<u8> {
        let mut out = if le {
            vec![0xFF, 0xFE]
        } else {
            vec![0xFE, 0xFF]
        };
        for u in text.encode_utf16() {
            out.extend(if le { u.to_le_bytes() } else { u.to_be_bytes() });
        }
        out
    }

    /// Review R1-4: UTF-16 playlists (Notepad "Unicode") imported 0 entries.
    #[test]
    fn utf16_playlists_are_transcoded() {
        let text = "#EXTM3U url-tvg=\"http://e/g.xml\"\r\n#EXTINF:-1 group-title=\"Infos\",Télé 1 🎬\r\nhttp://s/1.ts\r\n#EXTINF:-1,Two\r\nhttp://s/2.ts\r\n";
        for le in [true, false] {
            // Capacity 1 splits the mark and every code unit across reads.
            for cap in [1, 3, 64 * 1024] {
                let (e, h) = parse_bytes(&utf16(text, le), cap);
                assert_eq!(e.len(), 2, "le={le} cap={cap}");
                assert_eq!(e[0].name, "Télé 1 🎬");
                assert_eq!(e[0].group.as_deref(), Some("Infos"));
                assert_eq!(e[1].url, "http://s/2.ts");
                assert_eq!(h.epg_urls, ["http://e/g.xml"]);
            }
        }
    }

    /// Review R1-4: Latin-1 / Windows-1252 bytes came out as U+FFFD.
    #[test]
    fn non_utf8_lines_are_decoded_as_windows_1252() {
        let mut bytes =
            b"#EXTM3U\n#EXTINF:-1 group-title=\"Fran\xe7ais\",T\xe9l\xe9 \x80 \x96\n".to_vec();
        bytes.extend_from_slice("http://s/1.ts\n#EXTINF:-1,Déjà UTF-8\nhttp://s/2.ts\n".as_bytes());
        for cap in [1, 64 * 1024] {
            let (e, _) = parse_bytes(&bytes, cap);
            assert_eq!(e.len(), 2);
            assert_eq!(e[0].name, "Télé € –");
            assert_eq!(e[0].group.as_deref(), Some("Français"));
            assert_eq!(e[1].name, "Déjà UTF-8", "valid UTF-8 lines are untouched");
        }
        // A leading 0xFF that is not a byte order mark stays in the line.
        let (e, _) = parse_bytes(b"\xffjunk\nhttp://s/x.ts\n", 1);
        assert_eq!(e.len(), 1);
        assert_eq!(decode_windows_1252(b"\xff\x81"), "ÿ\u{FFFD}");
    }

    /// A line cut by MAX_LINE inside a UTF-8 character keeps its valid prefix
    /// instead of being re-read as Windows-1252.
    #[test]
    fn cut_utf8_line_stays_utf8() {
        let name = "é".repeat(MAX_LINE);
        let text = format!("#EXTM3U\n#EXTINF:-1,{name}\nhttp://s/1.ts\n");
        let (e, _, _) = parse_str(&text);
        assert_eq!(e.len(), 1);
        assert!(e[0].name.chars().all(|c| c == 'é'), "no mojibake");
    }

    /// Review R2-4: a whole Windows-1252 line whose last byte is a UTF-8 lead
    /// byte was taken for a cut UTF-8 line and lost that byte ("Caf").
    #[test]
    fn cp1252_line_ending_in_a_lead_byte_keeps_it() {
        for eol in ["\n", "\r\n", ""] {
            let mut bytes = b"#EXTM3U\n#EXTINF:-1 group-title=\"Caf\xe9\",Caf\xe9".to_vec();
            bytes.extend_from_slice(b"\nhttp://s/1.ts");
            bytes.extend_from_slice(eol.as_bytes());
            for cap in [1, 64 * 1024] {
                let (e, _) = parse_bytes(&bytes, cap);
                assert_eq!(e.len(), 1, "eol={eol:?}");
                assert_eq!(e[0].name, "Café");
                assert_eq!(e[0].group.as_deref(), Some("Café"));
            }
        }
    }

    /// Review R3-4: a UTF-8 line with one stray Windows-1252 byte was
    /// decoded wholly as Windows-1252 ("CafÃ© été").
    #[test]
    fn mixed_lines_keep_their_utf8_runs() {
        let t = |b: &[u8], cut: bool| line_text(b, cut).into_owned();
        assert_eq!(t(b"Caf\xc3\xa9 \xe9t\xe9", false), "Café été");
        assert_eq!(t(b"\xe9t\xe9 Caf\xc3\xa9", false), "été Café");
        // Earlier cases: a whole cp1252 line, a trailing lead byte, 0x80-0x9F.
        assert_eq!(t(b"T\xe9l\xe9 \x80 \x96", false), "Télé € –");
        assert_eq!(t(b"Caf\xe9", false), "Café");
        assert_eq!(t(b"Caf\xc3\xa9 Caf\xe9", false), "Café Café");
        // A lone lead byte inside the line, and an incomplete 3-byte
        // sequence (each of its bytes is cp1252).
        assert_eq!(t(b"a\xc3 b", false), "aÃ b");
        assert_eq!(t(b"a\xe2\x82 b", false), "aâ‚ b");
        // Undefined cp1252 bytes become U+FFFD.
        assert_eq!(t(b"x\x81y", false), "x\u{FFFD}y");
        // A line cut inside a UTF-8 character drops only the partial tail.
        assert_eq!(t(b"\xe9t\xe9 Caf\xc3", true), "été Caf");
        assert_eq!(t(b"Caf\xc3", false), "CafÃ");
        // Through the reader, and the stored-text decoder.
        let (e, _) = parse_bytes(
            b"#EXTM3U\n#EXTINF:-1,Caf\xc3\xa9 \xe9t\xe9\nhttp://s/1.ts\n",
            1,
        );
        assert_eq!(e[0].name, "Café été");
        assert_eq!(
            decode_playlist_text(b"#EXTINF:-1,Caf\xc3\xa9 \xe9t\xe9\n".to_vec()),
            "#EXTINF:-1,Café été\n"
        );
    }

    /// Review R2-3: UTF-16 without a byte order mark (NUL-interleaved
    /// `#EXTM3U`) is UTF-16 too.
    #[test]
    fn bomless_utf16_is_transcoded() {
        let text = "#EXTM3U\r\n#EXTINF:-1,Télé\r\nhttp://s/1.ts\r\n";
        for le in [true, false] {
            let bytes = utf16(text, le)[2..].to_vec();
            for cap in [1, 3, 64 * 1024] {
                let (e, _) = parse_bytes(&bytes, cap);
                assert_eq!(e.len(), 1, "le={le} cap={cap}");
                assert_eq!(e[0].name, "Télé");
                assert_eq!(e[0].url, "http://s/1.ts");
            }
            assert_eq!(utf16_text(&bytes).as_deref(), Some(text));
        }
        // A lone `#` line in UTF-8 is not UTF-16.
        assert_eq!(utf16_start(b'#', b'E'), None);
        let (e, _) = parse_bytes(b"#\nhttp://s/x.ts\n", 1);
        assert_eq!(e.len(), 1);
    }

    /// Review R2-8: the stored raw text decodes like the parser.
    #[test]
    fn decode_playlist_text_matches_the_reader() {
        let text = "#EXTM3U\n#EXTINF:-1,Télé\nhttp://s/1.ts\n";
        assert_eq!(decode_playlist_text(utf16(text, true)), text);
        assert_eq!(decode_playlist_text(utf16(text, false)), text);
        assert_eq!(decode_playlist_text(utf16(text, true)[2..].to_vec()), text);
        let mut bom = b"\xEF\xBB\xBF".to_vec();
        bom.extend_from_slice(text.as_bytes());
        assert_eq!(decode_playlist_text(bom), text);
        assert_eq!(
            decode_playlist_text(
                b"#EXTM3U\n#EXTINF:-1,Caf\xe9\n#EXTINF:-1,D\xc3\xa9j\xc3\xa0\n".to_vec()
            ),
            "#EXTM3U\n#EXTINF:-1,Café\n#EXTINF:-1,Déjà\n"
        );
    }
}
