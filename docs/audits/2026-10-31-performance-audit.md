# Performance audit

Tsrust IPTV, release 0.3.0 at `88b94a3`. The fixes are on the `perf/audit-2026-10-31` branch, 22 commits from `07576b9` to `04d8816`.

## Summary

The 2026-10-19 audit and the passes after it left no broken hot path, so this audit went looking for the costs that remain at large sizes: 200k-channel lists, 120 MB guides, 170k-item Xtream catalogs, m3u_plus playlists with 300k episodes, Stalker portals with 20k channels, and cold poster walls. It found 115 issues. Skeptical verifiers refuted 15 of them and cut the impact of most of the rest. 79 were fixed, in whole or in part; 36 were not, each for a stated reason (Not done, below).

The largest gains:

1. Pages draw sooner. The `@/features/player` barrel exported the dock, so Live, the guide and 11 other pages loaded the player's controls before their first render. Live and the guide now load a third less code before they draw (497 to 337 kB, 508 to 338 kB), Search and the category grids about a quarter less, and the entry chunk shrank from 223,369 to 205,517 bytes. `tools/check-bundle.mjs` now guards 23 routes.
2. Guide refreshes stopped rewriting the whole feed. A refresh replaces only the programmes that changed and updates the search index in place: an unchanged 176k-programme refresh holds the write lock 0.39 s instead of 1.28 s and writes 0.3 MB of WAL instead of 63 MB. An unchanged guide file is not read again at all (1.45 s to 1 ms).
3. Imports hold far less memory. Xtream rows carry their extras as text (heap per row about a quarter of before), M3U series rows are streamed to the writer (peak 422 to about 213 MB on a 96 MB `m3u_plus` list), Stalker channel lists stay as the portal's text (+176 to +57 MB), and on Linux the freed heap goes back to the system after each import (an Xtream catalog used to stay about 300 MB above its start, now about 60 MB).
4. Concurrent reads no longer queue. The bundled SQLite was built with a process-wide page-cache lock; without it, four parallel readers went from 76 to 133 calls/s on a loaded box.
5. Several user-facing waits went away: marking a long series watched (944 ms to 18 ms for 1,000 episodes), Continue watching on a long history (68 to 0.46 ms), the first page of a large All channels list (8-20 ms to about 1 ms), a Sports league switch (about 3 s of loading to none), a cold poster wall in server mode (2.4 to 0.8 s across three hosts), and an M3U zap waiting for the guide (152 to 1.3 ms).

Three tests that already failed before the branch still fail: a vitest case, an intermittent Rust test and an ignored memory test (Checks, below). Nothing the branch changed fails.

## Method

Fourteen area reviewers each took one part of the code and read its architecture documents and the 2026-10-19 audit's status table first, so fixed and decided items were not reported again:

| Area | Covered |
| --- | --- |
| F1 | Player, multi-view, failover, subtitles (UI) |
| F2 | Live TV, the guide and lists (UI) |
| F3 | VOD, library, My List, downloads, recording (UI) |
| F4 | Shell, startup and the entry chunk |
| F5 | Bundle, CSS, i18n, the service worker and the kit |
| F6 | Sports |
| R1 | Database and catalog |
| R2 | M3U import and sources |
| R3 | Xtream and Stalker ingest, HTTP clients |
| R4 | EPG and the guide search |
| R5 | Desktop and server hosts |
| R6 | Images, recording, downloads, screenshots |
| R7 | User state, backup, TMDB, settings |
| R8 | Core runtime and build settings |

Every finding then went to a skeptic, who checked the claim against the code and measured where it could, and rated its real impact: 24 were confirmed, 76 partly confirmed (usually with a smaller impact or a corrected fix) and 15 refuted. The 8 high-severity findings also went to a safety verifier, who checked the fix for behaviour changes. Where a verifier's corrected fix differed from the reviewer's, the verifier's was implemented. Four gap critics (UI core, UI features, Rust I/O, Rust data) then read the code again for what the reviewers missed and added 10 findings, which were verified the same way.

