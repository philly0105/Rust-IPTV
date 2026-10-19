//! `catalog` module (SPEC C5): the items/categories store every source kind
//! writes into, the paged readers the UI pages through, and `catalog.*` rpc.
//!
//! Writers: [`replace_catalog`] (one content type) and [`CatalogWriter`] (any
//! set of content types inside a caller-owned transaction; the m3u importer
//! uses it to write live, radio and movies in one streaming pass).
//! Readers: [`categories`], [`query`], [`get`], [`search`] plus the helpers
//! behind the rpc commands (neighbors, channel by number, recently added,
//! same title). The rpc readers take an optional parental [`Hide`] filter
//! (`docs/architecture/parental.md`). Channels hidden by a channel edit
//! leave every reader and count, and custom names are applied by the rpc
//! layer (`docs/architecture/channel-edits.md`). See
//! `docs/architecture/catalog.md`.

pub mod language;
pub mod rpc;
mod title;
// vod: year range and "Hide watched" filters (Run 2 C4).
pub mod vodfilter;

pub use title::title_base;
pub use vodfilter::VodFilter;

use crate::channeledit;
use crate::error::{CoreError, CoreResult};
use crate::model::{
    ArchiveInfo, CatchupInfo, Category, Channel, ContentType, ItemRef, Page, PageQuery,
    RequestHeaders, SeriesItem, SortDir, SortKey, SourceKind, VodItem,
};
use crate::parental::{self, Hide};
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
    /// Fills a movie or series row's `title_base`, and the year its title
    /// carries, the way [`CatalogWriter::insert`] would. Importers that map
    /// rows on the blocking pool call it there, so the title regexes do not
    /// run inside the write transaction (IN-3).
    pub fn derive_title_base(&mut self) {
        if self.title_base.is_none()
            && matches!(self.content_type, ContentType::Movie | ContentType::Series)
        {
            let (base, year) = title_base(&self.title);
            self.year = self.year.or(year);
            self.title_base = Some(base);
        }
    }

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
        let days = c
            .get("days")
            .and_then(|v| {
                v.as_i64()
                    .or_else(|| v.as_f64().map(|f| f as i64))
                    .or_else(|| v.as_str()?.trim().parse().ok())
            })
            // Rows imported before the parsers bounded it can hold any number.
            .map(|d: i64| d.clamp(0, crate::xtream::meta::MAX_ARCHIVE_DAYS));
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
                // Clamped on read too: older rows can hold unbounded values.
                duration_hours: Some(crate::xtream::meta::clamp_archive_hours(h)),
            }),
            _ if self.catchup().is_some_and(|c| catchup_usable(&c.kind)) => Some(ArchiveInfo {
                enabled: true,
                duration_hours: None,
            }),
            _ => None,
        }
    }
}

/// The catch-up types a client can build archive URLs for, and the check of
/// one. They live with the URL builder, so the importer enables an archive
/// for exactly the types the builder serves (aliases included).
pub use crate::catchup::m3u::{catchup_usable, CATCHUP_TYPES};

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
    /// Drop items that are clearly in another language (`englishOnly`, see
    /// [`language`]); `total` counts what is left.
    pub english_only: bool,
    // vod:
    /// Year range and "Hide watched" of `catalog.movies` / `catalog.series`
    /// (Run 2 C4); empty (the default) for channels.
    pub vod: VodFilter,
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

const INSERT_ITEM_SQL: &str = "INSERT OR IGNORE INTO items (source_id, content_type, item_id, category_id, title, title_base, number, logo_url, poster_url, backdrop_url, rating, added, year, epg_channel_id, url, container_extension, is_radio, archive_hours, extra_json, position, non_english) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)";

/// Rows inserted between progress callbacks / statement resets.
pub const WRITE_BATCH: u64 = 1000;

/// Rows a rewrite touches (deleted plus offered for insert) from which the
/// secondary indexes of `items` are dropped and built once in
/// [`CatalogWriter::finish`] instead of being updated row by row. The rewrite
/// must also touch at least as many rows as it leaves in `items` (other
/// sources and types), since the rebuild sorts those too.
pub const BULK_MIN_ROWS: u64 = 20_000;

/// Rowids whose stored verdict their category may overturn, per category:
/// `(untagged titles, foreign-script titles)`.
type Undecided = HashMap<String, (Vec<i64>, Vec<i64>)>;

/// The name a category is stored under (see [`CatalogWriter::finish`]).
fn stored_category_name(name: &str) -> &str {
    let name = name.trim();
    if name.is_empty() {
        FALLBACK_CATEGORY_NAME
    } else {
        name
    }
}

/// Streaming catalog writer over a caller-owned transaction.
///
/// `begin` deletes the existing categories and items of the given content
/// types (remembering which categories were hidden), `insert` adds items
/// through one prepared statement, `finish` writes the categories (restoring
/// `hidden`, adding fallback categories for ids items referenced but nobody
/// declared), recomputes `item_count`, and refreshes `source_counts`.
/// Dropping the transaction without committing restores the previous catalog.
///
/// Each row also gets its English-only verdict (`non_english`, see
/// [`language`]), so readers never test rows. A row whose category was
/// declared first ([`CatalogWriter::declare_categories`]) gets its final
/// verdict on insert. Otherwise `insert` stores the title's guess, and
/// `finish` corrects the rows whose category decides (an untagged title in a
/// "FRANCE" group, a foreign-script title in an "UK | NEWS" one).
///
/// A large rewrite ([`BULK_MIN_ROWS`]) drops the secondary indexes of
/// `items` and `finish` builds them again, inside the same transaction:
/// readers keep seeing the previous catalog with its indexes until the commit.
pub struct CatalogWriter<'c> {
    conn: &'c Connection,
    source_id: String,
    types: Vec<ContentType>,
    hidden: HashMap<ContentType, HashSet<String>>,
    seen_categories: HashMap<ContentType, HashSet<String>>,
    inserted: HashMap<ContentType, u64>,
    /// Rowids whose stored verdict a category may overturn, per type.
    undecided: HashMap<ContentType, Undecided>,
    /// Category verdicts declared before the rows, per type.
    declared: HashMap<ContentType, HashMap<String, i64>>,
    /// Rows of the rewritten types deleted by `begin`.
    replaced: u64,
    /// Whether `begin` has deleted the `replaced` rows yet.
    replaced_gone: bool,
    /// `(name, CREATE statement)` of the indexes dropped for a bulk rewrite;
    /// `None` while the indexes are maintained row by row.
    dropped_indexes: Option<Vec<(String, String)>>,
    /// Rows of `items` this rewrite leaves alone (other sources and types),
    /// counted once, the first time [`CatalogWriter::maybe_go_bulk`] needs
    /// it: the number cannot change while the writer's transaction runs.
    kept: Option<u64>,
    total: u64,
    duplicates: u64,
    /// Cancel token of the import run writing this catalog (C8), taken at
    /// [`CatalogWriter::begin`]; checked every [`WRITE_BATCH`] rows and in
    /// [`CatalogWriter::finish`], so a cancelled run rolls back.
    cancel: Option<tokio_util::sync::CancellationToken>,
}

