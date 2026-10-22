//! Binary media and byte-range serving.
//!
//! [`serve_bytes`] is the one place that implements `Range`, `If-Range`,
//! `If-None-Match`, `ETag`, `Last-Modified`, throttling, and the "drop the
//! connection after N bytes" fault used by `/files/flaky.bin`. Everything
//! that serves bytes (sample media, segments, generated files) goes through
//! it, so Range behaves identically on every route.

use std::io;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;

/// 60 s H.264/AAC 320x180 colour bars with a 440 Hz tone (faststart MP4).
pub const SAMPLE_MP4: &[u8] = include_bytes!("../../../fixtures/sample.mp4");
/// The same clip as VP9/Opus WebM (plays in browsers without H.264).
pub const SAMPLE_WEBM: &[u8] = include_bytes!("../../../fixtures/sample.webm");
/// First 2 s H.264/AAC MPEG-TS segment of the live loop (`fixtures/hls/seg-00.ts`).
pub const SEG_TS: &[u8] = include_bytes!("../../../fixtures/seg.ts");
/// 20 s MP3 tone used as the radio stream.
pub const RADIO_MP3: &[u8] = include_bytes!("../../../fixtures/radio.mp3");

/// Declared HLS segment duration in seconds.
pub const SEGMENT_SECONDS: i64 = 2;

/// Fixed `Last-Modified` for every byte resource.
pub const LAST_MODIFIED: &str = "Thu, 01 Jan 2026 00:00:00 GMT";

/// Produces `len` bytes starting at `offset`.
pub type Producer = Box<dyn Fn(u64, usize) -> Bytes + Send + Sync + 'static>;

/// Options for [`serve_bytes`].
pub struct ServeOpts {
    pub content_type: &'static str,
    /// Strong ETag including quotes, or `None` to omit.
    pub etag: Option<String>,
    /// Honour `Range` (also controls `Accept-Ranges` and `Content-Length`
    /// presence: `false` streams chunked with no length).
    pub ranges: bool,
    /// Send `Content-Length`.
    pub content_length: bool,
    /// Throttle to this many KiB per second (0 = unthrottled).
    pub kbps: u64,
    /// Abort the connection after this many body bytes.
    pub fail_after: Option<u64>,
    /// `Content-Disposition` filename.
    pub filename: Option<String>,
}

impl ServeOpts {
    pub fn new(content_type: &'static str) -> Self {
        Self {
            content_type,
            etag: None,
            ranges: true,
            content_length: true,
            kbps: 0,
            fail_after: None,
            filename: None,
        }
    }

    pub fn etag(mut self, etag: impl Into<String>) -> Self {
        self.etag = Some(etag.into());
        self
    }
}

/// Outcome of parsing a `Range` header against a resource length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeOutcome {
    /// No (usable) range: serve everything.
    Full,
    /// Inclusive byte range.
    Partial(u64, u64),
    /// 416.
    Unsatisfiable,
}

/// Parses a single-range `bytes=` header. Multi-range requests are served
/// whole (allowed by RFC 9110); malformed headers are ignored.
pub fn parse_range(value: Option<&str>, len: u64) -> RangeOutcome {
    let Some(v) = value else {
        return RangeOutcome::Full;
    };
    let Some(spec) = v.trim().strip_prefix("bytes=") else {
        return RangeOutcome::Full;
    };
    if spec.contains(',') {
        return RangeOutcome::Full;
    }
    let Some((a, b)) = spec.trim().split_once('-') else {
        return RangeOutcome::Full;
    };
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        // Suffix range: last N bytes.
        let Ok(n) = b.parse::<u64>() else {
            return RangeOutcome::Full;
        };
        if n == 0 || len == 0 {
            return RangeOutcome::Unsatisfiable;
        }
        let n = n.min(len);
        return RangeOutcome::Partial(len - n, len - 1);
    }
    let Ok(start) = a.parse::<u64>() else {
        return RangeOutcome::Full;
    };
    if start >= len {
        return RangeOutcome::Unsatisfiable;
    }
    let end = if b.is_empty() {
        len - 1
    } else {
        match b.parse::<u64>() {
            Ok(e) if e >= start => e.min(len - 1),
            Ok(_) => return RangeOutcome::Full,
            Err(_) => return RangeOutcome::Full,
        }
    };
    RangeOutcome::Partial(start, end)
}

