# VOD browsing: year filter and watched

Code: `crates/iptv-core/src/catalog/vodfilter.rs` and `crates/iptv-core/src/userstate/watched.rs` (core), and `src/features/vod/` (UI: `lib/years.ts`, `lib/paging.ts`, `components/VodFilterBar.tsx`, `hooks/useWatched.ts`, `pages/CategoryGridPage.tsx`, `pages/SeriesDetailPage.tsx`). Tests: `crates/iptv-core/tests/vod_filters.rs`, `crates/iptv-core/tests/l2_data_series_watched.rs` (a series' row following its episodes), unit tests in `vodfilter.rs`, `src/features/vod/test/vodFilters.test.tsx`, and `e2e/vod-filters.spec.ts`.

Run 2 contract C4 adds three ways to narrow a Movies or Series grid: a release-year range, a watched tick on each poster, and a "Hide watched" switch. Series pages also get "Mark series watched".

## What "watched" means

A movie or series is watched when it has an item-level row in `playback_positions` (`episode_id = ''`) with `watched = 1`. Run 1's `WatchlistEntry.watched` uses the same definition.

- A movie gets the row when playback finishes it (a save at 95 % of the duration or later) or when someone marks it watched.
- A movie keeps it while it is played again. The player's saves during a replay store the new position but leave `watched = 1`, so the tick stays, Hide watched keeps the film out, and it does not come back into Continue Watching. A replay stopped between 5% and 95% of the duration is still a resume point: the player resumes there and the movie page offers Resume and Start over beside the watched mark (`isWatchedReplay` in the player store, used by `isResumable`). Under 5% the next play starts over; at 95% the film is finished again. An episode works the other way: a save past 5 s clears its flag, so a rewatched episode becomes the series' place to resume. Only unmarking clears a movie's flag.
- A series gets the row from "Mark series watched" (`userstate.setWatched` without an episode id), and also when an episode write leaves every episode the provider lists watched (`watched::sync_series_mark`, the same rule as the detail page's `seriesWatchedWrite`). The core checks after a live `positions.set` that finishes an episode and after a `userstate.setWatched` episode mark, so finishing the last episode in the player or marking it from Recently watched counts too. The episode list comes from the Xtream series cache, else from the provider within 4 s (Stalker always asks the portal); an m3u series has it in its row (m3u.md, Series). When the list is unknown (the provider down or too slow), or the write is a dated undo or restore, nothing changes. Unmarking any episode clears the series row.
- Unmarking deletes the row (`set_watched(.., false)` removes the position), so the resume point goes too. The grid's Undo toast restores the captured rows.

## Core

### `catalog.movies` / `catalog.series` filters

`VodListArgs` takes `yearFrom?`, `yearTo?` and `hideWatched?`. The catalog builds a `VodFilter` and checks it with `vodfilter::validate`: each bound must be in 1900..=2100 and `yearFrom <= yearTo`, otherwise the call returns `invalid`. `query_named` appends the filter to both the count and the page statement with the same arguments, so they filter the same set and `total` counts the filtered titles. The count compares `i.year`; the page uses `+i.year` unless the grid is sorted by year (and writes a minimum rating as `+i.rating` unless it is sorted by rating), so the sort's index answers the page in order (catalog.md). In a category the count writes `+i.year` and `+i.rating` too, so it reads the category's range, and a list of 3,000 titles or fewer sorted by another key reads its category's or its filter's range and sorts it (catalog.md, Reading).

- Year bounds compare `items.year` and are inclusive. When only one bound is set, the other defaults to its end of 1900..=2100. A NULL year fails every comparison, and a junk year (`0`, `20210`) falls outside the range, so titles without a usable year drop out as soon as one bound is set. The facets leave the same years out, so no chip can select them.
- `hideWatched` adds `i.rowid NOT IN (SELECT it.rowid FROM playback_positions p JOIN items it ON <primary key> WHERE p.episode_id = '' AND p.watched = 1)`. The subquery does not depend on the outer row, so SQLite builds the set once per statement. The set holds only watched titles, and the rowid is in every index, so a `count(*)` over 50k titles stays an index-only scan. The parental hide filter uses the same pattern for item locks.
- Migration `0013_catalog_edits.sql` adds `idx_items_year`. Migrations 0018 and 0019 rebuild it and the other sort indexes with the category, the English-only verdict, the rating and the year after the sort key, so a year range or a minimum rating on a page sorted by another key reads index entries rather than table rows. A page past the filtered total skips the page statement, so a decade with no titles does not walk the whole sort index, and a decade with only a few reads its range of `idx_items_year`.

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

### Landing

A source's Movies and Series pages (`VodLandingPage`) open with rails, the way a media library does, and keep every category one click from the top:

- A row of category chips under the header (`CategoryChips`): up to `CATEGORY_CHIP_LIMIT` (24) categories with titles in the provider's order, as links in the kit's filter-chip look (`filterChipClass`), locked ones marked. The chips scroll sideways, and the edge that hides chips fades. After them come "All categories" with the count, a quiet link with a chevron rather than a chip (first and brighter, it read as a filter that was on), and Manage categories beside it. Below md, where the shell header drops its subtitle, the row starts with the title count and All categories ends that line, while the chips take the next line across the width, ended by Manage categories (beside the two buttons a phone showed about one chip). "All categories" opens the index below, takes its heading to the top of the view and moves focus to it. Pressed while the categories are still loading, it wins over the landing's scroll memory, which then does not restore the remembered offset, and the heading is taken to the top again when the categories arrive, since their rails go in above it. The press counts for the landing it was made on only: React Router keeps the page mounted when the sidebar opens another source's landing (or Series after Movies), and that landing restores its own offset.
- Rails: Continue watching for this source and section (when something was started here; each card opens its detail page, where Resume is the primary action), Recently added, Top rated (not on a Stalker portal, which sorts by name or date added only, so its "top rated" would be the newest titles), then one rail per category for the first `CATEGORY_RAIL_LIMIT` (12) categories with titles. Locked categories get no rail, so their posters never show before the PIN. Each `CatalogRail` is the first page of its grid, asked with the grid's own arguments (sort, minimum rating, Hide watched), so See all opens on a cached page. A rail is a placeholder of its own height until it nears the viewport, so the page asks only for rails the user reaches; a rail whose grid is empty goes away.
- The full index, folded, under the rails: "Browse all categories" is a disclosure (`aria-expanded`), and whether it is open is kept in localStorage (`vod.categoryIndexOpen`). Opened from the lower half of the view (at the bottom of the page, where scrolling down to it leaves the heading), it takes the heading to the top and focuses it, as "All categories" does; higher up the page stays where it is. Open, it has a filter field and the `CategoryIndex` list, which starts with All movies or All series, and it is at least as tall as the view (the scroller's `clientHeight`, `useClientHeight`, measured while the index is folded too, so the floor is in place in the render that opens it and the heading can go to the top above a short list), so a filter that narrows the list cannot shorten the page under the view: the browser would clamp the scroll and the field being typed in would drop down the screen. Back from a category restores the scroll offset and puts focus on the category that was opened.

Typing in the header's search field opens the source's search page with the text so far.

The source is named only when more than one is set up (`useShowSourceName`): then the header subtitles of the landing, a category grid and a detail page, the landing's line below md, the movie's watch stage and the search placeholder ("Search Northwind Premium") name it. With one source they show the count alone, the detail header has no subtitle, and the search field reads "Search this source" (short enough for the field on a 1024 px tablet, and not "Search everything", the name of the palette button beside it). A detail page's About facts always name it.

### Detail pages

A movie or series page opens on a full-width hero (`DetailHero`): the backdrop runs across the top and fades only under the text, and the poster and the title sit on its lower edge. A title with no artwork at all (none given, or every attempt failed) gets the title's tint instead of a flat page: two soft radial washes from the top edge in the poster fallback's hue (`heroWash`, `hueOf` of the same title), pale in the light theme and deep in the dark one, under the same fades, so the text keeps its contrast. Under the title come the meta line, the action row, the resume bar with its time left, and the plot. The action row has two groups, so a narrow column wraps between them and never inside one: the text buttons (`actions`: one primary, Play or Resume, and Trailer when there is one), then the round icon buttons (`icons`, a `HeroIconGroup` of `HeroIcon`s): My List, Favorite, Watched, Download for a movie, and a More menu for what is left (Start over, Other sources, the parental lock). Favorite is a pressed toggle with the heart filled in, so the page says whether the title is a favourite. Below 640 px the primary takes the whole width, the resume bar sits right under it, and the icons become a row of equal tiles, each circle over a short caption (My List, Favorite, Watched, Download, More), since touch shows no tooltips. The catalogue pages put Back in the shell header (ui-shell.md); My Videos' detail page reuses the same hero with its own Back in the hero's corner.

An Xtream title opened from a grid, a rail, Recently added or search shows its hero from the catalog row that list holds while the provider answers (VOD-DETAIL-PLACEHOLDER, [performance.md](performance.md#vod-landing-and-detail-pages)): title, poster, year, rating and format at once, the plot, backdrop, cast, runtime and genres when the answer lands. A movie's Play works from the first frame; a series shows Play and its Watched button disabled and placeholder episode rows until its seasons arrive (marking the series marks every episode, and the episodes come with the seasons). A title no list holds (a cold link, My List), an m3u title and a Stalker title show the skeleton as before.

Play switches the page to its watch view (`WatchStage`): the player at full content width, under a slim bar with the title, the source (or the playing episode) and a close button; Escape closes it too. The player leaves out its own title bar there, and the shell header names the section (Movies or Series) instead of repeating the title; the window and tab keep the title through the header's `documentTitle` (ui-shell.md). Under the player is the hero's own icon set (`HeroIconGroup`), so the two states share one look: round buttons, a pressed toggle drawn as a filled glyph, other sources and the lock in More. A series page puts Previous episode first in that row.

### Search: Top results

When a search finds more than one kind of result, the search page opens on Top results (`TopResults` in `SearchPage.tsx`) instead of the first kind's tab: a section for each kind it found, each with up to 12 posters, 6 channels or 5 programmes and a See all that opens its tab. The sections come in order of how many results each has (a tie keeps movies, series, channels), with programmes last, so the kind the query mostly found leads, on a phone too. In a search across several sources, posters fold the same title from different sources into one card that says how many sources have it; the per-type tabs list every copy with its source badge. A section heading counts what its tab counts, every copy, and the "2 sources" chip explains a card that stands for two. When movies and series each hold three titles or fewer, they share one "Movies and series" rail (with no See all, since no single tab holds both) instead of two short rails. With one kind of result the page shows that kind's tab, as before. Programme rows (`ProgrammeList`, in Top results and the Programmes tab) fold a show airing on several channels at once (the same title and start) into one row: the title opens the guide at the first channel's programme, and each other channel is a small link on the line under it that opens the guide at its own (the first 8; the rest behind a Show all toggle, which counts every channel, the title's too, as the palette's row does, so one show cannot fill the page), so "Inside the NBA" at 9:00 on six channels takes one row instead of six, and Top results' five rows are five shows. Every wrapped line of links starts under the channel name above, and under a coarse pointer each link and the toggle take `TOUCH_TARGET`. Back from the guide to a channel that was behind Show all opens its row again (the opened rows are kept per history entry), so focus can land on its link. A programme on the air has a LIVE pill beside its title, so its row is as tall as the others. The rows keep each hit's place in the whole list (`data-grid-index`), which focus and Back's return go by, and Up and Down step through the rows and the channel links.

### Filter row

`VodFilterBar` (`DecadeChips`, `YearRangeFields`) on every Movies and Series grid. The decade chips sit in the grid's toolbar beside the search and the sort; the exact range and Hide watched are in a panel under it that the toolbar's Filters button opens, whose badge counts the filters that are on. Below 640 px the sort and the chips fold into that panel too, so the grid starts right under the search row.

- Decade chips. For m3u and Xtream sources the chips come from `catalog.yearFacets`, summed per decade. Each chip has a thin level bar showing its share of the busiest decade, and its accessible name includes the count ("1990s, 8 titles"). Stalker portals cannot report years up front, so they get fixed chips from the 1950s to the 2020s without counts. If the facet call fails, the row falls back to those fixed chips. While facets load, the row shows skeleton pills. When a catalog has no years at all and no range is set, the chip group is hidden. Clicking the active chip clears it. With Hide watched on, the facet call adds `hideWatched: true`, so the counts and level bars describe the titles the grid keeps; flipping the switch keeps the current chips until the new counts arrive.
- Exact range. Two selects, From and To. Their first option ("From" or "To") means no bound. A reversed pick is swapped. When the range covers exactly one decade, that decade's chip shows as pressed.
- Hide watched. A switch at the end of the panel. It writes `settings.vodHideWatched` through the optimistic `useUpdateSettings`, so the choice holds across grids and restarts.

On a phone the chips scroll sideways inside their own row, so the page never scrolls horizontally. The row uses logical properties (`ms-auto`, `start`/`end`), and its transitions sit behind `motion-safe:`. The chips are the kit's `FilterChip`, as are the rating floor chip and the search page's source facets.

A category with fewer than 12 titles (`FEW_TITLES` in `CategoryGridPage.tsx`, counted from the category's `itemCount`, so the toolbar does not change as filters narrow the grid) has no decade chips and no search field of its own: for a row of posters they were most of the page. Either comes back while it is in use (a decade from the URL, typed text), so it can be cleared.

### URL

The range lives in the URL as `yf` and `yt` (both inclusive), so a filtered grid can be linked, reloaded and restored with Back. `readGridParams` reads them through `readYearRange`. Values that are not four-digit years in 1900..2100 are ignored, and a reversed pair is swapped, so a hand-edited link never reaches the core as an invalid call. Both VirtualGrids are keyed on the category only, so a filter change keeps the grid mounted: each page shows its old titles until the new page answers (`sameGridSlot` in `useVodPage`), and the old posters dim to 60 % once the wait passes 150 ms (`aria-busy` on the grid's wrapper). A new sort, search, rating, English-only state or year range (`filterKey`) scrolls the grid to the top and, through VirtualGrid's `resetKey`, puts the keyboard cursor on the first title (or clears it when the grid has no keyboard focus). Hide watched is not part of that key, so flipping it keeps the scroll position and the cursor.

### Paging

`buildPageRequest` sends `yearFrom`, `yearTo` and `hideWatched` only to `catalog.*`. Stalker pages come straight from the portal, so a year range or Hide watched switches a Stalker grid to the in-order loader (`useVodPagesInOrder`), the same one the rating and English-only filters use. The grid filters the loaded pages with `filterByYear` (the same 1900..2100 rule as the core) and the watched set. With Hide watched on, a page is shown only once its watched lookup has answered, so watched titles never flash in and then disappear. The filtered count is final once every page has loaded. A Stalker `CatalogRail` (the landing's category rails, "More in" on a detail page) does the same on its one page: with Hide watched it waits for the page's watched lookup, drops the watched titles and only then takes its 20.

On SQLite grids each cell reads its own page, through the grid's page gate (`pageGate.ts`): a scrollbar drag fetches the pages it rests on, not every page it passes (see performance.md, "Long lists and grids").

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

The hero actions include a series-level `WatchedButton` (labels `markSeriesWatched` / `markSeriesUnwatched`). It writes the item-level row, and the page reads it back from `positions.forSeries`. The season button is separate and still marks episodes. Each episode row has its own watched button beside Download (one press, named for what it does, "Mark S01E02 as watched" or "as unwatched", with the tick green once watched), in place of a More menu that held only that action. Next to it, Download season queues every episode of the selected season that has no download yet, or only a failed, cancelled or missing one (downloads.md). On a phone (below sm) an episode row is one 84 px line: the thumbnail, the facts over a two-line title, then the watched and download buttons. The facts keep to one line there, the code, the runtime, Now playing and the downloaded icon, and an item that does not fit (Now playing beside a long runtime) is left off whole rather than cut. Watched and the percent are left to the thumbnail's tick and bar and to the play button's name, which says both at every width.

### Preferred source

A movie that other sources carry too (`catalog.sameTitle`) has an Other sources dialog, where one copy can be pinned so Play uses it. Pins are kept by the core in `vod_source_pins`, one per title match key (`matchKey` in `src/features/vod/lib/pins.ts`: the normalized title base plus the year), through `sourcePins.get`, `sourcePins.set` and `sourcePins.clear` (`useSourcePin`). Backups export and import the table (backup.md). Builds before these commands kept pins in localStorage (`vod.sourcePins.v1`); the first pin read of a page load moves them into the core (`migrateLocalPins`): a key the core already has keeps its pin, a pin whose source is gone is dropped, and the local copy is deleted once nothing is left to retry.

### Recent searches

The search page's zero state offers the last 8 queries the user acted on (`lib/recentSearches.ts`, localStorage `vod.recentSearches`): a query counts once it was submitted with Enter, a result was opened from it, or its chip was picked. While parental controls are set (a PIN), nothing is remembered and nothing is offered, and setting them clears the list. The core filters what Hide mode hides from every list, but these chips are the UI's own, so a parent's query for a locked title would otherwise wait there for the next person once the unlock ran out (parental.md). The chips show only once the parental status says controls are off: not on a cold start before it is known, so a stored chip never flashes up, and not when it fails to load. Clear history on Recently watched, for every source, clears them too, and its Undo brings them back. Tabs share the list: another tab's write or clear reaches this one through the `storage` event, and each change starts from what is stored, so a tab never writes back queries another one cleared.

### "More like this" lookups

"More like this" (`SimilarSection`) and an actor's Known for match TMDB's titles against the catalog with one `catalog.search` each (`useCatalogMatches`, up to 20 per list). The section sits below the fold, so its lookups wait until it nears the view (`useNearViewport` on the page's scroller) and the page is idle (`whenIdle`), as Home's trending rail does, instead of queueing beside the page's own reads. A Stalker portal's VOD is not in the local catalog, so nothing could match there: neither page asks.

## Bundle budget

English `vod.json` is bundled into the entry chunk, and the C4 strings add 422 bytes to it (minified JSON). The filter row, hooks and series button load with the VOD route chunk.

Pages that draw no player load it on the press, as Home does (performance audit SH-2): Search plays a channel and a category grid's poster menu plays a movie through `import('@/features/player')` (`usePlayTitle` for the grids). A static import of the player barrel for `playItem` made those routes wait for the player's controls chunk before their first render. The detail pages, which show the player, keep `usePlayback`. `pnpm size:check` fails when the Search or category grid route chunk statically loads the player's UI (performance.md).