/// `Err` with the cancelled-import error when `token` fired.
fn check_cancel(token: Option<&tokio_util::sync::CancellationToken>) -> CoreResult<()> {
    if token.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
        return Err(crate::sources::import_cancelled_error());
    }
    Ok(())
}

impl<'c> CatalogWriter<'c> {
    /// Starts a rewrite of `types` for `source_id`. `conn` should be inside a
    /// transaction (one write transaction per source import).
    ///
    /// `cancel` is the import run's token, taken by the caller in async
    /// context before waiting for a connection or the write lock (C8). If that
    /// wait outlasts the cancel grace, the run's writer token is already
    /// unregistered (or replaced by a newer run's), so a lookup here would
    /// miss the cancel. `None` falls back to [`crate::sources::writer_cancel_token`]
    /// for writers outside an import run.
    pub fn begin(
        conn: &'c Connection,
        source_id: &str,
        types: &[ContentType],
        cancel: Option<tokio_util::sync::CancellationToken>,
    ) -> CoreResult<Self> {
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
        // Per-row FTS and items_rank triggers are suspended for this source
        // until `finish`; both are updated in bulk instead (see migrations
        // 0002 and 0020).
        conn.execute(
            "INSERT OR IGNORE INTO fts_suspend (source_id) VALUES (?1)",
            [source_id],
        )?;
        let mut replaced = 0u64;
        {
            let mut stmt = conn.prepare_cached(
                "SELECT count(*) FROM items WHERE source_id = ?1 AND content_type = ?2",
            )?;
            for ct in types {
                replaced +=
                    stmt.query_row(params![source_id, ct.as_str()], |r| r.get::<_, i64>(0))? as u64;
            }
        }
        let mut w = Self {
            conn,
            source_id: source_id.to_string(),
            types: types.to_vec(),
            hidden,
            seen_categories: HashMap::new(),
            inserted: HashMap::new(),
            undecided: HashMap::new(),
            declared: HashMap::new(),
            replaced,
            replaced_gone: false,
            dropped_indexes: None,
            kept: None,
            total: 0,
            duplicates: 0,
            cancel: cancel.or_else(|| crate::sources::writer_cancel_token(conn, source_id)),
        };
        // A large refresh drops the indexes before its deletes too.
        w.maybe_go_bulk()?;
        for ct in types {
            conn.execute(
                "INSERT INTO items_fts (items_fts, rowid, title) SELECT 'delete', rowid, title FROM items WHERE source_id = ?1 AND content_type = ?2",
                params![source_id, ct.as_str()],
            )?;
            conn.execute(
                "DELETE FROM items_rank WHERE id IN (SELECT rowid FROM items WHERE source_id = ?1 AND content_type = ?2)",
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
        w.replaced_gone = true;
        Ok(w)
    }

    /// Drops every secondary index of `items` once the rewrite touches enough
    /// rows ([`BULK_MIN_ROWS`]); [`CatalogWriter::finish`] runs their stored
    /// CREATE statements again. Sorting the rows once is several times
    /// cheaper than updating all eleven of them (as of migration 0019) per
    /// row. The primary key stays (duplicate detection and the per-source
    /// deletes use it).
    fn maybe_go_bulk(&mut self) -> CoreResult<()> {
        let touched = self.replaced + self.total + self.duplicates;
        if self.dropped_indexes.is_some() || touched < BULK_MIN_ROWS {
            return Ok(());
        }
        // Rows the rebuild sorts although this rewrite leaves them alone: all
        // but the rewrite's own, which are the replaced rows until `begin`
        // deletes them and the inserted rows after. Counted once, not every
        // WRITE_BATCH rows (IN-9).
        let kept = match self.kept {
            Some(kept) => kept,
            None => {
                let all: i64 = self
                    .conn
                    .query_row("SELECT count(*) FROM items", [], |r| r.get(0))?;
                let own = if self.replaced_gone {
                    self.total
                } else {
                    self.replaced
                };
                let kept = (all as u64).saturating_sub(own);
                self.kept = Some(kept);
                kept
            }
        };
        if touched < kept {
            return Ok(());
        }
        let indexes = {
            let mut stmt = self.conn.prepare(
                "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'items' AND sql IS NOT NULL ORDER BY name",
            )?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (name, _) in &indexes {
            self.conn
                .execute_batch(&format!("DROP INDEX \"{}\"", name.replace('"', "\"\"")))?;
        }
        self.dropped_indexes = Some(indexes);
        Ok(())
    }

    /// Declares the categories of `ct` before its rows are inserted, so each
    /// row gets its final English-only verdict on insert rather than an
    /// update in `finish`. Pass `finish` the same categories (as there, the
    /// first category with an id wins).
    pub fn declare_categories(&mut self, ct: ContentType, categories: &[CategoryRow]) {
        let declared = self.declared.entry(ct).or_default();
        for c in categories {
            if !declared.contains_key(c.category_id.as_str()) {
                declared.insert(
                    c.category_id.clone(),
                    language::category_verdict(stored_category_name(&c.name)),
                );
            }
        }
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
        let verdict = language::title_verdict(&item.title);
        let undecided = matches!(
            verdict,
            language::TITLE_UNDECIDED | language::TITLE_UNDECIDED_FOREIGN
        );
        let category = if undecided {
            self.declared
                .get(&item.content_type)
                .and_then(|d| d.get(item.category_id.as_str()))
                .copied()
        } else {
            None
        };
        let non_english = match category {
            Some(c) => language::combine(verdict, c),
            None => language::title_guess(verdict),
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
            non_english,
        ])?;
        if (self.total + self.duplicates + 1) % WRITE_BATCH == 0 {
            check_cancel(self.cancel.as_ref())?;
            self.maybe_go_bulk()?;
        }
        if n == 0 {
            self.duplicates += 1;
            return Ok(false);
        }
        if undecided && category.is_none() {
            let rowid = self.conn.last_insert_rowid();
            let by_cat = self.undecided.entry(item.content_type).or_default();
            let lists = match by_cat.get_mut(item.category_id.as_str()) {
                Some(l) => l,
                None => by_cat.entry(item.category_id.clone()).or_default(),
            };
            if verdict == language::TITLE_UNDECIDED {
                lists.0.push(rowid);
            } else {
                lists.1.push(rowid);
            }
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
        check_cancel(self.cancel.as_ref())?;
        // A bulk rewrite builds the indexes again first: the counts below
        // read them.
        for (_, sql) in self.dropped_indexes.iter().flatten() {
            self.conn.execute_batch(sql)?;
        }
        let mut insert_cat = self.conn.prepare_cached(
            "INSERT OR IGNORE INTO categories (source_id, content_type, category_id, name, hidden, position, item_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
        )?;
        let mut set_verdict = self
            .conn
            .prepare_cached("UPDATE items SET non_english = ?2 WHERE rowid = ?1")?;
        for ct in &self.types {
            let hidden = self.hidden.get(ct);
            let mut declared: HashSet<&str> = HashSet::new();
            // English-only verdict of each category as stored (first wins,
            // as with INSERT OR IGNORE).
            let mut verdicts: HashMap<&str, i64> = HashMap::new();
            let mut next_pos = 0i64;
            let rows = categories
                .iter()
                .filter(|(t, _)| t == ct)
                .flat_map(|(_, v)| v.iter());
            for c in rows {
                declared.insert(c.category_id.as_str());
                next_pos = next_pos.max(c.position + 1);
                let is_hidden = hidden.is_some_and(|h| h.contains(&c.category_id));
                let name = stored_category_name(&c.name);
                verdicts
                    .entry(c.category_id.as_str())
                    .or_insert_with(|| language::category_verdict(name));
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
            // English-only: the rows whose category overturns the title's
            // guess (undeclared categories are named FALLBACK_CATEGORY_NAME).
            if let Some(by_cat) = self.undecided.get(ct) {
                let fallback = language::category_verdict(FALLBACK_CATEGORY_NAME);
                for (category_id, (untagged, foreign)) in by_cat {
                    let verdict = verdicts
                        .get(category_id.as_str())
                        .copied()
                        .unwrap_or(fallback);
                    let (hide_untagged, show_foreign) = language::category_changes(verdict);
                    if hide_untagged {
                        for rowid in untagged {
                            set_verdict.execute(params![rowid, true])?;
                        }
                    }
                    if show_foreign {
                        for rowid in foreign {
                            set_verdict.execute(params![rowid, false])?;
                        }
                    }
                }
            }
            self.conn.execute(
                "DELETE FROM english_pending WHERE source_id = ?1 AND content_type = ?2",
                params![self.source_id, ct.as_str()],
            )?;
            // C2: hidden channels (kept across the rewrite) leave the counts.
            recount_categories(self.conn, &self.source_id, *ct)?;
        }
        // The search index and the ranking rows of the rewritten types, after
        // the verdict updates above (items_rank copies non_english).
        for ct in &self.types {
            self.conn.execute(
                "INSERT INTO items_fts (rowid, title) SELECT rowid, title FROM items WHERE source_id = ?1 AND content_type = ?2",
                params![self.source_id, ct.as_str()],
            )?;
            self.conn.execute(
                "INSERT INTO items_rank (id, source_id, content_type, category_id, non_english, title_len, position) SELECT rowid, source_id, content_type, category_id, non_english, length(title), position FROM items WHERE source_id = ?1 AND content_type = ?2",
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
    let (n, cancel) = {
        let mut w = CatalogWriter::begin(&tx, source_id, &[content_type], None)?;
        let cancel = w.cancel.clone();
        for item in items {
            w.insert(&item)?;
        }
        (w.finish(&[(content_type, categories.to_vec())])?, cancel)
    };
    // Last check: a cancelled import run never commits (C8).
    check_cancel(cancel.as_ref())?;
    tx.commit()?;
    Ok(n)
}

/// Recomputes `item_count` of every category of one source and content type
/// from `items`, leaving out channels hidden by a channel edit (C2). Called
/// by the catalog writer and after every change to the hidden set.
pub fn recount_categories(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
) -> CoreResult<()> {
    conn.prepare_cached(
        "UPDATE categories SET item_count = (SELECT count(*) FROM items i WHERE i.source_id = categories.source_id AND i.content_type = categories.content_type AND i.category_id = categories.category_id) WHERE source_id = ?1 AND content_type = ?2",
    )?
    .execute(params![source_id, content_type.as_str()])?;
    // A handful of hidden channels per category: subtract them rather than
    // probe `channel_edits` once per item.
    let hidden = channeledit::hidden_counts(conn, source_id, content_type)?;
    if !hidden.is_empty() {
        let mut stmt = conn.prepare_cached(
            "UPDATE categories SET item_count = MAX(item_count - ?4, 0) WHERE source_id = ?1 AND content_type = ?2 AND category_id = ?3",
        )?;
        for (category_id, n) in &hidden {
            stmt.execute(params![source_id, content_type.as_str(), category_id, n])?;
        }
    }
    Ok(())
}

/// Recomputes `source_counts` for one source (channels = live only, without
/// channels hidden by a channel edit; the radio count is read from `items`
/// by the source readers).
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
    let hidden_live = channeledit::hidden_count(conn, source_id, ContentType::Live)?;
    if let Some(n) = counts.get_mut("live") {
        *n = (*n - hidden_live).max(0);
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

/// Number of radio stations of one source, without hidden ones (C2).
pub fn radio_count(conn: &Connection, source_id: &str) -> CoreResult<i64> {
    let all: i64 = conn.query_row(
        "SELECT count(*) FROM items WHERE source_id = ?1 AND content_type = 'radio'",
        [source_id],
        |r| r.get(0),
    )?;
    Ok((all - channeledit::hidden_count(conn, source_id, ContentType::Radio)?).max(0))
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
///
/// `item_count` leaves out channels hidden by a channel edit (C2; stored
/// that way by [`recount_categories`]). Without `include_hidden`, a category
/// whose channels are all hidden is dropped like a hidden category; the
/// manage-categories view (`include_hidden`) still lists it, with 0 and
/// `emptied_by_edits` set (false on every other category there).
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
            emptied_by_edits: None,
        })
    })?;
    let mut all: Vec<Category> = rows.collect::<Result<_, _>>()?;
    // Categories holding hidden channels; empty (one cheap probe) without edits.
    let edited = channeledit::hidden_counts(conn, source_id, content_type)?;
    let emptied = |c: &Category| c.item_count == 0 && edited.contains_key(&c.id);
    if include_hidden {
        for c in &mut all {
            c.emptied_by_edits = Some(!c.hidden && emptied(c));
        }
    } else if !edited.is_empty() {
        all.retain(|c| !emptied(c));
    }
    Ok(all)
}

/// [`categories`] for the English-only mode. Where the items are stored,
/// `item_count` counts only items that are not clearly in another language
/// and categories left with none are dropped. Where they are not (Stalker
/// VOD pages live from the portal), categories whose own name is clearly in
/// another language are dropped and counts stay as they are.
pub fn english_categories(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
    include_hidden: bool,
) -> CoreResult<Vec<Category>> {
    let all = categories(conn, source_id, content_type, include_hidden)?;
    let stored: bool = conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM items WHERE source_id = ?1 AND content_type = ?2)",
        )?
        .query_row(params![source_id, content_type.as_str()], |r| r.get(0))?;
    if !stored {
        return Ok(all
            .into_iter()
            .filter(|c| !language::is_non_english("", Some(&c.name)))
            .collect());
    }
    let mut counts: HashMap<String, i64> = HashMap::new();
    {
        // An index-only walk of `idx_items_cat` with a rowid probe per row
        // (two when channels are hidden, C2).
        let hidden = english_scoped(conn, true, source_id, content_type)?;
        let edited = channeledit::scoped(conn, source_id, content_type, "?1", "?2")?;
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT i.category_id, count(*) FROM items i WHERE i.source_id = ?1 AND i.content_type = ?2{hidden}{edited} GROUP BY i.category_id"
        ))?;
        let rows = stmt.query_map(params![source_id, content_type.as_str()], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (id, n) = row?;
            counts.insert(id, n);
        }
    }
    Ok(all
        .into_iter()
        .filter_map(|mut c| {
            let n = counts.get(&c.id).copied().unwrap_or(0);
            if n == 0 && c.item_count > 0 {
                return None;
            }
            c.item_count = n;
            Some(c)
        })
        .collect())
}

