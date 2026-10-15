//! Scheduled auto-refresh of sources.
//!
//! Every [`TICK`] (and once 3 s after boot) each source with `autoRefresh`
//! whose last good refresh is older than `sourceRefreshIntervalHours` is
//! re-imported through [`super::try_run_import`], one source at a time with
//! [`STAGGER`] between them. With the interval at 0 nothing is scheduled
//! (the startup pass in [`super::init`] still refreshes every auto-refresh
//! source, the behavior before the scheduler existed).
//!
//! Rules (all decided by the pure [`next_due`]):
//! - A source that was never refreshed is due at once.
//! - A source whose import, refresh, partial sync or remove holds the import
//!   lock is skipped; the lock is taken with `try_lock`, so a scheduled run
//!   never queues behind a manual refresh and then repeats it.
//! - After a failure the next attempt waits [`backoff`]: 30 min, doubling per
//!   consecutive failure, capped at the interval. The failure is recorded by
//!   `run_import` exactly as for a manual refresh (`lastError`,
//!   `lastErrorCode`, `lastErrorAt`). After a restart the stored
//!   `lastErrorAt` still delays the first retry by 30 min.
//! - A scheduled run that is cancelled (`sources.cancelImport`, an edit, a
//!   remove) is not a failure; the source waits a full interval.
//!
//! Pasted m3u text has nothing to fetch and is never scheduled.

use super::{get, is_cancelled_error, is_import_running, list, try_run_import};
use crate::error::{CoreError, CoreResult};
use crate::model::{M3uOrigin, Source};
use crate::state::AppState;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::Serialize;
use std::sync::{Arc, Weak};
use std::time::Duration;

/// How often the scheduler looks for due sources.
pub const TICK: Duration = Duration::from_secs(10 * 60);
/// Pause between two scheduled refreshes in one pass.
pub const STAGGER: Duration = Duration::from_secs(20);
/// First retry delay after a failed scheduled refresh.
pub const BACKOFF_BASE: Duration = Duration::from_secs(30 * 60);

const MEMORY_KEY: &str = "sources.schedule";

/// Source of "now" for scheduling decisions (tests inject a fixed clock).
pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

/// The wall clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// In-memory outcome of the last scheduled attempts of one source.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Attempt {
    /// Consecutive failed scheduled refreshes.
    pub failures: u32,
    /// Not before this (after a failure or a cancel).
    pub retry_after: Option<DateTime<Utc>>,
}

type Memory = DashMap<String, Attempt>;

/// Scheduled-attempt memory of `state` (tests read it).
pub fn memory(state: &AppState) -> Arc<DashMap<String, Attempt>> {
    state.ext_or_insert_with::<Memory>(MEMORY_KEY, || Arc::new(DashMap::new()))
}

/// What the scheduler needs to know about a source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub auto_refresh: bool,
    /// False for pasted m3u text (nothing to fetch).
    pub refreshable: bool,
    pub last_refresh_at: Option<DateTime<Utc>>,
    /// Set only while the source shows an error.
    pub last_error_at: Option<DateTime<Utc>>,
}

fn parse(ts: Option<&str>) -> Option<DateTime<Utc>> {
    ts.and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
}

impl Candidate {
    pub fn from_source(s: &Source) -> Self {
        Self {
            id: s.id.clone(),
            auto_refresh: s.auto_refresh,
            refreshable: s.m3u.as_ref().is_none_or(|m| m.origin != M3uOrigin::Text),
            last_refresh_at: parse(s.last_refresh_at.as_deref()),
            last_error_at: parse(s.last_error_at.as_deref()),
        }
    }
}

fn hours(h: u32) -> Duration {
    Duration::from_secs(u64::from(h) * 3600)
}

fn add(t: DateTime<Utc>, d: Duration) -> DateTime<Utc> {
    chrono::Duration::from_std(d)
        .ok()
        .and_then(|d| t.checked_add_signed(d))
        .unwrap_or(DateTime::<Utc>::MAX_UTC)
}

