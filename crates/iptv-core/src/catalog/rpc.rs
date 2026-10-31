//! `catalog.*` RPC commands (SPEC C4).

use super::quality::QualityFilter;
use super::{CatalogQuery, NamedRow, VodFilter};
use crate::error::{CoreResult, RpcError};
use crate::model::{Category, Channel, ContentType, ItemRef, Page, PageQuery, SeriesItem, VodItem};
use crate::rpc::RpcRouter;
use crate::state::AppState;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// Default per-type limit of `catalog.search`.
pub const DEFAULT_SEARCH_LIMIT: usize = 30;

/// Largest per-type limit of `catalog.search`. The UI steps 60/200/1000 and
/// asks for one extra row to learn whether more exist, hence 1000 + 1.
pub const MAX_SEARCH_LIMIT: usize = 1001;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoriesArgs {
    pub source_id: String,
    pub content_type: ContentType,
    #[serde(default)]
    pub include_hidden: bool,
    /// Also list groups that parental hide mode leaves out while locked,
    /// with their full counts, for the parental settings page (Lock groups
    /// in provider order, L1-settings-13). Categories carry names and counts
    /// only; no item is ever returned through this flag.
    #[serde(default)]
    pub include_locked: bool,
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
    /// Only items rated at least this; the count covers the filtered set.
    #[serde(default)]
    pub min_rating: Option<f64>,
    // vod: Run 2 C4.
    /// 1900..=2100 and `yearFrom <= yearTo` else invalid. Titles without a
    /// year drop out when either bound is set.
    #[serde(default)]
    pub year_from: Option<i32>,
    #[serde(default)]
    pub year_to: Option<i32>,
    /// Drops titles with an item-level watched row; `total` counts the filtered set.
    #[serde(default)]
    pub hide_watched: bool,
}

impl VodListArgs {
    /// The C4 filter of these args, validated.
    fn vod_filter(&self) -> Result<VodFilter, RpcError> {
        let f = VodFilter {
            year_from: self.year_from,
            year_to: self.year_to,
            hide_watched: self.hide_watched,
        };
        super::vodfilter::validate(&f)?;
        Ok(f)
    }
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
    /// `live` or `radio`; omitted searches both, live first.
    #[serde(default)]
    pub content_type: Option<ContentType>,
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

/// The `englishOnly` setting: list readers drop items that are clearly in
/// another language (see [`super::language`]).
fn english_only(state: &AppState) -> bool {
    state.settings_snapshot().english_only
}

/// The Live TV quality filter (`liveMinQuality`, `liveHideUntagged`), `None`
/// while off: live readers drop channels whose name marks a lower quality
/// (see [`super::quality`]).
pub(crate) fn quality_filter(state: &AppState) -> Option<QualityFilter> {
    QualityFilter::from_settings(&state.settings.read())
}

/// The parental hide-mode filter for this call (`None` unless a PIN is set,
/// the mode is hide and no unlock is active).
async fn hide(state: &AppState) -> Result<Option<crate::parental::Hide>, RpcError> {
    Ok(crate::parental::hide_filter(state).await?)
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
    let english = english_only(&state);
    let quality = quality_filter(&state);
    let hide = if a.include_locked {
        None
    } else {
        hide(&state).await?
    };
    Ok(state
        .db_call(move |c| {
            super::visible_categories(
                c,
                &a.source_id,
                a.content_type,
                a.include_hidden,
                english,
                quality,
                hide,
            )
        })
        .await?)
}

pub async fn set_category_hidden(
    state: Arc<AppState>,
    a: SetCategoryHiddenArgs,
) -> Result<(), RpcError> {
    let source_id = a.source_id.clone();
    let live = a.content_type == ContentType::Live;
    state
        .db_write(move |c| {
            super::set_category_hidden(c, &a.source_id, a.content_type, &a.category_id, a.hidden)
        })
        .await?;
    if live {
        // The phone remote lists the channels of visible live groups only.
        crate::remote::channels_may_have_changed(&state, Some(source_id.as_str()));
    }
    Ok(())
}

pub async fn set_categories_hidden(
    state: Arc<AppState>,
    a: SetCategoriesHiddenArgs,
) -> Result<(), RpcError> {
    let source_id = a.source_id.clone();
    let live = a.content_type == ContentType::Live;
    state
        .db_write(move |c| {
            super::set_categories_hidden(c, &a.source_id, a.content_type, &a.hidden_ids)
        })
        .await?;
    if live {
        // The phone remote lists the channels of visible live groups only.
        crate::remote::channels_may_have_changed(&state, Some(source_id.as_str()));
    }
    Ok(())
}

pub async fn channels(state: Arc<AppState>, a: ChannelsArgs) -> Result<Page<Channel>, RpcError> {
    let hide = hide(&state).await?;
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
        min_rating: None,
        english_only: english_only(&state),
        // Radio is never filtered by quality.
        quality: if a.radio {
            None
        } else {
            quality_filter(&state)
        },
        vod: VodFilter::default(),
    };
    // guide: M3U catch-up overrides are applied on read.
    let page = state
        .db_call(move |c| {
            let mut page = super::query_named(c, &q, hide)?.map(NamedRow::into_channel);
            crate::catchup::m3u::apply_overrides(c, &mut page.items)?;
            // C2: custom names on read.
            crate::channeledit::apply_names(c, &mut page.items)?;
            Ok(page)
        })
        .await?;
    Ok(page)
}

