//! Failure modes for tests and e2e: slow, refused, missing, malformed and
//! oversized answers. Every route lives under `/fail/`.
//!
//! | Route | Answer |
//! |---|---|
//! | `/fail/slow.m3u?ms=N` | the sample playlist after N ms (default 3000, max 120000) |
//! | `/fail/stall.m3u` | `200` head and `#EXTM3U`, then the body hangs (closes after 10 min) |
//! | `/fail/drip.m3u?ms=N` | the sample playlist, one byte every N ms (default 500) |
//! | `/fail/401.m3u` | `401 Unauthorized` with `WWW-Authenticate: Basic` |
//! | `/fail/403.m3u` | `403 Forbidden` |
//! | `/fail/404.m3u` | `404 Not Found` |
//! | `/fail/503.m3u` | `503 Service Unavailable` with `Retry-After: 1` |
//! | `/fail/status/{code}` | that status (100-599) with a short text body |
//! | `/fail/empty.m3u` | `200` with an empty body |
//! | `/fail/malformed.m3u` | `200` plain text that is not a playlist |
//! | `/fail/broken.m3u` | `#EXTM3U` with junk lines, a dangling `#EXTINF` and 3 good channels |
//! | `/fail/login.m3u` | `200` HTML login page (what expired panels often send) |
//! | `/fail/stream.ts` | an endless MPEG-TS stream (`video/mp2t`, stops after 256 MiB) |
//! | `/fail/hls.m3u8` | an HLS media playlist (a single channel, not a channel list) |
//! | `/fail/malformed.xml` | XMLTV cut off mid-document with a broken tag |
//! | `/fail/notxmltv.xml` | `200` HTML page instead of XMLTV |
//! | `/fail/slow.xml?ms=N` | the sample guide after N ms |
//! | `/fail/slow-large.m3u?channels=N&ms=M` | a large generated playlist (default 50 000 channels), one ~64 KiB chunk every M ms (default 200): long enough to cancel mid-import |
//! | `/fail/hang.m3u` | no status line at all for 10 min (header timeouts) |
//! | `/fail/unicode.m3u` | BOM, CRLF and [`UNICODE_CHANNELS`]: accented, CJK, Arabic, Cyrillic and emoji names and groups |
//! | `/fail/xtream/{mode}/player_api.php` | an Xtream panel failing every call: `401`, `403`, `404`, any 4xx/5xx, `hang`, `html` (login page) or `badjson` (truncated JSON); also `.../get.php` and `.../xmltv.php` |
//!
//! The 10k-channel fixture is `/m3u/10k.m3u` (see [`crate::playlists`]).
//! Xtream with wrong credentials answers `{"user_info":{"auth":0}}` (see
//! [`crate::xtream`]).

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Query};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use serde::Deserialize;

use crate::{catalog, gen, Base, MockState};

const M3U_CT: &str = "audio/x-mpegurl; charset=utf-8";
const XML_CT: &str = "application/xml; charset=utf-8";
/// Longest delay `?ms=` accepts.
pub const MAX_DELAY_MS: u64 = 120_000;
/// How long `/fail/stall.m3u` holds the connection.
pub const STALL_HOLD: Duration = Duration::from_secs(600);
/// Bytes `/fail/stream.ts` sends before ending.
pub const STREAM_LIMIT: usize = 256 * 1024 * 1024;
/// Body of `/fail/malformed.m3u`.
pub const MALFORMED_M3U: &str =
    "This is not a playlist.\nPlease contact your provider.\nhello world\n";
/// Body of `/fail/login.m3u` and `/fail/notxmltv.xml`.
pub const LOGIN_HTML: &str = "<!DOCTYPE html><html><head><title>Panel login</title></head><body><form><input name=\"username\"><input name=\"password\" type=\"password\"></form></body></html>";
/// Channels that `/fail/broken.m3u` yields.
pub const BROKEN_M3U_CHANNELS: usize = 3;

