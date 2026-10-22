//! One upstream image fetch: status, type and size checks, body read with a
//! cap. Nothing here touches the disk or the index.

use super::{core_message, head_timeout, ImageError, ImageErrorKind, MAX_IMAGE_BYTES};
use crate::http::{self, BODY_IDLE_TIMEOUT};
use crate::model::RequestHeaders;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::StatusCode;
use url::Url;

/// `Accept` of image requests (what a browser sends for `<img>`).
const ACCEPT_IMAGES: &str = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

/// Fetches `url` and returns its stored content type and body.
pub(super) async fn download(
    client: &reqwest::Client,
    url: &Url,
    headers: &RequestHeaders,
    host: &str,
) -> Result<(String, Vec<u8>), ImageError> {
    let req = http::apply_source_headers(
        client.get(url.clone()).header(ACCEPT, ACCEPT_IMAGES),
        headers,
    );
    let head_timeout = head_timeout();
    let resp = match tokio::time::timeout(head_timeout, req.send()).await {
        Err(_) => {
            return Err(ImageError::upstream(format!(
                "{host} did not answer within {} s.",
                head_timeout.as_secs()
            )))
        }
        Ok(Err(err)) => return Err(transport(host, err)),
        Ok(Ok(resp)) => resp,
    };
    let status = resp.status();
    if status == StatusCode::NOT_FOUND || status == StatusCode::GONE {
        return Err(ImageError::new(
            ImageErrorKind::NotFound,
            format!(
                "{host} has no image at this address (HTTP {}).",
                status.as_u16()
            ),
        ));
    }
    if !status.is_success() {
        return Err(ImageError::upstream(format!(
            "{host} answered HTTP {} instead of the image.",
            status.as_u16()
        )));
    }
    let declared = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(essence)
        .unwrap_or_default();
    let declared = classify(&declared);
    if let Declared::Other(t) = &declared {
        return Err(ImageError::not_image(format!(
            "{host} sent {t}, not an image."
        )));
    }
    if resp.content_length().is_some_and(|n| n > MAX_IMAGE_BYTES) {
        return Err(ImageError::too_large());
    }
    let body = read_body(resp, host).await?;
    if body.is_empty() {
        return Err(ImageError::upstream(format!("{host} sent an empty image.")));
    }
    let content_type = match declared {
        Declared::Image(t) if looks_like_html(&body) => {
            return Err(ImageError::not_image(format!(
                "{host} sent a web page labelled {t}, not an image."
            )))
        }
        Declared::Image(t) => t,
        Declared::Generic => sniff(&body).map(str::to_owned).ok_or_else(|| {
            ImageError::not_image(format!("{host} sent a file that is not an image."))
        })?,
        Declared::Other(_) => unreachable!("refused above"),
    };
    Ok((content_type, body))
}

/// A transport failure: the guard's refusal is Forbidden, the rest Upstream.
fn transport(host: &str, err: reqwest::Error) -> ImageError {
    if let Some(blocked) = http::find_blocked(&err) {
        return ImageError::new(ImageErrorKind::Forbidden, blocked.0);
    }
    ImageError::upstream(core_message(http::transport_error(host, err)))
}