/// Serves `len` bytes produced by `producer`, honouring the request headers.
pub fn serve_bytes(headers: &HeaderMap, len: u64, producer: Producer, opts: ServeOpts) -> Response {
    let hv = |name: header::HeaderName| headers.get(name).and_then(|v| v.to_str().ok());

    if let (Some(tag), Some(inm)) = (&opts.etag, hv(header::IF_NONE_MATCH)) {
        if inm.split(',').any(|t| t.trim() == tag || t.trim() == "*") {
            let mut r = StatusCode::NOT_MODIFIED.into_response();
            set(&mut r, header::ETAG, tag);
            return r;
        }
    }

    let mut outcome = if opts.ranges {
        parse_range(hv(header::RANGE), len)
    } else {
        RangeOutcome::Full
    };
    if let (Some(if_range), Some(tag)) = (hv(header::IF_RANGE), &opts.etag) {
        if if_range.trim() != tag && if_range.trim() != LAST_MODIFIED {
            outcome = RangeOutcome::Full;
        }
    }

    let (status, start, end) = match outcome {
        RangeOutcome::Full => (StatusCode::OK, 0, len.saturating_sub(1)),
        RangeOutcome::Partial(s, e) => (StatusCode::PARTIAL_CONTENT, s, e),
        RangeOutcome::Unsatisfiable => {
            let mut r =
                (StatusCode::RANGE_NOT_SATISFIABLE, "range not satisfiable").into_response();
            set(&mut r, header::CONTENT_RANGE, &format!("bytes */{len}"));
            set(&mut r, header::ACCEPT_RANGES, "bytes");
            return r;
        }
    };
    let body_len = if len == 0 { 0 } else { end - start + 1 };

    let body = byte_stream(start, body_len, producer, opts.kbps, opts.fail_after);
    let mut r = Response::new(body);
    *r.status_mut() = status;
    set(&mut r, header::CONTENT_TYPE, opts.content_type);
    set(&mut r, header::LAST_MODIFIED, LAST_MODIFIED);
    set(&mut r, header::CACHE_CONTROL, "no-cache");
    if let Some(tag) = &opts.etag {
        set(&mut r, header::ETAG, tag);
    }
    if opts.ranges {
        set(&mut r, header::ACCEPT_RANGES, "bytes");
    }
    if opts.content_length {
        set(&mut r, header::CONTENT_LENGTH, &body_len.to_string());
    }
    if status == StatusCode::PARTIAL_CONTENT {
        set(
            &mut r,
            header::CONTENT_RANGE,
            &format!("bytes {start}-{end}/{len}"),
        );
    }
    if let Some(name) = &opts.filename {
        set(
            &mut r,
            header::CONTENT_DISPOSITION,
            &format!("attachment; filename=\"{name}\""),
        );
    }
    r
}

/// Serves a static byte slice with Range support.
pub fn serve_static(
    headers: &HeaderMap,
    data: &'static [u8],
    content_type: &'static str,
    etag: &str,
) -> Response {
    let producer: Producer =
        Box::new(move |o, n| Bytes::from_static(&data[o as usize..o as usize + n]));
    serve_bytes(
        headers,
        data.len() as u64,
        producer,
        ServeOpts::new(content_type).etag(etag),
    )
}

fn set(r: &mut Response, name: header::HeaderName, value: &str) {
    if let Ok(v) = HeaderValue::from_str(value) {
        r.headers_mut().insert(name, v);
    }
}

struct StreamState {
    pos: u64,
    end: u64,
    sent: u64,
    producer: Producer,
    kbps: u64,
    fail_after: Option<u64>,
    failed: bool,
}

