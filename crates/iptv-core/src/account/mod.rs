//! `account` module: cached subscription status of Xtream and Stalker
//! sources (expiry, trial, connections) for the source cards, the dashboard
//! expiry banner and the player's "connection limit reached" error.
//!
//! The status is kept per source in `app_state` (`account_status:<id>`), so
//! it is on screen at startup without a network call. It is refreshed:
//!
//! - by every Xtream sync (the sync's account reply is reused) and by the
//!   Account tab (`xtream.accountInfo` / `stalker.accountInfo`);
//! - after a successful Stalker import (in the background);
//! - in the background when `account.status` / `account.statusAll` find it
//!   older than [`STALE_AFTER`] (a failed check is retried after
//!   [`RETRY_FAILED_AFTER`]);
//! - on demand by `account.status {refresh: true}`, which the player sends
//!   right after a playback failure. Calls within [`FORCE_MIN_AGE`] of the
//!   last check reuse it, so a burst of failures costs one request. Only
//!   Xtream is asked: Stalker portals report no connection counts, so a
//!   forced Stalker check returns the cached status without portal traffic.
//!
//! Credentials never reach the log or the stored status: errors are passed
//! through `logging::redact_text`.

pub mod rpc;

use crate::error::{CoreError, CoreResult};
use crate::model::{Source, SourceKind};
use crate::stalker::playback::StalkerAccountInfo;
use crate::state::AppState;
use crate::xtream::service::XtreamAccountInfo;
use chrono::{DateTime, Utc};
use dashmap::{DashMap, DashSet};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

/// `app_state` key prefix of a source's cached status.
pub const KEY_PREFIX: &str = "account_status:";
/// A successful check older than this is refreshed in the background.
pub const STALE_AFTER: Duration = Duration::from_secs(4 * 3600);
/// A failed check is retried after this.
pub const RETRY_FAILED_AFTER: Duration = Duration::from_secs(30 * 60);
/// `refresh: true` reuses a check younger than this.
pub const FORCE_MIN_AGE: Duration = Duration::from_secs(20);
/// Event emitted when a source's status changes (`{sourceId}`).
pub const CHANGED_EVENT: &str = "account.changed";

const LOCKS_KEY: &str = "account.locks";
const INFLIGHT_KEY: &str = "account.inflight";

/// Subscription status of one source (TS `AccountStatus`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub source_id: String,
    pub kind: SourceKind,
    /// Provider status text ("Active", "Expired", "Banned", ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// RFC 3339; absent = no expiry reported (unlimited or unknown).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exp_date: Option<String>,
    #[serde(default)]
    pub is_trial: bool,
    /// Connections in use (Xtream only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_cons: Option<i64>,
    /// Connection limit (Xtream only; absent or 0 = unlimited).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_connections: Option<i64>,
    /// When the provider was last asked (RFC 3339).
    pub checked_at: String,
    /// Why the last check failed (redacted). The other fields then come from
    /// the last good check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AccountStatus {
    /// True when the last check succeeded and every connection is in use.
    pub fn connections_full(&self) -> bool {
        self.error.is_none()
            && matches!((self.active_cons, self.max_connections), (Some(a), Some(m)) if m > 0 && a >= m)
    }
}

