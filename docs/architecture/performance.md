# Data and bundle performance

Owner: B3-data-perf (Run 3, contract C4). Code: `src/api/query.ts`, `src/features/vod/hooks/prefetch.ts`, `src/features/vod/hooks/queries.ts`, `src/shell/ShellLayout.tsx`, `src/shell/effects.ts`, `vite.config.ts` and `tools/check-bundle.mjs`. Tests: `src/api/query.test.ts`, `src/features/vod/test/prefetch.test.tsx`, `src/features/vod/test/imageUrl.test.ts`, `src/features/vod/test/tmdbCache.test.ts`, `src/features/vod/test/playerDefer.test.ts`, and the focus and TMDB-off tests in `src/features/vod/test/pages.test.tsx`.

This page covers three things: how long query results stay cached, how the VOD pages start loading a detail page before it is clicked, and how the main JavaScript chunk is kept under its size budget. Image caching itself is in [image-cache.md](image-cache.md).

## Query cache timing

Every RPC query is keyed `[command, args]`. `queryDefaultsFor(cmd)` in `src/api/query.ts` gives the cache timing for a command: `staleTime` (how long a result counts as fresh, so a remount reads the cache without asking the core again) and `gcTime` (how long a result nobody reads stays in memory). The first matching prefix wins:

| Prefix | staleTime | gcTime | Why |
| --- | --- | --- | --- |
| `settings.get`, `app.info` | never stale | 10 min | Events and `setSettingsCache` keep them current. |
| `sources.list`, `sources.get`, `catalog.categories` | 5 min | 10 min | Change only through source edits and refreshes, which send `sources.changed`. |
| `catalog.channels`, `catalog.movies`, `catalog.series`, `catalog.yearFacets` | 2 min | 10 min | Grid pages: going back to a grid within 2 min shows the cached page with no request. |
| `epg.grid`, `epg.programs` | 5 min | 2 min | Guide windows are large, so they leave memory soon after the guide closes. |
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

Memory: `gcTime` counts from the moment the last component reading a result unmounts. Catalog pages, guide windows and TMDB results are the large ones. Guide windows get 2 minutes because a window holds every programme of its channels and hours. TMDB results get 30 minutes because they never change and are slow to fetch again.