pub(crate) fn routes() -> Router<Arc<MockState>> {
    Router::new()
        .route("/fail/slow.m3u", get(slow_m3u))
        .route("/fail/stall.m3u", get(stall_m3u))
        .route("/fail/drip.m3u", get(drip_m3u))
        .route("/fail/401.m3u", get(|| status(401)))
        .route("/fail/403.m3u", get(|| status(403)))
        .route("/fail/404.m3u", get(|| status(404)))
        .route("/fail/503.m3u", get(|| status(503)))
        .route("/fail/status/{code}", get(any_status))
        .route("/fail/empty.m3u", get(empty))
        .route("/fail/malformed.m3u", get(malformed_m3u))
        .route("/fail/broken.m3u", get(broken_m3u))
        .route("/fail/login.m3u", get(login_page))
        .route("/fail/stream.ts", get(endless_ts))
        .route("/fail/hls.m3u8", get(hls_media))
        .route("/fail/malformed.xml", get(malformed_xml))
        .route("/fail/notxmltv.xml", get(login_page))
        .route("/fail/slow.xml", get(slow_xml))
        .route("/fail/slow-large.m3u", get(slow_large_m3u))
        .route("/fail/hang.m3u", get(hang))
        .route("/fail/unicode.m3u", get(unicode_m3u))
        .route(
            "/fail/xtream/{mode}/player_api.php",
            get(xtream_failure).post(xtream_failure),
        )
        .route("/fail/xtream/{mode}/get.php", get(xtream_failure))
        .route("/fail/xtream/{mode}/xmltv.php", get(xtream_failure))
}

#[derive(Debug, Deserialize)]
struct Delay {
    ms: Option<u64>,
}

fn delay(q: &Delay, default: u64) -> Duration {
    Duration::from_millis(q.ms.unwrap_or(default).min(MAX_DELAY_MS))
}

async fn slow_m3u(Base(base): Base, Query(q): Query<Delay>) -> Response {
    tokio::time::sleep(delay(&q, 3_000)).await;
    ([(header::CONTENT_TYPE, M3U_CT)], gen::sample_m3u(&base)).into_response()
}

async fn slow_xml(Base(base): Base, Query(q): Query<Delay>) -> Response {
    tokio::time::sleep(delay(&q, 3_000)).await;
    let start = catalog::day_start(catalog::now()) - 86_400;
    (
        [(header::CONTENT_TYPE, XML_CT)],
        gen::sample_xmltv(&base, start),
    )
        .into_response()
}

async fn stall_m3u() -> Response {
    let first = futures::stream::once(async {
        Ok::<Bytes, std::io::Error>(Bytes::from_static(b"#EXTM3U\n"))
    });
    let hang = futures::stream::once(async {
        tokio::time::sleep(STALL_HOLD).await;
        Ok::<Bytes, std::io::Error>(Bytes::new())
    });
    (
        [(header::CONTENT_TYPE, M3U_CT)],
        Body::from_stream(futures::StreamExt::chain(first, hang)),
    )
        .into_response()
}

async fn drip_m3u(Base(base): Base, Query(q): Query<Delay>) -> Response {
    let every = delay(&q, 500);
    let text = gen::sample_m3u(&base).into_bytes();
    let stream = futures::stream::unfold((text, 0usize), move |(text, i)| async move {
        if i >= text.len() {
            return None;
        }
        if i > 0 {
            tokio::time::sleep(every).await;
        }
        let b = Bytes::copy_from_slice(&text[i..=i]);
        Some((Ok::<Bytes, std::io::Error>(b), (text, i + 1)))
    });
    ([(header::CONTENT_TYPE, M3U_CT)], Body::from_stream(stream)).into_response()
}

async fn status(code: u16) -> Response {
    let s = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut res = (s, format!("mock failure: HTTP {code}")).into_response();
    let h = res.headers_mut();
    if code == 401 {
        h.insert(
            header::WWW_AUTHENTICATE,
            header::HeaderValue::from_static("Basic realm=\"iptv-mock\""),
        );
    }
    if code == 503 || code == 429 {
        h.insert(header::RETRY_AFTER, header::HeaderValue::from_static("1"));
    }
    res
}