fn now_rfc3339(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// Status from an `xtream.accountInfo` reply.
pub fn from_xtream(source_id: &str, info: &XtreamAccountInfo, now: DateTime<Utc>) -> AccountStatus {
    AccountStatus {
        source_id: source_id.to_string(),
        kind: SourceKind::Xtream,
        status: Some(info.status.clone()).filter(|s| !s.trim().is_empty()),
        exp_date: info.exp_date.clone(),
        is_trial: info.is_trial,
        active_cons: Some(info.active_cons),
        max_connections: Some(info.max_connections),
        checked_at: now_rfc3339(now),
        error: None,
    }
}

/// Status from a `stalker.accountInfo` reply. A portal date that could not
/// be read as a date is dropped (the Account tab still shows it as sent).
pub fn from_stalker(
    source_id: &str,
    info: &StalkerAccountInfo,
    now: DateTime<Utc>,
) -> AccountStatus {
    AccountStatus {
        source_id: source_id.to_string(),
        kind: SourceKind::Stalker,
        status: info.status.clone(),
        exp_date: info.exp_date.clone().filter(|d| parse_time(d).is_some()),
        is_trial: false,
        active_cons: None,
        max_connections: None,
        checked_at: now_rfc3339(now),
        error: None,
    }
}

/// True when `status` should be checked again at `now`.
pub fn is_stale(status: &AccountStatus, now: DateTime<Utc>) -> bool {
    let Some(at) = parse_time(&status.checked_at) else {
        return true;
    };
    let max_age = if status.error.is_some() {
        RETRY_FAILED_AFTER
    } else {
        STALE_AFTER
    };
    now.signed_duration_since(at).to_std().unwrap_or_default() >= max_age
}

fn key(source_id: &str) -> String {
    format!("{KEY_PREFIX}{source_id}")
}

/// Cached status of `source_id`, if any.
pub fn load(conn: &Connection, source_id: &str) -> CoreResult<Option<AccountStatus>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            [key(source_id)],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw.and_then(|v| serde_json::from_str(&v).ok()))
}

/// Stores `status` (upsert). Skipped when the source no longer exists, so a
/// check that finishes after a remove leaves nothing behind.
pub fn save(conn: &Connection, status: &AccountStatus) -> CoreResult<bool> {
    let json = serde_json::to_string(status)?;
    let n = conn.execute(
        "INSERT INTO app_state(key, value, updated_at)
         SELECT ?1, ?2, CURRENT_TIMESTAMP WHERE EXISTS (SELECT 1 FROM sources WHERE id = ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key(&status.source_id), json, status.source_id],
    )?;
    Ok(n > 0)
}

/// Stores `status` and emits [`CHANGED_EVENT`]. Failures are logged only:
/// the status is a convenience and never fails the caller.
pub async fn record(state: &AppState, status: AccountStatus) {
    let id = status.source_id.clone();
    match state.db_call(move |c| save(c, &status)).await {
        Ok(true) => state.emit(CHANGED_EVENT, serde_json::json!({ "sourceId": id })),
        Ok(false) => {}
        Err(err) => tracing::warn!(source_id = %id, %err, "could not store account status"),
    }
}

/// Caches an Xtream account reply (sync, Account tab).
pub async fn remember_xtream(state: &AppState, source_id: &str, info: XtreamAccountInfo) {
    record(state, from_xtream(source_id, &info, Utc::now())).await;
}

/// Caches a Stalker account reply (Account tab, after an import).
pub async fn remember_stalker(state: &AppState, source_id: &str, info: &StalkerAccountInfo) {
    record(state, from_stalker(source_id, info, Utc::now())).await;
}

fn has_account(kind: SourceKind) -> bool {
    matches!(kind, SourceKind::Xtream | SourceKind::Stalker)
}

/// Asks the provider. Does not store anything.
async fn fetch(state: &Arc<AppState>, source: &Source) -> CoreResult<AccountStatus> {
    let now = Utc::now();
    match source.kind {
        SourceKind::Xtream => crate::xtream::service::account_info(state, &source.id)
            .await
            .map(|i| from_xtream(&source.id, &i, now)),
        SourceKind::Stalker => crate::stalker::playback::account_info(state, &source.id)
            .await
            .map(|i| from_stalker(&source.id, &i, now)),
        SourceKind::M3u => Err(CoreError::Unsupported(
            "m3u playlists have no account".into(),
        )),
    }
}

fn lock_for(state: &AppState, id: &str) -> Arc<tokio::sync::Mutex<()>> {
    type Locks = DashMap<String, Arc<tokio::sync::Mutex<()>>>;
    let locks = state.ext_or_insert_with::<Locks>(LOCKS_KEY, || Arc::new(DashMap::new()));
    let lock = locks
        .entry(id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())));
    Arc::clone(lock.value())
}