pub async fn movies(state: Arc<AppState>, a: VodListArgs) -> Result<Page<VodItem>, RpcError> {
    let vod = a.vod_filter()?;
    let hide = hide(&state).await?;
    let q = CatalogQuery {
        source_id: a.source_id,
        content_type: ContentType::Movie,
        category_id: a.category_id.filter(|c| !c.is_empty()),
        page: a.query,
        include_hidden: false,
        min_rating: a.min_rating,
        english_only: english_only(&state),
        quality: None,
        vod,
    };
    let page = state
        .db_call(move |c| super::query_named(c, &q, hide))
        .await?;
    Ok(page.map(NamedRow::into_vod))
}

pub async fn series(state: Arc<AppState>, a: VodListArgs) -> Result<Page<SeriesItem>, RpcError> {
    let vod = a.vod_filter()?;
    let hide = hide(&state).await?;
    let q = CatalogQuery {
        source_id: a.source_id,
        content_type: ContentType::Series,
        category_id: a.category_id.filter(|c| !c.is_empty()),
        page: a.query,
        include_hidden: false,
        min_rating: a.min_rating,
        english_only: english_only(&state),
        quality: None,
        vod,
    };
    let page = state
        .db_call(move |c| super::query_named(c, &q, hide))
        .await?;
    Ok(page.map(NamedRow::into_series))
}

/// Why `catalog.item` has no row for a ref.
enum Gone {
    Missing,
    /// Parental hide mode keeps the item in the database but out of reach.
    Locked,
}

/// The `catalog.item` read of `r` on an open connection.
fn lookup(
    c: &Connection,
    r: &ItemRef,
    hide: Option<crate::parental::Hide>,
) -> CoreResult<Result<AnyItem, Gone>> {
    let mut found = [find(c, r, hide, &mut HashMap::new())?];
    finish_channels(c, &mut found)?;
    let [found] = found;
    Ok(found)
}

/// [`lookup`] without the channel post-processing ([`finish_channels`]),
/// which `catalog.items` applies once over every ref's answer. `m3u` caches
/// [`super::is_m3u_source`] per source id across the refs of one call.
fn find(
    c: &Connection,
    r: &ItemRef,
    hide: Option<crate::parental::Hide>,
    m3u: &mut HashMap<String, bool>,
) -> CoreResult<Result<AnyItem, Gone>> {
    let Some(named) = super::get_named(c, r)? else {
        return Ok(Err(Gone::Missing));
    };
    // parental: hide mode keeps a locked item in the database.
    if let Some(h) = hide {
        if !super::is_visible(c, r, h)? {
            return Ok(Err(Gone::Locked));
        }
    }
    // An M3U movie plays and downloads from the playlist's own link;
    // Xtream and Stalker movies get theirs from their streamUrl.
    let is_m3u_movie = named.row.content_type == ContentType::Movie
        && match m3u.get(&r.source_id) {
            Some(known) => *known,
            None => {
                let known = super::is_m3u_source(c, &r.source_id)?;
                m3u.insert(r.source_id.clone(), known);
                known
            }
        };
    Ok(Ok(if is_m3u_movie {
        AnyItem::Vod(named.into_m3u_vod())
    } else {
        to_any(named)
    }))
}

