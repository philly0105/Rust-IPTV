//! Getting an XMLTV body onto local disk and opening it as a stream.
//!
//! Remote URLs are downloaded to a temp file under `data_dir/tmp` first (the
//! parser then reads the file, so a slow DB never stalls a socket and a broken
//! download never touches stored data). `file://` URLs and plain paths are
//! read in place. Gzip is detected by its magic bytes, not by the URL or the
//! Content-Type, because providers mislabel both.

use crate::error::{CoreError, CoreResult};
use crate::model::RequestHeaders;
use crate::state::AppState;
use futures::StreamExt;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

/// Read buffer size for the XML stream.
const READ_BUF: usize = 256 * 1024;
/// Downloads larger than this are refused (protects the disk).
pub const MAX_DOWNLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Attempts for a remote download (transient errors only).
const ATTEMPTS: u32 = 3;

/// Where an EPG URL points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Location {
    Remote(String),
    Local(PathBuf),
}

/// Classifies an EPG URL: `http(s)://` is remote; `file://` and anything else
/// is a local path.
pub fn classify(url: &str) -> CoreResult<Location> {
    let t = url.trim();
    let lower = t.get(..8).unwrap_or(t).to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Ok(Location::Remote(t.to_string()));
    }
    if lower.starts_with("file://") {
        let parsed =
            url::Url::parse(t).map_err(|e| CoreError::Invalid(format!("invalid file URL: {e}")))?;
        let path = parsed
            .to_file_path()
            .map_err(|_| CoreError::Invalid("file URL does not name a local path".into()))?;
        return Ok(Location::Local(path));
    }
    if t.is_empty() {
        return Err(CoreError::Invalid("empty EPG URL".into()));
    }
    Ok(Location::Local(PathBuf::from(t)))
}

/// A URL safe to log: remote URLs are redacted, local paths kept.
pub fn log_url(url: &str) -> String {
    match classify(url) {
        Ok(Location::Remote(u)) => crate::logging::redact_url(&u),
        Ok(Location::Local(p)) => p.display().to_string(),
        Err(_) => "<invalid>".into(),
    }
}

/// A body ready to parse.
#[derive(Debug)]
pub struct Body {
    pub path: PathBuf,
    /// True when `path` is a temp download that must be deleted after use.
    pub temp: bool,
    /// ETag of the response (remote only).
    pub etag: Option<String>,
    pub bytes: u64,
}

impl Body {
    /// Deletes the temp file, if any.
    pub fn cleanup(&self) {
        if self.temp {
            if let Err(err) = std::fs::remove_file(&self.path) {
                tracing::debug!(%err, "could not delete EPG temp file");
            }
        }
    }
}

/// Result of [`fetch`].
#[derive(Debug)]
pub enum Fetched {
    /// The server answered 304 to our `If-None-Match`.
    NotModified,
    Body(Body),
}

/// Directory for temp downloads.
pub fn temp_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("tmp")
}

/// Deletes leftover `epg-*.part` files from a previous run.
pub fn clean_temp_dir(state: &AppState) {
    let Ok(rd) = std::fs::read_dir(temp_dir(state)) else {
        return;
    };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("epg-") && name.ends_with(".part") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Resolves `url` to a local body. Remote bodies are streamed to a temp file
/// with the source headers and, when `etag` is given, `If-None-Match`.
/// `on_bytes` receives the running byte count of a download.
pub async fn fetch(
    state: &AppState,
    url: &str,
    headers: &RequestHeaders,
    etag: Option<&str>,
    on_bytes: &(dyn Fn(u64) + Send + Sync),
) -> CoreResult<Fetched> {
    match classify(url)? {
        Location::Local(path) => {
            let meta = tokio::fs::metadata(&path).await.map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    CoreError::NotFound(format!(
                        "EPG file not found: {}. Check the path in Settings > EPG.",
                        path.display()
                    ))
                } else {
                    CoreError::Io(e)
                }
            })?;
            if !meta.is_file() {
                return Err(CoreError::Invalid(format!(
                    "EPG path is not a file: {}",
                    path.display()
                )));
            }
            Ok(Fetched::Body(Body {
                path,
                temp: false,
                etag: None,
                bytes: meta.len(),
            }))
        }
        Location::Remote(u) => {
            let dir = temp_dir(state);
            tokio::fs::create_dir_all(&dir).await?;
            crate::http::with_retry(ATTEMPTS, || {
                download(state, &u, headers, etag, &dir, on_bytes)
            })
            .await
        }
    }
}

