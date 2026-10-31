//! `create_link` playback, catch-up, short EPG, account info and the
//! connection test.

use super::mapping;
use super::protocol::{self as p, into_list, n, s};
use super::session::{self, Req, StalkerClient, LONG_TIMEOUT};
use super::vod;
use crate::catalog;
use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, EpgProgram, ItemRef, PlayerSource, StalkerSourceConfig};
use crate::state::AppState;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use dashmap::DashMap;
use futures::future::{BoxFuture, FutureExt, Shared};
use futures::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// `stalker.accountInfo` result (TS `StalkerAccountInfo`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StalkerAccountInfo {
    pub mac: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tariff: Option<String>,
    pub raw: Value,
}

/// `stalker.test` result (TS `ConnectionTestResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Asks the portal for a playable link. `js.error` (e.g. `nothing_to_play`,
/// `limit`) becomes an error; the returned command is resolved against the
/// portal installation.
pub async fn create_link(
    client: &StalkerClient,
    link_type: &str,
    cmd: &str,
    series: Option<i64>,
) -> CoreResult<String> {
    let endpoint = client.endpoint().await?;
    let req = Req::new(link_type, "create_link")
        .p("cmd", cmd)
        .p("series", series.map(|n| n.to_string()).unwrap_or_default())
        .p("disable_ad", "0")
        .p("download", "0");
    let js = client.call(req).await?;
    if let Some(err) = s(&js, "error") {
        return Err(match err.as_str() {
            "nothing_to_play" => {
                CoreError::not_found("The portal has nothing to play for this item.")
            }
            "limit" => {
                CoreError::Conflict("The portal's simultaneous stream limit is reached.".into())
            }
            "link_fault" | "not_available" => {
                CoreError::network("The portal could not create a stream link. Try again later.")
            }
            other => CoreError::network(format!(
                "The portal refused to create a stream link ({other})."
            )),
        });
    }
    let reply = match &js {
        Value::String(s) => s.clone(),
        _ => s(&js, "cmd").unwrap_or_default(),
    };
    let url = p::resolve_playback_url(&endpoint, cmd, &reply);
    if url.is_empty() || !p::is_playable_http_url(&url) {
        return Err(CoreError::network("The portal returned no playable link."));
    }
    Ok(url)
}

fn source(
    client: &StalkerClient,
    endpoint: &str,
    url: String,
    title: String,
    r: &ItemRef,
) -> PlayerSource {
    PlayerSource {
        kind: p::player_kind_for(&url),
        headers: p::playback_headers(endpoint, &url, &client.config.headers),
        title,
        subtitle: None,
        poster_url: None,
        item_ref: Some(r.clone()),
        episode_id: None,
        resume_seconds: None,
        is_live: matches!(r.content_type, ContentType::Live | ContentType::Radio),
        is_radio: r.content_type == ContentType::Radio,
        url,
    }
}

async fn catalog_row(state: &AppState, r: &ItemRef) -> CoreResult<catalog::ItemRow> {
    let r2 = r.clone();
    state
        .db_call(move |conn| catalog::get(conn, &r2))
        .await?
        .ok_or_else(|| {
            CoreError::not_found("This channel is not in the catalog any more. Refresh the source.")
        })
}

/// Resolves a movie's `/media/<id>.mpg` command to its first file id.
async fn movie_cmd(client: &StalkerClient, raw: &Value, movie_id: &str) -> CoreResult<String> {
    let cmd = s(raw, "cmd").unwrap_or_else(|| format!("/media/{movie_id}.mpg"));
    let has_files = raw.get("has_files").is_some_and(|v| !v.is_null());
    if p::should_resolve_movie_file_id(has_files, &cmd) {
        let js = client
            .call(
                Req::new("vod", "get_ordered_list")
                    .p("movie_id", movie_id)
                    .p("p", 1),
            )
            .await?;
        if let Some(file_id) = into_list(js).first().and_then(|f| s(f, "id")) {
            return Ok(format!("/media/file_{file_id}.mpg"));
        }
    }
    Ok(cmd)
}

/// `stalker.streamUrl`.
pub async fn stream_url(
    state: &Arc<AppState>,
    r: &ItemRef,
    episode_id: Option<&str>,
) -> CoreResult<PlayerSource> {
    let client = StalkerClient::for_source(state, &r.source_id).await?;
    let endpoint = client.endpoint().await?;
    match r.content_type {
        ContentType::Live | ContentType::Radio => {
            let row = catalog_row(state, r).await?;
            let raw = mapping::channel_raw(&row.extra);
            let cmd = s(&raw, "cmd").ok_or_else(|| {
                CoreError::not_found("The portal sent no stream command for this channel.")
            })?;
            let url = match p::static_playback_url(&raw, &cmd) {
                Some(url) => url,
                None => {
                    let link_type = if r.content_type == ContentType::Radio {
                        "radio"
                    } else {
                        "itv"
                    };
                    create_link(&client, link_type, &cmd, None).await?
                }
            };
            let mut src = source(&client, &endpoint, url, row.title.clone(), r);
            src.poster_url = row.logo_url.clone();
            Ok(src)
        }
        ContentType::Movie => {
            let cached = vod::lookup(state, &client, r).await?;
            let raw = &cached.raw;
            let cmd = movie_cmd(&client, raw, &r.item_id).await?;
            let url = match p::static_playback_url(raw, &cmd) {
                Some(url) => url,
                None => create_link(&client, "vod", &cmd, None).await?,
            };
            let item = mapping::vod_item(&r.source_id, &endpoint, raw, "*", None);
            let title = item
                .as_ref()
                .map(|i| i.title.clone())
                .unwrap_or_else(|| "Movie".into());
            let mut src = source(&client, &endpoint, url, title, r);
            src.poster_url = item.and_then(|i| i.poster_url);
            Ok(src)
        }
        ContentType::Series => {
            let episode_id = episode_id
                .filter(|e| !e.trim().is_empty())
                .ok_or_else(|| CoreError::invalid("episodeId is required to play a series"))?;
            let plans = vod::season_plan(state, &client, r).await?;
            let (season, episode) = vod::find_episode(&plans, episode_id).ok_or_else(|| {
                CoreError::not_found("This episode is no longer listed by the portal.")
            })?;
            let cmd = if episode.series.is_none() && !episode.raw.is_null() {
                let eid = s(&episode.raw, "id").unwrap_or_default();
                movie_cmd(&client, &episode.raw, &eid).await?
            } else {
                episode.cmd.clone()
            };
            let url = create_link(&client, "vod", &cmd, episode.series).await?;
            let series_title = cached_title(state, r).await;
            let mut src = source(
                &client,
                &endpoint,
                url,
                series_title.unwrap_or_else(|| episode.title.clone()),
                r,
            );
            src.subtitle = Some(format!(
                "S{:02}E{:02} {}",
                season.number, episode.number, episode.title
            ));
            src.poster_url = episode
                .poster_url
                .clone()
                .or_else(|| season.poster_url.clone());
            src.episode_id = Some(episode.id.clone());
            Ok(src)
        }
    }
}

async fn cached_title(state: &AppState, r: &ItemRef) -> Option<String> {
    let hit = super::cached_item(state, r).await?;
    s(&hit.raw, "name").or_else(|| s(&hit.raw, "o_name"))
}

