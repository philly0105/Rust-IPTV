//! Read-ahead and resume for media bodies of known length (a movie, an
//! episode, an HLS segment).
//!
//! The webview's `<video>` reads a progressive file about ten seconds ahead
//! and then stops reading until it has played some of it. Passed straight
//! through, each of those pauses also stops the provider's connection, and a
//! provider that slows down for longer than those few seconds stalls
//! playback. So a reader task keeps up to [`READAHEAD_BYTES`] in memory ahead
//! of the player.
//!
//! When the upstream connection drops before the body is complete, the
//! server takes byte ranges and its first answer carried a validator (a
//! strong ETag, else Last-Modified), the reader asks for the rest with a Range
//! request (with that validator as `If-Range`, so a file that changed is
//! never spliced in) and carries on in the same response, up to
//! [`RESUME_ATTEMPTS`] failed tries in a row. The player never sees the drop.
//! Without a validator a replacement of the same length could not be told
//! apart, so the drop reaches the player.
//!
//! The reader stops as soon as the player lets go of the response (a seek,
//! another item), which frees the provider's connection at once: many IPTV
//! accounts allow one connection at a time. A long MPEG-TS body is the
//! exception: mpegts.js lets go of it on purpose and asks for the rest a
//! moment later, so its reader parks instead (park.rs).

use super::park::{Kept, Park, Progress, SLACK_BYTES};
use super::{Fail, Upstream};
use axum::http::header::{self, HeaderMap, HeaderValue};
use axum::http::{Method, StatusCode};
use bytes::Bytes;
use futures::stream::{self, BoxStream, Stream, StreamExt};
use iptv_core::http::backoff_delay;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use url::Url;

/// Bytes the reader holds ahead of the player, per response.
pub(crate) const READAHEAD_BYTES: usize = 32 << 20;
/// Resume requests in a row that may fail before the response fails.
pub(crate) const RESUME_ATTEMPTS: u32 = 3;

/// The bytes of the file a response body carries (inclusive offsets).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Span {
    pub start: u64,
    pub end: u64,
    /// The whole file's size, when the server gave it.
    pub total: Option<u64>,
}

impl Span {
    /// The span of a 200 or 206 body whose length the server gave.
    pub(crate) fn of(status: StatusCode, headers: &HeaderMap) -> Option<Self> {
        let len: u64 = headers
            .get(header::CONTENT_LENGTH)?
            .to_str()
            .ok()?
            .trim()
            .parse()
            .ok()?;
        if len == 0 {
            return None;
        }
        match status {
            StatusCode::OK => Some(Self {
                start: 0,
                end: len - 1,
                total: Some(len),
            }),
            StatusCode::PARTIAL_CONTENT => {
                let range = headers.get(header::CONTENT_RANGE)?.to_str().ok()?;
                let span = parse_content_range(range)?;
                (span.byte_count() == len).then_some(span)
            }
            _ => None,
        }
    }

    pub(crate) fn byte_count(&self) -> u64 {
        self.end - self.start + 1
    }

    /// Whether `rest` carries this span on from `offset`, out of the same file.
    fn continued_by(&self, rest: &Span, offset: u64) -> bool {
        let same_file = rest.total.is_none() || self.total.is_none() || rest.total == self.total;
        rest.start == offset && rest.end <= self.end && same_file
    }
}

/// `bytes <start>-<end>/<total or *>`.
pub(crate) fn parse_content_range(value: &str) -> Option<Span> {
    let rest = value.trim().strip_prefix("bytes")?.trim_start();
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.trim().split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    let end: u64 = end.trim().parse().ok()?;
    let total = match total.trim() {
        "*" => None,
        t => Some(t.parse::<u64>().ok()?),
    };
    if end < start || total.is_some_and(|t| end >= t) {
        return None;
    }
    Some(Span { start, end, total })
}

/// How to ask for the rest of a body after its connection dropped.
pub(crate) struct Resume {
    upstream: Upstream,
    /// The URL the player asked for; its redirects are followed again, so a
    /// provider that hands out expiring links gives a fresh one.
    url: Url,
    /// `If-Range`: a strong ETag, else Last-Modified.
    validator: HeaderValue,
}

