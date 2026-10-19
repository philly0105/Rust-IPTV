# Performance audit

Tsrust IPTV, master at `0c0ef59`. That commit is the 2026-10-16 nuts-polish-features work, which was fast-forwarded onto master on 2026-10-19, the day of this audit.

## Summary

The app has been through several measured performance passes, and it shows. Catalog pages are index-only scans, search runs a ranked top-N pass, M3U and XMLTV imports stream to disk, the entry chunk sits at half its budget, and most lists are virtualized with stable selectors. On a fast machine the common flow of opening the app, browsing a list and playing a channel has no broken hot path.

What's left falls into six groups.

1. Playback engines. hls.js transmuxes on the main thread because its ESM build ignores `enableWorker` unless `workerPath` is set. mpegts.js leaks a worker blob on every start. Extensionless live URLs try native `<video>` first on every zap. Every user of the built-in player hits these, and two of the three fixes are a few lines each.
2. The desktop host. Playing a local recording in the built-in player most likely reads the whole file into memory before the first byte plays. Every focus loss drops WebView2 to Low memory and trims the working set, even while video is playing in picture-in-picture or on a second monitor.
3. Work at launch. Every auto-refresh source is fully re-imported 3 s after every launch, although the setting's hint says this happens only when the list is more than a day old. Three reviewers found this on their own.
4. SQLite contention during long writes. An import holds the write lock for seconds to tens of seconds. User writes that skip the `db_write` gate, and several background writers, each park a pooled connection while they wait, so a busy launch can drain the 8-connection pool and make reads fail after 15 s.
5. Large lists. Dragging the scrollbar on a 200k-channel list fires hundreds of page requests that the desktop can't cancel, the guide gives up looking for a search hit past row 60,000, and 12 virtualizers still render inside scroll events.
6. Xtream and Stalker ingest. A Stalker channel import clones its whole JSON tree, Xtream list requests get 15 s to send headers and are then retried, and an Xtream sync holds 250-300 MB of rows at 170k items.

Only two fixes are structural: keying guide programmes by an integer feed id (EP-3) and, optionally, a separate read pool (DB-1). The rest are local changes.

## Method

Nine reviewers each took one slice of the code: database and catalog, ingest, sources/backup/TMDB, EPG/images/recording, desktop and server hosts, frontend shell, live TV and guide, player and multi-view, and VOD/library/settings. Each one read docs/architecture/performance.md and its area's docs first, so measured decisions weren't re-reported. I checked every High finding against the code myself, plus several Medium ones; the tables mark those "Verified". Two reviewers disagreed about import progress throttling, and the code settled it (IN-8).

Rust isn't installed on gmk1, and heavy Rust builds belong on the PC, so no Rust benchmark ran for this audit. Each finding says how to measure it. The frontend was built and tested on gmk1.

## Measurements on gmk1 (Intel N150)

| Check | Result |
| --- | --- |
| `pnpm typecheck` (tsc-rs) | Passes in 1.6 s |
| `pnpm build` (Vite 7) | 12.3 s build, 19.6 s wall, 1.5 GB peak RSS |
| `pnpm size:check` | Entry 141,525 B of the 268,000 B budget. 121 JS chunks, 7.8 MB in all |
| JS loaded before the first render | 902 kB minified: vendor-react 316 kB (react-dom 645 kB and react-router 227 kB before minification), locale-en 187 kB, entry 137 kB, vendor-ui 126 kB, vendor-query 67 kB, vendor-i18n 50 kB, vendor-tauri 20 kB |
| CSS before the first render | One 147.5 kB file |
| Home route, beyond the boot chunks | 216.6 kB, of which 96.8 kB is player code (SH-2) |
| Player engines | hls.js 593 kB, shaka 775 kB, mpegts.js 277 kB, each loaded only when needed |
| `pnpm test` (vitest) | 288 files and 3,864 tests pass in 405 s |

Three things in the bundle that aren't findings elsewhere:

- `vendor-ui` holds all 160 lucide icons the app uses anywhere (95 kB before minification) plus cmdk, and `index.html` preloads it on every boot. cmdk is used only by the lazy command palette, and most of the icons only by lazy pages (SH-10).
- react-router 7.18's exports map always resolves to `dist/development`, so the shipped bundle runs with `ENABLE_DEV_WARNINGS = true`. That flag is the only difference from `dist/production`. A `resolve.alias` to the production file removes it. Low impact.
- The web build's service worker caches every hashed asset in one fixed cache, `tsrust-iptv-v1`, and never deletes old entries, so each deploy's chunks pile up in the browser (SH-11).

## Fix order

Ranked by impact over effort. Effort: S is under an hour, M a few hours, L a day or more.

| # | ID | Fix | Severity | Effort |
| --- | --- | --- | --- | --- |
| 1 | PB-1 | Give hls.js a `workerPath` so transmuxing leaves the main thread | High | S |
| 2 | ST-1 | Make the startup refresh respect `next_due` or 24 h, as the hint promises | High | S |
| 3 | PB-3 | Patch mpegts.js to revoke its worker blob URL | High | S |
| 4 | HO-2 | Trim WebView2 memory on minimize only, not on every focus loss | High | S |
| 5 | DB-1 | Route every user write through `db_write`; stop awaiting best-effort cache writes | High | S, then M for a read pool |
| 6 | IN-1 | Drop the Stalker JSON clone and parse off the runtime worker | High | S |
| 7 | IN-2 | Give Xtream list heads a long deadline and stop retrying spent budgets | High | S |
| 8 | LV-2 | Reveal guide search hits with `paged.locate` instead of the 60k scan | High | S |
| 9 | HO-1 | Serve local recordings and downloads through the loopback proxy's `ServeFile` | High | M |
| 10 | PB-2 | Start extensionless live streams with mpegts.js, remember hosts, cover the wall | High | M |
| 11 | LV-1, VD-2 | Settle page queries while a list or grid is dragged; cancel far prefetches | High | M |
| 12 | SH-5, VD-1 | One shared virtualizer hook with `useFlushSync: false` and memoized search cells | High | S-M |
| 13 | EP-1 | Record plain TS over HTTP copy; stop mpv decoding when it records | Medium | S |
| 14 | HO-3, HO-5 | Put mpv's rewind buffer on disk or cap it; keep the user's `--hwdec` | Medium | S |
| 15 | DB-2, HO-4 | Take `long_write()` for source removal and bound the exit checkpoint | Medium | S, then M |
| 16 | PB-4 | Move position-driven UI into leaf components; skip updates while controls are hidden | Medium | M |
| 17 | EP-2 | Memoize guide name resolution; stop the refetch at refresh start | Medium | S |
| 18 | VD-3, VD-4, VD-5, VD-7 | Narrow the progress- and clock-driven re-renders on detail, downloads, sources and scheduled pages | Medium | S each |

## Playback (built-in player and multi-view)

| ID | Finding | Severity | Confidence | Effort |
| --- | --- | --- | --- | --- |
| PB-1 | hls.js transmuxes every segment on the main thread | High | Verified | S |
| PB-2 | Extensionless live URLs try native `<video>` first on every zap and every tile | High | Verified path, cost Likely | M |
| PB-3 | mpegts.js leaks a worker blob of about 205 KB on every player start | High | Verified | S |
| PB-4 | The control bar re-renders 4-7 times a second for the whole session, even hidden | Medium | Confirmed | M |
| PB-5 | Multi-view tiles use the main player's buffer and ABR settings | Medium | Confirmed | S |
| PB-6 | Each zap restarts hls.js's bandwidth estimate at 500 kbps | Low | Confirmed | S |
| PB-7 | Shaka's async teardown can blank the next engine's element | Low | Likely | S |

### PB-1. hls.js transmuxes on the main thread

`engines.ts:386` imports `'hls.js'`, whose `import` export is `dist/hls.mjs`. In that build a worker exists only when `config.workerPath` is set or the UMD-only `__HLS_WORKER_BUNDLE__` is defined (`hls.mjs:12716` and `18645`). The app sets `enableWorker: true` at `engines.ts:398` but no `workerPath`, so hls.js falls back to `new Transmuxer(...)` inline. Every HLS fragment is demuxed from TS and remuxed to fMP4 in one synchronous task on the UI thread. That is an estimated 10-40 ms per HD fragment on a laptop and 2-3x that on an N100, every 2-6 s per stream, four times over on an HLS wall. These tasks compete with zap keys and guide scrolling.