/// `stalker.catchupUrl`: finds the archived program starting at `start` and
/// asks `tv_archive/create_link` for it. The program defines the length, so
/// `durationMinutes` is accepted but not sent. `start` must lie in the past
/// and inside the channel's archive window.
pub async fn catchup_url(
    state: &Arc<AppState>,
    r: &ItemRef,
    start: &str,
    _duration_minutes: i64,
) -> CoreResult<PlayerSource> {
    if r.content_type != ContentType::Live {
        return Err(CoreError::invalid(
            "catch-up is only available for live channels",
        ));
    }
    let start_at = DateTime::parse_from_rfc3339(start)
        .map_err(|_| CoreError::invalid("start must be an RFC 3339 timestamp"))?
        .with_timezone(&Utc);
    let row = catalog_row(state, r).await?;
    let archive_hours = row.archive_hours.unwrap_or(0);
    if archive_hours <= 0 {
        return Err(CoreError::Unsupported(
            "This channel has no archive on the portal.".into(),
        ));
    }
    check_archive_window(start_at, Utc::now(), archive_hours)?;
    let client = StalkerClient::for_source(state, &r.source_id).await?;
    let endpoint = client.endpoint().await?;

    let program = find_archive_program(state, &client, &r.source_id, &r.item_id, start_at)
        .await?
        .ok_or_else(|| {
            CoreError::not_found("The portal archive has no program at that time for this channel.")
        })?;
    let program_id = s(&program, "id").ok_or_else(|| {
        CoreError::not_found("The portal archive has no program at that time for this channel.")
    })?;
    let url = create_link(
        &client,
        "tv_archive",
        &format!("auto /media/{program_id}.mpg"),
        None,
    )
    .await?;
    let aired = n(&program, "start_timestamp")
        .and_then(|ts| DateTime::from_timestamp(ts, 0))
        .unwrap_or(start_at);
    let mut src = source(&client, &endpoint, url, row.title.clone(), r);
    src.is_live = false;
    src.subtitle = Some(match s(&program, "name") {
        Some(name) => format!("{} {name}", aired.format("%Y-%m-%d %H:%M UTC")),
        None => aired.format("%Y-%m-%d %H:%M UTC").to_string(),
    });
    src.poster_url = row.logo_url;
    Ok(src)
}

/// Rejects catch-up starts in the future or older than the archive window.
fn check_archive_window(
    start: DateTime<Utc>,
    now: DateTime<Utc>,
    archive_hours: i64,
) -> CoreResult<()> {
    if start >= now {
        return Err(CoreError::invalid(
            "This programme has not started yet, so there is nothing to catch up on.",
        ));
    }
    // Rows stored by older builds may carry any provider value: clamp so the
    // duration and the subtraction cannot panic.
    let archive_hours = super::protocol::clamp_archive_hours(archive_hours);
    let oldest = now
        .checked_sub_signed(Duration::hours(archive_hours))
        .unwrap_or(DateTime::<Utc>::MIN_UTC);
    if start < oldest {
        let window = if archive_hours % 24 == 0 {
            let days = archive_hours / 24;
            format!("{days} day{}", if days == 1 { "" } else { "s" })
        } else {
            format!(
                "{archive_hours} hour{}",
                if archive_hours == 1 { "" } else { "s" }
            )
        };
        return Err(CoreError::invalid(format!(
            "The portal keeps {window} of archive for this channel; this programme is older."
        )));
    }
    Ok(())
}

/// True when the portal gave no usable answer in time (no HTTP answer at
/// all, or too slow). Falling back to another call would only wait again.
fn no_answer(err: &CoreError) -> bool {
    matches!(err, CoreError::Timeout(_)) || session::is_unreachable(err)
}

/// Most day tables cached, over every source and channel. A 7-day archive
/// ribbon reads 9, a guide row 2-3.
const DAY_TABLE_CAP: usize = 512;
/// How long a cached day table is reused. A past day's table no longer
/// changes; today's and tomorrow's can (and a stale programme id would give
/// a dead catch-up link), and an empty answer may be a table the portal has
/// not built yet.
const DAY_TABLE_TTL_PAST: std::time::Duration = std::time::Duration::from_secs(30 * 60);
const DAY_TABLE_TTL_NEAR: std::time::Duration = std::time::Duration::from_secs(5 * 60);
const DAY_TABLE_TTL_EMPTY: std::time::Duration = std::time::Duration::from_secs(2 * 60);
/// Day-table requests in flight per source, over every caller (the ribbon,
/// the guide's rows, a catch-up click): unbounded, one ribbon plus two
/// guide rows could put 20+ requests on one MAC, which portals may throttle.
const DAY_TABLE_REQUESTS: usize = 6;
/// Pages of one table asked at once after page 1.
const DAY_PAGE_CONCURRENCY: usize = 3;
/// Most pages read of one table.
const MAX_DAY_PAGES: u64 = 10;
/// The day-table row keys [`mapping::epg_program`], [`archive_row_matches`]
/// and [`catchup_url`] read: a cached row keeps only these.
const DAY_ROW_KEYS: [&str; 14] = [
    "id",
    "name",
    "title",
    "descr",
    "description",
    "category",
    "start_timestamp",
    "stop_timestamp",
    "time",
    "time_to",
    "start",
    "stop",
    "end",
    "duration",
];

/// One day's programme table, as the cache keeps it.
#[derive(Debug)]
pub struct DayTable {
    /// Rows trimmed to [`DAY_ROW_KEYS`]; none when the portal serves no
    /// table for the day.
    rows: Vec<Value>,
    /// Table type that answered (`epg` or `itv`).
    kind: Option<&'static str>,
    at: tokio::time::Instant,
    ttl: std::time::Duration,
}

type DayTableFuture = Shared<BoxFuture<'static, Result<Arc<DayTable>, Arc<CoreError>>>>;

#[derive(Clone)]
struct DayTableEntry {
    fut: DayTableFuture,
    started: tokio::time::Instant,
}

impl DayTableEntry {
    /// True when the entry may not be reused: its answer is past its TTL,
    /// or the read failed (a failure is never cached).
    fn stale(&self) -> bool {
        match self.fut.peek() {
            Some(Ok(t)) => t.at.elapsed() >= t.ttl,
            Some(Err(_)) => true,
            None => false,
        }
    }
}

/// The archive guide's day tables, keyed `<sourceId>|<channelId>|<date>`
/// (R5-1). The Live ribbon of an archive channel read up to 9 tables, the
/// guide's rows 2-3 each, and a catch-up click read the same tables again
/// before `create_link`; each was read anew every time. One read is now
/// shared by every caller (single flight) and reused until its TTL.
#[derive(Default)]
pub struct DayTables {
    entries: DashMap<String, DayTableEntry>,
    /// Table type that last answered per source, asked first next time.
    kinds: DashMap<String, &'static str>,
    /// Bounds a source's day-table requests ([`DAY_TABLE_REQUESTS`]).
    gates: DashMap<String, Arc<tokio::sync::Semaphore>>,
}

impl DayTables {
    /// Drops a source's tables and what was learned about it.
    pub fn forget(&self, source_id: &str) {
        let prefix = format!("{source_id}|");
        self.entries.retain(|k, _| !k.starts_with(&prefix));
        self.kinds.remove(source_id);
        self.gates.remove(source_id);
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn gate(&self, source_id: &str) -> Arc<tokio::sync::Semaphore> {
        self.gates
            .entry(source_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(DAY_TABLE_REQUESTS)))
            .clone()
    }

    /// Keeps at most [`DAY_TABLE_CAP`] entries: the stale ones go first,
    /// then the oldest tenth. A read in flight that is dropped still
    /// answers its waiters.
    fn trim(&self) {
        if self.entries.len() <= DAY_TABLE_CAP {
            return;
        }
        self.entries.retain(|_, e| !e.stale());
        let len = self.entries.len();
        if len <= DAY_TABLE_CAP {
            return;
        }
        let mut ages: Vec<(String, tokio::time::Instant)> = self
            .entries
            .iter()
            .map(|e| (e.key().clone(), e.started))
            .collect();
        ages.sort_unstable_by_key(|(_, at)| *at);
        for (key, _) in ages.into_iter().take(len - DAY_TABLE_CAP * 9 / 10) {
            self.entries.remove(&key);
        }
    }
}

