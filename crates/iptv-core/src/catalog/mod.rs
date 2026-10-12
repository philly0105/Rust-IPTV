//! `catalog` module (SPEC C5): the items/categories store every source kind
//! writes into, the paged readers the UI pages through, and `catalog.*` rpc.
//!
//! Writers: [`replace_catalog`] (one content type) and [`CatalogWriter`] (any
//! set of content types inside a caller-owned transaction; the m3u importer
//! uses it to write live, radio and movies in one streaming pass).
//! Readers: [`categories`], [`query`], [`get`], [`search`] plus the helpers
//! behind the rpc commands (neighbors, channel by number, recently added,
//! same title). See `docs/architecture/catalog.md`.

pub mod rpc;
mod title;

pub use title::title_base;

use crate::error::{CoreError, CoreResult};
use crate::model::{
    ArchiveInfo, CatchupInfo, Category, Channel, ContentType, ItemRef, Page, PageQuery,
    RequestHeaders, SeriesItem, SortDir, SortKey, SourceKind, VodItem,
};
use crate::state::AppState;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Largest page a paged query returns.
pub const MAX_PAGE_LIMIT: i64 = 1000;
/// Cap of [`all_live_channels`] (remote control publication).
pub const ALL_LIVE_CAP: usize = 20_000;
/// Name given to categories that items reference but the importer never declared.
pub const FALLBACK_CATEGORY_NAME: &str = "Uncategorized";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/// One `items` row. Importers build these; readers return them.
///
/// `extra` holds kind-specific fields. Keys the readers understand (camelCase):
/// `plot` (string), `genres` (string array), `durationSeconds` (number),
/// `tmdbId` (number), `catchup` (object `{type, days?, source?}`; enables
/// archive when [`catchup_usable`]), `headers` (object with
/// userAgent/referrer/origin; per-channel overrides).
#[derive(Debug, Clone, PartialEq)]
pub struct ItemRow {
    pub source_id: String,
    pub content_type: ContentType,
    pub item_id: String,
    pub category_id: String,
    pub title: String,
    pub title_base: Option<String>,
    pub number: Option<i64>,
    pub logo_url: Option<String>,
    pub poster_url: Option<String>,
    pub backdrop_url: Option<String>,
    pub rating: Option<f64>,
    pub added: Option<String>,
    pub year: Option<i64>,
    pub epg_channel_id: Option<String>,
    pub url: Option<String>,
    pub container_extension: Option<String>,
    pub is_radio: bool,
    pub archive_hours: Option<i64>,
    pub extra: serde_json::Value,
    pub position: i64,
}

impl Default for ItemRow {
    fn default() -> Self {
        Self {
            source_id: String::new(),
            content_type: ContentType::Live,
            item_id: String::new(),
            category_id: String::new(),
            title: String::new(),
            title_base: None,
            number: None,
            logo_url: None,
            poster_url: None,
            backdrop_url: None,
            rating: None,
            added: None,
            year: None,
            epg_channel_id: None,
            url: None,
            container_extension: None,
            is_radio: false,
            archive_hours: None,
            extra: serde_json::Value::Object(Default::default()),
            position: 0,
        }
    }
}

impl ItemRow {
    /// The item's reference.
    pub fn item_ref(&self) -> ItemRef {
        ItemRef::new(
            self.source_id.clone(),
            self.content_type,
            self.item_id.clone(),
        )
    }

    fn extra_str(&self, key: &str) -> Option<String> {
        self.extra
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_owned)
    }

    fn extra_i64(&self, key: &str) -> Option<i64> {
        let v = self.extra.get(key)?;
        v.as_i64()
            .or_else(|| v.as_f64().map(|f| f as i64))
            .or_else(|| v.as_str()?.trim().parse().ok())
    }

    fn extra_genres(&self) -> Option<Vec<String>> {
        match self.extra.get("genres")? {
            serde_json::Value::Array(a) => {
                let v: Vec<String> = a
                    .iter()
                    .filter_map(|g| {
                        g.as_str()
                            .map(str::trim)
                            .filter(|g| !g.is_empty())
                            .map(str::to_owned)
                    })
                    .collect();
                (!v.is_empty()).then_some(v)
            }
            serde_json::Value::String(s) => {
                let v: Vec<String> = s
                    .split([',', '/', '|'])
                    .map(str::trim)
                    .filter(|g| !g.is_empty())
                    .map(str::to_owned)
                    .collect();
                (!v.is_empty()).then_some(v)
            }
            _ => None,
        }
    }

    /// Per-channel headers from `extra.headers` (blank values dropped).
    pub fn headers(&self) -> Option<RequestHeaders> {
        let h = self.extra.get("headers")?;
        let field = |k: &str| {
            h.get(k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        let out = RequestHeaders {
            user_agent: field("userAgent"),
            referrer: field("referrer"),
            origin: field("origin"),
        };
        (!out.is_empty()).then_some(out)
    }

    /// Catch-up attributes from `extra.catchup` (type lowercased).
    pub fn catchup(&self) -> Option<CatchupInfo> {
        let c = self.extra.get("catchup")?;
        if !c.is_object() {
            return None;
        }
        let kind = c
            .get("type")
            .and_then(|v| v.as_str())
            .map(|t| t.trim().to_ascii_lowercase())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "default".into());
        let days = c.get("days").and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_f64().map(|f| f as i64))
                .or_else(|| v.as_str()?.trim().parse().ok())
        });
        let source = c
            .get("source")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned);
        Some(CatchupInfo { kind, days, source })
    }

    fn archive(&self) -> Option<ArchiveInfo> {
        match self.archive_hours {
            Some(h) if h > 0 => Some(ArchiveInfo {
                enabled: true,
                duration_hours: Some(h),
            }),
            _ if self.catchup().is_some_and(|c| catchup_usable(&c.kind)) => Some(ArchiveInfo {
                enabled: true,
                duration_hours: None,
            }),
            _ => None,
        }
    }
}

