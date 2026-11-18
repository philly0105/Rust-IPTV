//! Verifying candidates against a fingerprint, and what a failed junction
//! check tells the verdict cache.
//!
//! Each candidate source is checked on its own task, its candidates one
//! after the other under at most one connection hold
//! ([`DownloadManager::try_hold`] with [`HoldPurpose::Verify`]), taken only
//! when a candidate needs the network. A standing verdict, or a cached
//! fingerprint of the candidate, decides without asking the provider. The
//! first identical copy found on a source ends that source's checks: two
//! copies on one account share its connections, so a second adds nothing.

use super::cache::{self, now, stamp};
use super::discover;
use super::sample::{sample, SampleError};
use super::{Candidate, CopyMeta, Mirror};
use crate::downloads::manager::{ConnHold, HoldPurpose};
use crate::downloads::shared::{
    resolve, Fingerprint, MirrorRecord, Verdict, VerdictEntry, MIN_MIRROR_TOTAL,
};
use crate::downloads::DownloadManager;
use crate::model::CopyRef;
use crate::state::AppState;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long resolving and sampling one candidate may take before it counts
/// as unavailable.
const VERIFY_LIMIT: Duration = Duration::from_secs(45);

pub(super) async fn identical_copies(
    state: &Arc<AppState>,
    mgr: &DownloadManager,
    item: &CopyRef,
    fp: &Fingerprint,
    exclude: &[String],
) -> Vec<Mirror> {
    if !discover::applies(item)
        || fp.total < MIN_MIRROR_TOTAL
        || !state.settings.read().download_use_mirrors
    {
        return Vec::new();
    }
    let (own, candidates) = match discover::search(state, item).await {
        Ok(found) => found,
        Err(err) => {
            tracing::debug!(source = %item.source_id(), error = %err, "no mirror candidates");
            return Vec::new();
        }
    };
    // By source, in the catalog's order.
    let mut groups: Vec<(String, Vec<Candidate>)> = Vec::new();
    for c in candidates {
        let src = c.copy.source_id().to_string();
        if src == item.source_id() || exclude.contains(&src) {
            continue;
        }
        match groups.iter_mut().find(|(s, _)| *s == src) {
            Some((_, list)) => list.push(c),
            None => groups.push((src, vec![c])),
        }
    }
    if groups.is_empty() {
        return Vec::new();
    }
    // The authority's record, reconciled with `fp`: a fingerprint that
    // shows other bytes than the stored one drops the old verdicts.
    let (key, print) = (item.clone(), fp.clone());
    let record = state
        .db_write(move |c| {
            // A source removed meanwhile gets no record back.
            if cache::source_exists(c, key.source_id())? {
                cache::store_fingerprint(c, &key, &print)?;
            }
            cache::load(c, &key)
        })
        .await
        .unwrap_or_else(|err| {
            tracing::warn!(error = %err, "could not read the mirror record");
            None
        });
    let checks = groups.into_iter().map(|(source, list)| {
        let (record, own) = (record.as_ref(), &own);
        async move {
            let found = check_source(state, mgr, item, own, fp, record, &source, list).await;
            found.map(|m| (source, m))
        }
    });
    let found: Vec<(String, Mirror)> = futures::future::join_all(checks)
        .await
        .into_iter()
        .flatten()
        .collect();
    order(mgr, item, found)
}

/// Most spare connections first, then fewest holders. Ties keep the
/// catalog's order.
fn order(mgr: &DownloadManager, item: &CopyRef, found: Vec<(String, Mirror)>) -> Vec<Mirror> {
    let mut ranked: Vec<((usize, usize), Mirror)> = found
        .into_iter()
        .map(|(source, m)| (spare_and_holders(mgr, item.source_id(), &source), m))
        .collect();
    ranked.sort_by_key(|((spare, holders), _)| (std::cmp::Reverse(*spare), *holders));
    ranked.into_iter().map(|(_, m)| m).collect()
}

/// A transfer of `item_source`'s spare connections on `source`, and how many
/// active transfers hold connections there now. The one place mirror
/// ordering asks the manager.
fn spare_and_holders(mgr: &DownloadManager, item_source: &str, source: &str) -> (usize, usize) {
    (mgr.spare_on(item_source, source), mgr.holders(source))
}