async fn any_status(Path(code): Path<u16>) -> Response {
    if !(100..=599).contains(&code) {
        return (StatusCode::BAD_REQUEST, "status must be 100-599").into_response();
    }
    status(code).await
}

async fn empty() -> Response {
    ([(header::CONTENT_TYPE, M3U_CT)], "").into_response()
}

async fn malformed_m3u() -> Response {
    ([(header::CONTENT_TYPE, "text/plain")], MALFORMED_M3U).into_response()
}

async fn broken_m3u(Base(base): Base) -> Response {
    let body = format!(
        "#EXTM3U\n\
         garbage line without a tag\n\
         #EXTINF:-1 group-title=\"Ok\",One\n{base}/media/sample.mp4\n\
         #EXTINF:-1 group-title=\"Ok\" tvg-id=\"broken\n\
         #EXTINF:-1 group-title=\"Ok\",Two\n{base}/media/sample.webm\n\
         \u{0}\u{1} binary noise\n\
         #EXTINF:-1,Dangling with no URL\n\
         #EXTINF:-1 group-title=\"Ok\",Three\n{base}/media/radio.mp3\n\
         #EXTINF:-1,Last dangling\n"
    );
    ([(header::CONTENT_TYPE, M3U_CT)], body).into_response()
}

async fn login_page() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        LOGIN_HTML,
    )
        .into_response()
}

/// One 188-byte MPEG-TS null packet (PID 0x1FFF).
fn ts_packet() -> Bytes {
    let mut p = vec![0xFFu8; 188];
    p[0] = 0x47;
    p[1] = 0x1F;
    p[2] = 0xFF;
    p[3] = 0x10;
    Bytes::from(p)
}

async fn endless_ts() -> Response {
    // 64 KiB chunks of null packets (348 packets = 65 424 bytes).
    let chunk: Bytes = {
        let p = ts_packet();
        let mut v = Vec::with_capacity(188 * 348);
        for _ in 0..348 {
            v.extend_from_slice(&p);
        }
        Bytes::from(v)
    };
    let n = STREAM_LIMIT / chunk.len();
    let stream =
        futures::stream::iter((0..n).map(move |_| Ok::<Bytes, std::io::Error>(chunk.clone())));
    (
        [(header::CONTENT_TYPE, "video/mp2t")],
        Body::from_stream(stream),
    )
        .into_response()
}

