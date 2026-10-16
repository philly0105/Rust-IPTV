//! Guards for reading a playlist download body: a minimum average throughput,
//! so a server that drips a byte every few seconds (which keeps resetting the
//! idle timeout) cannot hold an import open forever.

use crate::error::{CoreError, CoreResult};
use std::time::{Duration, Instant};

/// Length of one throughput window.
#[cfg(not(test))]
pub const MIN_RATE_WINDOW: Duration = Duration::from_secs(60);
#[cfg(test)]
pub const MIN_RATE_WINDOW: Duration = Duration::from_secs(2);
/// Average bytes per second a download must reach over each window.
pub const MIN_RATE_BYTES_PER_SEC: u64 = 1024;

/// Fails a download whose body averaged under `bytes_per_sec` over a whole
/// window. Windows are consecutive: each starts when the previous one ended.
pub struct MinRate {
    window: Duration,
    bytes_per_sec: u64,
    since: Instant,
    bytes: u64,
}

impl MinRate {
    pub fn new(window: Duration, bytes_per_sec: u64) -> Self {
        Self {
            window,
            bytes_per_sec,
            since: Instant::now(),
            bytes: 0,
        }
    }

    /// [`MIN_RATE_WINDOW`] at [`MIN_RATE_BYTES_PER_SEC`].
    pub fn standard() -> Self {
        Self::new(MIN_RATE_WINDOW, MIN_RATE_BYTES_PER_SEC)
    }

    /// Records `n` bytes that just arrived from `host`. Errors with `Timeout`
    /// once a whole window passed below the minimum rate.
    pub fn on_bytes(&mut self, n: usize, host: &str) -> CoreResult<()> {
        self.bytes += n as u64;
        let elapsed = self.since.elapsed();
        if elapsed < self.window {
            return Ok(());
        }
        let needed = self.bytes_per_sec.saturating_mul(elapsed.as_secs().max(1));
        if self.bytes < needed {
            return Err(CoreError::Timeout(format!(
                "{host} is sending the playlist too slowly (under {} KB/s for {} s). Check your connection and that the server is online, then try again later.",
                (self.bytes_per_sec / 1024).max(1),
                elapsed.as_secs()
            )));
        }
        self.since = Instant::now();
        self.bytes = 0;
        Ok(())
    }
}

/// Largest playlist download accepted. Real lists stay far below this (500k
/// channels is about 80 MB); anything bigger is a stream or a wrong URL.
pub const MAX_PLAYLIST_BYTES: u64 = 1024 * 1024 * 1024;
/// Bytes collected from the start of a playlist download before [`sniff`]
/// judges them.
pub const SNIFF_BYTES: usize = 4096;

/// The error for a playlist download over [`MAX_PLAYLIST_BYTES`].
pub fn too_large_error(host: &str) -> CoreError {
    CoreError::Invalid(format!(
        "{host} sent more than {} MB for the playlist, which is too large to be a channel list. Check that the URL points at an M3U playlist, not a video stream or file.",
        MAX_PLAYLIST_BYTES / (1024 * 1024)
    ))
}

/// Looks at the first bytes of a playlist download (and its content type) and
/// returns an actionable `Invalid` error when they are clearly not a channel
/// list: a video stream (MPEG-TS, HLS segment playlist, `video/*`), other
/// binary data, or a web page (often a login or error page). `None` lets the
/// import continue; the parser makes the final call.
///
/// UTF-16 (a `FF FE` / `FE FF` byte order mark, or a NUL-interleaved
/// `#EXTM3U`) is transcoded before any check, so its NUL bytes are not taken
/// for binary data. A gzip head (`1F 8B`: a compressed playlist served
/// without `Content-Encoding`, the parser decompresses it) is judged by the
/// bytes it decompresses to, whatever the content type says.
pub fn sniff(head: &[u8], content_type: Option<&str>, host: &str) -> Option<CoreError> {
    if crate::m3u::parser::is_gzip(head) {
        let text = gunzip_head(head);
        if text.is_empty() {
            return Some(CoreError::Invalid(format!(
                "{host} sent a compressed file that could not be unpacked, not an M3U playlist. Check the playlist URL."
            )));
        }
        // The content type describes the compressed bytes.
        return sniff_plain(&text, None, host);
    }
    sniff_plain(head, content_type, host)
}

/// The first [`SNIFF_BYTES`] that the start of a gzip stream decompresses to
/// (the head is cut, so decoding stops with an error at its end).
fn gunzip_head(head: &[u8]) -> Vec<u8> {
    use std::io::Read;
    let mut out = Vec::new();
    let mut d = flate2::read::MultiGzDecoder::new(head);
    let mut buf = [0u8; 1024];
    while out.len() < SNIFF_BYTES {
        match d.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
        }
    }
    out.truncate(SNIFF_BYTES);
    out
}

fn sniff_plain(head: &[u8], content_type: Option<&str>, host: &str) -> Option<CoreError> {
    match crate::m3u::parser::utf16_text(head) {
        Some(text) => sniff_text(text.as_bytes(), content_type, host),
        None => sniff_text(head, content_type, host),
    }
}