The fixes were made in 17 lanes, each owning a disjoint set of files, so lanes could work in one tree at once without touching each other's code. Each lane measured its change, locked it in with a test (fewer calls, a smaller payload, the same output as the old code), and committed. An independent reviewer read every commit; three follow-up commits (`7158998`, `e6b9a7f`, `04d8816`) fix what the reviews found, and `fddc527` fixes a race the in-place guide index made reachable. A verifier then ran the full checks and a measurer re-ran the baseline on a quiet machine.

## Measurements

Before is `88b94a3`, after is `04d8816`, on the same shared 4-core VM (Intel Xeon 2.10 GHz, 16 GB) with rustc 1.97 and Node 22. Rust timings use the release profile with `CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16`, not the shipped fat LTO; the baseline's test binaries got the same file hashes in the after build, so the settings matched. The before set is one run whose machine load was not recorded; the after set is three runs on a quiet machine (1-minute load 0.7-1.5), and the tables give their median. Differences under about 15 % are not evidence either way.

### Rust baseline set

`cargo test -p iptv-core --release --test m3u_perf --test epg_perf --test catalog_perf --test l2_query_perf --test l3_search_perf -- --nocapture --test-threads=1`, every line printed both before and after:

| Test | Lines | After / before (geometric mean) | Lines >10 % faster | Lines >10 % slower |
| --- | ---: | ---: | ---: | ---: |
| m3u_perf | 2 | 0.96 | 0 | 0 |
| epg_perf | 2 | 0.84 | 2 | 0 |
| catalog_perf | 64 | 0.93 | 10 | 15 |
| l2_query_perf | 172 | 0.92 | 62 | 23 |
| l3_search_perf | 54 | 0.93 | 15 | 2 |

| Line | Before | After |
| --- | ---: | ---: |
| catalog_perf, 50k channels: first page | 4.51 ms | 0.96 ms |
| catalog_perf: sorted by name, descending | 3.63 ms | 0.95 ms |
| catalog_perf: first page, one group hidden | 7.19 ms | 0.84 ms |
| catalog_perf: deep page, one group hidden | 14.2 ms | 8.03 ms |
| l2_query_perf: channels @48000, p50 | 4.16 ms | 2.49 ms |
| l3_search_perf: search "the", p95 | 78.1 ms | 49.9 ms |
| epg_perf: 120 MB XMLTV ingest | 2.34 s | 1.87 s |
| epg_perf: peak RSS delta | 72 MB | 64 MB |
| m3u_perf: 50k channel import | 1.84 s, 46 MB | 1.79 s, 44 MB |

The lines more than 10 % slower are sub-millisecond calls (tens of microseconds), p95s of 20 samples, or single-call catalog_perf timings. One drift is consistent: all 10 English-only catalog_perf lines sit above the single before run, 9 of them by 5-34 % (the zap list 107 ms against 108-134 ms). The branch does not touch the English-only filter, and the spread between the three after runs is as large as the gap, so this is most likely noise, but one before run cannot rule out a small fixed cost.

### New measurement tests, both paths in one process

| What | Old path | New path |
| --- | ---: | ---: |
| Marking 200 / 1,000 episodes watched | 78 / 944 ms | 1.8 / 18 ms |
| `positions.continueWatching`, 14k / 42k rows, limit 24 | 21 / 68 ms | 0.32 / 0.46 ms |
| Emptying the search index of 200k channels | 566 ms | 6.2 ms |
| First now/next of 120 refs after a guide refresh | 210 ms | 1.6 ms |
| 120 unmatched titles after a refresh with the same channels | 1,455 ms | 0.9 ms |
| Refreshing an unchanged 120 MB local guide | 1.45 s | 0.001 s |
| Cold 30-poster wall, three hosts, server mode | 2,422 ms | 759 ms |
| Cold 30-poster wall, one host, desktop | 1,513 ms | 1,210 ms |
| RSS left after freeing 200 MB of import rows | 201 MB | 0 MB |

### New measurement tests, against the figures their commits recorded

These tests did not exist at `88b94a3`. The before figures come from the implementers' runs, often under a load of 10-13 from parallel builds and once in a debug build; every after figure here is at or better than the one its commit recorded.

