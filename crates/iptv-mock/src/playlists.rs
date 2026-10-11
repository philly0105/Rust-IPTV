//! Playlist and guide routes.
//!
//! - `/m3u/sample.m3u`: the 25-channel sample ([`gen::sample_m3u`]) with URLs
//!   rooted at this server.
//! - `/m3u/large.m3u?channels=N&groups=G`: streamed from [`gen::M3uGen`]
//!   (default 50 000 channels, 20 groups). Never built as one string.
//! - `/m3u/protected.m3u`: the sample, but only with
//!   `User-Agent: IPTVMockAgent/1.0` and `Referer: http://referer.mock/`;
//!   403 otherwise.
//! - `/xmltv/sample.xml`, `/xmltv/sample.xml.gz`: 3 days for the sample
//!   channels, starting the day before today (so "now" is always covered).
//! - `/xmltv/large.xml?mb=N`: streamed from [`gen::XmltvGen`], at least N MiB
//!   (default 5).

use std::io::Write;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::Query;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use serde::Deserialize;

use crate::{catalog, gen, Base, MockState};

/// Required `User-Agent` for `/m3u/protected.m3u`.
pub const PROTECTED_USER_AGENT: &str = "IPTVMockAgent/1.0";
/// Required `Referer` for `/m3u/protected.m3u`.
pub const PROTECTED_REFERER: &str = "http://referer.mock/";
/// Default channel count of `/m3u/large.m3u`.
pub const LARGE_M3U_DEFAULT_CHANNELS: usize = 50_000;
/// Upper bounds so a typo cannot stream forever.
const MAX_CHANNELS: usize = 2_000_000;
const MAX_MB: usize = 2_048;

const M3U_CT: &str = "audio/x-mpegurl; charset=utf-8";
const XML_CT: &str = "application/xml; charset=utf-8";

pub(crate) fn routes() -> Router<Arc<MockState>> {
    Router::new()
        .route("/m3u/sample.m3u", get(sample_m3u))
        .route("/m3u/large.m3u", get(large_m3u))
        .route("/m3u/protected.m3u", get(protected_m3u))
        .route("/xmltv/sample.xml", get(sample_xml))
        .route("/xmltv/sample.xml.gz", get(sample_xml_gz))
        .route("/xmltv/large.xml", get(large_xml))
}

fn guide_start() -> i64 {
    catalog::day_start(catalog::now()) - 86_400
}

async fn sample_m3u(Base(base): Base) -> Response {
    ([(header::CONTENT_TYPE, M3U_CT)], gen::sample_m3u(&base)).into_response()
}

async fn protected_m3u(Base(base): Base, headers: HeaderMap) -> Response {
    let h = |name: header::HeaderName| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    };
    if h(header::USER_AGENT) != PROTECTED_USER_AGENT || h(header::REFERER) != PROTECTED_REFERER {
        return (
            StatusCode::FORBIDDEN,
            "missing required User-Agent / Referer",
        )
            .into_response();
    }
    ([(header::CONTENT_TYPE, M3U_CT)], gen::sample_m3u(&base)).into_response()
}

#[derive(Debug, Deserialize)]
struct LargeM3u {
    channels: Option<usize>,
    groups: Option<usize>,
}

fn stream_body<I: Iterator<Item = String> + Send + 'static>(iter: I) -> Body {
    let stream = futures::stream::iter(iter.map(|s| Ok::<Bytes, std::io::Error>(Bytes::from(s))));
    Body::from_stream(stream)
}

async fn large_m3u(Base(base): Base, Query(q): Query<LargeM3u>) -> Response {
    let channels = q
        .channels
        .unwrap_or(LARGE_M3U_DEFAULT_CHANNELS)
        .min(MAX_CHANNELS);
    let groups = q.groups.unwrap_or(20).max(1);
    (
        [(header::CONTENT_TYPE, M3U_CT)],
        stream_body(gen::M3uGen::new(&base, channels, groups)),
    )
        .into_response()
}

async fn sample_xml(Base(base): Base) -> Response {
    (
        [(header::CONTENT_TYPE, XML_CT)],
        gen::sample_xmltv(&base, guide_start()),
    )
        .into_response()
}

/// Gzip-compresses `text`.
pub fn gzip(text: &str) -> Vec<u8> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(text.as_bytes()).expect("write to Vec");
    enc.finish().expect("finish gzip into Vec")
}

async fn sample_xml_gz(Base(base): Base) -> Response {
    let body = gzip(&gen::sample_xmltv(&base, guide_start()));
    ([(header::CONTENT_TYPE, "application/gzip")], body).into_response()
}

#[derive(Debug, Deserialize)]
struct LargeXml {
    mb: Option<usize>,
}

async fn large_xml(Base(base): Base, Query(q): Query<LargeXml>) -> Response {
    let mb = q.mb.unwrap_or(5).clamp(1, MAX_MB);
    let gen = gen::XmltvGen::new(&base, mb * gen::MIB, catalog::now());
    ([(header::CONTENT_TYPE, XML_CT)], stream_body(gen)).into_response()
}
