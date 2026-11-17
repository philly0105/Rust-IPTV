//! Reading a copy's three sample windows ([`shared::sample_offsets`]): one
//! `Range` request after the other on one connection the caller holds.
//!
//! The first answer gives the total and the validator. The other two go to
//! the URL the first one was finally served from (a panel's 302 to an edge
//! server is followed once, not three times), and back to the copy's own
//! URL once when that fails (an edge token can expire between requests).
//! Every answer must be a 206 for exactly the window asked for, with the
//! same total and validator as the first: anything else fails the sample, so
//! a fingerprint never mixes two states of a file.

use crate::downloads::manager;
use crate::downloads::shared::{
    sample_offsets, Endpoint, Fingerprint, MIN_MIRROR_TOTAL, SAMPLE_LEN,
};
use crate::error::{CoreError, CoreResult};
use crate::http::{apply_source_headers, send_within, source_client, status_error};
use crate::state::AppState;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_RANGE, ETAG, LAST_MODIFIED, RANGE};
use reqwest::StatusCode;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;

/// Why a sample did not produce a fingerprint.
#[derive(Debug)]
pub(super) enum SampleError {
    /// The first answer's total is not the one expected: another file.
    /// Only returned when the caller passed an expected total.
    Total(i64),
    /// Anything else (no ranges, refused, failed, changed mid-way).
    Failed(CoreError),
}

impl From<CoreError> for SampleError {
    fn from(err: CoreError) -> Self {
        SampleError::Failed(err)
    }
}

/// One answered window.
struct Window {
    total: i64,
    validator: Option<String>,
    hash: String,
    /// Where the answer finally came from (after redirects).
    served_from: String,
}

/// The fingerprint of `ep`. With `expect_total`, stops after the first
/// request when the copy's total is another ([`SampleError::Total`]).
pub(super) async fn sample(
    state: &Arc<AppState>,
    ep: &Endpoint,
    expect_total: Option<i64>,
) -> Result<Fingerprint, SampleError> {
    let first = window(state, ep, &ep.url, 0).await?;
    if expect_total.is_some_and(|t| t != first.total) {
        return Err(SampleError::Total(first.total));
    }
    if first.total < MIN_MIRROR_TOTAL {
        return Err(CoreError::Unsupported(format!(
            "the file is too small for mirrors ({} bytes)",
            first.total
        ))
        .into());
    }
    let [_, mid, end] = sample_offsets(first.total);
    let mut samples = [first.hash.clone(), String::new(), String::new()];
    let mut pinned = first.served_from.clone();
    for (slot, at) in [(1, mid), (2, end)] {
        let w = match window(state, ep, &pinned, at).await {
            Ok(w) => w,
            // The redirect target may have expired: once more from the start.
            Err(_) if pinned != ep.url => {
                let w = window(state, ep, &ep.url, at).await?;
                pinned = w.served_from.clone();
                w
            }
            Err(err) => return Err(err.into()),
        };
        if w.total != first.total || w.validator != first.validator {
            return Err(
                CoreError::Conflict("the file changed while its samples were read".into()).into(),
            );
        }
        samples[slot] = w.hash;
    }
    Ok(Fingerprint {
        total: first.total,
        validator: first.validator,
        samples,
        checked_at: super::cache::stamp(super::cache::now()),
    })
}

/// Reads the window at `at` of `ep` from `url` (the copy's own URL or where
/// it redirected to).
async fn window(state: &Arc<AppState>, ep: &Endpoint, url: &str, at: i64) -> CoreResult<Window> {
    let (head_limit, idle_limit) = manager::manager(state).idle_timeouts();
    let client = source_client(state, ep.copy.source_id(), url).await;
    let last = at + SAMPLE_LEN - 1;
    let req = apply_source_headers(client.get(url), &ep.headers)
        .header(RANGE, format!("bytes={at}-{last}"))
        .header(ACCEPT_ENCODING, "identity");
    let mut resp = send_within(req, head_limit).await?;
    let status = resp.status();
    if status == StatusCode::OK {
        return Err(CoreError::Unsupported("no ranges".into()));
    }
    if status != StatusCode::PARTIAL_CONTENT {
        return Err(status_error(status, "Reading a sample of the file"));
    }
    let range = resp
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(content_range);
    let Some((start, end, Some(total))) = range else {
        return Err(CoreError::Unsupported(
            "the server answered a range without the file's size".into(),
        ));
    };
    // The window must start where asked and hold all of it (or the file's
    // end); a server that sends more than asked is read only that far.
    let len = SAMPLE_LEN.min(total - at);
    if start != at || len <= 0 || end < at + len - 1 {
        return Err(CoreError::Conflict(format!(
            "the server answered bytes {start}-{end}/{total} for {at}-{last}"
        )));
    }
    let validator = validator_of(&resp);
    let served_from = resp.url().to_string();
    // Just the window: its end follows the last byte, and seeing it lets
    // the connection go back to the pool for the next window.
    let exact = end == at + len - 1;
    let mut hasher = Sha256::new();
    let mut left = len as usize;
    while left > 0 {
        let chunk = next_chunk(&mut resp, idle_limit).await?;
        let Some(chunk) = chunk else {
            return Err(CoreError::Network(
                "the server ended a sample before its end".into(),
            ));
        };
        let take = chunk.len().min(left);
        hasher.update(&chunk[..take]);
        left -= take;
    }
    if exact {
        let _ = next_chunk(&mut resp, Duration::from_millis(200)).await;
    }
    Ok(Window {
        total,
        validator,
        hash: hex::encode(hasher.finalize()),
        served_from,
    })
}

async fn next_chunk(
    resp: &mut reqwest::Response,
    idle: Duration,
) -> CoreResult<Option<bytes::Bytes>> {
    match tokio::time::timeout(idle, resp.chunk()).await {
        Ok(Ok(chunk)) => Ok(chunk),
        Ok(Err(err)) => Err(CoreError::Network(format!(
            "reading a sample failed: {}",
            err.without_url()
        ))),
        Err(_) => Err(CoreError::Timeout(format!(
            "the server sent no sample bytes for {} s",
            idle.as_secs()
        ))),
    }
}

/// `bytes 100-199/2000` -> (100, 199, Some(2000)); `/*` -> no total.
fn content_range(v: &str) -> Option<(i64, i64, Option<i64>)> {
    let rest = v.trim().strip_prefix("bytes")?.trim();
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let total = match total.trim() {
        "*" => None,
        t => Some(t.parse().ok()?),
    };
    Some((start.trim().parse().ok()?, end.trim().parse().ok()?, total))
}

/// Strong ETag, else Last-Modified (as the transfer reads them).
fn validator_of(resp: &reqwest::Response) -> Option<String> {
    let header = |name| {
        resp.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    header(ETAG)
        .filter(|e| !e.starts_with("W/"))
        .or_else(|| header(LAST_MODIFIED))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_reads_start_end_and_total() {
        assert_eq!(
            content_range("bytes 0-65535/209715200"),
            Some((0, 65535, Some(209_715_200)))
        );
        assert_eq!(content_range(" bytes 10-19/*"), Some((10, 19, None)));
        assert_eq!(content_range("bytes */100"), None);
        assert_eq!(content_range("items 0-1/2"), None);
        assert_eq!(content_range("bytes 0-1/x"), None);
    }
}