| What | Recorded before | Recorded after | This run |
| --- | --- | --- | --- |
| Guide refresh, unchanged: write lock / WAL (`epg_refresh_perf`) | 1.28 s / 62.8 MB | 0.48 s / 0.3 MB | 0.39 s / 0.3 MB |
| Guide refresh 12 h later | 1.30 s / 62.8 MB | 0.45 s / 5.9 MB | 0.39 s / 6.6 MB |
| Guide refresh, 5 % of titles edited | 1.23 s / 62.5 MB | 0.69 s / 53.3 MB | 0.53 s / 54.9 MB |
| 200k-channel list page, 100 of 2,000 groups hidden (`l2_query_perf`, ignored) | 40-110 ms | about 1 ms | 1.06 ms |
| Start of a 180k-movie refresh beside 200k channels (`catalog_write_perf`) | 3.8-5.2 s | 1.6-1.7 s | 0.85 s |
| Removing 200k channels | 3.3-3.4 s, WAL 101 MB | 0.6-0.8 s, 27 MB | 0.61 s, 27 MB |
| Stalker 20k-channel import, changed (`stalker_perf`) | 1.59 s, +176 MB | 0.76 s, +57 MB | 0.67 s, +56.9 MB |
| Stalker 20k-channel import, unchanged | 1.03 s, +176 MB | 0.22 s, +33 MB | 0.18 s, +32.8 MB |
| Stalker bulk guide, held after the first row | 232 MB | 38 MB | 38.2 MB |
| Stalker catch-up after a 30 h ribbon | 6 table requests, 2.1 s | 0, 0.3 s | 0, 0.30 s |
| Xtream heap per mapped row, live / movie / series (`xtream_row_memory`) | 792 / 758 / 1,102 B | 183 / 144 / 371 B | 183 / 144 / 371 B |
| 96 MB `m3u_plus` add, peak RSS delta (`m3u_perf`, ignored) | 422 MB | 215 MB | 212 MB |
| Same list refreshed with rotated tokens | 292-419 MB | 177 MB | 174 MB |
| Parallel reads from 1 / 2 / 4 tasks (`db_concurrency_perf`) | 87 / 70 / 76 calls/s | 76 / 110 / 133 calls/s | 118 / 245 / 351 calls/s |

The `m3u_plus` catalog digests equal the old importer's, so the stored data is byte for byte the same. The parallel-read before figures were taken with the flag defined on a loaded box; this run's absolute numbers are higher because the machine was quiet, and what matters is that throughput now grows with the number of tasks (1 : 2.1 : 3.0). `resize_perf` is not comparable with its documented numbers, which were taken with the shipped LTO profile; with LTO off its JPEG cases are 1.6-1.9x slower.

### Bundle

`pnpm build && node tools/check-bundle.mjs` (web build):

| Measure | Before | After |
| --- | ---: | ---: |
| JS chunks | 181 | 183 |
| JS bytes in all | 7,946,616 | 7,939,227 (-0.1 %) |
| Entry chunk | 223,369 (75.22 kB gzip) | 205,517 (70.35 kB gzip) |

Bytes a route loads beyond the boot chunks before its first render:

| Route | Before | After | Change (raw / gzip) |
| --- | ---: | ---: | ---: |
| Home | 168,112 | 152,367 | -9.4 % / -13.3 % |
| Search | 232,383 | 180,617 | -22.3 % / -23.1 % |
| Settings | 217,142 | 194,553 | -10.4 % / -15.6 % |
| Category grid | 213,004 | 162,693 | -23.6 % / -25.3 % |
| Sports | 151,856 | 153,903 | +1.3 % / -1.8 % |
| Live | 497,260 | 336,990 | -32.2 % / -33.6 % |
| Guide | 507,605 | 338,183 | -33.4 % / -34.2 % |

Measured at `7158998`, the commit before the last UI follow-up (which moved about 2 kB on a few routes): Favorites 293,647 to 112,839, Downloads 277,300 to 125,348, Scheduled 303,830 to 50,342, My videos 311,507 to 96,496, Movie 410,906 to 242,773, Series 422,888 to 291,518, Archive 262,872 to 120,089, Stats 188,351 to 157,852. Sports, Sources (+3.1 kB) and My List (+25.6 kB) load more beyond the boot than before, because code the baseline boot carried for every page (the form fields, 7.4 kB; TanStack Virtual, 27 kB) now loads with the pages that draw it; counted as boot plus route, every route is lighter than the baseline. The boot grew 6,448 bytes (2.5 kB gzip) when the icons many pages share moved into `vendor-ui`. Total JavaScript is unchanged: code moved between chunks and was not removed.