/// One day's table through the cache (R5-1): the cached answer, the read in
/// flight, or a new read in its own task, so a caller that stops waiting
/// (a deadline, a superseded call) still fills the cache.
async fn cached_day_table(
    state: &AppState,
    client: &StalkerClient,
    source_id: &str,
    channel_id: &str,
    date: NaiveDate,
) -> CoreResult<Arc<DayTable>> {
    let rt = super::Runtime::get(state);
    let tables = &rt.day_tables;
    let start = || {
        let first = tables.kinds.get(source_id).map_or("epg", |k| *k);
        let gate = tables.gate(source_id);
        let (client, channel_id) = (client.clone(), channel_id.to_string());
        let task =
            tokio::spawn(async move { day_table(&client, &gate, first, &channel_id, date).await });
        let fut = async move {
            match task.await {
                Ok(read) => read.map(Arc::new).map_err(Arc::new),
                Err(err) => Err(Arc::new(CoreError::Other(anyhow::anyhow!(
                    "Stalker day table: {err}"
                )))),
            }
        }
        .boxed()
        .shared();
        DayTableEntry {
            fut,
            started: tokio::time::Instant::now(),
        }
    };
    let key = format!("{source_id}|{channel_id}|{}", date.format("%Y-%m-%d"));
    let fut = {
        let mut entry = tables.entries.entry(key).or_insert_with(start);
        if entry.stale() {
            *entry = start();
        }
        entry.fut.clone()
    };
    tables.trim();
    let table = fut.await.map_err(|err| shared_error(&err))?;
    if let Some(kind) = table.kind {
        tables.kinds.insert(source_id.to_string(), kind);
    }
    Ok(table)
}

/// A shared read's error, for one of its waiters. Only auth failures and
/// [`no_answer`] errors leave [`day_table`]; both keep kind and message.
fn shared_error(err: &CoreError) -> CoreError {
    match err {
        CoreError::Auth(m) => CoreError::Auth(m.clone()),
        CoreError::Timeout(m) => CoreError::Timeout(m.clone()),
        CoreError::Network(m) => CoreError::Network(m.clone()),
        other => CoreError::Other(anyhow::anyhow!("{other}")),
    }
}

/// Every row of one day's programme table (`get_simple_data_table`),
/// trimmed to [`DAY_ROW_KEYS`]; no rows when the portal serves no table.
/// Ministra serves it under `epg`, some builds only under `itv`: `first` is
/// the type that last answered for the source, and the other one is still
/// asked when it gives nothing. Auth failures and a portal that does not
/// answer ([`no_answer`]) propagate.
async fn day_table(
    client: &StalkerClient,
    gate: &tokio::sync::Semaphore,
    first: &'static str,
    channel_id: &str,
    date: NaiveDate,
) -> CoreResult<DayTable> {
    let day = date.format("%Y-%m-%d").to_string();
    let other = if first == "itv" { "epg" } else { "itv" };
    let mut found = None;
    for table_type in [first, other] {
        let rows = table_pages(client, gate, table_type, channel_id, &day).await?;
        if !rows.is_empty() {
            found = Some((table_type, rows));
            break;
        }
    }
    let (kind, rows) = match found {
        Some((kind, rows)) => (Some(kind), rows.into_iter().map(trim_day_row).collect()),
        None => (None, Vec::new()),
    };
    let ttl = if rows.is_empty() {
        DAY_TABLE_TTL_EMPTY
    } else if date < Utc::now().date_naive() {
        DAY_TABLE_TTL_PAST
    } else {
        DAY_TABLE_TTL_NEAR
    };
    Ok(DayTable {
        rows,
        kind,
        at: tokio::time::Instant::now(),
        ttl,
    })
}

/// The rows of one table type: page 1, then the pages its `total_items`
/// leaves (at most [`MAX_DAY_PAGES`] in all), [`DAY_PAGE_CONCURRENCY`] at a
/// time and in order (R5-1: they went one after another, though page 1
/// gives the total). The page size is page 1's row count, which is what the
/// old one-by-one walk stopped on. A failed or empty page ends the table.
async fn table_pages(
    client: &StalkerClient,
    gate: &tokio::sync::Semaphore,
    table_type: &str,
    channel_id: &str,
    day: &str,
) -> CoreResult<Vec<Value>> {
    let page = |p: u64| {
        let req = Req::new(table_type, "get_simple_data_table")
            .p("ch_id", channel_id)
            .p("date", day)
            .p("p", p);
        async move {
            let _permit = gate.acquire().await.ok();
            page_answer(client.call(req).await)
        }
    };
    let Some(js) = page(1).await? else {
        return Ok(Vec::new());
    };
    let total = n(&js, "total_items");
    let mut rows = into_list(js);
    let per = rows.len() as u64;
    let last = match total {
        Some(t) if per > 0 && t > per as i64 => (t as u64).div_ceil(per).min(MAX_DAY_PAGES),
        _ => 1,
    };
    let rest = stream::iter(2..=last)
        .map(page)
        .buffered(DAY_PAGE_CONCURRENCY);
    tokio::pin!(rest);
    // Dropping `rest` at an empty page drops the requests still out.
    while let Some(js) = rest.next().await {
        let Some(js) = js? else { break };
        let got = into_list(js);
        if got.is_empty() {
            break;
        }
        rows.extend(got);
    }
    Ok(rows)
}

/// A day-table page: `None` for a failure that only ends the table (an
/// unsupported action, an HTML page). Auth failures and a portal that does
/// not answer propagate.
fn page_answer(res: CoreResult<Value>) -> CoreResult<Option<Value>> {
    match res {
        Ok(js) => Ok(Some(js)),
        Err(err @ CoreError::Auth(_)) => Err(err),
        Err(err) if no_answer(&err) => Err(err),
        Err(_) => Ok(None),
    }
}

/// A day-table row with only the keys the guide and catch-up read.
fn trim_day_row(v: Value) -> Value {
    match v {
        Value::Object(mut m) => {
            m.retain(|k, _| DAY_ROW_KEYS.contains(&k.as_str()));
            Value::Object(m)
        }
        other => other,
    }
}

/// The archived program airing at `start`. Ministra builds day tables in
/// the session's cookie timezone (Europe/Paris), not UTC, so a programme
/// late in the UTC day can sit in the next day's table: the adjacent days
/// are asked when the UTC day has no match. The tables come from the cache,
/// so a click on a programme the guide shows reads none.
async fn find_archive_program(
    state: &AppState,
    client: &StalkerClient,
    source_id: &str,
    channel_id: &str,
    start: DateTime<Utc>,
) -> CoreResult<Option<Value>> {
    let ts = start.timestamp();
    for date in archive_days(start.date_naive()) {
        let table = cached_day_table(state, client, source_id, channel_id, date).await?;
        if let Some(hit) = table.rows.iter().find(|v| archive_row_matches(v, ts)) {
            return Ok(Some(hit.clone()));
        }
    }
    Ok(None)
}

/// True when a day-table row is the programme starting at `ts` (within a
/// minute) or running at it. Portal timestamps can be anything, so nothing
/// here may overflow (D10).
fn archive_row_matches(v: &Value, ts: i64) -> bool {
    match (n(v, "start_timestamp"), n(v, "stop_timestamp")) {
        (Some(a), Some(b)) => a <= ts.saturating_add(60) && ts < b,
        (Some(a), None) => a.abs_diff(ts) <= 60,
        _ => false,
    }
}

/// The day of `day`, then the next and the previous one, skipping any past
/// chrono's date range (`day ± 1 day` panics there; D10).
fn archive_days(day: chrono::NaiveDate) -> impl Iterator<Item = chrono::NaiveDate> {
    [Some(day), day.succ_opt(), day.pred_opt()]
        .into_iter()
        .flatten()
}

/// Furthest `stalker.epg` looks back with `from`.
const MAX_PAST_DAYS: i64 = 7;

