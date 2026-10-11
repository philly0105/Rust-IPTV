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
3. Handshake. The request is `type=stb&action=handshake&token=&prehash=SHA1(MAC)&JsHttpRequest=1-xml` with no Bearer. It returns `token` and `random`.
4. Profile. `get_profile` sends the MAG250 fields, `metrics`, and these optional fields when present: `sn`, `device_id`, `device_id2`, `signature`, `signature2`.
   - `status=2` means the portal wants a login: the client calls `do_auth` with the username and password, then requests the profile again with `auth_second_step=1`.
   - `status=1`, or a block message, becomes `Auth`. The MAC inside the portal's text is replaced with "this MAC", and a device-id conflict gets an extra hint.
5. Token cache. The value at `app_state['stalker_token:<sourceId>']` is the JSON `{endpoint, token, random, identity}`.
   - `identity` is a fingerprint of the portal URL, MAC, serial, device ids, signatures, and login. A cached session is reused only while the fingerprint matches.
   - A cached token is trusted without a new handshake.
6. Re-handshake. An auth failure triggers one re-handshake per call, under the session mutex, and the call is retried once. Auth failures are:
   - the plain bodies `Authorization failed.`, `Access denied.`, `Unauthorized request.`
   - auth phrases inside `js`, `js.error`, or `js.msg`
   - HTTP 401 or 403

   If another task already replaced the failed token, its token is reused. If the known endpoint stops answering as a portal, discovery runs again.
7. Requests use `http::with_retry(3)`, which retries Network and Timeout errors only. An empty body counts as Network, so it is retried. The default timeout is 30 s; `get_all_channels` and `get_epg_info` get 90 s.

Headers are built with a `HeaderMap`, so each header is set once:

- `User-Agent`: MAG200, or the user's override
- `X-User-Agent: Model: MAG250; Link: WiFi`
- `Cookie: mac=<MAC>; stb_lang=en; timezone=Europe/Paris`, plus `__cfduid` derived from the serial when one is set
- `Accept: */*`
- `SN`, when a serial is set
- `Referer` and `Origin`, when configured
- `Authorization: Bearer <token>`

The legacy default serial `BEDACD4569BAF` counts as no serial.

## Import (`stalker.sync`, importer)

- Live: `itv/get_genres` (the `*` entry is skipped) and `itv/get_all_channels`. When `get_all_channels` is empty or unsupported, the importer pages `itv/get_ordered_list&genre=*` instead.
  - Channels whose genre is unknown go to the `uncategorized` category, named "Uncategorized".
  - Logos are made absolute.
  - `archive_hours` comes from `tv_archive_duration` when `tv_archive` or `enable_tv_archive` is set.
  - `extra` keeps `cmd`, `useHttpTmpLink`, `useLoadBalancing`, and `censored`.
- Radio: `radio/get_ordered_list` across all pages, into one "Radio" category. A failure here is not fatal.
- Movies and series: only `vod/get_categories` and `series/get_categories`, written with zero items, because VOD is paged live.
- Everything is written with `catalog::replace_catalog` per content type, followed by `update_counts`.
  - `ImportSummary.channels` is live plus radio.
  - `movies` and `series` are the portal's `total_items`. No VOD items are stored, so `sources::run_import` writes these totals into `source_counts` with `catalog::set_remote_counts`; `sources.list` shows them as `movieCount` / `seriesCount`.
- The importer (`sync::sync_source`) emits only `fetching`, `parsing`, and `saving` progress. It never emits `done` / `error` and never writes `last_refresh_at` / `last_error`.
- `stalker.sync` checks that the source exists and is a Stalker portal, then calls `sources::run_import`, the same path as `sources.refresh`. That one place holds the per-source import lock, records `last_refresh_at` or `last_error`, stores the remote movie/series totals, applies backup state parked for the source, and emits exactly one `done` or `error` plus `sources.changed`. There is no subset mode.

## Movies and series

- `offset/limit` is mapped onto portal pages. A page holds `max_page_items` rows (14 by default); the size learned from a response is remembered per source and type.
  - Pages are fetched four at a time. `limit` is clamped to 200.
  - Sort `name` maps to `sortby=name`; every other sort maps to `added`.
  - VOD requests send `genre=0` and `category=<id>`, or `*` when there is no category.
- VOD rows flagged `is_series` get `ref.contentType = series`, so the UI opens the series view.
- Listed rows are cached in memory (up to 5000 entries) for detail and playback lookups. On a cache miss, the title is taken from favorites, recent, or playback-position snapshots and searched on the portal. If that fails, the result is `NotFound` with a next step.
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
- Catch-up finds the program at `start` in `epg/get_simple_data_table`, falling back to `itv/get_simple_data_table`. It then calls `tv_archive/create_link cmd="auto /media/<programId>.mpg"`. When no program matches, the result is NotFound.
- `stalker.epg` uses `itv/get_short_epg&ch_id&size`, and falls back to `itv/get_epg_info&period=6`.

## Secrets

The MAC and token only show up at `trace` level, and only as the request label (`type/action`); URLs are never logged. Error messages never include the URL or token. Portal text that echoes the MAC is redacted. `accountInfo.raw` drops keys containing token, password, signature, device_id, or mac.

## Tests

- `cargo test -p iptv-core --lib stalker`: protocol, mapping, session, and season-plan unit tests, plus SHA-1 vectors.
- `cargo test -p iptv-core --test 'stalker_*'`:
  - `stalker_registry.rs`: every C4 name is registered, and `init` registers the importer.
  - `stalker_flow.rs`: sync, paging, details, episodes, streams, EPG, catch-up, token expiry through the mock's `/_control/expire`, a stale cached token, account info, and the connection test. `stalker.sync` over rpc is checked to record the movie/series totals in `sources.list` and emit exactly one `done` (or one `error`, with `lastError` set and the MAC kept out of the text), and to reject non-Stalker sources without recording anything. These run against `iptv_fixtures::spawn_mock()`.