/// Checks `source` with the provider unless a check younger than `min_age`
/// exists, stores the outcome and returns it. One check per source runs at a
/// time; callers that queue behind it reuse its result. A failed check keeps
/// the last good fields and records the redacted error.
async fn refresh(
    state: &Arc<AppState>,
    source: &Source,
    min_age: Duration,
) -> CoreResult<AccountStatus> {
    let lock = lock_for(state, &source.id);
    let _guard = lock.lock().await;
    let sid = source.id.clone();
    let cached = state.db_call(move |c| load(c, &sid)).await?;
    if let Some(c) = &cached {
        let fresh = parse_time(&c.checked_at).is_some_and(|at| {
            Utc::now()
                .signed_duration_since(at)
                .to_std()
                .unwrap_or_default()
                < min_age
        });
        if fresh {
            return Ok(c.clone());
        }
    }
    let status = match fetch(state, source).await {
        Ok(s) => s,
        Err(err) => {
            let msg = crate::logging::redact_text(&crate::sources::error_text(&err)).into_owned();
            tracing::info!(source_id = %source.id, error = %msg, "account check failed");
            let mut s = cached.unwrap_or_else(|| AccountStatus {
                source_id: source.id.clone(),
                kind: source.kind,
                status: None,
                exp_date: None,
                is_trial: false,
                active_cons: None,
                max_connections: None,
                checked_at: String::new(),
                error: None,
            });
            s.checked_at = now_rfc3339(Utc::now());
            s.error = Some(msg);
            s
        }
    };
    record(state, status.clone()).await;
    Ok(status)
}

/// Refreshes `ids` one after another in the background, skipping any
/// already being refreshed this way.
fn spawn_refresh(state: &Arc<AppState>, sources: Vec<Source>) {
    let inflight =
        state.ext_or_insert_with::<DashSet<String>>(INFLIGHT_KEY, || Arc::new(DashSet::new()));
    let mine: Vec<Source> = sources
        .into_iter()
        .filter(|s| inflight.insert(s.id.clone()))
        .collect();
    if mine.is_empty() {
        return;
    }
    let state = Arc::clone(state);
    tokio::spawn(async move {
        for s in mine {
            // Errors are stored in the status itself.
            let _ = refresh(&state, &s, FORCE_MIN_AGE).await;
            inflight.remove(&s.id);
        }
    });
}

/// After a successful import: Stalker statuses are refreshed in the
/// background (an Xtream sync already stored its account reply).
pub fn after_import(state: &Arc<AppState>, source: &Source) {
    if source.kind == SourceKind::Stalker {
        spawn_refresh(state, vec![source.clone()]);
    }
}

/// `account.status`. `None` for m3u sources. With `refresh` an Xtream panel is
/// asked now (unless checked within [`FORCE_MIN_AGE`]); otherwise the cached
/// status is returned and a stale one is refreshed in the background. A
/// forced Stalker check only returns the cache: the portal reports no
/// connection counts, and the player forces checks while a stream is failing,
/// when the portal is least able to take extra requests.
pub async fn status(
    state: &Arc<AppState>,
    source_id: &str,
    force: bool,
) -> CoreResult<Option<AccountStatus>> {
    let source = crate::sources::get(state, source_id).await?;
    if !has_account(source.kind) {
        return Ok(None);
    }
    if force && source.kind == SourceKind::Xtream {
        return refresh(state, &source, FORCE_MIN_AGE).await.map(Some);
    }
    let sid = source.id.clone();
    let cached = state.db_call(move |c| load(c, &sid)).await?;
    if force {
        return Ok(cached);
    }
    if cached.as_ref().is_none_or(|c| is_stale(c, Utc::now())) {
        spawn_refresh(state, vec![source]);
    }
    Ok(cached)
}