/// Wait before retrying after `failures` consecutive failures:
/// [`BACKOFF_BASE`] doubling per failure, capped at `interval` (but never
/// below the base).
pub fn backoff(failures: u32, interval: Duration) -> Duration {
    let cap = interval.max(BACKOFF_BASE);
    let factor = 1u32 << failures.saturating_sub(1).min(16);
    BACKOFF_BASE.saturating_mul(factor).min(cap)
}

/// When `c` is next due for a scheduled refresh, or `None` when it is not
/// scheduled at all (interval 0, auto-refresh off, pasted text).
pub fn next_due(
    c: &Candidate,
    interval_hours: u32,
    attempt: Option<&Attempt>,
) -> Option<DateTime<Utc>> {
    if interval_hours == 0 || !c.auto_refresh || !c.refreshable {
        return None;
    }
    let interval = hours(interval_hours);
    let mut due = match c.last_refresh_at {
        Some(t) => add(t, interval),
        None => DateTime::<Utc>::MIN_UTC,
    };
    // The latest attempt failed: wait at least the first backoff step, also
    // across restarts (the in-memory failure count starts over).
    if let Some(err_at) = c.last_error_at {
        if c.last_refresh_at.is_none_or(|r| err_at >= r) {
            due = due.max(add(err_at, backoff(1, interval)));
        }
    }
    if let Some(after) = attempt.and_then(|a| a.retry_after) {
        due = due.max(after);
    }
    Some(due)
}

/// Ids of the sources due at `now`, longest overdue first.
pub fn plan(
    now: DateTime<Utc>,
    candidates: &[Candidate],
    interval_hours: u32,
    attempt: impl Fn(&str) -> Option<Attempt>,
) -> Vec<String> {
    let mut due: Vec<(DateTime<Utc>, &str)> = candidates
        .iter()
        .filter_map(|c| {
            let at = next_due(c, interval_hours, attempt(&c.id).as_ref())?;
            (at <= now).then_some((at, c.id.as_str()))
        })
        .collect();
    due.sort();
    due.into_iter().map(|(_, id)| id.to_string()).collect()
}

/// Outcome of one scheduler pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TickReport {
    pub refreshed: Vec<String>,
    pub failed: Vec<String>,
    pub cancelled: Vec<String>,
    /// Due but an import of the source was running.
    pub busy: Vec<String>,
}

