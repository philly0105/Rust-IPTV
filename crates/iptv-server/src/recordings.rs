//! `GET /api/recordings/{id}`: serves a recording file with Range support.
//!
//! `id` is a `recordings.library` entry id; the core turns it into a path
//! (never taken from the request) and checks it is a regular file. Headers
//! follow `files.rs`: sandbox CSP, `nosniff`, inline only for media types, and
//! `?from=<byte>` starts the body at that byte (`files::byte_start`).

use crate::api::error_response;
use crate::Server;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::header::{self, HeaderValue};
use axum::response::{IntoResponse, Response};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use tower::ServiceExt;
use tower_http::services::ServeFile;

pub async fn handler(
    State(s): State<Server>,
    Path(id): Path<String>,
    mut req: Request,
) -> Response {
    crate::files::start_at_byte(&mut req);
    let target = match iptv_core::recording::library::resolve(&s.app, id.trim()).await {
        Ok(t) => t,
        Err(e) => return error_response(e.into()),
    };
    let path = target.path().to_path_buf();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "recording.ts".into());
    let mut res = match ServeFile::new(&path).oneshot(req).await {
        Ok(r) => r.map(Body::new),
        Err(e) => match e {},
    };
    let h = res.headers_mut();
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("ts") || e.eq_ignore_ascii_case("m2ts"))
    {
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp2t"));
    }
    let inline = h
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(crate::files::is_inline_type);
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let disposition = format!(
        "{}; filename=\"{ascii}\"; filename*=UTF-8''{}",
        if inline { "inline" } else { "attachment" },
        utf8_percent_encode(&name, NON_ALPHANUMERIC)
    );
    if let Ok(v) = HeaderValue::from_str(&disposition) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    crate::proxy::harden(&mut res);
    res.into_response()
}
