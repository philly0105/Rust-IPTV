# Catalog

Code: `crates/iptv-core/src/catalog/`. Tests: `crates/iptv-core/tests/catalog_query.rs`, `catalog_perf.rs` and `l2_query_perf.rs` (read budgets), `l2_query_english.rs` (stored English-only verdicts), `l2_cross_bulk_write.rs` (index rebuild, declared categories, rollback), `l3_search_perf.rs` (search, filtered VOD pages and parental hide mode on 215k items, with results checked against single-list searches) plus unit tests in `mod.rs`, `title.rs` and `language.rs`.

The catalog is the `items` and `categories` tables (C3) for every source kind. Importers write it; the UI reads it through `catalog.*` rpc. One row shape (`ItemRow`) serves live, radio, movie and series items.

## Layout

| File | Role |
| --- | --- |
| `mod.rs` | `ItemRow`, `CategoryRow`, `CatalogQuery`, `NamedRow`, `CatalogWriter`, `replace_catalog`, `update_counts`, `source_counts`, queries, search, the C5 `From` impls. |
| `title.rs` | `title_base(title) -> (base, year)` for multi-source VOD matching. The UI ports it rule for rule in `src/lib/title.ts` (`baseTitle`; tests in `title.test.ts`); change both together. `snapshotTitle(ref, title)` cleans a saved movie or series snapshot title at display time and leaves channels as they are, so the dashboard, library (Continue watching, Recent) and My List rows read like the detail page, including snapshots saved before the player stored the base title. The player itself saves the core's `titleBase` when its query cache holds the item (`snapshotOf` in `src/features/player/store.ts`). |
| `language.rs` | The English-only rule (`title_verdict`, `category_verdict`, `combine`), the stored-verdict helpers, `backfill_pending` and `hidden_rowids`. |
| `rpc.rs` | Every `catalog.*` command in C4. |

## Writing

Two entry points, both one write transaction per call:

- `replace_catalog(conn, source_id, content_type, categories, &mut items)` replaces one `(source, content type)`. Only tests call it now.
- `CatalogWriter` is for writers that replace several content types in one transaction: the m3u importer, and `xtream::sync::replace_catalogs`, which the Xtream and Stalker importers use for every type they write (xtream.md, stalker.md). Open a transaction first, then:

```rust
let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
let mut w = CatalogWriter::begin(&tx, source_id, &[ContentType::Live, ContentType::Movie], cancel)?;
w.declare_categories(ContentType::Live, &live_cats);   // optional: final verdicts on insert
w.declare_categories(ContentType::Movie, &movie_cats);
for row in rows { w.insert(&row)?; }          // returns false for a duplicate id
w.finish(&[(ContentType::Live, live_cats), (ContentType::Movie, movie_cats)])?;
tx.commit()?;
```

`begin` refuses to run outside a transaction. `cancel` is the import run's token, taken before waiting for the write lock; `None` looks up the source's writer token instead (`sources::writer_cancel_token`), for writers outside an import run. `begin` saves the hidden category ids, then deletes the old items and categories of those types. `finish` inserts categories with their hidden flag restored, adds an "Uncategorized" category for any `category_id` used by items but not declared, corrects the English-only verdicts (below), recomputes `item_count`, and refreshes `source_counts`. If anything fails, the caller drops the transaction and the previous catalog stays. After the commit, the m3u, Xtream and Stalker importers run `db::checkpoint_truncate` on the same connection: a catalog rewrite grows the WAL by about the catalog's size, and the TRUNCATE checkpoint folds it back and empties the WAL. It never waits on a busy reader; a later checkpoint finishes the job. An XMLTV ingest does the same (epg.md).

Duplicate `(content_type, item_id)` rows keep the first one (`INSERT OR IGNORE`). Movie and series rows without `title_base` get it, and `year` when missing, from `title_base(title)`.

### English-only verdict

