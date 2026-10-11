//! Streaming M3U / M3U8 parser over any `BufRead`.
//!
//! [`M3uReader`] is an iterator of [`M3uEntry`]. It reads one line at a time
//! into a reused buffer (lines longer than [`MAX_LINE`] are truncated and
//! counted as skipped), so memory stays flat no matter how large the playlist
//! is. Edge cases handled (mined from the old app's parser and real lists):
//!
//! - UTF-8 BOM, CRLF / CR-less files, blank lines, leading junk before `#EXTM3U`,
//!   several `#EXTM3U` lines (concatenated playlists), non-UTF-8 bytes (lossy).
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

use std::io::BufRead;

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
    /// Bytes read from the underlying reader.
    pub bytes: u64,
}

/// Streaming M3U reader. Iterate to get entries; read [`M3uReader::header`]
/// and [`M3uReader::stats`] afterwards (header attrs can appear on later lines
/// in concatenated playlists).
pub struct M3uReader<R: BufRead> {
    reader: R,
    buf: Vec<u8>,
    header: M3uHeader,
    stats: ParseStats,
    pending: Option<M3uEntry>,
    pending_kodi: Vec<(String, String)>,
    first_line: bool,
    done: bool,
    io_error: Option<std::io::Error>,
}

impl<R: BufRead> M3uReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            buf: Vec::with_capacity(1024),
            header: M3uHeader::default(),
            stats: ParseStats::default(),
            pending: None,
            pending_kodi: Vec::new(),
            first_line: true,
            done: false,
            io_error: None,
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
    /// most `MAX_LINE` bytes. Returns `Ok(None)` at EOF and `Ok(Some(true))`
    /// when the line was truncated.
    fn read_line(&mut self) -> std::io::Result<Option<bool>> {
        self.buf.clear();
        let mut truncated = false;
        let mut any = false;
        loop {
            let available = match self.reader.fill_buf() {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            if available.is_empty() {
                return Ok(if any { Some(truncated) } else { None });
            }
            any = true;
            let (chunk, found, used) = match memchr::memchr(b'\n', available) {
                Some(i) => (&available[..i], true, i + 1),
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
            let upper_prefix: String = rest
                .chars()
                .take(10)
                .collect::<String>()
                .to_ascii_uppercase();
            if upper_prefix.starts_with("EXTM3U") {
                self.stats.saw_header = true;
                self.parse_header(&rest[6..]);
            } else if upper_prefix.starts_with("EXTINF:") {
                self.finish_pending_as_skipped();
                let mut entry = parse_extinf(&rest[7..]);
                entry.line = self.stats.lines;
                entry.kodi_props.append(&mut self.pending_kodi);
                self.pending = Some(entry);
            } else if upper_prefix.starts_with("EXTGRP:") {
                let v = rest[7..].trim().trim_matches('"').trim();
                if let Some(p) = self.pending.as_mut() {
                    if !v.is_empty() {
                        p.group = Some(v.to_string());
                    }
                }
            } else if upper_prefix.starts_with("EXTVLCOPT:") {
                if let Some((k, v)) = split_kv(&rest[10..]) {
                    if let Some(p) = self.pending.as_mut() {
                        apply_header_opt(p, &k, &v);
                        p.vlc_opts.push((k, v));
                    }
                }
            } else if upper_prefix.starts_with("KODIPROP:") {
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
                finalize_name(&mut entry);
                self.stats.entries += 1;
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
                finalize_name(&mut entry);
                self.stats.entries += 1;
                Some(entry)
            }
            None => {
                self.stats.skipped += 1;
                None
            }
        }
    }

    fn parse_header(&mut self, rest: &str) {
        let (attrs, _) = parse_attrs(rest);
        for (k, v) in attrs {
            if matches!(k.as_str(), "url-tvg" | "x-tvg-url" | "tvg-url") {
                for url in extract_urls(&v) {
                    if !self.header.epg_urls.contains(&url) {
                        self.header.epg_urls.push(url);
                    }
                }
            }
            if !self.header.attrs.iter().any(|(ek, _)| *ek == k) {
                self.header.attrs.push((k, v));
            }
        }
    }
}

impl<R: BufRead> Iterator for M3uReader<R> {
    type Item = M3uEntry;

    fn next(&mut self) -> Option<M3uEntry> {
        while !self.done {
            match self.read_line() {
                Ok(Some(truncated)) => {
                    self.stats.lines += 1;
                    if truncated {
                        tracing::debug!(
                            line = self.stats.lines,
                            "m3u line longer than {MAX_LINE} bytes truncated"
                        );
                    }
                    let buf = std::mem::take(&mut self.buf);
                    let text = String::from_utf8_lossy(&buf);
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
    let bytes = s.as_bytes();
    let mut attrs = Vec::new();
    let mut i = 0;
    let n = bytes.len();
    while i < n {
        let c = bytes[i];
        if c == b',' {
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
                while k < n && !bytes[k].is_ascii_whitespace() && bytes[k] != b',' {
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
    let duration = rest[..dur_end].parse::<f64>().ok();
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
                        .or_else(|| v.trim().parse::<f64>().ok().map(|f| f as i64))
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
    for token in value.split(|c: char| c == ',' || c == ';' || c.is_whitespace()) {
        let t = token.trim().trim_matches(|c| c == '"' || c == '\'');
        let lower = t.to_ascii_lowercase();
        if (lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("file://"))
            && t.len() > 8
            && !out.iter().any(|u: &String| u == t)
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
}