/// How a candidate whose bytes differ from the item's compares: Equivalent
/// when [`super::equivalent`] holds for their quality, container and
/// `total`, else Differs.
fn mismatch(own: &discover::Own, cand: &Candidate, fp: &Fingerprint, total: i64) -> Verdict {
    let ours = CopyMeta {
        quality: own.quality,
        container: own.container.clone(),
        total: fp.total,
    };
    let theirs = CopyMeta {
        quality: cand.quality,
        container: cand.container.clone(),
        total,
    };
    if super::equivalent(&ours, &theirs) {
        Verdict::Equivalent
    } else {
        Verdict::Differs
    }
}

/// The first identical copy among `list` (all on `source`), recording a
/// verdict for each candidate checked. A copy with other bytes is recorded
/// Equivalent when it passes [`super::equivalent`] against `own`, else
/// Differs; neither is ever returned.
#[allow(clippy::too_many_arguments)]
async fn check_source(
    state: &Arc<AppState>,
    mgr: &DownloadManager,
    item: &CopyRef,
    own: &discover::Own,
    fp: &Fingerprint,
    record: Option<&MirrorRecord>,
    source: &str,
    list: Vec<Candidate>,
) -> Option<Mirror> {
    let mut hold: Option<Hold> = None;
    let mut refused = false;
    for cand in list {
        let copy = cand.copy.clone();
        let theirs = {
            let key = copy.clone();
            state
                .db_call(move |c| cache::cached_fingerprint(c, &key, now()))
                .await
                .unwrap_or(None)
        };
        // 1. A verdict that still stands.
        let standing = record.and_then(|r| cache::fresh_verdict(r, &copy, theirs.as_ref(), now()));
        match standing {
            Some(Verdict::Identical) => {
                let entry = record.and_then(|r| r.verdicts.iter().find(|e| e.copy == copy));
                let print = theirs
                    .clone()
                    .filter(|t| cache::same_bytes(t, fp))
                    .unwrap_or_else(|| Fingerprint {
                        validator: entry.and_then(|e| e.validator.clone()),
                        checked_at: entry
                            .map_or_else(|| fp.checked_at.clone(), |e| e.checked_at.clone()),
                        ..fp.clone()
                    });
                match resolve(state, &copy).await {
                    Ok(endpoint) => {
                        return Some(Mirror {
                            endpoint,
                            fingerprint: print,
                        })
                    }
                    Err(err) => {
                        tracing::debug!(source, error = %err, "an identical copy no longer resolves");
                        note(state, item, fp, &copy, Verdict::Unavailable, None).await;
                        continue;
                    }
                }
            }
            Some(_) => continue,
            None => {}
        }
        // 2. The candidate's own cached fingerprint.
        if let Some(theirs) = theirs {
            let same = cache::same_bytes(&theirs, fp);
            if same {
                if let Ok(endpoint) = resolve(state, &copy).await {
                    note(state, item, fp, &copy, Verdict::Identical, Some(&theirs)).await;
                    return Some(Mirror {
                        endpoint,
                        fingerprint: theirs,
                    });
                }
                // It no longer resolves: ask the provider below.
            } else {
                let verdict = mismatch(own, &cand, fp, theirs.total);
                note(state, item, fp, &copy, verdict, Some(&theirs)).await;
                continue;
            }
        }
        // 3. The provider, under a hold on one of the source's connections.
        if hold.is_none() && !refused {
            hold = Hold::take(state, mgr, source);
            refused = hold.is_none();
        }
        if refused {
            tracing::debug!(
                source,
                "no spare connection to verify a mirror; skipped for now"
            );
            note_busy(state, item, &copy).await;
            continue;
        }
        let checked = tokio::time::timeout(VERIFY_LIMIT, async {
            let endpoint = resolve(state, &copy).await.map_err(SampleError::Failed)?;
            let print = sample(state, &endpoint, Some(fp.total)).await?;
            Ok::<_, SampleError>((endpoint, print))
        })
        .await;
        match checked {
            Ok(Ok((endpoint, print))) => {
                let key = copy.clone();
                let stored = print.clone();
                if let Err(err) = state
                    .db_write(move |c| {
                        if cache::source_exists(c, key.source_id())? {
                            cache::store_fingerprint(c, &key, &stored)?;
                        }
                        Ok(())
                    })
                    .await
                {
                    tracing::warn!(error = %err, "could not store a mirror fingerprint");
                }
                if cache::same_bytes(&print, fp) {
                    note(state, item, fp, &copy, Verdict::Identical, Some(&print)).await;
                    return Some(Mirror {
                        endpoint,
                        fingerprint: print,
                    });
                }
                let verdict = mismatch(own, &cand, fp, print.total);
                note(state, item, fp, &copy, verdict, Some(&print)).await;
            }
            Ok(Err(SampleError::Total(total))) => {
                let other = Fingerprint {
                    total,
                    validator: None,
                    samples: Default::default(),
                    checked_at: String::new(),
                };
                let verdict = mismatch(own, &cand, fp, total);
                note(state, item, fp, &copy, verdict, Some(&other)).await;
            }
            Ok(Err(SampleError::Failed(err))) => {
                tracing::debug!(source, error = %err, "a mirror candidate could not be checked");
                note(state, item, fp, &copy, Verdict::Unavailable, None).await;
            }
            Err(_) => {
                tracing::debug!(source, "checking a mirror candidate took too long");
                note(state, item, fp, &copy, Verdict::Unavailable, None).await;
            }
        }
    }
    None
}

