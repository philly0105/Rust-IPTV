//! Mirrors: identical copies of a title on other sources, which a transfer
//! may draw bytes from alongside its own source.
//!
//! Every function here is a placeholder that keeps today's behaviour (no
//! mirrors). The real bodies replace them; the signatures are the contract.

use super::shared::{Endpoint, Fingerprint};
use super::DownloadManager;
use crate::error::{CoreError, CoreResult};
use crate::live::matcher::Quality;
use crate::model::{CopyRef, SourceKind};
use crate::state::AppState;
use rusqlite::Connection;
use std::sync::Arc;

/// A copy of the same title on another source, before verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub copy: CopyRef,
    pub kind: SourceKind,
    pub title: String,
    pub container: Option<String>,
    pub quality: Option<Quality>,
}

/// A verified identical copy, ready to serve ranges.
#[derive(Debug, Clone)]
pub struct Mirror {
    pub endpoint: Endpoint,
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
/// same title as `item` and mirrors apply (not live or catch-up).
pub fn has_candidates(_conn: &Connection, _item: &CopyRef) -> CoreResult<bool> {
    Ok(false)
}

/// Other copies of `item`. Movies match by title; episodes match the series
/// by title, then season and episode numbers.
pub async fn candidates(_state: &Arc<AppState>, _item: &CopyRef) -> CoreResult<Vec<Candidate>> {
    Ok(Vec::new())
}

/// Size and three sample hashes of `ep`, read sequentially on one connection
/// the caller holds. A 200 answer is `Err(CoreError::Unsupported("no ranges"))`.
pub async fn fingerprint(_state: &Arc<AppState>, _ep: &Endpoint) -> CoreResult<Fingerprint> {
    Err(CoreError::Unsupported(
        "mirror fingerprints are not available".into(),
    ))
}

/// The cached fingerprint of `copy`, while still valid.
pub fn cached_fingerprint(_conn: &Connection, _copy: &CopyRef) -> CoreResult<Option<Fingerprint>> {
    Ok(None)
}

/// Caches `fp` as the fingerprint of `copy`.
pub fn store_fingerprint(_conn: &Connection, _copy: &CopyRef, _fp: &Fingerprint) -> CoreResult<()> {
    Ok(())
}

/// Verified identical copies of `item` (exact total and all three samples
/// equal to `fp`), excluding sources in `exclude`, ordered by spare
/// allowance, then fewest current holders. Never errors.
pub async fn identical_copies(
    _state: &Arc<AppState>,
    _mgr: &DownloadManager,
    _item: &CopyRef,
    _fp: &Fingerprint,
    _exclude: &[String],
) -> Vec<Mirror> {
    Vec::new()
}

/// DB only: copies with a fresh Identical verdict for `item`.
pub fn cached_identical(_conn: &Connection, _item: &CopyRef) -> CoreResult<Vec<CopyRef>> {
    Ok(Vec::new())
}

/// Same quality (both `None` counts as equal), same container
/// (case-insensitive; `None` is never equivalent), and sizes within 15% of
/// the larger.
pub fn equivalent(_a: &CopyMeta, _b: &CopyMeta) -> bool {
    false
}

/// A junction comparison between `item` and `mirror` failed.
/// `against_authority`: the other side was the authority's bytes, so the
/// pair is recorded as differing; otherwise any Identical verdict for the
/// pair is dropped so the next use re-verifies.
pub async fn record_mismatch(
    _state: &Arc<AppState>,
    _item: &CopyRef,
    _mirror: &CopyRef,
    _against_authority: bool,
) {
}