The fix is `import hlsWorkerUrl from 'hls.js/dist/hls.worker.js?url'` and `workerPath: hlsWorkerUrl`. Both CSPs already allow `worker-src 'self'`. To confirm, record 30 s of an HD HLS channel in the Edge Performance panel: `TSDemuxer` and `MP4Remuxer` frames should move from the main thread to a worker track.

### PB-2. Native `<video>` goes first for extensionless live URLs

`createEngine` (`engines.ts:1001-1006`) sends any direct source to the native element unless `forceMpegts` is set or the URL looks like TS. `InlinePlayer.tsx:123` remembers one sniffed media key per player. Chromium can't demux MPEG-TS from `<video src>`, so each zap onto an extensionless M3U or Stalker channel downloads until FFmpeg's probe gives up, about 1 MiB, then errors, then opens a second connection for mpegts.js. That adds roughly 0.3-1 s on HD channels and 2-5 s on SD channels without a connect burst, and it uses two connections on accounts limited to one. Below about 0.8 Mbps the 10 s watchdog fires before the element errors, so the sniff memory is never set and the stream may never reach mpegts.js. On the wall, `useTilePlayback.ts:205-223` adds a third request to fetch the failure reason.

The perf-audit branch had a session set of `sourceId|host` (`tsLiveOrigins`). Master doesn't have it, and it wouldn't cover the wall or the low-bitrate case. The better fix starts live, non-radio, extensionless sources with mpegts.js, which rejects non-TS data after the first chunk, then falls back to native once. Persist the result per `sourceId|host` and share it with the wall. To measure, add an extensionless variant of the mock's `/live/timed.ts` and time zap-to-playing and requests per zap in Playwright.

### PB-3. mpegts.js leaks its worker blob

mpegts.js 1.8.2 builds its transmuxing worker with webworkify: `URL.createObjectURL(blob)` stored as `worker.objectURL` (`src/utils/webworkify-webpack.js:213-215`). The transmuxer's destroy path only calls `terminate()` (`src/core/transmuxer.js:276-281`), and nothing revokes the URL. `engines.ts:805` enables the worker and `:844` creates a player on every start, restart and wall tile. Each start keeps about 205 KB alive until the document unloads, and the desktop document lives all session: 300 tunes in an evening hold about 60 MB. The fix is a `pnpm patch` that revokes `this._worker.objectURL` on `destroyed`, reported upstream. A Playwright init script that wraps `createObjectURL` and `revokeObjectURL` can count leaked blobs over 50 zaps.

### PB-4. The control bar renders all session

`Controls.tsx:774` subscribes the whole bar to `positionSeconds`, and `:781-783` to `buffered`, `seekable` and `tracks`. `InlinePlayer.tsx` reports position on `timeupdate` and again on `progress`, and `reportProgress` (`store.ts:719-725`) always calls `setState`. Controls stays mounted while hidden (`PlayerSurface.tsx:853`), and none of its children are memoized. Hours of fullscreen TV with hidden chrome re-render about 30 components 7 times a second, an estimated 20 ms of main-thread work per second on an N100. With embedded mpv, `MpvSurface.tsx:349-359` publishes a new `tracks` object on every `mpv.state` event and builds a new `Intl.DisplayNames` per track each time. The fix moves the time readout, seek bar and live-edge readout into leaf components with their own subscriptions, skips subscribing while hidden, and returns early from `reportProgress` when nothing changed.

### PB-5. Wall tiles buffer like the main player

`useTilePlayback.ts:239-250` passes no tile profile, so tiles keep the main player's 30-60 s mpegts.js back buffer, hls.js `backBufferLength: 30` and `capLevelToPlayerSize: false`. Tiles can't seek, so that buffer is never used: 75-150 MB across a four-tile wall at 5 Mbps, and HLS tiles fetch the top rendition at 640x360. A tile profile with 10/5 s cleanup, `backBufferLength: 5`, `maxBufferLength: 10` and `capLevelToPlayerSize: true` fixes it.

### Low items

- PB-6. Every zap creates a new `Hls` with the default 500 kbps estimate (`engines.ts:397-418`), so multi-rendition streams start blurry. Carry `hls.bandwidthEstimate` into the next instance's `abrEwmaDefaultEstimate`.
- PB-7. `engines.ts:713-716` calls `void player.destroy()`, and shaka later clears `src` on the element. If its pending operations outlast one frame, the next engine on that element goes dead until the watchdog reconnects. Await the teardown, capped at about 300 ms.

## Startup, refresh and imports

| ID | Finding | Severity | Confidence | Effort |
| --- | --- | --- | --- | --- |
| ST-1 | The startup pass re-imports every auto-refresh source on every launch | High | Verified | S |
| ST-2 | Nothing limits imports across sources, and a manual refresh repeats a running import | Medium | Confirmed | M |
| ST-3 | Stalker refreshes always rewrite the catalog; M3U sends no conditional requests | Medium | Confirmed | M |
| ST-4 | Backup export holds each playlist's text about three times | Medium | Confirmed | M |
| ST-5 | Some refetch rounds ignore the "unchanged" signal | Low | Confirmed | S |

### ST-1. Every launch re-imports every auto-refresh source

`sources::init` (`crates/iptv-core/src/sources/mod.rs:1680-1699`) sleeps 3 s and calls `refresh_all`, which runs `run_import` on every `auto_refresh` source with no age check (`:1645-1663`). The hint in `src/i18n/en/sources.json:30` says "Reloads the channel list on startup when it is more than a day old." The scheduler already has the age logic in `schedule.rs:125-147`, and the EPG boot pass does check age (12 h).

Each launch downloads every Xtream list body and every M3U playlist in full before the "unchanged" check. Large panels add VOD daily, so the importer usually rewrites at least one content type inside a write transaction, then sends `sources.changed`, which refetches 11 query prefixes. On desktop the 3 s timer starts while WebView2 is still loading, so on a slow machine the import overlaps the first screen's queries, and user writes wait for its commit. On a 20 Mbit/s link the downloads also compete with the first stream for 10-30 s. Three reviewers found this independently. The existing test `sources_crud.rs:256-271` asserts the redundant fetch.

The fix runs the startup pass through `schedule::tick`, planning against 24 h when the interval is 0, and starts it about 30 s after boot or at the first idle.

### ST-2. Imports overlap

`run_import` waits on a per-source lock (`sources/mod.rs:1150-1153`), but nothing limits imports across sources, unlike EPG ingest (`epg/ingest.rs:332-337`). Refresh all calls `sources.refresh` for every source, busy or not, and a refresh of a source that is already importing runs a second full import after the first. Two concurrent 200k syncs roughly double peak memory, about 100-150 MB of rows each. The fix makes a refresh of a busy source wait for the running import's result, adds a process-wide semaphore around decode and save, and makes Refresh all skip busy sources.

### ST-3. Refreshes that could be skipped

Stalker never reports "unchanged" (`stalker/sync.rs:352`), so each Stalker refresh rewrites live and radio, including the index rebuild above 20k rows. `fetch_to_file` sends no `If-None-Match` or `If-Modified-Since` for M3U URLs. Hash the Stalker answers as Xtream's `kind_hash` does, and store ETag and Last-Modified for playlists.

### ST-4. Backup export copies playlist text

`backup/export.rs:259-273` reads each whole playlist, `json!(raw)` copies it into a Value tree, and `to_string_pretty` runs on the async task. Without a path, as in the browser, the RPC layer serializes it again. One 80 MB playlist peaks around 250 MB, and the result can exceed the 50 MB the import screen accepts (`src/features/settings/lib/backup.ts:51`). Write the file with `serde_json::to_writer` inside `spawn_blocking`, and offer to leave out the text of URL sources, which the importer refetches anyway.

### ST-5. Unchanged imports still refetch

`SourcesPage.tsx:195-196` invalidates `catalog.` after every manual refresh, even when the core reported no change. Backup background loads send `done` without `unchanged` and then `sources.changed`. An auto-refresh toggle sends the `config` reason and refetches 11 prefixes. Drop the explicit invalidate and use the `status` reason for patches that don't touch the catalog.