/// Records how `copy` compared with `item` (whose fingerprint is `fp`):
/// under `item`'s record, and an Identical or Equivalent verdict also under
/// `copy`'s (the relation is symmetric; queue spreading reads either side).
/// `theirs` is what was learned of `copy` (its total and validator).
async fn note(
    state: &Arc<AppState>,
    item: &CopyRef,
    fp: &Fingerprint,
    copy: &CopyRef,
    verdict: Verdict,
    theirs: Option<&Fingerprint>,
) {
    let at = stamp(now());
    let entry = VerdictEntry {
        copy: copy.clone(),
        verdict,
        total: theirs.map(|t| t.total),
        validator: theirs.and_then(|t| t.validator.clone()),
        checked_at: at.clone(),
    };
    let back = matches!(verdict, Verdict::Identical | Verdict::Equivalent).then(|| VerdictEntry {
        copy: item.clone(),
        verdict,
        total: Some(fp.total),
        validator: fp.validator.clone(),
        checked_at: at,
    });
    save(state, item, entry, back).await;
}

/// Records that `copy`'s source had no spare connection to verify it: an
/// Unavailable verdict that stands only [`cache::BUSY_TTL`].
async fn note_busy(state: &Arc<AppState>, item: &CopyRef, copy: &CopyRef) {
    let entry = VerdictEntry {
        copy: copy.clone(),
        verdict: Verdict::Unavailable,
        total: None,
        validator: Some(cache::BUSY.to_string()),
        checked_at: stamp(now()),
    };
    save(state, item, entry, None).await;
}

/// Writes `entry` under `item`'s record and `back` under the record of
/// `entry.copy`, only while both sources still exist (a source removed
/// meanwhile must not come back as a record, or be named in one).
async fn save(
    state: &Arc<AppState>,
    item: &CopyRef,
    entry: VerdictEntry,
    back: Option<VerdictEntry>,
) {
    let owner = item.clone();
    let wrote = state
        .db_write(move |c| {
            let other = entry.copy.clone();
            if !cache::source_exists(c, owner.source_id())?
                || !cache::source_exists(c, other.source_id())?
            {
                return Ok(());
            }
            cache::record_verdict(c, &owner, entry)?;
            if let Some(back) = back {
                cache::record_verdict(c, &other, back)?;
            }
            Ok(())
        })
        .await;
    if let Err(err) = wrote {
        tracing::warn!(error = %err, "could not record a mirror verdict");
    }
}