fn byte_stream(
    start: u64,
    len: u64,
    producer: Producer,
    kbps: u64,
    fail_after: Option<u64>,
) -> Body {
    let chunk_size: u64 = if kbps > 0 { 16 * 1024 } else { 64 * 1024 };
    let state = StreamState {
        pos: start,
        end: start + len,
        sent: 0,
        producer,
        kbps,
        fail_after,
        failed: false,
    };
    let stream = futures::stream::unfold(state, move |mut st| async move {
        if st.failed || st.pos >= st.end {
            return None;
        }
        let mut n = chunk_size.min(st.end - st.pos);
        if let Some(limit) = st.fail_after {
            if st.sent >= limit {
                st.failed = true;
                let err = io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "iptv-mock: simulated connection drop",
                );
                return Some((Err(err), st));
            }
            n = n.min(limit - st.sent);
        }
        if st.kbps > 0 {
            let secs = n as f64 / (st.kbps as f64 * 1024.0);
            tokio::time::sleep(Duration::from_secs_f64(secs)).await;
        }
        let bytes = (st.producer)(st.pos, n as usize);
        st.pos += n;
        st.sent += n;
        Some((Ok::<Bytes, io::Error>(bytes), st))
    });
    Body::from_stream(stream)
}

/// Content type for a media file extension.
pub fn content_type_for(ext: &str) -> &'static str {
    match ext {
        "m3u8" => "application/vnd.apple.mpegurl",
        "ts" => "video/mp2t",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        _ => "video/mp4",
    }
}

/// Splits `"101.m3u8"` into `(101, "m3u8")`.
pub fn split_id_ext(file: &str) -> Option<(u64, &str)> {
    let (stem, ext) = file.rsplit_once('.').unwrap_or((file, ""));
    stem.parse::<u64>().ok().map(|id| (id, ext))
}

/// Number of distinct live segments (`fixtures/hls/seg-00.ts` ..
/// `seg-15.ts`): one continuous 32 s clip cut every 2 s.
pub const LOOP_SEGMENTS: u64 = 16;

/// The 16 segments of the live loop, in order.
pub const LIVE_SEGMENTS: [&[u8]; LOOP_SEGMENTS as usize] = [
    include_bytes!("../../../fixtures/hls/seg-00.ts"),
    include_bytes!("../../../fixtures/hls/seg-01.ts"),
    include_bytes!("../../../fixtures/hls/seg-02.ts"),
    include_bytes!("../../../fixtures/hls/seg-03.ts"),
    include_bytes!("../../../fixtures/hls/seg-04.ts"),
    include_bytes!("../../../fixtures/hls/seg-05.ts"),
    include_bytes!("../../../fixtures/hls/seg-06.ts"),
    include_bytes!("../../../fixtures/hls/seg-07.ts"),
    include_bytes!("../../../fixtures/hls/seg-08.ts"),
    include_bytes!("../../../fixtures/hls/seg-09.ts"),
    include_bytes!("../../../fixtures/hls/seg-10.ts"),
    include_bytes!("../../../fixtures/hls/seg-11.ts"),
    include_bytes!("../../../fixtures/hls/seg-12.ts"),
    include_bytes!("../../../fixtures/hls/seg-13.ts"),
    include_bytes!("../../../fixtures/hls/seg-14.ts"),
    include_bytes!("../../../fixtures/hls/seg-15.ts"),
];

/// 90 kHz ticks in one pass of the loop (32 s).
const LOOP_TICKS: u64 = LOOP_SEGMENTS * SEGMENT_SECONDS as u64 * 90_000;
/// PTS, DTS and PCR base are 33-bit counters.
const TS_MASK: u64 = (1 << 33) - 1;

fn read_ts(b: &[u8]) -> u64 {
    (((b[0] as u64) >> 1) & 0x07) << 30
        | (b[1] as u64) << 22
        | ((b[2] as u64) >> 1) << 15
        | (b[3] as u64) << 7
        | (b[4] as u64) >> 1
}

fn write_ts(b: &mut [u8], ts: u64) {
    b[0] = (b[0] & 0xF0) | (((ts >> 29) as u8) & 0x0E) | 1;
    b[1] = (ts >> 22) as u8;
    b[2] = (((ts >> 14) as u8) & 0xFE) | 1;
    b[3] = (ts >> 7) as u8;
    b[4] = (((ts << 1) as u8) & 0xFE) | 1;
}