/// The `catalog.categories` list: [`english_categories`] in English-only
/// mode, else [`categories`]. In parental hide mode (`hide` set) locked
/// categories and, with `autoAdult`, adult ones are dropped; locked items
/// leave their category's `item_count`, and a category they empty is dropped.
pub fn visible_categories(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
    include_hidden: bool,
    english_only: bool,
    hide: Option<Hide>,
) -> CoreResult<Vec<Category>> {
    let mut all = if english_only {
        english_categories(conn, source_id, content_type, include_hidden)?
    } else {
        categories(conn, source_id, content_type, include_hidden)?
    };
    let Some(hide) = hide else {
        return Ok(all);
    };
    let locked = parental::filter::locked_categories(conn, source_id, content_type)?;
    let mut removed =
        parental::filter::locked_item_counts(conn, source_id, content_type, english_only)?;
    // C2: a locked channel that is also hidden has already left `item_count`.
    for (category_id, n) in locked_hidden_counts(conn, source_id, content_type, english_only)? {
        if let Some(r) = removed.get_mut(&category_id) {
            *r = (*r - n).max(0);
        }
    }
    all.retain_mut(|c| {
        if locked.contains(&c.id) || (hide.auto_adult && parental::is_adult_category(&c.name)) {
            return false;
        }
        match removed.get(&c.id) {
            Some(n) if c.item_count > 0 => {
                c.item_count = (c.item_count - n).max(0);
                c.item_count > 0
            }
            _ => true,
        }
    });
    Ok(all)
}

