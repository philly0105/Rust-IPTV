# Data and bundle performance

Owner: B3-data-perf (Run 3, contract C4). Code: `src/api/query.ts`, `src/features/vod/hooks/prefetch.ts`, `src/features/vod/hooks/queries.ts`, `src/shell/ShellLayout.tsx`, `src/shell/effects.ts`, `vite.config.ts` and `tools/check-bundle.mjs`. Tests: `src/api/query.test.ts`, `src/features/vod/test/prefetch.test.tsx`, `src/features/vod/test/imageUrl.test.ts`, `src/features/vod/test/tmdbCache.test.ts`, `src/features/vod/test/playerDefer.test.ts`, and the focus and TMDB-off tests in `src/features/vod/test/pages.test.tsx`.

This page covers how long query results stay cached, how the VOD pages start loading a detail page before it is clicked, how the main JavaScript chunk is kept under its size budget, and what keeps transfers, large catalog imports, filtered pages and search cheap. Image caching itself is in [image-cache.md](image-cache.md).

## Query cache timing

Every RPC query is keyed `[command, args]`. `queryDefaultsFor(cmd)` in `src/api/query.ts` gives the cache timing for a command: `staleTime` (how long a result counts as fresh, so a remount reads the cache without asking the core again) and `gcTime` (how long a result nobody reads stays in memory). The first matching prefix wins:

| Prefix | staleTime | gcTime | Why |
| --- | --- | --- | --- |
| `settings.get`, `app.info` | never stale | 10 min | Events and `setSettingsCache` keep them current. On desktop the launch's one `app.info` request (`src/api/bootInfo.ts`) seeds the cache, so readers send no second one. |
| `sources.list`, `sources.get`, `catalog.categories` | 5 min | 10 min | Change only through source edits and refreshes, which send `sources.changed`. |
| `catalog.channels`, `catalog.movies`, `catalog.series`, `catalog.yearFacets` | 2 min | 10 min | Grid pages: going back to a grid within 2 min shows the cached page with no request. |
| `epg.grid`, `epg.programs` | 5 min | 5 min | Guide windows stay in memory as long as they count as fresh, so reopening the guide within 5 min shows the cached window. |
| `tmdb.` | never stale | 30 min | TMDB metadata does not change during a session. |
| `positions.`, `stats.` | 15 s | 10 min | Playback writes these all the time. |
| anything else | 30 s | 10 min | `DEFAULT_QUERY_TIMING`. |

The table applies to every query whose first key part is a command, not only to `useRpcQuery`: `queryClient` is an `RpcQueryClient`, which overrides `getQueryDefaults`, so raw `useQuery` and `prefetchQuery` callers get the same timing. Options are applied in this order, and the later one wins:

1. the client defaults (30 s, 10 min, no refetch on window focus, two retries for retryable errors);
2. the C4 table;
3. anything registered with `queryClient.setQueryDefaults`;
4. the options passed with the query, including `useRpcQuery`'s `staleTime` and `gcTime`.

`useRpcQuery` only sets the options the caller gave. Before Run 3 it passed `staleTime: undefined` when the caller gave none, and TanStack Query read that as 0, so those queries refetched on every mount. They now follow the table.

Event invalidation does not change. `EVENT_INVALIDATION` in `src/shell/effects.ts` and `bindEventInvalidation` mark matching prefixes stale whatever their `staleTime`, so a long stale time only removes refetches that would have returned the same data. A write that sends no event has to invalidate its own prefix. Before Run 3, queries without a stale time refetched on every mount, which covered for such writes. Now the result of a write like that shows only once the stale time has passed.

Events are folded into refetch rounds. The first event that invalidates anything opens a 50 ms burst (`EVENT_BURST_MS` in `src/api/query.ts`). The prefixes of every event in the burst, and of every `invalidate(prefix)` call made while it is open (event handlers in `effects.ts`, for example), are collected, and when the burst closes one `invalidateQueries` call marks them all stale. An `invalidate` inside a burst resolves when that round has refetched. The core sends related events back to back (`import.progress` done, then `sources.changed`); before, each one cancelled and restarted the same refetches. `events.lagged` turns the burst into a refetch of every query. An `import.progress` done with `message: 'unchanged'` (the core kept the catalog) invalidates only `sources.`. `useRpcQuery` passes the query's abort signal to the call, so on the web a refetch that a newer invalidation or an unmount replaced stops transferring; on desktop only a call not yet sent is skipped.

