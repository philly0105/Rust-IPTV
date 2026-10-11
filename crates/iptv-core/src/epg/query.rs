//! Read side: programmes of a channel in a time range, now/next, grid rows,
//! channel search. Only urls that are enabled contribute.

use super::store::STAGING_ORIGIN;
use crate::error::{CoreError, CoreResult};
use crate::model::{EpgNowNext, EpgProgram};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// Programmes longer than this may be missed by range queries that start
/// inside them (the lookback bound keeps queries on the index).
pub const MAX_PROGRAMME_SECS: i64 = 36 * 3600;
/// Largest range accepted by `epg.programs` / `epg.grid`.
pub const MAX_RANGE_SECS: i64 = 31 * 86_400;
/// Programmes returned per channel at most.
pub const MAX_PER_CHANNEL: i64 = 3_000;

/// Unix seconds to RFC 3339 UTC (`2026-10-11T02:30:00Z`).
pub fn to_rfc3339(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// RFC 3339 (any offset) to unix seconds.
pub fn parse_time(s: &str, field: &str) -> CoreResult<i64> {
    chrono::DateTime::parse_from_rfc3339(s.trim())
        .map(|d| d.timestamp())
        .map_err(|_| {
            CoreError::Invalid(format!("{field} must be an RFC 3339 timestamp, got {s:?}"))
        })
}

/// Validates a `from`/`to` pair.
pub fn parse_range(from: &str, to: &str) -> CoreResult<(i64, i64)> {
    let f = parse_time(from, "from")?;
    let t = parse_time(to, "to")?;
    if t <= f {
        return Err(CoreError::Invalid("to must be after from".into()));
    }
    if t - f > MAX_RANGE_SECS {
        return Err(CoreError::Invalid(
            "the range may span at most 31 days".into(),
        ));
    }
    Ok((f, t))
}

#[derive(Debug, Clone)]
struct Row {
    start: i64,
    stop: i64,
    title: String,
    description: Option<String>,
    category: Option<String>,
    icon: Option<String>,
}

fn rows(
    conn: &Connection,
    channel_id: &str,
    from: i64,
    to: i64,
    limit: i64,
) -> CoreResult<Vec<Row>> {
    let mut stmt = conn.prepare_cached(
        "SELECT p.start, p.stop, p.title, p.description, p.category, p.icon
         FROM epg_programs p JOIN epg_sources s ON s.url = p.epg_url
         WHERE p.channel_id = ?1 AND p.start >= ?2 AND p.start < ?3 AND p.stop > ?4
           AND s.enabled = 1 AND s.origin <> ?5
         ORDER BY p.start, s.rowid LIMIT ?6",
    )?;
    let it = stmt.query_map(
        params![
            channel_id,
            from - MAX_PROGRAMME_SECS,
            to,
            from,
            STAGING_ORIGIN,
            limit
        ],
        |r| {
            Ok(Row {
                start: r.get(0)?,
                stop: r.get(1)?,
                title: r.get(2)?,
                description: r.get(3)?,
                category: r.get(4)?,
                icon: r.get(5)?,
            })
        },
    )?;
    Ok(tidy(it.collect::<Result<Vec<_>, _>>()?))
}

/// Makes a sorted list safe to lay out: duplicates with the same start (two
/// feeds, or a feed listing a slot twice) keep the first; an overlap clips the
/// earlier programme at the later one's start; zero-length leftovers drop.
fn tidy(sorted: Vec<Row>) -> Vec<Row> {
    let mut out: Vec<Row> = Vec::with_capacity(sorted.len());
    for r in sorted {
        if r.stop <= r.start {
            continue;
        }
        if let Some(prev) = out.last_mut() {
            if prev.start == r.start {
                continue;
            }
            if prev.stop > r.start {
                prev.stop = r.start;
            }
        }
        out.push(r);
    }
    out
}

fn to_program(channel_id: &str, r: Row) -> EpgProgram {
    EpgProgram {
        channel_id: channel_id.to_string(),
        start: to_rfc3339(r.start),
        end: to_rfc3339(r.stop),
        title: r.title,
        description: r.description,
        category: r.category,
        icon: r.icon,
    }
}

/// Programmes of `channel_id` overlapping `[from, to)`, in start order.
pub fn programs(
    conn: &Connection,
    channel_id: &str,
    from: i64,
    to: i64,
) -> CoreResult<Vec<EpgProgram>> {
    Ok(rows(conn, channel_id, from, to, MAX_PER_CHANNEL)?
        .into_iter()
        .map(|r| to_program(channel_id, r))
        .collect())
}

/// Current and next programme of `channel_id` at `now`.
pub fn now_next(conn: &Connection, channel_id: &str, now: i64) -> CoreResult<EpgNowNext> {
    // A day ahead is plenty to find "next"; the limit bounds the work.
    let list = rows(conn, channel_id, now, now + 86_400, 16)?;
    let mut out = EpgNowNext::default();
    let mut it = list.into_iter().peekable();
    while let Some(r) = it.next() {
        if r.start <= now && now < r.stop {
            out.now = Some(to_program(channel_id, r));
            if let Some(n) = it.next() {
                out.next = Some(to_program(channel_id, n));
            }
            break;
        }
        if r.start > now {
            out.next = Some(to_program(channel_id, r));
            break;
        }
    }
    Ok(out)
}

/// One `epg.channelsSearch` hit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMatch {
    pub channel_id: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub epg_url: String,
}

