//! Built UI with SPA fallback and cache headers.
//!
//! - Files under `/assets/` whose names carry a Vite content hash get
//!   `Cache-Control: public, max-age=31536000, immutable`.
//! - `index.html` (including every SPA fallback) and other root files
//!   (service worker, manifest, icons) get `no-cache`, so a new build is
//!   picked up on the next load.
//! - Unknown paths without a file extension fall back to `index.html` so
//!   client-side routes deep-link; unknown asset paths stay 404 so the
//!   browser never receives HTML where it expected a script.

use crate::Server;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{self, HeaderValue};
use axum::http::{Method, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use std::path::Path;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

pub const IMMUTABLE: &str = "public, max-age=31536000, immutable";
pub const NO_CACHE: &str = "no-cache";

pub async fn handler(State(s): State<Server>, req: Request) -> Response {
    let method = req.method().clone();
    if method != Method::GET && method != Method::HEAD {
        let mut res = StatusCode::METHOD_NOT_ALLOWED.into_response();
        res.headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return res;
    }
    let path = req.uri().path().to_owned();
    let headers = req.headers().clone();
    let dir = s.opts.static_dir.as_path();

    let res = match ServeDir::new(dir)
        .precompressed_br()
        .precompressed_gzip()
        .oneshot(req)
        .await
    {
        Ok(r) => r.map(Body::new),
        Err(e) => match e {},
    };
    if res.status() == StatusCode::NOT_FOUND && is_spa_route(&path) {
        return serve_index(dir, method, headers).await;
    }
    with_cache_headers(res, &path)
}

async fn serve_index(dir: &Path, method: Method, headers: axum::http::HeaderMap) -> Response {
    let index = dir.join("index.html");
    if !index.is_file() {
        let mut res = (
            StatusCode::SERVICE_UNAVAILABLE,
            Html(
                "<!doctype html><meta charset=utf-8><title>Tsrust IPTV</title>\
                 <h1>The UI is not built</h1><p>Run <code>pnpm build</code> and start the server \
                 with <code>--static ./dist</code>. The API at <code>/api</code> is running.</p>",
            ),
        )
            .into_response();
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return res;
    }
    let mut req = Request::new(Body::empty());
    *req.method_mut() = method;
    *req.uri_mut() = "/index.html".parse().expect("static uri");
    *req.headers_mut() = headers;
    // Deep links get the build's index.html.br / .gz too, like `/`.
    let res = match ServeFile::new(index)
        .precompressed_br()
        .precompressed_gzip()
        .oneshot(req)
        .await
    {
        Ok(r) => r.map(Body::new),
        Err(e) => match e {},
    };
    with_cache_headers(res, "/index.html")
}

fn with_cache_headers(mut res: Response, path: &str) -> Response {
    let status = res.status();
    let value = if !(status.is_success() || status == StatusCode::NOT_MODIFIED) {
        "no-store"
    } else if is_hashed_asset(path) {
        IMMUTABLE
    } else {
        NO_CACHE
    };
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    res
}

/// A client-side route: not under `/assets/` and the last segment has no extension.
pub fn is_spa_route(path: &str) -> bool {
    if path.starts_with("/assets/") {
        return false;
    }
    let last = path.rsplit('/').next().unwrap_or("");
    !last.contains('.')
}

/// Vite output like `/assets/index-Bk3a9_zQ.js`: under `/assets/` with a
/// content hash of at least 8 URL-safe characters after the first `-`.
pub fn is_hashed_asset(path: &str) -> bool {
    let Some(name) = path
        .strip_prefix("/assets/")
        .map(|p| p.rsplit('/').next().unwrap_or(p))
    else {
        return false;
    };
    let stem = name.split('.').next().unwrap_or("");
    stem.split_once('-').is_some_and(|(_, hash)| {
        hash.len() >= 8
            && hash
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spa_routes() {
        assert!(is_spa_route("/"));
        assert!(is_spa_route("/s/abc/live"));
        assert!(is_spa_route("/settings/general"));
        assert!(!is_spa_route("/assets/missing"));
        assert!(!is_spa_route("/favicon.ico"));
        assert!(!is_spa_route("/assets/index-abc.js"));
    }

    #[test]
    fn hashed_assets() {
        assert!(is_hashed_asset("/assets/index-Bk3a9_zQ.js"));
        assert!(is_hashed_asset("/assets/vendor-react-C1x2y3z4.js"));
        assert!(is_hashed_asset(
            "/assets/inter-latin-400-normal-D2Qk9zKx.woff2"
        ));
        assert!(!is_hashed_asset("/assets/logo.svg"));
        assert!(!is_hashed_asset("/index.html"));
        assert!(!is_hashed_asset("/assets/my-icon.png"));
    }
}
