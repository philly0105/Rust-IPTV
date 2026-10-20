# Xtream Codes

Code: `crates/iptv-core/src/xtream/`. Tests: `crates/iptv-core/tests/xtream_registry.rs`, `xtream_flow.rs`, `xtream_errors.rs`, `xtream_sync_lock.rs` (shared harness and embedded stub in `xtream_stub.rs`), `l2_import_sync.rs` (unchanged refresh, partial failures), plus unit tests in every module.

The client talks to `player_api.php` on an Xtream panel, imports live channels, radio, movies and series into the shared catalog, and builds stream, catch-up and EPG data on demand. Panels disagree about types, so every wire field is parsed leniently.

## Layout

| File | Role |
| --- | --- |
| `mod.rs` | `XtreamImporter` and `init` (registers the importer with `sources::register_importer`, amendment A1). |
| `url.rs` | Server URL normalization and builders for API, xmltv, live, movie, episode and timeshift URLs; catch-up stamp; extension cleanup. |
| `raw.rs` | Wire types and lenient deserializers. |
| `client.rs` | `XtreamClient`: GET with retry, the source's User-Agent, Referer and Origin (`XtreamSourceConfig.headers`; without a User-Agent the VLC one, `XTREAM_USER_AGENT`, that some panels require), JSON/HTML detection, `check_auth`. Built on `http::trusted_client`: in server mode the guarded client with the panel's own `host:port` trusted, so a redirect elsewhere is refused. |
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

`xtream.streamUrl` and `xtream.catchupUrl` carry the source's own User-Agent, Referer and Origin in `PlayerSource.headers` when any is set (absent otherwise, so players keep their defaults), so playback, downloads (which re-resolve through `streamUrl`) and recordings send what the API calls send. `sources.add` / `sources.update` refuse a header value with a line break or other control character.

## Server URL normalization

`url::normalize_server_url`: trim, add `http://` when no scheme is given, reject other schemes, embedded credentials and empty hosts. Strip trailing slashes, then a trailing `/player_api.php` or `/get.php` (case-insensitive), then trailing slashes again. The port and base path stay; a default port is dropped and the host is lowercased. `http://Host:8080/base/get.php?username=x` becomes `http://host:8080/base`.

## Sync

1. Fetch the account (`player_api.php` with no action). `user_info.auth == 0` (or missing user info) is an `Auth` error and aborts.
2. Store `ServerMeta` in memory and in `app_state` under `xtream_meta:<sourceId>`, so URLs work after a restart without a fresh login.
3. For live, movies, then series: fetch categories and the list concurrently, decode on the blocking pool and map rows. Live rows with `stream_type` `radio_streams` go to the radio content type. Each type's raw body is dropped before the next type is fetched; the mapped rows are held until the write.
4. Write every type that changed in one Immediate transaction (`sync::replace_catalogs_with`, through `CatalogWriter`), together with the fingerprints (see Unchanged refresh). A cancel or failure before the commit leaves the previous catalog of every type whole.
5. Auth, Network, Server and Timeout abort the sync, and nothing is written. Any other failure in one type logs a warning and keeps that type's previous rows (see Partial failures); the sync fails only if every type failed.
6. Add `{server}/xmltv.php?username=..&password=..` to `epg.detectedUrls`, replacing an older xmltv link for the same server.
7. Progress events (`fetching`, `parsing`, `saving`) are emitted every 2000 items, at most one per 250 ms (`sources::ProgressGate`); the last row's `saving` event always goes out. Around the row writes, `saving` names its step (see sources.md): `replacing` before the transaction deletes the previous rows, sent when a type about to be written already has rows, and `indexing` once every row is written (`on_finish` of `replace_catalogs_with`), before the writer rebuilds the indexes, the search index and the counts.

Types that are not written (unchanged, kept or failed) are left out of the transaction, so their rows stay as they were. The importer never emits `done` / `error` progress and never writes `last_refresh_at` / `last_error`: `sources::run_import` owns the outcome, `sources.changed`, and the per-source lock. `xtream.sync` with `contentTypes` cannot go through the importer, so it runs inside `sources::run_import_with`, which takes the same per-source lock as `run_import`, and records the outcome itself with `sources::store::record_import`, `sources::progress` and `sources::emit_changed` (`reason: "catalog"` after a successful sync, `"status"` after a failed one, which kept the previous rows). A subset sync and a full refresh of the same source therefore never interleave; whichever starts second waits. The source row is re-read under the lock. The lock is not reentrant, so nothing inside that block calls `run_import`.

### Unchanged refresh

`sync::kind_hash` takes a sha256 of each type's panel answers: `SYNC_VERSION`, the type, its mapped categories (id, name, position) and the raw list body. The hash and the rows written per content type are stored as JSON in `app_state` under `xtream_fp:<sourceId>`, inside the catalog's write transaction, so they commit or roll back with the rows. On the next sync, a type whose hash matches and whose stored row counts still match the rows in `items` is neither decoded nor written; its summary counts come from the rows already there.

