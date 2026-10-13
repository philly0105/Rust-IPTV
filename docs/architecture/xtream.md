# Xtream Codes

Code: `crates/iptv-core/src/xtream/`. Tests: `crates/iptv-core/tests/xtream_registry.rs`, `xtream_flow.rs`, `xtream_errors.rs`, `xtream_sync_lock.rs` (shared harness and embedded stub in `xtream_stub.rs`), plus unit tests in every module.

The client talks to `player_api.php` on an Xtream panel, imports live channels, radio, movies and series into the shared catalog, and builds stream, catch-up and EPG data on demand. Panels disagree about types, so every wire field is parsed leniently.

## Layout

| File | Role |
| --- | --- |
| `mod.rs` | `XtreamImporter` and `init` (registers the importer with `sources::register_importer`, amendment A1). |
| `url.rs` | Server URL normalization and builders for API, xmltv, live, movie, episode and timeshift URLs; catch-up stamp; extension cleanup. |
| `raw.rs` | Wire types and lenient deserializers. |
| `client.rs` | `XtreamClient`: GET with retry, VLC User-Agent, JSON/HTML detection, `check_auth`. Built on `http::trusted_client`: in server mode the guarded client with the panel's own `host:port` trusted, so a redirect elsewhere is refused. |
| `meta.rs` | Per-source `ServerMeta` (clock offset, allowed formats, timezone), series-info cache, time helpers. |
| `sync.rs` | Catalog sync per content type and xmltv detection. |
| `service.rs` | Detail pages, stream and catch-up URLs, short EPG, account info, connection test. |
| `rpc.rs` | `xtream.*` registration and `COMMANDS`. |

## Commands (C4)

| Command | Args | Returns |
| --- | --- | --- |
| `xtream.sync` | `{sourceId, contentTypes?}` | `ImportSummary`. A full sync delegates to `sources::run_import`; a subset runs under the same per-source lock (`sources::run_import_with`) and records the outcome the same way |
| `xtream.vodDetail` | `{ref}` | `VodDetail` |
| `xtream.seriesDetail` | `{ref}` | `SeriesDetail` with seasons and episodes |
| `xtream.streamUrl` | `{ref, episodeId?}` | `PlayerSource` |
| `xtream.catchupUrl` | `{ref, start, durationMinutes}` | `PlayerSource` |
| `xtream.shortEpg` | `{ref, limit?}` | `EpgProgram[]` (default 4, max 50) |
| `xtream.accountInfo` | `{sourceId}` | `XtreamAccountInfo` |
| `xtream.test` | `{config}` | `ConnectionTestResult` (never errors on a bad server; `ok: false` plus a message) |

## Server URL normalization

`url::normalize_server_url`: trim, add `http://` when no scheme is given, reject other schemes, embedded credentials and empty hosts. Strip trailing slashes, then a trailing `/player_api.php` or `/get.php` (case-insensitive), then trailing slashes again. The port and base path stay; a default port is dropped and the host is lowercased. `http://Host:8080/base/get.php?username=x` becomes `http://host:8080/base`.

## Sync

1. Fetch the account (`player_api.php` with no action). `user_info.auth == 0` (or missing user info) is an `Auth` error and aborts.
2. Store `ServerMeta` in memory and in `app_state` under `xtream_meta:<sourceId>`, so URLs work after a restart without a fresh login.
3. For live, movies, then series: fetch categories and the list concurrently, decode on the blocking pool, map rows and write with `catalog::replace_catalog`. Live rows with `stream_type` `radio_streams` go to the radio content type. One type at a time keeps peak memory to a single list.
4. Auth, Network and Timeout abort the sync. Any other failure in one type logs a warning and moves on; the sync fails only if every type failed.
5. Add `{server}/xmltv.php?username=..&password=..` to `epg.detectedUrls`, replacing an older xmltv link for the same server.
6. Progress events (`fetching`, `parsing`, `saving`) are emitted every 2000 items.

Each `replace_catalog` call runs in its own Immediate transaction (through `CatalogWriter`), so a failed type keeps its previous rows. The importer never emits `done` / `error` progress and never writes `last_refresh_at` / `last_error`: `sources::run_import` owns the outcome, `sources.changed`, and the per-source lock. `xtream.sync` with `contentTypes` cannot go through the importer, so it runs inside `sources::run_import_with`, which takes the same per-source lock as `run_import`, and records the outcome itself with `sources::store::record_import`, `sources::progress` and `sources::emit_changed`. A subset sync and a full refresh of the same source therefore never interleave; whichever starts second waits. The source row is re-read under the lock. The lock is not reentrant, so nothing inside that block calls `run_import`.

Rows never store a stream URL, because it would contain the password. URLs are built at play time from the source config.

Mapping notes: the category is `category_id`, else the first of `category_ids`, else `"0"`. `archive_hours` is `tv_archive_duration * 24` (one day when the duration is missing) when `tv_archive` is on. Rating uses `rating`, else `rating_5based * 2`, rounded to one decimal and capped at 10; `"N/A"` becomes none. `added` accepts unix seconds as a number or string, or a date. Series use `last_modified` as `added`. `extra` carries plot, genres, tmdbId, isAdult, categoryIds, tvArchive, tvArchiveDuration, customSid and streamType.

## Lenient JSON

`raw.rs` accepts numbers as strings and strings as numbers, booleans as `0`/`1`/`"true"`, `null` or missing for any field, `category_ids` as an array or a scalar, `backdrop_path` as a string or an array, objects where panels send `[]` (`info: []`), and lists sent as objects keyed by index. A bad element in a list is skipped and counted (`LenientVec`) instead of failing the whole list. Series `episodes` may be an object keyed by season, an array of arrays, or null. An HTML body (a login or error page) gives an `Invalid` error asking the user to check the server URL.

