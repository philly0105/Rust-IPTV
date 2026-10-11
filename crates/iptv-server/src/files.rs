//! `GET /api/files/{downloadId}`: serves a completed download with Range support.
//!
//! The path comes from the `downloads` table (never from the request), the
//! row must be `completed`, and the path must be a regular file (no
//! directories, no symlinks). Range, `If-Range`, `If-Modified-Since` and HEAD
//! are handled by `tower_http::services::ServeFile`.

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

pub async fn handler(State(s): State<Server>, Path(id): Path<String>, req: Request) -> Response {
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
    let disposition = format!(
        "inline; filename=\"{ascii}\"; filename*=UTF-8''{}",
        utf8_percent_encode(&name, NON_ALPHANUMERIC)
    );
    if let Ok(v) = HeaderValue::from_str(&disposition) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    res.into_response()
}
