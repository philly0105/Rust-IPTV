//! Timed live streams for recording tests.
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