/// Channels both item-locked (parental) and hidden by a channel edit, per
/// category id, counted like `parental::filter::locked_item_counts` (empty
/// when the source hides nothing of that type).
fn locked_hidden_counts(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
    english_only: bool,
) -> CoreResult<HashMap<String, i64>> {
    if !channeledit::has_hidden(conn, source_id, content_type)? {
        return Ok(HashMap::new());
    }
    let sql = if english_only {
        "SELECT i.category_id, count(*) FROM parental_locks pl CROSS JOIN items i ON i.source_id = pl.source_id AND i.content_type = pl.content_type AND i.item_id = pl.target_id LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id WHERE pl.source_id = ?1 AND pl.content_type = ?2 AND pl.kind = 'item' AND non_english(i.title, c.name) = 0 AND EXISTS (SELECT 1 FROM channel_edits e WHERE e.source_id = pl.source_id AND e.content_type = pl.content_type AND e.item_id = pl.target_id AND e.hidden = 1) GROUP BY i.category_id"
    } else {
        "SELECT i.category_id, count(*) FROM parental_locks pl CROSS JOIN items i ON i.source_id = pl.source_id AND i.content_type = pl.content_type AND i.item_id = pl.target_id WHERE pl.source_id = ?1 AND pl.content_type = ?2 AND pl.kind = 'item' AND EXISTS (SELECT 1 FROM channel_edits e WHERE e.source_id = pl.source_id AND e.content_type = pl.content_type AND e.item_id = pl.target_id AND e.hidden = 1) GROUP BY i.category_id"
    };
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map(params![source_id, content_type.as_str()], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
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

pub(crate) const SELECT_NAMED: &str = "SELECT i.source_id, i.content_type, i.item_id, i.category_id, i.title, i.title_base, i.number, i.logo_url, i.poster_url, i.backdrop_url, i.rating, i.added, i.year, i.epg_channel_id, i.url, i.container_extension, i.is_radio, i.archive_hours, i.extra_json, i.position, c.name FROM items i LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id";

/// `AND` clause of the English-only filter, or nothing, for readers across
/// sources (needs the `c` join of [`SELECT_NAMED`]): the stored verdict, or
/// the per-row rule while a catalog from before migration 0018 is pending.
fn english_clause(conn: &Connection, english_only: bool) -> CoreResult<&'static str> {
    if english_only {
        Ok(language::english_only_joined(conn)?)
    } else {
        Ok("")
    }
}

/// `AND` clause of the English-only filter for rows of one source and
/// content type, or nothing: the stored verdict (`items.non_english`, a
/// column of every catalog index, so a count over 100k rows stays an
/// index-only scan), or this connection's cached set of hidden rowids
/// ([`language::hidden_rowids`]) while the catalog is pending.
fn english_scoped(
    conn: &Connection,
    english_only: bool,
    source_id: &str,
    content_type: ContentType,
) -> CoreResult<&'static str> {
    if !english_only {
        return Ok("");
    }
    if language::is_pending(conn, source_id, content_type.as_str())? {
        return Ok(language::hidden_rowids(
            conn,
            source_id,
            content_type.as_str(),
        )?);
    }
    Ok(language::STORED_SQL)
}

pub(crate) fn read_named(r: &Row<'_>) -> rusqlite::Result<NamedRow> {
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
    Ok(query_named(conn, q, None)?.map(|n| n.row))
}