/// Budget of the short EPG call in `stalker.epg`. A portal that gives no
/// answer within it fails the call with the slow-portal message.
pub const EPG_DEADLINE: std::time::Duration = std::time::Duration::from_secs(20);
/// Overall budget of `stalker.epg` with `from`. The day tables read after
/// the short EPG stop here; the call then returns what it has.
pub const EPG_PAST_DEADLINE: std::time::Duration = std::time::Duration::from_secs(40);
/// How long a bulk `get_epg_info` answer is fresh for a source. Past it the
/// next row starts a refresh and still answers from the old guide (R5-2:
/// was 5 min, which refetched and reparsed the whole portal's guide every
/// 5 minutes of browsing). The answer spans 6 h and the read drops what has
/// ended, so a portal-side change shows up at most this late.
const BULK_EPG_TTL: std::time::Duration = std::time::Duration::from_secs(30 * 60);
/// How long a failed bulk `get_epg_info` is remembered before it is asked
/// again.
const BULK_EPG_RETRY: std::time::Duration = std::time::Duration::from_secs(60);
/// Longest a row whose short EPG answered empty waits for the bulk guide.
/// The fetch itself carries on in the background and fills the cache.
const BULK_EPG_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
/// A bulk guide no row asked for in this long is dropped (R5-2): it used to
/// stay resident for the rest of the session once fetched.
const BULK_EPG_IDLE: std::time::Duration =
    std::time::Duration::from_secs(BULK_EPG_TTL.as_secs() + 5 * 60);

/// One bulk `get_epg_info` answer, indexed by channel id. Each channel's
/// programmes are mapped once, on the blocking pool, with an empty channel
/// id that the read fills in (R5-2). The portal's JSON tree is not kept:
/// for a 10k-channel guide it was on the order of 100 MB.
#[derive(Debug)]
pub struct BulkEpg {
    by_channel: HashMap<String, Arc<[EpgProgram]>>,
    ok: bool,
    at: tokio::time::Instant,
}

type BulkEpgFuture = Shared<BoxFuture<'static, Arc<BulkEpg>>>;

/// The bulk guide of one source, fetched once and shared by every
/// `stalker.epg` call (single flight) until it expires. The fetch runs as
/// its own task, so a caller that stops waiting does not cancel it.
#[derive(Clone)]
pub struct BulkEpgEntry {
    fut: BulkEpgFuture,
    /// The last good answer, served while `fut` replaces it.
    stale: Option<Arc<BulkEpg>>,
    /// When a row last asked, in ms after `born`; also the entry's
    /// identity for [`sweep_when_idle`].
    used: Arc<AtomicU64>,
    born: tokio::time::Instant,
}

/// What a row gets from its source's bulk guide.
enum BulkAnswer {
    /// An answer to use now.
    Ready(Arc<BulkEpg>),
    /// Nothing usable yet: the fetch in flight, waited for at most
    /// [`BULK_EPG_WAIT`].
    Pending(BulkEpgFuture),
}

impl BulkEpgEntry {
    fn start(client: &StalkerClient, stale: Option<Arc<BulkEpg>>) -> Self {
        let client = client.clone();
        let task = tokio::spawn(async move {
            let req = Req::new("itv", "get_epg_info")
                .p("period", 6)
                .timeout(LONG_TIMEOUT);
            let (by_channel, ok) = match client.call(req).await {
                // `data` is taken out of the answer, not cloned (IN-1), and
                // mapped off the runtime worker.
                Ok(js) => {
                    match tokio::task::spawn_blocking(move || index_bulk(take_data(js))).await {
                        Ok(index) => (index, true),
                        Err(err) => {
                            tracing::debug!(error = %err, "stalker bulk EPG could not be read");
                            (HashMap::new(), false)
                        }
                    }
                }
                Err(err) => {
                    tracing::debug!(error = %err, "stalker bulk EPG failed");
                    (HashMap::new(), false)
                }
            };
            Arc::new(BulkEpg {
                by_channel,
                ok,
                at: tokio::time::Instant::now(),
            })
        });
        let fut = async move {
            task.await.unwrap_or_else(|_| {
                Arc::new(BulkEpg {
                    by_channel: HashMap::new(),
                    ok: false,
                    at: tokio::time::Instant::now(),
                })
            })
        }
        .boxed()
        .shared();
        Self::new(fut, stale)
    }

    fn new(fut: BulkEpgFuture, stale: Option<Arc<BulkEpg>>) -> Self {
        Self {
            fut,
            stale,
            used: Arc::new(AtomicU64::new(0)),
            born: tokio::time::Instant::now(),
        }
    }

    fn expired(&self) -> bool {
        match self.fut.peek() {
            Some(b) => b.at.elapsed() >= if b.ok { BULK_EPG_TTL } else { BULK_EPG_RETRY },
            None => false,
        }
    }

    /// The good answer to keep serving while a refresh runs: this entry's
    /// own when it has one, else the one it was serving.
    fn usable(&self) -> Option<Arc<BulkEpg>> {
        match self.fut.peek() {
            Some(b) if b.ok => Some(b.clone()),
            _ => self.stale.clone(),
        }
    }

    /// Stale-while-revalidate (R5-2): a good answer, expired or not, at
    /// once; a row waits only when nothing usable is cached. A failed fetch
    /// with no older answer gives its empty one until [`BULK_EPG_RETRY`].
    fn answer(&self) -> BulkAnswer {
        match (self.usable(), self.fut.peek()) {
            (Some(good), _) => BulkAnswer::Ready(good),
            (None, Some(failed)) => BulkAnswer::Ready(failed.clone()),
            (None, None) => BulkAnswer::Pending(self.fut.clone()),
        }
    }

    fn touch(&self) {
        self.used
            .store(self.born.elapsed().as_millis() as u64, Ordering::Relaxed);
    }

    fn idle(&self) -> std::time::Duration {
        let used = std::time::Duration::from_millis(self.used.load(Ordering::Relaxed));
        self.born.elapsed().saturating_sub(used)
    }
}

/// Maps the bulk answer's `data` (programmes keyed by channel id) with the
/// same [`mapping::epg_program`] the rows used to run at read time, so the
/// output is identical; channels without programmes are left out.
fn index_bulk(data: Value) -> HashMap<String, Arc<[EpgProgram]>> {
    let Value::Object(by_channel) = data else {
        return HashMap::new();
    };
    by_channel
        .into_iter()
        .filter_map(|(id, list)| {
            let Value::Array(list) = list else {
                return None;
            };
            let programs: Vec<EpgProgram> = list
                .iter()
                .filter_map(|v| mapping::epg_program("", v))
                .collect();
            (!programs.is_empty()).then(|| (id, programs.into()))
        })
        .collect()
}

/// Drops the source's bulk guide once no row has asked for it in
/// [`BULK_EPG_IDLE`], unless a newer entry replaced it (that one has its own
/// sweeper).
fn sweep_when_idle(rt: std::sync::Weak<super::Runtime>, source_id: String, used: Arc<AtomicU64>) {
    tokio::spawn(async move {
        let mut wait = BULK_EPG_IDLE;
        loop {
            tokio::time::sleep(wait).await;
            let Some(rt) = rt.upgrade() else { return };
            let mine = |e: &BulkEpgEntry| Arc::ptr_eq(&e.used, &used);
            let removed = rt
                .bulk_epg
                .remove_if(&source_id, |_, e| mine(e) && e.idle() >= BULK_EPG_IDLE);
            if removed.is_some() {
                return;
            }
            // Still this entry, used since: look again once it may be idle.
            let next = rt
                .bulk_epg
                .get(&source_id)
                .filter(|e| mine(e))
                .map(|e| BULK_EPG_IDLE.saturating_sub(e.idle()));
            match next {
                Some(left) => wait = left.max(std::time::Duration::from_secs(1)),
                None => return,
            }
        }
    });
}

/// The answer's `data` member, or the answer itself when it has none.
fn take_data(js: Value) -> Value {
    match js {
        Value::Object(mut m) => match m.remove("data") {
            Some(data) => data,
            None => Value::Object(m),
        },
        other => other,
    }
}

/// The source's bulk guide: the cached answer (an expired one starts its
/// refresh and is still served), the fetch in flight, or a new fetch.
fn bulk_epg(state: &AppState, client: &StalkerClient, source_id: &str) -> BulkAnswer {
    let rt = super::Runtime::get(state);
    let mut fresh = false;
    let (answer, used) = {
        let mut entry = rt.bulk_epg.entry(source_id.to_string()).or_insert_with(|| {
            fresh = true;
            BulkEpgEntry::start(client, None)
        });
        if entry.expired() {
            let stale = entry.usable();
            *entry = BulkEpgEntry::start(client, stale);
            fresh = true;
        }
        entry.touch();
        (entry.answer(), entry.used.clone())
    };
    if fresh {
        sweep_when_idle(Arc::downgrade(&rt), source_id.to_string(), used);
    }
    answer
}

