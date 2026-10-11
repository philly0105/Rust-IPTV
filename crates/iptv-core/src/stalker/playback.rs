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
            let series_title = cached_title(state, r);
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

fn cached_title(state: &AppState, r: &ItemRef) -> Option<String> {
    let rt = super::Runtime::get(state);
    let hit = rt.items.get(&r.key())?;
    s(&hit.raw, "name").or_else(|| s(&hit.raw, "o_name"))
}

/// `stalker.catchupUrl`: finds the archived program starting at `start` and
/// asks `tv_archive/create_link` for it. The program defines the length, so
/// `durationMinutes` is accepted but not sent.
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
    let start_at = chrono::DateTime::parse_from_rfc3339(start)
        .map_err(|_| CoreError::invalid("start must be an RFC 3339 timestamp"))?
        .with_timezone(&chrono::Utc);
    let row = catalog_row(state, r).await?;
    if row.archive_hours.unwrap_or(0) <= 0 {
        return Err(CoreError::Unsupported(
            "This channel has no archive on the portal.".into(),
        ));
    }
    let client = StalkerClient::for_source(state, &r.source_id).await?;
    let endpoint = client.endpoint().await?;

    let program_id = find_archive_program(&client, &r.item_id, start_at)
        .await
        .ok_or_else(|| {
            CoreError::not_found("The portal archive has no program at that time for this channel.")
        })?;
    let url = create_link(
        &client,
        "tv_archive",
        &format!("auto /media/{program_id}.mpg"),
        None,
    )
    .await?;
    let mut src = source(&client, &endpoint, url, row.title.clone(), r);
    src.is_live = false;
    src.subtitle = Some(start_at.format("%Y-%m-%d %H:%M UTC").to_string());
    src.poster_url = row.logo_url;
    Ok(src)
}

async fn find_archive_program(
    client: &StalkerClient,
    channel_id: &str,
    start: chrono::DateTime<chrono::Utc>,
) -> Option<String> {
    let ts = start.timestamp();
    let date = start.format("%Y-%m-%d").to_string();
    let matches = |v: &Value| -> bool {
        let st = n(v, "start_timestamp");
        let en = n(v, "stop_timestamp");
        match (st, en) {
            (Some(a), Some(b)) => a <= ts + 60 && ts < b,
            (Some(a), None) => (a - ts).abs() <= 60,
            _ => false,
        }
    };
    // Ministra serves the day table under `epg`; some builds only under `itv`.
    for table_type in ["epg", "itv"] {
        for page in 1..=10 {
            let req = Req::new(table_type, "get_simple_data_table")
                .p("ch_id", channel_id)
                .p("date", &date)
                .p("p", page);
            let Ok(js) = client.call(req).await else {
                break;
            };
            let total = n(&js, "total_items");
            let rows = into_list(js);
            if rows.is_empty() {
                break;
            }
            if let Some(hit) = rows.iter().find(|v| matches(v)) {
                return s(hit, "id");
            }
            let per = rows.len() as i64;
            if total.is_none_or(|t| page * per >= t) {
                // The table answered; the program is not in it.
                return None;
            }
        }
    }
    None
}

/// `stalker.epg`: short EPG, falling back to the bulk `get_epg_info`.
pub async fn epg(
    state: &Arc<AppState>,
    r: &ItemRef,
    limit: Option<i64>,
) -> CoreResult<Vec<EpgProgram>> {
    if !matches!(r.content_type, ContentType::Live | ContentType::Radio) {
        return Err(CoreError::invalid("EPG is only available for channels"));
    }
    let limit = limit.unwrap_or(10).clamp(1, 50);
    let row = catalog_row(state, r).await.ok();
    let channel_id = row
        .as_ref()
        .and_then(|r| r.epg_channel_id.clone())
        .unwrap_or_else(|| r.item_id.clone());
    let client = StalkerClient::for_source(state, &r.source_id).await?;

    let short = client
        .call(
            Req::new("itv", "get_short_epg")
                .p("ch_id", &r.item_id)
                .p("size", limit),
        )
        .await;
    let mut entries = match short {
        Ok(js) => into_list(js),
        Err(err @ CoreError::Auth(_)) => return Err(err),
        Err(_) => Vec::new(),
    };
    if entries.is_empty() {
        if let Ok(js) = client
            .call(
                Req::new("itv", "get_epg_info")
                    .p("period", 6)
                    .timeout(LONG_TIMEOUT),
            )
            .await
        {
            let data = js.get("data").cloned().unwrap_or(js);
            entries = match data.get(&r.item_id) {
                Some(Value::Array(a)) => a.clone(),
                _ => Vec::new(),
            };
        }
    }
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut programs: Vec<EpgProgram> = entries
        .iter()
        .filter_map(|v| mapping::epg_program(&channel_id, v))
        .filter(|p| p.end > now || p.end == p.start)
        .collect();
    programs.sort_by(|a, b| a.start.cmp(&b.start));
    programs.dedup_by(|a, b| a.start == b.start);
    programs.truncate(limit as usize);
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