Migration 0018 stores the English-only verdict with each item: `items.non_english` is 1 when the item is clearly in another language (the rule in `language.rs`, which mirrors `src/features/vod/lib/language.ts`). The title decides when it carries a language tag; otherwise the category name does.

- `declare_categories(ct, &categories)` gives the writer the categories of a type before their rows; it computes `category_verdict` of each name as it will be stored (the first category with an id wins, as in `finish`, which must get the same categories). An untagged row in a declared category then gets its final verdict on insert, `combine(title_verdict, category_verdict)`, and `finish` never touches it. The m3u importer declares each group before that group's first row, and `xtream::sync::replace_catalogs` declares every type's categories before any row, so Xtream, Stalker and m3u imports store final verdicts on insert.
- Otherwise `insert` stores the title's guess, `language::title_guess(title_verdict(title))`: the verdict for a category whose name says nothing. It also records, per category, the rowids of titles without a tag (`TITLE_UNDECIDED`) and of untagged titles in a foreign script (`TITLE_UNDECIDED_FOREIGN`). This covers rows whose `category_id` no declared category has, and writers that declare nothing (`replace_catalog`).
- For those rows, `finish` computes `category_verdict(name)` for each category as stored (an undeclared id uses the "Uncategorized" name) and, where `category_changes(verdict)` says the category overturns the guess, rewrites just those rows with `UPDATE items SET non_english = ? WHERE rowid = ?`: untagged titles become hidden, foreign-script titles become shown. Titles with their own tag never change. It then deletes the `english_pending` rows of its types.

`english_pending(source_id, content_type)` lists the catalogs whose rows were written before migration 0018 and still hold the column default 0. The migration seeds it with every `(source_id, content_type)` in `items`, and its rows go when the source is removed (`ON DELETE CASCADE`). At boot `catalog::init` spawns `language::backfill_pending`, which takes one Immediate transaction per pair, so user writes interleave: it re-checks that the pair is still pending (a rewrite since may have stored the verdicts), sets `non_english = 1` on the rows the rule hides, and deletes the pair. Until then readers fall back to the per-row rule for that pair:

- Readers of one source and type (`english_scoped`: `query_named` pages and counts, VOD year facets, `english_categories`, `neighbors`, `all_live_channels`) add `AND i.non_english = 0` (`language::STORED_SQL`). For a pending pair they use `language::hidden_rowids`, a per-connection `temp.english_hidden` set rebuilt after any write.
- Readers across sources (`english_clause`: search, `recently_added`) use `STORED_SQL` when no pair is pending, and the SQL function `non_english(i.title, c.name)` (`ENGLISH_ONLY_SQL`) while any pair is.

Any new code that writes `items` must keep the column right. Go through `CatalogWriter` (or `replace_catalog`), or set `non_english` from the `language.rs` rule yourself, or insert an `english_pending` row for the pair so the readers fall back and the next boot backfills it. The same holds for code that later changes a title or a category name: the stored verdict does not follow. Today only `CatalogWriter` and `backfill_pending` write items.

Migration 0018 also narrows the `items_au` trigger to `AFTER UPDATE OF title`, so writing the verdict (or any other column) leaves `items_fts` alone.

### FTS during bulk writes

`items_fts` is an external-content FTS5 table kept in step by triggers. Per-row trigger updates made a 50k import take about 2 s on their own. Migration 0002 adds `fts_suspend(source_id)` and makes `items_ai` and `items_ad` skip rows whose source has a row there. `CatalogWriter` inserts that row in `begin`, deletes the old FTS entries with one `INSERT ... SELECT 'delete'`, and in `finish` indexes the new rows with one `INSERT ... SELECT` before removing the suspend row. The suspend row never outlives the transaction. Any other code that inserts or deletes items keeps the normal per-row triggers.

