//! Stalker importer: itv genres + all channels and radio into the catalog;
//! VOD and series categories with zero items (VOD is paged live).

use super::mapping;
use super::protocol::{self as p, into_list, n};
use super::session::{Req, StalkerClient, LONG_TIMEOUT};
use super::Runtime;
use crate::catalog::{self, CategoryRow, ItemRow};
use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, ImportSummary, Source, SourceKind};
use crate::sources::{progress, Importer};
use crate::state::AppState;
use crate::xtream::sync::{replace_catalogs, CatalogPart};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;

/// Safety cap for paged list walks.
const MAX_PAGES: i64 = 400;
/// Category id for channels without a (known) genre.
const UNCATEGORIZED: &str = "uncategorized";
/// Category id of the single radio category.
const RADIO_CATEGORY: &str = "radio";

/// Progress callback: `(phase, done, total, message)`.
type Emit<'a> = dyn Fn(&str, u64, Option<u64>, Option<&str>) + Sync + 'a;

/// The registered [`Importer`] for `SourceKind::Stalker`.
pub struct StalkerImporter;

#[async_trait::async_trait]
impl Importer for StalkerImporter {
    fn kind(&self) -> SourceKind {
        SourceKind::Stalker
    }

    async fn import(&self, state: Arc<AppState>, source: &Source) -> CoreResult<ImportSummary> {
        let client = match &source.stalker {
            Some(cfg) => StalkerClient::with_config(&state, &source.id, cfg.clone()).await?,
            None => StalkerClient::for_source(&state, &source.id).await?,
        };
        sync_source(&state, &client, &source.id).await
    }
}

/// Walks every page of a `get_ordered_list` style call.
pub async fn fetch_all_pages(client: &StalkerClient, base: Req) -> CoreResult<Vec<Value>> {
    let mut out: Vec<Value> = Vec::new();
    let mut page = 1;
    loop {
        let js = client.call(base.clone().p("p", page)).await?;
        let total = n(&js, "total_items");
        let items = into_list(js);
        if items.is_empty() {
            break;
        }
        out.extend(items);
        if total.is_some_and(|t| out.len() as i64 >= t) || total.is_none() || page >= MAX_PAGES {
            break;
        }
        page += 1;
    }
    Ok(out)
}

async fn list(client: &StalkerClient, req: Req) -> CoreResult<Vec<Value>> {
    Ok(into_list(client.call(req).await?))
}

/// First-page `total_items` of a VOD/series listing; `None` when the portal
/// did not answer (or answered without a total).
async fn remote_total(client: &StalkerClient, kind: &str) -> Option<i64> {
    let req = Req::new(kind, "get_ordered_list")
        .p("category", "*")
        .p("sortby", "added")
        .p("p", 1);
    match client.call(req).await {
        Ok(js) => n(&js, "total_items"),
        Err(err) => {
            tracing::info!(kind, error = %err, "stalker portal total unavailable; keeping the previous count");
            None
        }
    }
}

/// Full resync of one source, emitting `fetching` / `parsing` / `saving`
/// progress. It does not emit `done` / `error` or touch `last_refresh_at` /
/// `last_error`: `sources::run_import` (which `stalker.sync` and
/// `sources.refresh` both go through) owns the outcome, including the
/// remote movie/series totals and parked backup state.
pub async fn sync_source(
    state: &Arc<AppState>,
    client: &StalkerClient,
    source_id: &str,
) -> CoreResult<ImportSummary> {
    let sid = source_id.to_string();
    let emit = |phase: &str, done: u64, total: Option<u64>, msg: Option<&str>| {
        progress(state, &sid, phase, done, total, msg)
    };
    run(state, client, source_id, &emit).await
}