TMDB results do change with the settings, though. A disabled query still returns what it cached, so the movie and series pages merge TMDB data (and the season's TMDB episodes) only while `settings.tmdb.enabled` is on. `bindTmdbCacheSync` in `src/shell/effects.ts` (mounted by `useShellEvents`) also watches the `settings.get` cache: turning TMDB off removes every `tmdb.` query, and a new effective TMDB language (`tmdb.language`, or the app language when that is blank, as in `iptv-core` `tmdb/config.rs`) resets them, so open pages refetch in the new language. The blank-key check `tmdb.testKey` keeps its answer on a language change.

The VOD hooks in `src/features/vod/hooks/queries.ts` no longer set their own stale times where the table covers them. The grid pages spread `queryDefaultsFor('catalog.movies')`. The detail queries are built by `movieDetailQuery(sourceKind, ref)` and `seriesDetailQuery(sourceKind, ref)` (staleTime `DETAIL_STALE_MS`, 5 min). The detail pages and the prefetch use these same builders, so a prefetched result is exactly the cache entry the page reads.

## Hover and focus prefetch

`src/features/vod/hooks/prefetch.ts` starts loading a detail page as soon as the user shows intent:

- `usePrefetchIntent(target)` returns `onPointerEnter`, `onPointerLeave`, `onFocus` and `onBlur` handlers. A pointer that rests on a card for `PREFETCH_REST_MS` (120 ms) counts as intent, and leaving earlier cancels it. Focus needs the same 120 ms rest, so Tab or a held arrow key passing along a rail warms only the card where focus stops. Only one focus rest is pending at a time, blur cancels it, and when it ends it fires only if focus is still inside the card (callers that wire no `onBlur`, such as the dashboard cards, rely on that check). A new target on a recycled virtual card, or unmounting, cancels a pending rest.
- Content that scrolls under a still pointer is not intent. Chromium sends `pointerenter` to each card that scrolls under the pointer, so a pointer rest starts only after the pointer has really moved: a window `pointermove` at new coordinates (a move event at the same spot, as Chromium sends after a scroll, is ignored). A `wheel` or `scroll` anywhere cancels pending pointer rests, and a card entered before the pointer moves again is parked until it does; leaving the card drops it. The grid's keyboard cursor rest and focus rests are not affected by scrolling, because the grid scrolls its cursor into view itself.
- `prefetchVodDetail(queryClient, target)` warms three things:
  - the detail query, with `retry: false`; a failed prefetch costs nothing, and the page asks again with retries when it opens;
  - the movie or series route chunk (`loadMovieDetailPage` and `loadSeriesDetailPage` in `src/features/vod/routes.tsx`);
  - the poster and backdrop, through `preloadImage` from `src/api/images.ts`. That is the same cache URL the page's `<img>` tries first, decoded at low priority. When the target has no backdrop, the one the detail hero shows first (the item's own, then the provider's first) is preloaded once the data arrives.
- Each target fires at most once per session. The key is `sourceKind|sourceId|contentType|itemId`. `preloadImage` keeps its own once-per-session memory per URL, which it shares with the dashboard's idle hero preloads. Live channels and other refs that are not movies or series are ignored.
- Prefetch is skipped when `navigator.connection.saveData` is set, when the primary pointer is coarse (`(pointer: coarse)`, where hover means nothing), and for touch `pointerenter` events on a device whose primary pointer is fine.

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

### What moved out of the entry in Run 3

After Run 2 the entry was 267,003 bytes, under 1 kB from the cap. Most of it was the player: the shell imported `PlayerDock`, `ExternalPlaybackFooter` and `restorePlayback` from the `@/features/player` barrel. The watch-stats reporter and the window-state effect pulled the player store, the engines, subtitles and track handling in too. Run 3 cuts each of those static paths:

- `ShellLayout` imports `@/features/player` dynamically, and not before the first route is in. The router renders the shell only after the first route's lazy chunks have loaded (initial hydration), and `usePlayerModule()` then waits for the first idle moment (`requestIdleCallback`, at most `PLAYER_IDLE_TIMEOUT_MS`, 2 s; a macrotask where the browser has no `requestIdleCallback`) or the first `pointerdown` or `keydown`, whichever comes first (`schedulePlayerLoad`). It loads at once when `sessionStorage` holds a resume record (`player.resume`), and `restorePlayback` runs only then. Run 3 first started the import when the module ran; under 50 ms of latency the player chunk and its dependencies then competed with the route chunks for the browser's connections and delayed the first paint by about 100 ms. A page that plays imports the player itself, so after a click the shell's import usually resolves at once. A failed chunk load leaves the shell usable without the dock.
- The watch-stats reporter (Run 2 C7) starts from an effect that imports `@/features/stats/reporter`, once the player module is in. It reads the player store's state when it starts, so nothing that played before is lost. `RecordingWatcher` imports the player too, so it also mounts with the player module; it picks up reminders that fired before it listened.
- `useWindowStatePersistence` (desktop only) imports `@/features/player/pip` inside its async start-up, next to the Tauri window API it already loaded lazily.

### First render

`src/main.tsx` renders once `Promise.all([initI18n(), imageBaseReady()])` settles. The two run in parallel. On the web `imageBaseReady()` is settled at once, so the web path waits only for the locale, as before. On desktop it waits for the image cache base (`app.info.proxyBase`, asked when `src/api/images.ts` loads), so the first artwork on screen already loads through the cache. The worst case is a desktop core that does not answer `app.info`: the first render then waits 1.5 s (the `imageBaseReady` cap) instead of only for the locale, and pictures load directly until the base arrives.

| Build | Entry chunk |
| --- | --- |
| Run 2 final (run.md) | 267,003 bytes |
| Run 3 tree before these changes (B3 scratch build) | 267,106 bytes |
| After the player dock, footer and stats reporter (B3 scratch build) | 151,358 bytes |
| After the PiP import in `effects.ts` (final `pnpm build`, 2026-10-14) | 111,723 bytes |

What is left in the entry: the shell (rail, header, effects, shortcuts, theme, about 64 kB before minification), `src/ui` (toasts, dialogs, fields, posters, about 49 kB), `src/api` (transport, query client, events, window helpers, about 32 kB), route tables and small hosts. Vendors (`vendor-react`, `vendor-query`, `vendor-i18n`, `vendor-ui`, `vendor-tauri`) and the English strings (`locale-en`) have their own chunks, which load in parallel and are not counted.

### Keeping it there

- New pages go in route chunks: use `lazy` in a feature's `routes.tsx`.
- Dialogs and hosts that show on demand load behind `import()`. `CommandPalette`, `ShortcutOverlay`, `ParentalGateHost` and `RecordingWatcher` are examples.
- Do not import the `@/features/player` barrel, or anything that reaches `@/features/player/store`, from a module the shell loads statically. If a shell file needs the player, load it with `import()` the way `ShellLayout` and `effects.ts` do.
- To find out why a module is in the entry, build with a small Rollup plugin that records `getModuleInfo(id).importers` for the entry's modules, then follow the importers back to `src/main.tsx`.