impl Resume {
    /// `None` unless the server takes byte ranges for this body and gave a
    /// validator for `If-Range`.
    pub(crate) fn new(
        upstream: Upstream,
        url: Url,
        status: StatusCode,
        headers: &HeaderMap,
    ) -> Option<Self> {
        let accepts = headers.get(header::ACCEPT_RANGES);
        let ranges = accepts.is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"bytes"));
        if status != StatusCode::PARTIAL_CONTENT && !ranges {
            return None;
        }
        let validator = headers
            .get(header::ETAG)
            .filter(|v| !v.as_bytes().starts_with(b"W/"))
            .or_else(|| headers.get(header::LAST_MODIFIED))
            .cloned()?;
        Some(Self {
            upstream,
            url,
            validator,
        })
    }

    fn host(&self) -> &str {
        self.url.host_str().unwrap_or("the stream server")
    }

    /// The body from `offset` to the end of `span`, from a new request.
    async fn reopen(
        &self,
        offset: u64,
        span: Span,
    ) -> Result<BoxStream<'static, reqwest::Result<Bytes>>, String> {
        let range = format!("bytes={offset}-{}", span.end);
        let range = HeaderValue::from_str(&range).map_err(|e| e.to_string())?;
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, range);
        headers.insert(header::IF_RANGE, self.validator.clone());
        let (resp, _) = self
            .upstream
            .fetch(&Method::GET, self.url.clone(), &headers, true)
            .await
            .map_err(|Fail(_, e)| e.message)?;
        if resp.status() != StatusCode::PARTIAL_CONTENT {
            return Err(format!(
                "answered HTTP {} instead of the rest of the file",
                resp.status().as_u16()
            ));
        }
        // Content-Length must match the range too, or the reader would send
        // the player more than it was promised.
        let rest = Span::of(StatusCode::PARTIAL_CONTENT, resp.headers());
        match rest {
            Some(r) if span.continued_by(&r, offset) => Ok(resp.bytes_stream().boxed()),
            _ => Err("sent a different part of the file".to_owned()),
        }
    }
}

/// A chunk on its way to the player, holding its share of the read-ahead room.
pub(crate) type Chunk = io::Result<(Bytes, OwnedSemaphorePermit)>;

/// Streams `body` (the bytes `span` of the file) through a reader task that
/// stays up to [`READAHEAD_BYTES`] ahead of the player and, given `resume`,
/// picks a dropped connection up where it stopped. Given `park`, it parks
/// when the player lets go before the end (park.rs).
pub(crate) fn spawn(
    body: BoxStream<'static, reqwest::Result<Bytes>>,
    span: Span,
    resume: Option<Resume>,
    park: Option<Park>,
) -> impl Stream<Item = io::Result<Bytes>> + Send + 'static {
    let (tx, rx) = mpsc::unbounded_channel::<Chunk>();
    let taken = Arc::new(AtomicU64::new(span.start));
    tokio::spawn(read(body, span, resume, tx, park, Arc::clone(&taken)));
    consumer(rx, taken, span.byte_count())
}

/// The player's side of a reader: `len` bytes of what it sends. `taken` counts
/// the file offset the player has read up to, which a parked reader keeps from.
/// It ends after `len` bytes, so a reader that parks can keep its sender.
pub(crate) fn consumer(
    rx: mpsc::UnboundedReceiver<Chunk>,
    taken: Arc<AtomicU64>,
    len: u64,
) -> impl Stream<Item = io::Result<Bytes>> + Send + 'static {
    stream::unfold((rx, taken, len), |(mut rx, taken, left)| async move {
        if left == 0 {
            return None;
        }
        // The permit drops here, which makes room for the reader.
        match rx.recv().await? {
            Ok((bytes, _room)) => {
                let n = bytes.len() as u64;
                taken.fetch_add(n, Ordering::Relaxed);
                Some((Ok(bytes), (rx, taken, left.saturating_sub(n))))
            }
            Err(e) => Some((Err(e), (rx, taken, 0))),
        }
    })
}

