//! Connection-limit probes: finding how many connections a panel really
//! allows, beyond what the account reports.
//!
//! A round runs beside a transfer that holds everything its source gives
//! it. It opens extra Range requests near the file's end one at a time,
//! holds each for [`ProbeTiming::step`](super::manager::ProbeTiming) with
//! its body unread, and stops at the first refusal (any answer but a 2xx),
//! at a kick (the panel ended the oldest connection, the transfer's own, to
//! take the new one) or at the engine's cap plus one. The most
//! connections the panel kept open becomes the source's learned limit
//! ([`LimitRecord`] under [`limit_key`]), retested after a week. A learned
//! limit above the reported one raises the source's download budget
//! ([`super::manager::learned_download_budget`]).
//!
//! A round never touches the row: no settle, no account check, no wait. It
//! aborts, recording nothing, as soon as playback or a recording starts on
//! the source or the transfer stops, and it closes every connection it
//! opened before it returns. After an aborted round the source is not
//! probed for [`super::manager::PROBE_ABORT_BACKOFF`]. A round whose
//! transfer ends (done or failed) keeps what it proved: connections held
//! for a full step above the known limit are recorded as a learned limit,
//! retested after [`super::manager::PROBE_ABORT_BACKOFF`]; with none, the
//! round counts as aborted.

use super::manager::{self, Policy, TaskCtl};
use super::segments::MAX_CONNECTIONS;
use super::shared::{
    delete_record, limit_key, read_record, write_record, Endpoint, LimitRecord, ProbeOutcome,
    ProbeStep,
};
use super::DownloadManager;
use crate::error::CoreResult;
use crate::model::{ConnectionLimitMode, SourceConnectionLimit, SourceKind, TransferNote};
use crate::state::AppState;
use std::str::FromStr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// How far before the file's end probe requests start. Their bodies are
/// never read.
const PROBE_SPAN: i64 = 32 * 1024 * 1024;
/// How often a round checks for a stop, playback or a kick.
const POLL: Duration = Duration::from_millis(25);
/// Steps a [`LimitRecord`] keeps.
const HISTORY: usize = 20;

/// Sync. True when `ctl` should probe `source` now: settings allow it, the
/// source is Xtream or Stalker, its record is missing or due, nothing plays
/// or records from it, no probe runs on it or was aborted there lately, it
/// is not blocked, `ctl` may split (no rate limit, the source not set to one
/// connection, no one-connection fallback in this run), `ctl` holds
/// everything it may there, and the effective limit is below the engine's
/// cap plus one. A source whose record is not read yet is not due (the read
/// starts).
pub fn probe_due(state: &AppState, mgr: &DownloadManager, ctl: &TaskCtl, source: &str) -> bool {
    let policy = Policy::of(&state.settings.read());
    mgr.probe_due_with(ctl, source, &policy)
}

/// How a round's climb ended.
enum End {
    /// The panel refused the next connection: any answer but a 2xx, a
    /// reset, or no answer in time.
    Refused,
    /// The panel took the next connection and ended the oldest.
    Kicked,
    /// The round reached [`MAX_CONNECTIONS`] + 1 connections.
    Cap,
    /// The transfer stopped, or playback or a recording started.
    Abort,
    /// The transfer ended (done or failed) before the climb did.
    Ended,
}

/// Runs one probe round for `ctl` on `ep` (a file of `total` bytes) and
/// records the result. `None` when no round ran.
pub async fn probe(
    state: &Arc<AppState>,
    mgr: &DownloadManager,
    ctl: &TaskCtl,
    ep: &Endpoint,
    total: i64,
) -> Option<ProbeOutcome> {
    probe_until(state, mgr, ctl, ep, total, &CancellationToken::new()).await
}

