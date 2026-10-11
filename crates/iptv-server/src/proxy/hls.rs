//! Streaming HLS playlist rewriter.
//!
//! Every URI line and every `URI="..."` attribute (EXT-X-KEY, EXT-X-MAP,
//! EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF, EXT-X-SESSION-KEY, EXT-X-PART,
//! EXT-X-PRELOAD-HINT, EXT-X-RENDITION-REPORT, ...) is resolved against the
//! playlist's final URL and replaced with `/api/proxy?url=<abs>&sourceId=<id>`.
//! Non-HTTP URIs (`data:`, `skd:`) are left alone. The rewriter works line by
//! line on chunks as they arrive, so a playlist is never buffered whole.

use bytes::Bytes;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use std::borrow::Cow;
use std::io;
use url::Url;

/// Characters left unescaped in query values (RFC 3986 unreserved).
const QUERY_VALUE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// Longest line accepted before the stream is aborted.
pub const MAX_LINE: usize = 1024 * 1024;

/// `/api/proxy?url=<abs>[&sourceId=<id>]`.
pub fn proxy_path(absolute: &str, source_id: Option<&str>) -> String {
    let mut out = format!(
        "/api/proxy?url={}",
        utf8_percent_encode(absolute, QUERY_VALUE)
    );
    if let Some(id) = source_id.filter(|s| !s.is_empty()) {
        out.push_str("&sourceId=");
        out.extend(utf8_percent_encode(id, QUERY_VALUE));
    }
    out
}

/// True for HLS playlist content types (`application/vnd.apple.mpegurl`,
/// `application/x-mpegurl`, `audio/mpegurl`, `audio/x-mpegurl`).
pub fn is_playlist_content_type(content_type: &str) -> bool {
    content_type.to_ascii_lowercase().contains("mpegurl")
}

/// True when the bytes start like an M3U playlist (after a BOM and whitespace).
pub fn looks_like_playlist(prefix: &[u8]) -> bool {
    let p = prefix.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(prefix);
    let start = p
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(p.len());
    p[start..].starts_with(b"#EXTM3U")
}

/// Incremental playlist rewriter.
pub struct HlsRewriter {
    base: Url,
    source_id: Option<String>,
    pending: Vec<u8>,
}

impl HlsRewriter {
    /// `base` is the URL the playlist was finally fetched from (after redirects).
    pub fn new(base: Url, source_id: Option<String>) -> Self {
        Self {
            base,
            source_id: source_id.filter(|s| !s.is_empty()),
            pending: Vec::new(),
        }
    }

    /// Feeds a chunk; returns the rewritten complete lines it finished.
    pub fn push(&mut self, chunk: &[u8]) -> io::Result<Bytes> {
        self.pending.extend_from_slice(chunk);
        let Some(last_nl) = self.pending.iter().rposition(|&b| b == b'\n') else {
            if self.pending.len() > MAX_LINE {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "playlist line exceeds 1 MiB",
                ));
            }
            return Ok(Bytes::new());
        };
        let complete: Vec<u8> = self.pending.drain(..=last_nl).collect();
        Ok(self.rewrite_block(&complete))
    }

    /// Flushes the final line (a playlist may lack a trailing newline).
    pub fn finish(&mut self) -> Bytes {
        let rest = std::mem::take(&mut self.pending);
        self.rewrite_block(&rest)
    }

    fn rewrite_block(&self, block: &[u8]) -> Bytes {
        if block.is_empty() {
            return Bytes::new();
        }
        // Blocks end on '\n', which never splits a UTF-8 sequence.
        let text = String::from_utf8_lossy(block);
        let mut out = String::with_capacity(text.len() + text.len() / 2);
        for piece in text.split_inclusive('\n') {
            let (line, ending) = if let Some(l) = piece.strip_suffix("\r\n") {
                (l, "\r\n")
            } else if let Some(l) = piece.strip_suffix('\n') {
                (l, "\n")
            } else {
                (piece, "")
            };
            out.push_str(&self.rewrite_line(line));
            out.push_str(ending);
        }
        Bytes::from(out)
    }

    /// Rewrites one line (without its line ending).
    pub fn rewrite_line<'a>(&self, line: &'a str) -> Cow<'a, str> {
        let trimmed = line.trim().trim_start_matches('\u{feff}');
        if trimmed.is_empty() {
            return Cow::Borrowed(line);
        }
        if trimmed.starts_with('#') {
            if trimmed.starts_with("#EXT") && trimmed.contains("URI=\"") {
                return Cow::Owned(self.rewrite_uri_attributes(line));
            }
            return Cow::Borrowed(line);
        }
        match self.proxied(trimmed) {
            Some(p) => Cow::Owned(p),
            None => Cow::Borrowed(line),
        }
    }

    /// Replaces the value of every `URI="..."` attribute in a tag line.
    fn rewrite_uri_attributes(&self, line: &str) -> String {
        let mut out = String::with_capacity(line.len() + 64);
        let mut rest = line;
        while let Some(idx) = rest.find("URI=\"") {
            // Only a whole attribute name: preceded by ':' (first attribute) or ','.
            let at_boundary = rest[..idx]
                .chars()
                .next_back()
                .is_some_and(|c| c == ':' || c == ',' || c.is_whitespace());
            let value_start = idx + 5;
            let Some(len) = rest[value_start..].find('"') else {
                break; // unterminated quote: leave the remainder untouched
            };
            let value = &rest[value_start..value_start + len];
            out.push_str(&rest[..value_start]);
            match self.proxied(value.trim()).filter(|_| at_boundary) {
                Some(p) => out.push_str(&p),
                None => out.push_str(value),
            }
            out.push('"');
            rest = &rest[value_start + len + 1..];
        }
        out.push_str(rest);
        out
    }

    /// Proxy path for a URI, or `None` when it is empty, unresolvable, or not HTTP(S).
    pub fn proxied(&self, uri: &str) -> Option<String> {
        if uri.is_empty() {
            return None;
        }
        let abs = self.base.join(uri).ok()?;
        if !matches!(abs.scheme(), "http" | "https") {
            return None;
        }
        Some(proxy_path(abs.as_str(), self.source_id.as_deref()))
    }
}