/// One scheduler pass: refreshes every due source, one at a time, `stagger`
/// apart. Each source is re-checked right before its refresh (settings,
/// edits, removes and manual refreshes during the stagger count).
pub async fn tick(state: &Arc<AppState>, clock: &dyn Clock, stagger: Duration) -> TickReport {
    let mut report = TickReport::default();
    let interval = state.settings_snapshot().source_refresh_interval_hours;
    if interval == 0 {
        return report;
    }
    let sources = match list(state).await {
        Ok(s) => s,
        Err(err) => {
            tracing::warn!(%err, "scheduled refresh: could not list sources");
            return report;
        }
    };
    let mem = memory(state);
    mem.retain(|id, _| sources.iter().any(|s| &s.id == id));
    let candidates: Vec<Candidate> = sources.iter().map(Candidate::from_source).collect();
    let due = plan(clock.now(), &candidates, interval, |id| {
        mem.get(id).map(|a| a.clone())
    });
    for (i, id) in due.iter().enumerate() {
        if i > 0 && !stagger.is_zero() {
            tokio::time::sleep(stagger).await;
        }
        let interval = state.settings_snapshot().source_refresh_interval_hours;
        if interval == 0 {
            break;
        }
        let Ok(source) = get(state, id).await else {
            continue;
        };
        let attempt = mem.get(id).map(|a| a.clone());
        let still_due = next_due(&Candidate::from_source(&source), interval, attempt.as_ref())
            .is_some_and(|at| at <= clock.now());
        if !still_due {
            continue;
        }
        if is_import_running(state, id) {
            report.busy.push(id.clone());
            continue;
        }
        tracing::info!(source_id = %id, "scheduled refresh");
        let outcome = try_run_import(state.clone(), id).await;
        // An unchanged playlist sent `done` + "unchanged" instead of
        // `sources.changed` (clients refetch `sources.*` on it, which covers
        // `sources.schedule`); repeating `sources.changed` here would make
        // every client refetch its catalog after a no-op refresh.
        let notify = outcome
            .as_ref()
            .is_some_and(|r| !r.as_ref().is_ok_and(|(_, s)| s.unchanged));
        match outcome {
            None => report.busy.push(id.clone()),
            Some(Ok(_)) => {
                mem.remove(id);
                report.refreshed.push(id.clone());
            }
            Some(Err(err)) if is_cancelled_error(&err) => {
                mem.entry(id.clone()).or_default().retry_after =
                    Some(add(clock.now(), hours(interval)));
                report.cancelled.push(id.clone());
            }
            Some(Err(CoreError::NotFound(_))) if get(state, id).await.is_err() => {
                // Removed during the refresh.
                mem.remove(id);
            }
            Some(Err(err)) => {
                let mut a = mem.entry(id.clone()).or_default();
                a.failures = a.failures.saturating_add(1);
                let wait = backoff(a.failures, hours(interval));
                a.retry_after = Some(add(clock.now(), wait));
                tracing::warn!(
                    source_id = %id,
                    failures = a.failures,
                    retry_in_min = wait.as_secs() / 60,
                    error = %crate::logging::redact_text(&super::error_text(&err)),
                    "scheduled refresh failed"
                );
                report.failed.push(id.clone());
            }
        }
        if notify {
            // The import's own `sources.changed` fired before the backoff
            // above was stored; tell the UI again so `sources.schedule` shows
            // the real next attempt.
            super::emit_changed(state);
        }
    }
    report
}

/// Runs [`tick`] after `first`, then every [`TICK`], until the app state is
/// dropped.
pub async fn run(state: Weak<AppState>, first: Duration) {
    tokio::time::sleep(first).await;
    loop {
        let Some(s) = state.upgrade() else { break };
        let r = tick(&s, &SystemClock, STAGGER).await;
        if !(r.refreshed.is_empty() && r.failed.is_empty()) {
            tracing::info!(
                refreshed = r.refreshed.len(),
                failed = r.failed.len(),
                "scheduled refresh pass finished"
            );
        }
        drop(s);
        tokio::time::sleep(TICK).await;
    }
}

/// One source in `sources.schedule`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEntry {
    pub source_id: String,
    /// RFC 3339. The scheduler checks every 10 minutes, so a refresh starts
    /// up to that long after this.
    pub next_refresh_at: String,
    /// The next attempt is a retry after a failure.
    pub retrying: bool,
}

/// `sources.schedule` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleView {
    pub interval_hours: u32,
    /// Scheduled sources only (auto-refresh on, interval above 0).
    pub sources: Vec<ScheduleEntry>,
}