async fn hls_media(Base(base): Base) -> Response {
    let body = format!(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n\
         #EXTINF:6.0,\n{base}/xtream/seg/1.ts\n#EXTINF:6.0,\n{base}/xtream/seg/2.ts\n"
    );
    (
        [(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")],
        body,
    )
        .into_response()
}

async fn malformed_xml() -> Response {
    let body = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>\n\
        <channel id=\"a\"><display-name>A</display-name></channel>\n\
        <programme start=\"20260101000000 +0000\" stop=\"20260101010000 +0000\" channel=\"a\"><title>Ok</title></programme>\n\
        <programme start=\"not a date\" channel=\"a\"><title>Bad time</title></programme>\n\
        <programme start=\"20260101010000 +0000\" channel=\"a\"><title>Unclosed <b>tag</title>\n\
        <programme start=\"2026";
    ([(header::CONTENT_TYPE, XML_CT)], body).into_response()
}

#[derive(Debug, Deserialize)]
struct SlowLarge {
    channels: Option<usize>,
    ms: Option<u64>,
}

/// Default channel count of `/fail/slow-large.m3u`.
pub const SLOW_LARGE_DEFAULT_CHANNELS: usize = 50_000;
/// Default pause between the ~64 KiB chunks of `/fail/slow-large.m3u`.
pub const SLOW_LARGE_DEFAULT_MS: u64 = 200;

async fn slow_large_m3u(Base(base): Base, Query(q): Query<SlowLarge>) -> Response {
    let channels = q
        .channels
        .unwrap_or(SLOW_LARGE_DEFAULT_CHANNELS)
        .min(1_000_000);
    let every = delay(
        &Delay {
            ms: q.ms.or(Some(SLOW_LARGE_DEFAULT_MS)),
        },
        SLOW_LARGE_DEFAULT_MS,
    );
    let chunks = gen::M3uGen::new(&base, channels, 20);
    let stream = futures::stream::unfold((chunks, true), move |(mut chunks, first)| async move {
        let chunk = chunks.next()?;
        if !first {
            tokio::time::sleep(every).await;
        }
        Some((
            Ok::<Bytes, std::io::Error>(Bytes::from(chunk)),
            (chunks, false),
        ))
    });
    ([(header::CONTENT_TYPE, M3U_CT)], Body::from_stream(stream)).into_response()
}

/// Holds the request without sending a status line, for header timeouts.
async fn hang() -> Response {
    tokio::time::sleep(STALL_HOLD).await;
    (StatusCode::GATEWAY_TIMEOUT, "mock failure: hung").into_response()
}

/// `/fail/xtream/{mode}/player_api.php` and `.../get.php`: an Xtream panel
/// that fails every call the way `mode` names.
async fn xtream_failure(Path(mode): Path<String>) -> Response {
    match mode.as_str() {
        "hang" => hang().await,
        "html" => login_page().await,
        "badjson" => (
            [(header::CONTENT_TYPE, "application/json")],
            "{\"user_info\": {\"auth\": 1, ",
        )
            .into_response(),
        code => match code.parse::<u16>() {
            Ok(c) if (400..=599).contains(&c) => status(c).await,
            _ => (StatusCode::BAD_REQUEST, "unknown failure mode").into_response(),
        },
    }
}

/// Channels of `/fail/unicode.m3u`, in order: (group, name).
pub const UNICODE_CHANNELS: [(&str, &str); 8] = [
    ("Fran\u{e7}ais", "France 2 \u{e9}\u{e8}\u{ea}"),
    ("Deutsch", "Das Erste \u{fc}\u{f6}\u{e4}\u{df}"),
    ("\u{65e5}\u{672c}", "NHK \u{7dcf}\u{5408}"),
    ("\u{4e2d}\u{6587}", "CCTV-1 \u{7efc}\u{5408}"),
    (
        "\u{627}\u{644}\u{639}\u{631}\u{628}\u{64a}\u{629}",
        "\u{627}\u{644}\u{62c}\u{632}\u{64a}\u{631}\u{629}",
    ),
    (
        "\u{420}\u{443}\u{441}\u{441}\u{43a}\u{438}\u{439}",
        "\u{41f}\u{435}\u{440}\u{432}\u{44b}\u{439} \u{43a}\u{430}\u{43d}\u{430}\u{43b}",
    ),
    ("Emoji \u{1f3ac}", "Kids \u{1f43b} TV \u{2728}"),
    (
        "Fran\u{e7}ais",
        "Caf\u{e9} \u{201c}quoted\u{201d}, with comma",
    ),
];

/// A UTF-8 playlist (with a BOM and CRLF line ends) whose names and groups
/// are accented Latin, CJK, Arabic (RTL), Cyrillic and emoji.
async fn unicode_m3u(Base(base): Base) -> Response {
    let mut body = String::from("\u{feff}#EXTM3U\r\n");
    for (i, (group, name)) in UNICODE_CHANNELS.iter().enumerate() {
        body.push_str(&format!(
            "#EXTINF:-1 tvg-id=\"u{i}\" tvg-name=\"{}\" group-title=\"{group}\",{name}\r\n{base}/media/sample.mp4?ch={i}\r\n",
            name.replace('"', "'")
        ));
    }
    ([(header::CONTENT_TYPE, M3U_CT)], body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_packet_is_well_formed() {
        let p = ts_packet();
        assert_eq!(p.len(), 188);
        assert_eq!(p[0], 0x47);
    }

    #[test]
    fn delay_is_capped() {
        assert_eq!(
            delay(&Delay { ms: Some(u64::MAX) }, 1),
            Duration::from_millis(MAX_DELAY_MS)
        );
        assert_eq!(delay(&Delay { ms: None }, 7), Duration::from_millis(7));
    }
}
