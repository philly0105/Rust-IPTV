//! `GET /api/img?url=<absolute http(s) url>&sourceId=<id?>`: posters, logos
//! and backdrops through the core image cache (Run 3 contract C2).
//!
//! Server mode mounts it at `/api/img`; the desktop loopback proxy mounts the
//! same handler at `/<token>/api/img`. The first request for a URL fetches it
//! upstream (`X-Image-Cache: miss`), later ones read it from disk
//! (`X-Image-Cache: hit`); see `iptv_core::imagecache` for the cache itself.
//!
//! Responses:
//! - 200 with the cached bytes, the stored `Content-Type`,
//!   `Cache-Control: private, max-age=604800` and `X-Image-Cache: hit|miss`.
//!   The file is served by `tower_http::services::ServeFile`, so HEAD,
//!   `Last-Modified`/`If-Modified-Since` (304) and Range work too.
//! - 400 bad URL, 403 refused by the SSRF guard, 404 upstream 404, 415 not an
//!   image, 502 a body over 10 MB (code `invalid`) or any other upstream
//!   failure (`network`), 500 a local disk or database failure (`io`) or a
//!   file that vanished twice while being read (`internal`). Errors are the
//!   usual JSON `RpcError` with `Cache-Control: no-store`.
//!
//! Every response of this handler carries the sandbox CSP and `nosniff`
//! ([`harden`]): an SVG is served from the app's own origin, so it must never
//! run as a document. Requests refused before the handler runs (server mode:
//! `api_guard`'s host and cross-site checks; desktop: the token and Origin
//! checks) get those layers' own answers and headers.

use crate::api::error_response_with;
use crate::proxy::harden;
use crate::Server;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{self, HeaderName, HeaderValue};
use axum::http::StatusCode;
use axum::response::Response;
use iptv_core::imagecache::{self, CachedImage, ImageError};
use iptv_core::logging::redact_url;
use iptv_core::RpcError;
use tower::ServiceExt;
use tower_http::services::ServeFile;

/// `Cache-Control` of a served image: the browser keeps it for a week.
pub const CACHE_CONTROL: &str = "private, max-age=604800";
/// Header that says whether the bytes came from disk (`hit`) or upstream (`miss`).
pub const X_IMAGE_CACHE: HeaderName = HeaderName::from_static("x-image-cache");

/// The route's query (first value of each parameter wins).
#[derive(Debug, Default, PartialEq, Eq)]
struct ImgQuery {
    url: Option<String>,
    source_id: Option<String>,
}

fn parse_query(query: Option<&str>) -> ImgQuery {
    let mut q = ImgQuery::default();
    for (k, v) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        let slot = match &*k {
            "url" => &mut q.url,
            "sourceId" => &mut q.source_id,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(v.into_owned());
        }
    }
    q.source_id = q
        .source_id
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    q
}

/// Route handler (server `/api/img`, desktop `/<token>/api/img`).
pub async fn handler(State(s): State<Server>, req: Request) -> Response {
    let q = parse_query(req.uri().query());
    // Only the parts `ServeFile` needs are kept: a `Request` (its body is not
    // `Sync`) must not be borrowed across an await in a `Send` handler.
    let file_req = FileRequest::from(&req);
    drop(req);
    let mut res = match q.url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        Some(url) => serve(&s, url, q.source_id.as_deref(), &file_req).await,
        None => error(
            StatusCode::BAD_REQUEST,
            RpcError::invalid("missing url query parameter"),
        ),
    };
    harden(&mut res);
    res
}

async fn serve(s: &Server, url: &str, source_id: Option<&str>, req: &FileRequest) -> Response {
    let mut retried = false;
    loop {
        let image = match imagecache::fetch(&s.app, url, source_id).await {
            Ok(image) => image,
            Err(err) => return image_error(url, err),
        };
        let res = serve_file(&image, req).await;
        if res.status() != StatusCode::NOT_FOUND {
            return decorate(res, &image);
        }
        // Evicted or cleared between the lookup and the read: look again
        // (the next lookup sees the row is stale and fetches anew).
        if retried {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                RpcError::internal("the cached image disappeared while it was being read"),
            );
        }
        retried = true;
    }
}

/// Method, URI and the conditional/Range headers of the client's request.
struct FileRequest {
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
}

impl From<&Request> for FileRequest {
    fn from(req: &Request) -> Self {
        let mut headers = axum::http::HeaderMap::new();
        for name in [
            header::IF_MODIFIED_SINCE,
            header::IF_UNMODIFIED_SINCE,
            header::RANGE,
            header::IF_RANGE,
        ] {
            if let Some(v) = req.headers().get(&name) {
                headers.insert(name, v.clone());
            }
        }
        Self {
            method: req.method().clone(),
            uri: req.uri().clone(),
            headers,
        }
    }
}

/// Serves the cached file with the client's conditional and Range headers.
async fn serve_file(image: &CachedImage, req: &FileRequest) -> Response {
    let mut file_req = Request::new(Body::empty());
    *file_req.method_mut() = req.method.clone();
    *file_req.uri_mut() = req.uri.clone();
    *file_req.headers_mut() = req.headers.clone();
    match ServeFile::new(&image.path).oneshot(file_req).await {
        Ok(res) => res.map(Body::new),
        Err(never) => match never {},
    }
}

/// Adds the stored type and the cache headers to a file response.
fn decorate(mut res: Response, image: &CachedImage) -> Response {
    // ServeFile guesses the type from the (extensionless) file name; the
    // stored type replaces it on the file and on a 304 for it.
    let describes_file = res.status().is_success() || res.status() == StatusCode::NOT_MODIFIED;
    let h = res.headers_mut();
    if describes_file {
        if let Ok(ct) = HeaderValue::from_str(&image.content_type) {
            h.insert(header::CONTENT_TYPE, ct);
        }
    }
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(CACHE_CONTROL),
    );
    h.insert(
        X_IMAGE_CACHE,
        HeaderValue::from_static(if image.hit { "hit" } else { "miss" }),
    );
    res
}

fn image_error(url: &str, err: ImageError) -> Response {
    let status =
        StatusCode::from_u16(err.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    tracing::debug!(
        url = %redact_url(url),
        %status,
        error = %err,
        "image request failed"
    );
    error(status, err.into())
}

fn error(status: StatusCode, err: RpcError) -> Response {
    let mut res = error_response_with(status, err);
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_takes_the_first_url_and_a_trimmed_source() {
        let q = parse_query(Some(
            "url=http%3A%2F%2Fa.example%2Fp.png%3Fx%3D1%26y%3D2&sourceId=%20s1%20&url=other",
        ));
        assert_eq!(q.url.as_deref(), Some("http://a.example/p.png?x=1&y=2"));
        assert_eq!(q.source_id.as_deref(), Some("s1"));
        assert_eq!(parse_query(None), ImgQuery::default());
        assert_eq!(parse_query(Some("sourceId=")).source_id, None);
    }

    #[test]
    fn unknown_parameters_such_as_the_clients_gen_are_ignored() {
        // The client adds `gen=<n>` after Clear to skip the browser's copies;
        // it must not change what the route reads.
        let plain = parse_query(Some("url=http%3A%2F%2Fa.example%2Fp.png&sourceId=s1"));
        for query in [
            "url=http%3A%2F%2Fa.example%2Fp.png&sourceId=s1&gen=3",
            "gen=3&url=http%3A%2F%2Fa.example%2Fp.png&x=&sourceId=s1",
        ] {
            assert_eq!(parse_query(Some(query)), plain, "{query}");
        }
    }
}