## Database

| ID | Finding | Severity | Confidence | Effort |
| --- | --- | --- | --- | --- |
| DB-1 | Writes outside the `db_write` gate park pooled connections during long saves | High | Likely; call sites verified | S, M for a read pool |
| DB-2 | Removing a large source deletes row by row through triggers, without the long-write mark | Medium | Likely | S, then M |
| DB-3 | Page SQL formats LIMIT and OFFSET into the text, and the statement cache stays at 16 | Low | Verified | S |
| DB-4 | r2d2 recycles connections, so their 32 MiB page caches go cold | Low | Verified | S |
| DB-5 | Every RPC reply is built as a `serde_json::Value`, then serialized again | Low | Confirmed | M |
| DB-6 | Upgrading from schema 17 or older builds five `items` indexes twice | Low | Confirmed | S |

### DB-1. The pool drains while an import saves

The pool has 8 connections and a 15 s checkout timeout (`db/mod.rs:28`, `387-392`). While an import holds the write lock, a waiting writer retries for up to 600 s (`LONG_BUSY_TIMEOUT`, `db/mod.rs:37`). `AppState::db_write` (`state.rs:207-218`) lets only one user write wait on a connection at a time, but it is opt-in. These writers skip it and each hold a connection for the rest of the save:

- `stats.record`, `userstate.setWatched`, favorites reorder and remove, recent remove and clear, positions remove, all `watchlist.*` and `lists.*` writes, `channels.*` edits and category hiding
- `stalker.movies` and `stalker.series`, which await an ungated write per page (`stalker/mod.rs:279-283`)
- TMDB lookups, which await their cache write before returning (`tmdb/cache.rs:346-355`), so cast and trailer stay pending until the save commits
- background writers: each EPG refresh, the image index writer, each download's progress write every 2 s and each recording's byte save every 10 s

Two reviewers counted the same scenario: a launch with a changed large catalog, two guide ingests, two queued downloads and a Stalker VOD grid open. That leaves one connection or none for reads, so catalog pages, now/next and image lookups wait 15 s and fail. Separately, `favorites_reorder` opens a DEFERRED transaction and reads before it writes (`userstate/mod.rs:374-410`), so it fails with SQLITE_BUSY when another write commits in between.

The S fix routes every user write through `db_write`, stops awaiting the TMDB and Stalker cache writes in read RPCs, and opens `favorites_reorder` as IMMEDIATE. The download loop should also stop awaiting its progress write. The M fix gives reads their own pool: WAL readers never wait on the write lock, so waiting writers can't starve them. `l2_import_pool.rs` covers only `db_write`; extend it to hold the lock with `long_write()` and send the ungated commands.

### DB-2. Source removal holds the write lock without saying so

`store::delete` (`sources/store.rs:364-383`) deletes the source row in one IMMEDIATE transaction, and `items` cascades. No `fts_suspend` row exists, so each deleted item fires the FTS and `items_rank` triggers and updates about a dozen indexes. At 200k items that is an estimated 10-30 s of held write lock on a desktop. `sources::remove` doesn't take `db::long_write()`, so every other writer gives up after the 5 s `BUSY_TIMEOUT`: position saves, favorites, `lastRoute` and stats flushes fail with "database is locked". `removeAll`, backup Replace and the English-only backfill take the same path. Two reviewers found it. The first fix is to take `long_write()`, which turns failures into waits. The second is to delete like `CatalogWriter::begin`: suspend the triggers, delete FTS and rank rows in bulk, rebuild indexes when the source is most of the table, then checkpoint.

### DB-3. OFFSET defeats the statement cache

This one is left over from the perf-audit branch. `query_named` formats `LIMIT {limit} OFFSET {offset}` into SQL that goes to `prepare_cached` (`catalog/mod.rs:1462-1466`), so each new page compiles a new statement and evicts one still in use. Nothing calls `set_prepared_statement_cache_capacity`, so each connection keeps rusqlite's 16 slots, while one Live scroll step alone uses 10-14 statements and moving between Live, VOD and Home cycles 40-60. Bind OFFSET as a parameter and keep LIMIT literal, since SQLite uses a literal LIMIT in its row estimate, then raise the capacity to 64. The perf-audit branch bound both and raised it to 128; binding LIMIT risks plan changes.

### Low items

- DB-4. The pool builder sets no `idle_timeout` or `max_lifetime`, so r2d2 closes idle connections after 10 minutes and replaces every connection after 30. Each new connection starts with a cold 32 MiB page cache and no prepared statements, which costs an estimated 10-40 ms on the first browse after a film. Set both to `None`.
- DB-5. `rpc/mod.rs:79` turns every result into a `Value`, which both hosts serialize again. A 20k-row `allLiveChannels` reply pays an estimated 30-60 ms for that. Serialize once into `Box<RawValue>`.
- DB-6. Migration 0018 creates five `items` indexes that 0019 drops and rebuilds (`0019_guide_search_speed.sql:29-38`). An upgrade from a pre-Loop-2 build with 200k items wastes an estimated 3-10 s at boot. Delete the superseded `CREATE INDEX` lines from 0018.

## Ingest (M3U, Xtream, Stalker)

| ID | Finding | Severity | Confidence | Effort |
| --- | --- | --- | --- | --- |
| IN-1 | A Stalker channel import clones its whole JSON tree on a runtime worker | High | Verified | S, M for typed parsing |
| IN-2 | Xtream list requests get 15 s for headers and retry the timeout; Stalker large calls cap the whole body at 90 s | High | Verified path, frequency Likely | S |
| IN-3 | Xtream holds wide rows with JSON extras until its single write | Medium | Likely | M |
| IN-4 | Stalker fetches pages one at a time even when the total is known | Medium | Confirmed | S-M |
| IN-5 | An M3U refresh with any saved user state builds maps over every old and new row | Medium | Likely | M |
| IN-6 | Gzip playlists up to 8 MB on disk are decompressed whole just to measure them | Medium | Confirmed | S |
| IN-7 | Xtream list decoding builds a `Value` per element, then again per field | Medium | Likely | M |
| IN-8 | Parse progress is emitted every 2,000 rows with no time limit | Low | Verified | S |
| IN-9 | Below the bulk threshold, the writer counts every `items` row after each 1,000 inserts | Low | Confirmed | S |
| IN-10 | Allocation churn per M3U entry, and an fsync of the temp file | Low | Confirmed | S |

### IN-1. Stalker channel import

`stalker/sync.rs:144` reads `Ok(js) if !into_list(js.clone()).is_empty() => into_list(js)`, which deep-copies the whole channel list to test whether it is empty. `into_list`'s own doc comment says it exists to avoid cloning large arrays. The answer was already parsed into a `serde_json::Value` tree inside the async call (`protocol.rs:423`), mapping runs on the same task, and the tree stays alive through the catalog write. A Ministra channel has 40-50 keys, so a 20k-channel portal (about 30 MB of JSON) builds an estimated 150-200 MB tree, and the clone doubles the peak. Parsing, cloning and mapping keep one tokio worker busy for an estimated 1-2 s on an N100. `playback.rs:448` clones the bulk EPG answer the same way. The S fix is `let list = into_list(js); if list.is_empty() {...}`, plus dropping the trees after mapping and taking `data` by value. The M fix decodes a lenient typed struct on `spawn_blocking`.

### IN-2. Large Xtream panels can fail to sync

List actions go through `send_checked` with `HEADER_TIMEOUT` = 15 s (`http.rs:70`, `xtream/client.rs:215-217`), and the timeout is wrapped in `Failed::retry`, so `fetch` tries twice more (`client.rs:131-146`). Panels often build `get_vod_streams` and `get_series` in full before sending the response head, as they do for `get.php`. Past 15 s each attempt is cut off and restarted, the panel does the work three times, and the sync fails after about 46 s with nothing written. M3U already got 120 s for exactly this reason (`m3u/importer.rs:879-884`). Stalker's `get_all_channels` has a 90 s deadline on the whole request including the body, retried three times. I can't say how many panels need more than 15 s, but the failure mode is total. Reuse the 120 s head deadline for lists, keep `MinRate` on the body, and don't retry a spent budget.

