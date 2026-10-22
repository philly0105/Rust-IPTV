//! Parked readers for MPEG-TS played by mpegts.js.
//!
//! mpegts.js loads a non-live MPEG-TS file (catch-up, a TS movie) lazily: once
//! it holds 60 s ahead it aborts its request, and after 30 s of playback it
//! asks for the rest with `Range: bytes=<n>-`. Passed straight through, every
//! pause closed the provider's connection and every resume opened a new one,
//! about twice a minute. A one-connection account can refuse the reopen while
//! the panel still counts the old connection, and a panel that ignores Range
//! answers it from byte 0, which mpegts.js appends as if it were the rest.
//!
//! So when the player lets go of a long MPEG-TS body before its end, its reader
//! parks ([`Park::wait`]) for [`PARK_FOR`]: it keeps the upstream connection,
//! keeps what it read from at least [`SLACK_BYTES`] behind what the player took
//! (bytes still in the socket and the browser count as not received), and
//! reads on until it holds [`KEEP_BYTES`]. A GET for the same URL, source and headers
//! whose Range starts at a byte it holds continues from it, with no new
//! upstream request. Any other request for the same source (or host, without
//! one), `release=1` (the player was torn down), a newer park on the same
//! source or the time running out lets the reader go, which closes the
//! connection.

use super::readahead::{self, Chunk, Span, READAHEAD_BYTES};
use axum::http::header::HeaderMap;
use bytes::Bytes;
use futures::stream::{BoxStream, Stream, StreamExt};
use iptv_core::model::RequestHeaders;
use std::collections::{HashMap, VecDeque};
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use url::Url;

/// How long a reader waits for the player's resume: mpegts.js asks again after
/// 30 s of playback.
pub(crate) const PARK_FOR: Duration = Duration::from_secs(45);
/// Only bodies this long park: a programme or a movie, not an HLS segment.
pub(crate) const PARK_MIN_BYTES: u64 = 16 << 20;
/// Kept behind what the player took: hyper, the socket buffers (several MB
/// each way on a loopback) and the browser's stream queue hold bytes it took
/// but never received, and it resumes from what it received.
pub(crate) const SLACK_BYTES: u64 = 16 << 20;
/// Most a parked reader holds; it stops reading upstream there.
pub(crate) const KEEP_BYTES: u64 = READAHEAD_BYTES as u64 + SLACK_BYTES;
/// Parked readers at once, across sources.
const MAX_PARKED: usize = 4;
/// A release lands before the reader notices the player let go: a source
/// released this recently doesn't park.
const RELEASE_GRACE: Duration = Duration::from_secs(5);

/// The source a request is for (its id, else the URL's host): one parked
/// reader each, and any request for it lets that reader go.
pub(crate) fn scope(source_id: Option<&str>, url: &Url) -> String {
    match source_id {
        Some(id) => format!("source:{id}"),
        None => format!("host:{}", url.host_str().unwrap_or("")),
    }
}

/// MPEG-TS by type, or by a `.ts` path when the type says nothing.
pub(crate) fn is_mpeg_ts(content_type: &str, path: &str) -> bool {
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match essence.as_str() {
        "video/mp2t" | "application/x-mpegts" => true,
        "" | "application/octet-stream" | "binary/octet-stream" => {
            path.to_ascii_lowercase().ends_with(".ts")
        }
        _ => false,
    }
}

/// What a continuation must match: the same URL, source and headers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParkKey {
    scope: String,
    url: String,
    headers: [Option<String>; 3],
}

impl ParkKey {
    pub(crate) fn new(scope: String, url: &Url, headers: &RequestHeaders) -> Self {
        Self {
            scope,
            url: url.to_string(),
            headers: [
                headers.user_agent.clone(),
                headers.referrer.clone(),
                headers.origin.clone(),
            ],
        }
    }
}

/// A continuation's answer: the parked body's span and upstream headers.
#[derive(Clone)]
pub(crate) struct ParkMeta {
    pub span: Span,
    pub headers: HeaderMap,
}

struct Attach {
    from: u64,
    tx: mpsc::UnboundedSender<Chunk>,
    accepted: oneshot::Sender<bool>,
}

/// A parked reader, handed to the request that may continue it.
pub(crate) struct Slot {
    id: u64,
    key: ParkKey,
    meta: ParkMeta,
    taken: Arc<AtomicU64>,
    attach: oneshot::Sender<Attach>,
}

impl Slot {
    /// The rest of the body from byte `from`, or `None` when the reader no
    /// longer holds that byte (it is let go then).
    pub(crate) async fn attach(
        self,
        from: u64,
    ) -> Option<(
        impl Stream<Item = io::Result<Bytes>> + Send + 'static,
        ParkMeta,
    )> {
        let (tx, rx) = mpsc::unbounded_channel();
        let (accepted, answer) = oneshot::channel();
        self.attach.send(Attach { from, tx, accepted }).ok()?;
        if !answer.await.unwrap_or(false) {
            return None;
        }
        let len = self.meta.span.end + 1 - from;
        Some((readahead::consumer(rx, self.taken, len), self.meta))
    }
}