/// Rewrites a whole playlist in one go (tests and small bodies).
pub fn rewrite_playlist(text: &str, base: &Url, source_id: Option<&str>) -> String {
    let mut rw = HlsRewriter::new(base.clone(), source_id.map(str::to_owned));
    let mut out = Vec::new();
    out.extend_from_slice(&rw.push(text.as_bytes()).unwrap_or_default());
    out.extend_from_slice(&rw.finish());
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("http://cdn.example.com/live/chan/index.m3u8?token=a b").unwrap()
    }

    fn decode(p: &str) -> String {
        let q = p.strip_prefix("/api/proxy?url=").unwrap();
        let enc = q.split('&').next().unwrap();
        percent_encoding::percent_decode_str(enc)
            .decode_utf8()
            .unwrap()
            .into_owned()
    }

    #[test]
    fn rewrites_media_playlist() {
        let src = "#EXTM3U\r\n#EXT-X-VERSION:7\r\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1\r\n#EXT-X-MAP:URI=\"/init.mp4\"\r\n#EXTINF:2.0,\r\nseg1.ts\r\n#EXTINF:2.0,\r\nhttps://other.example/seg2.ts?x=1&y=2\r\n#EXT-X-ENDLIST";
        let out = rewrite_playlist(src, &base(), Some("src 1"));
        let lines: Vec<&str> = out.split("\r\n").collect();
        assert_eq!(lines[0], "#EXTM3U");
        assert_eq!(lines[1], "#EXT-X-VERSION:7");
        assert!(lines[2].starts_with("#EXT-X-KEY:METHOD=AES-128,URI=\"/api/proxy?url="));
        assert!(lines[2].ends_with("&sourceId=src%201\",IV=0x1"));
        let key = lines[2].split('"').nth(1).unwrap();
        assert_eq!(decode(key), "http://cdn.example.com/live/chan/key.bin");
        let map = lines[3].split('"').nth(1).unwrap();
        assert_eq!(decode(map), "http://cdn.example.com/init.mp4");
        assert_eq!(decode(lines[5]), "http://cdn.example.com/live/chan/seg1.ts");
        assert_eq!(decode(lines[7]), "https://other.example/seg2.ts?x=1&y=2");
        assert_eq!(lines[8], "#EXT-X-ENDLIST");
    }

    #[test]
    fn rewrites_master_playlist_media_tags() {
        let src = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"en\",URI=\"audio/en.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO=\"aud\"\nlow/index.m3u8\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI=\"iframe.m3u8\"\n";
        let out = rewrite_playlist(src, &base(), None);
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines[1].contains("GROUP-ID=\"aud\",NAME=\"en\",URI=\"/api/proxy?url="));
        assert!(!lines[1].contains("sourceId"));
        assert_eq!(
            decode(
                lines[1]
                    .rsplit("URI=\"")
                    .next()
                    .unwrap()
                    .trim_end_matches('"')
            ),
            "http://cdn.example.com/live/chan/audio/en.m3u8"
        );
        assert_eq!(lines[2], "#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO=\"aud\"");
        assert_eq!(
            decode(lines[3]),
            "http://cdn.example.com/live/chan/low/index.m3u8"
        );
        assert!(lines[4].contains("URI=\"/api/proxy?url="));
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn leaves_non_http_uris_and_comments() {
        let src = "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://key-id\"\n#EXT-X-CUSTOM:XURI=\"keep.ts\"\n# plain comment with URI=\"x\"\ndata:video/mp2t;base64,AAAA\n";
        let out = rewrite_playlist(src, &base(), Some("s"));
        assert!(out.contains("URI=\"skd://key-id\""));
        assert!(out.contains("XURI=\"keep.ts\""));
        assert!(out.contains("# plain comment with URI=\"x\""));
        assert!(out.contains("data:video/mp2t;base64,AAAA"));
    }

    #[test]
    fn streaming_chunks_match_whole() {
        let src = "#EXTM3U\n#EXTINF:2,\nseg-ä1.ts\n#EXTINF:2,\nseg2.ts\n";
        let whole = rewrite_playlist(src, &base(), Some("s"));
        for split in 1..src.len() {
            if !src.is_char_boundary(split) {
                continue;
            }
            let mut rw = HlsRewriter::new(base(), Some("s".into()));
            let mut out = Vec::new();
            out.extend_from_slice(&rw.push(&src.as_bytes()[..split]).unwrap());
            out.extend_from_slice(&rw.push(&src.as_bytes()[split..]).unwrap());
            out.extend_from_slice(&rw.finish());
            assert_eq!(String::from_utf8(out).unwrap(), whole, "split at {split}");
        }
    }

    #[test]
    fn overlong_line_errors() {
        let mut rw = HlsRewriter::new(base(), None);
        assert!(rw.push(&vec![b'a'; MAX_LINE + 1]).is_err());
    }

    #[test]
    fn detection() {
        assert!(is_playlist_content_type("application/vnd.apple.mpegurl"));
        assert!(is_playlist_content_type("Audio/X-MPEGURL; charset=utf-8"));
        assert!(!is_playlist_content_type("video/mp2t"));
        assert!(looks_like_playlist(b"\xEF\xBB\xBF\r\n#EXTM3U\n"));
        assert!(!looks_like_playlist(b"\x47\x40\x00"));
    }
}