/// The day tables [`past_programmes`] reads: the UTC dates from `from`
/// (at most [`MAX_PAST_DAYS`] back) through the day after `now`, or after
/// the last second before `to` when that is earlier, each once. The tables
/// follow the portal's timezone (Europe/Paris), not UTC, so the programmes
/// after local midnight sit in the next UTC date's table.
fn past_days(from: DateTime<Utc>, to: Option<DateTime<Utc>>, now: DateTime<Utc>) -> Vec<NaiveDate> {
    if to.is_some_and(|t| t <= from) {
        return Vec::new();
    }
    let first = from.max(now - Duration::days(MAX_PAST_DAYS)).date_naive();
    let end = match to.filter(|t| *t < now) {
        Some(t) => (t - Duration::seconds(1)).date_naive(),
        None => now.date_naive(),
    };
    let Some(last) = end.succ_opt() else {
        return Vec::new();
    };
    first.iter_days().take_while(|d| *d <= last).collect()
}

/// The day tables of `days`, read through the cache into `out` as each
/// completes (three at a time), so a caller that stops waiting keeps the
/// finished days.
async fn past_programmes(
    state: &AppState,
    client: &StalkerClient,
    source_id: &str,
    channel_id: &str,
    days: Vec<NaiveDate>,
    out: &mut Vec<Arc<DayTable>>,
) -> CoreResult<()> {
    let mut tables = stream::iter(days)
        .map(|d| cached_day_table(state, client, source_id, channel_id, d))
        .buffer_unordered(3);
    while let Some(t) = tables.next().await {
        out.push(t?);
    }
    Ok(())
}

/// `stalker.epg`: short EPG, falling back to the source's bulk
/// `get_epg_info` (cached per source) when the portal answers without
/// programmes. With `from`, the archived programmes since `from` (day
/// tables, at most [`MAX_PAST_DAYS`] back) come first, and with `to` only
/// those starting before it (and only the day tables up to it are read);
/// `limit` caps the airing and upcoming ones.
///
/// Only the short EPG decides whether the portal is answering: no answer
/// within [`EPG_DEADLINE`] fails the call with its own message. The bulk
/// guide is waited for at most [`BULK_EPG_WAIT`] and the day tables until
/// [`EPG_PAST_DEADLINE`]; past those the call returns what it has.
pub async fn epg(
    state: &Arc<AppState>,
    r: &ItemRef,
    limit: Option<i64>,
    from: Option<&str>,
    to: Option<&str>,
) -> CoreResult<Vec<EpgProgram>> {
    if !matches!(r.content_type, ContentType::Live | ContentType::Radio) {
        return Err(CoreError::invalid("EPG is only available for channels"));
    }
    let started = tokio::time::Instant::now();
    let limit = limit.unwrap_or(10).clamp(1, 50);
    let from = rfc3339_arg(from, "from")?;
    let to = rfc3339_arg(to, "to")?;
    let client = StalkerClient::for_source(state, &r.source_id).await?;
    let from = from.filter(|f| *f < Utc::now());
    portal_epg(state, &client, r, limit, from, to, started).await
}

/// An optional RFC 3339 argument; blank counts as absent.
fn rfc3339_arg(v: Option<&str>, name: &str) -> CoreResult<Option<DateTime<Utc>>> {
    match v.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => Ok(Some(
            DateTime::parse_from_rfc3339(v)
                .map_err(|_| CoreError::invalid(format!("{name} must be an RFC 3339 timestamp")))?
                .with_timezone(&Utc),
        )),
        None => Ok(None),
    }
}

/// The body of [`epg`].
async fn portal_epg(
    state: &Arc<AppState>,
    client: &StalkerClient,
    r: &ItemRef,
    limit: i64,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
    started: tokio::time::Instant,
) -> CoreResult<Vec<EpgProgram>> {
    let row = catalog_row(state, r).await.ok();
    let channel_id = row
        .as_ref()
        .and_then(|r| r.epg_channel_id.clone())
        .unwrap_or_else(|| r.item_id.clone());
    // The channel's guide shift moves the portal's programmes (the bulk
    // cache keeps them as the portal sent them) before the times pick.
    let shift = crate::epg::channel_shift(state, r).await?;

    // The day tables are read alongside the short EPG, not after it (R5-1:
    // the ribbon got nothing until both had answered). A positive shift
    // shows programmes that ended before `from` on the portal's clock, so
    // the tables start that much earlier; a negative one shows programmes
    // that start after `to` there, so they end that much later.
    let days = match from {
        Some(from_at) => {
            let read_from = from_at - Duration::seconds(shift.max(0));
            let later = Duration::seconds(shift.saturating_neg().max(0));
            let read_to = to.map(|t| t.checked_add_signed(later).unwrap_or(t));
            past_days(read_from, read_to, Utc::now())
        }
        None => Vec::new(),
    };
    let mut past: Vec<Arc<DayTable>> = Vec::new();
    let past_read = async {
        let read = past_programmes(state, client, &r.source_id, &r.item_id, days, &mut past);
        Ok(tokio::time::timeout_at(started + EPG_PAST_DEADLINE, read).await)
    };
    // A short EPG that fails ends the call with its own error at once; the
    // day-table read is dropped (the reads it started still fill the cache).
    let (upcoming, past_read) = tokio::try_join!(
        upcoming_programmes(state, client, r, &channel_id, limit, started),
        past_read
    )?;
    match past_read {
        Ok(Ok(())) => {}
        Ok(Err(err @ CoreError::Auth(_))) => return Err(err),
        // The short EPG answered: keep it and the days read so far.
        Ok(Err(err)) => {
            tracing::debug!(source_id = %r.source_id, error = %err, "stalker archive EPG failed");
        }
        Err(_) => {
            tracing::debug!(
                source_id = %r.source_id,
                days = past.len(),
                "stalker archive EPG ran out of time; returning the days read so far"
            );
        }
    }

    let now_at = Utc::now();
    let now = now_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut programs: Vec<EpgProgram> = upcoming
        .into_iter()
        .map(|p| crate::epg::shifted(p, shift))
        .filter(|p| p.end > now || p.end == p.start)
        .collect();
    programs.sort_by(|a, b| a.start.cmp(&b.start));
    programs.dedup_by(|a, b| a.start == b.start);
    programs.truncate(limit as usize);

    if let Some(from_at) = from.filter(|f| *f < now_at) {
        let from_s = from_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let to_s = to.map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        let earliest_upcoming = programs.first().map(|p| p.start.clone());
        programs.extend(
            past.iter()
                .flat_map(|t| t.rows.iter())
                .filter_map(|v| mapping::epg_program(&channel_id, v))
                .map(|p| crate::epg::shifted(p, shift))
                .filter(|p| p.end > from_s && p.end > p.start)
                .filter(|p| to_s.as_ref().is_none_or(|t| p.start < *t))
                // Past only: the short EPG owns the airing and upcoming part.
                .filter(|p| earliest_upcoming.as_ref().is_none_or(|e| p.start < *e))
                .filter(|p| p.start < now),
        );
        programs.sort_by(|a, b| a.start.cmp(&b.start));
        programs.dedup_by(|a, b| a.start == b.start);
    }
    Ok(programs)
}

