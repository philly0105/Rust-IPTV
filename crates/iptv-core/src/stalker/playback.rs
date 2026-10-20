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
use futures::future::{BoxFuture, FutureExt, Shared};
use futures::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::{json, Map, Value};
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

    let program = find_archive_program(&client, &r.item_id, start_at)
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

/// Every row of one day's programme table (`get_simple_data_table`), or
/// `None` when the portal serves no table. Ministra serves it under `epg`;
/// some builds only under `itv`. Auth failures and a portal that does not
/// answer ([`no_answer`]) propagate.
async fn day_table(
    client: &StalkerClient,
    channel_id: &str,
    date: NaiveDate,
) -> CoreResult<Option<Vec<Value>>> {
    let date = date.format("%Y-%m-%d").to_string();
    for table_type in ["epg", "itv"] {
        let mut rows: Vec<Value> = Vec::new();
        for page in 1..=10 {
            let req = Req::new(table_type, "get_simple_data_table")
                .p("ch_id", channel_id)
                .p("date", &date)
                .p("p", page);
            let js = match client.call(req).await {
                Ok(js) => js,
                Err(err @ CoreError::Auth(_)) => return Err(err),
                Err(err) if no_answer(&err) => return Err(err),
                Err(_) => break,
            };
            let total = n(&js, "total_items");
            let got = into_list(js);
            if got.is_empty() {
                break;
            }
            let per = got.len() as i64;
            rows.extend(got);
            if total.is_none_or(|t| page * per >= t) {
                break;
            }
        }
        if !rows.is_empty() {
            return Ok(Some(rows));
        }
    }
    Ok(None)
}

