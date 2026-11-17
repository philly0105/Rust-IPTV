//! Mirrors: identical copies of a title on other sources, which a transfer
//! may draw bytes from alongside its own source, and which the queue may
//! start a row on when its own source is busy.
//!
//! - **Discovery** ([`has_candidates`], [`candidates`]): movies by title
//!   (`catalog::same_title`); episodes by their series' title, then the
//!   primary episode's season and episode numbers in each other series.
//! - **Fingerprints** ([`fingerprint`]): the total and SHA-256 of three
//!   64 KiB windows (`shared::sample_offsets`), read one after the other on
//!   one connection the caller holds.
//! - **Verification** ([`identical_copies`]): a candidate is a mirror only
//!   with the exact total and all three hashes equal. Bytes outside the
//!   windows are not compared here; the engine's overlap checks catch a copy
//!   that differs only there and report it through [`record_mismatch`].
//! - **The verdict cache** ([`cached_fingerprint`], [`cached_identical`]):
//!   `app_state` records under `shared::mirror_key`, with the validity
//!   windows in [`cache`].
//! - **Equivalence** ([`equivalent`]): the looser match the opt-in
//!   "equivalent copies" setting allows for queue spreading.
//!
//! Nothing here ever fails a download: lookups that fail find no mirrors,
//! checks that fail record `Unavailable` for an hour.

mod cache;
mod discover;
mod sample;
mod verify;

use super::shared::{Endpoint, Fingerprint};
use super::DownloadManager;
use crate::error::{CoreError, CoreResult};
use crate::live::matcher::Quality;
use crate::model::{CopyRef, SourceKind};
use crate::state::AppState;
use rusqlite::Connection;
use std::sync::Arc;
use std::time::Duration;

pub use verify::RefuseHolds;

/// A copy of the same title on another source, before verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub copy: CopyRef,
    pub kind: SourceKind,
    /// The catalog title of the movie or series.
    pub title: String,
    /// Lowercase extension without the dot ("mkv"), when known.
    pub container: Option<String>,
    /// Quality named in the title ("4K", "FHD").
    pub quality: Option<Quality>,
}

/// A verified identical copy, ready to serve ranges.
#[derive(Debug, Clone)]
pub struct Mirror {
    pub endpoint: Endpoint,
    /// The copy's own fingerprint (its validator, the authority's total and
    /// samples).
    pub fingerprint: Fingerprint,
}

/// What [`equivalent`] compares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyMeta {
    pub quality: Option<Quality>,
    pub container: Option<String>,
    pub total: i64,
}

/// DB only, under 5 ms. True when another movie or series source has the
/// same title as `item` and mirrors apply (a movie or one episode; never
/// live, radio or catch-up).
pub fn has_candidates(conn: &Connection, item: &CopyRef) -> CoreResult<bool> {
    discover::has_candidates(conn, item)
}

/// Other copies of `item`. Movies match by title; episodes match the series
/// by title, then the season and episode numbers the primary's own seasons
/// give the episode. Xtream sources are always searched; Stalker and M3U
/// ones are best effort (a series whose seasons cannot be read is skipped).
/// An item that is not in the catalog has none.
pub async fn candidates(state: &Arc<AppState>, item: &CopyRef) -> CoreResult<Vec<Candidate>> {
    discover::candidates(state, item).await
}

/// Size and three sample hashes of `ep`, read sequentially on one connection
/// the caller holds. A 200 answer is `Err(CoreError::Unsupported("no ranges"))`;
/// so is an answer without the file's size, or a file smaller than
/// `shared::MIN_MIRROR_TOTAL`. Nothing is stored ([`store_fingerprint`]).
pub async fn fingerprint(state: &Arc<AppState>, ep: &Endpoint) -> CoreResult<Fingerprint> {
    match sample::sample(state, ep, None).await {
        Ok(fp) => Ok(fp),
        Err(sample::SampleError::Failed(err)) => Err(err),
        // Only returned when a total is expected.
        Err(sample::SampleError::Total(total)) => {
            Err(CoreError::Conflict(format!("unexpected file size {total}")))
        }
    }
}

/// The cached fingerprint of `copy`, while still valid: with a validator,
/// until the caller sees another total or validator ([`still_matches`]);
/// without one, for 7 days.
pub fn cached_fingerprint(conn: &Connection, copy: &CopyRef) -> CoreResult<Option<Fingerprint>> {
    cache::cached_fingerprint(conn, copy, cache::now())
}