/// Reads the body, refusing it once it passes [`MAX_IMAGE_BYTES`].
async fn read_body(resp: reqwest::Response, host: &str) -> Result<Vec<u8>, ImageError> {
    let hint = resp.content_length().unwrap_or(0).min(MAX_IMAGE_BYTES);
    let mut body = Vec::with_capacity(hint as usize);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = http::next_body_chunk(&mut stream, host, BODY_IDLE_TIMEOUT)
        .await
        .map_err(|e| ImageError::upstream(core_message(e)))?
    {
        if (body.len() + chunk.len()) as u64 > MAX_IMAGE_BYTES {
            return Err(ImageError::too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Lowercase media type without parameters (`image/png; q=1` -> `image/png`).
fn essence(value: &str) -> String {
    value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

/// What the upstream's `Content-Type` says.
#[derive(Debug, PartialEq, Eq)]
enum Declared {
    /// A well-formed `image/*` type (stored as sent, `image/jpg` fixed).
    Image(String),
    /// Missing or generic: decided by the body's magic bytes.
    Generic,
    /// Anything else (HTML, JSON, video): refused.
    Other(String),
}

fn classify(essence: &str) -> Declared {
    const GENERIC: &[&str] = &[
        "",
        "application/octet-stream",
        "binary/octet-stream",
        "application/binary",
        "application/unknown",
        "application/x-octet-stream",
        "application/force-download",
        "text/plain",
    ];
    if GENERIC.contains(&essence) {
        return Declared::Generic;
    }
    if let Some(sub) = essence.strip_prefix("image/") {
        let well_formed = !sub.is_empty()
            && sub.bytes().all(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'+' | b'-')
            });
        if well_formed {
            return Declared::Image(match sub {
                "jpg" | "pjpeg" => "image/jpeg".to_owned(),
                _ => essence.to_owned(),
            });
        }
        return Declared::Generic;
    }
    Declared::Other(essence.to_owned())
}

/// The first bytes as lowercase text, without a BOM or leading whitespace.
fn text_head(body: &[u8]) -> String {
    let body = body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(body);
    let head = &body[..body.len().min(1024)];
    String::from_utf8_lossy(head)
        .trim_start()
        .to_ascii_lowercase()
}

/// True for an HTML document (an error page sent with an image type).
fn looks_like_html(body: &[u8]) -> bool {
    let head = text_head(body);
    ["<!doctype html", "<html", "<head", "<body"]
        .iter()
        .any(|p| head.starts_with(p))
}

/// Image type from the magic bytes of `body`.
fn sniff(body: &[u8]) -> Option<&'static str> {
    let at = |range: std::ops::Range<usize>| body.get(range);
    if body.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if body.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if body.starts_with(b"GIF87a") || body.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if at(0..4) == Some(b"RIFF") && at(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if at(4..8) == Some(b"ftyp") && matches!(at(8..12), Some(b"avif") | Some(b"avis")) {
        Some("image/avif")
    } else if body.starts_with(&[0, 0, 1, 0]) && body.len() > 22 {
        Some("image/x-icon")
    } else if body.starts_with(b"BM") && body.len() > 26 {
        Some("image/bmp")
    } else {
        let head = text_head(body);
        let svg = head.starts_with("<svg")
            || ((head.starts_with("<?xml") || head.starts_with("<!--")) && head.contains("<svg"));
        svg.then_some("image/svg+xml")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_types_are_classified() {
        assert_eq!(classify("image/png"), Declared::Image("image/png".into()));
        assert_eq!(
            classify("image/svg+xml"),
            Declared::Image("image/svg+xml".into())
        );
        assert_eq!(classify("image/jpg"), Declared::Image("image/jpeg".into()));
        assert_eq!(
            classify("image/vnd.microsoft.icon"),
            Declared::Image("image/vnd.microsoft.icon".into())
        );
        assert_eq!(classify(""), Declared::Generic);
        assert_eq!(classify("application/octet-stream"), Declared::Generic);
        assert_eq!(classify("image/"), Declared::Generic);
        assert_eq!(classify("image/p\"ng"), Declared::Generic);
        assert_eq!(classify("text/html"), Declared::Other("text/html".into()));
        assert_eq!(
            classify("application/json"),
            Declared::Other("application/json".into())
        );
        assert_eq!(essence(" Image/PNG ; charset=x"), "image/png");
    }

    #[test]
    fn magic_bytes_are_sniffed() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a......"), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"\0\0\0\x1cftypavif\0\0"), Some("image/avif"));
        assert_eq!(
            sniff(b"\xEF\xBB\xBF  <?xml version=\"1.0\"?>\n<svg xmlns=\"x\"/>"),
            Some("image/svg+xml")
        );
        assert_eq!(
            sniff(b"<SVG viewBox=\"0 0 1 1\"></SVG>"),
            Some("image/svg+xml")
        );
        assert_eq!(sniff(b"<html><body>no</body></html>"), None);
        assert_eq!(sniff(b"#EXTM3U\n"), None);
        assert_eq!(sniff(b"{\"error\":1}"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn html_error_pages_are_recognised() {
        assert!(looks_like_html(b"\n  <!DOCTYPE html><html></html>"));
        assert!(looks_like_html(b"<HTML><body>404</body></HTML>"));
        assert!(!looks_like_html(b"<svg/>"));
        assert!(!looks_like_html(b"\x89PNG\r\n\x1a\n"));
    }
}