### Medium items

- IN-3. `xtream/sync.rs:606-643` holds every mapped `ItemRow` with a `Value::Object` extra and a per-row `source_id` clone the writer ignores. At 50k live, 100k movies and 20k series that is an estimated 250-300 MB at the write. The `title_base` regexes and the JSON serialization of `extra` then run inside the IMMEDIATE transaction. Precompute both in the mapping step, which already runs on the blocking pool.
- IN-4. `fetch_all_pages` (`stalker/sync.rs:47-64`) and `vod_pages` (`vod.rs:420-437`) walk 14-item pages one at a time, and `list_page` fetches the first page alone before the rest. A 300-station radio list takes 22 sequential requests, the channel fallback stops silently at 5,600 channels (`MAX_PAGES = 400`), and every 42-item VOD grid page costs two round-trip waves. Once page 1 returns the total, fetch the rest with `buffered`, and derive the cap from the total.
- IN-5. `m3u/remap.rs:72-162` reads every old row into two maps when any of 13 user tables references the source, then records every new row, all inside the write transaction. That is about 120 MB at 200k entries. Only the referenced ids matter, so key the maps on those.
- IN-6. `m3u/importer.rs:741-753` decompresses any gzip file up to 8 MB on disk in full to decide whether to store its text, and a 7 MB `.m3u.gz` is a 70-100 MB playlist. `ParseStats.bytes` already holds the decoded size, so check it first.
- IN-7. `xtream/raw.rs:144-166` deserializes each element into a `Value` and then into the struct, about 90 allocations per VOD entry, roughly 3x slower than direct decoding. Write the lenient helpers as serde visitors.

### Low items

- IN-8. `m3u/importer.rs:685-688` and `xtream/sync.rs` emit `import.progress` every 2,000 rows with no time throttle. `sources::progress` doesn't throttle either. Only the download phase has the 250 ms gate (`importer.rs:961-967`). At M3U parse speed that is dozens of events a second, and each one re-renders every source card (VD-5). Reuse the 250 ms gate.
- IN-9. `catalog/mod.rs:537-556` runs `SELECT count(*) FROM items` every 1,000 inserts once 20k rows are touched, for rewrites that never go bulk. Count once in `begin`.
- IN-10. Two Strings per directive line, double allocation per attribute, SHA-256 per group name, a BTreeMap per `extra`, and an fsync of the 100 MB temp file. Together about 10 % of import time.

## Guide, images, recording and downloads

| ID | Finding | Severity | Confidence | Effort |
| --- | --- | --- | --- | --- |
| EP-1 | Recordings decode the video in software for their whole length | Medium, High on N100 | Verified | S |
| EP-2 | now/next and grid re-resolve every ref with an O(guide channels) fuzzy scan; a refresh triggers two refetch rounds | Medium | Likely | S |
| EP-3 | Each guide refresh rewrites the feed twice and re-indexes every feed in long write transactions | Medium | Confirmed mechanism | L, M for the index part |
| EP-4 | Poster variants decode at full size and resample without SIMD, with no concurrency cap | Medium | Likely | M |
| EP-5 | `FEED_SQL` reads every programme in a 36 h lookback | Low | Confirmed | S |
| EP-6 | Smaller costs in downloads, the image cache and gunzip | Low | Confirmed | S each |

### EP-1. The recorder decodes video it throws away

`recording/engine.rs:116-118` picks mpv whenever it is found, before checking `is_plain_http` or the Xtream TS variant, and runs it with `--vo=null --ao=null --hwdec=no` (`:186-188`). `--vo=null` discards frames after decoding, and `--hwdec=no` forces the CPU decoder, while `--stream-record` only needs demuxed packets. A 1080p50 H.264 recording costs an estimated 25-35 % of an N100 core for hours, double that for HEVC, usually while the user watches another channel. Prefer the HTTP copy engine for plain TS and Xtream live, keep mpv for HLS and DASH, and test `--vd-lavc-skipframe=all` for the mpv path. Check outputs with ffprobe.

### EP-2. Guide resolution repeats work on every call

`epg/mod.rs:94-106` resolves each ref on every now/next and grid call: manual mapping, the item row, `has_programmes` and the shift, each through an unprepared `query_row`. Refs without an id match go to `find_name` (`resolve.rs:227-274`), which runs `normalized_levenshtein` against every guide channel. Keys of 4-8 characters can never reach the 0.9 score, yet they still scan everything. A 120-ref page that is half unmatched costs an estimated 150 ms on an N100 on every refetch. Separately, `epg.changed` goes out when a refresh starts (`ingest.rs:424`) and again after a 304, and `query.ts:215` refetches every `epg.` query on it. Memoize `find_name` per directory, return early for short keys, use `prepare_cached`, single-flight the directory build, and send a status-only event at refresh start.

### EP-3. Guide refreshes rewrite too much

Programmes are keyed by the guide URL text (migration 0007). `commit_staging` (`epg/store.rs:358-390`) deletes every old row and then rewrites every staged row's `epg_url` in one IMMEDIATE transaction, and `refresh_index` (`search.rs:127-170`) rebuilds the search index for all feeds. The reviewer measured the swap on gmk1 with Python's sqlite3 at 115k rows: 0.85 s, as long as the whole staging insert, all of it holding the lock. With several feeds every refresh re-indexes all of them, and the URL is stored twice per programme, about 45 MB per 288k programmes. Key programmes by an integer feed id, swap by repointing the URL, and keep the search index per feed.

### EP-4. Poster resizing

`imagecache/resize.rs:120-127` decodes at full resolution and resizes with `CatmullRom` through the image crate's scalar code, and `spawn_blocking` runs with no limit; cancelled requests keep resizing. performance.md measured 21-35 ms per poster on first view; a 2000x3000 TMDB original costs roughly 10x that. Shrink with `imageops::thumbnail` to about twice the target before Catmull-Rom, or use `fast_image_resize`, decode JPEG at reduced scale, and cap resizes at cores minus one.

### Low items

- EP-5. `query.rs:99-102, 152-165` reads every programme in a 36-hour lookback per channel. 120-ref now/next measured 8.6 ms with it and 4.7 ms without.
- EP-6. `downloads.list` and `myvideos.list` stat every completed file on a tokio worker (`downloads/mod.rs:69-84`), which blocks on a sleeping disk. Desktop image URLs carry the per-launch port and token (`proxy.rs:187-190`), so WebView2's week-long image cache never hits after a restart. Each image cache hit loads its source row before the lookup (`imagecache/mod.rs:975`). flate2 uses miniz_oxide; the `zlib-rs` feature roughly halves gunzip time for `.xml.gz` guides.

## Live TV, guide and lists UI

| ID | Finding | Severity | Confidence | Effort |
| --- | --- | --- | --- | --- |
| LV-1 | A scrollbar drag floods the core with channel-page requests | High | Verified | M |
| LV-2 | A guide search hit is located by scanning 1,000 rows at a time, up to 60,000 | High on large lists | Verified | S |
| LV-3 | Stalker and short-guide rows defeat the `ChannelRow` memo | Medium | Confirmed | S |
| LV-4 | The guide asks Stalker portals about every row a fling passes | Medium | Confirmed | S |
| LV-5 | The list page re-renders itself, its ribbon and every unavailable entry per focus move | Medium | Confirmed | S |
| LV-6 | The Edit channels dialog renders every entry and re-renders them on each drag-over | Medium | Confirmed | M |
| LV-7 | With remote control on, each Live visit pulls up to 20k rows through the WebView | Medium | Likely | S |
| LV-8 | Guide cells aren't memoized, lists refetch twice per write, small duplicate calls | Low | Confirmed | S |

### LV-1. Dragging the scrollbar

`usePagedChannels.ts:217-236` prefetches the next one or two pages on every range report that moves more than 4 rows, and each prefetched page then prefetches `epg.nowNext` for 120 refs and `favorites.contains` (`:189-212`). The observed pages switch keys on every report. ChannelList and the guide report every range change, and on desktop the abort signal is checked only before `invoke` (`transport.ts:119-126`), so nothing already sent is cancelled. Dragging across a 200k list is the only practical way across it, and a one-second drag issues an estimated 200 deep page reads, 400 or more requests on Live, which the pool works through in order. The page the user stops on comes last. The category grid has the same pattern (VD-2). The fix skips read-ahead on jumps larger than a page, switches observed pages only after about 100 ms at rest unless cached, fetches extras only for observed pages, and drops prefetches more than two pages from the range.