/// Catch-up types a client can build archive URLs for. `default` and
/// `append` use `catchup-source` when present and otherwise the standard
/// `?utc={utc}&lutc={lutc}` convention; `shift` always uses that convention;
/// `xc` and the flussonic variants derive the URL from the stream URL.
pub const CATCHUP_TYPES: [&str; 7] = [
    "default",
    "append",
    "shift",
    "xc",
    "flussonic",
    "flussonic-hls",
    "flussonic-ts",
];

/// True when a catch-up `type` (case-insensitive) is one clients can play.
/// `fs` is accepted as the common alias of `flussonic`.
pub fn catchup_usable(kind: &str) -> bool {
    let k = kind.trim().to_ascii_lowercase();
    k == "fs" || CATCHUP_TYPES.contains(&k.as_str())
}

/// One category to write with [`replace_catalog`] / [`CatalogWriter::finish`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CategoryRow {
    pub category_id: String,
    pub name: String,
    pub position: i64,
}

/// Paged query over one source and content type.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogQuery {
    pub source_id: String,
    pub content_type: ContentType,
    pub category_id: Option<String>,
    pub page: PageQuery,
    pub include_hidden: bool,
    /// Keep only items rated at least this (unrated items drop out). `None`
    /// or a value <= 0 disables the filter.
    pub min_rating: Option<f64>,
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

impl From<ItemRow> for Channel {
    fn from(r: ItemRow) -> Self {
        let archive = r.archive();
        let headers = r.headers();
        let catchup = r.catchup();
        let is_radio = r.is_radio || r.content_type == ContentType::Radio;
        Channel {
            item_ref: ItemRef::new(r.source_id, r.content_type, r.item_id),
            name: r.title,
            number: r.number,
            logo_url: r.logo_url.or(r.poster_url),
            category_id: r.category_id,
            category_name: String::new(),
            epg_channel_id: r.epg_channel_id,
            url: r.url,
            is_radio,
            archive,
            headers,
            catchup,
        }
    }
}

impl From<ItemRow> for VodItem {
    fn from(r: ItemRow) -> Self {
        let plot = r.extra_str("plot");
        let genres = r.extra_genres();
        let duration_seconds = r.extra_i64("durationSeconds");
        let tmdb_id = r.extra_i64("tmdbId");
        VodItem {
            item_ref: ItemRef::new(r.source_id, r.content_type, r.item_id),
            title: r.title,
            title_base: r.title_base,
            year: r.year,
            poster_url: r.poster_url.or(r.logo_url),
            backdrop_url: r.backdrop_url,
            rating: r.rating,
            added: r.added,
            category_id: r.category_id,
            category_name: None,
            container_extension: r.container_extension,
            duration_seconds,
            plot,
            genres,
            tmdb_id,
        }
    }
}

impl From<ItemRow> for SeriesItem {
    fn from(r: ItemRow) -> Self {
        let plot = r.extra_str("plot");
        let genres = r.extra_genres();
        let tmdb_id = r.extra_i64("tmdbId");
        SeriesItem {
            item_ref: ItemRef::new(r.source_id, r.content_type, r.item_id),
            title: r.title,
            title_base: r.title_base,
            year: r.year,
            poster_url: r.poster_url.or(r.logo_url),
            backdrop_url: r.backdrop_url,
            rating: r.rating,
            added: r.added,
            category_id: r.category_id,
            category_name: None,
            plot,
            genres,
            tmdb_id,
        }
    }
}

/// An item row plus the name of its category (joined on read).
#[derive(Debug, Clone, PartialEq)]
pub struct NamedRow {
    pub row: ItemRow,
    pub category_name: Option<String>,
}

impl NamedRow {
    pub fn into_channel(self) -> Channel {
        let name = self.category_name.unwrap_or_default();
        let mut c = Channel::from(self.row);
        c.category_name = name;
        c
    }
    pub fn into_vod(self) -> VodItem {
        let name = self.category_name;
        let mut v = VodItem::from(self.row);
        v.category_name = name;
        v
    }
    pub fn into_series(self) -> SeriesItem {
        let name = self.category_name;
        let mut s = SeriesItem::from(self.row);
        s.category_name = name;
        s
    }
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

const INSERT_ITEM_SQL: &str = "INSERT OR IGNORE INTO items (source_id, content_type, item_id, category_id, title, title_base, number, logo_url, poster_url, backdrop_url, rating, added, year, epg_channel_id, url, container_extension, is_radio, archive_hours, extra_json, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)";

/// Rows inserted between progress callbacks / statement resets.
pub const WRITE_BATCH: u64 = 1000;

/// Streaming catalog writer over a caller-owned transaction.
///
/// `begin` deletes the existing categories and items of the given content
/// types (remembering which categories were hidden), `insert` adds items
/// through one prepared statement, `finish` writes the categories (restoring
/// `hidden`, adding fallback categories for ids items referenced but nobody
/// declared), recomputes `item_count`, and refreshes `source_counts`.
/// Dropping the transaction without committing restores the previous catalog.
pub struct CatalogWriter<'c> {
    conn: &'c Connection,
    source_id: String,
    types: Vec<ContentType>,
    hidden: HashMap<ContentType, HashSet<String>>,
    seen_categories: HashMap<ContentType, HashSet<String>>,
    inserted: HashMap<ContentType, u64>,
    total: u64,
    duplicates: u64,
}