/// `sources.schedule`: when each auto-refresh source is next refreshed.
pub async fn view(state: &Arc<AppState>) -> CoreResult<ScheduleView> {
    let interval = state.settings_snapshot().source_refresh_interval_hours;
    let sources = list(state).await?;
    let mem = memory(state);
    let now = Utc::now();
    let entries = sources
        .iter()
        .filter_map(|s| {
            let c = Candidate::from_source(s);
            let attempt = mem.get(&s.id).map(|a| a.clone());
            let at = next_due(&c, interval, attempt.as_ref())?;
            let plain = c.last_refresh_at.map(|t| add(t, hours(interval)));
            Some(ScheduleEntry {
                source_id: s.id.clone(),
                next_refresh_at: at
                    .max(now)
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                retrying: s.last_error.is_some() && plain.is_none_or(|p| at > p),
            })
        })
        .collect();
    Ok(ScheduleView {
        interval_hours: interval,
        sources: entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn cand(id: &str, last: Option<&str>, err: Option<&str>) -> Candidate {
        Candidate {
            id: id.into(),
            auto_refresh: true,
            refreshable: true,
            last_refresh_at: last.map(t),
            last_error_at: err.map(t),
        }
    }

    #[test]
    fn interval_zero_autorefresh_off_and_pasted_text_are_never_scheduled() {
        let c = cand("a", None, None);
        assert_eq!(next_due(&c, 0, None), None);
        let off = Candidate {
            auto_refresh: false,
            ..c.clone()
        };
        assert_eq!(next_due(&off, 12, None), None);
        let text = Candidate {
            refreshable: false,
            ..c
        };
        assert_eq!(next_due(&text, 12, None), None);
    }

    #[test]
    fn due_after_the_interval_and_never_refreshed_is_due_now() {
        let c = cand("a", Some("2026-10-12T00:00:00Z"), None);
        assert_eq!(next_due(&c, 12, None), Some(t("2026-10-12T12:00:00Z")));
        assert_eq!(next_due(&c, 6, None), Some(t("2026-10-12T06:00:00Z")));
        let never = cand("b", None, None);
        let now = t("2026-10-12T01:00:00Z");
        assert_eq!(plan(now, &[c.clone(), never], 12, |_| None), vec!["b"]);
        assert!(plan(
            t("2026-10-12T11:59:59Z"),
            std::slice::from_ref(&c),
            12,
            |_| None
        )
        .is_empty());
        assert_eq!(
            plan(t("2026-10-12T12:00:00Z"), &[c], 12, |_| None),
            vec!["a"]
        );
    }

    #[test]
    fn plan_orders_longest_overdue_first() {
        let a = cand("a", Some("2026-10-11T10:00:00Z"), None);
        let b = cand("b", Some("2026-10-10T10:00:00Z"), None);
        let c = cand("c", Some("2026-10-12T09:00:00Z"), None);
        let now = t("2026-10-12T10:00:00Z");
        assert_eq!(plan(now, &[a, b, c], 12, |_| None), vec!["b", "a"]);
    }

    #[test]
    fn backoff_doubles_and_caps_at_the_interval() {
        let twelve = hours(12);
        assert_eq!(backoff(1, twelve), Duration::from_secs(30 * 60));
        assert_eq!(backoff(2, twelve), hours(1));
        assert_eq!(backoff(3, twelve), hours(2));
        assert_eq!(backoff(6, twelve), hours(12));
        assert_eq!(backoff(40, twelve), hours(12));
        // A 6 h interval caps sooner; the base is the floor.
        assert_eq!(backoff(5, hours(6)), hours(6));
        assert_eq!(backoff(1, Duration::from_secs(60)), BACKOFF_BASE);
    }

    #[test]
    fn a_stored_error_delays_the_retry_even_without_memory() {
        // Failed at 10:00 after a good refresh two days ago: due 10:30, not now.
        let c = cand(
            "a",
            Some("2026-10-10T00:00:00Z"),
            Some("2026-10-12T10:00:00Z"),
        );
        assert_eq!(next_due(&c, 12, None), Some(t("2026-10-12T10:30:00Z")));
        // An error older than the last good refresh does not count.
        let old = cand(
            "a",
            Some("2026-10-12T00:00:00Z"),
            Some("2026-10-11T00:00:00Z"),
        );
        assert_eq!(next_due(&old, 12, None), Some(t("2026-10-12T12:00:00Z")));
    }

    #[test]
    fn memory_retry_after_wins_when_later() {
        let c = cand("a", Some("2026-10-10T00:00:00Z"), None);
        let a = Attempt {
            failures: 3,
            retry_after: Some(t("2026-10-12T14:00:00Z")),
        };
        assert_eq!(next_due(&c, 12, Some(&a)), Some(t("2026-10-12T14:00:00Z")));
        assert!(plan(
            t("2026-10-12T13:59:00Z"),
            std::slice::from_ref(&c),
            12,
            |_| Some(a.clone())
        )
        .is_empty());
        assert_eq!(
            plan(t("2026-10-12T14:00:00Z"), &[c], 12, |_| Some(a.clone())),
            vec!["a"]
        );
    }
}