### LV-2. Revealing a guide search hit

`EpgGridPage.tsx:947-979` checks the two loaded pages, then calls `findChannelIndex` (`guide/search.ts:77-99`), which reads sequential full-row pages of 1,000, at most 60 (`LOCATE_MAX_PAGES`). A hit at row 30,000 takes 31 round trips and about 15 MB of JSON. Any channel past row 60,000 takes 60 round trips and then shows a false "not found" toast. `paged.locate` already exists (`usePagedChannels.ts:260-292`), uses the channel number to finish in at most 12 reads, and ChannelList uses it; `selectHit` drops `hit.channelNumber`. Use `locate` first and keep the scan as an uncapped fallback.

### Medium items

- LV-3. `getNowNext` returns a new `{now, next}` object per call (`epgMerge.ts:41-49`), so the memoized `ChannelRow` re-renders for every Stalker row with portal data and every Xtream row from the short guide. `useStalkerPreviews.ts:40-46` also calls `bump()` once per answer instead of once per frame. One arrow press renders about 33 rows instead of 2.
- LV-4. `EpgGridPage.tsx:469-482` builds the Stalker preview lists from the live visible range with no settle, so a fling queues up to four `get_short_epg` calls for rows already passed. The core doesn't cache them, and they eat the portal's rate limit. Build them from the settled `shortRows`.
- LV-5. `ListPage.tsx:128-134` keeps the focused row in state, re-rendering the page, an unmemoized `EpgRibbon` with 30-60 query hooks, and every unavailable entry on each arrow key. LivePage already avoids this by reading the focused row at key time.
- LV-6. `SortableList.tsx:110-178` maps every item with no virtualization and keeps drag state on the list. Lists hold up to 2,000 channels, about 28k elements, and each drag-over re-renders all of them, an estimated 50-150 ms.
- LV-7. `useRemoteBridge.ts:41-100` calls `catalog.allLiveChannels` (up to 20,000 rows) on every Live mount, source change and `parental.changed`, then sends the rows back with `remote.publishChannels`. That is an estimated 8-12 MB parsed per visit. Publish from the core, or skip the republish when nothing changed.

### Low items

- LV-8. `now` changes every 30 s and reruns `layoutBlocks` and every cell's formatting in each mounted guide row (`GuideRow.tsx:119-266`). Each list write refetches `lists.*` twice, once in `finally` and once from `lists.changed`. Stalker makes two portal calls per tune, one for `limit: 3` and one for `limit: 50`. The ribbon re-renders every block on each scroll event.

## VOD, library, sources and settings UI

| ID | Finding | Severity | Confidence | Effort |
| --- | --- | --- | --- | --- |
| VD-1 | Search results re-render every mounted card synchronously on each scroll step | High after "Show more" | Verified flushSync | M |
| VD-2 | The category grid fetches every page it scrolls past | Medium | Likely | M |
| VD-3 | Detail pages refetch the whole download list twice a second during any download | Medium | Confirmed | S |
| VD-4 | `/downloads` re-renders every row on each progress event | Medium | Confirmed | S |
| VD-5 | Import and guide progress re-render every source card | Medium | Verified core side | S-M |
| VD-6 | Portal searches fire on every debounced keystroke | Medium | Confirmed | S |
| VD-7 | `/scheduled` re-renders everything every second | Medium | Confirmed | S |
| VD-8 | A cold detail open waits on a TMDB request the prefetch skips | Medium | Likely | S |
| VD-9 | Grid slot memo broken by an inline prop, and other per-keystroke recomputation | Low | Confirmed | S |

### VD-1. Search results scroll

`HitGrid`'s virtualizer (`SearchPage.tsx:572-579`) keeps react-virtual's default `useFlushSync: true`, so every range change renders inside the scroll event. VirtualGrid, VirtualList, ChannelList and the guide turned it off; HitGrid didn't (SH-5). `renderCell` builds new prop objects per call, so `PosterCard`'s memo never holds, and every card mounts `MyListButton` with two `watchlist.list` observers. At 1920 px about 110 cards are mounted and all re-render on each row crossed, an estimated 100-400 ms of scroll-handler work per second during a fling. Set `useFlushSync: false`, memoize the cell with cached derived props, and share My List state through one context as the category grid does.

### Medium items

- VD-2. Each grid cell queries its page with `enabled: !!req` (`CategoryGridPage.tsx:124`). A one-second thumb drag on a 200k grid sends 60-120 `catalog.movies` calls whose answers are thrown away, and the pages at the stopping point queue behind them. Posters already wait for scrolling to settle (`imageGate.ts`); pages should too.
- VD-3. `useDownloads` (`queries.ts:300-320`) invalidates `downloads.list` 500 ms after any `downloads.progress`, for any id. A detail page open during any transfer refetches every download row twice a second, and the core stats each completed file per call (EP-6). Only bump for ids that belong to the page.
- VD-4. `useProgressVersion()` runs at page level (`DownloadsPage.tsx:41`) and `renderRow` passes fresh objects, so every row re-renders per event, and `formatBytes` builds an `Intl.NumberFormat` per call. Subscribe each row to its own sample.
- VD-5. The Sources page subscribes to the whole progress record (`SourcesPage.tsx:86`), `SourceCard` isn't memoized and gets inline closures, and each card render builds 10-14 Intl formatters. With IN-8, a 200k import sends about 100 events, each re-rendering every card. Memoize the card with per-card selectors and throttle the core events.
- VD-6. The 100 ms search debounce (`SearchPage.tsx:43-47`) also drives `useStalkerSearch`, which searches every Stalker source, up to 4 portal pages per call. Typing "breaking bad" with two Stalker sources sends about 170 portal requests. Give portal searches a 400-500 ms debounce and a 3-character minimum.
- VD-7. `useClock(1000)` runs at page level on `/scheduled` (`ScheduledPage.tsx:107`), rebuilding every row and about 350 date formatters a second with nothing recording. Run the clock only inside the recording-now row.
- VD-8. TMDB queries start only after the provider detail arrives (`MovieDetailPage.tsx:74`), and the hover prefetch warms only the detail, chunk and artwork. Cast and trailer arrive 0.3-1 s late and shift the action row. Prefetch the TMDB query in `afterData` and reserve the slots.

### Low items

- VD-9. CategoryGridPage's inline `render` prop (`:771-773`) breaks `GridSlot`'s memo, so focusing the grid re-renders about 100 cards. My List search re-folds every entry and parses two dates per comparison on each key (`mylist/lib/list.ts:54-87`). Stalker client-side filtering rescans every loaded page. About ten modules build Intl formatters per call; `stats/lib/format.ts` already has the cache pattern to copy.

## Shell, data layer and bundle

| ID | Finding | Severity | Confidence | Effort |
| --- | --- | --- | --- | --- |
| SH-1 | Navigation, URL typing and the `lastRoute` write re-render the whole shell, player included | Medium | Confirmed | M |
| SH-2 | Home's route chunk statically loads about 97 KB of player code | Medium | Verified | M |
| SH-3 | Home's first RPCs aren't prefetched at boot | Medium | Likely | S-M |
| SH-4 | Any Home query update re-renders every rail and card | Medium | Confirmed | M |
| SH-5 | 12 virtualizers still render inside scroll events | Medium | Verified | S-M |
| SH-6 | Poster forces one layout per mount when its artwork is cached | Low | Likely | S |
| SH-7 | Every keydown queries the DOM for an open modal | Low | Confirmed | S |
| SH-8 | A non-English cold start loads two chunks in sequence before the first paint | Low desktop, Medium remote web | Confirmed | S-M |
| SH-9 | Four settings readers override the never-stale timing | Low | Confirmed | S |
| SH-10 | `vendor-ui` preloads cmdk and every icon at boot | Low | Verified | S |
| SH-11 | The service worker never deletes old assets | Low | Verified | S |

### SH-1. Shell re-renders