impl<'c> CatalogWriter<'c> {
    /// Starts a rewrite of `types` for `source_id`. `conn` should be inside a
    /// transaction (one write transaction per source import).
    pub fn begin(conn: &'c Connection, source_id: &str, types: &[ContentType]) -> CoreResult<Self> {
        let mut hidden: HashMap<ContentType, HashSet<String>> = HashMap::new();
        {
            let mut stmt = conn.prepare_cached(
                "SELECT category_id FROM categories WHERE source_id = ?1 AND content_type = ?2 AND hidden = 1",
            )?;
            for ct in types {
                let ids = stmt
                    .query_map(params![source_id, ct.as_str()], |r| r.get::<_, String>(0))?
                    .collect::<Result<HashSet<_>, _>>()?;
                hidden.insert(*ct, ids);
            }
        }
        if conn.is_autocommit() {
            return Err(CoreError::Invalid(
                "CatalogWriter must run inside a transaction".into(),
            ));
        }
        // Per-row FTS triggers are suspended for this source until `finish`;
        // the index is updated in bulk instead (see migration 0002).
        conn.execute(
            "INSERT OR IGNORE INTO fts_suspend (source_id) VALUES (?1)",
            [source_id],
        )?;
        for ct in types {
            conn.execute(
                "INSERT INTO items_fts (items_fts, rowid, title) SELECT 'delete', rowid, title FROM items WHERE source_id = ?1 AND content_type = ?2",
                params![source_id, ct.as_str()],
            )?;
            conn.execute(
                "DELETE FROM items WHERE source_id = ?1 AND content_type = ?2",
                params![source_id, ct.as_str()],
            )?;
            conn.execute(
                "DELETE FROM categories WHERE source_id = ?1 AND content_type = ?2",
                params![source_id, ct.as_str()],
            )?;
        }
        Ok(Self {
            conn,
            source_id: source_id.to_string(),
            types: types.to_vec(),
            hidden,
            seen_categories: HashMap::new(),
            inserted: HashMap::new(),
            total: 0,
            duplicates: 0,
        })
    }

    /// Inserts one item. The row's `source_id` is ignored (the writer's wins).
    /// Movie/series rows without `title_base` get it from [`title_base`];
    /// a duplicate `(content_type, item_id)` keeps the first row.
    /// Returns true when the row was inserted.
    pub fn insert(&mut self, item: &ItemRow) -> CoreResult<bool> {
        if !self.types.contains(&item.content_type) {
            return Err(CoreError::Invalid(format!(
                "catalog writer for {:?} got a {} item",
                self.types, item.content_type
            )));
        }
        let derived = match (&item.title_base, item.content_type) {
            (None, ContentType::Movie | ContentType::Series) => Some(title_base(&item.title)),
            _ => None,
        };
        let (tb, year) = match &derived {
            Some((base, y)) => (Some(base.as_str()), item.year.or(*y)),
            None => (item.title_base.as_deref(), item.year),
        };
        let extra = if item.extra.as_object().is_some_and(|o| o.is_empty()) || item.extra.is_null()
        {
            "{}".to_string()
        } else {
            item.extra.to_string()
        };
        let mut stmt = self.conn.prepare_cached(INSERT_ITEM_SQL)?;
        let n = stmt.execute(params![
            self.source_id,
            item.content_type.as_str(),
            item.item_id,
            item.category_id,
            item.title,
            tb,
            item.number,
            item.logo_url,
            item.poster_url,
            item.backdrop_url,
            item.rating.filter(|r| r.is_finite()),
            item.added,
            year,
            item.epg_channel_id,
            item.url,
            item.container_extension,
            item.is_radio,
            item.archive_hours,
            extra,
            item.position,
        ])?;
        if n == 0 {
            self.duplicates += 1;
            return Ok(false);
        }
        let seen = self.seen_categories.entry(item.content_type).or_default();
        if !seen.contains(item.category_id.as_str()) {
            seen.insert(item.category_id.clone());
        }
        *self.inserted.entry(item.content_type).or_default() += 1;
        self.total += 1;
        Ok(true)
    }

    /// Items inserted so far.
    pub fn inserted(&self) -> u64 {
        self.total
    }

    /// Items inserted so far for one content type.
    pub fn inserted_of(&self, ct: ContentType) -> u64 {
        self.inserted.get(&ct).copied().unwrap_or(0)
    }

    /// Rows skipped because their `(content_type, item_id)` was already written.
    pub fn duplicates(&self) -> u64 {
        self.duplicates
    }