/// [`query`] with category names joined; `hide` drops parentally locked
/// items from the page and the total. Channels hidden by a channel edit are
/// always dropped, and a search also matches custom names (C2). Names are
/// not applied here: the rpc layer calls [`channeledit::apply_names`].
pub fn query_named(
    conn: &Connection,
    q: &CatalogQuery,
    hide: Option<Hide>,
) -> CoreResult<Page<NamedRow>> {
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
    // Skip the hidden-category filter when nothing is hidden (the common case).
    let filter_hidden = q.category_id.is_none()
        && !q.include_hidden
        && has_hidden_categories(conn, &q.source_id, q.content_type)?;
    let locked = match hide {
        Some(h) => parental::filter::scoped(conn, &q.source_id, q.content_type, h, "?1", "?2")?,
        None => String::new(),
    };
    let english = english_scoped(conn, q.english_only, &q.source_id, q.content_type)?;
    // C2: hidden channels leave the page and the total (also with
    // `include_hidden`); custom names are searched too, when there are any.
    let edited = channeledit::scoped(conn, &q.source_id, q.content_type, "?1", "?2")?;
    let named = search.is_some() && channeledit::has_names(conn, &q.source_id, q.content_type)?;
    // The page statement walks the sort's index: a rating or year filter on
    // another sort key is written `+i.rating` / `+i.year` there, which keeps
    // it off the index choice. Left alone, SQLite took idx_items_rating or
    // idx_items_year for the filter and sorted every match in a temp b-tree
    // (100-340 ms a page on 60k movies; under 1 ms through the sort index).
    // The sort indexes hold both columns (migration 0019), so a selective
    // filter on a deep page reads index entries, not table rows. The count
    // keeps the plain column, where the filter's index helps.
    let sort = q.page.sort;
    let page_rating = if sort == Some(SortKey::Rating) {
        "i.rating"
    } else {
        "+i.rating"
    };
    let page_year = if sort == Some(SortKey::Year) {
        "i.year"
    } else {
        "+i.year"
    };
    for (i, m) in attempts.iter().enumerate() {
        // The WHERE of the count (plain filter columns) and of the page;
        // both take the same `args`.
        let mut count_where = String::from("i.source_id = ?1 AND i.content_type = ?2");
        let mut args: Vec<SqlValue> = vec![
            q.source_id.clone().into(),
            q.content_type.as_str().to_string().into(),
        ];
        if let Some(cat) = &q.category_id {
            args.push(cat.clone().into());
            count_where.push_str(&format!(" AND i.category_id = ?{}", args.len()));
        } else if filter_hidden {
            // Same rows as `COALESCE(c.hidden, 0) = 0` on the join (an item
            // whose category is missing stays visible), without a join per row.
            count_where.push_str(
                " AND i.category_id NOT IN (SELECT category_id FROM categories WHERE source_id = ?1 AND content_type = ?2 AND hidden <> 0)",
            );
        }
        let mut page_where = count_where.clone();
        if let Some(min) = q.min_rating.filter(|r| r.is_finite() && *r > 0.0) {
            args.push(min.into());
            count_where.push_str(&format!(" AND i.rating >= ?{}", args.len()));
            page_where.push_str(&format!(" AND {page_rating} >= ?{}", args.len()));
        }
        // vod: year range and "Hide watched" (C4; nothing for channels).
        let mut page_args = args.clone();
        count_where.push_str(&vodfilter::vod_filter_sql(&q.vod, &mut args));
        page_where.push_str(&vodfilter::vod_filter_sql_on(
            &q.vod,
            page_year,
            &mut page_args,
        ));
        debug_assert_eq!(args, page_args);
        // The rest is shared.
        let mut where_sql = String::from(english);
        if let Some(s) = search {
            match m {
                Match::Fts => {
                    args.push(fts_query(s).unwrap_or_default().into());
                    let fts = args.len();
                    if named {
                        // Provider names by word prefix, custom names by
                        // substring (a few rows from `channel_edits`).
                        args.push(like_pattern(s).into());
                        where_sql.push_str(&format!(
                            " AND i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?{fts} UNION {})",
                            channeledit::named_rowids("?1", "?2", &format!("?{}", args.len()))
                        ));
                    } else {
                        where_sql.push_str(&format!(
                            " AND i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?{fts})"
                        ));
                    }
                }
                Match::Like => {
                    args.push(like_pattern(s).into());
                    let pat = args.len();
                    if named {
                        where_sql.push_str(&format!(
                            " AND (i.title LIKE ?{pat} ESCAPE '\\' OR i.rowid IN ({}))",
                            channeledit::named_rowids("?1", "?2", &format!("?{pat}"))
                        ));
                    } else {
                        where_sql.push_str(&format!(" AND i.title LIKE ?{pat} ESCAPE '\\'"));
                    }
                }
            }
        }
        // After the search: SQLite tests index-covered terms in this order,
        // so the few FTS matches are found before the hidden-rowid probe.
        where_sql.push_str(&locked);
        where_sql.push_str(&edited);
        // No join: it only adds the category name, which cannot change the
        // count (categories' key is unique), and the English-only clause
        // reads categories through its own sets.
        let count_sql = format!("SELECT count(*) FROM items i WHERE {count_where}{where_sql}");
        let total: i64 = conn
            .prepare_cached(&count_sql)?
            .query_row(rusqlite::params_from_iter(args.iter()), |r| r.get(0))?;
        if total == 0 && i + 1 < attempts.len() {
            continue;
        }
        // Nothing on this page: skip the walk (a decade with no titles
        // would otherwise pass every entry of the sort index).
        if offset >= total {
            return Ok(Page {
                items: Vec::new(),
                total,
                offset,
                limit,
            });
        }
        // The page's rowids first, from the sort's index (migration 0018
        // puts the category and English-only columns in it), then the full
        // rows of just those: OFFSET no longer reads and joins every skipped
        // row, which made pages near the end of a 100k list take 100-900 ms.
        // OFFSET is bound, so each page of a list reuses one cached
        // statement; LIMIT stays literal, as SQLite uses it in the row
        // estimate (DB-3).
        let order = order_clause(&q.page);
        args.push(offset.into());
        let sql = format!(
            "{SELECT_NAMED} WHERE i.rowid IN (SELECT i.rowid FROM items i WHERE {page_where}{where_sql} ORDER BY {order} LIMIT {limit} OFFSET ?{}) ORDER BY {order}",
            args.len()
        );
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

/// True when a category of `source_id` / `content_type` is hidden.
pub(crate) fn has_hidden_categories(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
) -> CoreResult<bool> {
    Ok(conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM categories WHERE source_id = ?1 AND content_type = ?2 AND hidden <> 0)",
        )?
        .query_row(params![source_id, content_type.as_str()], |r| r.get(0))?)
}

/// True when a category of `source_id` (any source when `None`) is hidden.
fn has_hidden_any(conn: &Connection, source_id: Option<&str>) -> CoreResult<bool> {
    Ok(match source_id {
        Some(s) => conn
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM categories WHERE source_id = ?1 AND hidden <> 0)",
            )?
            .query_row([s], |r| r.get(0))?,
        None => conn
            .prepare_cached("SELECT EXISTS(SELECT 1 FROM categories WHERE hidden <> 0)")?
            .query_row([], |r| r.get(0))?,
    })
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

/// False when parental hide mode (`hide`) drops the catalog item `r`: an item
/// lock, a lock on its category, or (with `autoAdult`) an adult category
/// name. Also false when the item does not exist.
pub fn is_visible(conn: &Connection, r: &ItemRef, hide: Hide) -> CoreResult<bool> {
    let locked = parental::filter::item_row(conn, hide)?;
    let sql = format!(
        "SELECT EXISTS(SELECT 1 FROM items i LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id WHERE i.source_id = ?1 AND i.content_type = ?2 AND i.item_id = ?3{locked})"
    );
    Ok(conn.prepare_cached(&sql)?.query_row(
        params![r.source_id, r.content_type.as_str(), r.item_id],
        |row| row.get(0),
    )?)
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
    Ok(
        search_named(conn, query, source_id, types, limit, false, None)?
            .into_iter()
            .map(|n| n.row)
            .collect(),
    )
}