`items_rank` (migration 0020, see Reading) follows the same contract. Its insert and delete triggers skip a suspended source; `begin` deletes the rewritten types' rows with one `DELETE ... WHERE id IN (SELECT rowid FROM items ...)` next to the FTS delete, and `finish` copies the new rows with one `INSERT ... SELECT` after the verdict updates, next to the FTS insert (about 0.11 s per 100k rewritten rows, where per-row triggers cost about 0.65 s per 50k). Its update trigger is unconditional: a verdict update in `finish` touches a row that is not in `items_rank` yet, and `language::backfill_pending` and any other update keep it in step. Code that writes `items` while its source sits in `fts_suspend` must update `items_rank` the way it updates `items_fts`; `crates/iptv-core/tests/m3u_support.rs` has `assert_items_rank`, which the import, bulk-rewrite and search-rank tests run after each kind of write.

`db::configure` also sets `temp_store=MEMORY`. Without it, statement journals for `INSERT OR IGNORE` with triggers went to temp files and tripled insert time.

### Index rebuild for large rewrites

A rewrite that touches at least `BULK_MIN_ROWS` (20,000) rows, counting the rows `begin` deletes and every row offered to `insert` (duplicates included), and at least as many as it leaves in `items` (other sources and types), drops every secondary index of `items` (`maybe_go_bulk`; names and `CREATE` statements from `sqlite_master`, the primary key stays). `finish` runs those statements again before it writes the categories and counts. Building each index once from sorted rows replaces updating all eleven secondary indexes (as of migration 0019) on every row. `items_rank` has no secondary index, so bulk mode leaves it alone; its rows are deleted and copied by the set-based statements above. The check runs in `begin`, before the deletes, and again every `WRITE_BATCH` (1000) rows. Either way it weighs the rewrite only against the rows of other sources and of the source's other types: `count(*)` of `items` minus the rows `begin` is about to delete, and after the deletes (`replaced_gone`) minus the rows inserted so far. That number cannot change inside the writer's transaction, so it is counted once, the first time the check needs it (`kept`), not on every batch.

All of it happens inside the import transaction: readers keep the previous catalog and its indexes until the commit, and a rollback restores them. The costs:

- The drop and the rebuild change the database schema once per large import, so every pooled connection re-reads the schema and re-prepares its cached statements once, on its next use.
- The rebuild sorts each index through temp storage, which `db::configure` keeps in memory (`temp_store=MEMORY`), so peak memory rises by about the size of the largest `items` index while it is built. Migrations, by contrast, sort on disk (`db::migrate` sets `temp_store=FILE`).
- Nothing runs `ANALYZE` or `PRAGMA optimize`, so there are no index statistics to lose. If `ANALYZE` is ever added, a bulk rewrite drops the statistics of those indexes until it runs again.

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

The m3u importer also stores `tvgName`, `tvgShift`, `vlcOpts` and `kodiProps`, and on the series rows it groups from playlist episodes `episodes`, the stored episode list that `m3u.seriesDetail` and `m3u.streamUrl` read (m3u.md, Series). Readers pass unknown keys through untouched.

## Reading