## What was fixed

| Findings | What changed | Measured effect | Commit |
| --- | --- | --- | --- |
| F1-1, F2-1, F2-2, F5-1, F1-3, F1-4, F3-7, F4-1 | The player barrel no longer exports the dock or the controls; the shell loads them from `features/player/dock`. Pure helpers moved out of heavy modules (`resumeRules.ts`, `trackTypes.ts`, `menuDismiss.ts`, `pipState.ts`, `joinList` in `lib/intl.ts`). The library pages load the player on the press; the guide's Stalker notice has its own module. `check-bundle.mjs` guards 23 routes by marker strings | Before first render: Live -160 kB, the guide -169 kB, Search -52 kB, Scheduled -253 kB, Favorites -181 kB; player store chunk 72.5 to 51.9 kB | `d1a014b`, `7158998` |
| Review follow-up | The 4 kB small-chunk merge had made Settings, Sports, My List, Sources and Stats heavier: shared icons go in `vendor-ui`, and the virtualizer carries a side effect Rollup sees (`virtualListBoundary`), so TanStack Virtual stays out of pages without a virtual list. Byte budgets and a no-virtual-list check for 9 pages | Settings 273 to 194 kB, Sports 204 to 156 kB, Stats 198 to 158 kB against the commit before | `7158998` |
| F4-2 | The command palette and shortcut overlay mount on first open and are warmed on the player's schedule or at the first press | 6 chunks, 98,206 B (35.3 kB gzip) out of the first route | `d1d755e` |
| F4-6, R7-4 | A `lastRoute` save's reply stays out of the settings cache (`currentLastRoute`); Reset's Undo restores the newest screen | Renders of a whole-settings reader per screen change: 2 to 1 | `d1d755e`, `04d8816` |
| F4-7 | Home's Continue watching cards and hero slides batch `catalog.item` into `catalog.items` | 4 cards: 4 calls to 1 | `d1d755e` |
| GAP-ui-core-3 | Home's trending lookups keep their answers as long as they count as fresh (`TRENDING_MS`) | A return to Home after 10 min no longer repeats about 8-11 searches (estimate) | `d1d755e` |
| GAP-ui-core-2 | Desktop queries and mutations run in `networkMode: 'always'` | My videos loads while the webview thinks it is offline (test) | `5299abb` |
| GAP-ui-core-1 | Provider commands skip UI retries for failures the core already retried; the web transport tags HTTP errors without the core's payload | A provider timeout: 3 query calls to 1 (test); a busy database is still retried | `5299abb`, `04d8816` |
| F1-7 | The idle hls.js and mpegts.js warm-up is skipped on desktop when every player is mpv, VLC or embedded mpv | 888 kB of engines not fetched at idle for such a user (not traced) | `5299abb` |
| F5-5, F4-5 | `vendor-query` narrowed; TanStack Virtual and the Tauri plugins are lazy manual chunks; the web `vendor-tauri` holds only `core` and `event`; the phone tab bar and the form fields are lazy; a boot check (`NOT_AT_BOOT`) | Web boot 859,331 to 802,970 B (270.8 to 256.2 kB gzip) | `5299abb` |
| F5-4 | `theme-boot.js` preloads a remembered non-English language next to the entry | One round trip on a cold remote-web start (not timed) | `5299abb` |
| F5-3, F4-9, F5-6 | Service worker static routes for `/api/*` and ignored requests; cache writes under `waitUntil` | `/api` after the worker idled: 16-19 to 5-6 ms; first byte of a 2 MB uncached asset: about 1 s to 5-11 ms | `ab34078` |
| F1-5 | An M3U zap starts without waiting for the guide's title; `sources.get` stays cached | Tune to play with a 150 ms guide answer: 152 to 1.3 ms (vitest) | `7201387` |
| F1-6 | Embedded mpv's cursor poll reads the cursor only, and not at all on a focused macOS window | 15 to 5 IPC calls a second at rest | `7201387` |
| F6-1, F6-3, F6-4, F6-5, F6-7 | Sports: time-sliced prepare with `scheduler.yield` or a message channel; per-programme first-word hits and cached guide words instead of token arrays; the guide window covers every league after a real league switch; channel rows described as their pages arrive; memoized game cards | Longest main-thread block 150-690 to 23-53 ms; held heap 238 to 31 MB; NBA to All: 16 `epg.grid` calls and about 3 s to none and about 60 ms; warm re-prepare 0.5-0.7 s to 0.05-0.23 s | `4e24ed0`, `cd10678` |
| F3-1 | My List's staleness link finds the list by hash | 69 to 0.6 ms with 1,000 cached and 100 positions queries | `82cb8e7` |
| GAP-ui-features-2 | The episode queue resolves only the next episode | `streamUrl` calls at S1E1: 43 to 1; per auto-advance: 42 to 1 | `82cb8e7` |
| F3-5 | Search asks for guide programmes after a 300 ms rest, keeps narrowed answers, shows cached ones at once | Typing "breaking" over 2 sources: 14 `epg.search` calls to 2 | `82cb8e7`, `04d8816` |
| F3-6, F3-10 | Search's channel cells and the list page's dropped-channels tray are memoized | Channel renders per scroll step 84 to 0; tray rows per page render 2 to 0 | `82cb8e7` |
| F3-8 | Every My List reader gets a 5-minute stale time | A remount after 60 s: 2 reads to 1 | `82cb8e7` |
| F3-11 | Detail pages read the category list and the source pin only when needed | Per open with one source: 1 `catalog.categories` and 1 `sourcePins.get` to none | `82cb8e7` |
| F2-3 | The guide stores its data window length; the boot prefetch waits for the guide module on a cold launch | First open after a launch: the first grid chunk is prefetched, and the page adds no grid or channel call | `5b2a787`, `04d8816` |
| F2-4 | The guide's toolbar and preview band keep their memo; cached slices found by key | 3 to 0 renders of each over 3 scroll frames; cache lookup 519 to 8 µs a render | `5b2a787` |
| F2-5 | Outer time slices only around moves in time; slices only asked ahead kept 5 min | `epg.grid` calls per one-chunk vertical rest: 3 to 1 | `5b2a787` |
| F2-7 | `getChannel` reads other pages through a page-hash memo | 2.98 to 0.19 µs a read | `5b2a787` |
| GAP-ui-features-1 (part) | The UI keeps at most 200 Xtream archive tables per source | Bounded (test) | `5b2a787` |
| R8-2 | `.cargo/config.toml` builds the bundled SQLite without `SQLITE_ENABLE_MEMORY_MANAGEMENT` | 4 parallel readers: 76 to 133 calls/s; settled RSS after a guide ingest about 30 MB lower | `86e5c84` |
| R8-3 | `malloc_trim` after each source import (Linux, glibc) | Settled RSS after a 170k-item Xtream import: +278-328 to +46-71 MB | `86e5c84`, `e6b9a7f` |
| R8-1 | Release opt-level measured against 2 and 3 with the real profile; `"s"` kept, the Cargo.toml note corrected | At 2: resize and guide ingest 8-24 % faster, server binary +32 % | `86e5c84`, `e6b9a7f` |
| R6-9 | A width variant's fetch leaves WebP and AVIF out of `Accept` | A host that negotiates sends JPEG the resizer shrinks (a TMDB w600 poster: 62 KB WebP stored whole before, about 10-15 KB now) | `07576b9` |
| R6-10 | Recording mpv keeps no demuxer back buffer | About 150-200 MiB less per recorder (estimate; mpv not installed here) | `07576b9` |
| R6-5 | The HTTP recorder writes through a 128 KiB buffer flushed every 2 s | 6.5 Mbit/s for 5 s: 799 writes to 25, futex calls 1,553 to 77 | `07576b9` |
| R7-6 | The TMDB purge runs in the background, 500 rows per step | Launch no longer waits for a scan of every cached payload (17-20 ms warm, 1.5 s cold for 3,000 rows) | `07576b9`, `e6b9a7f` |
| R7-3 | `positions.continueWatching` walks `idx_positions_updated` and stops at the limit | 42k rows, limit 24: 68 to 0.46 ms | `07576b9` |
| GAP-rust-io-1 | `images.warm` and upstream slots per host and in all | Cold 30-poster wall: 2,422 to 759 ms (three hosts, server mode) | `9a8567f`, `e6b9a7f` |
| R6-3 (part) | A width variant is made from a cached wider copy | A second width of one image: 1 upstream GET to 0 | `9a8567f` |
| F3-4 | `userstate.setWatched` takes `episodeIds` and `series` and writes them in one transaction | 1,000 episodes: 944 to 18 ms; 201 calls to 1 | `3d8068b`, `e6b9a7f`, `04d8816` |
| R1-1 | All channels and radio take their total from stored counts | 200k channels: 8-20 ms a page to about 1 ms (40-110 ms with hidden groups) | `6b54f7d` |
| R1-4, R2-3 (step 1) | List readers skip a series row's `episodes` | M3U series page 5.5-6 ms to under 1 ms; 1,001-row search 200-240 ms to 18-50 ms | `6b54f7d` |
| GAP-rust-data-1 | `CatalogWriter::begin_with` weighs the rows to come; a rewrite of every row empties the search index at once | Start of a 180k-movie refresh: 3.8-5.2 s to 0.85-1.7 s; search index emptied in 6 ms, not 566 ms | `6b54f7d` |
| R3-1 | Xtream rows carry `extra_json` text and are freed once written | Heap per row 792 / 758 / 1,102 to 183 / 144 / 371 B; heap at the index build (20k movies) 18.8 to 2.3 MB | `6b54f7d`, `e6b9a7f` |
| R1-3, R2-7 | Removing a large source drops and rebuilds the `items` indexes | 200k channels: 3.3-3.4 s and 101 MB of WAL to 0.6 s and 27 MB | `6b54f7d` |
| R2-1, R2-2, R2-5 | M3U series rows streamed to the writer; show keys computed once per spelling; fewer copies per entry | 96 MB `m3u_plus` add: peak 422 to 212-215 MB, CPU 14.0-15.4 to 9.7-12.4 s; 82 MB 480k-channel list 150 to 120 MB | `aa6e0c3`, `e6b9a7f` |
| R3-4 | Stalker channel lists kept as text, decoded item by item when changed; at most 5 sync requests out at once | 20k channels: +176 to +57 MB (changed), +33 MB (unchanged); stall 0.4-0.5 s to 12 ms | `e05a269`, `e6b9a7f` |
| R3-6 | The Stalker bulk guide is kept as mapped programmes | Held 232 to 38 MB; stall 630 to 13 ms | `e05a269` |
| R3-7 | Stalker day tables cached per source, channel and date | Catch-up after the ribbon: 6 table requests and 2.1 s to none and 0.3 s | `e05a269`, `e6b9a7f` |
| GAP-rust-data-4 | The Stalker row cache stores compact JSON text | 5,000 rows: 36.8 to 7.9 MB | `e05a269` |
| R3-3 | A provider timeout outside an import is final | A silent `create_link`: about 91 s and 3 connections to 30 s and 1 | `e05a269` |
| R4-1 | A guide refresh replaces only changed programmes and updates the search index in place; prune and rebuild can no longer race | Unchanged refresh: 1.28 s and 62.8 MB of WAL to 0.39 s and 0.3 MB | `89fc9b6`, `fddc527` |
| R4-2 | Migration 0027 drops two programme indexes | First ingest 2.34 to 1.87 s; two-feed database 95.4 to 84.2 MB | `89fc9b6` |
| R4-5 | The Xtream guide caches drop expired answers and cap the archive at 60,000 programmes | Bounded (about 35-40 MB worst case, estimate) | `49b795d` |
| R4-4 | The channel directory is built at boot and before `epg.changed` | First now/next after a refresh: 210 to 1.6 ms | `49b795d` |
| GAP-rust-data-2 | Fuzzy name results survive a refresh with the same channels | 120 unmatched titles: 1,455 to 0.9 ms | `49b795d` |
| R4-7 | An unchanged guide body is kept as on a 304 | 120 MB local guide: 1.45 s to 0.001 s | `49b795d` |
| R4-8 | A failed guide refresh sends a status-only `epg.changed` | Clients refetch `epg.sources` only | `49b795d` |
| GAP-rust-data-3 (part) | Guides that already have data wait until 30 s after boot | Not measured | `49b795d` |