/// Caches `fp` as the fingerprint of `copy`. A fingerprint that shows other
/// bytes (or another validator) than the cached one also drops `copy`'s
/// verdicts, which compared bytes it no longer has.
pub fn store_fingerprint(conn: &Connection, copy: &CopyRef, fp: &Fingerprint) -> CoreResult<()> {
    cache::store_fingerprint(conn, copy, fp)
}

/// Whether a cached `fp` still describes a copy that now answers with
/// `total` and `validator`: the same total, and the same validator when the
/// fingerprint has one.
pub fn still_matches(fp: &Fingerprint, total: i64, validator: Option<&str>) -> bool {
    fp.total == total && fp.validator.as_deref().is_none_or(|v| Some(v) == validator)
}

/// Verified identical copies of `item` (exact total and all three samples
/// equal to `fp`), excluding sources in `exclude`, at most one per source,
/// ordered by spare allowance, then the catalog's order.
///
/// Standing verdicts and cached fingerprints decide first; every other
/// candidate is sampled under `mgr.try_hold(.., Verify)` on its source, and
/// a source whose hold is refused is skipped (recorded Unavailable for an
/// hour). Every comparison is recorded: a copy with other bytes is
/// Equivalent (under both copies' records, for queue spreading) when
/// [`equivalent`] holds for the two copies' quality, container and total,
/// else Differs. Equivalent copies are never returned. Never errors:
/// failures become Unavailable. Empty while `downloadUseMirrors` is off.
pub async fn identical_copies(
    state: &Arc<AppState>,
    mgr: &DownloadManager,
    item: &CopyRef,
    fp: &Fingerprint,
    exclude: &[String],
) -> Vec<Mirror> {
    verify::identical_copies(state, mgr, item, fp, exclude).await
}

/// DB only: copies with a standing Identical verdict for `item`, on other
/// sources, ordered by source.
pub fn cached_identical(conn: &Connection, item: &CopyRef) -> CoreResult<Vec<CopyRef>> {
    cache::cached_identical(conn, item, cache::now())
}

/// Same quality (both `None` counts as equal), same container
/// (case-insensitive, a leading dot ignored; `None` is never equivalent),
/// and sizes within 15% of the larger. An unknown size (0 or less) is never
/// equivalent.
pub fn equivalent(a: &CopyMeta, b: &CopyMeta) -> bool {
    let container = |m: &CopyMeta| {
        m.container
            .as_deref()
            .map(|c| c.trim().trim_start_matches('.').to_ascii_lowercase())
            .filter(|c| !c.is_empty())
    };
    let (ca, cb) = (container(a), container(b));
    if a.quality != b.quality || ca.is_none() || ca != cb || a.total <= 0 || b.total <= 0 {
        return false;
    }
    let (x, y) = (i128::from(a.total), i128::from(b.total));
    (x - y).abs() * 100 <= x.max(y) * 15
}

/// A junction comparison between `item` and `mirror` failed.
/// `against_authority`: the other side was the authority's bytes, so the
/// pair is recorded as differing (under both copies' records); otherwise
/// any Identical verdict for the pair is dropped, with the mirror's cached
/// fingerprint, so the next use re-verifies with the provider. Never fails;
/// a write that fails is logged.
pub async fn record_mismatch(
    state: &Arc<AppState>,
    item: &CopyRef,
    mirror: &CopyRef,
    against_authority: bool,
) {
    verify::record_mismatch(state, item, mirror, against_authority).await
}

/// Test hook: ages every mirror record's fingerprint and verdict stamps by
/// `by`, as if that much time had gone by.
#[doc(hidden)]
pub async fn age_records(state: &Arc<AppState>, by: Duration) -> CoreResult<()> {
    state.db_write(move |c| cache::age(c, by).map(|_| ())).await
}

/// Test hook: while the guard lives, verification finds no spare
/// connection on `source`, as when `DownloadManager::try_hold` refuses.
#[doc(hidden)]
pub fn refuse_holds(state: &AppState, source: &str) -> RefuseHolds {
    verify::refuse_holds(state, source)
}

#[cfg(test)]
mod tests;