When the sync has nothing to write, it takes no write lock and sets `ImportSummary.unchanged`. `run_import` then emits `done` with `message: "unchanged"` (`sources::UNCHANGED_MESSAGE`) and no `sources.changed`, so clients keep their catalog queries (sources.md). A subset `xtream.sync` skips unchanged types the same way, but its `done` carries no message and it always emits `sources.changed`.

`SYNC_VERSION` (now 1) is part of every hash. Bump it whenever a change alters the rows a sync writes, as with `m3u::importer::IMPORT_VERSION`; otherwise panels whose answers did not change keep rows mapped by the old rules. The fingerprints are deleted with the source (`sources::store::delete`). A type written without its categories (below) loses its fingerprint, so the next refresh writes it again.

### Partial failures

- A type whose list fails with anything but Auth, Network, Server or Timeout (`NotFound`, unreadable JSON) keeps its previous rows. Unless the error is `NotFound` or `Unsupported`, which mean the panel does not serve the type, the sync notes a warning: "Movies could not be loaded from the server, so the previous movies were kept. Refresh the source to try again."
- A type whose categories come back unreadable (a login or error page) keeps its previous rows and categories when it has rows. On a first import, its items are written under "Uncategorized" and no fingerprint is stored, so the next good refresh rewrites them with their real categories. Both cases note a warning naming the categories.
- Warnings go through `sources::note_import_warning(message, code)`; only the first one of a run is kept. `run_import` records it as `lastError` (with `lastErrorCode` and `lastErrorAt`) right after recording the success, so the source says what is stale instead of looking fully refreshed. The run still ends with `done`.
- A subset `xtream.sync` keeps rows the same way but does not record the warning: it clears `lastError` on success.

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

- Requests are retried like `http::with_retry` (3 attempts; 1 for `xtream.test`), only for errors `CoreError::is_retryable` accepts: Network, Timeout and Server (5xx). A refused connection, an unknown host and a bad certificate are Network errors that fail at once with their own next step. A request that used up its whole time budget is not retried either. The account check waits at most 10 s for the response head (`client::ACCOUNT_HEADER_TIMEOUT`), so a silent panel fails in about 10 s. List actions (`get_live_streams`, `get_vod_streams`, `get_series`) wait up to 120 s for the head, the M3U `PLAYLIST_HEADER_TIMEOUT`, because panels build big lists before answering; a head that did not come in that time is not asked for again, so the panel never builds the list three times (IN-2). They go through a second client (`XtreamClient::with_list_client`, `http::trusted_long_client`) whose 150 s read timeout outlasts that wait; reqwest's read timeout also runs while a head is awaited, so the normal 60 s one cut such lists off. Their body keeps the 1 KB/s minimum rate instead of a whole deadline, and fails after 60 s without a byte (`http::READ_TIMEOUT`).
- `xtream.test` and the first import of `sources.add` run inside `http::interactive` (sources.md, add): the connection gets 3 s instead of 10 s, and a panel that does not take it fails once with "Could not reach <host>. The server did not answer. Check the address and port, and that the server is online, then try again.", without retries. Refreshes keep the 10 s connect timeout and the retries.
- `From<reqwest::Error>` strips URLs, so error messages never contain the query string. Logs carry the server, a masked username (first character and `***`) and the action only. `XtreamClient` and `XtreamSourceConfig` redact the password in `Debug`.
- `xtream.test` turns every error into a sentence naming the next step (check credentials, check the URL, try later).

## Detail pages

`vodDetail` / `seriesDetail` merge the catalog row with `get_vod_info` / `get_series_info`. When the provider call fails with anything but `Auth` and the catalog row exists, the page is built from the row alone with `providerDetailsUnavailable: true` and `providerError` set (the UI shows a hint). `NotFound` is returned only when neither the row nor a provider payload exists.

## Caches

Series info is cached for 10 minutes (at most 64 entries) so `streamUrl` for an episode does not refetch what the detail page loaded. `seriesDetail` always refetches. A sync clears the cache for that source.

## Tests and the mock

The mock panel also accepts the users `expiring` (trial, expires in 3 days, 1 of 2 connections), `expired` (status `Expired`, two days ago) and `full` (2 of 2 connections; its live, VOD and timeshift streams answer 403 "Max connections reached"), all with password `secret`; `account_status.rs` uses them.

The integration tests use `iptv_fixtures::spawn_mock()` when it serves `/xtream/player_api.php` for `demo` / `secret`, and otherwise an embedded axum stub in `tests/xtream_stub.rs` with the same C13 shapes plus real-panel quirks. The stub also provides a `flaky` user whose first account request returns 503, for the retry test, and a `slow` user whose `get_vod_streams` answer is delayed, so `xtream_sync_lock.rs` can show a concurrent `sources.refresh` waits for a running subset sync.