- `query` / `query_named(conn, &CatalogQuery)` returns a `Page`. Limit is capped at 1000. Without a `category_id`, items in hidden categories are left out unless `include_hidden`; with one, that category is listed even if hidden. Sort keys: `name`, `number`, `added`, `rating`, `year`; NULLs sort last. Default direction is ascending for name and number, descending for added, rating and year. Without a sort key the order is item position (playlist order). `min_rating` (the `minRating` arg of `catalog.movies`/`catalog.series`) adds `rating >= ?` to the WHERE clause, so the count and paging cover only items rated at least that.
- A page is read in two statements. The count runs on `items` alone, without the category join. The page then picks its rowids from the sort's index and joins only those: `SELECT_NAMED WHERE i.rowid IN (SELECT i.rowid FROM items i WHERE ... ORDER BY ... LIMIT <n> OFFSET ?) ORDER BY ...`. OFFSET is a bound parameter, so every page of one list shape reuses a single cached statement; LIMIT stays literal because SQLite uses it in its row estimate. The 0018 indexes hold the category, position and verdict, and 0019 adds the rating and year to the sort indexes, so a deep OFFSET skips index entries instead of reading and joining every skipped row (100 to 900 ms near the end of a 100k list without them). In the page statement a rating or year filter on another sort key is written `+i.rating` / `+i.year`, which keeps it out of SQLite's index choice: the sort's index answers the page in order, where the filter's own index would sort every match in a temp b-tree (100 to 340 ms a page on 60k movies). The count keeps the plain columns, where the filter's index helps. A page whose offset is at or past the total returns no rows without running the page statement.
- Search tries FTS5 first. Each word becomes a quoted prefix term, so user input cannot inject FTS syntax. When FTS returns nothing, a `LIKE '%text%'` substring search runs instead. `PageQuery.search` filters the page and keeps the page's sort.
- `catalog.search` and `search` / `search_named` go through `search_groups`, which answers several groups of types in one pass; `catalog.search` passes three (live and radio, movies, series). One FTS statement ranks the matches on `items_rank`, a narrow copy of the columns ranking and filtering need (rowid, source, type, category, verdict, `length(title)` as `title_len`, position; migration 0020), instead of each match's wide `items` row with its URLs and JSON. It collects the matches once (`WITH m AS MATERIALIZED`, `items_fts CROSS JOIN items_rank` so the FTS index drives), keeps each group's best `limit` with a bounded `ORDER BY rank, title_len, position, rowid LIMIT limit` per group (`UNION ALL` of one per non-empty group), and then reads the full rows of those winners only. Ties end on the rowid. On 215k items "th" has 56k matches; the rank, the narrow rows and the per-group top-N keep it at 61-64 ms at p95 in a release build, where a `ROW_NUMBER()` window over every match's `items` row took 155 ms. Its filters test columns of `items_rank` alone (they are written against `items i` and name only columns both tables have), so ranking reads no category row per match: hidden categories are checked only when there are any (in the searched source, or in any source when the search spans them all), as a set of hidden category ids plus an exact key probe for the rows whose id is in it, and the categories join is added only while the per-row English-only rule applies (a pending pair, above). That rule reads the title and the category name, so while it applies the FTS pass ranks on `items` with the `ROW_NUMBER()` window instead, with the same order. When FTS finds nothing in any group, every group falls back together in one substring statement over `idx_items_title` (`rowid IN (SELECT rowid FROM items WHERE title LIKE ?)`), ordered by title length, then title. A group without word-prefix hits next to groups that have some stays empty: filling it would scan every title of the library for a few in-word matches (50 to 120 ms on 220k items). Without a source the inner statement filters on `+content_type`, which keeps SQLite off `idx_items_added`, and the outer pass writes the type and source as `+i.content_type` / `+i.source_id`, so the matched rowids drive it. Channels whose custom name matches come first (channel-edits.md). A group with word-prefix hits answers as a search of its own would.
- `channel_by_number(conn, source, number, content_type)` skips hidden categories. `content_type` `Some(Live)` / `Some(Radio)` restricts the lookup (any other type is Invalid); `None` checks live before radio. `neighbors` wraps around within the category (or the whole visible list). `recently_added` needs `added` set. `same_title` matches other sources by `title_base` (case-insensitive) with a compatible year, up to 50 rows. `all_live_channels` is capped at 20,000.

## Counts

`source_counts(source_id, channel_count, movie_count, series_count)` is a cache refreshed by `update_counts` after every write. `channel_count` is live channels only. The radio count is not cached: `radio_count` and the source readers count `items` rows of type radio (an index range scan on the primary key). `sources.list` reads it with a join instead of counting large catalogs on every call.

Stalker sources are the exception: their VOD and series are not stored, so `update_counts` leaves their `movie_count` and `series_count` alone, and `set_remote_counts(conn, source_id, movies, series)` records the portal totals (called by `sources::run_import` from the stalker `ImportSummary`).

## Migrations