/// [`search`] with category names joined; `english_only` drops items that are
/// clearly in another language, `hide` parentally locked ones.
pub fn search_named(
    conn: &Connection,
    query: &str,
    source_id: Option<&str>,
    types: &[ContentType],
    limit: usize,
    english_only: bool,
    hide: Option<Hide>,
) -> CoreResult<Vec<NamedRow>> {
    let types: Vec<ContentType> = if types.is_empty() {
        ContentType::ALL.to_vec()
    } else {
        types.to_vec()
    };
    Ok(
        search_groups(conn, query, source_id, &[&types], limit, english_only, hide)?
            .pop()
            .unwrap_or_default(),
    )
}

/// [`search_named`] for several groups of content types at once (the
/// `catalog.search` lists: live and radio, movies, series), up to `limit`
/// rows per group, in one ranked pass: one FTS match for every group instead
/// of one each, ranked on the narrow `items_rank` rows with a top-`limit`
/// per group (ties by rowid), then the full rows of the winners. When the
/// word-prefix match finds nothing in any group, every group falls back to
/// a substring match, again one statement for all of them, over the title
/// index rather than the table (wide rows: URLs, JSON). A group with
/// word-prefix hits answers exactly as a [`search_named`] call of its own
/// would; a group without them is empty unless no group has any.
pub fn search_groups(
    conn: &Connection,
    query: &str,
    source_id: Option<&str>,
    groups: &[&[ContentType]],
    limit: usize,
    english_only: bool,
    hide: Option<Hide>,
) -> CoreResult<Vec<Vec<NamedRow>>> {
    let mut out: Vec<Vec<NamedRow>> = vec![Vec::new(); groups.len()];
    let text = query.trim();
    let types: Vec<ContentType> = groups.iter().flat_map(|g| g.iter().copied()).collect();
    if text.is_empty() || limit == 0 || types.is_empty() {
        return Ok(out);
    }
    // Search lists may hold one probe row past the 1000-row UI step.
    let limit = limit.min(rpc::MAX_SEARCH_LIMIT);
    let fts = fts_query(text);

    let channels = types.iter().any(|t| channeledit::is_channel_type(*t));
    // Every filter tests columns of `items i` alone, and only columns that
    // items_rank copies, so the word-prefix pass can rank on items_rank and
    // reads no category row per match (about 30% of a broad prefix), except
    // the per-row English-only rule while a catalog is pending (it needs
    // the title and the category name, so that case ranks on items).
    let english = english_clause(conn, english_only)?;
    let ranking_join = english == language::ENGLISH_ONLY_SQL;
    let mut filter = String::from(english);
    if let Some(h) = hide {
        filter.push_str(&parental::filter::item_set(conn, h)?);
    }
    if channels {
        filter.push_str(&channeledit::item_set(conn, source_id)?);
    }
    let mut base_args: Vec<SqlValue> = Vec::new();
    let placeholders: Vec<String> = types
        .iter()
        .map(|t| {
            base_args.push(t.as_str().to_string().into());
            format!("?{}", base_args.len() + 1)
        })
        .collect();
    let source_param = source_id.map(|sid| {
        base_args.push(sid.to_string().into());
        format!("?{}", base_args.len() + 1)
    });
    // The content types and the source, apart from `filter`: the substring
    // pass writes them as `+i.content_type` / `+i.source_id` (below).
    let scope = |plus: &str| -> String {
        let mut s = format!(" AND {plus}i.content_type IN ({})", placeholders.join(", "));
        if let Some(p) = &source_param {
            s.push_str(&format!(" AND {plus}i.source_id = {p}"));
        }
        s
    };
    let hidden_scope = source_param
        .as_ref()
        .map(|p| format!(" AND source_id = {p}"))
        .unwrap_or_default();
    // Hidden categories, only when there are any: the same rows as
    // `COALESCE(c.hidden, 0) = 0` on the join (an item whose category is
    // missing stays visible). A row whose category id is not among the
    // hidden ids (one set per statement) passes at once; the others get an
    // exact primary-key probe, since category ids repeat across sources.
    if has_hidden_any(conn, source_id)? {
        filter.push_str(&format!(
            " AND NOT (i.category_id IN (SELECT category_id FROM categories WHERE hidden <> 0{hidden_scope}) AND EXISTS (SELECT 1 FROM categories hc WHERE hc.source_id = i.source_id AND hc.content_type = i.content_type AND hc.category_id = i.category_id AND hc.hidden <> 0))"
        ));
    }
    // The group of each row, by content type (content types are fixed
    // identifiers, safe as literals).
    let group_of = |pick: &dyn Fn(usize) -> bool| -> String {
        let arms: String = groups
            .iter()
            .enumerate()
            .filter(|(g, _)| pick(*g))
            .flat_map(|(g, ts)| {
                ts.iter()
                    .map(move |t| format!(" WHEN '{}' THEN {g}", t.as_str()))
            })
            .collect();
        format!("CASE i.content_type{arms} END")
    };
    // Ranks each group's matching rows on their rowids alone and then reads
    // the full rows of the `limit` best, so the window sorts small records
    // rather than every match's URLs and JSON. Used by the substring pass
    // and by the word-prefix pass while the English-only rule is pending.
    // `body` is the match: joins and WHERE after `items i` (and `c` when
    // `ranking_join`).
    let ranked = |group: &str, order: &str, body: &str| -> String {
        let (cols, join) = SELECT_NAMED
            .split_once(" FROM items i")
            .unwrap_or((SELECT_NAMED, ""));
        let inner_join = if ranking_join { join } else { "" };
        format!(
            "{cols}, g.search_group FROM (SELECT i.rowid AS rid, {group} AS search_group, ROW_NUMBER() OVER (PARTITION BY {group} ORDER BY {order}) AS search_rank FROM items i{inner_join} {body}) g CROSS JOIN items i ON i.rowid = g.rid{join} WHERE g.search_rank <= {limit} ORDER BY g.search_group, g.search_rank"
        )
    };
    let run = |sql: String, first: SqlValue, out: &mut Vec<Vec<NamedRow>>| -> CoreResult<()> {
        let mut args: Vec<SqlValue> = vec![first];
        args.extend(base_args.iter().cloned());
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
            Ok((r.get::<_, i64>(21)?, read_named(r)?))
        })?;
        for row in rows {
            let (g, n) = row?;
            if let Some(list) = usize::try_from(g).ok().and_then(|g| out.get_mut(g)) {
                list.push(n);
            }
        }
        Ok(())
    };

    // The word-prefix pass ranks on items_rank (narrow rows, migration
    // 0020) and keeps each group's best `limit` with a bounded ORDER BY ...
    // LIMIT per group over one materialized match set, instead of a
    // ROW_NUMBER() window that sorts every match: "th" on 215k items has 56k
    // matches. Ties end on the rowid. `filter` names only columns that
    // items_rank copies from items (rowid, source_id, content_type,
    // category_id, non_english).
    let ranked_fts = |body_filter: &str| -> String {
        let group = group_of(&|_| true);
        let (cols, join) = SELECT_NAMED
            .split_once(" FROM items i")
            .unwrap_or((SELECT_NAMED, ""));
        let tops: Vec<String> = groups
            .iter()
            .enumerate()
            .filter(|(_, ts)| !ts.is_empty())
            .map(|(g, _)| {
                format!("SELECT * FROM (SELECT rid, grp, r, l, p FROM m WHERE grp = {g} ORDER BY r, l, p, rid LIMIT {limit})")
            })
            .collect();
        format!(
            "WITH m AS MATERIALIZED (SELECT i.rowid AS rid, {group} AS grp, items_fts.rank AS r, i.title_len AS l, i.position AS p FROM items_fts CROSS JOIN items_rank i ON i.rowid = items_fts.rowid WHERE items_fts MATCH ?1{body_filter}) {cols}, t.grp FROM ({}) t CROSS JOIN items i ON i.rowid = t.rid{join} ORDER BY t.grp, t.r, t.l, t.p, t.rid",
            tops.join(" UNION ALL ")
        )
    };

    if let Some(fq) = &fts {
        let sql = if ranking_join {
            // The pending English-only rule reads the title and the
            // category name, which items_rank lacks.
            ranked(
                &group_of(&|_| true),
                "items_fts.rank, length(i.title), i.position",
                &format!(
                    "JOIN items_fts ON items_fts.rowid = i.rowid WHERE items_fts MATCH ?1{}{filter}",
                    scope("")
                ),
            )
        } else {
            ranked_fts(&format!("{}{filter}", scope("")))
        };
        run(sql, fq.clone().into(), &mut out)?;
    }
    // The substring pass is for text that starts no word anywhere (inside
    // a word, "mber atl"): it runs only when every list came back empty.
    // A list without word-prefix hits next to lists with some stays empty;
    // filling it scanned every title of the library (50-120 ms on 220k
    // items) for the few in-word matches.
    let missing: Vec<usize> = if out.iter().all(Vec::is_empty) {
        (0..groups.len())
            .filter(|g| !groups[*g].is_empty())
            .collect()
    } else {
        Vec::new()
    };
    if !missing.is_empty() {
        let group = group_of(&|g| missing.contains(&g));
        let wanted: Vec<String> = missing
            .iter()
            .flat_map(|g| groups[*g].iter().map(|t| format!("'{}'", t.as_str())))
            .collect();
        // Substring matches are found by scanning idx_items_title (covering
        // for this subquery) instead of every table row. Without a source
        // the `+` keeps SQLite off idx_items_added, which it otherwise took
        // for the type and then read every row of it (300-800 ms on 100k
        // movies against about 12 ms for the index scan). The outer scope
        // is `+` for the same reason: the matched rowids drive the outer
        // pass, not an index on the type or source (twice as fast).
        let (inner_scope, ct_col) = match &source_param {
            Some(p) => (format!(" AND source_id = {p}"), "content_type"),
            None => (String::new(), "+content_type"),
        };
        let sql = ranked(
            &group,
            "length(i.title), i.title COLLATE NOCASE",
            &format!(
                "WHERE i.rowid IN (SELECT rowid FROM items WHERE title LIKE ?1 ESCAPE '\\' AND {ct_col} IN ({}){inner_scope}){}{filter}",
                wanted.join(", "),
                scope("+")
            ),
        );
        run(sql, like_pattern(text).into(), &mut out)?;
    }

    // C2: channels whose custom name contains the text come first (the
    // user's own names), shortest name first; the provider-name matches
    // follow without repeating them.
    if channels && has_any_names(conn, source_id)? {
        let custom = custom_name_matches(
            conn,
            text,
            &format!("{}{filter}", scope("")),
            &base_args,
            limit,
        )?;
        if !custom.is_empty() {
            for (g, ts) in groups.iter().enumerate() {
                let mine: Vec<NamedRow> = custom
                    .iter()
                    .filter(|n| ts.contains(&n.row.content_type))
                    .cloned()
                    .collect();
                if mine.is_empty() {
                    continue;
                }
                let mut seen: HashSet<(String, ContentType, String)> = HashSet::new();
                let rows = std::mem::take(&mut out[g]);
                out[g] = mine
                    .into_iter()
                    .chain(rows)
                    .filter(|n| {
                        seen.insert((
                            n.row.source_id.clone(),
                            n.row.content_type,
                            n.row.item_id.clone(),
                        ))
                    })
                    .take(limit)
                    .collect();
            }
        }
    }
    Ok(out)
}