/// Shifts every PES PTS/DTS and every PCR in an MPEG-TS buffer by `offset`
/// 90 kHz ticks (modulo 2^33). Packets that do not parse are left alone.
pub fn retime_ts(src: &[u8], offset: u64) -> Vec<u8> {
    let mut out = src.to_vec();
    for pkt in out.as_chunks_mut::<188>().0 {
        if pkt[0] != 0x47 {
            continue;
        }
        let pusi = pkt[1] & 0x40 != 0;
        let afc = (pkt[3] >> 4) & 0x03;
        let mut idx = 4usize;
        if afc & 0x02 != 0 {
            let alen = pkt[4] as usize;
            if alen >= 7 && 5 + alen <= 188 && pkt[5] & 0x10 != 0 {
                let base = (pkt[6] as u64) << 25
                    | (pkt[7] as u64) << 17
                    | (pkt[8] as u64) << 9
                    | (pkt[9] as u64) << 1
                    | (pkt[10] as u64) >> 7;
                let nb = (base + offset) & TS_MASK;
                pkt[6] = (nb >> 25) as u8;
                pkt[7] = (nb >> 17) as u8;
                pkt[8] = (nb >> 9) as u8;
                pkt[9] = (nb >> 1) as u8;
                pkt[10] = (pkt[10] & 0x7F) | (((nb & 1) as u8) << 7);
            }
            idx = 5 + alen;
        }
        if afc & 0x01 == 0 || !pusi || idx + 19 > 188 {
            continue;
        }
        let pes = &mut pkt[idx..];
        if pes[0] != 0 || pes[1] != 0 || pes[2] != 1 {
            continue;
        }
        let flags = pes[7] >> 6;
        if flags & 0x02 != 0 {
            let pts = read_ts(&pes[9..14]);
            write_ts(&mut pes[9..14], (pts + offset) & TS_MASK);
        }
        if flags == 0x03 {
            let dts = read_ts(&pes[14..19]);
            write_ts(&mut pes[14..19], (dts + offset) & TS_MASK);
        }
    }
    out
}

/// Live segment `n` of the endless stream: loop segment `n % 16`, shifted
/// so timestamps keep increasing across passes. Consecutive `n` play as one
/// continuous stream with no discontinuity.
pub fn live_segment(n: u64) -> Vec<u8> {
    let pass = n / LOOP_SEGMENTS;
    let offset = ((pass & TS_MASK) * LOOP_TICKS) & TS_MASK;
    retime_ts(LIVE_SEGMENTS[(n % LOOP_SEGMENTS) as usize], offset)
}

/// One pass of the loop (32 s) as a single MPEG-TS body, for archive
/// (`timeshift`) `.ts` URLs.
pub fn live_loop_ts() -> Vec<u8> {
    LIVE_SEGMENTS.concat()
}

/// Serves an owned buffer with Range support.
pub fn serve_owned(
    headers: &HeaderMap,
    data: Vec<u8>,
    content_type: &'static str,
    etag: String,
) -> Response {
    let data = Bytes::from(data);
    let len = data.len() as u64;
    let producer: Producer = Box::new(move |o, n| data.slice(o as usize..o as usize + n));
    serve_bytes(
        headers,
        len,
        producer,
        ServeOpts::new(content_type).etag(etag),
    )
}

/// A live sliding-window HLS playlist: the three 2 s segments ending at
/// `now`, pointing at `/xtream/seg/{n}.ts`. The media sequence advances by
/// one every 2 s. Segments are re-timestamped into one continuous stream
/// (see [`live_segment`]), so there are no `#EXT-X-DISCONTINUITY` tags and
/// the discontinuity sequence stays 0.
pub fn live_playlist(base: &str, now: i64) -> String {
    let seq = (now / SEGMENT_SECONDS).max(3) - 3;
    let mut out = format!(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:{SEGMENT_SECONDS}\n#EXT-X-MEDIA-SEQUENCE:{seq}\n#EXT-X-DISCONTINUITY-SEQUENCE:0\n"
    );
    for n in seq..seq + 3 {
        out.push_str(&format!(
            "#EXT-X-PROGRAM-DATE-TIME:{}\n#EXTINF:{SEGMENT_SECONDS}.000,\n{base}/xtream/seg/{n}.ts\n",
            crate::catalog::utc(n * SEGMENT_SECONDS).format("%Y-%m-%dT%H:%M:%S%.3fZ")
        ));
    }
    out
}