async fn read(
    mut body: BoxStream<'static, reqwest::Result<Bytes>>,
    span: Span,
    resume: Option<Resume>,
    mut tx: mpsc::UnboundedSender<Chunk>,
    park: Option<Park>,
    taken: Arc<AtomicU64>,
) {
    let room = Arc::new(Semaphore::new(READAHEAD_BYTES));
    let mut sent: u64 = 0;
    let mut failures: u32 = 0;
    // Parking: what was read, from a little behind the player, and whether
    // the upstream body is complete.
    let mut kept = Kept::new(span.start);
    let mut done = false;
    loop {
        if tx.is_closed() {
            // The player let go.
            let Some(park) = &park else { return };
            let progress = Progress {
                body: &mut body,
                kept: &mut kept,
                sent: &mut sent,
                done: &mut done,
            };
            let Some((next, from)) = park.wait(span, &taken, progress).await else {
                return;
            };
            // A continuation: what it may not have, then on from the upstream.
            tx = next;
            for chunk in kept.from(from) {
                let need = chunk.len().min(READAHEAD_BYTES) as u32;
                let permit = tokio::select! {
                    _ = tx.closed() => break,
                    permit = Arc::clone(&room).acquire_many_owned(need) => match permit {
                        Ok(p) => p,
                        Err(_) => return,
                    },
                };
                if tx.send(Ok((chunk, permit))).is_err() {
                    break;
                }
            }
            continue;
        }
        if done {
            // All read and sent: wait until the player has it all or lets go.
            tx.closed().await;
            continue;
        }
        let next = tokio::select! {
            _ = tx.closed() => continue,
            next = body.next() => next,
        };
        let failure = match next {
            Some(Ok(chunk)) => {
                if chunk.is_empty() {
                    continue;
                }
                failures = 0;
                sent += chunk.len() as u64;
                if park.is_some() {
                    let floor = taken.load(Ordering::Relaxed).saturating_sub(SLACK_BYTES);
                    kept.push(chunk.clone(), floor);
                }
                let need = chunk.len().min(READAHEAD_BYTES) as u32;
                // A player that lets go here gets this chunk from `kept` if it comes back.
                let permit = tokio::select! {
                    _ = tx.closed() => continue,
                    permit = Arc::clone(&room).acquire_many_owned(need) => match permit {
                        Ok(p) => p,
                        Err(_) => return,
                    },
                };
                let _ = tx.send(Ok((chunk, permit)));
                continue;
            }
            None if sent >= span.byte_count() => {
                if park.is_none() {
                    return;
                }
                done = true;
                continue;
            }
            None => io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the stream server closed the connection early",
            ),
            Some(Err(e)) => io::Error::other(e.without_url()),
        };
        let Some(resume) = &resume else {
            let _ = tx.send(Err(failure));
            return;
        };
        let offset = span.start + sent;
        loop {
            if failures >= RESUME_ATTEMPTS {
                tracing::warn!(
                    host = resume.host(),
                    offset,
                    %failure,
                    "media proxy: the stream server keeps dropping the connection"
                );
                let _ = tx.send(Err(failure));
                return;
            }
            let wait = backoff_delay(failures);
            failures += 1;
            tokio::select! {
                _ = tx.closed() => return,
                _ = tokio::time::sleep(wait) => {}
            }
            let reopened = tokio::select! {
                _ = tx.closed() => return,
                r = resume.reopen(offset, span) => r,
            };
            match reopened {
                Ok(rest) => {
                    tracing::info!(
                        host = resume.host(),
                        offset,
                        "media proxy: resumed a dropped stream"
                    );
                    body = rest;
                    break;
                }
                Err(reason) => tracing::debug!(
                    host = resume.host(),
                    offset,
                    %reason,
                    "media proxy: resume failed"
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(header::HeaderName, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (name, value) in pairs {
            h.insert(name.clone(), HeaderValue::from_str(value).unwrap());
        }
        h
    }

    #[test]
    fn content_ranges_parse() {
        assert_eq!(
            parse_content_range("bytes 100-199/1000"),
            Some(Span {
                start: 100,
                end: 199,
                total: Some(1000)
            })
        );
        assert_eq!(
            parse_content_range("bytes 0-0/*"),
            Some(Span {
                start: 0,
                end: 0,
                total: None
            })
        );
        for bad in [
            "bytes 200-100/1000",
            "bytes 0-1000/1000",
            "bytes */1000",
            "items 0-1/2",
            "bytes 0-1",
            "",
        ] {
            assert_eq!(parse_content_range(bad), None, "{bad}");
        }
    }

    #[test]
    fn spans_need_a_length_that_matches() {
        let full = headers(&[(header::CONTENT_LENGTH, "1000")]);
        assert_eq!(
            Span::of(StatusCode::OK, &full),
            Some(Span {
                start: 0,
                end: 999,
                total: Some(1000)
            })
        );
        let part = headers(&[
            (header::CONTENT_LENGTH, "100"),
            (header::CONTENT_RANGE, "bytes 100-199/1000"),
        ]);
        assert_eq!(
            Span::of(StatusCode::PARTIAL_CONTENT, &part).map(|s| (s.start, s.end)),
            Some((100, 199))
        );
        // A live stream (no length), an empty body, or a length that disagrees.
        assert_eq!(Span::of(StatusCode::OK, &HeaderMap::new()), None);
        assert_eq!(
            Span::of(StatusCode::OK, &headers(&[(header::CONTENT_LENGTH, "0")])),
            None
        );
        let wrong = headers(&[
            (header::CONTENT_LENGTH, "50"),
            (header::CONTENT_RANGE, "bytes 100-199/1000"),
        ]);
        assert_eq!(Span::of(StatusCode::PARTIAL_CONTENT, &wrong), None);
        assert_eq!(Span::of(StatusCode::NOT_MODIFIED, &full), None);
    }
}
