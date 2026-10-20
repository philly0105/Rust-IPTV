# Stalker / Ministra portals

Code: `crates/iptv-core/src/stalker/`. Contract: SPEC C4 (stalker), amendment A1 (importer registration).

## Modules

| File | Role |
| --- | --- |
| `protocol.rs` | Pure helpers: endpoint candidates, request URL encoding, MAG headers, response classification, playback command parsing, lenient JSON readers. Unit tests are ported from the old app's `libs/portal/stalker/data-access`. |
| `sha1.rs` | Minimal SHA-1 for the handshake `prehash`. The workspace has no sha1 crate. |
| `session.rs` | `StalkerClient`: discovery, handshake, profile, `do_auth`, token cache, the single re-handshake. |
| `mapping.rs` | Portal JSON to `ItemRow`, `VodItem`, `SeriesItem`, `EpgProgram`. |
| `sync.rs` | `StalkerImporter` (registered from `stalker::init`) and `sync_source`. |
| `vod.rs` | Movies and series paged live from the portal, details, season plans. |
| `playback.rs` | `create_link`, catch-up, EPG, account info, connection test. |
| `rpc.rs` | The 11 `stalker.*` commands. `COMMANDS` lists them. |

## Session

1. Discovery. `endpoint_candidates(portalUrl)` puts a pasted `.php` endpoint first, then `portal.php`, then `server/load.php`, then `stalker_portal/server/load.php` (never nested twice), then `c/portal.php`. A browser URL ending in `/c` is reduced to its base first.
2. Probing.
   - Full portals (`isFullPortal=true`) run the handshake on each candidate.
   - Token-free panels probe `itv/get_genres` without a token. When the probe gets an auth failure, they fall back to a handshake.
   - Endpoints that answer 404, HTML, non-Stalker JSON, or a bare 401/403 move discovery on to the next candidate.
   - A portal-level refusal (wrong MAC, blocked device) stops discovery straight away.
   - A candidate that gets no HTTP answer at all (refused, DNS, timeout) stops discovery too, since every candidate is on the same host. A refused connection, an unknown host or a bad certificate is Network and is not retried: "Could not reach the portal at <host[:port]>. " plus that failure's own next step from `http` (for a refused connection, "The server refused the connection. Check the address and port, and that the server is running, then try again."). Any other failure without an answer, such as a reset connection, is Network and retried: "Could not reach the portal at <host[:port]>. Check the URL and your connection, then try again." A host that takes the connection and stays silent is Timeout (retryable): "The portal at <host[:port]> did not answer in time. Try again later."
3. Handshake. The request is `type=stb&action=handshake&token=&prehash=SHA1(MAC)&JsHttpRequest=1-xml` with no Bearer. It returns `token` and `random`.
4. Profile. `get_profile` sends the MAG250 fields, `metrics`, and these optional fields when present: `sn`, `device_id`, `device_id2`, `signature`, `signature2`.
   - `status=2` means the portal wants a login: the client calls `do_auth` with the username and password, then requests the profile again with `auth_second_step=1`.
   - `status=1` becomes `Auth` "This MAC address is not registered on the portal. Check the MAC or contact your provider.", followed by "Portal message: ..." with the portal's own `msg` / `block_msg` text. A portal sentence that spells out the MAC is left out, because the message reaches `lastError`, events, and logs. Any other block message becomes `Auth` with the portal's text, and a device-id conflict gets an extra hint.
5. Token cache. The value at `app_state['stalker_token:<sourceId>']` is the JSON `{endpoint, token, random, identity}`.
   - `identity` is a fingerprint of the portal URL, MAC, serial, device ids, signatures, and login. A cached session is reused only while the fingerprint matches.
   - A cached token is trusted without a new handshake.
6. Re-handshake. An auth failure triggers one re-handshake per call, under the session mutex, and the call is retried once. Auth failures are:
   - the plain bodies `Authorization failed.`, `Access denied.`, `Unauthorized request.`
   - auth phrases inside `js`, `js.error`, or `js.msg`
   - HTTP 401 or 403

   If another task already replaced the failed token, its token is reused. If the known endpoint stops answering as a portal, discovery runs again.
