//! Queue spreading: where a queued row could start when its own source has
//! no room, the fingerprint batch that finds such places, and the endpoint
//! resolved ahead for the next row.
//!
//! A plan lists, per queued row, the copies it may run on besides its home:
//! copies with a standing Identical verdict (of its origin, when it has
//! one), and for a row without an origin, copies with an Equivalent verdict.
//! A row moves to another copy only while it is fresh (no bytes, no `.part`
//! content, no sidecar) or its `.part` has a valid sidecar, which records
//! the copy each range came from; a plain `.part` stays on its home. The
//! pump uses equivalent copies only while `download_allow_equivalent` is on
//! and the row is fresh; the claim checks both again and stores an
//! equivalent copy as the row's origin in the same write.

use super::{manager, DownloadManager, Policy, TaskCtl};
use crate::downloads::shared::{self, Endpoint, MirrorRecord, Verdict};
use crate::downloads::{mirrors, naming, segments, store};
use crate::error::CoreResult;
use crate::model::{CopyRef, Download};
use crate::state::AppState;
use rusqlite::Connection;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long a plan stands before the pump reads it again (new verdicts, a
/// row that got bytes).
pub(super) const PLAN_TTL: Duration = Duration::from_secs(30);
/// How long an Identical or Equivalent verdict counts.
const VERDICT_TTL: chrono::Duration = chrono::Duration::days(30);
/// Most rows one fingerprint batch covers.
const BATCH_MAX: usize = 8;

#[derive(Debug, Clone)]
pub(super) enum PlanState {
    /// Being read; the row waits for its home meanwhile.
    Loading,
    Ready(Plan),
}

/// Where a queued row could start besides its home.
#[derive(Debug, Clone)]
pub(super) struct Plan {
    pub(super) at: Instant,
    /// Copies identical to the row's bytes (its own copy's, or its
    /// origin's).
    pub(super) identical: Vec<CopyRef>,
    /// Copies equivalent to the row's own; empty for a row with an origin.
    pub(super) equivalent: Vec<CopyRef>,
    /// The row has no bytes yet, so it may still adopt an equivalent copy.
    pub(super) fresh: bool,
    /// The row may run on another copy at all ([`may_move`]).
    pub(super) movable: bool,
}

impl Plan {
    fn empty() -> Self {
        Self {
            at: Instant::now(),
            identical: Vec::new(),
            equivalent: Vec::new(),
            fresh: false,
            movable: false,
        }
    }

    /// Whether the row could start on `source` under `policy`.
    pub(super) fn targets(&self, source: &str, policy: &Policy, has_origin: bool) -> bool {
        let on = |copies: &[CopyRef]| copies.iter().any(|c| c.source_id() == source);
        self.movable && on(&self.identical)
            || policy.allow_equivalent && self.fresh && !has_origin && on(&self.equivalent)
    }
}

/// An endpoint resolved ahead for a row.
#[derive(Debug, Clone)]
pub(super) enum Pre {
    /// A resolve runs since then.
    Pending(Instant),
    Ready {
        at: Instant,
        ep: Endpoint,
        /// `ep` is the row's own copy (it has no origin).
        own: bool,
    },
}

impl Pre {
    fn fresh(&self) -> bool {
        let at = match self {
            Pre::Pending(at) | Pre::Ready { at, .. } => at,
        };
        at.elapsed() < super::PRERESOLVE_TTL
    }
}

/// True when row `d` holds no bytes of any copy yet: none counted, no
/// `.part` content and no sidecar. Such a row may still switch to an
/// equivalent copy.
pub(super) fn is_fresh(d: &Download) -> bool {
    if d.bytes_downloaded > 0 {
        return false;
    }
    let Some(path) = d.file_path.as_deref() else {
        return true;
    };
    let part = naming::part_path(Path::new(path));
    let empty = std::fs::metadata(&part).map_or(true, |m| m.len() == 0);
    empty && !segments::ranges_path(&part).exists()
}

/// True when row `d` may run on a copy other than the one its bytes came
/// from: it is [fresh](is_fresh), or its `.part` has a valid sidecar, which
/// records the copy each range came from. A plain `.part` would be
/// continued with another copy's bytes.
pub(super) fn may_move(d: &Download) -> bool {
    if is_fresh(d) {
        return true;
    }
    let Some(path) = d.file_path.as_deref() else {
        return false;
    };
    let part = naming::part_path(Path::new(path));
    matches!(segments::load(&part), segments::Sidecar::Valid(_))
}

/// Copies `copy`'s mirror record lists as Equivalent: the newest entry per
/// copy, younger than [`VERDICT_TTL`], and still standing against the
/// copy's own cached fingerprint (the total and validator compared), as
/// the mirrors' own verdict checks require.
fn equivalent_copies(conn: &Connection, copy: &CopyRef) -> CoreResult<Vec<CopyRef>> {
    let Some(record) = shared::read_record::<MirrorRecord>(conn, &shared::mirror_key(copy))? else {
        return Ok(Vec::new());
    };
    let cutoff = chrono::Utc::now() - VERDICT_TTL;
    let mut newest: Vec<(
        &CopyRef,
        chrono::DateTime<chrono::FixedOffset>,
        &shared::VerdictEntry,
    )> = Vec::new();
    for e in &record.verdicts {
        let Ok(at) = chrono::DateTime::parse_from_rfc3339(&e.checked_at) else {
            continue;
        };
        match newest.iter_mut().find(|(c, ..)| **c == e.copy) {
            Some(slot) if slot.1 < at => *slot = (&e.copy, at, e),
            Some(_) => {}
            None => newest.push((&e.copy, at, e)),
        }
    }
    let mut out = Vec::new();
    for (c, at, e) in newest {
        if e.verdict != Verdict::Equivalent || at < cutoff {
            continue;
        }
        let standing = mirrors::cached_fingerprint(conn, c)?.is_none_or(|fp| {
            e.total.is_none_or(|t| t == fp.total)
                && match (&e.validator, &fp.validator) {
                    (Some(a), Some(b)) => a == b,
                    _ => true,
                }
        });
        if standing {
            out.push(c.clone());
        }
    }
    Ok(out)
}

/// Row `id`'s origin and plan, from the database.
fn plan_for(conn: &Connection, id: i64) -> CoreResult<(Option<CopyRef>, Plan)> {
    let d = store::get(conn, id)?.download;
    let own = CopyRef::new(d.item_ref.clone(), d.episode_id.clone());
    let base = d.origin.clone().unwrap_or_else(|| own.clone());
    // Standing verdicts only: a copy whose cached fingerprint shows other
    // bytes than the ones compared is left out.
    let mut identical = mirrors::cached_identical(conn, &base)?;
    identical.retain(|c| *c != base && *c != own);
    let equivalent = if d.origin.is_none() {
        equivalent_copies(conn, &own)?
    } else {
        Vec::new()
    };
    let plan = Plan {
        at: Instant::now(),
        identical,
        equivalent,
        fresh: is_fresh(&d),
        movable: may_move(&d),
    };
    Ok((d.origin, plan))
}

/// Reads the plans of `ids` (and their stored origins) in one database
/// call, then pumps. A row whose read fails gets an empty plan, so it waits
/// for its home until the plan is read again.
pub(super) async fn load_plans(state: Arc<AppState>, mgr: Arc<DownloadManager>, ids: Vec<i64>) {
    let wanted = ids.clone();
    let read = state
        .db_call(move |c| {
            Ok(wanted
                .into_iter()
                .map(|id| (id, plan_for(c, id).ok()))
                .collect())
        })
        .await
        .unwrap_or_else(|_: crate::error::CoreError| {
            ids.into_iter().map(|id| (id, None)).collect::<Vec<_>>()
        });
    {
        let mut inner = mgr.inner.lock();
        for (id, found) in read {
            let tracked = inner.queued_from.contains_key(&id) || inner.active.contains_key(&id);
            let plan = match found {
                Some((origin, plan)) => {
                    if tracked {
                        match origin {
                            Some(o) => inner.origins.insert(id, o),
                            None => inner.origins.remove(&id),
                        };
                    }
                    plan
                }
                None => Plan::empty(),
            };
            if let Some(slot @ PlanState::Loading) = inner.plans.get_mut(&id) {
                *slot = PlanState::Ready(plan);
            }
        }
    }
    super::pump(&state, &mgr);
}

/// Before row `id` claims its home source, fingerprints up to K of the
/// home's queued rows that have candidate copies elsewhere (K = 1 + the
/// candidate sources with room, at most [`BATCH_MAX`]) on the connection the
/// run already holds there, and has each verified on those sources
/// ([`mirrors::identical_copies`], which holds its own connections there).
/// Their plans are read again afterwards, so the rows that now have
/// identical copies spread at once. Each row is batched once per run of the
/// queue; fingerprints and verdicts are cached, so this is cheap the next
/// time. Stops early when the run is asked to stop.
pub(super) async fn fingerprint_batch(
    state: &Arc<AppState>,
    mgr: &Arc<DownloadManager>,
    id: i64,
    ctl: &TaskCtl,
) {
    let home = ctl.source.clone();
    let ids: Vec<i64> = {
        let inner = mgr.inner.lock();
        std::iter::once(id)
            .chain(
                inner
                    .queue
                    .iter()
                    .copied()
                    .filter(|q| {
                        inner.home(*q) == Some(home.as_str())
                            && !inner.origins.contains_key(q)
                            && !inner.batched.contains(q)
                    })
                    .take(2 * BATCH_MAX),
            )
            .collect()
    };
    let rows = state
        .db_call(move |c| {
            let mut rows = Vec::new();
            for id in ids {
                let Ok(row) = store::get(c, id) else {
                    continue;
                };
                let d = row.download;
                let copy = CopyRef::new(d.item_ref, d.episode_id);
                if d.origin.is_none() && mirrors::has_candidates(c, &copy)? {
                    let fp = mirrors::cached_fingerprint(c, &copy)?;
                    rows.push((id, copy, fp));
                }
            }
            Ok(rows)
        })
        .await
        .unwrap_or_default();
    let done = |rows: &[i64]| {
        let mut inner = mgr.inner.lock();
        for r in rows {
            inner.batched.insert(*r);
            if matches!(inner.plans.get(r), Some(PlanState::Ready(_))) {
                inner.plans.remove(r);
            }
        }
    };
    if !rows.iter().any(|(r, ..)| *r != id) {
        done(&[id]);
        return;
    }
    let candidates = mirrors::candidates(state, &rows[0].1)
        .await
        .unwrap_or_default();
    let sources: HashSet<&str> = candidates
        .iter()
        .map(|c| c.copy.source_id())
        .filter(|s| *s != home && mgr.spare_on(&home, s) > 0)
        .collect();
    let k = (1 + sources.len()).min(BATCH_MAX);
    let exclude = [home.clone()];
    let mut covered = vec![id];
    for (rid, copy, cached) in rows.into_iter().take(k) {
        if ctl.token.is_cancelled() {
            break;
        }
        let fp = match cached {
            Some(fp) => fp,
            None => {
                let Ok(ep) = shared::resolve(state, &copy).await else {
                    continue;
                };
                let Ok(fp) = mirrors::fingerprint(state, &ep).await else {
                    continue;
                };
                let (c2, f2) = (copy.clone(), fp.clone());
                if let Err(err) = state
                    .db_call(move |c| mirrors::store_fingerprint(c, &c2, &f2))
                    .await
                {
                    tracing::debug!(error = %err, "could not cache a fingerprint");
                }
                fp
            }
        };
        let _ = mirrors::identical_copies(state, mgr, &copy, &fp, &exclude).await;
        covered.push(rid);
    }
    done(&covered);
    mgr.repump();
}

/// Resolves the queue's front row ahead (its origin's copy, or its own),
/// so its run can start without waiting for the provider's answer. Kept
/// for [`super::PRERESOLVE_TTL`].
pub(super) fn preresolve_next(state: &Arc<AppState>, mgr: &Arc<DownloadManager>) {
    let id = {
        let mut inner = mgr.inner.lock();
        let Some(id) = inner.queue.front().copied() else {
            return;
        };
        if inner.preresolved.get(&id).is_some_and(Pre::fresh) {
            return;
        }
        inner.preresolved.insert(id, Pre::Pending(Instant::now()));
        id
    };
    let state = state.clone();
    tokio::spawn(async move {
        let mgr = manager(&state);
        let resolved = match state.db_call(move |c| store::get(c, id)).await {
            Ok(row) => {
                let d = row.download;
                let own = d.origin.is_none();
                let copy = d
                    .origin
                    .unwrap_or_else(|| CopyRef::new(d.item_ref, d.episode_id));
                shared::resolve(&state, &copy)
                    .await
                    .ok()
                    .map(|ep| (ep, own))
            }
            Err(_) => None,
        };
        let mut inner = mgr.inner.lock();
        if !matches!(inner.preresolved.get(&id), Some(Pre::Pending(_))) {
            return;
        }
        match resolved {
            Some((ep, own)) => {
                inner.preresolved.insert(
                    id,
                    Pre::Ready {
                        at: Instant::now(),
                        ep,
                        own,
                    },
                );
            }
            None => {
                inner.preresolved.remove(&id);
            }
        }
    });
}