/// The archived program airing at `start`. Ministra builds day tables in
/// the session's cookie timezone (Europe/Paris), not UTC, so a programme
/// late in the UTC day can sit in the next day's table: the adjacent days
/// are asked when the UTC day has no match.
async fn find_archive_program(
    client: &StalkerClient,
    channel_id: &str,
    start: DateTime<Utc>,
) -> CoreResult<Option<Value>> {
    let ts = start.timestamp();
    for date in archive_days(start.date_naive()) {
        if let Some(rows) = day_table(client, channel_id, date).await? {
            if let Some(hit) = rows.into_iter().find(|v| archive_row_matches(v, ts)) {
                return Ok(Some(hit));
            }
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
/// How long a bulk `get_epg_info` answer is reused for a source.
const BULK_EPG_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);
/// How long a failed bulk `get_epg_info` is remembered before it is asked
/// again.
const BULK_EPG_RETRY: std::time::Duration = std::time::Duration::from_secs(60);
/// Longest a row whose short EPG answered empty waits for the bulk guide.
/// The fetch itself carries on in the background and fills the cache.
const BULK_EPG_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// One bulk `get_epg_info` answer: programmes keyed by channel id.
#[derive(Debug)]
pub struct BulkEpg {
    by_channel: Map<String, Value>,
    ok: bool,
    at: std::time::Instant,
}

type BulkEpgFuture = Shared<BoxFuture<'static, Arc<BulkEpg>>>;

/// The bulk guide of one source, fetched once and shared by every
/// `stalker.epg` call (single flight) until it expires. The fetch runs as
/// its own task, so a caller that stops waiting does not cancel it.
#[derive(Clone)]
pub struct BulkEpgEntry {
    fut: BulkEpgFuture,
}

impl BulkEpgEntry {
    fn start(client: &StalkerClient) -> Self {
        let client = client.clone();
        let task = tokio::spawn(async move {
            let req = Req::new("itv", "get_epg_info")
                .p("period", 6)
                .timeout(LONG_TIMEOUT);
            let (by_channel, ok) = match client.call(req).await {
                // `data` is taken out of the answer, not cloned (IN-1).
                Ok(js) => match take_data(js) {
                    Value::Object(m) => (m, true),
                    _ => (Map::new(), true),
                },
                Err(err) => {
                    tracing::debug!(error = %err, "stalker bulk EPG failed");
                    (Map::new(), false)
                }
            };
            Arc::new(BulkEpg {
                by_channel,
                ok,
                at: std::time::Instant::now(),
            })
        });
        let fut = async move {
            task.await.unwrap_or_else(|_| {
                Arc::new(BulkEpg {
                    by_channel: Map::new(),
                    ok: false,
                    at: std::time::Instant::now(),
                })
            })
        }
        .boxed()
        .shared();
        Self { fut }
    }

    fn expired(&self) -> bool {
        match self.fut.peek() {
            Some(b) => b.at.elapsed() >= if b.ok { BULK_EPG_TTL } else { BULK_EPG_RETRY },
            None => false,
        }
    }
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

/// The source's bulk guide: the cached answer, the fetch in flight, or a
/// new fetch.
fn bulk_epg(state: &AppState, client: &StalkerClient, source_id: &str) -> BulkEpgFuture {
    let rt = super::Runtime::get(state);
    let mut entry = rt
        .bulk_epg
        .entry(source_id.to_string())
        .or_insert_with(|| BulkEpgEntry::start(client));
    if entry.expired() {
        *entry = BulkEpgEntry::start(client);
    }
    entry.fut.clone()
}

/// The day tables [`past_programmes`] reads: the UTC dates from `from`
/// (at most [`MAX_PAST_DAYS`] back) through the day after `now`, each once.
fn past_days(from: DateTime<Utc>, now: DateTime<Utc>) -> Vec<NaiveDate> {
    let first = from.max(now - Duration::days(MAX_PAST_DAYS)).date_naive();
    let last = now.date_naive() + Duration::days(1);
    first.iter_days().take_while(|d| *d <= last).collect()
}

/// Past programmes from `from` up to now, read from the day tables into
/// `out` as each table completes (three at a time), so a caller that stops
/// waiting keeps the finished days. The tables follow the portal's timezone
/// (Europe/Paris), not UTC, so the programmes after local midnight sit in
/// the next UTC date's table: that one is read too, and the caller drops
/// what has not started yet.
async fn past_programmes(
    client: &StalkerClient,
    channel_id: &str,
    from: DateTime<Utc>,
    now: DateTime<Utc>,
    out: &mut Vec<Value>,
) -> CoreResult<()> {
    let mut tables = stream::iter(past_days(from, now))
        .map(|d| day_table(client, channel_id, d))
        .buffer_unordered(3);
    while let Some(t) = tables.next().await {
        if let Some(rows) = t? {
            out.extend(rows);
        }
    }
    Ok(())
}

/// `stalker.epg`: short EPG, falling back to the source's bulk
/// `get_epg_info` (cached per source) when the portal answers without
/// programmes. With `from`, the archived programmes since `from` (day
/// tables, at most [`MAX_PAST_DAYS`] back) come first; `limit` caps the
/// airing and upcoming ones.
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
) -> CoreResult<Vec<EpgProgram>> {
    if !matches!(r.content_type, ContentType::Live | ContentType::Radio) {
        return Err(CoreError::invalid("EPG is only available for channels"));
    }
    let started = tokio::time::Instant::now();
    let limit = limit.unwrap_or(10).clamp(1, 50);
    let from = match from.map(str::trim).filter(|f| !f.is_empty()) {
        Some(f) => Some(
            DateTime::parse_from_rfc3339(f)
                .map_err(|_| CoreError::invalid("from must be an RFC 3339 timestamp"))?
                .with_timezone(&Utc),
        ),
        None => None,
    };
    let client = StalkerClient::for_source(state, &r.source_id).await?;
    let from = from.filter(|f| *f < Utc::now());
    portal_epg(state, &client, r, limit, from, started).await
}

/// The body of [`epg`].
async fn portal_epg(
    state: &Arc<AppState>,
    client: &StalkerClient,
    r: &ItemRef,
    limit: i64,
    from: Option<DateTime<Utc>>,
    started: tokio::time::Instant,
) -> CoreResult<Vec<EpgProgram>> {
    let row = catalog_row(state, r).await.ok();
    let channel_id = row
        .as_ref()
        .and_then(|r| r.epg_channel_id.clone())
        .unwrap_or_else(|| r.item_id.clone());

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
    let mut entries = match short {
        Ok(js) => into_list(js),
        Err(err @ CoreError::Auth(_)) => return Err(err),
        // Silent or unreachable portal: the bulk call would only wait longer.
        Err(err) if no_answer(&err) => return Err(err),
        Err(_) => Vec::new(),
    };
    if entries.is_empty() {
        // The portal answered: whatever the bulk guide does, this row gets
        // its (possibly empty) programmes, never an error.
        let bulk = bulk_epg(state, client, &r.source_id);
        match tokio::time::timeout(BULK_EPG_WAIT, bulk).await {
            Ok(bulk) => {
                if let Some(Value::Array(a)) = bulk.by_channel.get(&r.item_id) {
                    entries = a.clone();
                }
            }
            Err(_) => {
                tracing::debug!(source_id = %r.source_id, "stalker bulk EPG still loading");
            }
        }
    }
    let now_at = Utc::now();
    let now = now_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut programs: Vec<EpgProgram> = entries
        .iter()
        .filter_map(|v| mapping::epg_program(&channel_id, v))
        .filter(|p| p.end > now || p.end == p.start)
        .collect();
    programs.sort_by(|a, b| a.start.cmp(&b.start));
    programs.dedup_by(|a, b| a.start == b.start);
    programs.truncate(limit as usize);

    if let Some(from_at) = from.filter(|f| *f < now_at) {
        let from_s = from_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let mut past = Vec::new();
        let read = past_programmes(client, &r.item_id, from_at, now_at, &mut past);
        match tokio::time::timeout_at(started + EPG_PAST_DEADLINE, read).await {
            Ok(Ok(())) => {}
            Ok(Err(err @ CoreError::Auth(_))) => return Err(err),
            // The short EPG answered: keep it and the days read so far.
            Ok(Err(err)) => {
                tracing::debug!(source_id = %r.source_id, error = %err, "stalker archive EPG failed");
            }
            Err(_) => {
                tracing::debug!(
                    source_id = %r.source_id,
                    rows = past.len(),
                    "stalker archive EPG ran out of time; returning the days read so far"
                );
            }
        }
        let earliest_upcoming = programs.first().map(|p| p.start.clone());
        programs.extend(
            past.iter()
                .filter_map(|v| mapping::epg_program(&channel_id, v))
                .filter(|p| p.end > from_s && p.end > p.start)
                // Past only: the short EPG owns the airing and upcoming part.
                .filter(|p| earliest_upcoming.as_ref().is_none_or(|e| p.start < *e))
                .filter(|p| p.start < now),
        );
        programs.sort_by(|a, b| a.start.cmp(&b.start));
        programs.dedup_by(|a, b| a.start == b.start);
    }
    Ok(programs)
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
            past_days(at("2026-10-11T18:00:00Z"), now),
            vec![d("2026-10-11"), d("2026-10-12")]
        );
        assert_eq!(
            past_days(at("2026-10-10T23:00:00Z"), now),
            vec![d("2026-10-10"), d("2026-10-11"), d("2026-10-12")]
        );
        // Capped at MAX_PAST_DAYS back, each date once.
        let days = past_days(at("2026-09-01T00:00:00Z"), now);
        assert_eq!(days.first(), Some(&d("2026-10-04")));
        assert_eq!(days.last(), Some(&d("2026-10-12")));
        assert_eq!(days.len(), 9);
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