    /// Writes categories, restores hidden flags, recomputes counts. Returns the
    /// number of items written. Does not commit.
    pub fn finish(self, categories: &[(ContentType, Vec<CategoryRow>)]) -> CoreResult<u64> {
        let mut insert_cat = self.conn.prepare_cached(
            "INSERT OR IGNORE INTO categories (source_id, content_type, category_id, name, hidden, position, item_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
        )?;
        for ct in &self.types {
            let hidden = self.hidden.get(ct);
            let mut declared: HashSet<&str> = HashSet::new();
            let mut next_pos = 0i64;
            let rows = categories
                .iter()
                .filter(|(t, _)| t == ct)
                .flat_map(|(_, v)| v.iter());
            for c in rows {
                declared.insert(c.category_id.as_str());
                next_pos = next_pos.max(c.position + 1);
                let is_hidden = hidden.is_some_and(|h| h.contains(&c.category_id));
                let name = if c.name.trim().is_empty() {
                    FALLBACK_CATEGORY_NAME
                } else {
                    c.name.trim()
                };
                insert_cat.execute(params![
                    self.source_id,
                    ct.as_str(),
                    c.category_id,
                    name,
                    is_hidden,
                    c.position
                ])?;
            }
            if let Some(seen) = self.seen_categories.get(ct) {
                let mut missing: Vec<&String> = seen
                    .iter()
                    .filter(|id| !declared.contains(id.as_str()))
                    .collect();
                missing.sort();
                for id in missing {
                    let is_hidden = hidden.is_some_and(|h| h.contains(id));
                    insert_cat.execute(params![
                        self.source_id,
                        ct.as_str(),
                        id,
                        FALLBACK_CATEGORY_NAME,
                        is_hidden,
                        next_pos
                    ])?;
                    next_pos += 1;
                }
            }
            self.conn.execute(
                "UPDATE categories SET item_count = (SELECT count(*) FROM items i WHERE i.source_id = categories.source_id AND i.content_type = categories.content_type AND i.category_id = categories.category_id) WHERE source_id = ?1 AND content_type = ?2",
                params![self.source_id, ct.as_str()],
            )?;
        }
        for ct in &self.types {
            self.conn.execute(
                "INSERT INTO items_fts (rowid, title) SELECT rowid, title FROM items WHERE source_id = ?1 AND content_type = ?2",
                params![self.source_id, ct.as_str()],
            )?;
        }
        self.conn.execute(
            "DELETE FROM fts_suspend WHERE source_id = ?1",
            [&self.source_id],
        )?;
        update_counts(self.conn, &self.source_id)?;
        Ok(self.total)
    }
}

/// Replaces the catalog of one `(source, content_type)` in one transaction:
/// deletes categories and items, inserts categories (preserving `hidden` for
/// ids that existed), inserts items via a prepared statement, recomputes
/// `item_count` and the source counts. Returns the number of items written.
/// On error nothing changes.
pub fn replace_catalog(
    conn: &mut Connection,
    source_id: &str,
    content_type: ContentType,
    categories: &[CategoryRow],
    items: &mut dyn Iterator<Item = ItemRow>,
) -> CoreResult<u64> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let n = {
        let mut w = CatalogWriter::begin(&tx, source_id, &[content_type])?;
        for item in items {
            w.insert(&item)?;
        }
        w.finish(&[(content_type, categories.to_vec())])?
    };
    tx.commit()?;
    Ok(n)
}

/// Recomputes `source_counts` for one source (channels = live only; the
/// radio count is read from `items` by the source readers).
///
/// Stalker portals serve VOD and series live (only their categories are
/// stored), so for stalker sources the movie and series counts are the portal
/// totals recorded by [`set_remote_counts`] and are left untouched here.
pub fn update_counts(conn: &Connection, source_id: &str) -> CoreResult<()> {
    let mut counts: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT content_type, count(*) FROM items WHERE source_id = ?1 GROUP BY content_type",
        )?;
        let rows = stmt.query_map([source_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (ct, n) = row?;
            counts.insert(ct, n);
        }
    }
    let get = |k: &str| counts.get(k).copied().unwrap_or(0);
    let kind: Option<String> = conn
        .query_row("SELECT kind FROM sources WHERE id = ?1", [source_id], |r| {
            r.get(0)
        })
        .optional()?;
    let Some(kind) = kind else {
        return Ok(());
    };
    if kind == SourceKind::Stalker.as_str() {
        conn.execute(
            "INSERT INTO source_counts (source_id, channel_count, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
             ON CONFLICT(source_id) DO UPDATE SET channel_count = excluded.channel_count, updated_at = excluded.updated_at",
            params![source_id, get("live")],
        )?;
        return Ok(());
    }
    conn.execute(
        "INSERT INTO source_counts (source_id, channel_count, movie_count, series_count, updated_at) VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
         ON CONFLICT(source_id) DO UPDATE SET channel_count = excluded.channel_count, movie_count = excluded.movie_count, series_count = excluded.series_count, updated_at = excluded.updated_at",
        params![source_id, get("live"), get("movie"), get("series")],
    )?;
    Ok(())
}

/// Records movie and series totals for a source whose VOD is not stored
/// locally (stalker: the importer's `ImportSummary` carries the portal
/// totals). Negative values are clamped to 0. No-op for an unknown source.
pub fn set_remote_counts(
    conn: &Connection,
    source_id: &str,
    movies: i64,
    series: i64,
) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO source_counts (source_id, movie_count, series_count, updated_at)
         SELECT id, ?2, ?3, CURRENT_TIMESTAMP FROM sources WHERE id = ?1
         ON CONFLICT(source_id) DO UPDATE SET movie_count = excluded.movie_count, series_count = excluded.series_count, updated_at = excluded.updated_at",
        params![source_id, movies.max(0), series.max(0)],
    )?;
    Ok(())
}