## Playback URLs

- Live and radio: `{server}/live/{user}/{pass}/{id}.{ext}`. `ext` is `settings.streamFormat` when the panel allows it (`allowed_output_formats`, lowercased and trimmed) or lists no formats, otherwise the first allowed format in the order m3u8 > ts > the panel's first listed format. The formats come from `ServerMeta`, captured on every sync, `xtream.accountInfo` and `xtream.test`, and persisted, so URLs built offline still respect them. `xtream.accountInfo` also returns them as `allowedOutputFormats` (empty when the panel lists none). Its `serverTime` is RFC 3339 from `timestamp_now`; without it, `time_now` is converted when `timezone` is UTC or a fixed offset (`+02:00`, `GMT-5`, `Etc/GMT-2`), and otherwise returned as the bare wall clock, which the UI shows verbatim next to the zone name (there is no zone database). The old app's "auto" format preferred ts over m3u8 and, for an explicit format the panel rejects, took the panel's first format; Tsrust has no "auto" setting and prefers m3u8 because HLS plays in the inline player. m3u8 maps to `hls`, mpd to `dash`, everything else to `direct`.
- Movie: `{server}/movie/{user}/{pass}/{id}.{ext}`. The extension comes from the catalog row, then `get_vod_info`, then `mp4`. The resume position comes from `playback_positions`. A movie ref whose id has no movie row but matches a series row is `NotFound`, naming the series and pointing to the series list.
- Episode: `{server}/series/{user}/{pass}/{episodeId}.{ext}`. A series ref without `episodeId` is `Invalid` ("Choose an episode to play."). When series info loads but has no such episode (after one refetch past the cache), the call is `NotFound`; the `mp4` fallback applies only when series info itself fails.
- Catch-up: `{server}/timeshift/{user}/{pass}/{minutes}/{YYYY-MM-DD:HH-mm}/{id}.ts`. The start is converted to server local time with the stored clock offset (`server_info.time_now` minus `timestamp_now`, rounded to 15 minutes). Starts in the future are rejected; duration is clamped to 1 minute through 7 days. When the channel row is synced, a channel without archive is rejected ("This channel has no catch-up.") and so is a start older than its `tv_archive_duration` window (the message names the window).

Username and password are percent-encoded as path segments.

## Short EPG

`get_short_epg` titles and descriptions are base64; text that does not decode to UTF-8 is kept as is. Times come from `start_timestamp` / `stop_timestamp` (unix) when present, otherwise from the server-local `start` / `end` strings minus the clock offset. Output is RFC 3339, sorted by start and deduplicated.

Guide fallback (`catchup/`): `epg.shortEpg {ref, limit?}` returns the programmes that have not ended yet on the guide clock (`now - settings.epgOffsetMinutes`, so with a positive offset the programme the UI shows as airing is kept; default 4, max 10) for channels whose XMLTV guide has nothing airing. It is empty when `settings.epgShortFallback` is off or the source is not Xtream. Answers are cached per `(source, stream)` for 20 minutes, or until every programme in them has ended. Concurrent asks for one channel share one panel call, at most 3 panel calls run at once, and errors are not cached. Both caches drop a source's answers when its server or account changes, when it is removed, and when a backup restore re-creates it. The UI asks only for visible rows, through the same throttled preview queue Stalker rows use, and marks the result "From the provider's guide" (`EpgProgram.fromProvider`).

`catchup.programs {ref, from, to}` returns the archive programmes overlapping `[from, to)` from `get_simple_data_table` (decoded like the short EPG, at most 5000 rows per answer, cached 20 minutes, 2 concurrent calls). The archive browser uses it when XMLTV has nothing for the chosen day.

## Errors, retries, secrets

- Requests go through `http::with_retry` (3 attempts; 1 for `xtream.test`) and retry only Network and Timeout errors, which include 5xx responses.
- `From<reqwest::Error>` strips URLs, so error messages never contain the query string. Logs carry the server, a masked username (first character and `***`) and the action only. `XtreamClient` and `XtreamSourceConfig` redact the password in `Debug`.
- `xtream.test` turns every error into a sentence naming the next step (check credentials, check the URL, try later).

## Detail pages

`vodDetail` / `seriesDetail` merge the catalog row with `get_vod_info` / `get_series_info`. When the provider call fails with anything but `Auth` and the catalog row exists, the page is built from the row alone with `providerDetailsUnavailable: true` and `providerError` set (the UI shows a hint). `NotFound` is returned only when neither the row nor a provider payload exists.

## Caches

Series info is cached for 10 minutes (at most 64 entries) so `streamUrl` for an episode does not refetch what the detail page loaded. `seriesDetail` always refetches. A sync clears the cache for that source.

## Tests and the mock

The mock panel also accepts the users `expiring` (trial, expires in 3 days, 1 of 2 connections), `expired` (status `Expired`, two days ago) and `full` (2 of 2 connections; its live, VOD and timeshift streams answer 403 "Max connections reached"), all with password `secret`; `account_status.rs` uses them.

The integration tests use `iptv_fixtures::spawn_mock()` when it serves `/xtream/player_api.php` for `demo` / `secret`, and otherwise an embedded axum stub in `tests/xtream_stub.rs` with the same C13 shapes plus real-panel quirks. The stub also provides a `flaky` user whose first account request returns 503, for the retry test, and a `slow` user whose `get_vod_streams` answer is delayed, so `xtream_sync_lock.rs` can show a concurrent `sources.refresh` waits for a running subset sync.
