//! Per-source server metadata and short-lived detail caches.
//!
//! `ServerMeta` (server clock offset, allowed output formats) is captured from
//! the account response on every sync / accountInfo / test and kept in memory
//! plus `app_state` (`xtream_meta:<sourceId>`) so catch-up and stream URLs
//! work offline after a restart. Series info responses are cached for a few
//! minutes so `streamUrl` for an episode does not refetch what the detail page
//! just loaded.

use super::raw::{RawAccount, RawSeriesInfo};
use crate::error::CoreResult;
use crate::state::AppState;
use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use dashmap::DashMap;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// `AppState.extensions` key.
pub const EXT_KEY: &str = "xtream";
/// How long a fetched series info stays fresh.
pub const SERIES_TTL: Duration = Duration::from_secs(10 * 60);
/// Most series infos kept in memory.
const SERIES_CACHE_MAX: usize = 64;

/// What we remember about a panel between calls.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerMeta {
    /// Server local time minus UTC, in seconds, rounded to 15 minutes.
    pub offset_seconds: i64,
    /// Lowercased `user_info.allowed_output_formats` (empty = unknown).
    pub allowed_output_formats: Vec<String>,
    /// IANA zone name reported by the server, display only.
    pub timezone: Option<String>,
}

impl ServerMeta {
    pub fn from_account(acc: &RawAccount) -> Self {
        let formats = acc
            .user_info
            .as_ref()
            .map(|u| {
                u.allowed_output_formats
                    .iter()
                    .map(|f| f.trim().to_ascii_lowercase())
                    .filter(|f| !f.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let (offset, tz) = acc
            .server_info
            .as_ref()
            .map(|s| {
                (
                    server_offset_seconds(s.timestamp_now, s.time_now.as_deref()),
                    s.timezone.clone(),
                )
            })
            .unwrap_or((0, None));
        Self {
            offset_seconds: offset,
            allowed_output_formats: formats,
            timezone: tz,
        }
    }
}

/// Runtime caches stored under [`EXT_KEY`].
#[derive(Default)]
pub struct Runtime {
    meta: DashMap<String, ServerMeta>,
    series: DashMap<(String, String), (Instant, Arc<RawSeriesInfo>)>,
}

pub fn runtime(state: &AppState) -> Arc<Runtime> {
    state.ext_or_insert_with::<Runtime>(EXT_KEY, || Arc::new(Runtime::default()))
}

fn meta_key(source_id: &str) -> String {
    format!("xtream_meta:{source_id}")
}

/// Remembers `meta` for `source_id` (memory + `app_state`).
pub fn store_meta(
    conn: &Connection,
    rt: &Runtime,
    source_id: &str,
    meta: &ServerMeta,
) -> CoreResult<()> {
    rt.meta.insert(source_id.to_string(), meta.clone());
    conn.execute(
        "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![meta_key(source_id), serde_json::to_string(meta)?],
    )?;
    Ok(())
}

/// Memory, then `app_state`; `None` if the source was never contacted.
pub fn load_meta(
    conn: &Connection,
    rt: &Runtime,
    source_id: &str,
) -> CoreResult<Option<ServerMeta>> {
    if let Some(m) = rt.meta.get(source_id) {
        return Ok(Some(m.clone()));
    }
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            [meta_key(source_id)],
            |r| r.get(0),
        )
        .optional()?;
    let meta = raw.and_then(|s| serde_json::from_str::<ServerMeta>(&s).ok());
    if let Some(m) = &meta {
        rt.meta.insert(source_id.to_string(), m.clone());
    }
    Ok(meta)
}

/// Forgets cached data of a source (after a resync).
pub fn invalidate_source(rt: &Runtime, source_id: &str) {
    rt.series.retain(|(sid, _), _| sid != source_id);
}

/// Drops the cached info of one series.
pub fn invalidate_series(rt: &Runtime, source_id: &str, series_id: &str) {
    rt.series
        .remove(&(source_id.to_string(), series_id.to_string()));
}

pub fn cached_series(rt: &Runtime, source_id: &str, series_id: &str) -> Option<Arc<RawSeriesInfo>> {
    let key = (source_id.to_string(), series_id.to_string());
    let hit = rt.series.get(&key).map(|e| e.value().clone());
    match hit {
        Some((at, info)) if at.elapsed() < SERIES_TTL => Some(info),
        Some(_) => {
            rt.series.remove(&key);
            None
        }
        None => None,
    }
}

pub fn put_series(rt: &Runtime, source_id: &str, series_id: &str, info: Arc<RawSeriesInfo>) {
    if rt.series.len() >= SERIES_CACHE_MAX {
        rt.series.retain(|_, (at, _)| at.elapsed() < SERIES_TTL);
        if rt.series.len() >= SERIES_CACHE_MAX {
            rt.series.clear();
        }
    }
    rt.series.insert(
        (source_id.to_string(), series_id.to_string()),
        (Instant::now(), info),
    );
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/// Server clock offset from `server_info.timestamp_now` (unix, UTC) and
/// `time_now` (server local wall clock), rounded to the nearest 15 minutes.
/// 0 when either is missing or the result is implausible (> 14 h).
pub fn server_offset_seconds(timestamp_now: Option<i64>, time_now: Option<&str>) -> i64 {
    let (Some(ts), Some(local)) = (timestamp_now, time_now) else {
        return 0;
    };
    let Some(naive) = parse_server_datetime(local) else {
        return 0;
    };
    let diff = naive.and_utc().timestamp() - ts;
    let rounded = ((diff as f64) / 900.0).round() as i64 * 900;
    if rounded.abs() > 14 * 3600 {
        0
    } else {
        rounded
    }
}

/// Parses `YYYY-MM-DD HH:MM:SS` (also `T`-separated, or without seconds).
pub fn parse_server_datetime(s: &str) -> Option<NaiveDateTime> {
    let s = s.trim();
    ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"]
        .iter()
        .find_map(|f| NaiveDateTime::parse_from_str(s, f).ok())
}

/// Unix seconds to RFC 3339 UTC; `None` for 0, negatives and absurd values.
pub fn unix_to_rfc3339(secs: i64) -> Option<String> {
    if secs <= 0 {
        return None;
    }
    Utc.timestamp_opt(secs, 0)
        .single()
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// `added`-style text (unix seconds, or a date string) to RFC 3339.
pub fn added_to_rfc3339(raw: Option<&str>) -> Option<String> {
    let s = raw?.trim();
    if let Ok(n) = s.parse::<i64>() {
        return unix_to_rfc3339(n);
    }
    if let Some(dt) = parse_server_datetime(s) {
        return Some(
            dt.and_utc()
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        );
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|dt| {
            dt.and_utc()
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        })
}

/// Parses an RFC 3339 instant (also accepts a bare unix seconds string).
pub fn parse_instant(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            s.parse::<i64>()
                .ok()
                .and_then(|n| Utc.timestamp_opt(n, 0).single())
        })
}

/// First 4-digit year (1900..2100) in a release date like `2019-05-01` or `01/05/2019`.
pub fn year_from_date(s: Option<&str>) -> Option<i64> {
    let s = s?;
    let bytes = s.as_bytes();
    (0..bytes.len().saturating_sub(3)).find_map(|i| {
        // Check bytes first: slicing `s` at an arbitrary byte panics inside a
        // multi-byte character (Arabic dates, for one).
        let w = &bytes[i..i + 4];
        let digits = w.iter().all(u8::is_ascii_digit);
        let left_ok = i == 0 || !bytes[i - 1].is_ascii_digit();
        let right_ok = i + 4 == bytes.len() || !bytes[i + 4].is_ascii_digit();
        if digits && left_ok && right_ok {
            std::str::from_utf8(w)
                .ok()?
                .parse::<i64>()
                .ok()
                .filter(|y| (1900..=2100).contains(y))
        } else {
            None
        }
    })
}

/// `HH:MM:SS` / `MM:SS` / minutes (`"95"`, `"95 min"`) to seconds.
pub fn duration_to_seconds(s: Option<&str>) -> Option<i64> {
    let s = s?.trim();
    if s.contains(':') {
        let parts: Option<Vec<i64>> = s.split(':').map(|p| p.trim().parse::<i64>().ok()).collect();
        let parts = parts?;
        let secs = parts.iter().fold(0i64, |acc, p| acc * 60 + p);
        return (secs > 0).then_some(secs);
    }
    let digits: String = s.chars().take_while(char::is_ascii_digit).collect();
    digits
        .parse::<i64>()
        .ok()
        .filter(|m| *m > 0)
        .map(|m| m * 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offset_from_server_clock() {
        // 1700000000 = 2023-11-14 22:13:20 UTC
        assert_eq!(
            server_offset_seconds(Some(1_700_000_000), Some("2023-11-14 23:13:20")),
            3600
        );
        assert_eq!(
            server_offset_seconds(Some(1_700_000_000), Some("2023-11-14 22:13:41")),
            0
        );
        assert_eq!(
            server_offset_seconds(Some(1_700_000_000), Some("2023-11-14 16:43:20")),
            -5 * 3600 - 1800
        );
        assert_eq!(server_offset_seconds(None, Some("2023-11-14 23:13:20")), 0);
        assert_eq!(server_offset_seconds(Some(1_700_000_000), Some("junk")), 0);
    }

    #[test]
    fn time_conversions() {
        assert_eq!(
            unix_to_rfc3339(1_700_000_000).as_deref(),
            Some("2023-11-14T22:13:20Z")
        );
        assert_eq!(unix_to_rfc3339(0), None);
        assert_eq!(
            added_to_rfc3339(Some("1700000000")).as_deref(),
            Some("2023-11-14T22:13:20Z")
        );
        assert_eq!(
            added_to_rfc3339(Some("2020-01-02")).as_deref(),
            Some("2020-01-02T00:00:00Z")
        );
        assert_eq!(added_to_rfc3339(Some("nope")), None);
        assert!(parse_instant("2026-10-11T02:30:00+02:00").is_some());
        assert!(parse_instant("1700000000").is_some());
    }

    #[test]
    fn years_and_durations() {
        assert_eq!(year_from_date(Some("2019-05-01")), Some(2019));
        assert_eq!(year_from_date(Some("01/05/1999")), Some(1999));
        assert_eq!(year_from_date(Some("12345")), None);
        assert_eq!(year_from_date(Some("جمعة 2019")), Some(2019));
        assert_eq!(year_from_date(Some("ج")), None);
        assert_eq!(duration_to_seconds(Some("01:30:05")), Some(5405));
        assert_eq!(duration_to_seconds(Some("95 min")), Some(5700));
        assert_eq!(duration_to_seconds(Some("")), None);
    }
}