Each subsystem document says how its part works now: performance.md, catalog.md, epg.md, guide-search.md, m3u.md, xtream.md, stalker.md, image-cache.md, recording.md, userstate.md, vod-browsing.md, sports.md, watchlist.md, server.md, desktop.md, ui-shell.md, players.md, tmdb.md and sources.md.

## Not done

Refuted by a verifier:

| Finding | Reason |
| --- | --- |
| F1-2 | The detail pages' Escape helper does not pull the controls in on its own (the move to `menuDismiss.ts` was made anyway with F1-1). |
| F2-9 | The now/next refetch is needed for rows whose programme changed; the proposed change was unsafe. |
| F6-6 | Settings already splits its sections where it pays; the remaining chunk is needed for General. |
| F3-9 | Recordings and reminders lists are small and already shared across readers. |
| R1-6 | `catalog.items` batches are small. |
| R2-8, R6-1 | Per-crate opt-levels are lost under fat LTO; covered by the measured profile decision (R8-1). |
| R6-6 | Capability checks are cached and cheap. |
| R6-7 | macOS libmpv polling costs nothing measurable. |
| R6-8 | The image cache reconcile is quick and runs off the critical path. |
| R7-5 | The channel hide recount is fast at real sizes. |
| R4-6, R5-4, R6-2, R8-4 | zlib-rs: verifiers measured negligible gains for guide and playlist inflates. |

