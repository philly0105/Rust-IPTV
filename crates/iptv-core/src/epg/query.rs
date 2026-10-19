//! Read side: programmes of a channel in a time range, now/next, grid rows,
//! channel search. Only urls that are enabled contribute, and one channel's
//! programmes come from one url. A channel's `tvg-shift` moves its programmes.

use super::store::STAGING_ORIGIN;
use crate::error::{CoreError, CoreResult};
use crate::model::{EpgNowNext, EpgProgram, ItemRef};
use rusqlite::{params, Connection, OptionalExtension};
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

/// Largest `tvg-shift` applied, in hours either way.
pub const MAX_SHIFT_HOURS: f64 = 24.0;

/// A `tvg-shift` value (hours, may be fractional or signed: "1", "+1.5",
/// "-2", "0,5") in seconds; 0 when unusable or beyond [`MAX_SHIFT_HOURS`].
pub fn parse_shift(value: &str) -> i64 {
    value
        .trim()
        .replace(',', ".")
        .parse::<f64>()
        .ok()
        .filter(|h| h.is_finite() && h.abs() <= MAX_SHIFT_HOURS)
        .map_or(0, |h| (h * 3600.0).round() as i64)
}

/// The `tvg-shift` of a catalog item in seconds (`extraJson.tvgShift`, set
/// by the M3U import); 0 for items without one.
pub fn item_shift(conn: &Connection, r: &ItemRef) -> CoreResult<i64> {
    let extra: Option<String> = conn
        .prepare_cached(
            "SELECT extra_json FROM items WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        )?
        .query_row(
            params![r.source_id, r.content_type.as_str(), r.item_id],
            |row| row.get(0),
        )
        .optional()?;
    let shift = extra
        .and_then(|e| serde_json::from_str::<serde_json::Value>(&e).ok())
        .and_then(|v| match v.get("tvgShift")? {
            serde_json::Value::String(s) => Some(parse_shift(s)),
            serde_json::Value::Number(n) => Some(parse_shift(&n.to_string())),
            _ => None,
        });
    Ok(shift.unwrap_or(0))
}

/// The feed a channel's programmes come from: the first enabled url (by
/// rowid) with a programme of channel `?1` that starts in `[?2, ?3)` (the
/// range plus the lookback before it) and still runs after `?4` (the range
/// start). The urls are tried in rowid order, each with one probe of the
/// `(epg_url, channel_id, start)` index read backwards from the range end:
/// the latest start nearly always runs after the range start, so the probe
/// stops at its first row. Joining from the programmes instead read every
/// programme of the lookback and the range in every feed before sorting by
/// url. `+p.stop` keeps the plan off the `stop` index.
pub const FEED_SQL: &str = "SELECT s.url FROM epg_sources s
     WHERE s.enabled = 1 AND s.origin <> ?5
       AND (SELECT p.start FROM epg_programs p
             WHERE p.epg_url = s.url AND p.channel_id = ?1 AND p.start >= ?2 AND p.start < ?3
               AND +p.stop > ?4 AND p.stop > p.start
             ORDER BY p.start DESC LIMIT 1) IS NOT NULL
     ORDER BY s.rowid LIMIT 1";
/// The last programme of the feed starting in the lookback (zero-length rows
/// are skipped here as [`tidy`] skips them: they clip nothing).
pub const BEFORE_SQL: &str =
    "SELECT start, stop, title, description, category, icon FROM epg_programs
     WHERE epg_url = ?1 AND channel_id = ?2 AND start >= ?3 AND start < ?4 AND stop > start
     ORDER BY start DESC LIMIT 1";
/// The feed's programmes starting in the range.
pub const INSIDE_SQL: &str =
    "SELECT start, stop, title, description, category, icon FROM epg_programs
     WHERE epg_url = ?1 AND channel_id = ?2 AND start >= ?3 AND start < ?4
     ORDER BY start LIMIT ?5";
/// [`BEFORE_SQL`] without the description (`withDescription: false`): about
/// half the bytes of a guide page or a now/next list.
pub const BEFORE_BRIEF_SQL: &str =
    "SELECT start, stop, title, NULL, category, icon FROM epg_programs
     WHERE epg_url = ?1 AND channel_id = ?2 AND start >= ?3 AND start < ?4 AND stop > start
     ORDER BY start DESC LIMIT 1";
/// [`INSIDE_SQL`] without the description.
pub const INSIDE_BRIEF_SQL: &str =
    "SELECT start, stop, title, NULL, category, icon FROM epg_programs
     WHERE epg_url = ?1 AND channel_id = ?2 AND start >= ?3 AND start < ?4
     ORDER BY start LIMIT ?5";

/// Tidied programmes of `channel_id` overlapping `[from, to)`, at most
/// `limit`, moved by `shift` seconds (the channel's `tvg-shift`): the range
/// is in channel time, the guide is read at `[from - shift, to - shift)`.
///
/// Every row comes from one feed ([`FEED_SQL`]): two guide urls covering
/// the same channel cut the schedule differently, and tidying their rows
/// against each other left sliver programmes.
///
/// After [`tidy`], a programme that starts before `from` can only still be
/// running at `from` when it is the LAST one to start before `from` (any
/// later start clips it). So the query takes that one programme (within the
/// lookback) plus the programmes starting in the range. Taking the earliest
/// rows of the whole lookback window instead let a `LIMIT` cut the list
/// before the programme that is actually on (broken feeds whose programmes
/// overlap by days).
///
/// `with_description: false` leaves every description out.
fn rows(
    conn: &Connection,
    channel_id: &str,
    from: i64,
    to: i64,
    limit: i64,
    shift: i64,
    with_description: bool,
) -> CoreResult<Vec<Row>> {
    let (from, to) = (from - shift, to - shift);
    let feed: Option<String> = conn
        .prepare_cached(FEED_SQL)?
        .query_row(
            params![
                channel_id,
                from - MAX_PROGRAMME_SECS,
                to,
                from,
                STAGING_ORIGIN
            ],
            |r| r.get(0),
        )
        .optional()?;
    let Some(feed) = feed else {
        return Ok(Vec::new());
    };
    let map = |r: &rusqlite::Row<'_>| {
        Ok(Row {
            start: r.get(0)?,
            stop: r.get(1)?,
            title: r.get(2)?,
            description: r.get(3)?,
            category: r.get(4)?,
            icon: r.get(5)?,
        })
    };
    let (before_sql, inside_sql) = if with_description {
        (BEFORE_SQL, INSIDE_SQL)
    } else {
        (BEFORE_BRIEF_SQL, INSIDE_BRIEF_SQL)
    };
    let mut before = conn.prepare_cached(before_sql)?;
    let mut list: Vec<Row> = before
        .query_map(
            params![feed, channel_id, from - MAX_PROGRAMME_SECS, from],
            map,
        )?
        .collect::<Result<_, _>>()?;
    let mut inside = conn.prepare_cached(inside_sql)?;
    for r in inside.query_map(params![feed, channel_id, from, to, limit], map)? {
        list.push(r?);
    }
    let mut out = tidy(list);
    // A clipped programme may now end before the range.
    out.retain(|r| r.stop > from);
    out.truncate(limit.max(0) as usize);
    for r in &mut out {
        r.start += shift;
        r.stop += shift;
    }
    Ok(out)
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

/// Programmes of `channel_id` overlapping `[from, to)`, in start order,
/// moved by `shift` seconds (the channel's `tvg-shift`, see [`item_shift`]).
pub fn programs(
    conn: &Connection,
    channel_id: &str,
    from: i64,
    to: i64,
    shift: i64,
) -> CoreResult<Vec<EpgProgram>> {
    programs_with(conn, channel_id, from, to, shift, true)
}

/// [`programs`], with or without descriptions.
pub fn programs_with(
    conn: &Connection,
    channel_id: &str,
    from: i64,
    to: i64,
    shift: i64,
    with_description: bool,
) -> CoreResult<Vec<EpgProgram>> {
    Ok(rows(
        conn,
        channel_id,
        from,
        to,
        MAX_PER_CHANNEL,
        shift,
        with_description,
    )?
    .into_iter()
    .map(|r| to_program(channel_id, r))
    .collect())
}

/// Current and next programme of `channel_id` at `now`, moved by `shift`
/// seconds (the channel's `tvg-shift`).
pub fn now_next(
    conn: &Connection,
    channel_id: &str,
    now: i64,
    shift: i64,
) -> CoreResult<EpgNowNext> {
    now_next_with(conn, channel_id, now, shift, true)
}

/// [`now_next`], with or without descriptions.
pub fn now_next_with(
    conn: &Connection,
    channel_id: &str,
    now: i64,
    shift: i64,
    with_description: bool,
) -> CoreResult<EpgNowNext> {
    // A day ahead is plenty to find "next"; the limit bounds the work.
    let list = rows(
        conn,
        channel_id,
        now,
        now + 86_400,
        16,
        shift,
        with_description,
    )?;
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

    fn guide(progs: &[(i64, i64, &str)]) -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        conn.execute("INSERT INTO epg_sources(url) VALUES ('u')", [])
            .unwrap();
        for (start, stop, title) in progs {
            conn.execute(
                "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES ('u', 'c', ?1, ?2, ?3)",
                params![start, stop, title],
            )
            .unwrap();
        }
        conn
    }

    /// Review R1-3: with more than 16 starts in the lookback and stops that
    /// overlap by days, LIMIT 16 cut the list before the programme on air and
    /// "now" showed one from hours ago.
    #[test]
    fn now_next_with_broken_stops_picks_the_programme_on_air() {
        let now = 1_800_000_000;
        let h = 3600;
        let names: Vec<String> = (0..20).map(|i| format!("p{i}")).collect();
        let mut progs: Vec<(i64, i64, &str)> = (0..20)
            .map(|i| {
                let start = now - 20 * h + i * h;
                (start, start + 3 * 86_400, names[i as usize].as_str())
            })
            .collect();
        progs.push((now + h, now + 2 * h, "later"));
        let conn = guide(&progs);
        let nn = now_next(&conn, "c", now, 0).unwrap();
        let on = nn.now.expect("a programme is on");
        assert_eq!(on.title, "p19");
        assert_eq!(on.start, to_rfc3339(now - h));
        assert_eq!(on.end, to_rfc3339(now + h), "clipped at the next start");
        assert_eq!(nn.next.unwrap().title, "later");
        // epg.programs agrees.
        let list = programs(&conn, "c", now, now + 1, 0).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "p19");
    }

    /// Review R1-3: a programme clipped by a later start could end before the
    /// requested range and was still returned.
    #[test]
    fn programs_never_returns_rows_outside_the_range() {
        let from = 1_800_000_000;
        let conn = guide(&[
            (from - 7200, from + 18_000, "clipped away"),
            (from - 3600, from + 3600, "on"),
            (from + 3600, from + 7200, "after"),
        ]);
        let list = programs(&conn, "c", from, from + 7200, 0).unwrap();
        let titles: Vec<_> = list.iter().map(|p| p.title.as_str()).collect();
        assert_eq!(titles, ["on", "after"]);
        // A zero-length last row before the range does not hide the one on air.
        let conn = guide(&[
            (from - 3600, from + 3600, "on"),
            (from - 60, from - 60, "zero"),
        ]);
        assert_eq!(
            now_next(&conn, "c", from, 0).unwrap().now.unwrap().title,
            "on"
        );
    }

    /// EP-5: the feed is the first enabled url (by rowid) with a programme
    /// running in the range; disabled and staging urls never count.
    #[test]
    fn feed_is_the_first_enabled_url_with_a_programme_in_range() {
        let now = 1_800_000_000;
        let h = 3600;
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        for (url, enabled, origin) in [
            ("off", 0, "settings"),
            ("stage", 1, STAGING_ORIGIN),
            ("old", 1, "settings"),
            ("good", 1, "source"),
            ("late", 1, "settings"),
        ] {
            conn.execute(
                "INSERT INTO epg_sources(url, enabled, origin) VALUES (?1, ?2, ?3)",
                params![url, enabled, origin],
            )
            .unwrap();
        }
        for (url, start, stop) in [
            ("off", now - h, now + h),
            ("stage", now - h, now + h),
            // Ended before the range: no programme of "old" runs in it.
            ("old", now - 30 * h, now - 29 * h),
            ("old", now - 2 * h, now - h),
            ("good", now - 20 * h, now - 19 * h),
            ("good", now - h / 2, now + h / 2),
            ("late", now - h, now + h),
        ] {
            conn.execute(
                "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES (?1, 'c', ?2, ?3, ?1)",
                params![url, start, stop],
            )
            .unwrap();
        }
        let feed = |from: i64, to: i64| -> Option<String> {
            conn.query_row(
                FEED_SQL,
                params!["c", from - MAX_PROGRAMME_SECS, to, from, STAGING_ORIGIN],
                |r| r.get(0),
            )
            .optional()
            .unwrap()
        };
        assert_eq!(feed(now, now + 60).as_deref(), Some("good"));
        assert_eq!(feed(now - 2 * h, now - h).as_deref(), Some("old"));
        assert_eq!(feed(now + 5 * h, now + 6 * h), None);
        let nn = now_next(&conn, "c", now, 0).unwrap();
        assert_eq!(nn.now.unwrap().title, "good");
    }

    /// The brief statements differ from the full ones only in the
    /// description column: same parameters, same index plan.
    #[test]
    fn brief_statements_match_the_full_ones_but_the_description() {
        for (full, brief) in [
            (BEFORE_SQL, BEFORE_BRIEF_SQL),
            (INSIDE_SQL, INSIDE_BRIEF_SQL),
        ] {
            assert_eq!(full.replacen("description", "NULL", 1), brief);
            let conn = guide(&[]);
            let plan = |sql: &str| -> Vec<String> {
                let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
                let args = vec![rusqlite::types::Null; stmt.parameter_count()];
                stmt.query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(3))
                    .unwrap()
                    .map(Result::unwrap)
                    .collect()
            };
            assert_eq!(plan(full), plan(brief), "{brief}");
        }
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