/// [`probe`], ended early once `end` is cancelled (the transfer ended):
/// the round then keeps what it proved.
pub async fn probe_until(
    state: &Arc<AppState>,
    mgr: &DownloadManager,
    ctl: &TaskCtl,
    ep: &Endpoint,
    total: i64,
    end: &CancellationToken,
) -> Option<ProbeOutcome> {
    let source = ep.copy.source_id().to_string();
    mgr.load_now(state, &source).await;
    if total <= 0 || !probe_due(state, mgr, ctl, &source) {
        return None;
    }
    let round = mgr.begin_probe(ctl, &source)?;
    let timing = mgr.probe_timing();
    let (head_limit, _) = mgr.idle_timeouts();
    let client = crate::http::source_client(state, &source, &ep.url).await;
    let range = format!("bytes={}-{}", (total - PROBE_SPAN).max(0), total - 1);
    let drops_before = ctl.drops(&source);
    let mut open: Vec<reqwest::Response> = Vec::new();
    let mut steps: Vec<ProbeStep> = Vec::new();
    // Connections held open for a full step.
    let mut accepted = 0usize;
    let stop = || {
        if mgr.probe_interrupted(ctl, &source) {
            Some(End::Abort)
        } else if end.is_cancelled() {
            Some(End::Ended)
        } else {
            None
        }
    };
    let step = |connections: usize, outcome: ProbeOutcome| ProbeStep {
        at: now_rfc3339(),
        connections: i64::try_from(connections).unwrap_or(i64::MAX),
        outcome,
    };
    let end = 'climb: loop {
        let trying = round.base + open.len() + 1;
        if trying > MAX_CONNECTIONS + 1 {
            break End::Cap;
        }
        if let Some(e) = stop() {
            break e;
        }
        let req = crate::http::apply_source_headers(
            client
                .get(&ep.url)
                .header(reqwest::header::RANGE, range.as_str()),
            &ep.headers,
        );
        let send = tokio::time::timeout(head_limit, req.send());
        tokio::pin!(send);
        let answer = loop {
            tokio::select! {
                answer = &mut send => break answer,
                _ = tokio::time::sleep(POLL) => {
                    if let Some(e) = stop() {
                        break 'climb e;
                    }
                }
            }
        };
        match answer {
            Ok(Ok(resp)) if resp.status().is_success() => {
                open.push(resp);
                round.open.store(open.len(), Ordering::Relaxed);
            }
            // Any other answer, a reset or no answer in time: the panel
            // would not take it.
            Ok(Ok(resp)) => {
                tracing::debug!(source, status = %resp.status(), "probe connection refused");
                steps.push(step(trying, ProbeOutcome::Refused));
                break End::Refused;
            }
            Ok(Err(_)) | Err(_) => {
                steps.push(step(trying, ProbeOutcome::Refused));
                break End::Refused;
            }
        }
        // Hold every connection for a step, watching for a kick: the
        // transfer's stream (the oldest connection) dropping. Probe bodies
        // stay unread, so the end of a probe's range never looks like one.
        let until = tokio::time::Instant::now() + timing.step;
        loop {
            if let Some(e) = stop() {
                break 'climb e;
            }
            if ctl.drops(&source) > drops_before {
                steps.push(step(trying, ProbeOutcome::KickedOldest));
                break 'climb End::Kicked;
            }
            let now = tokio::time::Instant::now();
            if now >= until {
                break;
            }
            tokio::time::sleep(POLL.min(until - now)).await;
        }
        steps.push(step(trying, ProbeOutcome::Accepted));
        accepted += 1;
    };
    let kept = round.base + open.len();
    // Every probe connection closes before the round ends.
    drop(open);
    round.open.store(0, Ordering::Relaxed);
    let proved = round.base + accepted;
    drop(round);
    let reported = mgr.reported_limit(&source);
    let prior = mgr.record(&source);
    let before = prior.as_ref().map(|r| r.limit).or(reported).unwrap_or(1);
    let short = |n: usize| i64::try_from(n).unwrap_or(i64::MAX) <= before;
    let (limit, mode, outcome) = match end {
        End::Abort => {
            mgr.probe_aborted(&source);
            mgr.repump();
            return Some(ProbeOutcome::Aborted);
        }
        End::Ended if short(proved) => {
            mgr.probe_aborted(&source);
            mgr.repump();
            return Some(ProbeOutcome::Aborted);
        }
        // A lower bound: the climb goes on from it at the next retest.
        End::Ended => (proved, ConnectionLimitMode::Accept, ProbeOutcome::Accepted),
        End::Refused => (kept, ConnectionLimitMode::Refuse, ProbeOutcome::Refused),
        End::Kicked => (
            kept.saturating_sub(1).max(1),
            ConnectionLimitMode::KickOldest,
            ProbeOutcome::KickedOldest,
        ),
        End::Cap => (kept, ConnectionLimitMode::Accept, ProbeOutcome::Accepted),
    };
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let now = chrono::Utc::now();
    let retest = if matches!(end, End::Ended) {
        manager::PROBE_ABORT_BACKOFF
    } else {
        timing.retest_after
    };
    let next = now + chrono::Duration::from_std(retest).unwrap_or(chrono::Duration::days(7));
    let mut history = prior.map(|r| r.history).unwrap_or_default();
    history.extend(steps);
    let cut = history.len().saturating_sub(HISTORY);
    history.drain(..cut);
    let record = LimitRecord {
        version: 1,
        limit,
        reported,
        mode,
        probed_at: rfc3339(now),
        next_probe_at: rfc3339(next),
        history,
    };
    let (sid, saved) = (source.clone(), record.clone());
    match state
        .db_write(move |c| write_record(c, &limit_key(&sid), &saved))
        .await
    {
        Ok(()) => mgr.set_record(&source, Some(record)),
        Err(err) => {
            tracing::warn!(source, error = %err, "could not save the probed connection limit")
        }
    }
    tracing::info!(source, limit, ?mode, "connection limit probed");
    let source_id = source.clone();
    ctl.push_note(match mode {
        ConnectionLimitMode::KickOldest => TransferNote::ProbeKickedOldest { source_id },
        _ if limit > before => TransferNote::ProbeAccepted { source_id, limit },
        _ => TransferNote::ProbeRefused { source_id },
    });
    mgr.repump();
    Some(outcome)
}