/// True when a channel of `source_id` (any source when `None`) is renamed.
fn has_any_names(conn: &Connection, source_id: Option<&str>) -> CoreResult<bool> {
    match source_id {
        Some(s) => Ok(channeledit::has_names(conn, s, ContentType::Live)?
            || channeledit::has_names(conn, s, ContentType::Radio)?),
        None => channeledit::any_names(conn),
    }
}

/// Rows of [`search_named`] whose custom name contains `text`, under the
/// same `filter` (its placeholders start at `?2`, as in the callers), shortest
/// custom name first. The edits are the outer loop: a primary-key probe into
/// `items` per renamed channel that matches.
fn custom_name_matches(
    conn: &Connection,
    text: &str,
    filter: &str,
    base_args: &[SqlValue],
    limit: usize,
) -> CoreResult<Vec<NamedRow>> {
    let sql = format!(
        "{SELECT_NAMED} WHERE i.rowid IN (SELECT h.rowid FROM channel_edits e CROSS JOIN items h ON h.source_id = e.source_id AND h.content_type = e.content_type AND h.item_id = e.item_id WHERE e.name IS NOT NULL AND e.name LIKE ?1 ESCAPE '\\'){filter}"
    );
    let mut args: Vec<SqlValue> = vec![like_pattern(text).into()];
    args.extend(base_args.iter().cloned());
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), read_named)?
        .collect::<Result<Vec<_>, _>>()?;
    // Sort by the custom name (the rows still carry the provider name).
    let mut keyed: Vec<(String, NamedRow)> = Vec::with_capacity(rows.len());
    for n in rows {
        let r = ItemRef {
            source_id: n.row.source_id.clone(),
            content_type: n.row.content_type,
            item_id: n.row.item_id.clone(),
        };
        let name = channeledit::custom_name(conn, &r)?.unwrap_or_else(|| n.row.title.clone());
        keyed.push((name, n));
    }
    keyed.sort_by(|(a, x), (b, y)| {
        a.chars()
            .count()
            .cmp(&b.chars().count())
            .then_with(|| a.to_lowercase().cmp(&b.to_lowercase()))
            .then_with(|| x.row.position.cmp(&y.row.position))
    });
    keyed.truncate(limit);
    Ok(keyed.into_iter().map(|(_, n)| n).collect())
}