/// Applies the M3U catch-up overrides (guide) and the custom names (C2) to
/// every channel among `found`, in one call each: both read their
/// per-source data (the source's config, every custom name of the source)
/// once per call, so `catalog.items` with 42 favourite channels ran about
/// 150 statements and 42 config parses one ref at a time. A hidden channel
/// is still returned (the hidden-channels dialog and the player open it),
/// with its custom name.
fn finish_channels(c: &Connection, found: &mut [Result<AnyItem, Gone>]) -> CoreResult<()> {
    let mut at = Vec::new();
    let mut channels = Vec::new();
    for (i, slot) in found.iter_mut().enumerate() {
        if matches!(slot, Ok(AnyItem::Channel(_))) {
            if let Ok(AnyItem::Channel(ch)) = std::mem::replace(slot, Err(Gone::Missing)) {
                at.push(i);
                channels.push(ch);
            }
        }
    }
    if channels.is_empty() {
        return Ok(());
    }
    crate::catchup::m3u::apply_overrides(c, &mut channels)?;
    crate::channeledit::apply_names(c, &mut channels)?;
    for (i, ch) in at.into_iter().zip(channels) {
        found[i] = Ok(AnyItem::Channel(ch));
    }
    Ok(())
}

/// `catalog.item`'s answer for a lookup of the item `id`.
fn item_answer(id: &str, found: Result<AnyItem, Gone>) -> Result<AnyItem, RpcError> {
    found.map_err(|gone| match gone {
        // The code stays not_found for older callers; `details.parentalLocked`
        // lets the UI tell a locked item from one the provider dropped.
        Gone::Locked => RpcError::not_found(format!(
            "catalog item {id} is locked by parental controls; unlock them to open it"
        ))
        .with_details(serde_json::json!({ "parentalLocked": true })),
        Gone::Missing => {
            RpcError::not_found(format!("catalog item {id} not found; refresh the source"))
        }
    })
}

pub async fn item(state: Arc<AppState>, a: RefArgs) -> Result<AnyItem, RpcError> {
    let r = a.item_ref;
    let id = r.item_id.clone();
    let hide = hide(&state).await?;
    let found = state.db_call(move |c| lookup(c, &r, hide)).await?;
    item_answer(&id, found)
}

/// Most refs one `catalog.items` call takes.
pub const MAX_ITEMS_REFS: usize = 500;

#[derive(Debug, Deserialize)]
pub struct RefsArgs {
    pub refs: Vec<ItemRef>,
}

/// One answer of `catalog.items`: what `catalog.item` returns for the ref,
/// or the error it fails with.
#[derive(Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub enum ItemAnswer {
    Item { item: Box<AnyItem> },
    Error { error: RpcError },
}

/// `catalog.items`: `catalog.item` for many refs in one call and one
/// `db_call`, one answer per ref in their order. The favourites and recently
/// watched views and the channel pickers ask for the channels of 20 to 60
/// rows at once; one request each queued them on the pool (and in server mode
/// on the browser's six connections), and every answer re-rendered the page.
pub async fn items(state: Arc<AppState>, a: RefsArgs) -> Result<Vec<ItemAnswer>, RpcError> {
    if a.refs.len() > MAX_ITEMS_REFS {
        return Err(RpcError::invalid(format!(
            "catalog.items takes at most {MAX_ITEMS_REFS} refs"
        )));
    }
    let hide = hide(&state).await?;
    let found = state
        .db_call(move |c| {
            let mut m3u = HashMap::new();
            let mut found = a
                .refs
                .iter()
                .map(|r| find(c, r, hide, &mut m3u))
                .collect::<CoreResult<Vec<_>>>()?;
            finish_channels(c, &mut found)?;
            Ok(found.into_iter().zip(a.refs).collect::<Vec<_>>())
        })
        .await?;
    Ok(found
        .into_iter()
        .map(|(l, r)| match item_answer(&r.item_id, l) {
            Ok(item) => ItemAnswer::Item {
                item: Box::new(item),
            },
            Err(error) => ItemAnswer::Error { error },
        })
        .collect())
}

pub async fn channel_by_number(
    state: Arc<AppState>,
    a: ChannelByNumberArgs,
) -> Result<Option<Channel>, RpcError> {
    let quality = quality_filter(&state);
    let hide = hide(&state).await?;
    let row = state
        .db_call(move |c| {
            let mut ch =
                super::channel_by_number(c, &a.source_id, a.number, a.content_type, quality, hide)?
                    .map(NamedRow::into_channel);
            // guide: M3U catch-up overrides are applied on read.
            crate::catchup::m3u::apply_overrides(c, ch.as_mut_slice())?;
            crate::channeledit::apply_names(c, ch.as_mut_slice())?;
            Ok(ch)
        })
        .await?;
    Ok(row)
}