pub(super) async fn record_mismatch(
    state: &Arc<AppState>,
    item: &CopyRef,
    mirror: &CopyRef,
    against_authority: bool,
) {
    let (item, mirror) = (item.clone(), mirror.clone());
    let wrote = state
        .db_write(move |c| {
            let at = stamp(now());
            let entry = |copy: &CopyRef, fp: Option<Fingerprint>| VerdictEntry {
                copy: copy.clone(),
                verdict: Verdict::Differs,
                total: fp.as_ref().map(|f| f.total),
                validator: fp.and_then(|f| f.validator),
                checked_at: at.clone(),
            };
            let theirs = cache::load(c, &mirror)?.and_then(|r| r.fingerprint);
            let ours = cache::load(c, &item)?.and_then(|r| r.fingerprint);
            // A removed source's records stay gone, and nothing names it.
            let (item_on, mirror_on) = (
                cache::source_exists(c, item.source_id())?,
                cache::source_exists(c, mirror.source_id())?,
            );
            if !against_authority {
                // Which side is wrong is unknown: the pairing goes, and so
                // does the mirror's cached fingerprint, so the next use asks
                // the provider again instead of trusting what it said before.
                // An Equivalent verdict becomes Differs, so no row adopts
                // that copy again while it stands.
                cache::drop_verdict(c, &item, &mirror, Verdict::Identical)?;
                cache::drop_verdict(c, &mirror, &item, Verdict::Identical)?;
                let equivalent = cache::drop_verdict(c, &item, &mirror, Verdict::Equivalent)?
                    | cache::drop_verdict(c, &mirror, &item, Verdict::Equivalent)?;
                if equivalent && item_on && mirror_on {
                    cache::record_verdict(c, &item, entry(&mirror, theirs))?;
                    cache::record_verdict(c, &mirror, entry(&item, ours))?;
                }
                // The mirror's other matches were compared with the
                // fingerprint that goes now, and a match stands while the
                // copy's fingerprint is unknown (`cache::fresh_verdict`):
                // they go too.
                cache::drop_matches(c, &mirror)?;
                cache::forget_fingerprint(c, &mirror)?;
                return Ok(());
            }
            if item_on && mirror_on {
                cache::record_verdict(c, &item, entry(&mirror, theirs))?;
                cache::record_verdict(c, &mirror, entry(&item, ours))?;
            }
            Ok(())
        })
        .await;
    if let Err(err) = wrote {
        tracing::warn!(error = %err, "could not record a mirror mismatch");
    }
}

/// One connection of a candidate's source, held while it is verified.
struct Hold {
    _hold: ConnHold,
}

impl Hold {
    fn take(state: &AppState, mgr: &DownloadManager, source: &str) -> Option<Hold> {
        if refusing(state, source) {
            return None;
        }
        mgr.try_hold(source, HoldPurpose::Verify)
            .map(|h| Hold { _hold: h })
    }
}

/// Sources whose verification holds are refused on purpose, per state.
/// Tests only ([`refuse_holds`]).
static REFUSED: Mutex<Vec<(usize, String)>> = Mutex::new(Vec::new());

fn state_key(state: &AppState) -> usize {
    state as *const AppState as usize
}

fn refusing(state: &AppState, source: &str) -> bool {
    let key = state_key(state);
    REFUSED
        .lock()
        .map(|r| r.iter().any(|(k, s)| *k == key && s == source))
        .unwrap_or(false)
}

/// While the returned guard lives, verifying a candidate on `source` finds
/// no spare connection, as when the manager's `try_hold` refuses. Tests
/// only.
pub(super) fn refuse_holds(state: &AppState, source: &str) -> RefuseHolds {
    let entry = (state_key(state), source.to_string());
    if let Ok(mut r) = REFUSED.lock() {
        r.push(entry.clone());
    }
    RefuseHolds { entry }
}

/// Ends [`refuse_holds`] when dropped.
#[must_use = "holds are refused only while the guard lives"]
pub struct RefuseHolds {
    entry: (usize, String),
}

impl Drop for RefuseHolds {
    fn drop(&mut self) {
        if let Ok(mut r) = REFUSED.lock() {
            if let Some(i) = r.iter().position(|e| *e == self.entry) {
                r.remove(i);
            }
        }
    }
}
