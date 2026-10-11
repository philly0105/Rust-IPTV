//! `catalog.*` RPC commands (SPEC C4).

use super::{CatalogQuery, NamedRow};
use crate::error::RpcError;
use crate::model::{Category, Channel, ContentType, ItemRef, Page, PageQuery, SeriesItem, VodItem};
use crate::rpc::RpcRouter;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Default per-type limit of `catalog.search`.
pub const DEFAULT_SEARCH_LIMIT: usize = 30;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoriesArgs {
    pub source_id: String,
    pub content_type: ContentType,
    #[serde(default)]
    pub include_hidden: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCategoryHiddenArgs {
    pub source_id: String,
    pub content_type: ContentType,
    pub category_id: String,
    pub hidden: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCategoriesHiddenArgs {
    pub source_id: String,
    pub content_type: ContentType,
    #[serde(default)]
    pub hidden_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelsArgs {
    pub source_id: String,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub query: PageQuery,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default)]
    pub radio: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VodListArgs {
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
pub struct ChannelByNumberArgs {
    pub source_id: String,
    pub number: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeighborsArgs {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    #[serde(default)]
    pub category_id: Option<String>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct NeighborsResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev: Option<Channel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<Channel>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchArgs {
    pub query: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub content_types: Option<Vec<ContentType>>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct SearchResult {
    pub live: Vec<Channel>,
    pub movies: Vec<VodItem>,
    pub series: Vec<SeriesItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentlyAddedArgs {
    #[serde(default)]
    pub source_id: Option<String>,
    pub content_type: ContentType,
    #[serde(default = "default_recent_limit")]
    pub limit: usize,
}

fn default_recent_limit() -> usize {
    20
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceArgs {
    pub source_id: String,
}

/// `catalog.item` / `catalog.recentlyAdded` result: shape by content type.
#[derive(Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub enum AnyItem {
    Channel(Channel),
    Vod(VodItem),
    Series(SeriesItem),
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub enum VodOrSeriesList {
    Movies(Vec<VodItem>),
    Series(Vec<SeriesItem>),
}

fn to_any(n: NamedRow) -> AnyItem {
    match n.row.content_type {
        ContentType::Live | ContentType::Radio => AnyItem::Channel(n.into_channel()),
        ContentType::Movie => AnyItem::Vod(n.into_vod()),
        ContentType::Series => AnyItem::Series(n.into_series()),
    }
}

pub async fn categories(
    state: Arc<AppState>,
    a: CategoriesArgs,
) -> Result<Vec<Category>, RpcError> {
    Ok(state
        .db_call(move |c| super::categories(c, &a.source_id, a.content_type, a.include_hidden))
        .await?)
}

pub async fn set_category_hidden(
    state: Arc<AppState>,
    a: SetCategoryHiddenArgs,
) -> Result<(), RpcError> {
    state
        .db_call(move |c| {
            super::set_category_hidden(c, &a.source_id, a.content_type, &a.category_id, a.hidden)
        })
        .await?;
    Ok(())
}

pub async fn set_categories_hidden(
    state: Arc<AppState>,
    a: SetCategoriesHiddenArgs,
) -> Result<(), RpcError> {
    state
        .db_call(move |c| {
            super::set_categories_hidden(c, &a.source_id, a.content_type, &a.hidden_ids)
        })
        .await?;
    Ok(())
}

pub async fn channels(state: Arc<AppState>, a: ChannelsArgs) -> Result<Page<Channel>, RpcError> {
    let q = CatalogQuery {
        source_id: a.source_id,
        content_type: if a.radio {
            ContentType::Radio
        } else {
            ContentType::Live
        },
        category_id: a.category_id.filter(|c| !c.is_empty()),
        page: a.query,
        include_hidden: a.include_hidden,
    };
    let page = state.db_call(move |c| super::query_named(c, &q)).await?;
    Ok(page.map(NamedRow::into_channel))
}

pub async fn movies(state: Arc<AppState>, a: VodListArgs) -> Result<Page<VodItem>, RpcError> {
    let q = CatalogQuery {
        source_id: a.source_id,
        content_type: ContentType::Movie,
        category_id: a.category_id.filter(|c| !c.is_empty()),
        page: a.query,
        include_hidden: false,
    };
    let page = state.db_call(move |c| super::query_named(c, &q)).await?;
    Ok(page.map(NamedRow::into_vod))
}

pub async fn series(state: Arc<AppState>, a: VodListArgs) -> Result<Page<SeriesItem>, RpcError> {
    let q = CatalogQuery {
        source_id: a.source_id,
        content_type: ContentType::Series,
        category_id: a.category_id.filter(|c| !c.is_empty()),
        page: a.query,
        include_hidden: false,
    };
    let page = state.db_call(move |c| super::query_named(c, &q)).await?;
    Ok(page.map(NamedRow::into_series))
}

pub async fn item(state: Arc<AppState>, a: RefArgs) -> Result<AnyItem, RpcError> {
    let r = a.item_ref;
    let id = r.item_id.clone();
    let row = state.db_call(move |c| super::get_named(c, &r)).await?;
    row.map(to_any).ok_or_else(|| {
        RpcError::not_found(format!("catalog item {id} not found; refresh the source"))
    })
}

pub async fn channel_by_number(
    state: Arc<AppState>,
    a: ChannelByNumberArgs,
) -> Result<Option<Channel>, RpcError> {
    let row = state
        .db_call(move |c| super::channel_by_number(c, &a.source_id, a.number))
        .await?;
    Ok(row.map(NamedRow::into_channel))
}

pub async fn neighbors(
    state: Arc<AppState>,
    a: NeighborsArgs,
) -> Result<NeighborsResult, RpcError> {
    let (prev, next) = state
        .db_call(move |c| {
            super::neighbors(
                c,
                &a.item_ref,
                a.category_id.as_deref().filter(|s| !s.is_empty()),
            )
        })
        .await?;
    Ok(NeighborsResult {
        prev: prev.map(NamedRow::into_channel),
        next: next.map(NamedRow::into_channel),
    })
}

pub async fn search(state: Arc<AppState>, a: SearchArgs) -> Result<SearchResult, RpcError> {
    let limit = a.limit.unwrap_or(DEFAULT_SEARCH_LIMIT).clamp(1, 200);
    let wanted = a.content_types.unwrap_or_else(|| ContentType::ALL.to_vec());
    state
        .db_call(move |c| {
            let mut out = SearchResult::default();
            let live_types: Vec<ContentType> = wanted
                .iter()
                .copied()
                .filter(|t| matches!(t, ContentType::Live | ContentType::Radio))
                .collect();
            if !live_types.is_empty() {
                out.live =
                    super::search_named(c, &a.query, a.source_id.as_deref(), &live_types, limit)?
                        .into_iter()
                        .map(NamedRow::into_channel)
                        .collect();
            }
            if wanted.contains(&ContentType::Movie) {
                out.movies = super::search_named(
                    c,
                    &a.query,
                    a.source_id.as_deref(),
                    &[ContentType::Movie],
                    limit,
                )?
                .into_iter()
                .map(NamedRow::into_vod)
                .collect();
            }
            if wanted.contains(&ContentType::Series) {
                out.series = super::search_named(
                    c,
                    &a.query,
                    a.source_id.as_deref(),
                    &[ContentType::Series],
                    limit,
                )?
                .into_iter()
                .map(NamedRow::into_series)
                .collect();
            }
            Ok(out)
        })
        .await
        .map_err(Into::into)
}

pub async fn recently_added(
    state: Arc<AppState>,
    a: RecentlyAddedArgs,
) -> Result<VodOrSeriesList, RpcError> {
    let ct = a.content_type;
    if !matches!(ct, ContentType::Movie | ContentType::Series) {
        return Err(RpcError::invalid(
            "recentlyAdded supports contentType 'movie' or 'series'",
        ));
    }
    let rows = state
        .db_call(move |c| super::recently_added(c, a.source_id.as_deref(), ct, a.limit))
        .await?;
    Ok(match ct {
        ContentType::Series => {
            VodOrSeriesList::Series(rows.into_iter().map(NamedRow::into_series).collect())
        }
        _ => VodOrSeriesList::Movies(rows.into_iter().map(NamedRow::into_vod).collect()),
    })
}

pub async fn same_title(state: Arc<AppState>, a: RefArgs) -> Result<Vec<VodItem>, RpcError> {
    let rows = state
        .db_call(move |c| super::same_title(c, &a.item_ref))
        .await?;
    Ok(rows.into_iter().map(NamedRow::into_vod).collect())
}

pub async fn all_live_channels(
    state: Arc<AppState>,
    a: SourceArgs,
) -> Result<Vec<Channel>, RpcError> {
    let rows = state
        .db_call(move |c| super::all_live_channels(c, &a.source_id))
        .await?;
    Ok(rows.into_iter().map(NamedRow::into_channel).collect())
}

/// Registers every `catalog.*` command of C4.
pub fn register(r: &mut RpcRouter) {
    r.add("catalog.categories", categories);
    r.add("catalog.setCategoryHidden", set_category_hidden);
    r.add("catalog.setCategoriesHidden", set_categories_hidden);
    r.add("catalog.channels", channels);
    r.add("catalog.movies", movies);
    r.add("catalog.series", series);
    r.add("catalog.item", item);
    r.add("catalog.channelByNumber", channel_by_number);
    r.add("catalog.neighbors", neighbors);
    r.add("catalog.search", search);
    r.add("catalog.recentlyAdded", recently_added);
    r.add("catalog.sameTitle", same_title);
    r.add("catalog.allLiveChannels", all_live_channels);
}