/// Channels whose display name or id contains `query` (case-insensitive),
/// prefix matches first. An empty query lists channels alphabetically.
pub fn channels_search(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> CoreResult<Vec<ChannelMatch>> {
    let q = query.trim();
    let escaped: String = q
        .chars()
        .flat_map(|c| match c {
            '\\' | '%' | '_' => vec!['\\', c],
            c => vec![c],
        })
        .collect();
    let contains = format!("%{escaped}%");
    let prefix = format!("{escaped}%");
    let mut stmt = conn.prepare_cached(
        "SELECT c.channel_id, c.display_name, c.icon, c.epg_url
         FROM epg_channels c JOIN epg_sources s ON s.url = c.epg_url
         WHERE s.enabled = 1 AND s.origin <> ?1
           AND (c.display_name LIKE ?2 ESCAPE '\\' OR c.channel_id LIKE ?2 ESCAPE '\\')
         ORDER BY CASE WHEN c.display_name LIKE ?3 ESCAPE '\\' THEN 0
                       WHEN c.channel_id LIKE ?3 ESCAPE '\\' THEN 1 ELSE 2 END,
                  length(c.display_name), c.display_name COLLATE NOCASE, s.rowid
         LIMIT ?4",
    )?;
    let it = stmt.query_map(
        params![STAGING_ORIGIN, contains, prefix, limit as i64],
        |r| {
            Ok(ChannelMatch {
                channel_id: r.get(0)?,
                display_name: r.get(1)?,
                icon: r.get(2)?,
                epg_url: r.get(3)?,
            })
        },
    )?;
    Ok(it.collect::<Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(start: i64, stop: i64, title: &str) -> Row {
        Row {
            start,
            stop,
            title: title.into(),
            description: None,
            category: None,
            icon: None,
        }
    }

    #[test]
    fn tidy_dedupes_and_clips() {
        let out = tidy(vec![
            row(0, 100, "a"),
            row(0, 100, "a-dup"),
            row(50, 150, "b"),
            row(150, 150, "zero"),
            row(150, 200, "c"),
        ]);
        let t: Vec<_> = out
            .iter()
            .map(|r| (r.title.as_str(), r.start, r.stop))
            .collect();
        assert_eq!(t, vec![("a", 0, 50), ("b", 50, 150), ("c", 150, 200)]);
    }

    #[test]
    fn rfc3339() {
        assert_eq!(to_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            parse_time("2024-01-01T12:00:00+01:00", "from").unwrap(),
            1_704_106_800
        );
        assert!(parse_range("2024-01-02T00:00:00Z", "2024-01-01T00:00:00Z").is_err());
    }
}
