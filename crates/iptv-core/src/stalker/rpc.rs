//! `stalker.*` RPC commands (SPEC C4 stalker).

use super::playback::{self, ConnectionTestResult, StalkerAccountInfo};
use super::session::StalkerClient;
use super::vod::{self, Kind};
use crate::error::{CoreError, RpcError};
use crate::model::{
    ContentType, EpgProgram, ImportSummary, ItemRef, Page, PageQuery, PlayerSource, SeriesDetail,
    SeriesItem, StalkerSourceConfig, VodDetail, VodItem,
};
use crate::state::AppState;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

/// Every command this module registers (C4).
pub const COMMANDS: [&str; 11] = [
    "stalker.sync",
    "stalker.movies",
    "stalker.series",
    "stalker.vodDetail",
    "stalker.seriesDetail",
    "stalker.streamUrl",
    "stalker.catchupUrl",
    "stalker.epg",
    "stalker.search",
    "stalker.accountInfo",
    "stalker.test",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceArgs {
    pub source_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListArgs {
    pub source_id: String,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub query: PageQuery,
}

#[derive(Debug, Deserialize)]
pub struct RefArgs {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamArgs {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    #[serde(default)]
    pub episode_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatchupArgs {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub start: String,
    pub duration_minutes: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgArgs {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchArgs {
    pub source_id: String,
    pub query: String,
    pub content_type: ContentType,
}

#[derive(Debug, Deserialize)]
pub struct TestArgs {
    pub config: StalkerSourceConfig,
}

/// Registers this module's commands.
pub fn register(r: &mut crate::rpc::RpcRouter) {
    r.add("stalker.sync", |s, a: SourceArgs| async move {
        sync(s, a).await
    });
    r.add("stalker.movies", |s, a: ListArgs| async move {
        Ok::<Page<VodItem>, RpcError>(movies(&s, a).await?)
    });
    r.add("stalker.series", |s, a: ListArgs| async move {
        Ok::<Page<SeriesItem>, RpcError>(series(&s, a).await?)
    });
    r.add("stalker.vodDetail", |s, a: RefArgs| async move {
        expect_type(&a.item_ref, &[ContentType::Movie])?;
        Ok::<VodDetail, RpcError>(vod::vod_detail(&s, &a.item_ref).await?)
    });
    r.add("stalker.seriesDetail", |s, a: RefArgs| async move {
        expect_type(&a.item_ref, &[ContentType::Series])?;
        Ok::<SeriesDetail, RpcError>(vod::series_detail(&s, &a.item_ref).await?)
    });
    r.add("stalker.streamUrl", |s, a: StreamArgs| async move {
        Ok::<PlayerSource, RpcError>(
            playback::stream_url(&s, &a.item_ref, a.episode_id.as_deref()).await?,
        )
    });
    r.add("stalker.catchupUrl", |s, a: CatchupArgs| async move {
        Ok::<PlayerSource, RpcError>(
            playback::catchup_url(&s, &a.item_ref, &a.start, a.duration_minutes).await?,
        )
    });
    r.add("stalker.epg", |s, a: EpgArgs| async move {
        Ok::<Vec<EpgProgram>, RpcError>(playback::epg(&s, &a.item_ref, a.limit).await?)
    });
    r.add("stalker.search", |s, a: SearchArgs| async move {
        Ok::<Page<Value>, RpcError>(search(&s, a).await?)
    });
    r.add("stalker.accountInfo", |s, a: SourceArgs| async move {
        Ok::<StalkerAccountInfo, RpcError>(playback::account_info(&s, &a.source_id).await?)
    });
    r.add("stalker.test", |s, a: TestArgs| async move {
        Ok::<ConnectionTestResult, RpcError>(playback::test(&s, a.config).await)
    });
}

fn expect_type(r: &ItemRef, allowed: &[ContentType]) -> Result<(), CoreError> {
    if allowed.contains(&r.content_type) {
        Ok(())
    } else {
        Err(CoreError::invalid(format!(
            "this command does not accept {} items",
            r.content_type.as_str()
        )))
    }
}

/// `stalker.sync`: a full resync through `sources::run_import`, which holds
/// the per-source import lock, records `last_refresh_at` / `last_error` and
/// the portal's movie/series totals, applies parked backup state, and emits
/// `done` / `error` progress plus `sources.changed`. The kind is checked
/// first so a wrong source id never runs another kind's importer.
async fn sync(state: Arc<AppState>, a: SourceArgs) -> Result<ImportSummary, RpcError> {
    super::session::load_config(&state, &a.source_id).await?;
    let (_, summary) = crate::sources::run_import(state, &a.source_id).await?;
    Ok(summary)
}

async fn movies(state: &Arc<AppState>, a: ListArgs) -> Result<Page<VodItem>, CoreError> {
    let client = StalkerClient::for_source(state, &a.source_id).await?;
    let endpoint = client.endpoint().await?;
    let page = vod::list_page(
        state,
        &client,
        &a.source_id,
        Kind::Vod,
        a.category_id.as_deref(),
        &a.query,
    )
    .await?;
    let names = vod::category_names(state, &a.source_id, ContentType::Movie).await;
    vod::remember_rows(state, &a.source_id, Kind::Vod, &page.items, &names);
    let sid = a.source_id.clone();
    Ok(page
        .map(|l| {
            super::mapping::vod_item(
                &sid,
                &endpoint,
                &l.raw,
                &l.category_id,
                names.get(&l.category_id).cloned(),
            )
        })
        .filter_some())
}

async fn series(state: &Arc<AppState>, a: ListArgs) -> Result<Page<SeriesItem>, CoreError> {
    let client = StalkerClient::for_source(state, &a.source_id).await?;
    let endpoint = client.endpoint().await?;
    let page = vod::list_page(
        state,
        &client,
        &a.source_id,
        Kind::Series,
        a.category_id.as_deref(),
        &a.query,
    )
    .await?;
    let names = vod::category_names(state, &a.source_id, ContentType::Series).await;
    vod::remember_rows(state, &a.source_id, Kind::Series, &page.items, &names);
    let sid = a.source_id.clone();
    Ok(page
        .map(|l| {
            super::mapping::series_item(
                &sid,
                &endpoint,
                &l.raw,
                &l.category_id,
                names.get(&l.category_id).cloned(),
            )
        })
        .filter_some())
}

async fn search(state: &Arc<AppState>, a: SearchArgs) -> Result<Page<Value>, CoreError> {
    let text = a.query.trim().to_string();
    let query = PageQuery {
        offset: 0,
        limit: 56,
        search: Some(text.clone()),
        ..Default::default()
    };
    if text.is_empty() {
        return Ok(Page::empty(0, query.limit));
    }
    let args = ListArgs {
        source_id: a.source_id,
        category_id: None,
        query,
    };
    Ok(match a.content_type {
        ContentType::Movie => movies(state, args).await?.map(to_value),
        ContentType::Series => series(state, args).await?.map(to_value),
        other => {
            return Err(CoreError::invalid(format!(
            "stalker.search covers movies and series; {} items are searched with catalog.search",
            other.as_str()
        )))
        }
    })
}

fn to_value<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

trait FilterSome<T> {
    fn filter_some(self) -> Page<T>;
}

impl<T> FilterSome<T> for Page<Option<T>> {
    fn filter_some(self) -> Page<T> {
        Page {
            items: self.items.into_iter().flatten().collect(),
            total: self.total,
            offset: self.offset,
            limit: self.limit,
        }
    }
}