/// The airing and upcoming programmes, not yet shifted: the short EPG, or
/// the source's bulk guide when the portal answers without programmes. A
/// portal that does not answer, or refuses the session, fails the call.
async fn upcoming_programmes(
    state: &AppState,
    client: &StalkerClient,
    r: &ItemRef,
    channel_id: &str,
    limit: i64,
    started: tokio::time::Instant,
) -> CoreResult<Vec<EpgProgram>> {
    let short_req = Req::new("itv", "get_short_epg")
        .p("ch_id", &r.item_id)
        .p("size", limit);
    let short = match tokio::time::timeout_at(started + EPG_DEADLINE, client.call(short_req)).await
    {
        Ok(res) => res,
        Err(_) => {
            tracing::debug!(source_id = %r.source_id, "stalker short EPG ran out of time");
            return Err(session::slow_error(&client.config.portal_url));
        }
    };
    let entries = match short {
        Ok(js) => into_list(js),
        Err(err @ CoreError::Auth(_)) => return Err(err),
        // Silent or unreachable portal: the bulk call would only wait longer.
        Err(err) if no_answer(&err) => return Err(err),
        Err(_) => Vec::new(),
    };
    let mut upcoming: Vec<EpgProgram> = entries
        .iter()
        .filter_map(|v| mapping::epg_program(channel_id, v))
        .collect();
    if entries.is_empty() {
        // The portal answered: whatever the bulk guide does, this row gets
        // its (possibly empty) programmes, never an error.
        let bulk = match bulk_epg(state, client, &r.source_id) {
            BulkAnswer::Ready(bulk) => Some(bulk),
            BulkAnswer::Pending(fetch) => match tokio::time::timeout(BULK_EPG_WAIT, fetch).await {
                Ok(bulk) => Some(bulk),
                Err(_) => {
                    tracing::debug!(source_id = %r.source_id, "stalker bulk EPG still loading");
                    None
                }
            },
        };
        if let Some(list) = bulk.as_ref().and_then(|b| b.by_channel.get(&r.item_id)) {
            upcoming = list
                .iter()
                .map(|p| EpgProgram {
                    channel_id: channel_id.to_string(),
                    ..p.clone()
                })
                .collect();
        }
    }
    Ok(upcoming)
}

fn scrub(v: Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.into_iter()
                .filter(|(k, _)| {
                    let k = k.to_ascii_lowercase();
                    !(k.contains("password")
                        || k.contains("token")
                        || k == "mac"
                        || k.contains("signature")
                        || k.starts_with("device_id"))
                })
                .map(|(k, v)| (k, scrub(v)))
                .collect::<Map<String, Value>>(),
        ),
        // A list of devices or sessions carries the same fields.
        Value::Array(items) => Value::Array(items.into_iter().map(scrub).collect()),
        other => other,
    }
}

fn first_text(sources: &[&Value], keys: &[&str]) -> Option<String> {
    sources
        .iter()
        .find_map(|v| keys.iter().find_map(|k| s(v, k)))
}

/// `stalker.accountInfo`.
pub async fn account_info(
    state: &Arc<AppState>,
    source_id: &str,
) -> CoreResult<StalkerAccountInfo> {
    let client = StalkerClient::for_source(state, source_id).await?;
    client.ensure_session().await?;
    let profile = match client.cached_profile().await {
        Some(p) => p,
        None => client
            .call(profile_request(&client))
            .await
            .unwrap_or(Value::Null),
    };
    let main = match client.call(Req::new("account_info", "get_main_info")).await {
        Ok(v) => v,
        Err(err @ CoreError::Auth(_)) => return Err(err),
        Err(_) => Value::Null,
    };
    let profile_account = profile.get("account_info").cloned().unwrap_or(Value::Null);
    let sources = [&main, &profile_account, &profile];
    let exp_raw = first_text(
        &sources,
        &[
            "expire_billing_date",
            "expire_date",
            "end_date",
            "tariff_expired_date",
        ],
    );
    let exp_date = exp_raw.map(|d| p::date_to_rfc3339(&Value::String(d.clone())).unwrap_or(d));
    let tariff = first_text(&sources, &["tariff_plan_name", "tariff_plan"]);
    let status = match first_text(&[&main, &profile_account], &["status"]) {
        Some(st) => Some(st),
        None => profile.get("status").and_then(p::int_of).map(|n| {
            if n == 0 {
                "active".to_string()
            } else {
                format!("blocked ({n})")
            }
        }),
    };
    Ok(StalkerAccountInfo {
        mac: client.mac().to_string(),
        status,
        exp_date,
        tariff,
        raw: json!({"profile": scrub(profile), "mainInfo": scrub(main)}),
    })
}

fn profile_request(client: &StalkerClient) -> Req {
    let mut req = Req::new("stb", "get_profile");
    for (k, v) in p::STB_PROFILE_PARAMS {
        req = req.p(k, v);
    }
    req.p("not_valid_token", 0)
        .p("auth_second_step", 0)
        .p("prehash", p::prehash(client.mac()))
}

/// `stalker.test`: connects with an unsaved config; never errors.
pub async fn test(state: &Arc<AppState>, config: StalkerSourceConfig) -> ConnectionTestResult {
    if let Err(err) = session::validate_config(&config) {
        return ConnectionTestResult {
            ok: false,
            message: Some(user_message(&err)),
            name: None,
        };
    }
    // A typed MAC is tested the way `sources.add` will store it.
    let mut config = config;
    if let Some(mac) = p::normalize_mac(&config.mac_address) {
        config.mac_address = mac;
    }
    let client = match StalkerClient::ephemeral(state, config) {
        Ok(c) => c,
        Err(err) => {
            return ConnectionTestResult {
                ok: false,
                message: Some(user_message(&err)),
                name: None,
            }
        }
    };
    let outcome = async {
        client.ensure_session().await?;
        let genres = into_list(client.call(Req::new("itv", "get_genres")).await?);
        let profile = client.cached_profile().await;
        Ok::<_, CoreError>((
            genres
                .iter()
                .filter(|g| s(g, "id").as_deref() != Some("*"))
                .count(),
            profile,
        ))
    }
    .await;
    match outcome {
        Ok((count, profile)) => {
            let name = profile
                .as_ref()
                .and_then(|p| s(p, "name").or_else(|| s(p, "fname")))
                .filter(|n| !n.contains(':'));
            ConnectionTestResult {
                ok: true,
                message: Some(format!(
                    "Connected. The portal lists {count} channel categories."
                )),
                name,
            }
        }
        Err(err) => ConnectionTestResult {
            ok: false,
            message: Some(user_message(&err)),
            name: None,
        },
    }
}