Real, but left for later:

| Finding | Reason |
| --- | --- |
| R5-1, F4-4 | Cancelling desktop RPCs: real but low payoff, and needs a new IPC command on both sides; the UI's debounces already outlast most superseded reads. |
| R5-2, R6-4 | Stable desktop image URLs: negligible gain, and unsafe, since the per-launch token is a security boundary. |
| R1-2 | A separate read pool: the remaining ungated writes are already handled; low payoff now. |
| R1-5, R5-3, R8-5 | Serializing RPC results once: about 0.1 ms per call, low payoff for a cross-cutting change. |
| R1-7 | Partial VOD indexes: low payoff for a migration that rebuilds six indexes on upgrade. |
| R2-6 | Pausing refreshes while playing: low payoff and a behaviour change. |
| R3-2 | Parallel Xtream list downloads: low payoff, and holds more memory at once. |
| R3-5 | Typed Xtream decode: faster, but changes how malformed elements are handled; needs a product decision. |
| R4-3 | Integer feed ids for programmes: a large migration; the diff swap (R4-1) gets most of the refresh gain without it. |
| R7-1, R7-2 | Backup import memory and export without a path: rare actions, low payoff. |
| F2-6 | Dropping programme icons from `epg.grid`: low payoff, needs a core and a UI change together. |
| F2-8 | Ribbon tick rendering: negligible. |
| F3-2 | `downloads.list` observation: low payoff, medium effort. |
| F5-2 | The kit's i18n mount cost: low payoff, medium effort across the whole kit. |
| F5-7 | Virtualizer measurement arrays: unsafe to change inside react-virtual's contract. |
| F6-2 | Filtering sports programmes in the core: real, but large and cross-layer; the Sports changes already cut the prepared guide's heap from 238 MB to about 31 MB. |
| F4-8 | Prefetching Home's On now rail: one or two serial round trips on a cold Home (10-25 ms of skeleton on desktop) for a three-stage prefetch that must reproduce Home's ref order. |
| F4-3 | The desktop deep-link check at launch: needs measuring on Windows first, and a safe version needs a buffer for links that arrive during the wait. |
| F3-3 | "More like this" lookups falling into the substring scan: needs a `prefixOnly` flag in the core's `catalog.search` and a one-line UI change. |
| R2-4 | Parsing M3U on its own thread: implemented, measured and dropped. No wall-clock gain in a same-binary comparison, about 1 s more CPU and 15 MB more RSS per 450k-entry import. Worth trying again once the parser thread serializes `extra` itself. |