/// First channel with `number` in playlist order, skipping hidden
/// categories (and with `hide`, parentally locked channels). `content_type`
/// restricts the lookup to live or radio; `None` searches both, live first.
pub fn channel_by_number(
    conn: &Connection,
    source_id: &str,
    number: i64,
    content_type: Option<ContentType>,
    hide: Option<Hide>,
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
    let locked = match hide {
        Some(h) => parental::filter::item_row(conn, h)?,
        None => String::new(),
    };
    // C2: a hidden channel answers null (a correlated probe per candidate).
    let edited = channeledit::item_row(conn, source_id)?;
    let sql = format!(
        "{SELECT_NAMED} WHERE i.source_id = ?1 AND i.number = ?2 AND i.content_type IN ({types}) AND COALESCE(c.hidden, 0) = 0{locked}{edited} ORDER BY CASE i.content_type WHEN 'live' THEN 0 ELSE 1 END, i.position LIMIT 1"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    Ok(stmt
        .query_row(params![source_id, number], read_named)
        .optional()?)
}

/// Previous and next channel around `r` in playlist order, inside `category_id`
/// when given (else across visible categories). Wraps around at both ends.
/// `english_only` skips channels that are clearly in another language, `hide`
/// parentally locked ones.
pub fn neighbors(
    conn: &Connection,
    r: &ItemRef,
    category_id: Option<&str>,
    english_only: bool,
    hide: Option<Hide>,
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
    scope.push_str(english_scoped(
        conn,
        english_only,
        &r.source_id,
        r.content_type,
    )?);
    if let Some(h) = hide {
        scope.push_str(&parental::filter::scoped(
            conn,
            &r.source_id,
            r.content_type,
            h,
            "?1",
            "?2",
        )?);
    }
    // C2: zapping skips hidden channels.
    scope.push_str(&channeledit::scoped(
        conn,
        &r.source_id,
        r.content_type,
        "?1",
        "?2",
    )?);
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
/// categories excluded, with `english_only` titles clearly in another
/// language too, and with `hide` parentally locked items.
pub fn recently_added(
    conn: &Connection,
    source_id: Option<&str>,
    content_type: ContentType,
    limit: usize,
    english_only: bool,
    hide: Option<Hide>,
) -> CoreResult<Vec<NamedRow>> {
    let limit = limit.clamp(1, MAX_PAGE_LIMIT as usize);
    let mut args: Vec<SqlValue> = vec![content_type.as_str().to_string().into()];
    let mut sql = format!(
        "{SELECT_NAMED} WHERE i.content_type = ?1 AND i.added IS NOT NULL AND COALESCE(c.hidden, 0) = 0{}",
        english_clause(conn, english_only)?
    );
    if let Some(h) = hide {
        sql.push_str(&parental::filter::item_row(conn, h)?);
    }
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
/// compatible year (equal, or unknown on either side); `hide` drops
/// parentally locked ones.
pub fn same_title(conn: &Connection, r: &ItemRef, hide: Option<Hide>) -> CoreResult<Vec<NamedRow>> {
    let Some(item) = get(conn, r)? else {
        return Err(CoreError::NotFound(format!("item {} not found", r.item_id)));
    };
    let (derived, derived_year) = title_base(&item.title);
    let base = item.title_base.clone().unwrap_or(derived);
    let year = item.year.or(derived_year);
    if base.trim().is_empty() {
        return Ok(Vec::new());
    }
    let locked = match hide {
        Some(h) => parental::filter::item_row(conn, h)?,
        None => String::new(),
    };
    let sql = format!(
        "{SELECT_NAMED} WHERE i.content_type = ?1 AND i.title_base = ?2 COLLATE NOCASE AND i.source_id <> ?3 AND (?4 IS NULL OR i.year IS NULL OR i.year = ?4){locked} ORDER BY i.source_id, i.position LIMIT 50"
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
/// `english_only` drops channels that are clearly in another language, `hide`
/// parentally locked ones.
pub fn all_live_channels(
    conn: &Connection,
    source_id: &str,
    english_only: bool,
    hide: Option<Hide>,
) -> CoreResult<Vec<NamedRow>> {
    let locked = match hide {
        Some(h) => parental::filter::scoped(conn, source_id, ContentType::Live, h, "?1", "'live'")?,
        None => String::new(),
    };
    // C2: nothing at all while the source hides no channel.
    let edited = channeledit::scoped(conn, source_id, ContentType::Live, "?1", "'live'")?;
    let sql = format!(
        "{SELECT_NAMED} WHERE i.source_id = ?1 AND i.content_type = 'live' AND COALESCE(c.hidden, 0) = 0{}{locked}{edited} ORDER BY i.position LIMIT {ALL_LIVE_CAP}",
        english_scoped(conn, english_only, source_id, ContentType::Live)?
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt
        .query_map([source_id], read_named)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Boot: stores the English-only verdicts of catalogs written before
/// migration 0018, in the background (readers use the per-row rule for them
/// until then; see [`language::backfill_pending`]).
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    tokio::spawn(async move {
        // Holds the write lock per catalog: other writes wait for it (DB-2).
        let done = state
            .db_call(|c| {
                let _long = crate::db::long_write();
                Ok(language::backfill_pending(c)?)
            })
            .await;
        match done {
            Ok(0) => {}
            Ok(n) => tracing::info!(catalogs = n, "stored English-only verdicts"),
            Err(err) => tracing::warn!(%err, "could not store English-only verdicts"),
        }
    });
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
    fn stored_archive_lengths_are_clamped_on_read() {
        let mut row = item("1", "a", "Old", 0);
        row.archive_hours = Some(i64::MAX / 2);
        let a = row.archive().unwrap();
        assert_eq!(a.duration_hours, Some(8784));
        row.archive_hours = None;
        row.extra = serde_json::json!({ "catchup": { "type": "xc", "days": 9_999_999 } });
        assert_eq!(row.catchup().unwrap().days, Some(366));
        row.extra = serde_json::json!({ "catchup": { "type": "xc", "days": -5 } });
        assert_eq!(row.catchup().unwrap().days, Some(0));
    }

    /// IN-3: a title base worked out before the write is the one the
    /// writer would have stored; live rows and set bases are left alone.
    #[test]
    fn derived_title_base_matches_the_writer() {
        let mut movie = item("1", "a", "|EN| The Matrix (1999)", 0);
        movie.content_type = ContentType::Movie;
        movie.derive_title_base();
        let (base, year) = title_base("|EN| The Matrix (1999)");
        assert_eq!(movie.title_base.as_deref(), Some(base.as_str()));
        assert_eq!(movie.year, year);
        let mut dated = item("2", "a", "Heat (1995)", 0);
        dated.content_type = ContentType::Series;
        dated.year = Some(1996);
        dated.derive_title_base();
        assert_eq!(dated.year, Some(1996), "the row's own year wins");
        let mut live = item("3", "a", "Heat (1995)", 0);
        live.derive_title_base();
        assert_eq!(live.title_base, None);
        let mut set = item("4", "a", "Heat (1995)", 0);
        set.content_type = ContentType::Movie;
        set.title_base = Some("heat".into());
        set.derive_title_base();
        assert_eq!((set.title_base.as_deref(), set.year), (Some("heat"), None));
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