`ShellLayout.tsx:328-343` calls `useSettings()`, `useShellEvents()` and `useLastRoutePersistence()`, which use `useNavigate()` and `useLocation()`. React Router builds a new route context on every router update, so ShellLayout re-renders on each navigation, on each keystroke in the Favorites, Recent and My List search fields (they write `?q=` per character), and when the `lastRoute` reply lands 1.2 s after each screen change. Nothing under it is memoized, including `PlayerDock`, which creates a new `PlayerSurface` portal element per render, and `Controls` with 28 store subscriptions. Move those hooks into leaf components that render null, select only the settings fields the shell needs, and memo the dock, rail and header.

### SH-2 to SH-5

- SH-2. `DashboardPage.tsx:23-25` imports `playItem` and `preloadEngines`, which pull `store` (58.4 kB), `playback` (27.3 kB), `mpvExtras` and `play` into Home's static closure; I measured 96.8 kB of player code in the analysis build. A lazy route renders only after its static imports run, so a cold Home waits on player code it needs only after a click. ListRails' `lazy()` was also merged into the dashboard chunk, contrary to `features/lists/rails.tsx:4-5`. Load the player inside `play()` as the command palette does, and add a chunk-graph check to `tools/check-bundle.mjs`.
- SH-3. `prefetchScreenData` (`api/bootPrefetch.ts:80-96`) handles live, radio and VOD paths but not `/dashboard`, so Home's eight first RPCs wait for the chunk load and two renders. Add a dashboard branch with argument builders shared with the page.
- SH-4. `DashboardBody` owns every Home query and builds new `renderCard` closures per render, and neither rails nor cards are memoized. Each of about ten answers on a cold start re-renders up to 9 rails of 24 cards, an estimated 20-40 ms per pass on an N100. Give each rail its own memoized component and query.
- SH-5. react-virtual 3.14 calls `flushSync` during scroll unless `useFlushSync: false`. Only VirtualGrid, VirtualList, ChannelList and EpgGridPage turn it off. It is still on in VirtualRows (Favorites, Recent, Downloads, My List, My Videos), SearchPage, EpisodeList, VirtualCardGrid, HiddenChannelsPanel, HiddenCategoriesDialog, CategoryIndex, ManageCategoriesDialog, EpgRibbon, CategorySidebar, FullscreenChannelPanel and LockGroupsDialog. Add a `useListVirtualizer` wrapper that defaults it off, and a source scan in perf-budget.test.ts that forbids importing `useVirtualizer` directly.

### Low items

- SH-6. None of the 20 `<Poster>` call sites passes `width`, so `Poster.tsx:144` reads `clientWidth` on mount, which forces a layout per card when artwork is already cached. Pass the width the rails and grids already compute.
- SH-7. `shortcuts.ts:153-155` runs `document.querySelector('[aria-modal="true"]')` on every keydown before any shortcut matches, once per auto-repeat on a held arrow. Check only after a match, or count open dialogs.
- SH-8. `initI18n` (`i18n/index.ts:150`) fetches `lazyLocales` (23.5 kB) and only then the 186-282 kB locale chunk. On remote web that is an extra round trip before the first paint. A 19-entry loader map in the entry fixes it.
- SH-9. `useDisplayPrefs.ts:23`, `LivePage.tsx:141`, `EpgRibbon.tsx:72` and `recording/hooks.ts:55` set `staleTime: 60_000` on `settings.get`, which events keep current anyway, so page visits refetch it.
- SH-10. `vite.config.ts:20-23` puts cmdk and lucide-react into `vendor-ui`. Dropping both from the manual chunk list lets Rollup place them with their users.
- SH-11. `public/sw.js` uses one cache name and only deletes caches with other names. Delete entries whose URLs are no longer in the current build's asset list on activate, or version the cache name per build.

## Desktop and server hosts

| ID | Finding | Severity | Confidence | Effort |
| --- | --- | --- | --- | --- |
| HO-1 | Playing a local `.ts` recording or download in the built-in player reads the whole file into memory first | High | Likely; app side verified | M |
| HO-2 | WebView2 drops to Low memory and the process trims its working set on every focus loss, even while video plays | High | Verified trigger, impact Likely | S |
| HO-3 | Live rewind keeps up to 1 GiB per stream in embedded mpv's RAM | Medium | Verified | S |
| HO-4 | Quitting during a catalog save blocks the event loop until the import commits | Medium | Likely | S |
| HO-5 | `--hwdec=auto-safe` overrides the user's own `--hwdec` | Low | Verified | S |
| HO-6 | The release profile optimizes the whole binary for size | Low | Speculative | S to try |
| HO-7 | Streams and images share one HTTP/1.1 loopback origin and its 6 connections | Low | Likely | S |
| HO-8 | The desktop proxy buffers every rewritten playlist | Low | Confirmed | S |
| HO-9 | External VLC is killed and cold-started on every zap | Low | Confirmed | M |

The startup refresh (ST-1) and the remote-control channel round trip (LV-7) also came up in this review; they are described above.

### HO-1. Local recordings load whole

On desktop, `recordings.playSource` returns a filesystem path with `kind: File` (`crates/iptv-core/src/recording/library.rs:260-267`), and downloads do the same. `proxiedUrl` turns it into an asset URL with `convertFileSrc` (`src/api/transport.ts:262`), and `.ts` goes to mpegts.js. mpegts.js sends no Range header for a load from byte 0 unless `rangeLoadZeroStart` is set, and the app's config at `engines.ts:804-817` doesn't set it. According to the reviewer's reading of Tauri 2.12.3, the asset protocol answers a request without Range by reading the whole file into a Vec, and wry then copies the body on the UI thread. A 1-hour recording at 6 Mbit/s is about 2.7 GB, so playback waits seconds before the first byte, the process peaks around twice the file size, and multi-hour files can exhaust an 8 GB machine. The reviewer also flagged, unverified, that later Range replies are capped at 1,000 KiB, which mpegts.js may treat as the end of the file.

I checked the app side. The Tauri side rests on the reviewer's reading of upstream source and should be confirmed with one test: play a 2-3 GB `.ts` from My Videos and watch private bytes in Process Explorer. The fix is to serve local media from the loopback proxy, which already exists: mount the server crate's `files` and `recordings` handlers, which use `ServeFile` and honour Range, under the proxy's token path, and return those URLs from `playSource` on desktop.

### HO-2. Focus loss trims memory while video plays

This is the perf-audit branch fix, still missing on master. `crates/iptv-tauri/src/lib.rs:850-853` handles `WindowEvent::Focused(false)` by setting WebView2's memory target to Low and calling `SetProcessWorkingSetSize(-1, -1)` on the event-loop thread. Tauri reports focus from WebView2's GotFocus and LostFocus, so this runs on every alt-tab, every click into another app and every native dialog. An unfocused window is often still playing: mpv picture-in-picture is the main window, browser picture-in-picture plays from the same renderer, and a second monitor keeps the video visible. Microsoft's documentation describes Low as a level for inactive apps whose memory may be swapped out, and MSE feeding touches that memory again at once. The trim also evicts the SQLite page caches. Expect dropped frames right after clicking away and a slow first interaction on return.

The fix deletes the `Focused(false)` arm and keeps Low plus the trim for minimize only. 89e7bf3 predates the visibility logic, so port it by hand. Measure dropped frames in the stream info panel and page faults for msedgewebview2.exe over 20 blur and focus cycles.

### Medium items

- HO-3. `LIVE_TIMESHIFT_OPTIONS` (`crates/iptv-core/src/player/args.rs:275-280`) sets `demuxer-max-back-bytes=1GiB` with no `cache-on-disk`, so one live channel in embedded mpv grows by about 45 MB a minute at 6 Mbit/s and reaches 1 GiB in about 23 minutes. A 25 Mbit/s stream gets there in 6. players.md doesn't mention the cost. Add `cache-on-disk=yes` with a cache folder under the data directory, or default to 256 MiB with a rewind-length setting.
- HO-4. `shutdown` runs on the UI thread (`lib.rs:958-996`), and `checkpoint_wal` runs `wal_checkpoint(TRUNCATE)` on a connection that still has the 600 s busy handler. `db::checkpoint_truncate` already drops the handler for this reason, but the exit path doesn't use it, and imports aren't cancelled first. Quitting during a save, which ST-1 makes likely in the first minute, leaves a hidden process alive until the import commits, and a relaunch in that window is handed to the stuck instance, so nothing appears. Cancel imports, use `checkpoint_truncate`, and give shutdown a time budget.