7. Requests use `http::with_retry(3)`, which retries only errors `CoreError::is_retryable` accepts: Network (but not a refused connection, an unknown host or a bad certificate), Timeout and Server. An empty body counts as Network, so it is retried. The default timeout is 30 s for the whole request. `get_all_channels` and `get_epg_info` get 120 s for the response head only, the same as an M3U playlist; their body has no whole deadline but must average at least 1 KB/s over each 60 s window (`http::read_capped_at_rate`), and a timeout of either is not retried, because a portal that slow would be as slow again (IN-2). Each exchange goes through `http::send_within` with the request's own timeout as the response-head deadline (portals build large replies before answering), so the shared client's connect timeout applies, a request refused by the server-mode guard keeps its own explanation, and transport failures map to the portal messages above. The client comes from `http::trusted_client` (`http::trusted_long_client` for the 120 s requests, whose 150 s read timeout outlasts the head wait that the normal 60 s one would cut short; their body reads still fail after 60 s without a byte): in server mode it is the guarded client with the portal's own `host:port` trusted, so a portal redirect to any other private address is refused. `stalker.test` and the first import of `sources.add` run inside `http::interactive` (sources.md, add): the connect timeout is 3 s instead of 10 s, and a portal that does not take the connection fails once, without retries, with "Could not reach the portal at <host[:port]>. The server did not answer. Check the address and port, and that the server is online, then try again."

Headers are built with a `HeaderMap`, so each header is set once:

- `User-Agent`: MAG200, or the user's override
- `X-User-Agent: Model: MAG250; Link: WiFi`
- `Cookie: mac=<MAC>; stb_lang=en; timezone=Europe/Paris`, plus `__cfduid` derived from the serial when one is set. `<MAC>` is the stored value, sent verbatim.
- `Accept: */*`
- `SN`, when a serial is set
- `Referer` and `Origin`, when configured
- `Authorization: Bearer <token>`

The legacy default serial `BEDACD4569BAF` counts as no serial.

MAC rules: a newly typed MAC (`sources.add`, `stalker.test`, a changed MAC in `sources.update`) must have 12 hex digits and is stored as `00:1A:79:12:34:56`. A stored MAC that is not in that form (a grandfathered value such as `MAG-0001`) is kept verbatim when an edit leaves it unchanged, and `backup.import` keeps the backup's value verbatim (trimmed). The session only requires a non-empty MAC without whitespace, control characters, `;`, or `,`.

## Import (`stalker.sync`, importer)

- Live: `itv/get_genres` (the `*` entry is skipped) and `itv/get_all_channels`. When `get_all_channels` is empty or unsupported, the importer pages `itv/get_ordered_list&genre=*` instead. Paged walks (`vod::walk_pages`) read page 1 for the total and the page size, then fetch the remaining pages four at a time in order; the page count follows the total, up to 100,000 rows (a longer total logs a warning), and an empty page ends the list. The pages are read in order as they arrive, so an empty page stops the walk at once: a total the portal overstates costs only the requests already out, and a page past the end that fails is never read. Episode walks keep their 30-page cap.
  - Channels whose genre is unknown go to the `uncategorized` category, named "Uncategorized".
  - Logos are made absolute.
  - `archive_hours` comes from `tv_archive_duration` when `tv_archive` or `enable_tv_archive` is set.
  - `extra` keeps `cmd`, `useHttpTmpLink`, `useLoadBalancing`, and `censored`.
- Radio: `radio/get_ordered_list` across all pages, into one "Radio" category. A failure here is not fatal (see the partial-failure item below).
- Movies and series: only `vod/get_categories` and `series/get_categories`, written with zero items, because VOD is paged live.
- Partial failures: when radio, the VOD categories or the series categories fail with Network, Server or Timeout (the portal or the network did not answer), that section is left out of the write and keeps its previous rows. The importer notes a warning with `sources::note_import_warning` ("The radio stations could not be loaded from the portal, so the previous ones were kept. Refresh the source to try again."), and `run_import` records it as `lastError` after recording the success. Kept radio rows still count in `ImportSummary.channels`. Any other failure, such as a 404, means the portal does not serve the section, which is written empty. Auth and a cancel stop the import. Genres and live channels have no such fallback: their failures fail the import.
- Unchanged refresh (ST-3): when every section answered, the importer hashes the answers on the blocking pool (`sync::answers_hash`: `SYNC_VERSION`, the endpoint, the live, movie and series categories, and the channel and radio answers as serde_json writes them). When the hash matches the fingerprint stored in `app_state` (`stalker_fp:<id>`) and the live and radio rows it recorded are all still in the catalog, nothing is mapped or written: the summary carries the current live plus radio rows and the portal's totals, with `unchanged` set, so `run_import` reports `done` with `unchanged` and sends no `sources.changed`. A write stores the fingerprint in its own transaction, or drops it when a section kept its previous rows. `sources.remove` deletes it. Bump `SYNC_VERSION` whenever a change alters the rows a sync writes.
- Everything is written in one transaction (`xtream::sync::replace_catalogs_with`, through `CatalogWriter`, which also runs `update_counts`), so a cancel rolls every type back together.
  - `ImportSummary.channels` is live plus radio.
  - `movies` and `series` are the portal's `total_items`. No VOD items are stored, so `sources::run_import` (and a `backup.import` restore) writes these totals into `source_counts` with `catalog::set_remote_counts`; `sources.list` shows them as `movieCount` / `seriesCount`. When the portal does not answer for a total, the previously stored count is kept instead of writing 0.