`settings.changed` carries the full settings, as `settings.get` returns them. `bindEventInvalidation` writes that payload into the `settings.get` cache before anything refetches and adds no `settings.` invalidation, so the settings are not asked for again. Only a `settings.changed` without an object payload invalidates `settings.`. `EVENT_INVALIDATION` maps nothing to it: the shell's handler in `effects.ts` invalidates `sources.schedule` only when `sourceRefreshIntervalHours` changed. The `lastRoute` writes that follow navigation send no `settings.changed` at all: the core skips the broadcast when `lastRoute` is the only change, and the writing window puts the reply into its own cache, so no other client re-renders its settings readers.

On the web, events arrive over a WebSocket. How it reconnects, and the full refetch after a reconnect, are in [server.md](server.md) under `GET /api/events`.

Memory: `gcTime` counts from the moment the last component reading a result unmounts. Catalog pages, guide windows and TMDB results are the large ones. Guide windows hold every programme of their channels and hours. They used to get 2 minutes, which dropped windows that still counted as fresh, so reopening the guide refetched them; they now get 5 minutes, equal to their stale time. `query.test.ts` checks that `gcTime` is at least `staleTime` for every command it lists with a finite stale time. TMDB results get 30 minutes because they never change and are slow to fetch again.

TMDB results do change with the settings, though. A disabled query still returns what it cached, so the movie and series pages merge TMDB data (and the season's TMDB episodes) only while `settings.tmdb.enabled` is on. `bindTmdbCacheSync` in `src/shell/effects.ts` (mounted by `useShellEvents`) also watches the `settings.get` cache: turning TMDB off removes every `tmdb.` query, and a new effective TMDB language (`tmdb.language`, or the app language when that is blank, as in `iptv-core` `tmdb/config.rs`) resets them, so open pages refetch in the new language. The blank-key check `tmdb.testKey` keeps its answer on a language change.

The VOD hooks in `src/features/vod/hooks/queries.ts` no longer set their own stale times where the table covers them. The grid pages spread `queryDefaultsFor('catalog.movies')`. The detail queries are built by `movieDetailQuery(sourceKind, ref)` and `seriesDetailQuery(sourceKind, ref)` (staleTime `DETAIL_STALE_MS`, 5 min). The detail pages and the prefetch use these same builders, so a prefetched result is exactly the cache entry the page reads. Xtream and Stalker sources ask the provider's detail command (`xtream.vodDetail`, `stalker.seriesDetail` and so on). An m3u playlist has no provider detail: its movie query caches the flat `catalog.item` row under `['catalog.item', { ref }]` and wraps it as a detail with `select` (`toMovieDetail`); an m3u series asks `m3u.seriesDetail`, which answers with the seasons the importer stored (m3u.md, Series). Flat `useRpcQuery('catalog.item')` readers (the player, the live pages) use that same key, so one ref holds one shape: a row a flat reader cached opens the detail page without a second call, and a detail the page cached is a plain row to the flat readers. `afterData` in `prefetch.ts` reads both shapes when it picks the backdrop to preload.

## Hover and focus prefetch

`src/features/vod/hooks/prefetch.ts` starts loading a detail page as soon as the user shows intent:

- `usePrefetchIntent(target)` returns `onPointerEnter`, `onPointerLeave`, `onFocus` and `onBlur` handlers. A pointer that rests on a card for `PREFETCH_REST_MS` (120 ms) counts as intent, and leaving earlier cancels it. Focus needs the same 120 ms rest, so Tab or a held arrow key passing along a rail warms only the card where focus stops. Only one focus rest is pending at a time, blur cancels it, and when it ends it fires only if focus is still inside the card (callers that wire no `onBlur`, such as the dashboard cards, rely on that check). A new target on a recycled virtual card, or unmounting, cancels a pending rest.
- Content that scrolls under a still pointer is not intent. Chromium sends `pointerenter` to each card that scrolls under the pointer, so a pointer rest starts only after the pointer has really moved: a window `pointermove` at new coordinates (a move event at the same spot, as Chromium sends after a scroll, is ignored). A `wheel` or `scroll` anywhere cancels pending pointer rests, and a card entered before the pointer moves again is parked until it does; leaving the card drops it. The grid's keyboard cursor rest and focus rests are not affected by scrolling, because the grid scrolls its cursor into view itself.
- `prefetchVodDetail(queryClient, target)` warms three things:
  - the detail query, with `retry: false`; a failed prefetch costs nothing, and the page asks again with retries when it opens;
  - the movie or series route chunk, through `preloadDetailChunk(kind)`, which runs the route's own `import()` (`loadMovieDetailPage` or `loadSeriesDetailPage` in `src/features/vod/routes.tsx`) at most once per kind per session. Hover, focus and cursor prefetch and the grid's idle warm-up share that one load; a failed load is forgotten, so a later call tries again;
  - the poster and backdrop, through `preloadImage` from `src/api/images.ts`. That is the same cache URL the page's `<img>` tries first, decoded at low priority. When the target has no backdrop, the one the detail hero shows first (the item's own, then the provider's first) is preloaded once the data arrives.
- Each target fires at most once per session. The key is `sourceKind|sourceId|contentType|itemId`. `preloadImage` keeps its own once-per-session memory per URL, which it shares with the dashboard's idle hero preloads. Live channels and other refs that are not movies or series are ignored.
- Prefetch is skipped when `navigator.connection.saveData` is set, when the primary pointer is coarse (`(pointer: coarse)`, where hover means nothing), and for touch `pointerenter` events on a device whose primary pointer is fine.
- Idle warm-up: touch screens get no hover prefetch, so `CategoryGridPage` calls `preloadDetailChunk(kind)` for its own kind once the grid mounts and the browser is idle (`requestIdleCallback` with a 2 s timeout, or a 500 ms timer where there is none), unless `saveData` is set. The first title opened then does not wait for its code.

Where it is used:

| Surface | How |
| --- | --- |
| `PosterCard` (VOD landing rails, grids, search results) | Takes a `prefetch` target, or a ready-made `intent`, and puts the handlers on the card and its link. Its `sourceId` also scopes the poster's cache URL. |
| VOD search results (`SearchPage`) | Each movie or series hit passes its target, using the hit's source kind. |
| VOD grid keyboard cursor (`CategoryGridPage`) | The grid moves `aria-activedescendant`, not focus, so the active cell uses `usePrefetchOnRest(target)`. It fires once the cursor has stayed on a cell for 120 ms, and only while the grid listbox has focus. |
| TMDB rails (`TmdbRail`) | A TMDB card links to a title search, not to a catalog item. `useSearchPrefetchIntent({ title, sourceId })` warms the search route chunk and the first `catalog.search` page with the exact args `SearchPage` sends (`{ query, sourceId?, limit: searchRequestLimit(SEARCH_LIMIT) }`, stale for 30 s like the page's own query). Titles shorter than `MIN_QUERY_LENGTH` after `normalizeQuery` are skipped. |
| Dashboard poster cards | The same hook, in `src/shell/dashboard/` (B2). |

## Grid cursor shortcuts need grid focus

The VOD grid binds `s` (My List), `w` (watched), `Shift+F10` and the context-menu key to the keyboard cursor. They are registered only while the grid listbox itself has focus: `CategoryGridPage` tracks `gridFocused` from focus and blur events on the listbox. With the grid unfocused, or focus in the page's search field, the keys reach whoever else registered them (the player's `s` screenshot shortcut, for example), and `shortcutRegistry.list()` includes the grid's entries only while they are live. When the grid takes focus, the shortcut registry puts its entries on top again. `pages.test.tsx` checks both sides.

## Entry chunk budget

`dist/assets/index-*.js`, the module script `index.html` loads, may be at most 268,000 bytes. That is about 10 % over the 243,927-byte entry before Run 1 (SC10).

```
pnpm build && pnpm size:check
```

`tools/check-bundle.mjs [distDir]` is plain Node with no dependencies. It lists every JavaScript chunk, largest first, with its size and gzip size, and marks the entry. It exits 1 when there is no build, when there is no `index-*.js`, when `index.html` loads something else, or when an `index-*.js` is over budget.

`vite.config.ts` names lazy chunks whose first module is an `index.ts` barrel after their folder (`player-index-*.js`). Without that, `import('@/features/player')` would produce a second `index-*.js` beside the entry.

Three more settings in `vite.config.ts` shape the chunks:

- `experimentalMinChunkSize: 4_000` merges app chunks under 4 kB into a neighbour. With no merging a cold dashboard in server mode made 68 JS requests, 39 of them under 4 kB. Rollup merges a small chunk that several lazy pages share into the entry, because the entry always loads, so a larger setting moves lazy-only code there: at 10 kB the entry was 162.0 kB, at 4 kB 143.0 kB, with no merging 141.0 kB (84, 117 and 160 JS chunks; every route in one session 59 requests at 10 kB, 88 at 4 kB). Cold first paint on loopback was the same within noise at 10 kB and 4 kB.
- Each language is one manual chunk, `locale-<lang>` (`vendorChunk` matches `src/i18n/<lang>/*.json`), since `loadLanguage` fetches all of a folder's namespaces at once. A manual chunk stays out of the min-size merge, so no foreign strings end up in app chunks; without these chunks the 10 kB merge cost 11 % more bytes.
- `treeshake.manualPureFunctions: ['memo', 'lazy']` marks React's wrappers pure. Rollup cannot prove they have no side effects, so a module with a top-level `memo(...)` reached through the `@/ui` barrel was kept whole in the importer's chunk; that put `VirtualGrid` in the entry.

`src/ui/test/bundlePurity.test.ts` checks that `memo` and `lazy` are on the pure list, that every component wrapper called at module top level is on it, that `experimentalMinChunkSize` is between 3,000 and 5,000, and that each language has one chunk with no app modules in it.

### What moved out of the entry in Run 3

After Run 2 the entry was 267,003 bytes, under 1 kB from the cap. Most of it was the player: the shell imported `PlayerDock`, `ExternalPlaybackFooter` and `restorePlayback` from the `@/features/player` barrel. The watch-stats reporter and the window-state effect pulled the player store, the engines, subtitles and track handling in too. Run 3 cuts each of those static paths:

- `ShellLayout` imports `@/features/player` dynamically, and not before the first route is in. The router renders the shell only after the first route's lazy chunks have loaded (initial hydration), and `usePlayerModule()` then waits `PLAYER_PREFETCH_DELAY_MS` (2.5 s) followed by the first idle moment (`requestIdleCallback`, at most `PLAYER_IDLE_TIMEOUT_MS`, 2 s; a macrotask where the browser has no `requestIdleCallback`), or for the first `pointerdown` or `keydown` from the start, whichever comes first (`schedulePlayerLoad`). Without the delay the player's chunks (about 200 KB) arrived at about 0.4 s on a cold load, among the first route's own chunks and long tasks. It loads at once when `sessionStorage` holds a resume record (`player.resume`), and `restorePlayback` runs only then. Run 3 first started the import when the module ran; under 50 ms of latency the player chunk and its dependencies then competed with the route chunks for the browser's connections and delayed the first paint by about 100 ms. A page that plays imports the player itself, so after a click the shell's import usually resolves at once. A failed chunk load leaves the shell usable without the dock.
- The watch-stats reporter (Run 2 C7) starts from an effect that imports `@/features/stats/reporter`, once the player module is in. It reads the player store's state when it starts, so nothing that played before is lost. `RecordingWatcher` imports the player too, so it also mounts with the player module; it picks up reminders that fired before it listened.
- `useWindowStatePersistence` (desktop only) imports `@/features/player/pip` inside its async start-up, next to the Tauri window API it already loaded lazily.

### First render

`src/main.tsx` renders once `Promise.all([initI18n(), imageBaseReady()])` settles. The two run in parallel. On the web `imageBaseReady()` is settled at once, so the web path waits only for the locale, as before. On desktop it waits for the image cache base (`app.info.proxyBase`, from the launch's one `app.info` request, which `src/api/bootInfo.ts` sends as soon as the first module loads and `images.ts`, `transport.ts` and the query cache share), so the first artwork on screen already loads through the cache. The worst case is a desktop core that does not answer `app.info`: the first render then waits 1.5 s (the `imageBaseReady` cap) instead of only for the locale, and pictures load directly until the base arrives.

| Build | Entry chunk |
| --- | --- |
| Run 2 final (run.md) | 267,003 bytes |
| Run 3 tree before these changes (B3 scratch build) | 267,106 bytes |
| After the player dock, footer and stats reporter (B3 scratch build) | 151,358 bytes |
| After the PiP import in `effects.ts` (final `pnpm build`, 2026-10-14) | 111,723 bytes |
| Loop 1 commit `ad3742f` (loop 2 scratch build) | 121,601 bytes |
| Loop 2 tree before the chunk settings (scratch build) | 139,487 bytes |
| With `experimentalMinChunkSize` alone (scratch build) | 162,736 bytes |
| With `memo` and `lazy` marked pure too (scratch build, `tools/check-bundle.mjs`) | 143,833 bytes |

Loop 2 growth before the chunk settings came mostly from `src/ui/Menu.tsx` (9.1 kB before minification), which the collapsed rail imported statically (`Rail.tsx` loads it in its own chunk with `loadRailMenu`); `src/ui/VirtualGrid.tsx` (7.5 kB), whose new top-level `memo(...)` kept it whole; and `src/features/sources/lib/files.ts` and `format.ts` (6.5 kB together), which `src/shell/effects.ts` imported for `formatFileSize` and `formatCount`. The min-size merge then folded small chunks into the entry, and marking the wrappers pure took 18,903 bytes back out. A diff of the last two builds showed no module dropped, only moved.

The two formatters now live in `src/lib/numbers.ts`, which `effects.ts` imports; `files.ts` and `format.ts` re-export them for their other callers. That took a scratch build's entry from 164,993 to 155,979 bytes. `files.ts` is not in the entry: no entry module imports it, and with the 4 kB `experimentalMinChunkSize` the merge leaves it in its own chunk. `SubtitleStyleFields.tsx`, `VirtualRows.tsx` and the live `ContextMenu.tsx` stay out of the entry too. Parental `status.ts` and `gate.ts` are in the entry because `ShellLayout.tsx` imports them statically.

What is left in the entry: the shell (rail, header, effects, shortcuts, theme, about 64 kB before minification), `src/ui` (toasts, dialogs, fields, posters, about 49 kB), `src/api` (transport, query client, events, window helpers, about 32 kB), route tables and small hosts. Vendors (`vendor-react`, `vendor-query`, `vendor-i18n`, `vendor-ui`, `vendor-tauri`) and the English strings (`locale-en`) have their own chunks, which load in parallel and are not counted; the other languages' `locale-<lang>` chunks load only when chosen.

### Keeping it there

- New pages go in route chunks: use `lazy` in a feature's `routes.tsx`.
- Dialogs and hosts that show on demand load behind `import()`. `CommandPalette`, `ShortcutOverlay`, `ParentalGateHost` and `RecordingWatcher` are examples.
- Do not import the `@/features/player` barrel, or anything that reaches `@/features/player/store`, from a module the shell loads statically. If a shell file needs the player, load it with `import()` the way `ShellLayout` and `effects.ts` do.
- To find out why a module is in the entry, build with a small Rollup plugin that records `getModuleInfo(id).importers` for the entry's modules, then follow the importers back to `src/main.tsx`.

## Bytes on the wire

- Images: grid posters and channel logos ask the image cache for a copy at their drawn size (`w`, [image-cache.md](image-cache.md#width-hints)). On a fast scroll, 1,060 posters took 10.5 MB at `w=192` against 215.6 MB at full size, and 1,125 logos 4.4 MB at `w=64` against 180.3 MB. The first view of an image pays for the resize (a median of 21 to 35 ms per poster instead of about 4 ms); later views take 1 to 2 ms.
- Guide answers: views that never show descriptions pass `withDescription: false` to `epg.nowNext` and `epg.grid` ([epg.md](epg.md#queries)). On a 400-channel test guide that halves a 40-channel, 7-hour grid answer (101,964 to 50,736 bytes) and nearly halves now/next for 123 channels (79,102 to 43,076).
- Compression: server mode sends RPC replies and the UI as brotli or gzip ([server.md](server.md#compression)). A web build also runs the `tsrust-precompress` plugin in `vite.config.ts`: once the bundle is written, it writes `<file>.br` (brotli quality 11, text mode) and `<file>.gz` (gzip level 9) beside every `.js`, `.css`, `.html`, `.svg`, `.json`, `.webmanifest`, `.txt` and `.xml` file of at least 1,024 bytes in the output folder. The server sends those copies as they are, so a cold UI load costs no compression CPU (compressing on the fly at level 4 added about 25 ms per cold load on loopback), and quality 11 is about 25 % smaller than level 4. `tauri build` sets `TAURI_ENV_PLATFORM` when it runs `pnpm build`, and the plugin then writes nothing: Tauri embeds `dist/` and compresses it itself. `tools/check-bundle.mjs` reads only the `.js` files.

## Large catalog imports

A large catalog rewrite (at least 20,000 rows touched; the full rule is in catalog.md) drops the secondary indexes of `items` and builds them once before the commit, instead of updating each of them on every row. It changes the schema once per import, so every pooled connection re-prepares its statements once, and the rebuild raises peak memory by about the largest index. Details in [catalog.md](catalog.md#index-rebuild-for-large-rewrites).

## Filtered pages and search

- A movie or series page with a minimum rating or a year range reads its sort's index in order: the page statement writes those filters as `+i.rating` / `+i.year` when the grid is sorted by another key, and migration 0019 puts the rating and the year in every sort index, so the page reads index entries instead of a table row per title it passes. A page at or past the filtered total skips the page statement. Details in [catalog.md](catalog.md#reading).
- `catalog.search` runs its substring pass only when no list has a word-prefix hit, and its ranking pass reads no category row per match. The word-prefix pass ranks on `items_rank` (migration 0020), about 60 bytes per match instead of the item's wide row, and keeps each list's best rows with a bounded top-N per list over one materialized match set instead of a `ROW_NUMBER()` window that sorts every match. On 215k items in a release build that takes "th" (56k matches) from 155 ms to 61-64 ms at p95, "the" from 105 ms to 43-44 ms, "a" from 110 ms to 37-44 ms and hide-mode "th" from 99 ms to 52-61 ms; narrow queries gain too ("news" 20 to 12 ms, "blue" 16 to 10 ms). Details in [catalog.md](catalog.md#reading). `crates/iptv-core/tests/l3_search_perf.rs` holds these on 215k items in release builds: every search under 100 ms at p95, the broad prefixes and hide mode included (only the substring scan, which reads every title, under 250 ms), filtered pages and parental hide mode under 50 ms. `crates/iptv-core/tests/l4_search_rank.rs` checks that the ranking returns the same rows in the same order as the window statement.
- Every pooled connection runs with a 32 MiB page cache (`cache_size` in `db::configure`; SQLite's default is 2 MiB). Reads of `items` rows by rowid missed the default cache on most reads on a 215k-item library. The larger cache halved "blue", "news" and "zzzz" (p50 25-30 ms to 12-17 ms) for about 40 MB more peak memory in `l3_search_perf.rs`; 16 MiB gained almost nothing and 64 MiB little more. The cache belongs to its connection and fills only as pages are read, so the pool's 8 connections (`POOL_MAX`) hold at most 256 MiB. Migrations run on the 2 MiB default (`db::migrate`; a 600k-row guide upgrade would otherwise fill the whole 32 MiB). A memory map (`mmap_size`) measured no gain and is not set. `items_rank` adds about 15 MB per 220k items to the database and, while a broad search reads it, up to that much to a connection's page cache; the materialized match set of a broad search takes about 2 MB of temp memory.
