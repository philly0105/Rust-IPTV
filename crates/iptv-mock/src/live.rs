//! Timed live streams for recording tests, and the body of the Xtream
//! panel's direct live `.ts` streams ([`channel_ts`]).
//!
//! | Route | Answer |
//! |---|---|
//! | `/live/timed.ts?seconds=N` | a live MPEG-TS stream (`video/mp2t`) that sends one 2 s segment every 2 s and ends after about N s (default 10, max 600) |
//! | `/live/timed.ts?...&ua=X` | the same, but `403 Forbidden` unless the request's `User-Agent` is exactly `X` |
//!
//! The segments are [`media::live_segment`], so consecutive bytes play as one
//! continuous stream with increasing timestamps.

use crate::media;
use axum::body::Body;
use axum::extract::Query;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;

/// Seconds of video in one live segment.
const SEGMENT_SECONDS: u64 = 2;
/// Longest stream a request may ask for.
const MAX_SECONDS: u64 = 600;
/// Segments [`channel_ts`] sends at once on connect, like a panel's connect
/// burst.
pub const CONNECT_BURST: u64 = 2;
/// Segments before [`channel_ts`] ends (an hour), for a client that never
/// hangs up.
const CHANNEL_SEGMENTS: u64 = 1_800;

pub fn routes() -> Router<Arc<crate::MockState>> {
    Router::new().route("/live/timed.ts", get(timed))
}

#[derive(Debug, Deserialize)]
struct TimedQuery {
    seconds: Option<u64>,
    ua: Option<String>,
}

/// Segments sent for a stream of `seconds` (at least one).
pub fn segment_count(seconds: u64) -> u64 {
    seconds.min(MAX_SECONDS).div_ceil(SEGMENT_SECONDS).max(1)
}

async fn timed(headers: HeaderMap, Query(q): Query<TimedQuery>) -> Response {
    if let Some(want) = q.ua.as_deref() {
        let got = headers
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if got != want {
            return (StatusCode::FORBIDDEN, "wrong user agent").into_response();
        }
    }
    let count = segment_count(q.seconds.unwrap_or(10));
    let stream = futures::stream::unfold(0u64, move |n| async move {
        if n >= count {
            return None;
        }
        if n > 0 {
            tokio::time::sleep(Duration::from_secs(SEGMENT_SECONDS)).await;
        }
        Some((
            Ok::<Bytes, std::io::Error>(Bytes::from(media::live_segment(n))),
            n + 1,
        ))
    });
    (
        [
            (header::CONTENT_TYPE, "video/mp2t"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

/// A live channel's direct MPEG-TS stream, the way a panel sends one: no
/// length and no ranges, [`CONNECT_BURST`] segments at once, then one segment
/// every [`SEGMENT_SECONDS`] in real time. A player that keeps a channel on
/// plays on for as long as it would on HLS, instead of reaching the end of a
/// file after one loop.
pub fn channel_ts() -> Response {
    let start = tokio::time::Instant::now();
    let stream = futures::stream::unfold(0u64, move |n| async move {
        if n >= CHANNEL_SEGMENTS {
            return None;
        }
        if n >= CONNECT_BURST {
            // Against the start, so the pace does not drift behind playback.
            let due = (n + 1 - CONNECT_BURST) * SEGMENT_SECONDS;
            tokio::time::sleep_until(start + Duration::from_secs(due)).await;
        }
        Some((
            Ok::<Bytes, std::io::Error>(Bytes::from(media::live_segment(n))),
            n + 1,
        ))
    });
    (
        [
            (header::CONTENT_TYPE, "video/mp2t"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_count_rounds_up_and_caps() {
        assert_eq!(segment_count(0), 1);
        assert_eq!(segment_count(1), 1);
        assert_eq!(segment_count(3), 2);
        assert_eq!(segment_count(4), 2);
        assert_eq!(segment_count(10_000), MAX_SECONDS / SEGMENT_SECONDS);
    }
}