async fn run(
    state: &Arc<AppState>,
    client: &StalkerClient,
    source_id: &str,
    emit: &Emit<'_>,
) -> CoreResult<ImportSummary> {
    emit("fetching", 0, None, Some("Connecting to the portal"));
    let endpoint = client.endpoint().await?;

    emit("fetching", 0, None, Some("Loading channel categories"));
    let genres = mapping::categories(&list(client, Req::new("itv", "get_genres")).await?);

    emit("fetching", 0, None, Some("Loading channels"));
    let channels = match client
        .call(Req::new("itv", "get_all_channels").timeout(LONG_TIMEOUT))
        .await
    {
        Ok(js) if !into_list(js.clone()).is_empty() => into_list(js),
        Ok(_) | Err(CoreError::Invalid(_)) | Err(CoreError::NotFound(_)) => {
            // Some panels disable get_all_channels: page through the list instead.
            fetch_all_pages(
                client,
                Req::new("itv", "get_ordered_list")
                    .p("genre", "*")
                    .p("sortby", "number"),
            )
            .await?
        }
        Err(err) => return Err(err),
    };

    emit(
        "fetching",
        channels.len() as u64,
        None,
        Some("Loading radio"),
    );
    let radio = match fetch_all_pages(
        client,
        Req::new("radio", "get_ordered_list").p("sortby", "number"),
    )
    .await
    {
        Ok(r) => r,
        Err(err @ CoreError::Auth(_)) => return Err(err),
        Err(err) => {
            tracing::info!(error = %err, "stalker portal has no radio list");
            Vec::new()
        }
    };

    emit(
        "fetching",
        (channels.len() + radio.len()) as u64,
        None,
        Some("Loading movie and series categories"),
    );
    let vod_categories = match list(client, Req::new("vod", "get_categories")).await {
        Ok(c) => mapping::categories(&c),
        Err(err @ CoreError::Auth(_)) => return Err(err),
        Err(err) => {
            tracing::info!(error = %err, "stalker portal has no VOD categories");
            Vec::new()
        }
    };
    let series_categories = match list(client, Req::new("series", "get_categories")).await {
        Ok(c) => mapping::categories(&c),
        Err(err @ CoreError::Auth(_)) => return Err(err),
        Err(err) => {
            tracing::info!(error = %err, "stalker portal has no series categories");
            Vec::new()
        }
    };

    // Map rows.
    let total = (channels.len() + radio.len()) as u64;
    let known: HashSet<&str> = genres.iter().map(|g| g.category_id.as_str()).collect();
    let mut live_rows: Vec<ItemRow> = Vec::with_capacity(channels.len());
    let mut seen: HashSet<String> = HashSet::new();
    for (i, v) in channels.iter().enumerate() {
        let genre = p::s(v, "tv_genre_id")
            .filter(|g| known.contains(g.as_str()))
            .unwrap_or_else(|| UNCATEGORIZED.to_string());
        if let Some(row) =
            mapping::channel_row(source_id, &endpoint, v, ContentType::Live, genre, i as i64)
        {
            if seen.insert(row.item_id.clone()) {
                live_rows.push(row);
            }
        }
        if (i + 1) % 2000 == 0 {
            emit("parsing", (i + 1) as u64, Some(total), None);
        }
    }
    let mut live_categories = genres.clone();
    if live_rows.iter().any(|r| r.category_id == UNCATEGORIZED) {
        live_categories.push(CategoryRow {
            category_id: UNCATEGORIZED.into(),
            name: catalog::FALLBACK_CATEGORY_NAME.into(),
            position: live_categories.len() as i64,
        });
    }
    seen.clear();
    let radio_rows: Vec<ItemRow> = radio
        .iter()
        .enumerate()
        .filter_map(|(i, v)| {
            mapping::channel_row(
                source_id,
                &endpoint,
                v,
                ContentType::Radio,
                RADIO_CATEGORY.into(),
                i as i64,
            )
        })
        .filter(|r| seen.insert(r.item_id.clone()))
        .collect();
    let radio_categories = if radio_rows.is_empty() {
        Vec::new()
    } else {
        vec![CategoryRow {
            category_id: RADIO_CATEGORY.into(),
            name: "Radio".into(),
            position: 0,
        }]
    };
    emit("parsing", total, Some(total), None);

    // Totals for the summary (VOD is not stored, so ask the portal).
    // An unanswered total keeps the stored count: `sources::run_import`
    // records whatever the summary carries.
    let (movies, series) =
        tokio::join!(remote_total(client, "vod"), remote_total(client, "series"));
    let (movies, series) = if movies.is_none() || series.is_none() {
        let sid = source_id.to_string();
        let (_, old_movies, old_series) = state
            .db_call(move |conn| catalog::source_counts(conn, &sid))
            .await
            .unwrap_or((0, 0, 0));
        (movies.unwrap_or(old_movies), series.unwrap_or(old_series))
    } else {
        (movies.unwrap_or(0), series.unwrap_or(0))
    };

    // A cancelled run keeps the old catalog (C8): stop before saving, and
    // save all four types in one transaction so a cancel seen by the writer
    // rolls every type back together.
    if crate::sources::is_import_cancelled() {
        return Err(crate::sources::import_cancelled_error());
    }
    emit("saving", 0, Some(total), Some("Saving the catalog"));
    let sid = source_id.to_string();
    let part = |content_type, categories, rows| CatalogPart {
        content_type,
        categories,
        rows,
    };
    let parts = vec![
        part(ContentType::Live, live_categories, live_rows),
        part(ContentType::Radio, radio_categories, radio_rows),
        part(ContentType::Movie, vod_categories, Vec::new()),
        part(ContentType::Series, series_categories, Vec::new()),
    ];
    // The run's token, read here (task-local) before waiting on the pool or
    // the write lock (C8; see `CatalogWriter::begin`).
    let cancel = crate::sources::import_cancel();
    let counts = state
        .db_call(move |conn| replace_catalogs(conn, &sid, parts, cancel, &mut |_| {}))
        .await?;
    let count = |ct: ContentType| counts.get(&ct).copied().unwrap_or(0);
    let (channel_count, radio_count) = (count(ContentType::Live), count(ContentType::Radio));
    // Plans and page sizes may have changed; listed rows stay usable.
    Runtime::get(state).forget_listings(source_id);

    Ok(ImportSummary {
        channels: (channel_count + radio_count) as i64,
        movies,
        series,
    })
}