/// A finished (VOD) HLS playlist of `segments` continuous segments, used for
/// timeshift and `.m3u8` VOD URLs.
pub fn vod_playlist(base: &str, segments: u32) -> String {
    let mut out = format!(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:{SEGMENT_SECONDS}\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n"
    );
    for n in 0..segments {
        out.push_str(&format!(
            "#EXTINF:{SEGMENT_SECONDS}.000,\n{base}/xtream/seg/{n}.ts\n"
        ));
    }
    out.push_str("#EXT-X-ENDLIST\n");
    out
}

/// HLS playlist response.
pub fn m3u8_response(body: String) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parsing() {
        use RangeOutcome::*;
        assert_eq!(parse_range(None, 100), Full);
        assert_eq!(parse_range(Some("bytes=0-9"), 100), Partial(0, 9));
        assert_eq!(parse_range(Some("bytes=90-"), 100), Partial(90, 99));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Partial(90, 99));
        assert_eq!(parse_range(Some("bytes=-1000"), 100), Partial(0, 99));
        assert_eq!(parse_range(Some("bytes=50-5000"), 100), Partial(50, 99));
        assert_eq!(parse_range(Some("bytes=100-"), 100), Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), Full);
        assert_eq!(parse_range(Some("items=0-1"), 100), Full);
        assert_eq!(parse_range(Some("bytes=9-3"), 100), Full);
    }

    #[test]
    fn media_fixtures_are_real_containers() {
        assert_eq!(&SAMPLE_MP4[4..8], b"ftyp");
        assert_eq!(SEG_TS[0], 0x47, "MPEG-TS sync byte");
        assert_eq!(SEG_TS.len() % 188, 0);
        assert_eq!(&SAMPLE_WEBM[..4], &[0x1A, 0x45, 0xDF, 0xA3]);
    }

    #[test]
    fn live_playlist_has_three_segments() {
        let p = live_playlist("http://h", 1_000);
        assert_eq!(p.matches("#EXTINF").count(), 3);
        assert!(p.contains("#EXT-X-MEDIA-SEQUENCE:497"));
        assert!(p.contains("http://h/xtream/seg/499.ts"));
        assert!(!p.contains("ENDLIST"));
        assert!(!p.contains("#EXT-X-DISCONTINUITY\n"));
        assert!(p.contains("#EXT-X-DISCONTINUITY-SEQUENCE:0"));
        assert!(live_playlist("http://h", 1_002).contains("#EXT-X-MEDIA-SEQUENCE:498"));
    }

    fn pts_list(ts: &[u8]) -> Vec<u64> {
        let mut v = Vec::new();
        for pkt in ts.as_chunks::<188>().0 {
            let afc = (pkt[3] >> 4) & 3;
            let idx = if afc & 2 != 0 { 5 + pkt[4] as usize } else { 4 };
            if pkt[1] & 0x40 != 0
                && afc & 1 != 0
                && idx + 14 <= 188
                && pkt[idx..idx + 3] == [0, 0, 1]
                && pkt[idx + 7] & 0x80 != 0
            {
                v.push(read_ts(&pkt[idx + 9..idx + 14]));
            }
        }
        v
    }

    #[test]
    fn segments_have_increasing_timestamps_across_the_loop() {
        let first = |n: u64| pts_list(&live_segment(n))[0];
        // 2 s apart within a pass and across the wrap.
        for n in [0u64, 7, 14, 15, 16, 31, 1_000_000] {
            let d = (first(n + 1) + (1 << 33) - first(n)) & TS_MASK;
            assert!((178_000..=182_000).contains(&d), "segment {n}: step {d}");
        }
        assert_eq!(retime_ts(LIVE_SEGMENTS[3], 0), LIVE_SEGMENTS[3]);
        assert_eq!(SEG_TS, LIVE_SEGMENTS[0]);
    }
}