### Low items

- HO-5. `embedded_args` puts the user's `mpvArgs` first and then appends `--hwdec=auto-safe` (`args.rs:254-269`). mpv uses the last value, so a `--hwdec` set in Settings is ignored. Port the perf-audit hunk and its test `embedded_args_keep_the_users_hwdec`.
- HO-6. `Cargo.toml:88-93` builds release with `opt-level = "s"` and fat LTO, which skips loop vectorization and compiles the bundled SQLite at `/O1`. Image resizing, SQLite and JSON parsing would likely gain at opt-level 3. Measure it against the installer size, or at least set `[profile.release.package.libsqlite3-sys] opt-level = 3`.
- HO-7. `proxy.rs:140-206` serves `/proxy` and `/img` from one listener, and Chromium allows 6 connections per host and port. Four MPEG-TS tiles on the wall leave 2 connections for every logo, poster and HLS request. Serve images from a second listener or host alias.
- HO-8. `require_token` (`proxy.rs:107-137`) collects each rewritten playlist, up to 32 MB, and copies it byte by byte, which defeats the server's line-streamed `HlsRewriter`. Pass the token prefix into the rewriter instead.
- HO-9. With "reuse instance" on, the default, `external.rs:163-176` kills VLC and starts a new one on every zap, although VLC already gets `--one-instance --playlist-enqueue`. Each zap pays VLC's 0.5-1.5 s startup.

Native occlusion tracking is off on purpose (`CalculateNativeWinOcclusion` in `additionalBrowserArgs`), and minimize is handled through `SetIsVisible` (desktop.md). The remaining cost is that a window fully covered by another app, but not minimized, keeps rendering at full rate. That is a deliberate trade, not a finding.

## perf-audit branch carryover

`origin/perf-audit` (commit 89e7bf3, 2026-10-12) is still unmerged. It conflicts with master in 7 files, and master already has two of its six changes in its own form.

| perf-audit change | On master | What to do |
| --- | --- | --- |
| Position index for unfiltered pages, `NOT IN` hidden filter | Yes, as migration 0006 and `catalog/mod.rs:1381` | Nothing |
| Statement cache 16 to 128, bind LIMIT and OFFSET | No | DB-3: bind OFFSET only, then raise to 64 |
| Skip `quick_check` after a clean exit | Yes, with a different design (running marker, background check) | Nothing |
| WebView2 Low memory and working-set trim only on minimize, not on blur | No; master still trims on `Focused(false)` at `crates/iptv-tauri/src/lib.rs:850-853` | HO-2: port by hand |
| Keep a user-chosen `--hwdec` for embedded mpv | No; `args.rs:263` still appends `--hwdec=auto-safe` after the user's args | HO-5: port the hunk and its test |
| Remember hosts whose extensionless live URLs are MPEG-TS | No | PB-2, which goes further |

Once the remaining items are ported, the branch can be deleted.

## Gaps in perf test coverage

Every Rust budget was set on a fast desktop, and nothing runs on N100-class hardware or on Windows in CI. There is no CI at all. Specific gaps:

- Ingest. No Xtream sync perf test (decode, mapping, write, RSS at 100k+ items) and no Stalker one. `m3u_perf` covers only a first import into an empty database, so a changed re-import with user state, a refresh of a large catalog, gzip playlists and several sources below the bulk threshold are untested. No test for a slow Xtream list head or Stalker paging with latency.
- Database. No test sends the ungated writes or a Stalker page against a held write lock, removes a large source, scrolls through different offsets, or measures cold connections. `migration_perf.rs` skips 0018 and 0019.
- Guide. `epg_perf.rs` times a first import only. Nothing times `epg.nowNext` or `epg.grid` on a large guide with unmatched names, a second refresh, a second feed or WAL growth.
- Images and recording. Image tests are functional. Nothing times resizes by source size or checks memory under concurrent variants, and nothing measures recorder CPU.
- Player. The mock has no extensionless TS route, its media runs at about 90 kbps, and there is no multi-rendition HLS, so zap latency, long tasks and ABR can't be measured. `engines.test.ts` mocks hls.js and mpegts.js, so worker selection and blob leaks pass unnoticed. No soak test over many zaps.
- Hosts. No test plays a large local file on desktop or serves one without a Range header. No memory soak for embedded mpv on live streams. Startup time, `init_all` duration and exit latency with an import in flight are unmeasured; the desktop.md numbers come from one manual warm-start run. Focus and minimize memory behaviour is checked only by hand.
- UI. No request-count tests for drags or flings on Live, the guide or VOD grids. No render-count tests for ChannelRow on Stalker sources, ListPage keys, SortableList at 2,000 entries, HitGrid, Home, the shell on navigation, /downloads, /sources or /scheduled. `check-bundle.mjs` budgets only the entry chunk, so route chunks that pull in the player go unnoticed. No Playwright long-task or layout-shift traces.

## Measuring on the PC

The existing Rust perf tests run in release mode:

```
cargo test -p iptv-core --release --test m3u_perf
cargo test -p iptv-core --release --test epg_perf
cargo test -p iptv-core --release --test catalog_perf
cargo test -p iptv-core --release --test l2_query_perf
cargo test -p iptv-core --release --test l3_search_perf
cargo test -p iptv-core --release --test migration_perf -- --include-ignored
```

The findings above each name the test to extend or add. The frontend checks run anywhere:

```
pnpm build && pnpm size:check
pnpm test
```

For the playback findings, the Edge DevTools Performance panel (main-thread transmuxing, long tasks), the Media panel (time to `DEMUXER_ERROR_COULD_NOT_OPEN` on extensionless streams) and `edge://blob-internals` (one new blob per tune) show the problems without new tooling.

## Checked and fine

The reviewers also looked at these and found them efficient:

- One shared reqwest client with pooled keep-alive connections, bounded retries with jittered backoff, and streaming M3U and XMLTV downloads with `MinRate` and idle limits.
- M3U parsing with memchr and no regex, bounded lines, and parse and write on `spawn_blocking` in one transaction. Xtream decodes on the blocking pool and skips unchanged content types.
- Every database call in the catalog, user-state and parental code runs through `spawn_blocking`. Settings come from memory. Search uses `items_rank` with a bounded top-N.
- The scheduler sleeps between ticks, so waking from sleep runs one tick, not a burst. Account status is cached and single-flight. TMDB lookups are bounded and cached, misses included.
- XMLTV ingest streams throughout, the same guide URL is fetched once, and guide window queries are index range seeks.
- Image cache fetches are single-flight, batched `last_access` writes, sharded folders, and a background reconcile. The UI image gate allows 4 fetches and pauses during scrolls.
- Downloads use a 256 KB buffered writer and one `sync_data` per attempt.
- The guide grid virtualizes rows with memoized `GuideRow`s and chunked, settled `epg.grid` fetches. Live zap bursts tune only the channel they land on.
- hls.js and mpegts.js teardown removes `src`, revokes the MediaSource URL and removes listeners. Reconnect, stats and position timers run only while playing.
- Query cache timing, event bursts and abort signals match performance.md. Glass blur stays on small overlays, as perf-budget.test.ts enforces.

## Status on the audit/fixes branch

The audit/fixes branch merges the performance lane (audit/perf-fixes) and the feature lane (audit/feature-fixes). The Rust changes were written without a compiler on gmk1, so `cargo test`, clippy and rustfmt still have to run on the PC. Frontend checks (typecheck, vitest, build, size check) ran on the merged branch.

