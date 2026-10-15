# Catalog

Code: `crates/iptv-core/src/catalog/`. Tests: `crates/iptv-core/tests/catalog_query.rs` plus unit tests in `mod.rs` and `title.rs`.

The catalog is the `items` and `categories` tables (C3) for every source kind. Importers write it; the UI reads it through `catalog.*` rpc. One row shape (`ItemRow`) serves live, radio, movie and series items.

## Layout

| File | Role |
| --- | --- |
| `mod.rs` | `ItemRow`, `CategoryRow`, `CatalogQuery`, `NamedRow`, `CatalogWriter`, `replace_catalog`, `update_counts`, `source_counts`, queries, search, the C5 `From` impls. |
| `title.rs` | `title_base(title) -> (base, year)` for multi-source VOD matching. |
| `rpc.rs` | Every `catalog.*` command in C4. |

## Writing

Two entry points, both one write transaction per call:

- `replace_catalog(conn, source_id, content_type, categories, &mut items)` replaces one `(source, content type)`. Xtream and Stalker importers use it per type.
- `CatalogWriter` is for streaming writers that see several content types in one pass (the m3u importer). Open a transaction first, then:

```rust
let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
let mut w = CatalogWriter::begin(&tx, source_id, &[ContentType::Live, ContentType::Movie])?;
for row in rows { w.insert(&row)?; }          // returns false for a duplicate id
w.finish(&[(ContentType::Live, live_cats), (ContentType::Movie, movie_cats)])?;
tx.commit()?;
```

`begin` refuses to run outside a transaction. It saves the hidden category ids, then deletes the old items and categories of those types. `finish` inserts categories with their hidden flag restored, adds an "Uncategorized" category for any `category_id` used by items but not declared, recomputes `item_count`, and refreshes `source_counts`. If anything fails, the caller drops the transaction and the previous catalog stays.

Duplicate `(content_type, item_id)` rows keep the first one (`INSERT OR IGNORE`). Movie and series rows without `title_base` get it, and `year` when missing, from `title_base(title)`.

### FTS during bulk writes

`items_fts` is an external-content FTS5 table kept in step by triggers. Per-row trigger updates made a 50k import take about 2 s on their own. Migration 0002 adds `fts_suspend(source_id)` and makes `items_ai` and `items_ad` skip rows whose source has a row there. `CatalogWriter` inserts that row in `begin`, deletes the old FTS entries with one `INSERT ... SELECT 'delete'`, and in `finish` indexes the new rows with one `INSERT ... SELECT` before removing the suspend row. The suspend row never outlives the transaction. Any other code that inserts or deletes items keeps the normal per-row triggers.

`db::configure` also sets `temp_store=MEMORY`. Without it, statement journals for `INSERT OR IGNORE` with triggers went to temp files and tripled insert time.

## extra_json keys

`ItemRow.extra` is stored as `items.extra_json`. The readers (`From<NamedRow>` for `Channel`, `VodItem`, `SeriesItem`) understand these camelCase keys; B3/B4 importers should use the same names:

| Key | Type | Used for |
| --- | --- | --- |
| `plot` | string | `VodItem.plot`, `SeriesItem.plot` |
| `genres` | string array (a comma string is split) | `genres` |
| `durationSeconds` | number | `VodItem.durationSeconds` |
| `tmdbId` | number | `tmdbId` |
| `catchup` | object `{type, days?, source?}` | `Channel.catchup`; turns on `Channel.archive` when the type is usable (`catchup_usable`, case-insensitive: default, append, shift, xc and flussonic, plus the aliases in `CATCHUP_TYPES` in `catchup/m3u.rs`: timeshift is handled as shift; flussonic-hls, flussonic-ts and fs as flussonic), as does `archive_hours > 0` |
| `headers` | object `{userAgent?, referrer?, origin?}` | `Channel.headers` (blank values dropped); the player merges them over the source-level headers |

The m3u importer also stores `tvgName`, `tvgShift`, `vlcOpts` and `kodiProps`. Readers pass unknown keys through untouched.

## Reading

- `query` / `query_named(conn, &CatalogQuery)` returns a `Page`. Limit is capped at 1000. Without a `category_id`, items in hidden categories are left out unless `include_hidden`; with one, that category is listed even if hidden. Sort keys: `name`, `number`, `added`, `rating`, `year`; NULLs sort last. Default direction is ascending for name and number, descending for added, rating and year. Without a sort key the order is item position (playlist order). `min_rating` (the `minRating` arg of `catalog.movies`/`catalog.series`) adds `rating >= ?` to the WHERE clause, so the count and paging cover only items rated at least that.
- `search` with `PageQuery.search` or `catalog.search` tries FTS5 first. Each word becomes a quoted prefix term, so user input cannot inject FTS syntax. When FTS returns nothing, a `LIKE '%text%'` substring search runs instead. FTS results are ordered by rank, then by title length.
- `channel_by_number(conn, source, number, content_type)` skips hidden categories. `content_type` `Some(Live)` / `Some(Radio)` restricts the lookup (any other type is Invalid); `None` checks live before radio. `neighbors` wraps around within the category (or the whole visible list). `recently_added` needs `added` set. `same_title` matches other sources by `title_base` (case-insensitive) with a compatible year, up to 50 rows. `all_live_channels` is capped at 20,000.

## Counts

`source_counts(source_id, channel_count, movie_count, series_count)` is a cache refreshed by `update_counts` after every write. `channel_count` is live channels only. The radio count is not cached: `radio_count` and the source readers count `items` rows of type radio (an index range scan on the primary key). `sources.list` reads it with a join instead of counting large catalogs on every call.

Stalker sources are the exception: their VOD and series are not stored, so `update_counts` leaves their `movie_count` and `series_count` alone, and `set_remote_counts(conn, source_id, movies, series)` records the portal totals (called by `sources::run_import` from the stalker `ImportSummary`).

## Migrations

- 0001: the C3 schema.
- 0002: `source_counts`, `idx_items_title_base`, `idx_sources_position`, `fts_suspend` and the suspend-aware FTS triggers.
- 0003: `idx_epg_programs_url` on `epg_programs(epg_url)`. The EPG store replaces a feed with `DELETE FROM epg_programs WHERE epg_url = ?`, renames staging rows by `epg_url`, and removing an `epg_sources` row cascades by `epg_url`; without the index each of those scans every programme. Lookups by channel already use `idx_epg_programs_chan`.

## rpc

`catalog.categories`, `setCategoryHidden` (NotFound for an unknown id), `setCategoriesHidden` (the list replaces the hidden set), `channels` (`radio: true` lists radio), `movies`, `series`, `item` (shape follows the content type), `channelByNumber` (`contentType?: 'live' | 'radio'`; null when none), `neighbors`, `search` (default 30 per type, max 1001 so the UI can probe its 1000-row step with one extra row; radio is returned in `live`), `recentlyAdded` (movie or series only), `sameTitle`, `allLiveChannels`.

`live.alternates {ref}` (module `live`, failover slice) reads the catalog too: the same live or radio channel on other sources (and duplicates in the same one), found through `idx_items_epg`, `epg_channel_map` and `items_fts`. See `failover.md`.
