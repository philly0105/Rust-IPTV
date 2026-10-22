//! `GET /api/files/{downloadId}`: serves a completed download with Range support.
//!
//! The path comes from the `downloads` table (never from the request), the
//! row must be `completed`, and the path must be a regular file (no
//! directories, no symlinks). Range, `If-Range`, `If-Modified-Since` and HEAD
//! are handled by `tower_http::services::ServeFile`.
//!
//! Only video, audio and image files are served `inline` (for the player);
//! everything else is an `attachment`. Every response carries the sandbox
//! CSP and `nosniff`, so a downloaded HTML or SVG page never runs with the
//! app's origin.
//!
//! `?from=<byte>` serves the file as if it began at that byte ([`byte_start`]):
//! the built-in player restarts an MPEG-TS file there to seek in it.

use crate::api::error_response;
use crate::Server;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::header::{self, HeaderValue};
use axum::response::{IntoResponse, Response};
use iptv_core::RpcError;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use rusqlite::OptionalExtension;
use std::path::PathBuf;
use tower::ServiceExt;
use tower_http::services::ServeFile;

struct Row {
    status: String,
    file_path: Option<String>,
    file_name: Option<String>,
}

pub async fn handler(
    State(s): State<Server>,
    Path(id): Path<String>,
    mut req: Request,
) -> Response {
    start_at_byte(&mut req);
    let Ok(id) = id.trim().parse::<i64>() else {
        return error_response(RpcError::invalid("download id must be a number"));
    };
    let row = s
        .app
        .db_call(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT status, file_path, file_name FROM downloads WHERE id = ?1",
                    [id],
                    |r| {
                        Ok(Row {
                            status: r.get(0)?,
                            file_path: r.get(1)?,
                            file_name: r.get(2)?,
                        })
                    },
                )
                .optional()?)
        })
        .await;
    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => return error_response(RpcError::not_found(format!("download {id} not found"))),
        Err(e) => return error_response(e.into()),
    };
    if row.status != "completed" {
        return error_response(RpcError::conflict(format!(
            "download {id} is {}; only completed downloads can be played",
            row.status
        )));
    }
    let Some(path) = row
        .file_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
    else {
        return error_response(RpcError::not_found(format!("download {id} has no file")));
    };
    match tokio::fs::symlink_metadata(&path).await {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => {
            return error_response(RpcError::not_found(format!(
                "download {id} does not point at a regular file"
            )))
        }
        Err(_) => {
            return error_response(RpcError::not_found(format!(
                "the file for download {id} is missing; it may have been moved or deleted"
            )))
        }
    }

    let name = row
        .file_name
        .filter(|n| !n.trim().is_empty())
        .or_else(|| path.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| format!("download-{id}"));

    let mut res = match ServeFile::new(&path).oneshot(req).await {
        Ok(r) => r.map(Body::new),
        Err(e) => match e {},
    };
    let h = res.headers_mut();
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
    let inline = h
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(is_inline_type);
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

/// Video, audio and raster/vector images may render inline; the sandbox CSP
/// keeps an SVG from running script.
pub fn is_inline_type(ct: &str) -> bool {
    let essence = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    essence.starts_with("video/") || essence.starts_with("audio/") || essence.starts_with("image/")
}

/// The byte a body starts at, from a `?from=<byte>` query (`/api/files`,
/// `/api/recordings`, `/api/proxy`). mpegts.js can't seek in MPEG-TS and
/// always asks for a URL from its byte 0, so the player seeks by loading the
/// same URL with `from` (players.md); the Range requests it sends later (a
/// resume after its lazy-load pause) count from that byte too. `None` when
/// absent, 0 or not a number.
pub fn byte_start(query: Option<&str>) -> Option<u64> {
    url::form_urlencoded::parse(query?.as_bytes())
        .find(|(k, _)| k == "from")
        .and_then(|(_, v)| v.trim().parse::<u64>().ok())
        .filter(|&n| n > 0)
}

/// The Range to ask for when the client's `range` counts from byte `from`:
/// none is `bytes=<from>-`, and `bytes=a-` or `bytes=a-b` move up by `from`. A
/// suffix range (`bytes=-n`) means the same either way, and anything else
/// (several ranges) is left as it is.
pub fn shifted_range(range: Option<&str>, from: u64) -> String {
    let Some(range) = range else {
        return format!("bytes={from}-");
    };
    let shifted = range.trim().strip_prefix("bytes=").and_then(|spec| {
        let (a, b) = spec.trim().split_once('-')?;
        let a = a.trim().parse::<u64>().ok()?.checked_add(from)?;
        match b.trim() {
            "" => Some(format!("bytes={a}-")),
            b => Some(format!(
                "bytes={a}-{}",
                b.parse::<u64>().ok()?.checked_add(from)?
            )),
        }
    });
    shifted.unwrap_or_else(|| range.to_owned())
}

/// Applies [`byte_start`] to a file request before `ServeFile` reads its Range.
pub(crate) fn start_at_byte(req: &mut Request) {
    let Some(from) = byte_start(req.uri().query()) else {
        return;
    };
    let range = shifted_range(
        req.headers()
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok()),
        from,
    );
    if let Ok(v) = HeaderValue::from_str(&range) {
        req.headers_mut().insert(header::RANGE, v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_start_reads_a_positive_from() {
        assert_eq!(byte_start(Some("from=188")), Some(188));
        assert_eq!(byte_start(Some("x=1&from=%20376")), Some(376));
        assert_eq!(byte_start(Some("from=0")), None);
        assert_eq!(byte_start(Some("from=-5")), None);
        assert_eq!(byte_start(Some("from=abc")), None);
        assert_eq!(byte_start(Some("url=x")), None);
        assert_eq!(byte_start(None), None);
    }

    #[test]
    fn shifted_range_counts_from_the_start_byte() {
        assert_eq!(shifted_range(None, 100), "bytes=100-");
        assert_eq!(shifted_range(Some("bytes=0-"), 100), "bytes=100-");
        assert_eq!(shifted_range(Some("bytes=50-"), 100), "bytes=150-");
        assert_eq!(shifted_range(Some("bytes=10-19"), 100), "bytes=110-119");
        // Nothing to move: a suffix, several ranges, another unit.
        assert_eq!(shifted_range(Some("bytes=-500"), 100), "bytes=-500");
        assert_eq!(shifted_range(Some("bytes=0-1,5-9"), 100), "bytes=0-1,5-9");
        assert_eq!(shifted_range(Some("items=0-1"), 100), "items=0-1");
        assert_eq!(
            shifted_range(Some(&format!("bytes={}-", u64::MAX)), 1),
            format!("bytes={}-", u64::MAX)
        );
    }
}