- The importer (`sync::sync_source`) emits only `fetching`, `parsing`, and `saving` progress (`parsing` every 2000 rows, at most one per 250 ms, and the final count). It maps rows and saves them only while it holds the import save slot (`sources::save_slot`, see sources.md); the mapping runs on the blocking pool, not a runtime worker. Its `saving` events name the step (see sources.md): `replacing` when the source already has items, before the transaction deletes them, and `indexing` once every row is written, before the indexes and counts are rebuilt. It never emits `done` / `error` and never writes `last_refresh_at` / `last_error`.
- `stalker.sync` checks that the source exists and is a Stalker portal, then calls `sources::run_import`, the same path as `sources.refresh`. That one place holds the per-source import lock, records `last_refresh_at` or `last_error`, stores the remote movie/series totals, applies backup state parked for the source, and emits exactly one `done` or `error` plus `sources.changed`. There is no subset mode.

## Movies and series

- `offset/limit` is mapped onto portal pages. A page holds `max_page_items` rows (14 by default); the size learned from a response is remembered per source and type.
  - Pages are fetched four at a time. `limit` is clamped to 200. Once the portal has confirmed the page size (`max_page_items`), every page covering the window goes out in one wave; before that, the first page goes alone to learn the size and the rest follow. Pages of the wave past the reported total are dropped, failed or not, since some portals repeat their last page and others fail it; only a failure of a page the window needs fails the listing.
  - Sort `name` maps to `sortby=name`; every other sort maps to `added`.
  - VOD requests send `genre=0` and `category=<id>`, or `*` when there is no category.
- VOD rows flagged `is_series` get `ref.contentType = series`, so the UI opens the series view.
- Listed rows are kept for detail and playback lookups in two places:
  - in memory, an LRU of 5000 rows (season plans: an LRU of 500);
  - in the `stalker_items` table (`source_id`, `content_type`, `item_id`, `raw_json`, `category_name`, `touched_at`, `category_id`), created with `CREATE TABLE IF NOT EXISTS` by `stalker::init` at startup (or on first use) and pruned to the 20000 most recently touched rows per source. The prune keeps the rows of titles in `favorites`, `recent`, `playback_positions` or `watchlist` past the cap. Its foreign key cascades on source delete. A listed page writes its rows in the background (`stalker::spawn_persist_items`, through the user-write gate, see catalog.md or `AppState::writer`): `stalker.movies` and `stalker.series` answer without waiting for the write, which an import's catalog save could hold for seconds.
  - `category_id` is the category the row was listed under. Stalker titles are not in `items`, so parental controls read a title's category from here. On a table an older build made, `stalker::init` adds the column and backfills it from the row's own `category_id` field, else from the catalog category with the remembered `category_name`.

  A sync drops only the season plans and learned page sizes. The rows themselves go (memory and `stalker_items`, through `stalker::forget_source`) when the source is removed, when `sources.update` changes its portal URL or MAC (a rename or other edit keeps them), and, for the memory copy, when `backup.import` restores the source (a replace deletes the `sources` rows, so `stalker_items` cascades). Rows therefore survive a re-sync and an app restart. On a miss in both places, the title is taken from favorites, recent, or playback-position snapshots and searched on the portal. If that fails, the result is `NotFound` with a next step.
- Season plans:
  - Regular series: `series/get_ordered_list&movie_id=<id>` returns seasons with `cmd` and a `series: [n...]` list. An episode id is `s|<seasonId>|<n>` and plays through `create_link type=vod cmd=<season cmd> series=<n>`.
  - VOD-as-series: `vod/get_ordered_list&movie_id=<id>` lists the seasons (`is_season`), then `movie_id=<video_id>&season_id=<id>` lists the episodes (`is_episode`). An episode id is `v|<seasonId>|<episodeId>` and plays the episode's own `cmd`.

## Playback

- `create_link` sends `cmd`, `series`, `disable_ad=0`, and `download=0`.
  - A `js.error` becomes an error: `nothing_to_play` is NotFound, `limit` is Conflict, anything else is Network.
  - The returned command loses its solution prefix (`ffmpeg `, `auto `). A `/path` reply resolves against the installation base; a `?query` reply is appended to the original command.