/// Error text for the UI, without the `kind:` prefix of `CoreError`'s Display.
pub fn user_message(err: &CoreError) -> String {
    match err {
        CoreError::NotFound(m)
        | CoreError::Invalid(m)
        | CoreError::Network(m)
        | CoreError::Auth(m)
        | CoreError::Timeout(m)
        | CoreError::Conflict(m)
        | CoreError::Unsupported(m) => m.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GPT review (stalker-raw-array-credentials): arrays were returned as
    /// they were, so a token or MAC inside a list reached
    /// `stalker.accountInfo.raw`.
    #[test]
    fn scrub_reaches_into_arrays() {
        let raw = json!({
            "devices": [{"mac": "00:1A:79:00:00:01", "name": "Box", "token": "t"}],
            "sessions": [[{"auth_token": "a", "ok": 1}], "kept"],
            "password": "p"
        });
        let want = json!({
            "devices": [{"name": "Box"}],
            "sessions": [[{"ok": 1}], "kept"]
        });
        assert_eq!(scrub(raw), want);
    }

    /// IN-1: the bulk guide's `data` is moved out, with the same results as
    /// the clone it replaced.
    #[test]
    fn take_data_moves_the_data_member() {
        let data = json!({"7": [{"name": "News"}]});
        assert_eq!(take_data(json!({ "data": data.clone() })), data);
        assert_eq!(take_data(json!({"x": 1})), json!({"x": 1}));
        assert_eq!(take_data(json!({ "data": null })), Value::Null);
        assert_eq!(take_data(json!([1])), json!([1]));
    }

    /// R5-2: the bulk guide is mapped once into an index instead of being
    /// kept as the portal's JSON tree. A row reads exactly what the old
    /// read-time mapping of that channel's array gave: the 'Untitled'
    /// fallback, a duration-based end, a swapped stop, markup stripped.
    #[test]
    fn bulk_index_reads_like_the_raw_guide() {
        let data = json!({
            "7": [
                {"name": "News", "descr": "<b>Daily</b>  news", "category": "News",
                 "start_timestamp": 1_700_000_000, "stop_timestamp": "1700003600"},
                {"start_timestamp": 1_700_003_600, "duration": 1800},
                {"name": "Swapped", "start_timestamp": 1_700_010_000, "stop_timestamp": 1000},
                {"name": "No time"},
                {"title": "By time", "time": "2023-11-15 01:00:00", "time_to": "2023-11-15 02:00:00"}
            ],
            "8": [],
            "9": {"not": "a list"},
            "10": [{"name": "No time either"}]
        });
        let raw_read = |ch: &str| -> Vec<EpgProgram> {
            match data.get(ch) {
                Some(Value::Array(a)) => a
                    .iter()
                    .filter_map(|v| mapping::epg_program("one.uk", v))
                    .collect(),
                _ => Vec::new(),
            }
        };
        let index = index_bulk(take_data(json!({ "data": data.clone() })));
        for ch in ["7", "8", "9", "10", "11"] {
            let read: Vec<EpgProgram> = index
                .get(ch)
                .map(|list| {
                    list.iter()
                        .map(|p| EpgProgram {
                            channel_id: "one.uk".into(),
                            ..p.clone()
                        })
                        .collect()
                })
                .unwrap_or_default();
            assert_eq!(read, raw_read(ch), "channel {ch}");
        }
        assert_eq!(index.len(), 1, "only channels with programmes");
        assert_eq!(index["7"].len(), 4);
        assert_eq!(index["7"][1].title, "Untitled");
        assert!(index_bulk(json!([1])).is_empty());
    }

    fn bulk_answer(ok: bool) -> Arc<BulkEpg> {
        Arc::new(BulkEpg {
            by_channel: HashMap::new(),
            ok,
            at: tokio::time::Instant::now(),
        })
    }

    /// An entry whose fetch has finished with `answer`, or is still out.
    fn bulk_entry(answer: Option<Arc<BulkEpg>>, stale: Option<Arc<BulkEpg>>) -> BulkEpgEntry {
        let fut = match answer {
            Some(b) => futures::future::ready(b).boxed().shared(),
            None => futures::future::pending().boxed().shared(),
        };
        let _ = fut.clone().now_or_never();
        BulkEpgEntry::new(fut, stale)
    }

    fn ready(a: BulkAnswer) -> Option<Arc<BulkEpg>> {
        match a {
            BulkAnswer::Ready(b) => Some(b),
            BulkAnswer::Pending(_) => None,
        }
    }

    /// R5-2: an expired good guide is still served while its refresh runs
    /// (rows used to wait up to 10 s for the refetch every 5 minutes, and
    /// got nothing past that); a row waits only when nothing usable is
    /// cached.
    #[tokio::test(start_paused = true)]
    async fn bulk_guide_is_served_while_it_refreshes() {
        let good = bulk_answer(true);
        let fresh = bulk_entry(Some(good.clone()), None);
        assert!(!fresh.expired());
        tokio::time::advance(BULK_EPG_TTL).await;
        assert!(fresh.expired());
        // The refresh: in flight, then failed, the old answer still serves.
        let refreshing = bulk_entry(None, fresh.usable());
        assert!(!refreshing.expired());
        assert!(Arc::ptr_eq(&ready(refreshing.answer()).unwrap(), &good));
        let failed = bulk_entry(Some(bulk_answer(false)), refreshing.usable());
        assert!(Arc::ptr_eq(&ready(failed.answer()).unwrap(), &good));
        // A failed fetch is asked again after BULK_EPG_RETRY, keeping the
        // good answer for the next refresh.
        tokio::time::advance(BULK_EPG_RETRY).await;
        assert!(failed.expired());
        assert!(Arc::ptr_eq(&failed.usable().unwrap(), &good));

        // Nothing cached: the first fetch is waited for; a failed one gives
        // its empty answer until it is retried.
        assert!(ready(bulk_entry(None, None).answer()).is_none());
        let empty = ready(bulk_entry(Some(bulk_answer(false)), None).answer()).unwrap();
        assert!(!empty.ok);
    }

    /// R5-2: the guide stayed resident for the session once fetched. An
    /// entry no row asked for in BULK_EPG_IDLE is dropped; a used one, or
    /// one a newer entry replaced, is not dropped by this sweeper.
    #[tokio::test(start_paused = true)]
    async fn an_idle_bulk_guide_is_dropped() {
        let rt = Arc::new(super::super::Runtime::default());
        let entry = bulk_entry(Some(bulk_answer(true)), None);
        let used = entry.used.clone();
        rt.bulk_epg.insert("s1".into(), entry);
        sweep_when_idle(Arc::downgrade(&rt), "s1".into(), used);
        let minutes = |m: u64| std::time::Duration::from_secs(m * 60);

        tokio::time::sleep(minutes(20)).await;
        rt.bulk_epg.get("s1").unwrap().touch();
        tokio::time::sleep(minutes(20)).await;
        assert!(rt.bulk_epg.contains_key("s1"), "used 20 minutes ago");
        tokio::time::sleep(minutes(16)).await;
        assert!(!rt.bulk_epg.contains_key("s1"), "idle for 36 minutes");

        // A replaced entry's sweeper leaves the new one alone.
        let old = bulk_entry(Some(bulk_answer(true)), None);
        let old_used = old.used.clone();
        rt.bulk_epg.insert("s2".into(), old);
        sweep_when_idle(Arc::downgrade(&rt), "s2".into(), old_used);
        rt.bulk_epg
            .insert("s2".into(), bulk_entry(Some(bulk_answer(true)), None));
        tokio::time::sleep(minutes(40)).await;
        assert!(rt.bulk_epg.contains_key("s2"));
    }

    /// D10: `(a - ts).abs()` overflowed on a hostile start timestamp, and
    /// `day ± 1 day` panicked at chrono's date range edge.
    #[test]
    fn archive_lookup_survives_hostile_data() {
        let ts = 1_800_000_000;
        let row = |v: Value| archive_row_matches(&v, ts);
        assert!(row(serde_json::json!({"start_timestamp": ts + 30})));
        assert!(row(
            serde_json::json!({"start_timestamp": ts - 600, "stop_timestamp": ts + 600})
        ));
        assert!(!row(
            serde_json::json!({"start_timestamp": ts + 600, "stop_timestamp": ts + 900})
        ));
        assert!(!row(serde_json::json!({"start_timestamp": i64::MIN})));
        assert!(!row(serde_json::json!({"start_timestamp": i64::MAX})));
        assert!(!row(
            serde_json::json!({"start_timestamp": i64::MIN, "stop_timestamp": i64::MIN})
        ));
        assert!(!archive_row_matches(
            &serde_json::json!({"start_timestamp": i64::MAX, "stop_timestamp": i64::MAX}),
            i64::MAX
        ));
        assert!(archive_row_matches(
            &serde_json::json!({"start_timestamp": i64::MIN, "stop_timestamp": i64::MAX}),
            i64::MAX - 1
        ));

        let day = NaiveDate::from_ymd_opt(2026, 10, 12).unwrap();
        assert_eq!(
            archive_days(day).collect::<Vec<_>>(),
            vec![day, day.succ_opt().unwrap(), day.pred_opt().unwrap()]
        );
        assert_eq!(archive_days(NaiveDate::MAX).count(), 2);
        assert_eq!(archive_days(NaiveDate::MIN).count(), 2);
    }

    #[test]
    fn past_days_include_the_next_utc_date() {
        let d = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let at = |s: &str| DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc);
        // 22:30 UTC is already the next day in Paris: that table is read too.
        let now = at("2026-10-11T22:30:00Z");
        assert_eq!(
            past_days(at("2026-10-11T18:00:00Z"), None, now),
            vec![d("2026-10-11"), d("2026-10-12")]
        );
        assert_eq!(
            past_days(at("2026-10-10T23:00:00Z"), None, now),
            vec![d("2026-10-10"), d("2026-10-11"), d("2026-10-12")]
        );
        // Capped at MAX_PAST_DAYS back, each date once.
        let days = past_days(at("2026-09-01T00:00:00Z"), None, now);
        assert_eq!(days.first(), Some(&d("2026-10-04")));
        assert_eq!(days.last(), Some(&d("2026-10-12")));
        assert_eq!(days.len(), 9);
        // A `to` at or after now reads as far as without one.
        assert_eq!(past_days(at("2026-09-01T00:00:00Z"), Some(now), now), days);
    }

    /// R5-1: the archive day view asked `from` = its day's start with no
    /// end, so day -k read k + 2 tables to show one. With `to`, the tables
    /// end at the date after its last second.
    #[test]
    fn past_days_stop_after_to() {
        let d = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let at = |s: &str| DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc);
        let now = at("2026-10-11T22:30:00Z");
        // A UTC day three days back: its table and the next one.
        assert_eq!(
            past_days(
                at("2026-10-08T00:00:00Z"),
                Some(at("2026-10-09T00:00:00Z")),
                now
            ),
            vec![d("2026-10-08"), d("2026-10-09")]
        );
        // A local day (UTC+2): 22:00 UTC to 22:00 UTC.
        assert_eq!(
            past_days(
                at("2026-10-07T22:00:00Z"),
                Some(at("2026-10-08T22:00:00Z")),
                now
            ),
            vec![d("2026-10-07"), d("2026-10-08"), d("2026-10-09")]
        );
        // Empty windows, and windows before the archive reaches.
        assert!(past_days(
            at("2026-10-08T00:00:00Z"),
            Some(at("2026-10-08T00:00:00Z")),
            now
        )
        .is_empty());
        assert!(past_days(
            at("2026-10-08T00:00:00Z"),
            Some(at("2026-10-07T00:00:00Z")),
            now
        )
        .is_empty());
        assert!(past_days(
            at("2026-09-01T00:00:00Z"),
            Some(at("2026-09-02T00:00:00Z")),
            now
        )
        .is_empty());
    }

    /// R5-1: a cached day-table row keeps only the keys the guide and
    /// catch-up read, and reads exactly like the portal's row.
    #[test]
    fn trimmed_day_rows_read_like_the_portal_rows() {
        let rows = vec![
            json!({"id": "91", "ch_id": "7", "name": "News", "descr": "<b>Daily</b> news",
                   "category": "News", "start_timestamp": 1_700_000_000,
                   "stop_timestamp": "1700003600", "time": "2023-11-14 22:13:20",
                   "t_time": "22:13", "mark_archive": 1, "open": 1, "on_date": "Tue"}),
            json!({"id": 92, "start_timestamp": 1_700_003_600, "duration": 1800}),
            json!({"id": "93", "title": "By time", "start": "2023-11-15 01:00:00",
                   "end": "2023-11-15 02:00:00", "description": "Plain"}),
            json!({"name": "Swapped", "start_timestamp": 1_700_010_000, "stop_timestamp": 1000}),
            json!({"name": "Clock only", "time": "2023-11-15 03:00:00", "time_to": "2023-11-15 04:00:00"}),
            json!("not an object"),
        ];
        for v in rows {
            let t = trim_day_row(v.clone());
            assert_eq!(
                mapping::epg_program("one.uk", &t),
                mapping::epg_program("one.uk", &v)
            );
            for ts in [1_700_000_000, 1_700_000_030, 1_700_003_600, 1_700_010_000] {
                assert_eq!(archive_row_matches(&t, ts), archive_row_matches(&v, ts));
            }
            assert_eq!(s(&t, "id"), s(&v, "id"));
            assert_eq!(n(&t, "start_timestamp"), n(&v, "start_timestamp"));
            assert_eq!(s(&t, "name"), s(&v, "name"));
        }
        let t = trim_day_row(json!({"id": "1", "mark_archive": 1, "t_time": "x"}));
        assert_eq!(t, json!({"id": "1"}));
    }

    fn day_entry(rows: usize, ttl: std::time::Duration) -> DayTableEntry {
        let table = Arc::new(DayTable {
            rows: vec![json!({}); rows],
            kind: Some("epg"),
            at: tokio::time::Instant::now(),
            ttl,
        });
        let fut = futures::future::ready(Ok(table)).boxed().shared();
        let _ = fut.clone().now_or_never();
        DayTableEntry {
            fut,
            started: tokio::time::Instant::now(),
        }
    }

    /// R5-1: tables are reused until their TTL, a failed read never, the
    /// cache stays under its cap (stale entries first), and forgetting a
    /// source drops only its tables.
    #[tokio::test(start_paused = true)]
    async fn day_table_cache_expires_caps_and_forgets() {
        let near = day_entry(30, DAY_TABLE_TTL_NEAR);
        assert!(!near.stale());
        tokio::time::advance(DAY_TABLE_TTL_NEAR).await;
        assert!(near.stale());
        let failed: DayTableFuture =
            futures::future::ready(Err(Arc::new(CoreError::Timeout("slow".into()))))
                .boxed()
                .shared();
        let _ = failed.clone().now_or_never();
        let failed = DayTableEntry {
            fut: failed,
            started: tokio::time::Instant::now(),
        };
        assert!(failed.stale());
        let pending = DayTableEntry {
            fut: futures::future::pending().boxed().shared(),
            started: tokio::time::Instant::now(),
        };
        assert!(!pending.stale(), "a read in flight is shared");

        let tables = DayTables::default();
        tables.entries.insert("s1|7|old".into(), near);
        for i in 0..DAY_TABLE_CAP {
            tokio::time::advance(std::time::Duration::from_millis(1)).await;
            tables.entries.insert(
                format!("s2|{i}|2026-10-01"),
                day_entry(30, DAY_TABLE_TTL_PAST),
            );
        }
        tables.trim();
        assert_eq!(tables.len(), DAY_TABLE_CAP, "the stale entry went first");
        assert!(!tables.entries.contains_key("s1|7|old"));
        tables
            .entries
            .insert("s1|7|new".into(), day_entry(30, DAY_TABLE_TTL_PAST));
        tables.trim();
        assert_eq!(tables.len(), DAY_TABLE_CAP * 9 / 10);
        assert!(tables.entries.contains_key("s1|7|new"), "the newest stays");
        assert!(
            !tables.entries.contains_key("s2|0|2026-10-01"),
            "the oldest went"
        );

        tables.kinds.insert("s1".into(), "itv");
        tables.forget("s1");
        assert!(!tables.entries.contains_key("s1|7|new"));
        assert!(!tables.kinds.contains_key("s1"));
        assert_eq!(tables.len(), DAY_TABLE_CAP * 9 / 10 - 1);
    }

    #[test]
    fn archive_window_rejects_future_and_too_old_starts() {
        let now = Utc::now();
        assert!(check_archive_window(now - Duration::hours(2), now, 168).is_ok());
        let err = check_archive_window(now + Duration::minutes(5), now, 168).unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)));
        assert!(check_archive_window(now, now, 168).is_err());
        let err = check_archive_window(now - Duration::hours(200), now, 168).unwrap_err();
        assert_eq!(
            user_message(&err),
            "The portal keeps 7 days of archive for this channel; this programme is older."
        );
        let err = check_archive_window(now - Duration::hours(5), now, 3).unwrap_err();
        assert!(user_message(&err).contains("3 hours"), "{err}");
    }

    #[test]
    fn archive_window_survives_absurd_archive_hours() {
        // A stored row with a garbage duration used to panic in Duration::hours.
        let now = Utc::now();
        for hours in [i64::MAX, i64::MAX / 3600, 1 << 40] {
            assert!(check_archive_window(now - Duration::hours(2), now, hours).is_ok());
            let err = check_archive_window(now - Duration::days(400), now, hours).unwrap_err();
            assert!(user_message(&err).contains("366 days"), "{err}");
        }
    }
}