| Item | Status | Note |
| --- | --- | --- |
| PB-1 | Fixed | hls.js gets `workerPath` from `hls.js/dist/hls.worker.js?url`; the build emits the worker file. |
| PB-2 | Fixed | Extensionless live streams start in mpegts.js, fall back to native once, and the outcome is kept per source and host (`player.liveFormats`). Tiles share it. |
| PB-3 | Fixed | pnpm patch for mpegts.js 1.8.2 revokes the worker blob URL; the Dockerfile copies `patches/`. |
| PB-4 | Fixed | Seek bar, time readout and live edge are leaf components that stop following the stores while the chrome is hidden; `reportProgress` skips no-op writes; mpv tracks are kept when equal. |
| PB-5 | Fixed | New `tile` engine profile with short buffers and `capLevelToPlayerSize`. |
| PB-6 | Fixed | The main player's bandwidth estimate seeds the next hls.js instance. |
| PB-7 | Fixed | Shaka teardown is awaited, capped at 300 ms. |
| ST-1 | Fixed | Startup refreshes only stale or never-refreshed sources, 30 s after boot. |
| ST-2 | Partial | A manual refresh joins a running import and one save slot serializes decode and commit. An unchanged Xtream kind skips the slot, but a changed one holds it while later kinds download. |
| ST-3 | Fixed | Stalker answers are fingerprinted; M3U URLs send ETag and Last-Modified and keep the catalog on a 304. |
| ST-4 | Partial | Export to a path streams to the file and the download JSON is built on the blocking pool. The RPC layer still serializes the download a second time (DB-5), and there is no option to leave out the text of URL sources. |
| ST-5 | Fixed | Refresh of one source refetches only `sources.*`; backup loads emit `done` with `sources.changed`; an autoRefresh-only update sends `status`. |
| DB-1 | Partial | User writes and best-effort background writes go through the write gate. The separate read pool is not done. |
| DB-2 | Partial | Remove holds `long_write`, deletes FTS and rank rows in bulk and checkpoints the WAL. The index rebuild after a very large removal is not done. |
| DB-3 | Fixed | OFFSET is bound, LIMIT stays literal, statement cache raised to 64. |
| DB-4 | Fixed | Pool idle timeout and max lifetime are off. |
| DB-5 | Not done | Not attempted: serializing RPC results once (`RawValue`) needs a Rust toolchain to do safely. |
| DB-6 | Fixed | The superseded index lines were removed from migration 0018. |
| IN-1 | Fixed | No deep clone of the channel list, trees dropped after mapping, mapping runs on `spawn_blocking`. The typed decode was not attempted. |
| IN-2 | Fixed | Xtream lists and Stalker large calls use the 120 s head deadline and a minimum body rate, and a spent timeout is not retried. |
| IN-3 | Partial | `title_base` and the title year are computed before the transaction. Rows still carry the JSON extra and a `source_id` clone, and extra is serialized inside the transaction. |
| IN-4 | Fixed | Stalker pages are fetched 4 at a time once the total is known, with a 100k-row cap that logs a warning. |
| IN-5 | Fixed | The remapper keeps strings only for referenced ids and identities. |
| IN-6 | Fixed | A gzip file whose decoded size is over the inline limit is not read again. |
| IN-7 | Not done | Decoding straight into the typed structs changes how bad elements and duplicate keys are handled; it needs a design decision and a compiled benchmark. |
| IN-8 | Fixed | Parse progress is throttled to one event per 250 ms, and the final count is always sent. |
| IN-9 | Fixed | The writer counts untouched rows once. |
| IN-10 | Partial | Group ids are cached, directive lines are matched without allocating, and only playlists kept on disk are synced. Per-attribute double allocation and the per-row extra map remain. |
| EP-1 | Fixed | Recording uses the HTTP copy for plain TS and Xtream live even when mpv is installed; recording mpv skips video decoding. |
| EP-2 | Fixed | Fuzzy name lookups are memoized, the directory build is single-flight, per-ref reads use cached statements, and status-only `epg.changed` refetches only `epg.sources`. |
| EP-3 | Not done | Not attempted: changing how guide refreshes rewrite programmes needs a Rust toolchain to do safely. |
| EP-4 | Fixed | Large posters are shrunk before Catmull-Rom, and resizes are capped at cores minus one. |
| EP-5 | Fixed | `FEED_SQL` probes each enabled feed through the index instead of reading the whole lookback. |
| EP-6 | Partial | Download lists stat files on the blocking pool and desktop image hits skip the source row. The zlib-rs feature and stable desktop image URLs were not done. |
| LV-1 | Fixed | A scrollbar jump waits 110 ms at rest before it reads pages, and stale read-ahead is cancelled. |
| LV-2 | Fixed | Search hits use `paged.locate` with the channel number; the scan reads to the end of the list. Guide hits opened from global search use the same path. |
| LV-3 | Fixed | Now/next results are cached per programme list and time; Stalker previews re-render once per frame. |
| LV-4 | Fixed | The /epg grid builds Stalker previews from settled rows. |
| LV-5 | Fixed | ListPage reads the focused row at key time. |
| LV-6 | Partial | Rows are memoized so a drag-over re-renders only the rows that change. The list is still not virtualized. |
| LV-7 | Fixed | Done in the feature lane: `remote.publishSource` reads the channels in the core, so the Live page no longer calls `catalog.allLiveChannels`. |
| LV-8 | Fixed | Guide rows skip clock ticks that change nothing, ribbon blocks are memoized, list writes refetch once, and a Stalker tune asks once. |
| VD-1 | Fixed | HitGrid uses the shared virtualizer with memoized cells and one My List subscription. |
| VD-2 | Fixed | Category grid pages open through a page gate after scrolling rests. |
| VD-3 | Fixed | Detail pages refetch downloads only for their own ids. |
| VD-4 | Fixed | Each download row reads its own progress sample. |
| VD-5 | Fixed | Source cards are memoized with per-card selectors and cached formatters. |
| VD-6 | Fixed | Portal searches wait 450 ms and need 3 characters. |
| VD-7 | Fixed | `/scheduled` ticks once a minute; only the recording-now row runs a one-second clock. |
| VD-8 | Fixed | The detail prefetch also starts the TMDB lookup, and the hero reserves the trailer slot. |
| VD-9 | Fixed | Stable cell renderers, cached Stalker filtering, My List folds once, and cached Intl formatters in `src/lib/intl.ts` (now also taking their locale from `intlLocale`). |
| SH-1 | Fixed | Shell hooks moved into leaf components; Rail, Header and PlayerDock are memoized. |
| SH-2 | Fixed | Home loads the player on click; `tools/check-bundle.mjs` fails if Home's static imports reach player chunks. |
| SH-3 | Fixed | Boot prefetch covers Home's rail queries. |
| SH-4 | Fixed | Each Home rail is a memoized component. |
| SH-5 | Fixed | `useListVirtualizer` turns off flushSync everywhere; a test forbids direct `useVirtualizer` imports. |
| SH-6 | Partial | Home and VOD rails pass the card width. VirtualGrid and the other grids still measure. |
| SH-7 | Fixed | The modal lookup happens only after a shortcut matches that a modal would block. |
| SH-8 | Fixed | One loader map in the entry, one request per language. |
| SH-9 | Fixed | The 60 s `staleTime` overrides on `settings.get` are gone. |
| SH-10 | Fixed | `vendor-ui` holds only tailwind-merge, clsx and zustand. |
| SH-11 | Fixed | The service worker gets the build's asset list and deletes stale entries. |
| HO-1 | Fixed | Desktop recordings and downloads play through the loopback proxy, which honours Range. |
| HO-2 | Fixed | WebView2 Low memory and the trim happen on minimize only. |
| HO-3 | Fixed | Live rewind is capped at 256 MiB; disk cache was not used. |
| HO-4 | Fixed | Shutdown cancels imports and runs within a 5 s budget; the WAL checkpoint drops the busy handler. |
| HO-5 | Fixed | `--hwdec=auto-safe` is added only when the user set no hwdec. |
| HO-6 | Fixed | The bundled SQLite builds at opt-level 3; the global level stays `s` until measured. |
| HO-7 | Fixed | Images are served from a second loopback listener (`imageBase`). |
| HO-8 | Fixed | The desktop proxy streams rewritten playlists with the token in them. |
| HO-9 | Not done | VLC's one-instance hand-off would lose the stop and reuse handle and can't be tested from gmk1; players.md explains why the kill stays. |
| Split the pool into read and write pools | Not done | Not attempted: needs a Rust toolchain to do safely (this is the remaining part of DB-1). |

Rust tests added or changed by the performance lane have not been compiled. On the PC, run `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` before relying on them.