fn rfc3339(t: chrono::DateTime<chrono::Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn now_rfc3339() -> String {
    rfc3339(chrono::Utc::now())
}

/// Every Xtream and Stalker source's connection limit as downloads see it
/// (`downloads.connectionLimits`), in the sources' order.
pub async fn list(state: &Arc<AppState>) -> CoreResult<Vec<SourceConnectionLimit>> {
    let mgr = manager::manager(state);
    let disabled = state.settings.read().download_probe_disabled.clone();
    let rows = state
        .db_call(|c| {
            let mut stmt =
                c.prepare("SELECT id, kind FROM sources ORDER BY position, created_at, id")?;
            let sources = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            let mut out = Vec::new();
            for (id, kind) in sources {
                if !matches!(
                    SourceKind::from_str(&kind),
                    Ok(SourceKind::Xtream | SourceKind::Stalker)
                ) {
                    continue;
                }
                let reported = crate::account::load(c, &id)?
                    .and_then(|s| s.max_connections)
                    .filter(|m| *m > 0);
                let record = read_record::<LimitRecord>(c, &limit_key(&id))?;
                out.push((id, reported, record));
            }
            Ok(out)
        })
        .await?;
    Ok(rows
        .into_iter()
        .map(|(source_id, reported, record)| SourceConnectionLimit {
            probing: mgr.is_probing(&source_id),
            disabled: disabled.contains(&source_id),
            reported,
            learned: record.as_ref().map(|r| r.limit),
            mode: record.as_ref().map(|r| r.mode),
            probed_at: record.as_ref().map(|r| r.probed_at.clone()),
            next_probe_at: record.map(|r| r.next_probe_at),
            source_id,
        })
        .collect())
}

/// Forgets what probes learned about `source_id`, so the next eligible
/// transfer may probe again (`downloads.resetConnectionLimit`). The source
/// falls back to its reported limit at once.
pub async fn reset(state: &Arc<AppState>, source_id: &str) -> CoreResult<()> {
    let sid = source_id.to_string();
    state
        .db_write(move |c| delete_record(c, &limit_key(&sid)))
        .await?;
    let mgr = manager::manager(state);
    mgr.set_record(source_id, None);
    mgr.clear_probe_backoff(source_id);
    mgr.repump();
    Ok(())
}

/// Test hook: moves `source_id`'s probe record `by` into the past.
pub async fn age(state: &Arc<AppState>, source_id: &str, by: Duration) -> CoreResult<()> {
    let sid = source_id.to_string();
    let by = chrono::Duration::from_std(by).unwrap_or(chrono::Duration::MAX);
    let aged = state
        .db_write(move |c| {
            let key = limit_key(&sid);
            let Some(mut record) = read_record::<LimitRecord>(c, &key)? else {
                return Ok(None);
            };
            let shift = |s: &str| {
                chrono::DateTime::parse_from_rfc3339(s)
                    .ok()
                    .and_then(|t| t.with_timezone(&chrono::Utc).checked_sub_signed(by))
                    .map_or_else(|| s.to_string(), rfc3339)
            };
            record.probed_at = shift(&record.probed_at);
            record.next_probe_at = shift(&record.next_probe_at);
            write_record(c, &key, &record)?;
            Ok(Some(record))
        })
        .await?;
    if let Some(record) = aged {
        manager::manager(state).set_record(source_id, Some(record));
    }
    Ok(())
}