- 0001: the C3 schema.
- 0002: `source_counts`, `idx_items_title_base`, `idx_sources_position`, `fts_suspend` and the suspend-aware FTS triggers.
- 0003: `idx_epg_programs_url` on `epg_programs(epg_url)`. The EPG store replaces a feed with `DELETE FROM epg_programs WHERE epg_url = ?`, renames staging rows by `epg_url`, and removing an `epg_sources` row cascades by `epg_url`; without the index each of those scans every programme. Lookups by channel already use `idx_epg_programs_chan`.
- 0018 (`0018_catalog_query_speed.sql`): `items.non_english`, `english_pending` and the title-only `items_au` trigger (see English-only verdict), and the page indexes. Each one leads with `(source_id, content_type)`, then the sort key, then `position` (the tie-break of every sort), the category and the verdict, so pages and counts of one source and type are index-only scans:
  - `idx_items_cat(source_id, content_type, category_id, position, non_english, year)`, which also serves a category's year facets;
  - `idx_items_title(source_id, content_type, title COLLATE NOCASE, position, category_id, non_english)`, for the name sort and the substring search;
  - `idx_items_pos(source_id, content_type, position, category_id, non_english)`;
  - `idx_items_year(source_id, content_type, year DESC, position, category_id, non_english)`;
  - `idx_items_rating(source_id, content_type, rating DESC, position, category_id, non_english)`, new;
  - `idx_items_added_src(source_id, content_type, added DESC, position, category_id, non_english)`, new.

  The first four replace the indexes of the same name from 0001, 0006 and 0013. Rating, year and added sort descending by default with NULLs last, the natural order of a DESC index. Since 2026-10-19 the file itself creates only `idx_items_cat` and drops the old `idx_items_title`, `idx_items_pos` and `idx_items_year`; the five sort indexes are built once, by 0019 (an upgrade from schema 17 used to build each twice, DB-6 in the performance audit). Migrations are tracked by version, never re-run or hashed, so a database that ran the old file is unaffected.
- 0019 (`0019_guide_search_speed.sql`): recreates the five sort indexes with the rating and the year after the verdict (`idx_items_added_src`, `idx_items_title` and `idx_items_pos` gain both, `idx_items_rating` gains the year, `idx_items_year` the rating), so a page with a minimum rating or a year range reads index entries, not table rows (about 12 ms or less in every measured case, against up to 140 ms on a deep page of 100k movies). It also adds `idx_items_guide` and `epg_search_rows` for the guide search (guide-search.md).
- 0020 (`0020_search_rank.sql`): `items_rank`, one narrow row per item (`id` is the item's rowid) with `source_id`, `content_type`, `category_id`, `non_english`, `title_len` (`length(title)`) and `position`, filled from `items` in the migration and kept in step by suspend-aware insert and delete triggers and an update trigger on the copied columns (see FTS during bulk writes). The search ranks on it (see Reading). It adds about 15 MB per 220k items; the upgrade copies 220k rows in about 0.14 s (`migration_perf.rs`).
- 0021 (`0021_epg_channel_shift.sql`): `epg_channel_shift`, a channel's own guide shift in minutes, keyed like `epg_channel_map` (epg.md).

## rpc

`catalog.categories` (`includeHidden?` for category management, `includeLocked?` for the parental Lock groups dialog, see parental.md), `setCategoryHidden` (NotFound for an unknown id), `setCategoriesHidden` (the list replaces the hidden set), `channels` (`radio: true` lists radio), `movies`, `series`, `item` (shape follows the content type), `channelByNumber` (`contentType?: 'live' | 'radio'`; null when none), `neighbors`, `search` (default 30 per type, max 1001 so the UI can probe its 1000-row step with one extra row; radio is returned in `live`), `recentlyAdded` (movie or series only), `sameTitle`, `allLiveChannels`.

`live.alternates {ref}` (module `live`, failover slice) reads the catalog too: the same live or radio channel on other sources (and duplicates in the same one), found through `idx_items_epg`, `epg_channel_map` and `items_fts`. See `failover.md`.
