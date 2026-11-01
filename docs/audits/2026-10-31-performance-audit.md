# Performance audit

Tsrust IPTV, branch `claude/iptv-performance-audit-mw9j3c`. The audit started from `88b94a3` on 2026-10-31, and the fixes landed on 2026-10-31 and 2026-11-01, ending at `2c15cce`: 102 commits and 264 files. Unlike the 2026-10-19 audit, this report covers both the findings and the work done on them.

## Summary

Twelve reviewers re-read the code after the 2026-10-19 audit and its fixes. They reported 72 findings. A verifier checked each one: 47 held as reported, 25 held in part, and none were refuted. The verifiers lowered 17 severities and raised none. After verification, 2 findings are High, 21 Medium and 49 Low. Of the 72, 64 are fixed, 4 are partly fixed, and 4 were left alone on purpose (see [Not done, and why](#not-done-and-why)).

What changed, by area:

1. Database. Hot reads now run on a separate read-only pool of 6 connections, so writers waiting out an import's save can no longer take every connection. The last ungated writers now pass a gate. In a debug-build test with all 8 write connections parked, 13 reader RPCs and an image hit answered in 0.1-3.2 ms. Before, they failed at the 15 s checkout timeout. Removing or replacing a large source now rebuilds the search index and secondary indexes instead of deleting row by row.
2. Imports. Xtream lists are decoded element by element. Every list is downloaded before the import save slot is taken, so a changed list no longer blocks other imports while the later lists download. Xtream rows and M3U series rows carry JSON text instead of `serde_json` trees: about 160 MB less at 50k channels, 180k movies and 20k series, and about 105 MB less at 120k episodes. A Stalker sync sends its sections together.
3. The guide core. The search index is kept in step inside the guide swap instead of being rebuilt for every feed after each refresh. Now/next stops reading feeds once it has the programme on air and the next one. Each ref resolves with one statement. The channel directory is built before `epg.changed` goes out. gzip goes through zlib-rs.
4. Stalker. Archive day tables are cached and shared with catch-up. The bulk guide is indexed per channel instead of kept as a JSON tree for the session.
5. Replies and builds. RPC results are serialized once (this was DB-5). The server image builds at opt-level 3, and replies compress with brotli quality 1.
6. Frontend. The entry chunk shrank from 223,838 to 205,755 bytes, and what Live loads before its first render from 497,498 to 386,651 bytes. MPEG-TS starts reuse a booted spare mpegts.js worker: 21.0 ms to the stream request before, 6.3 ms after, in headless Chrome. The fullscreen channel panel now pages through Live's cached pages. The guide asks Xtream for days of archive instead of whole tables. Sports, My List, the rail and the palette stopped re-rendering for changes that don't affect them.

What was not measured: no release-mode benchmark ran, and nothing ran on an N100, on Windows, in WebView2 or in WKWebView. The Rust timings below come from Python sqlite3 benches, standalone `rustc -O` benches, dev-profile tests or the findings' estimates, and each one says which. [Measuring on the PC](#measuring-on-the-pc) lists the release checks still worth running.

Each of the 15 implementation batches had its own adversarial review. Those reviews raised 32 issues, including 3 bugs, and all of them are fixed. A final review across batches found 2 more problems where batches interact: a bug and a missed saving. Both are fixed.

## Method

The code was split into twelve slices:

| Slice | Covers |
| --- | --- |
| R1 | Database, catalog and the RPC layer (`db/`, `catalog/`, `rpc/`, `state.rs`, RPC handling in both hosts) |
| R2 | Guide, EPG and catch-up in the core |
| R3 | M3U and Xtream import |
| R4 | User state, parental controls, TMDB, lists and settings |
| R5 | Stalker, the sources lifecycle and backup |
| R6 | Downloads, recording and the image cache |
| R7 | Hosts: server, desktop, players, remote control, HTTP |
| F1 | Shell, UI kit, API layer and bundle |
| F2 | Player and multi-view |
| F3 | Live TV and the TV guide |
| F4 | VOD, library and My List |
| F5 | Sources, settings, Sports and smaller features |

Each reviewer read docs/architecture/performance.md, the 2026-10-19 audit with its status table, and the area's docs before the code, so they would not re-report decisions that were already measured. Each slice also had an adversarial verifier. The verifier re-read the cited code, re-ran or repeated the measurements where it could, and returned a verdict (confirmed, partly or refuted), a severity, a refined fix and its risks. Where the refined fix differed from the reviewer's, the implementers followed the refined fix.

Implementation ran in 15 batches: RB-A to RB-I for the core, FB-1 to FB-6 for the frontend. Each batch owned a set of files. Implementers wrote tests that pin the new behaviour and, where they could, checked that those tests fail against the old code. Each batch then had an adversarial review against its brief and the committed code. The review issues were checked and fixed in follow-up commits, and the architecture docs were brought up to date in `492849e`, `ccaa074` and `6d802ed`. Finally, a cross-batch review looked at how the batches interact. One lens covered wire and cross-layer contracts: RPC arguments, result shapes and key order, `RPC_COMMANDS`, the server policy and cancel list, the desktop proxy and Tauri IPC, iptv-mock, the e2e mocks and the test harnesses, plus backup, the remote control and server mode. The other lens covered frontend integration. That review produced the last two fixes, `d247ad9` and `2c15cce`.

Rust was available this time (1.97 in the sandbox), so the items the previous audit left because there was no compiler on gmk1 were done: DB-5 (R1-5, R7-4), the separate read pool (R1-1), IN-7 (R3-2) and the first stage of EP-3 (R2-1). All Rust changes were compiled and tested in the sandbox.

The sandbox has 4 CPUs (a Xeon) and Node 22; the repo asks for Node 24. Release-mode benchmarks were not run, because the batches were told not to build release and the sandbox is not the target hardware. The Rust numbers therefore come from four sources, and each one below names its source:

- Python sqlite3 3.53 benches by the reviewers, on a scratch database built with the app's migrations and pragmas. The app bundles SQLite 3.46.0, so query plans could differ slightly. F2-1's panel numbers were measured on a build of the bundled 3.46 amalgamation.
- Standalone `rustc -O` benches by the R3 and R7 reviewers, against the crate versions pinned in Cargo.lock, on one Xeon core and without LTO.
- Dev-profile tests by the implementers: iptv-core unoptimized, dependencies including SQLite at opt-level 1.
- The findings' own estimates, marked as estimates.

On the frontend, `pnpm build` and `tools/check-bundle.mjs` produced the bundle numbers. Vitest tests in jsdom produced the render and request counts by counting calls. The mpegts.js start was timed in headless Chrome.

## Measurements

### Bundle

From `pnpm build` and `node tools/check-bundle.mjs`. "Before" is `bce7579`, the last commit before the bundle fixes. "After" is `6bd1197`, the last commit of the bundle batch (FB-5), with the `cb41a7d` build in brackets where it differs. Closures count the bytes a route loads beyond the boot chunks before its first render.

| Check | Before | After |
| --- | --- | --- |
| Entry chunk | 223,838 B, 75.35 kB gzip | 205,525 B, 70.64 kB gzip (205,755 B, 70.72 kB gzip) |
| Live | 62 chunks, 497,498 B | 53 chunks, 386,527 B (386,651 B) |
| TV guide | 63 chunks, 519,660 B | 54 chunks, 411,291 B (411,656 B) |
| Scheduled | 304,381 B | 210,865 B |
| Movie detail | 414,253 B | 297,789 B |
| Series detail | 426,264 B | 312,462 B |
| Search | 238,205 B | 220,393 B |
| Category grid | 217,851 B | 205,718 B |
| VOD landing | 212,040 B | 197,550 B |
| My List | 115,720 B | 97,186 B |
| Home | 168,148 B | 167,682 B |
| Settings | 215,613 B | 229,733 B |
| Sports | 154,918 B | 168,386 B |

Settings and Sports grew because `experimentalMinChunkSize` merged shared modules into different chunks. Entry plus closure still fell on every route: Live from 721.3 to 592.1 kB, the guide from 743.5 to 616.8 kB, Home from 392.0 to 373.2 kB, Search from 462.0 to 425.9 kB, Settings from 439.5 to 435.3 kB and Sports from 378.8 to 373.9 kB. F1-1 alone took 1.31 MB off the sum of all 23 route closures. The entry budget is unchanged at 268,000 B. The 2026-10-19 audit measured the entry at 141,525 B, so it had grown by about 82 kB between the two audits (F1-7).

### Player start

Measured in headless Chrome against the old and new patched mpegts.js dist. Each figure is the time from `createPlayer` and `load` until the `/live/*.ts` request reaches a local server, as the median (mean) of 10 samples.

| CPU | Before | After |
| --- | --- | --- |
| Full speed | 21.0 ms (21.4) | 6.3 ms (6.5) |
| 4x throttle | 37.7 ms (38.7) | 16.3 ms (17.0) |
| Worker blob URLs over 10 starts | 10 | 1 |

### Render and request counts

From the vitest tests added in the pass, in jsdom. "Before" was measured by running the same test against the old code.

| Case | Before | After |
| --- | --- | --- |
| Fullscreen channel panel, 30-frame scrollbar drag across 45 pages (F2-1) | One `catalog.channels` read per frame | At most 2 pages and 2 `epg.nowNext` |
| Channel panel reopened, or closed (F2-1) | Requests on each open | 0 RPCs |
| Embedded mpv fullscreen, cursor at rest (F2-3) | 15 IPC calls a second | 5 on Windows, 0 on macOS |
| Embedded mpv plain layout, full measures (F2-3) | 4 in the test window | 0 over three ticks, then 1 every 2 s |
| Sports NBA tab on a 60-game slate, 8,000 channels (F5-1) | 16 `epg.grid` calls (about 43 MB), about 2,050 ms with loading shown | 0 calls, about 4 ms |
| Sports with 24 cards: keystroke / score poll / clock tick (F5-2) | 24 / 24 / 24 card renders | 0 / 1 / 2 |
| Hidden channels dialog, 1,000 hidden: open / Unhide all (F5-4) | 15 / 985 `catalog.item` calls | 1 / 2 `catalog.items` calls |
| 304 guide refresh: grid refetches (F5-5) | 1 | 0 |
| Full guide refresh or error: grid refetches (F5-5) | 2 | 1 |
| My List toggle on the VOD landing: card bodies drawn (F4-4) | 289 | 0 |
| My List change among 50 grid cells and 50 linked cards (F4-4) | 100 | 1 |
| Cold Xtream detail with an 800 ms provider: hero shown (F4-1) | Skeleton until the answer | About 81 ms |
| "More in" rail on a detail page as answers land (F4-6) | 80 card renders (movie), 100 (series) | 20 |
| My Videos logos, 300 recordings from 25 channels (F4-5) | 25 `catalog.item` calls | 1 `catalog.items` call |
| Recordings tab, keystroke that keeps all 300 files (F4-5) | 300 row renders | 0 |
| `downloads.list` refetches per `downloads.update` on a detail page (F4-7) | 2 | 1 |
| Rail on a source page, three typed `?q=` (F1-3 and its review fix) | 6 source entry and 18 link renders | 0 |
| Palette opened once, three typed `?q=` (review fix) | 15 `useVisibleSources` reads | 0 |
| `useVisibleSources` `.data` reader on an unchanged refetch (F1-6) | 2 renders | 0 |
| Two labels across 20 mounted rows, i18next translate calls (F1-2) | 40 | 2 |
| More like this or Known for on an actor page (F4-3) | Up to 40 `catalog.search` calls | 2 `catalog.matchTitles` calls |

### Core timings

| Item | Before | After | Source |
| --- | --- | --- | --- |
| Reads with all 8 write connections parked by writers waiting out a save (R1-1) | Failed at the 15 s checkout timeout | 0.1-3.2 ms for 13 reader RPCs and an image hit; 35 µs-2.6 ms for every other moved RPC | `l2_import_pool.rs`, dev profile |
| 14 catalog pages, write lock held, 3 connections busy, 11 newly gated writers (R1-1) | The 11 writers alone outnumbered the 8 connections | 6.5 ms | `l2_import_pool.rs`, dev profile |
| Stalker login while the write lock is held (R1-1) | Session write could wait up to 600 s under the session mutex | 13 ms | `l2_import_pool.rs`, dev profile |
| Second forced account check during another source's save (cross-batch fix) | Timed out at 5 s | 0.7 ms | `account_status.rs`, dev profile |
| Count on a 200k-channel list page (R1-2) | 4.42 ms of a 4.7 ms first page | 0.04 ms (stored total) | Python sqlite3 bench |
| 60-row page of 20-episode M3U shows (R1-3) | 0.85 ms, 14,760 allocations | 0.1 ms, 120 allocations | Commit `a163f9b`; profile not stated |
| `begin` of a 250k-row refresh beside 40k kept rows (R1-4) | 1.10-1.17 s | 0.44-0.45 s | Dev profile |
| Removing a 250k-row source beside 40k rows (R5-4) | 2.98-3.74 s, not counting the commit | 1.13-1.43 s, commit included | Dev profile |
| Guide refresh, 3 feeds of 200k programmes (R2-1) | 1.32-1.47 s swap plus 1.48 s rebuild, in two transactions | 2.61-2.69 s in one transaction | Dev profile |
| Guide swap and rebuild per refresh (R2-1, before) | 0.76-0.96 s swap per feed, plus 0.25 s rebuild per 200k programmes of all feeds | | Python sqlite3 bench |
| Now/next, 120 refs on 3 overlapping feeds (R2-2) | 360 feeds read, 13.3 ms | 120 feeds read, 5.8 ms | Python sqlite3 bench of the two query patterns |
| Continue watching, 4,283 position rows (R4-3) | 4.7 ms | 0.13 ms | Python sqlite3 bench |
| Hide one channel, 270k items (R4-4) | 15.4 ms | Under 0.1 ms | Python sqlite3 bench |
| List reorder move, 2,000 rows (R4-5) | 4.8 ms; 3.4 MB of WAL per 30 moves | 1.3 ms; 0.25 MB | Python sqlite3 bench |
| TMDB boot purge, 37 MB cache (R4-2) | 9.3 ms warm (about 1 s cold on eMMC, estimated) | 0.15 ms | Python sqlite3 bench |
| Stalker sync, 300 ms per request (R5-3) | 14 waves, about 4.2 s of waiting (estimated) | 2.44 s, 7 requests in flight at the start | `stalker_paging.rs` |
| Week of Stalker archive, 100 ms per request (R5-1) | Pages read one after another per table, again for every caller | 45 pages, 4-6 in flight; a second read and a catch-up click read 0 tables | `fix3_stalker_epg.rs` |
| Xtream `get_vod_streams`, 180k movies, 72 MB (R3-2) | 486 ms, 7.74M allocations, 170 MB transient | 168 ms, no intermediate buffer | Reviewer's `rustc -O` bench; not re-measured |
| M3U `m3u_plus` line (R3-7) | 406 ns, 12 allocations | 244 ns, 5 allocations | Reviewer's `rustc -O` bench |
| RPC reply, 120 / 500 channel rows at "s" (R1-5, R7-4) | 242 / 1,025 µs through a Value tree | 92 / 329 µs direct | Reviewer's `rustc -O` bench; not re-measured |
| Brotli, 40 KB / 165 KB reply at "s" (R7-2) | Quality 4: 530 µs / 2,525 µs | Quality 1: 409 µs / 1,268 µs | Reviewer's prebuilt bench, re-run by the implementer |
| Same at opt-level 3 (R7-1, R7-2) | Quality 4: 282 µs / 1,430 µs | Quality 1: 203 µs / 475 µs | Same |

### Memory

| Item | Before | After | Source |
| --- | --- | --- | --- |
| `backup.import`, 24 MB embedded playlist, peak heap (R5-7) | 144.0 MB (6.0x) | 50.0 MB (2.08x); 71.8 MB after the moves alone | Counting allocator, `backup_import_memory.rs` |
| Retained heap per mapped Xtream row: live / VOD / series (R3-1) | 1,186 / 1,162 / 1,566 B | 561 / 534 / 791 B | Counting allocator, dev profile |
| The same at 50k live, 180k VOD, 20k series | | About 160 MB less | Arithmetic from the row figures |
| M3U episode held from grouping to `finish` (R3-3) | About 877 B as a tree | About 200 B as text, one show at a time | Counting allocator; about 105 MB at 120k episodes |
| FTS index after a large refresh test (R1-4) | 828 KB (per-row path) | Under 1.25x of the 310 KB start | `l2_cross_bulk_write.rs` |
| Stalker bulk guide for a 10k-channel portal (R5-2) | On the order of 100 MB as a JSON tree | Compact per-channel index | Estimate, not measured |
| Prefetched guide slices after 30 rests in 15 min (F3-3) | About 50-65 MB, two thirds never displayed | Prefetches dropped after 5 min | Estimate |
| Xtream archive tables in the guide (F3-1) | Up to 2,000 whole tables per source for the life of the app | At most 200 answers of about 3 days each, released on unmount | From the code paths |

### Compression sizes

From the R7-2 implementer, on fixture replies (`m3u_text(2000,20)` plus an 8 MB `write_xmltv` guide), in bytes.

| Reply | br q1 | br q4 | gzip 1 | gzip 4 |
| --- | --- | --- | --- | --- |
| `catalog.channels`, 120 rows (45,342 B) | 3,545 | 3,212 | 5,832 | 4,160 |
| `epg.grid`, 40 channels x 7 h with descriptions (70,378 B) | 5,486 | 4,575 | 7,291 | 4,728 |
| The same grid without descriptions (34,854 B) | 3,574 | 2,967 | 4,692 | 2,982 |
| `epg.nowNext`, 40 refs (9,691 B) | 1,672 | 1,397 | 2,028 | 1,457 |

Brotli quality 1 costs 10-20 % more bytes on these repetitive replies and 1-3 % on varied rows, for about half the CPU. Gzip level 1 came out 39-57 % larger than level 4, because zlib-rs level 1 uses static Huffman codes only. Plain-HTTP LAN browsers get gzip, so gzip stays at level 4 in its own layer.

## Database, catalog and RPC

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| R1-1 | Reads and waiting writers share one 8-connection pool; ungated writes remain, one under the Stalker session mutex (DB-1 remainder) | Medium | Fixed | Phase 1 put the last writers behind gates. The Stalker session and Xtream metadata go to the background writer, and the session write no longer runs under the session mutex. Account saves, import outcomes and `window.setState` go through the background gate. Download and source writes go through the user gate. Phase 2 added a read-only pool of 6 for the catalog, guide, user-state, parental and image reads. Shrinking the write pool waits for release measurements. |
| R1-2 | Every page of a large list recounts the whole list | Medium | Fixed | Unfiltered live and radio lists sum the stored category counts, which already exclude hidden channels. The optional English-only count column was not added. |
| R1-3 | List readers parse each M3U series row's whole episode list into a Value | Medium | Fixed | Readers skip the `episodes` key with `IgnoredAny`. The episode readers deserialize it straight from the row text. Fixed together with R3-6. |
| R1-4 | Large rewrites and source removal delete FTS entries row by row; removal updates all 12 `items` indexes per row (DB-2 remainder) | Medium | Fixed | A rewrite that replaces more rows than it keeps runs an FTS `rebuild`. Removing a source at least as large as the rest drops and recreates the indexes around the cascade. Same commit as R5-4. |
| R1-5 | Every RPC result is built as a `serde_json::Value` and serialized again by both hosts; the server keeps the request body for the whole call (DB-5) | Low | Fixed | `dispatch_raw` serializes once. The server sends the text as the body, and Tauri returns it as `InvokeResponseBody::Json`. The request body is freed before the command runs. Same change as R7-4. |
| R1-6 | `catalog.items` reloads per-source data for every ref | Low | Fixed | Catch-up overrides, custom names and the source kind are read once per batch. |

## Guide and catch-up (core)

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| R2-1 | A guide refresh holds the write lock to swap the feed, then again to re-index every feed (EP-3) | Medium | Partial | Stage 1: the swap keeps the search index in step inside its own transaction, either for the refreshed feed or for all feeds, whichever costs less (migration 0028). Each upkeep step runs under a savepoint, and the index marker names the Unicode version. Stage 2, integer feed ids with a repoint swap, is not done. |
| R2-2 | Now/next reads every feed that carries the channel | Low | Fixed | It stops once it has the programme on air and the next one. |
| R2-3 | The /epg grid asks for Xtream's whole archive table per visible row | Medium | Fixed | The core picks programmes before cloning them and drops expired tables (`ed747e2`). The grid asks `catchup.programs` over whole days (F3-1). The ribbon still asks `catchup.table` for its one channel. |
| R2-4 | Every refresh rebuilds the guide-channel directory under a lock the next reads wait on | Low | Fixed | The directory is built before `epg.changed` goes out, with half the regex work. |
| R2-5 | Each ref costs 4-5 point queries, a JSON parse and an unmemoized normalization | Low | Fixed | One statement per ref, with `tvgShift` read in SQL. Title and programme checks are memoized per directory. |
| R2-6 | gzip still goes through miniz_oxide | Low | Fixed | flate2 now uses zlib-rs, which is 1.3-2x faster by the finding's estimate. |

## Ingest (M3U and Xtream)

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| R3-1 | Xtream rows carry a JSON map extra, a copied `source_id` and Vec slack; extra is serialized inside the write transaction (IN-3) | Medium | Fixed | The extra is serialized on the blocking pool into `ItemRow::extra_json`, with the same bytes as before, and there is no `source_id` copy. The capacity hint was skipped, since it saves no RSS. |
| R3-2 | Xtream list decoding builds a Value per element and keeps a whole `Vec<RawVod>` (IN-7) | Medium | Fixed | Streaming visitors map each record as it is read. Parity tests compare it with the old path, including 3,000 generated bodies. |
| R3-3 | M3U series grouping holds every show's episode tree through the index rebuild | Medium | Fixed | Series rows are built lazily, one show at a time, with the episodes written as text. |
| R3-4 | A changed Xtream kind holds the save slot while the later lists download (ST-2) | Medium | Fixed | The sync runs in two phases. It downloads and stages every list to disk with no slot held, then decodes under one slot wait. Failures are reported in content-type order. The BytesMut pre-size was left out on purpose. |
| R3-5 | Every M3U episode re-runs `title_base` and `show_key` for its show | Low | Fixed | The show index is cached per group and raw title. |
| R3-6 | Every read of an M3U series row parses its episode list | Low | Fixed | Fixed with R1-3. |
| R3-7 | Per-entry allocation churn in the parser and row builder (IN-10) | Low | Fixed | Attributes are borrowed, extra is written as text, and seen ids are kept as u64. |

## User state, parental, TMDB and settings

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| R4-1 | `window.setState` and the account-status save skip the write gates, and the save is awaited | Low | Fixed | Both go through the background gate, and the shell skips unchanged geometry. A forced check answers before its row is stored. Since the cross-batch fix, a second forced check reuses the first one's unstored answer. |
| R4-2 | `tmdb::init` scans the whole cache at boot, and server mode waits for it | Low | Fixed | The purge reads through an expiry index (migration 0027) in the background. |
| R4-3 | `positions.continueWatching` ranks every row with a window function | Low | Fixed | A newest-row statement reads a partial index (0027). |
| R4-4 | `channels.setHidden` recounts every category inside the transaction | Low | Fixed | Stored counts move by the changed channels. |
| R4-5 | List, favorites and My List reorders update every row on each move | Low | Fixed | Only rows whose position changes are written. The client change was not needed after that. |

## Stalker, sources and backup

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| R5-1 | Stalker archive guide reads up to 9 day tables page by page per ribbon, and catch-up reads them again | High | Fixed | Day tables are cached per source, channel and date and shared with catch-up. Pages go out three at a time, with at most 6 requests per source. A `to` argument bounds past windows. A read that a failed page cut short is not reused (review fix `ec7a415`). |
| R5-2 | The bulk `get_epg_info` guide is kept as a JSON tree for the session and refetched every 5 minutes | Medium | Fixed | It is indexed per channel on the blocking pool, stays fresh for 30 minutes, refreshes in the background, lets the old guide go once a refresh succeeds, and is dropped after 35 idle minutes. |
| R5-3 | A Stalker sync makes 5-6 portal calls one after another and holds the save slot across the totals request | Medium | Fixed | The sections are requested together after the session, and the slot is taken after the totals arrive. |
| R5-4 | Removing a large source updates every index and the FTS index row by row (DB-2 remainder) | Low | Fixed | Fixed with R1-4. |
| R5-5 | Large portal answers are parsed on a runtime worker; an unchanged refresh still builds and re-serializes the tree to hash it | Low | Partial | Answers over 1 MB and long-timeout calls are parsed on the blocking pool. Hashing the raw text for the unchanged check (the M part) is not done. |
| R5-6 | Stalker page sizes are relearned every session and dropped after every sync | Low | Fixed | Page sizes survive a sync and are seeded by the totals request. |
| R5-7 | `backup.import` holds 3-4 copies of every embedded playlist and parses on a runtime worker | Low | Fixed | The text moves through the import, is parsed on the blocking pool, and the fingerprint is hashed while the text is read. |
| R5-8 | Web backup export is serialized twice, and URL sources' text cannot be left out (ST-4 remainder) | Low | Not done | See below. The Value copy disappeared with R1-5. |

## Downloads, recording and image cache

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| R6-1 | Desktop image URLs change every launch, so WebView2's HTTP cache never serves an earlier session's poster (EP-6 remainder) | Low | Not done | This needs a security decision. See below. |
| R6-2 | "Serve the original" decisions live only in memory, and flat PNG logos repeat a discarded resize | Low | Fixed | A kept original of 256 KiB or less is also stored under the variant key. Larger ones are still remembered in memory only. |
| R6-3 | The image cache reconcile reads every row and stats every file at every launch | Low | Fixed | It runs after an unclean shutdown or weekly, once the database has been quiet for 5 s (60 s at most). A pass owed after a crash stays owed until one finishes (`cb41a7d`). |
| R6-4 | Segmented downloads fsync the whole `.part` every 2 s for the sidecar | Low | Fixed | The sidecar is now saved every 15 s. The optional adaptive interval was not added. |
| R6-5 | Server-mode image hits read and parse the source row twice | Low | Fixed | A hit for a URL the untrusted check passes reads no source row. |
| R6-6 | The recording HTTP copy makes a blocking-pool write per chunk and stats on a runtime worker | Low | Fixed | It writes through a 256 KiB buffer and checks the final flush. Stats run on the blocking pool. |

## Hosts, replies and builds

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| R7-1 | Release opt-level "s" makes serialization about 2.7x and brotli about 2x slower (HO-6) | Medium | Partial | The Docker image builds with a `release-server` profile at opt-level 3, which was checked by a unit-graph dry run but not built. The desktop stays at "s" until it is measured. |
| R7-2 | Server mode compresses every reply with brotli quality 4 | Low | Fixed | Brotli now runs at quality 1. Gzip stays at level 4 in a separate layer, after the size check the verifier asked for (table above). |
| R7-3 | macOS embedded mpv: the render thread hops to the main thread every frame, and the event pump polls at 30 Hz | Low | Not done | This can't be tested without a Mac. See below. |
| R7-4 | Every reply builds a Value tree that both hosts serialize again (DB-5) | Low | Fixed | Fixed with R1-5. |
| R7-5 | External mpv with reuse on is killed and cold-started on every zap (HO-9) | Low | Not done | This changes behaviour and can't be tested here. See below. |

## Shell, data layer and bundle

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| F1-1 | Live, the guide, Scheduled, My List and detail pages load the player dock and controls plus Home's cards before their first render (SH-2) | Medium | Fixed | The dock moved out of the player barrel into `@/features/player/dock`, which only the shell loads. A dock-request event covers plays with no press. `check-bundle.mjs` now fails if Live or the guide reach Controls, or if Live, the guide, Search or Scheduled load `cards`. `EpgMappingDialog` stays a static import, because making it lazy measured larger. |
| F1-2 | i18next takes 9-14 % of UI JavaScript: uncached `t()` and re-subscribing hooks | Medium | Fixed | One shared cache answers option-free `t()` calls behind `getFixedT`, at about 0.02 µs a call instead of 1.9 µs. The optional react-i18next codemod was not done. |
| F1-3 | The closed palette loads cmdk and an unused Radix dialog at boot, and it re-renders with the rail on every `?q=` (SH-1) | Low | Partial | The palette and shortcut overlay mount on first open, and their chunks are warmed at idle and on hover. The rail and palette read the pathname and a stable navigate. The build-time stub for cmdk's Radix dialog was not done. |
| F1-4 | The service worker's start-up and cache writes sit on every web launch (SH-11) | Low | Fixed | Navigation preload is on, and cache writes run under `waitUntil` without delaying the response. Network-first for `/assets` was skipped, since it would change offline behaviour. |
| F1-5 | hls.js and mpegts.js (890 kB) are preloaded even when every player is mpv or VLC | Low | Fixed | The idle warm-up and the spare TS worker are skipped when cached settings put every play outside. This was not measured in a browser. |
| F1-6 | `useVisibleSources` spreads the tracked query result, so 13 consumers re-render on every fetch-state change | Low | Fixed | The hook now filters through `select`. |
| F1-7 | The entry grew from 141.5 kB to 223.4 kB because the shell drags in whole UI-kit modules | Low | Fixed | The phone tab bar loads lazily, `SearchInput` has its own module apart from `Field`, and the PiP code moved to `pipWindow.ts`. |

## Player and multi-view

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| F2-1 | The fullscreen channel panel reads number-sorted pages through a non-covering index, with no settle, cancel or cache (LV-1) | High | Fixed | The panel pages through `usePagedChannels` with Live's arguments and keys, so it lists channels in playlist order. The bundled SQLite 3.46 measured 22-63 ms against 2-4 ms for a deep page, and 112-224 ms against 0.02 ms for a middle or late group's first page, at 200k channels. |
| F2-2 | Every MPEG-TS start builds and boots a fresh mpegts.js worker before the stream request goes out (PB-3) | Low | Fixed | The patched mpegts.js builds the worker's blob URL once per page and keeps one booted spare. The wall prewarms one worker per opening tile. |
| F2-3 | Embedded mpv polls all session: 15 IPC calls a second in fullscreen, plus a 400 ms full layout measure | Low | Fixed | macOS runs no cursor poll, and Windows makes one IPC call per tick. The layout tick reads only the surface rect. Re-sending the subtitle style on every load stays, because it is documented behaviour. |
| F2-4 | Live tunes wait for the now/next subtitle and a second parental check | Low | Fixed | `play()` no longer waits for the title, and Recently watched keeps play order. A list click's row is remembered only once its stream is found, and only for catalog rows (cross-batch fix). Caching the parental check was skipped, because the gate asks the core on purpose. |

## TV guide UI

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| F3-1 | The Xtream guide downloads each empty row's whole archive table, keeps up to 2,000 per source, and also asks the short EPG | Medium | Fixed | Rows ask `catchup.programs` over whole UTC days. The guide keeps at most 200 answers per source and releases them on unmount. During a fling it shows up to 3 earlier answered ranges. A row whose answer already covers the next 6 h asks no short EPG. |
| F3-2 | While a chunk loads, every render rebuilds 40-500-ref key strings for every cached grid answer | Low | Fixed | The refs signature is computed once per array, cheap filters run first, and the scan runs only when a row asks for it. |
| F3-3 | Each vertical rest prefetches up to 7 extra slices, and all grid answers are kept 15 minutes | Low | Fixed | Prefetched slices are kept 5 minutes and displayed ones 15. The outer-slice prefetch now covers only chunks that hold at least a third of the rows on screen. |
| F3-4 | A vertical scroll re-renders the preview band, the toolbar, the closed Jump dialog and the Favorites view's probes | Medium | Fixed | The band is memoized with a stable handler, the toolbar gets a stable handler, the dialog uses the cached formatter, and the view's dependencies are now the query fields. |
| F3-5 | `chunkRefsSeen` is never pruned, and `programsCache` pins 2,000 rows | Low | Fixed | `chunkRefsSeen` resets per list and prunes past 64 chunks. `programsCache` holds 500 rows, pruned to those near the screen. |
| F3-6 | A typed channel number in the guide always waits the full 1 s | Low | Fixed | The guide asks for the highest channel number, so a complete number commits at once. |

## VOD, library and My List

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| F4-1 | Cold detail opens show a skeleton for the whole provider round trip (VD-8) | Medium | Fixed | An Xtream title shows its hero from its own catalog row. My List, Favorites, Recently watched and Stats start the detail fetch on click, with retries kept (`5fbf245`). |
| F4-2 | Search drops guide programme hits on every keystroke, so Top results remounts | Medium | Fixed | The last answered hits stay on screen, narrowed to the new query, while the next searches run. |
| F4-3 | "More like this" and "Known for" run 20-40 ranked `catalog.search` calls per page | Medium | Fixed | `catalog.matchTitles` makes one call per rail. In tests it picks the same title as the old lookup for 16 briefs. |
| F4-4 | Any My List change re-renders every mounted VOD poster card (VD-1) | Low | Fixed | The grid context is ref-stable, and the leaves read a small store per title. |
| F4-5 | My Videos makes one `catalog.item` call per channel, and the Recordings tab is not memoized | Low | Fixed | One `catalog.items` batch fetches the logos, and the rows are memoized. The rail stays uncapped and the tab unvirtualized, because both are product choices. |
| F4-6 | The detail pages' "More in" rail re-renders all 20 cards on every page render | Low | Fixed | The rail's input is built once, and `CatalogRail` is memoized. |
| F4-7 | VOD `useDownloads` refetches `downloads.list` a second time after every update (VD-3) | Low | Fixed | The hook only observes the list, and the shell's event binding refetches it. |

## Sources, Sports and channel edits UI

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| F5-1 | Sports: the guide window follows the league tab, so each switch re-reads the whole guide | Medium | Fixed | The window only grows for the picked day, and the live pass also starts over at Eastern midnight. Returning to a cached window still re-tokenizes, because TanStack's `combine` copies the programmes. |
| F5-2 | Sports: every tick, poll and keystroke re-renders every game card | Low | Fixed | Cards are memoized, one aligned minute clock replaces three, and each card gets the clock only while its action can change (`cardNow`). |
| F5-3 | Sports: any `sources.list` change rebuilds the channel index and re-matches every game | Low | Fixed | The index is keyed on each source's id, kind and name. |
| F5-4 | The hidden-channel rows and Unhide all make one `catalog.item` call per channel | Low | Fixed | They now use `catalog.items` batches of up to 500. Those lookups are not retried. |
| F5-5 | The guide and import progress feeds duplicate the core's change event, which undoes the status-only path for a 304 | Low | Fixed | The feeds leave refetching to the core's events. |

## Status of the 2026-10-19 items

The previous report's status table is left as it was written. These rows changed in this pass:

| Item | Then | Now |
| --- | --- | --- |
| DB-1 | Partial; no read pool | Fixed: read-only pool (R1-1 phase 2) and the remaining writers gated (R1-1 phase 1, R4-1). The EPG status writes stay ungated, because the EPG semaphore bounds them to 2. A few reads still use the write pool, among them `positions.watchedContains`, `sourcePins.get`, `channels.edits`, `catchup::source_kind` and the server's `files.rs`. |
| DB-2 | Partial; no index rebuild | Fixed (R1-4, R5-4) |
| DB-5 | Not done | Fixed (R1-5, R7-4) |
| EP-3 | Not done | Partial: stage 1 (R2-1) |
| EP-6 | Partial | zlib-rs on (R2-6), and server-mode image hits skip the source row (R6-5). Stable desktop image URLs are still not done (R6-1). |
| ST-2 | Partial | Fixed (R3-4); Stalker takes the slot after its totals too (R5-3) |
| ST-4 | Partial | Still partial. The second serialization went with R1-5, but URL sources' text can't be left out (R5-8). |
| IN-3 | Partial | Fixed (R3-1) |
| IN-7 | Not done | Fixed (R3-2) |
| IN-10 | Partial | Fixed (R3-7) |
| HO-6 | Fixed (SQLite only) | Server image at opt-level 3 (R7-1). The desktop is still unmeasured. |
| HO-9 | Not done | Still not done (R7-5) |
| PB-3 | Fixed: revoke on destroy | Replaced by F2-2. The blob URL is built once per page and never revoked, because later workers load from it. |
| SH-6 | Partial | Effectively done. The F1 and F4 reviewers found that every grid and rail hands `Poster` a width. |
| LV-6 | Partial; not virtualized | Done in code: `EditItemsDialog` passes `virtual` to `SortableList`, which uses `useListVirtualizer` |
| Read and write pools | Not done | Fixed (R1-1 phase 2) |

## Not done, and why

- R6-1, stable desktop image URLs. The per-launch token on the image listener is part of the desktop proxy's hardening model. A stable origin would make the image secret per-install and store it in the data directory. image-cache.md already records this as a decision for later. The verifier also found the saving smaller than reported: under about 1 ms per image, because a WebView2 disk-cache hit is not free and the image gate still queues browser-cached images.
- R7-3, macOS embedded mpv threading. Removing the main-thread hop from the render thread changes GL context handling, and a mistake shows up as a black, stretched or crashing view on resize or on a move between Retina and non-Retina screens. CI's macOS job runs no libmpv or GL render path, and no Mac was available.
- R7-5 and HO-9, reusing external mpv over IPC. This changes what users see: the window would stay open across zaps, and there would be no exited and started events per zap. Adding `--input-ipc-server` overrides a user's own setting in `mpv.conf`, and the embedded `loadfile` options would override their `mpvArgs`. The Windows-only `player_rpc` test would need a rewrite, and none of it can be tested here. The VLC reasons in players.md still apply.
- R5-8, a web backup export endpoint. A form-download endpoint would widen the server's surface for an action users rarely take: it would have to sit behind `api_guard` and stay unreachable through the desktop proxy without its token, and the form download gives the existing toast no success or error signal. R1-5 already removed the extra Value copy. What remains is the manifest escaped into a JSON string, and no option to leave out URL sources' text.
- R2-1 stage 2, integer feed ids. This needs a migration, a chunked copy, a one-row swap and contentless-delete FTS, which is L effort. Stage 1 removed the all-feed rebuild after each refresh. A prune still re-indexes every feed, but that is rare.
- F1-3 step 2, a build-only Vite plugin that stubs `@radix-ui/react-dialog` inside cmdk. It would remove about 40 kB of dead code from the palette and scope-picker chunks. The batch left it out by instruction: it stubs a dependency's internals, and since the palette now loads only on first open, those 40 kB are no longer on the boot path.
- R7-1 desktop opt-level. It needs release builds on the PC and a comparison against installer size ([Measuring on the PC](#measuring-on-the-pc)).
- The raw-value parts. R5-5's M part, hashing Stalker answers as raw text for the unchanged check with a `SYNC_VERSION` bump, was skipped by instruction. R3-2 (IN-7) leaves one gap on purpose: an object whose first key is serde_json's private `RawValue` token is read differently by the streaming decoder. Only a hostile body can send it.
- Smaller parts the batches left out:
  - R1-2(b), an `english_count` column. Add it only if `l2_query_perf` on target hardware shows English-only All pages matter.
  - F2-4(b), caching `parental.check`.
  - F1-2's react-i18next codemod.
  - F1-4's network-first `/assets`.
  - The single in-flight `window.setState`.
  - R6-4's adaptive interval and R6-6's atomic byte counter.
  - R5-1's split of the ribbon so now/next appears after one round trip. A ribbon still waits for its day tables, or for the 40 s deadline, on a first load.
  - Moving Stalker live rows to `extra_json`.
  - A capacity hint for the Xtream collect.
  - Streaming a list body straight to its staged file.
  - Overlapping Xtream list downloads.
- Known gaps left by the fixes:
  - Within 30 s of a click on a Favorites snapshot row, a favorites zap can still land on the dropped channel. LivePage copies the clicked row into an empty or errored `catalog.item` cache entry, and `favoriteChannel` reuses entries for 30 s.
  - `tuneChannel` still remembers its row before the gate, as it did at `88b94a3`, but its callers pass only catalog rows.
  - `useMyListToggle` still notifies on every fetch-state change, so the category grid page itself re-renders about 3 times per toggle. The cards no longer do.
  - Final-game Sports cards re-render once a minute.
  - Chunk merging still places shared lucide icons and small modules in unrelated chunks, worth 5-14 kB on Home, Settings and Sports.
  - The entry budget could drop to about 236,000 B, but that is a policy change.

## Behaviour changes

- RPC replies: object keys follow struct field order instead of alphabetical order. `epg.grid` and `epg.nowNext` return maps, so their keys come out in hash order and can differ between identical calls. Values are unchanged, and the UI reads by key.
- The fullscreen channel panel lists channels in playlist order, as Live does, instead of by number. On providers that number out of order, the number-guided locate can give up and focus the search field, as Live's list already does.
- Stalker sync progress no longer sends "Loading channel categories", "Loading radio" or "Loading movie and series categories".
- Xtream sync: an unreadable list fails after all downloads instead of between them, with the same outcome. A list that cannot be staged on disk fails the whole sync. A sync temporarily uses disk about the size of its changed lists in `data_dir/tmp`.
- The guide search index rebuilds once on the first start of this build, because its marker now carries the Unicode version.
- The image cache stores small kept originals twice, and both copies count against the cap. After clean shutdowns, orphan files can stay up to a week.
- After an OS crash or power cut, a split download can re-download up to 15 s more than before. Recording progress can trail by up to 256 KiB.
- The Stalker bulk guide can be up to 30 minutes old (it was 5), and it refreshes in the background.
- Every Xtream detail open whose provider detail is not cached sends one local `catalog.items` read, even when a grid already holds the row.
- Brotli replies are 1-3 % larger on varied rows and 10-20 % larger on repetitive ones.

## Review results

The 15 per-batch reviews raised 32 issues. Two batches, RB-B and RB-H, came back clean. Of the 32, 3 were bugs, 5 missed savings, 4 test gaps and 20 risks; 10 of the risks were docs the batch had not updated. Every issue was checked against the code. All held except one, which the frontend lane had already fixed (the grid's `to`, `69b31e5`). The code issues were fixed in their own commits, with tests that fail on the old code. The doc issues were fixed in the three docs commits.

The three bugs:

- F4-3 (`57ad134`) took away the detail placeholder for titles opened from "More like this" and "Known for". `cachedCatalogRow` now also reads the `catalog.matchTitles` answers (`87401b0`).
- R5-1's day-table cache stored reads that HTTP 429 or 5xx had cut short as if they were complete, so a catch-up click could miss its programme. Such reads now get a zero TTL (`ec7a415`).
- The dense guide e2e mocked only `catchup.table` after the guide had moved to `catchup.programs` (`c1179ab`). The spec was typechecked only, because Playwright, a built server and browsers were not available to the fix agent.

Other notable fixes:

- Pasted playlists are now hashed and written before the user-write gate (`79bafce`).
- A failed index upkeep step no longer fails the guide swap (`ddb1498`).
- The index marker now names the Unicode version (`e966ced`).
- A refreshed bulk guide lets the old one go (`1d23810`).
- The rail and palette got a navigate that ignores typed searches (`e9d2233`).
- Click-time detail prefetches keep their retries (`5fbf245`).
- Recently watched writes go out in order (`a34cd8e`).
- The Sports live window starts over at Eastern midnight (`41d9540`).
- No spare TS worker boots when mpv or VLC play everything (`3fd47a1`).
- Xtream failures are reported in content-type order (`3490b04`).
- An image reconcile owed after a crash stays owed until a pass finishes (`cb41a7d`).

The cross-batch review found two more:

- Bug, F2-4 (`df6a957`). `startItem` remembered every live list click before the parental gate and the stream lookup. A click on a Favorites or Recently watched snapshot row of a dropped channel therefore left a stand-in in `knownChannels`, and a favorites zap tuned the dead channel. Moving the call after `resolveSource` was not enough on its own, because an Xtream panel builds a live URL without the catalog. The row is now remembered after the lookup succeeds, and only when it has a number or a URL (`2c15cce`).
- Missed saving, R4-1 (`7c96f4e`). Only the first forced account check skipped the wait. A second forced check of the same source waited for the background save, which in turn waited for another source's import commit. Each save now records its status in a per-source in-memory map, and the source lock is released as soon as the status is recorded (`d247ad9`). The second check answers in 0.7 ms; before, it timed out at 5 s.

## Checked and fine

The reviewers also looked at these and found them efficient, or found that earlier fixes still hold:

- Database: every hot statement is a covering or index search on a 200k-channel scratch database, and no index is missing. DB-3 and DB-4 hold. Per-call dispatch overhead is negligible next to the queries. Read-only connections keep TEMP tables working.
- Guide core: staging, the in-place parser, the EP-2 memos and EP-5's index probe hold. The catch-up cache is single-flight. `live.alternates` is capped at 2,000 candidates.
- Ingest: IN-2, IN-5, IN-6, IN-8, IN-9 and ST-3 hold. English-only classification is a byte scan, and quality tagging costs about 25 ms per 50k rows.
- User state: the parental hide filter reads a cached config. Channel-edit overlays cost nothing for a source without edits. `lastRoute` is debounced, and TMDB is bounded and cached.
- Stalker and sources: ST-1 holds; the startup refresh plans by age and starts 30 s after boot. `sources.list` is one statement, and the session token is cached in memory.
- Downloads, recording and images: EP-1 and EP-4 hold. The rate limiter, progress events and buffers cost nothing measurable.
- Hosts: HO-1 to HO-5, HO-7 and HO-8 hold. The media proxy passes chunks by refcount. Logging stays at info with a non-blocking appender.
- Shell: a cold Home requests one 48 kB font file. Boot RPCs are not duplicated. Idle is clean: 1 render in 10 s on Live. SH-1 to SH-11 hold. About 300 B of the CSS is unused.
- Player: PB-1 to PB-7 hold. No listener leaks across zaps, and the player's caches are bounded.
- Guide UI: the page renders once per row crossed, and the row and chunk memos hold. The 30 s clock skips rows that don't change. LV-1 to LV-8 hold.
- VOD and library: VD-1 to VD-9 hold. Episode lists, category indexes and card grids are virtualized.
- Sports, settings and onboarding: Sports reads go through a 5-slot limiter, and ESPN polling pauses while the window is hidden. Settings mounts only the open section. The tour and What's new are lazy.

## Pre-existing test failures

The baseline run on the untouched tree at `88b94a3` had 6 vitest failures (5,872 passed, 10 skipped). All 132 Rust test binaries passed. The 6 vitest failures:

- `src/features/library/test/lib.test.ts` "formats bytes, durations and clocks", and the two F11 runtime tests in `src/features/vod/test/fix4.test.tsx` and `pages.test.tsx`. Node 22 lacks `Intl.DurationFormat`, and the repo requires Node 24.
- `src/features/live/guide/test/favoritesGrid.test.tsx` "asks complete favorite chunks for the visible slice and adjacent time slices".
- `src/features/live/guide/test/guidePrefetch.test.tsx` "a return to the guide gets its channels and first grid chunk…". It failed in the baseline and passed in later runs.
- `src/features/live/test/guideFallback.test.tsx` "offers a past archive programme download…". It times out at 10 s under full-suite load and passes alone.

Also on the untouched tree, `cargo clippy -D warnings` failed on Linux because of three unused variables in `player/embedded.rs`. This was fixed in `3c0827b`.

Flakes that showed up during the pass but that the pass did not cause:

- `crates/iptv-core/tests/stalker_paging.rs` `unchanged_answers_keep_the_catalog` sometimes fails under parallel load with "no such table: items" on a write-pool delete. With the read pool switched off, as the code stood before RB-E, it failed 2 times in 36 runs. A likely cause: `Env` declares `_tmp` before `state`, so the temporary directory is deleted before the `AppState` and its connections are dropped.
- `src/features/library/test/pages.test.tsx` "RecentPage … past the 20 newest saved spots" can miss its 1 s wait under full-suite load.
- `gridPerf.test.tsx` "updates only airing markers on a clock tick" failed once under load and passed alone.

## Measuring on the PC

Run the existing release perf tests first. Most numbers in this report come from debug builds, Python or estimates:

```
cargo test -p iptv-core --release --test m3u_perf
cargo test -p iptv-core --release --test epg_perf
cargo test -p iptv-core --release --test epg_reingest_rss -- --nocapture
cargo test -p iptv-core --release --test catalog_perf
cargo test -p iptv-core --release --test l2_query_perf
cargo test -p iptv-core --release --test l3_search_perf
cargo test -p iptv-core --release --test downloads_perf
cargo test -p iptv-core --release --test migration_perf -- --include-ignored
```

Then, in order of value:

1. Desktop opt-level (R7-1, HO-6). Build the desktop at a global `opt-level = 3`, then at 2, and compare both with "s". For each build, run the perf tests above, a 50-poster TMDB resize at `w=192` and 384, and a `dispatch_raw` micro-bench (`catalog.channels` with 120 rows, `epg.grid` with 40 channels). Record the sizes of `iptv-tauri.exe` and the NSIS installer. Under fat LTO only a global level reliably helps. Try per-crate overrides only if a global 3 is rejected on size.
2. The guide swap threshold (R2-1). `SwapUpkeep` picks per-feed upkeep when the other feeds hold more than old + new/2 programmes. That rule rests on a debug build with SQLite at -O1. Time a refresh of 1, 3 and 5 feeds of 200k programmes in release, preferably on an N100.
3. The write pool after the read pool (R1-1). Before shrinking the write pool or its 32 MiB cache, check `m3u_perf`, `catalog_perf` and `l3_search_perf` show no regression.
4. Xtream decode and memory (R3-1, R3-2). No Xtream perf test exists. A test based on `xtream_stub` at 50k channels, 180k movies and 20k series would pin decode time (486 ms before and 168 ms after, from the reviewer's bench) and peak RSS end to end.
5. Large removals and refreshes (R1-4, R5-4). Re-time `begin` and `store::delete` at 250k rows beside 40k in release. The figures above are dev-profile.
6. English-only pages (R1-2(b)). `l2_query_perf` with English-only on All movies and `catalog.categories` decides whether a stored count is worth adding.
7. The Docker image. Build it once with the `release-server` profile (it was only checked by a dry run), and confirm in CI that the Tauri `rpc` signature change compiles on Windows and macOS.
8. In the app, on Windows:
   - Time an MPEG-TS zap in WebView2 to confirm the spare-worker gain (F2-2).
   - On a cold Home with every player set to mpv or VLC, check that no hls.js or mpegts.js chunk loads (F1-5).
   - Drag the fullscreen channel panel over a 200k-channel source and count requests (F2-1).
   - Run the two archive journeys in `e2e/guide-scroll-performance.spec.ts` with Playwright and a built `iptv-server`.

The frontend checks run anywhere. Use Node 24 so the `Intl.DurationFormat` tests pass:

```
pnpm build && pnpm size:check
pnpm test
```

## Final checks

Filled in after the full suites run.