#[derive(Default)]
struct Inner {
    slots: Vec<Slot>,
    released: HashMap<String, Instant>,
    ids: u64,
}

/// The proxy's parked readers.
#[derive(Default)]
pub(crate) struct Parking {
    inner: Mutex<Inner>,
}

impl Parking {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn park(
        &self,
        key: ParkKey,
        meta: ParkMeta,
        taken: Arc<AtomicU64>,
        attach: oneshot::Sender<Attach>,
    ) -> Option<u64> {
        let mut g = self.lock();
        let now = Instant::now();
        g.released
            .retain(|_, at| now.duration_since(*at) < RELEASE_GRACE);
        if g.released.contains_key(&key.scope) {
            return None;
        }
        g.slots.retain(|s| s.key.scope != key.scope);
        if g.slots.len() >= MAX_PARKED {
            g.slots.remove(0);
        }
        g.ids += 1;
        let id = g.ids;
        g.slots.push(Slot {
            id,
            key,
            meta,
            taken,
            attach,
        });
        Some(id)
    }

    fn expire(&self, id: u64) {
        self.lock().slots.retain(|s| s.id != id);
    }

    /// A request for `key`'s source: whatever is parked for that source is let
    /// go, except a reader of `key` itself, which is handed over.
    pub(crate) fn take(&self, key: &ParkKey) -> Option<Slot> {
        let mut g = self.lock();
        let mut found = None;
        for s in std::mem::take(&mut g.slots) {
            if s.key.scope != key.scope {
                g.slots.push(s);
            } else if found.is_none() && s.key == *key {
                found = Some(s);
            }
        }
        found
    }

    /// The player was torn down: let go of what is parked for `scope`, and of a
    /// reader that parks there in the next moments.
    pub(crate) fn release(&self, scope: &str) {
        let mut g = self.lock();
        g.slots.retain(|s| s.key.scope != scope);
        g.released.insert(scope.to_owned(), Instant::now());
    }

    #[cfg(test)]
    fn parked(&self) -> usize {
        self.lock().slots.len()
    }
}

/// The bytes a reader read, from a little behind where the player is.
pub(crate) struct Kept {
    chunks: VecDeque<Bytes>,
    /// File offset of the first kept byte.
    start: u64,
    len: u64,
}

impl Kept {
    pub(crate) fn new(start: u64) -> Self {
        Self {
            chunks: VecDeque::new(),
            start,
            len: 0,
        }
    }

    /// File offset after the last kept byte.
    pub(crate) fn end(&self) -> u64 {
        self.start + self.len
    }

    /// Keeps `chunk`, then drops whole chunks that end at or before `floor`.
    pub(crate) fn push(&mut self, chunk: Bytes, floor: u64) {
        self.len += chunk.len() as u64;
        self.chunks.push_back(chunk);
        while let Some(front) = self.chunks.front() {
            let n = front.len() as u64;
            if self.start + n > floor {
                break;
            }
            self.chunks.pop_front();
            self.start += n;
            self.len -= n;
        }
    }

    /// The kept bytes from file offset `from` on.
    pub(crate) fn from(&self, from: u64) -> Vec<Bytes> {
        let mut at = self.start;
        let mut out = Vec::new();
        for c in &self.chunks {
            let n = c.len() as u64;
            if at + n > from {
                let skip = from.saturating_sub(at) as usize;
                out.push(c.slice(skip..));
            }
            at += n;
        }
        out
    }
}

/// A body's way to park: the registry, its key and its upstream headers.
pub(crate) struct Park {
    pub parking: Arc<Parking>,
    pub key: ParkKey,
    pub headers: HeaderMap,
}

/// Where a parked reader stands: `sent` bytes of `span` read from upstream,
/// `done` once it read them all.
pub(crate) struct Progress<'a> {
    pub body: &'a mut BoxStream<'static, reqwest::Result<Bytes>>,
    pub kept: &'a mut Kept,
    pub sent: &'a mut u64,
    pub done: &'a mut bool,
}