- A static link skips `create_link`. That happens when the row carries link flags, both flags are off, and the command is a non-loopback http URL.
- A movie with `has_files` and a `/media/<id>.mpg` command first resolves its file id through `vod/get_ordered_list&movie_id`.
- `PlayerSource.kind` comes from the URL: `.m3u8` is hls, `.mpd` is dash, anything else is direct.
  - A stream on the portal's host gets the MAG User-Agent plus the portal's Referer and Origin.
  - A stream on any other host only gets a User-Agent the user configured.
- Catch-up first checks `start`: a start at or after now, or older than the channel's archive window, is Invalid, and the message names the window ("The portal keeps 7 days of archive for this channel; this programme is older."). It then finds the program at `start` in `epg/get_simple_data_table`, falling back to `itv/get_simple_data_table`. The day tables follow the cookie timezone (Europe/Paris), not UTC, so the UTC day is tried first, then the next day, then the previous day. It then calls `tv_archive/create_link cmd="auto /media/<programId>.mpg"`. When no program matches, the result is NotFound. The subtitle is the matched program's own start (UTC) and name.
- `stalker.epg` uses `itv/get_short_epg&ch_id&size`, and falls back to `itv/get_epg_info&period=6` when the portal answers without programmes. That bulk guide is fetched once per source (single flight, in its own task), cached for 5 minutes (a failed fetch for 1 minute) and dropped by `forget_source`; a row waits for it at most 10 s and otherwise gets no programmes, never an error. `limit` caps these airing and upcoming programmes. With `from` (RFC 3339, in the past), the past programmes since `from` are added from the day tables, at most 7 days back and three days at a time. The day tables follow the portal's timezone, so the table of the UTC date after today is read too (programmes after local midnight), and anything not yet started is dropped. The UI passes `from` for channels with an archive, and the ribbon lays these over XMLTV.
  - Deadline: only the short EPG (with the session) decides whether the portal answers: no answer within 20 s fails the call with Timeout "The portal at <host[:port]> did not answer in time. Try again later." The day tables stop at 40 s from the start of the call; the call then returns the short EPG plus the days read so far (each day joins as soon as its table completes).
  - A portal that does not answer the short EPG (timeout, or no HTTP answer at all) fails the call with that error straight away. There is no fallback to `get_epg_info` or the day tables after it, and the result is an error, never `[]`. Other failures (an unsupported action, an HTML page) still fall back.

## Secrets

The MAC and token only show up at `trace` level, and only as the request label (`type/action`); URLs are never logged. Error messages never include the URL or token; the unreachable-portal message names only the host. Portal sentences that echo the MAC are dropped from error messages. `accountInfo.raw` drops keys containing token, password, signature, device_id, or mac, at any depth, including objects inside arrays.

## Tests

- `cargo test -p iptv-core --lib stalker`: protocol, mapping, session, and season-plan unit tests, plus SHA-1 vectors.
- `cargo test -p iptv-core --test 'stalker_*'` (and `--test backup_import` for restores):
  - `stalker_registry.rs`: every C4 name is registered, and `init` registers the importer.
  - `stalker_flow.rs`: sync, paging, details, episodes, streams, EPG, catch-up, token expiry through the mock's `/_control/expire`, a stale cached token, account info, and the connection test. `stalker.sync` over rpc is checked to record the movie/series totals in `sources.list` and emit exactly one `done` (or one `error`, with `lastError` set and the MAC kept out of the text), and to reject non-Stalker sources without recording anything. These run against `iptv_fixtures::spawn_mock()`.
  - `stalker_fixes.rs`: covers detail lookups after a re-sync and after a restart on the same data dir, `stalker.epg` with `from`, the catch-up window checks, a closed port giving the unreachable message, the wrong-MAC message, and grandfathered MACs (kept on update, imported verbatim, sent verbatim). It also checks that failed portal totals keep the stored counts, using a proxy that fails the totals requests. Against a TCP listener that never answers, it checks that `stalker.epg` fails within its deadline with the slow-portal message (about 20 s for the short EPG, so the file takes about 40 s) and that `stalker.test` says the portal did not answer in time. A portal URL or MAC change drops the cached rows; a rename keeps them.
  - `l2_import_sync.rs`: radio and VOD category failures keep the previous rows and set `lastError`; a 404 radio answer still empties radio.
  - `backup_import.rs` (`stalker_restore_records_totals_and_plain_errors`): a restored Stalker source lists the portal totals (30 channels, 30 movies, 10 series), a wrong MAC stores the plain message without the `auth:` prefix, and a replace drops the rows remembered for the re-created id.