/// `account.statusAll`: cached statuses of every Xtream and Stalker source,
/// in source order; stale or missing ones are refreshed in the background
/// (each emits [`CHANGED_EVENT`] when done).
pub async fn status_all(state: &Arc<AppState>) -> CoreResult<Vec<AccountStatus>> {
    let sources: Vec<Source> = crate::sources::list(state)
        .await?
        .into_iter()
        .filter(|s| has_account(s.kind))
        .collect();
    let ids: Vec<String> = sources.iter().map(|s| s.id.clone()).collect();
    let cached = state
        .db_call(move |c| {
            ids.iter()
                .map(|id| load(c, id))
                .collect::<CoreResult<Vec<_>>>()
        })
        .await?;
    let now = Utc::now();
    let mut out = Vec::new();
    let mut stale = Vec::new();
    for (source, status) in sources.into_iter().zip(cached) {
        match status {
            Some(s) => {
                if is_stale(&s, now) {
                    stale.push(source);
                }
                out.push(s);
            }
            None => stale.push(source),
        }
    }
    spawn_refresh(state, stale);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        parse_time(s).unwrap()
    }

    fn status(checked_at: &str, error: Option<&str>) -> AccountStatus {
        AccountStatus {
            source_id: "a".into(),
            kind: SourceKind::Xtream,
            status: Some("Active".into()),
            exp_date: None,
            is_trial: false,
            active_cons: Some(1),
            max_connections: Some(2),
            checked_at: checked_at.into(),
            error: error.map(Into::into),
        }
    }

    #[test]
    fn staleness_depends_on_the_last_outcome() {
        let ok = status("2026-10-12T00:00:00Z", None);
        assert!(!is_stale(&ok, at("2026-10-12T03:59:00Z")));
        assert!(is_stale(&ok, at("2026-10-12T04:00:00Z")));
        let failed = status("2026-10-12T00:00:00Z", Some("down"));
        assert!(!is_stale(&failed, at("2026-10-12T00:29:00Z")));
        assert!(is_stale(&failed, at("2026-10-12T00:30:00Z")));
        assert!(is_stale(
            &status("garbage", None),
            at("2026-10-12T00:00:00Z")
        ));
    }

    #[test]
    fn connections_full_needs_a_limit() {
        let mut s = status("2026-10-12T00:00:00Z", None);
        assert!(!s.connections_full());
        s.active_cons = Some(2);
        assert!(s.connections_full());
        s.max_connections = Some(0);
        assert!(!s.connections_full(), "0 = unlimited");
        s.max_connections = None;
        assert!(!s.connections_full());
    }

    #[test]
    fn a_failed_check_is_never_full() {
        let mut s = status("2026-10-12T00:00:00Z", Some("panel down"));
        s.active_cons = Some(2);
        assert!(
            !s.connections_full(),
            "counts kept from the last good check are not evidence"
        );
    }

    #[test]
    fn maps_provider_replies() {
        let now = at("2026-10-12T10:00:00Z");
        let x = XtreamAccountInfo {
            status: "Active".into(),
            exp_date: Some("2026-10-15T00:00:00Z".into()),
            active_cons: 2,
            max_connections: 2,
            is_trial: true,
            created_at: None,
            server_time: None,
            timezone: None,
            allowed_output_formats: vec![],
        };
        let s = from_xtream("x1", &x, now);
        assert_eq!(s.kind, SourceKind::Xtream);
        assert_eq!(s.checked_at, "2026-10-12T10:00:00Z");
        assert!(s.is_trial && s.connections_full());
        let st = StalkerAccountInfo {
            mac: "00:1A:79:00:00:01".into(),
            status: Some("active".into()),
            exp_date: Some("not a date".into()),
            tariff: None,
            raw: serde_json::Value::Null,
        };
        let s = from_stalker("s1", &st, now);
        assert_eq!(s.exp_date, None, "unreadable dates are dropped");
        assert_eq!(s.max_connections, None);
        let json = serde_json::to_value(&s).unwrap();
        assert!(
            json.get("mac").is_none(),
            "the MAC is never part of the status"
        );
    }
}