/// Number of radio stations of one source.
pub fn radio_count(conn: &Connection, source_id: &str) -> CoreResult<i64> {
    Ok(conn.query_row(
        "SELECT count(*) FROM items WHERE source_id = ?1 AND content_type = 'radio'",
        [source_id],
        |r| r.get(0),
    )?)
}

/// Cached counts of one source: `(live channels, movies, series)`.
pub fn source_counts(conn: &Connection, source_id: &str) -> CoreResult<(i64, i64, i64)> {
    Ok(conn
        .query_row(
            "SELECT channel_count, movie_count, series_count FROM source_counts WHERE source_id = ?1",
            [source_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .unwrap_or((0, 0, 0)))
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/// Categories of one source and content type, ordered by position.
pub fn categories(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
    include_hidden: bool,
) -> CoreResult<Vec<Category>> {
    let sql = if include_hidden {
        "SELECT category_id, name, hidden, item_count, position FROM categories WHERE source_id = ?1 AND content_type = ?2 ORDER BY position, name COLLATE NOCASE"
    } else {
        "SELECT category_id, name, hidden, item_count, position FROM categories WHERE source_id = ?1 AND content_type = ?2 AND hidden = 0 ORDER BY position, name COLLATE NOCASE"
    };
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map(params![source_id, content_type.as_str()], |r| {
        Ok(Category {
            id: r.get(0)?,
            source_id: source_id.to_string(),
            content_type,
            name: r.get(1)?,
            hidden: r.get(2)?,
            item_count: r.get(3)?,
            position: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Sets `hidden` on one category. NotFound when it does not exist.
pub fn set_category_hidden(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
    category_id: &str,
    hidden: bool,
) -> CoreResult<()> {
    let n = conn.execute(
        "UPDATE categories SET hidden = ?4 WHERE source_id = ?1 AND content_type = ?2 AND category_id = ?3",
        params![source_id, content_type.as_str(), category_id, hidden],
    )?;
    if n == 0 {
        return Err(CoreError::NotFound(format!(
            "category {category_id} not found"
        )));
    }
    Ok(())
}

/// Replaces the hidden set of one source and content type. Unknown ids are ignored.
pub fn set_categories_hidden(
    conn: &mut Connection,
    source_id: &str,
    content_type: ContentType,
    hidden_ids: &[String],
) -> CoreResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        "UPDATE categories SET hidden = 0 WHERE source_id = ?1 AND content_type = ?2",
        params![source_id, content_type.as_str()],
    )?;
    {
        let mut stmt = tx.prepare_cached(
            "UPDATE categories SET hidden = 1 WHERE source_id = ?1 AND content_type = ?2 AND category_id = ?3",
        )?;
        for id in hidden_ids {
            stmt.execute(params![source_id, content_type.as_str(), id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const SELECT_NAMED: &str = "SELECT i.source_id, i.content_type, i.item_id, i.category_id, i.title, i.title_base, i.number, i.logo_url, i.poster_url, i.backdrop_url, i.rating, i.added, i.year, i.epg_channel_id, i.url, i.container_extension, i.is_radio, i.archive_hours, i.extra_json, i.position, c.name FROM items i LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id";

fn read_named(r: &Row<'_>) -> rusqlite::Result<NamedRow> {
    let ct: String = r.get(1)?;
    let content_type = ct.parse::<ContentType>().map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            1,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::other(e.to_string())),
        )
    })?;
    let extra: String = r.get(18)?;
    let extra = if extra == "{}" || extra.is_empty() {
        serde_json::Value::Object(Default::default())
    } else {
        serde_json::from_str(&extra)
            .unwrap_or_else(|_| serde_json::Value::Object(Default::default()))
    };
    Ok(NamedRow {
        row: ItemRow {
            source_id: r.get(0)?,
            content_type,
            item_id: r.get(2)?,
            category_id: r.get(3)?,
            title: r.get(4)?,
            title_base: r.get(5)?,
            number: r.get(6)?,
            logo_url: r.get(7)?,
            poster_url: r.get(8)?,
            backdrop_url: r.get(9)?,
            rating: r.get(10)?,
            added: r.get(11)?,
            year: r.get(12)?,
            epg_channel_id: r.get(13)?,
            url: r.get(14)?,
            container_extension: r.get(15)?,
            is_radio: r.get(16)?,
            archive_hours: r.get(17)?,
            extra,
            position: r.get(19)?,
        },
        category_name: r.get(20)?,
    })
}

/// Builds an FTS5 prefix query from free text: every word becomes a quoted
/// prefix term (`"bbc"* "one"*`). `None` when the text has no word characters.
pub fn fts_query(text: &str) -> Option<String> {
    let terms: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .take(16)
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

/// `%text%` with LIKE wildcards escaped (use with `ESCAPE '\'`).
pub fn like_pattern(text: &str) -> String {
    let mut s = String::with_capacity(text.len() + 2);
    s.push('%');
    for c in text.trim().chars() {
        if matches!(c, '%' | '_' | '\\') {
            s.push('\\');
        }
        s.push(c);
    }
    s.push('%');
    s
}

/// Text match strategy for a search term.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Match {
    Fts,
    Like,
}

fn order_clause(page: &PageQuery) -> String {
    let dir = |default: SortDir| match page.dir.unwrap_or(default) {
        SortDir::Asc => "ASC",
        SortDir::Desc => "DESC",
    };
    match page.sort {
        None => format!("i.position {}", dir(SortDir::Asc)),
        Some(SortKey::Name) => format!("i.title COLLATE NOCASE {}, i.position", dir(SortDir::Asc)),
        Some(SortKey::Number) => format!("i.number {} NULLS LAST, i.position", dir(SortDir::Asc)),
        Some(SortKey::Added) => format!("i.added {} NULLS LAST, i.position", dir(SortDir::Desc)),
        Some(SortKey::Rating) => format!("i.rating {} NULLS LAST, i.position", dir(SortDir::Desc)),
        Some(SortKey::Year) => format!("i.year {} NULLS LAST, i.position", dir(SortDir::Desc)),
    }
}

fn clamp_page(page: &PageQuery) -> (i64, i64) {
    (page.offset.max(0), page.limit.clamp(1, MAX_PAGE_LIMIT))
}

/// Paged items of one source/content type with optional category, search
/// (FTS word-prefix match, falling back to substring LIKE when the prefix
/// match finds nothing), optional minimum rating, and sort. Without a
/// category, items in hidden categories are excluded unless `include_hidden`.
pub fn query(conn: &Connection, q: &CatalogQuery) -> CoreResult<Page<ItemRow>> {
    Ok(query_named(conn, q)?.map(|n| n.row))
}

/// [`query`] with category names joined.
pub fn query_named(conn: &Connection, q: &CatalogQuery) -> CoreResult<Page<NamedRow>> {
    let (offset, limit) = clamp_page(&q.page);
    let search = q
        .page
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let attempts: &[Match] = match search {
        None => &[Match::Fts],
        Some(s) if fts_query(s).is_some() => &[Match::Fts, Match::Like],
        Some(_) => &[Match::Like],
    };
    for (i, m) in attempts.iter().enumerate() {
        let mut where_sql = String::from("i.source_id = ?1 AND i.content_type = ?2");
        let mut args: Vec<SqlValue> = vec![
            q.source_id.clone().into(),
            q.content_type.as_str().to_string().into(),
        ];
        if let Some(cat) = &q.category_id {
            args.push(cat.clone().into());
            where_sql.push_str(&format!(" AND i.category_id = ?{}", args.len()));
        } else if !q.include_hidden {
            // Same rows as `COALESCE(c.hidden, 0) = 0` on the join, but without
            // a categories lookup per item, so the count below needs no join.
            where_sql.push_str(" AND i.category_id NOT IN (SELECT category_id FROM categories WHERE source_id = ?1 AND content_type = ?2 AND hidden = 1)");
        }
        if let Some(min) = q.min_rating.filter(|r| r.is_finite() && *r > 0.0) {
            args.push(min.into());
            where_sql.push_str(&format!(" AND i.rating >= ?{}", args.len()));
        }
        if let Some(s) = search {
            match m {
                Match::Fts => {
                    args.push(fts_query(s).unwrap_or_default().into());
                    where_sql.push_str(&format!(
                        " AND i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?{})",
                        args.len()
                    ));
                }
                Match::Like => {
                    args.push(like_pattern(s).into());
                    where_sql.push_str(&format!(" AND i.title LIKE ?{} ESCAPE '\\'", args.len()));
                }
            }
        }
        let count_sql = format!("SELECT count(*) FROM items i WHERE {where_sql}");
        let total: i64 = conn
            .prepare_cached(&count_sql)?
            .query_row(rusqlite::params_from_iter(args.iter()), |r| r.get(0))?;
        if total == 0 && i + 1 < attempts.len() {
            continue;
        }
        // LIMIT/OFFSET are bound, not formatted in, so every page of a list
        // reuses one cached statement instead of compiling (and evicting) its own.
        let n = args.len();
        let sql = format!(
            "{SELECT_NAMED} WHERE {where_sql} ORDER BY {} LIMIT ?{} OFFSET ?{}",
            order_clause(&q.page),
            n + 1,
            n + 2
        );
        args.push(limit.into());
        args.push(offset.into());
        let mut stmt = conn.prepare_cached(&sql)?;
        let items = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), read_named)?
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(Page {
            items,
            total,
            offset,
            limit,
        });
    }
    Ok(Page::empty(offset, limit))
}

/// One item by reference.
pub fn get(conn: &Connection, r: &ItemRef) -> CoreResult<Option<ItemRow>> {
    Ok(get_named(conn, r)?.map(|n| n.row))
}

/// [`get`] with the category name joined.
pub fn get_named(conn: &Connection, r: &ItemRef) -> CoreResult<Option<NamedRow>> {
    let sql =
        format!("{SELECT_NAMED} WHERE i.source_id = ?1 AND i.content_type = ?2 AND i.item_id = ?3");
    let mut stmt = conn.prepare_cached(&sql)?;
    Ok(stmt
        .query_row(
            params![r.source_id, r.content_type.as_str(), r.item_id],
            read_named,
        )
        .optional()?)
}

/// Global search: FTS word-prefix match (LIKE substring fallback when the
/// prefix match finds nothing), items in hidden categories excluded, best
/// matches first. `types` empty means every type. `limit` applies per call.
pub fn search(
    conn: &Connection,
    query: &str,
    source_id: Option<&str>,
    types: &[ContentType],
    limit: usize,
) -> CoreResult<Vec<ItemRow>> {
    Ok(search_named(conn, query, source_id, types, limit)?
        .into_iter()
        .map(|n| n.row)
        .collect())
}

/// [`search`] with category names joined.
pub fn search_named(
    conn: &Connection,
    query: &str,
    source_id: Option<&str>,
    types: &[ContentType],
    limit: usize,
) -> CoreResult<Vec<NamedRow>> {
    let text = query.trim();
    if text.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let types: Vec<ContentType> = if types.is_empty() {
        ContentType::ALL.to_vec()
    } else {
        types.to_vec()
    };
    // Search lists may hold one probe row past the 1000-row UI step.
    let limit = limit.min(rpc::MAX_SEARCH_LIMIT);
    let fts = fts_query(text);

    let mut filter = String::from(" AND COALESCE(c.hidden, 0) = 0");
    let mut base_args: Vec<SqlValue> = Vec::new();
    let placeholders: Vec<String> = types
        .iter()
        .map(|t| {
            base_args.push(t.as_str().to_string().into());
            format!("?{}", base_args.len() + 1)
        })
        .collect();
    filter.push_str(&format!(
        " AND i.content_type IN ({})",
        placeholders.join(", ")
    ));
    if let Some(sid) = source_id {
        base_args.push(sid.to_string().into());
        filter.push_str(&format!(" AND i.source_id = ?{}", base_args.len() + 1));
    }

    if let Some(fq) = &fts {
        let sql = format!(
            "{SELECT_NAMED} JOIN items_fts ON items_fts.rowid = i.rowid WHERE items_fts MATCH ?1{filter} ORDER BY items_fts.rank, length(i.title), i.position LIMIT {limit}"
        );
        let mut args: Vec<SqlValue> = vec![fq.clone().into()];
        args.extend(base_args.iter().cloned());
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), read_named)?
            .collect::<Result<Vec<_>, _>>()?;
        if !rows.is_empty() {
            return Ok(rows);
        }
    }
    let sql = format!(
        "{SELECT_NAMED} WHERE i.title LIKE ?1 ESCAPE '\\'{filter} ORDER BY length(i.title), i.title COLLATE NOCASE LIMIT {limit}"
    );
    let mut args: Vec<SqlValue> = vec![like_pattern(text).into()];
    args.extend(base_args);
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), read_named)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// First channel with `number` in playlist order, skipping hidden
/// categories. `content_type` restricts the lookup to live or radio; `None`
/// searches both, live first.
pub fn channel_by_number(
    conn: &Connection,
    source_id: &str,
    number: i64,
    content_type: Option<ContentType>,
) -> CoreResult<Option<NamedRow>> {
    let types = match content_type {
        None => "'live', 'radio'",
        Some(ContentType::Live) => "'live'",
        Some(ContentType::Radio) => "'radio'",
        Some(other) => {
            return Err(CoreError::Invalid(format!(
                "channelByNumber supports contentType 'live' or 'radio', not '{other}'"
            )))
        }
    };
    let sql = format!(
        "{SELECT_NAMED} WHERE i.source_id = ?1 AND i.number = ?2 AND i.content_type IN ({types}) AND COALESCE(c.hidden, 0) = 0 ORDER BY CASE i.content_type WHEN 'live' THEN 0 ELSE 1 END, i.position LIMIT 1"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    Ok(stmt
        .query_row(params![source_id, number], read_named)
        .optional()?)
}

/// Previous and next channel around `r` in playlist order, inside `category_id`
/// when given (else across visible categories). Wraps around at both ends.
pub fn neighbors(
    conn: &Connection,
    r: &ItemRef,
    category_id: Option<&str>,
) -> CoreResult<(Option<NamedRow>, Option<NamedRow>)> {
    let Some(current) = get(conn, r)? else {
        return Err(CoreError::NotFound(format!("item {} not found", r.item_id)));
    };
    let mut scope = String::from("i.source_id = ?1 AND i.content_type = ?2");
    let mut args: Vec<SqlValue> = vec![
        r.source_id.clone().into(),
        r.content_type.as_str().to_string().into(),
    ];
    match category_id {
        Some(cat) => {
            args.push(cat.to_string().into());
            scope.push_str(&format!(" AND i.category_id = ?{}", args.len()));
        }
        None => scope.push_str(" AND COALESCE(c.hidden, 0) = 0"),
    }
    let pos_idx = args.len() + 1;
    let id_idx = args.len() + 2;
    let pick = |cmp: &str, order: &str, wrap: bool| -> CoreResult<Option<NamedRow>> {
        let mut a = args.clone();
        let sql = if wrap {
            format!("{SELECT_NAMED} WHERE {scope} AND i.item_id <> ?{pos_idx} ORDER BY i.position {order}, i.item_id {order} LIMIT 1")
        } else {
            format!(
                "{SELECT_NAMED} WHERE {scope} AND (i.position {cmp} ?{pos_idx} OR (i.position = ?{pos_idx} AND i.item_id {cmp} ?{id_idx})) ORDER BY i.position {order}, i.item_id {order} LIMIT 1"
            )
        };
        if wrap {
            a.push(current.item_id.clone().into());
        } else {
            a.push(current.position.into());
            a.push(current.item_id.clone().into());
        }
        let mut stmt = conn.prepare_cached(&sql)?;
        Ok(stmt
            .query_row(rusqlite::params_from_iter(a.iter()), read_named)
            .optional()?)
    };
    let prev = match pick("<", "DESC", false)? {
        Some(p) => Some(p),
        None => pick("<", "DESC", true)?,
    };
    let next = match pick(">", "ASC", false)? {
        Some(n) => Some(n),
        None => pick(">", "ASC", true)?,
    };
    Ok((prev, next))
}

/// Most recently added movies or series (rows with an `added` date), hidden
/// categories excluded.
pub fn recently_added(
    conn: &Connection,
    source_id: Option<&str>,
    content_type: ContentType,
    limit: usize,
) -> CoreResult<Vec<NamedRow>> {
    let limit = limit.clamp(1, MAX_PAGE_LIMIT as usize);
    let mut args: Vec<SqlValue> = vec![content_type.as_str().to_string().into()];
    let mut sql = format!("{SELECT_NAMED} WHERE i.content_type = ?1 AND i.added IS NOT NULL AND COALESCE(c.hidden, 0) = 0");
    if let Some(sid) = source_id {
        args.push(sid.to_string().into());
        sql.push_str(" AND i.source_id = ?2");
    }
    sql.push_str(&format!(" ORDER BY i.added DESC, i.position LIMIT {limit}"));
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), read_named)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Movies in other sources with the same base title (case-insensitive) and a
/// compatible year (equal, or unknown on either side).
pub fn same_title(conn: &Connection, r: &ItemRef) -> CoreResult<Vec<NamedRow>> {
    let Some(item) = get(conn, r)? else {
        return Err(CoreError::NotFound(format!("item {} not found", r.item_id)));
    };
    let (derived, derived_year) = title_base(&item.title);
    let base = item.title_base.clone().unwrap_or(derived);
    let year = item.year.or(derived_year);
    if base.trim().is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "{SELECT_NAMED} WHERE i.content_type = ?1 AND i.title_base = ?2 COLLATE NOCASE AND i.source_id <> ?3 AND (?4 IS NULL OR i.year IS NULL OR i.year = ?4) ORDER BY i.source_id, i.position LIMIT 50"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt
        .query_map(
            params![r.content_type.as_str(), base, r.source_id, year],
            read_named,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Every visible live channel of a source in playlist order (capped at 20 000).
pub fn all_live_channels(conn: &Connection, source_id: &str) -> CoreResult<Vec<NamedRow>> {
    let sql = format!(
        "{SELECT_NAMED} WHERE i.source_id = ?1 AND i.content_type = 'live' AND COALESCE(c.hidden, 0) = 0 ORDER BY i.position LIMIT {ALL_LIVE_CAP}"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt
        .query_map([source_id], read_named)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// The catalog module has no background runtime.
pub async fn init(_state: Arc<AppState>) -> CoreResult<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> (tempfile::TempDir, crate::db::DbPool) {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open_and_migrate(&dir.path().join("t.db")).unwrap();
        pool.get()
            .unwrap()
            .execute(
                "INSERT INTO sources(id, kind, name, config_json) VALUES ('s', 'm3u', 'S', '{}')",
                [],
            )
            .unwrap();
        (dir, pool)
    }

    fn item(id: &str, cat: &str, title: &str, pos: i64) -> ItemRow {
        ItemRow {
            source_id: "s".into(),
            item_id: id.into(),
            category_id: cat.into(),
            title: title.into(),
            position: pos,
            ..Default::default()
        }
    }

    #[test]
    fn fts_query_quotes_terms() {
        assert_eq!(fts_query("bbc one").as_deref(), Some("\"bbc\"* \"one\"*"));
        assert_eq!(fts_query("+1 \"x").as_deref(), Some("\"1\"* \"x\"*"));
        assert_eq!(fts_query("  -- "), None);
        assert_eq!(like_pattern("50%_a"), "%50\\%\\_a%");
    }

    #[test]
    fn writer_preserves_hidden_and_adds_fallback_categories() {
        let (_d, pool) = conn();
        let mut c = pool.get().unwrap();
        let cats = vec![
            CategoryRow {
                category_id: "a".into(),
                name: "News".into(),
                position: 0,
            },
            CategoryRow {
                category_id: "b".into(),
                name: "Sports".into(),
                position: 1,
            },
        ];
        let items = vec![
            item("1", "a", "BBC News", 0),
            item("2", "b", "Sky Sports", 1),
            item("3", "zz", "Odd", 2),
        ];
        let n = replace_catalog(
            &mut c,
            "s",
            ContentType::Live,
            &cats,
            &mut items.clone().into_iter(),
        )
        .unwrap();
        assert_eq!(n, 3);
        let all = categories(&c, "s", ContentType::Live, true).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[2].name, FALLBACK_CATEGORY_NAME);
        set_category_hidden(&c, "s", ContentType::Live, "b", true).unwrap();
        replace_catalog(
            &mut c,
            "s",
            ContentType::Live,
            &cats,
            &mut items.into_iter(),
        )
        .unwrap();
        let visible = categories(&c, "s", ContentType::Live, false).unwrap();
        assert!(
            visible.iter().all(|c| c.id != "b"),
            "hidden flag survives a rewrite"
        );
        assert_eq!(source_counts(&c, "s").unwrap(), (3, 0, 0));
    }
}