pub async fn neighbors(
    state: Arc<AppState>,
    a: NeighborsArgs,
) -> Result<NeighborsResult, RpcError> {
    let english = english_only(&state);
    let quality = quality_filter(&state);
    let hide = hide(&state).await?;
    let (prev, next) = state
        .db_call(move |c| {
            let (prev, next) = super::neighbors(
                c,
                &a.item_ref,
                a.category_id.as_deref().filter(|s| !s.is_empty()),
                english,
                quality,
                hide,
            )?;
            let mut prev = prev.map(NamedRow::into_channel);
            let mut next = next.map(NamedRow::into_channel);
            // guide: M3U catch-up overrides are applied on read.
            crate::catchup::m3u::apply_overrides(c, prev.as_mut_slice())?;
            crate::catchup::m3u::apply_overrides(c, next.as_mut_slice())?;
            crate::channeledit::apply_names(c, prev.as_mut_slice())?;
            crate::channeledit::apply_names(c, next.as_mut_slice())?;
            Ok((prev, next))
        })
        .await?;
    Ok(NeighborsResult { prev, next })
}

pub async fn search(state: Arc<AppState>, a: SearchArgs) -> Result<SearchResult, RpcError> {
    let limit = a
        .limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT);
    let wanted = a.content_types.unwrap_or_else(|| ContentType::ALL.to_vec());
    let english = english_only(&state);
    let quality = quality_filter(&state);
    let hide = hide(&state).await?;
    state
        .db_call(move |c| {
            let mut out = SearchResult::default();
            let live_types: Vec<ContentType> = wanted
                .iter()
                .copied()
                .filter(|t| matches!(t, ContentType::Live | ContentType::Radio))
                .collect();
            let movies = wanted.contains(&ContentType::Movie);
            let series = wanted.contains(&ContentType::Series);
            // One ranked pass for every list (search_groups).
            let groups: [&[ContentType]; 3] = [
                &live_types,
                if movies { &[ContentType::Movie] } else { &[] },
                if series { &[ContentType::Series] } else { &[] },
            ];
            let mut found = super::search_groups(
                c,
                &a.query,
                a.source_id.as_deref(),
                &groups,
                limit,
                english,
                quality,
                hide,
            )?
            .into_iter();
            let mut next = || found.next().unwrap_or_default();
            out.live = next().into_iter().map(NamedRow::into_channel).collect();
            out.movies = next().into_iter().map(NamedRow::into_vod).collect();
            out.series = next().into_iter().map(NamedRow::into_series).collect();
            if !out.live.is_empty() {
                // guide: M3U catch-up overrides are applied on read.
                crate::catchup::m3u::apply_overrides(c, &mut out.live)?;
                crate::channeledit::apply_names(c, &mut out.live)?;
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
    let english = english_only(&state);
    let hide = hide(&state).await?;
    let rows = state
        .db_call(move |c| {
            super::recently_added(c, a.source_id.as_deref(), ct, a.limit, english, hide)
        })
        .await?;
    Ok(match ct {
        ContentType::Series => {
            VodOrSeriesList::Series(rows.into_iter().map(NamedRow::into_series).collect())
        }
        _ => VodOrSeriesList::Movies(rows.into_iter().map(NamedRow::into_vod).collect()),
    })
}

pub async fn same_title(state: Arc<AppState>, a: RefArgs) -> Result<Vec<VodItem>, RpcError> {
    let hide = hide(&state).await?;
    let rows = state
        .db_call(move |c| super::same_title(c, &a.item_ref, hide))
        .await?;
    Ok(rows.into_iter().map(NamedRow::into_vod).collect())
}

pub async fn all_live_channels(
    state: Arc<AppState>,
    a: SourceArgs,
) -> Result<Vec<Channel>, RpcError> {
    let english = english_only(&state);
    let quality = quality_filter(&state);
    let hide = hide(&state).await?;
    let rows = state
        .db_call(move |c| {
            let found = super::all_live_channels(c, &a.source_id, english, quality, hide)?;
            let mut v: Vec<Channel> = found.into_iter().map(NamedRow::into_channel).collect();
            // guide: M3U catch-up overrides are applied on read.
            crate::catchup::m3u::apply_overrides(c, &mut v)?;
            crate::channeledit::apply_names(c, &mut v)?;
            Ok(v)
        })
        .await?;
    Ok(rows)
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
    r.add("catalog.items", items);
    r.add("catalog.channelByNumber", channel_by_number);
    r.add("catalog.neighbors", neighbors);
    r.add("catalog.search", search);
    r.add("catalog.recentlyAdded", recently_added);
    r.add("catalog.sameTitle", same_title);
    r.add("catalog.allLiveChannels", all_live_channels);
    // vod: `catalog.yearFacets` (Run 2 C4) is registered by the vodfilter
    // module, which owns its handler.
    super::vodfilter::register(r);
}
