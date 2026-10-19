# VOD browsing: year filter and watched

Code: `crates/iptv-core/src/catalog/vodfilter.rs` and `crates/iptv-core/src/userstate/watched.rs` (core), and `src/features/vod/` (UI: `lib/years.ts`, `lib/paging.ts`, `components/VodFilterBar.tsx`, `hooks/useWatched.ts`, `pages/CategoryGridPage.tsx`, `pages/SeriesDetailPage.tsx`). Tests: `crates/iptv-core/tests/vod_filters.rs`, `crates/iptv-core/tests/l2_data_series_watched.rs` (a series' row following its episodes), unit tests in `vodfilter.rs`, `src/features/vod/test/vodFilters.test.tsx`, and `e2e/vod-filters.spec.ts`.

Run 2 contract C4 adds three ways to narrow a Movies or Series grid: a release-year range, a watched tick on each poster, and a "Hide watched" switch. Series pages also get "Mark series watched".

## What "watched" means

A movie or series is watched when it has an item-level row in `playback_positions` (`episode_id = ''`) with `watched = 1`. Run 1's `WatchlistEntry.watched` uses the same definition.

- A movie gets the row when playback finishes it (a save at 95 % of the duration or later) or when someone marks it watched.
- A movie keeps it while it is played again. The player's saves during a replay store the new position but leave `watched = 1`, so the tick stays, Hide watched keeps the film out, and it does not come back into Continue Watching. A replay stopped between 5% and 95% of the duration is still a resume point: the player resumes there and the movie page offers Resume and Start over beside the watched mark (`isWatchedReplay` in the player store, used by `isResumable`). Under 5% the next play starts over; at 95% the film is finished again. An episode works the other way: a save past 5 s clears its flag, so a rewatched episode becomes the series' place to resume. Only unmarking clears a movie's flag.
- A series gets the row from "Mark series watched" (`userstate.setWatched` without an episode id), and also when an episode write leaves every episode the provider lists watched (`watched::sync_series_mark`, the same rule as the detail page's `seriesWatchedWrite`). The core checks after a live `positions.set` that finishes an episode and after a `userstate.setWatched` episode mark, so finishing the last episode in the player or marking it from Recently watched counts too. The episode list comes from the Xtream series cache, else from the provider within 4 s (Stalker always asks the portal). When the list is unknown (an m3u source, the provider down or too slow), or the write is a dated undo or restore, nothing changes. Unmarking any episode clears the series row.
- Unmarking deletes the row (`set_watched(.., false)` removes the position), so the resume point goes too. The grid's Undo toast restores the captured rows.

## Core

### `catalog.movies` / `catalog.series` filters

`VodListArgs` takes `yearFrom?`, `yearTo?` and `hideWatched?`. The catalog builds a `VodFilter` and checks it with `vodfilter::validate`: each bound must be in 1900..=2100 and `yearFrom <= yearTo`, otherwise the call returns `invalid`. `query_named` appends the filter to both the count and the page statement with the same arguments, so they filter the same set and `total` counts the filtered titles. The count uses `vod_filter_sql`; the page uses `vod_filter_sql_on` with `+i.year` unless the grid is sorted by year (and writes a minimum rating as `+i.rating` unless it is sorted by rating), so the sort's index answers the page in order (catalog.md).

- Year bounds compare `items.year` and are inclusive. When only one bound is set, the other defaults to its end of 1900..=2100. A NULL year fails every comparison, and a junk year (`0`, `20210`) falls outside the range, so titles without a usable year drop out as soon as one bound is set. The facets leave the same years out, so no chip can select them.
- `hideWatched` adds `i.rowid NOT IN (SELECT it.rowid FROM playback_positions p JOIN items it ON <primary key> WHERE p.episode_id = '' AND p.watched = 1)`. The subquery does not depend on the outer row, so SQLite builds the set once per statement. The set holds only watched titles, and the rowid is in every index, so a `count(*)` over 50k titles stays an index-only scan. The parental hide filter uses the same pattern for item locks.
- Migration `0013_catalog_edits.sql` adds `idx_items_year`. Migrations 0018 and 0019 rebuild it and the other sort indexes with the category, the English-only verdict, the rating and the year after the sort key, so a year range or a minimum rating on a page sorted by another key reads index entries rather than table rows. A page past the filtered total skips the page statement, so a decade with no titles does not walk the whole sort index.

### `catalog.yearFacets`

Args are `{sourceId, contentType: 'movie' | 'series', categoryId?, hideWatched?}`. The command returns `{year, count}[]` with the newest year first. It counts the set the grid would show:

- years inside 1900..=2100 only
- one category when `categoryId` is given; otherwise every category except hidden ones (the same `NOT IN` that `query_named` uses)
- the English-only scope, when that setting is on
- the parental hide filter, when parental controls are on in hide mode
- titles with an item-level watched row, left out when `hideWatched` is true (absent means false), using the same `i.rowid NOT IN` set that `vod_filter_sql` adds, so the counts match the grid under Hide watched

Live and radio content types return `invalid`. Stalker VOD is never stored in `items`, so a Stalker source gets an empty list.

### `positions.watchedContains`

Args are `{refs: ItemRef[]}` with 1..=500 refs; anything else returns `invalid`. It returns the refs that are watched, in input order with duplicates collapsed. It reads `playback_positions` directly and does not join the catalog, so it also answers for Stalker titles. `watched_set` gives the same answer as `ItemKey` strings for Rust callers.

## UI

### Filter row

`VodFilterBar` sits under the grid toolbar on every Movies and Series grid.

- Decade chips. For m3u and Xtream sources the chips come from `catalog.yearFacets`, summed per decade. Each chip has a thin level bar showing its share of the busiest decade, and its accessible name includes the count ("1990s, 8 titles"). Stalker portals cannot report years up front, so they get fixed chips from the 1950s to the 2020s without counts. If the facet call fails, the row falls back to those fixed chips. While facets load, the row shows skeleton pills. When a catalog has no years at all and no range is set, the chip group is hidden. Clicking the active chip clears it. With Hide watched on, the facet call adds `hideWatched: true`, so the counts and level bars describe the titles the grid keeps; flipping the switch keeps the current chips until the new counts arrive.
- Exact range. Two selects, From and To. Their first option ("From" or "To") means no bound. A reversed pick is swapped. When the range covers exactly one decade, that decade's chip shows as pressed.
- Hide watched. A switch at the end of the row. It writes `settings.vodHideWatched` through the optimistic `useUpdateSettings`, so the choice holds across grids and restarts.

On a phone the chips scroll sideways inside their own row, so the page never scrolls horizontally. The row uses logical properties (`ms-auto`, `start`/`end`), and its transitions sit behind `motion-safe:`.

### URL

The range lives in the URL as `yf` and `yt` (both inclusive), so a filtered grid can be linked, reloaded and restored with Back. `readGridParams` reads them through `readYearRange`. Values that are not four-digit years in 1900..2100 are ignored, and a reversed pair is swapped, so a hand-edited link never reaches the core as an invalid call. Both VirtualGrids are keyed on the category only, so a filter change keeps the grid mounted: each page shows its old titles until the new page answers (`sameGridSlot` in `useVodPage`), and the old posters dim to 60 % once the wait passes 150 ms (`aria-busy` on the grid's wrapper). A new sort, search, rating, English-only state or year range (`filterKey`) scrolls the grid to the top and, through VirtualGrid's `resetKey`, puts the keyboard cursor on the first title (or clears it when the grid has no keyboard focus). Hide watched is not part of that key, so flipping it keeps the scroll position and the cursor.

### Paging

`buildPageRequest` sends `yearFrom`, `yearTo` and `hideWatched` only to `catalog.*`. Stalker pages come straight from the portal, so a year range or Hide watched switches a Stalker grid to the in-order loader (`useVodPagesInOrder`), the same one the rating and English-only filters use. The grid filters the loaded pages with `filterByYear` (the same 1900..2100 rule as the core) and the watched set. With Hide watched on, a page is shown only once its watched lookup has answered, so watched titles never flash in and then disappear. The filtered count is final once every page has loaded.

### Watched tick

Each loaded page asks `positions.watchedContains` once (`useWatchedKeys`, `useWatchedPages`), and the cells of that page share the query. A watched poster shows a check in the top-end corner, beside the rating chip, and its accessible name ends with "Watched". A watched title does not show a resume bar. If the lookup fails, nothing is ticked.

`useSetWatched` and the grid's Undo call `invalidateWatched`, which refreshes `positions.*`, `userstate.*`, and the `catalog.movies` / `catalog.series` pages and `catalog.yearFacets` counts fetched with `hideWatched`, so a newly watched title leaves a filtered grid right away.

### Keys (area Vod)

| Key | Action | Description key |
| --- | --- | --- |
| `w` | Marks the title under the grid cursor watched, or unwatched if it already is. It asks the core first, so it never acts on a stale tick. A toast confirms and offers Undo. | `vod:shortcutWatched` |
| `shift+w` | Turns Hide watched on or off. | `vod:shortcutHideWatched` |

`w` is also bound in the My List area. The bindings are scoped to their pages, so they do not clash.

### Empty states

When the grid comes back empty, the reason is checked in this order: the rating minimum, then the year range ("No titles from these years", with an "All years" button), then Hide watched ("You have watched everything here", with "Show watched"), then search, then an empty category.

### Series detail

The hero actions include a series-level `WatchedButton` (labels `markSeriesWatched` / `markSeriesUnwatched`). It writes the item-level row, and the page reads it back from `positions.forSeries`. The season button is separate and still marks episodes. Next to it, Download season queues every episode of the selected season that has no download yet, or only a failed, cancelled or missing one (downloads.md).

### Preferred source

A movie that other sources carry too (`catalog.sameTitle`) has an Other sources dialog, where one copy can be pinned so Play uses it. Pins are kept by the core in `vod_source_pins`, one per title match key (`matchKey` in `src/features/vod/lib/pins.ts`: the normalized title base plus the year), through `sourcePins.get`, `sourcePins.set` and `sourcePins.clear` (`useSourcePin`). Backups export and import the table (backup.md). Builds before these commands kept pins in localStorage (`vod.sourcePins.v1`); the first pin read of a page load moves them into the core (`migrateLocalPins`): a key the core already has keeps its pin, a pin whose source is gone is dropped, and the local copy is deleted once nothing is left to retry.

## Bundle budget

English `vod.json` is bundled into the entry chunk, and the C4 strings add 422 bytes to it (minified JSON). The filter row, hooks and series button load with the VOD route chunk.