impl Park {
    /// The player let go of the body. Unless it had all of it, waits for a
    /// continuation, reading on meanwhile, and returns the new player's
    /// channel and the byte it starts at; `None` when the reader should stop.
    pub(crate) async fn wait(
        &self,
        span: Span,
        taken: &Arc<AtomicU64>,
        p: Progress<'_>,
    ) -> Option<(mpsc::UnboundedSender<Chunk>, u64)> {
        if taken.load(Ordering::Relaxed) > span.end {
            return None;
        }
        let meta = ParkMeta {
            span,
            headers: self.headers.clone(),
        };
        let (attach, mut asked) = oneshot::channel::<Attach>();
        let id = self
            .parking
            .park(self.key.clone(), meta, Arc::clone(taken), attach)?;
        let expiry = tokio::time::sleep(PARK_FOR);
        tokio::pin!(expiry);
        loop {
            let more = !*p.done && p.kept.len < KEEP_BYTES;
            tokio::select! {
                a = &mut asked => {
                    // An error: let go (another request, a release, a newer park).
                    let a = a.ok()?;
                    let held = a.from >= p.kept.start && a.from <= p.kept.end() && a.from <= span.end;
                    if held {
                        taken.store(a.from, Ordering::Relaxed);
                    }
                    let _ = a.accepted.send(held);
                    return held.then_some((a.tx, a.from));
                }
                _ = &mut expiry => {
                    self.parking.expire(id);
                    return None;
                }
                next = p.body.next(), if more => match next {
                    Some(Ok(chunk)) => {
                        *p.sent += chunk.len() as u64;
                        p.kept.push(chunk, 0);
                    }
                    None if *p.sent >= span.byte_count() => *p.done = true,
                    // The upstream dropped: nothing to continue from.
                    _ => {
                        self.parking.expire(id);
                        return None;
                    }
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(scope: &str, url: &str) -> ParkKey {
        ParkKey::new(
            scope.to_owned(),
            &Url::parse(url).unwrap(),
            &RequestHeaders::default(),
        )
    }

    fn meta() -> ParkMeta {
        ParkMeta {
            span: Span {
                start: 0,
                end: 99,
                total: Some(100),
            },
            headers: HeaderMap::new(),
        }
    }

    fn park(p: &Parking, k: &ParkKey) -> (Option<u64>, oneshot::Receiver<Attach>) {
        let (tx, rx) = oneshot::channel();
        (p.park(k.clone(), meta(), Arc::default(), tx), rx)
    }

    #[test]
    fn only_long_mpeg_ts_parks() {
        assert!(is_mpeg_ts("video/MP2T", "/x"));
        assert!(is_mpeg_ts("application/x-mpegts; a=b", "/x"));
        assert!(is_mpeg_ts(
            "application/octet-stream",
            "/timeshift/u/p/9/x/1.ts"
        ));
        assert!(is_mpeg_ts("", "/movie/u/p/1.TS"));
        assert!(!is_mpeg_ts("application/octet-stream", "/movie/u/p/1.mp4"));
        assert!(!is_mpeg_ts("video/mp4", "/movie/u/p/1.ts"));
    }

    #[test]
    fn a_request_hands_over_its_reader_and_lets_the_rest_of_the_source_go() {
        let p = Parking::default();
        let a = key("source:x", "http://p/a.ts");
        let other = key("source:y", "http://p/a.ts");
        let (_, mut a_rx) = park(&p, &a);
        let (_, _other_rx) = park(&p, &other);
        assert_eq!(p.parked(), 2);
        // Another URL of the same source: `a` is let go, `other` stays.
        assert!(p.take(&key("source:x", "http://p/b.ts")).is_none());
        assert!(matches!(
            a_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert_eq!(p.parked(), 1);
        let (_, _a_rx) = park(&p, &a);
        let slot = p.take(&a).expect("the same key is handed over");
        assert_eq!(slot.key, a);
        assert_eq!(p.parked(), 1);
    }

    #[test]
    fn a_newer_park_replaces_the_source_and_a_release_keeps_it_from_parking() {
        let p = Parking::default();
        let a = key("source:x", "http://p/a.ts");
        let (first, _rx1) = park(&p, &a);
        let (second, _rx2) = park(&p, &key("source:x", "http://p/b.ts"));
        assert!(first.is_some() && second.is_some());
        assert_eq!(p.parked(), 1);
        p.release("source:x");
        assert_eq!(p.parked(), 0);
        assert_eq!(park(&p, &a).0, None);
        assert!(park(&p, &key("source:y", "http://p/a.ts")).0.is_some());
        for i in 0..MAX_PARKED + 2 {
            park(&p, &key(&format!("host:{i}"), "http://p/a.ts"));
        }
        assert_eq!(p.parked(), MAX_PARKED);
    }

    #[test]
    fn kept_bytes_follow_the_player() {
        let mut k = Kept::new(1000);
        for i in 0..4u8 {
            k.push(Bytes::from(vec![i; 10]), 0);
        }
        assert_eq!((k.start, k.end()), (1000, 1040));
        let from: Vec<u8> = k.from(1015).iter().flat_map(|b| b.to_vec()).collect();
        assert_eq!(from, [vec![1u8; 5], vec![2; 10], vec![3; 10]].concat());
        // The player is past 1025: the chunks that end by then go.
        k.push(Bytes::from(vec![4; 10]), 1025);
        assert_eq!((k.start, k.end()), (1020, 1050));
    }
}