async fn download(
    state: &AppState,
    url: &str,
    headers: &RequestHeaders,
    etag: Option<&str>,
    dir: &Path,
    on_bytes: &(dyn Fn(u64) + Send + Sync),
) -> CoreResult<Fetched> {
    // Server mode: guarded client; an XMLTV URL on a private host needs
    // --allow-private-targets.
    crate::http::check_fetch(state, url, None).await?;
    let mut req =
        crate::http::apply_source_headers(crate::http::client_for(state).get(url), headers);
    if let Some(tag) = etag {
        req = req.header(reqwest::header::IF_NONE_MATCH, tag);
    }
    let resp = crate::http::send(req).await?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(Fetched::NotModified);
    }
    if !status.is_success() {
        return Err(crate::http::status_error(status, "EPG download"));
    }
    if resp
        .content_length()
        .is_some_and(|n| n > MAX_DOWNLOAD_BYTES)
    {
        return Err(CoreError::Invalid("EPG file is larger than 2 GB".into()));
    }
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let path = dir.join(format!("epg-{}.part", uuid::Uuid::new_v4().simple()));
    let result = async {
        let mut file = tokio::fs::File::create(&path).await?;
        let mut stream = resp.bytes_stream();
        let mut total: u64 = 0;
        let mut reported: u64 = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            total += chunk.len() as u64;
            if total > MAX_DOWNLOAD_BYTES {
                return Err(CoreError::Invalid("EPG file is larger than 2 GB".into()));
            }
            file.write_all(&chunk).await?;
            if total - reported >= 4 * 1024 * 1024 {
                reported = total;
                on_bytes(total);
            }
        }
        file.flush().await?;
        Ok::<u64, CoreError>(total)
    }
    .await;
    match result {
        Ok(bytes) => Ok(Fetched::Body(Body {
            path,
            temp: true,
            etag,
            bytes,
        })),
        Err(err) => {
            let _ = tokio::fs::remove_file(&path).await;
            Err(err)
        }
    }
}

/// Opens a body for streaming: gzip (magic `1f 8b`) is decompressed on the
/// fly, a UTF-8 BOM is skipped, and zip / xz / bzip2 archives are refused with
/// a clear message.
pub fn open_reader(path: &Path) -> CoreResult<Box<dyn BufRead + Send>> {
    let file = File::open(path)?;
    let mut raw = BufReader::with_capacity(READ_BUF, file);
    let head = raw.fill_buf()?;
    let mut reader: Box<dyn BufRead + Send> = if head.starts_with(&[0x1f, 0x8b]) {
        Box::new(BufReader::with_capacity(
            READ_BUF,
            flate2::bufread::MultiGzDecoder::new(raw),
        ))
    } else if head.starts_with(b"PK\x03\x04") {
        return Err(CoreError::Unsupported(
            "EPG file is a zip archive; use an .xml or .xml.gz URL".into(),
        ));
    } else if head.starts_with(&[0xfd, b'7', b'z', b'X', b'Z']) || head.starts_with(b"BZh") {
        return Err(CoreError::Unsupported(
            "EPG file is xz/bzip2 compressed; use an .xml or .xml.gz URL".into(),
        ));
    } else {
        Box::new(raw)
    };
    let head = reader.fill_buf()?;
    if head.starts_with(&[0xef, 0xbb, 0xbf]) {
        reader.consume(3);
    }
    Ok(reader)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies() {
        assert_eq!(
            classify("https://x/epg.xml").unwrap(),
            Location::Remote("https://x/epg.xml".into())
        );
        assert_eq!(
            classify(" HTTP://x ").unwrap(),
            Location::Remote("HTTP://x".into())
        );
        assert!(matches!(
            classify("C:\\epg\\a.xml").unwrap(),
            Location::Local(_)
        ));
        assert!(matches!(
            classify("/tmp/a.xml").unwrap(),
            Location::Local(_)
        ));
        assert!(classify("  ").is_err());
    }
}