Parts of fixed findings left out, each as its verifier advised or for the reason given: the WebP decoder for width variants (R6-9; needs the image crate's feature); indexes on `tmdb_cache.expires_at` and a partial index on unwatched positions (R7-6, R7-3; migrations, so limit 200 of Continue watching still reads the whole index when fewer than 200 items are in progress); moving M3U episodes to a column of their own (R2-3 step 2); a shared body flight per URL across widths and keeping small originals (R6-3); domain sharding and HTTP/2 to image hosts (GAP-rust-io-1); localStorage engine-usage flags (F1-7); making English lazy (F5-4); navigation preload and a theme-boot precache (F5-3); the short EPG skip for rows with an Xtream table (GAP-ui-features-1); reading Stalker table pages in parallel (R3-7); counting live totals minus hidden groups for the filtered shapes (R1-1); batching Undo of a long series' unmark, still one call per episode (F3-4).

Open from the reviews: a Stalker day-table read is single-flight through a held lock, so a caller that gives up cancels the read the others wait for; the palette host keeps the palette mounted after its first open, so it re-renders on navigation afterwards; a few wording and timing notes on the guide's boot and the recorder's flush.

## Checks

The verifier ran the full checks at `04d8816` with a clean tree:

| Check | Result |
| --- | --- |
| `pnpm typecheck` (tsc-rs) and `pnpm typecheck:tsc` | Pass |
| `pnpm vitest run`, Node 24 (the version `package.json` requires) | 6,005 passed, 1 failed, 10 skipped |
| `pnpm vitest run`, Node 22 | 6,001 passed, 5 failed, 10 skipped: the one above, three files that need `Intl.DurationFormat` (pass on Node 24), and `guideFallback.test.tsx`, which fails only under load and passes alone |
| `cargo fmt --all -- --check` | Pass |
| `cargo clippy -p iptv-core -p iptv-server -p iptv-mock --all-targets -- -D warnings` | 3 `unused variable` errors in `player/embedded.rs`, a file the branch does not touch (they exist at `88b94a3`). With `--force-warn unused_variables` and every other lint denied: pass |
| `cargo test -p iptv-core -p iptv-server -p iptv-mock --no-fail-fast` (debug) | 1,632 passed, 1 failed, 34 ignored |
| `pnpm build && pnpm size:check` | Pass: entry 205,517 B of 268,000; no lazy-only module at boot; all 23 routes pass |
| `cargo check -p iptv-tauri` | Not run: the Linux box has no GTK or WebKit libraries. The branch changes nothing in `crates/iptv-tauri`, and the one `iptv-core` item it imports that changed keeps its signature |

The two failures predate the branch:

- `src/features/live/guide/test/favoritesGrid.test.tsx`, "asks complete favorite chunks for the visible slice and adjacent time slices", expects 3 `epg.grid` calls and gets 1. The test file is unchanged on the branch, and it fails the same way on `88b94a3`'s sources.
- `l2_import_sync`'s `a_removed_catalog_is_written_again_even_when_the_panel_did_not_change` fails about 1 run in 10 with "no such table: items" while preparing its own `DELETE` on a connection the pool has just opened, with the table listed in `sqlite_master` and the same statement succeeding when retried. It fails on `88b94a3` too (13 of 40 instrumented runs against 15 of 40 on the branch), and not because of the SQLite build flag (15 of 40 with the flag removed). It needs an investigation of its own.

The measurer re-ran the Rust baseline three times and every new measurement test; all passed but one ignored test, `m3u_perf::import_80mb_playlist_with_flat_memory`, which asserts a peak under 100 MB and measures 119 MB. It was not run for the baseline, and it measured 150 MB before the branch: the branch improved it, but the limit was already unmet. The rest is SQLite's index rebuild and FTS memory; the limit or that memory needs a follow-up.

Not checked here: the Playwright specs (the guide scroll specs, the phone tab bar, `theme-boot.spec.ts`), the Windows build of the SQLite flag (`sqlite_compile_options` in the Windows CI job will show whether MSVC accepts `-U` after libsqlite3-sys's own `-D`), that the oldest supported mpv accepts the recorder's two new options (`--no-config` makes it refuse unknown ones), an HLS recording checked with ffprobe, and runtime traces of the engine warm-up skip, desktop offline queries and the locale preload.