fn sniff_text(head: &[u8], content_type: Option<&str>, host: &str) -> Option<CoreError> {
    let body = head.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(head);
    let body = body.trim_ascii_start();
    let has_extm3u = body.len() >= 7 && body[..7].eq_ignore_ascii_case(b"#EXTM3U");
    let stream = |what: &str| {
        Some(CoreError::Invalid(format!(
            "{host} sent {what}, not a channel list. This URL looks like a single channel; add the playlist URL from your provider instead."
        )))
    };
    if body.first() == Some(&0x47) && (body.len() < 189 || body[188] == 0x47) && !has_extm3u {
        return stream("an MPEG-TS video stream");
    }
    let ct = content_type
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !has_extm3u
        && (ct.starts_with("video/") || (ct == "application/octet-stream" && is_binary(body)))
    {
        return stream("video data");
    }
    if has_extm3u {
        let text = String::from_utf8_lossy(body);
        let hls = text.contains("#EXT-X-TARGETDURATION") || text.contains("#EXT-X-STREAM-INF");
        let iptv = text.contains("tvg-") || text.contains("group-title");
        if hls && !iptv {
            return stream("an HLS stream playlist");
        }
        return None;
    }
    if is_binary(body) {
        return Some(CoreError::Invalid(format!(
            "{host} sent binary data, not an M3U playlist. Check the playlist URL."
        )));
    }
    let lower = String::from_utf8_lossy(&body[..body.len().min(512)]).to_ascii_lowercase();
    if lower.starts_with("<!doctype html") || lower.starts_with("<html") || lower.contains("<html")
    {
        return Some(CoreError::Invalid(format!(
            "{host} answered with a web page instead of a playlist (often a login or error page). Check the playlist URL and that your subscription is active."
        )));
    }
    None
}

/// NUL bytes or many control characters in the first 512 bytes.
fn is_binary(b: &[u8]) -> bool {
    let sample = &b[..b.len().min(512)];
    if sample.contains(&0) {
        return true;
    }
    let ctrl = sample
        .iter()
        .filter(|&&c| c < 0x09 || (0x0e..0x20).contains(&c))
        .count();
    !sample.is_empty() && ctrl * 10 > sample.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_rejects_streams_pages_and_binary() {
        let mut ts = vec![0u8; 400];
        ts[0] = 0x47;
        ts[188] = 0x47;
        let e = sniff(&ts, Some("video/mp2t"), "h").unwrap();
        assert!(
            matches!(e, CoreError::Invalid(ref m) if m.contains("MPEG-TS") && m.contains("playlist URL")),
            "{e:?}"
        );
        let hls = b"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg1.ts\n";
        let e = sniff(hls, Some("application/vnd.apple.mpegurl"), "h").unwrap();
        assert!(e.to_string().contains("HLS stream"), "{e}");
        assert!(sniff(b"ID3\x03\x00\x00", Some("video/mp4"), "h").is_some());
        let e = sniff(b"\x00\x01\x02binary", None, "h").unwrap();
        assert!(e.to_string().contains("binary data"), "{e}");
        let e = sniff(
            b"<!DOCTYPE html><html><body>Login</body></html>",
            Some("text/html"),
            "h",
        )
        .unwrap();
        assert!(e.to_string().contains("web page"), "{e}");
    }

    #[test]
    fn sniff_accepts_playlists() {
        let ok = "\u{feff}  #EXTM3U x-tvg-url=\"http://e/g.xml\"\n#EXTINF:-1 tvg-id=\"a\" group-title=\"News\",A\nhttp://h/a.ts\n";
        assert!(sniff(ok.as_bytes(), Some("video/mp2t"), "h").is_none());
        // Headerless lists and odd content types are left to the parser.
        assert!(sniff(b"#EXTINF:-1,A\nhttp://h/a\n", Some("text/plain"), "h").is_none());
        assert!(sniff(b"#extm3u\n", Some("application/octet-stream"), "h").is_none());
        // An IPTV list that happens to carry HLS tags is still a list.
        let mixed =
            b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXTINF:-1 group-title=\"G\",A\nhttp://a\n";
        assert!(sniff(mixed, None, "h").is_none());
        assert!(too_large_error("h").to_string().contains("too large"));
    }

    /// Review R2-3: a UTF-16 playlist added by URL was rejected as binary
    /// (every other byte is NUL).
    #[test]
    fn sniff_accepts_utf16_playlists() {
        let text = "#EXTM3U\r\n#EXTINF:-1 group-title=\"News\",A\r\nhttp://h/a.ts\r\n";
        for le in [true, false] {
            let mut bom = if le {
                vec![0xFF, 0xFE]
            } else {
                vec![0xFE, 0xFF]
            };
            for u in text.encode_utf16() {
                bom.extend(if le { u.to_le_bytes() } else { u.to_be_bytes() });
            }
            for ct in [
                None,
                Some("application/octet-stream"),
                Some("audio/x-mpegurl"),
            ] {
                assert!(sniff(&bom, ct, "h").is_none(), "le={le} {ct:?}");
                assert!(
                    sniff(&bom[2..], ct, "h").is_none(),
                    "no BOM, le={le} {ct:?}"
                );
                // A head cut mid code unit.
                assert!(sniff(&bom[..bom.len() - 1], ct, "h").is_none());
            }
        }
        // A UTF-16 web page is still a web page.
        let mut page = vec![0xFF, 0xFE];
        for u in "<!DOCTYPE html><html>".encode_utf16() {
            page.extend(u.to_le_bytes());
        }
        assert!(sniff(&page, None, "h")
            .unwrap()
            .to_string()
            .contains("web page"));
    }

    #[test]
    fn slow_window_fails_and_fast_window_resets() {
        let mut r = MinRate::new(Duration::from_millis(0), 1024);
        // A zero-length window is judged as one second.
        assert!(r.on_bytes(2048, "h").is_ok());
        let err = r.on_bytes(10, "h").unwrap_err();
        assert!(
            matches!(err, CoreError::Timeout(ref m) if m.contains("too slowly") && m.contains("try again")),
            "{err:?}"
        );
        let mut r = MinRate::new(Duration::from_secs(3600), 1024);
        assert!(r.on_bytes(1, "h").is_ok(), "window not over yet");
    }
}
