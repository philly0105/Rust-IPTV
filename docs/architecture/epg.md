# EPG (XMLTV)

Code: `crates/iptv-core/src/epg/`. Tests: `crates/iptv-core/tests/epg_parser.rs`, `epg_store.rs`, `epg_http.rs`, `epg_perf.rs` (check 5), `epg_limits.rs` (hostile-size feeds), `epg_clear_all.rs`, `epg_now_next_offset.rs` and `l3_serve_epg_brief.rs` (`withDescription`), plus unit tests in `xmltv.rs` and `ingest.rs`.

## Layout

| File | Role |
| --- | --- |
| `mod.rs` | Public async API behind the RPC commands. `init`. |
| `rpc.rs` | Registers the twelve `epg.*` commands. |
| `fetch.rs` | Classifies a URL as remote or local, downloads remote bodies to a temp file, and opens a decoding reader (gzip, BOM). |
| `xmltv.rs` | Streaming quick-xml parser and XMLTV date parsing. |
| `store.rs` | `epg_sources` bookkeeping, the configured-URL merge, the staging writer, the atomic swap, pruning. |
| `ingest.rs` | Refresh runtime: per-URL claim, global semaphore, progress events, boot scheduler. |
| `resolve.rs` | Maps an item to an XMLTV channel id. |
| `query.rs` | Programme reads (now/next, ranges, grid) and channel search. |
| `search.rs` | Programme title search (`epg.search`) and its index; see [guide-search.md](guide-search.md). |

## Configured URLs (`epg.sources`)

The list is `settings.epgUrls` (origin `settings`) followed by every source's `epg_json` `detectedUrls` and `manualUrls`, minus its `disabledUrls` (origin `source`, with `sourceId`). Sources are taken in `position, created_at, id` order. URLs are trimmed and deduplicated, and the first occurrence wins. A remote fetch for a source URL sends that source's `config_json.headers` (user agent, referrer). Status, ETag and counts come from `epg_sources`. A URL with no row yet reads as `idle`, enabled, with zero counts.

`epg.setEnabled` only accepts configured URLs. Disabled URLs are excluded from queries, resolution and the scheduler. Their data is kept, so re-enabling them is instant. Enabling a URL that has no data starts a refresh.

## Fetch

- `http(s)://` is streamed with reqwest `bytes_stream` to `<data_dir>/tmp/epg-<uuid>.part`, with a 2 GB cap.
  - `http::with_retry` gives up to 3 attempts on transient failures.
  - When the previous fetch succeeded with data and an ETag is stored, the request carries `If-None-Match`. A 304 only updates `last_fetch_at`.
  - Non-2xx responses go through `http::status_error`: 404 maps to NotFound, 401/403 map to Auth.
- `file://` URLs and plain paths are read in place on desktop. In server mode they are refused with Unsupported (also up front in `settings.update`, source EPG links and backup import), and a guide detected from a source trusts that source's own `host:port` like the playlist.
- `open_reader` detects gzip by magic bytes `1f 8b`, independent of name and `Content-Encoding`, and uses `MultiGzDecoder`. Zip, xz and bzip2 are refused with a clear Unsupported error. A UTF-8 BOM is skipped.
- Logs only ever show `crate::logging::redact_url(url)`, because Xtream `xmltv.php` URLs carry credentials.
- Temp files are removed after ingest, and leftovers from a crash are cleared at boot.

## Parser (`xmltv::parse`)

The parser is a pull parser over `BufRead`. Memory use stays flat whatever the file size or line length, and the read buffer shrinks back once it has grown past 1 MB. Items go to a sink callback, so nothing is collected.

Size limits, enforced by a byte-level guard between the decoded reader and quick-xml (which would otherwise buffer a whole node before the length caps below apply):

- Document: more than `MAX_DOCUMENT_BYTES` (2 GB) read after decompression aborts the ingest with an Invalid error, even if some data was already parsed. Stored data is left alone. This caps gzip bombs.
- Node: a text, CDATA or comment node passes only its first `MAX_NODE_BYTES` (4 MB) to quick-xml. The rest is read and discarded up to the node's end, and parsing continues. A 300 MB title in a 1.4 MB `.xml.gz` ingests with a peak RSS delta of about 5 MB.
- Tag: a single tag (attributes included) larger than `MAX_NODE_BYTES` is an Invalid error, because cutting it would corrupt the document. A `<!DOCTYPE ...>` declaration is capped the same way, and a processing instruction is cut like a text node.
- The byte filter splits nodes exactly where quick-xml 0.37 splits events (`>` inside a quoted attribute value, `<`/`>` nesting in a DOCTYPE subset, `<?` to the first `?>`, `<![` to `]]>`, `<!-` plus one byte to `-->`), so no single event can grow past the cap (`epg_limits::single_event_bombs_stay_under_the_node_cap`).
- Download: body chunks are read through `http::next_body_chunk`, so a server that stops mid-body fails after `BODY_IDLE_TIMEOUT` (20 s) with a Timeout that names the host.
- Nesting, ids and held programmes: past `MAX_OPEN_DEPTH` (256) open elements or 64 KB of open names, quick-xml's stack of open names is dropped and parsing continues, so unclosed tags (a stray `<br>`, or a `<a><a>...` bomb) cost no memory. A channel id or programme `channel` over `MAX_ID_BYTES` (1 KB) skips the element (counted in `skippedInvalid`), and an icon URL over `MAX_URL_BYTES` (4 KB) is dropped. Stop-less programmes starting after the window are skipped at once; at most `MAX_PENDING` (100k, or 64 MB) wait for their next programme, and past that the oldest gets start + 1 h (`fix3_robust_epg`).
- `xmltv::parse_with_limits` takes both limits explicitly; `parse` uses the constants.

- `<channel id>`: the first non-empty `display-name` and the first non-empty `icon src`.
- `<programme start stop channel>`: the first non-empty `title`, `desc`, `category` and `icon src`, whatever their `lang`. Other children (`sub-title`, `credits`, and so on) are skipped.
- Text: XML, numeric and common HTML entities (`&nbsp;`, `&eacute;`, and so on) are decoded, and a bare `&` is kept as is. CDATA is kept literally. Whitespace runs, NBSP included, collapse to one space. Lengths are capped: title 512 characters, desc 8192, others 1024.
- Encoding: UTF-8 by default. ISO-8859-1 or Latin-1 is used when declared.
- Dates: `YYYYMMDD[hh[mm[ss]]][.frac] [offset]`, where the offset can be `+HHMM`, `+HH:MM`, `+HH`, `Z`, `UTC` or `GMT`. Missing offsets mean UTC. RFC 3339 is accepted as a fallback. The result is stored as unix seconds (UTC).
- Missing `stop`: the stop is inferred as the next programme's start on the same channel, or start + 1 h if nothing follows.
- Invalid rows (bad start, no channel, `stop <= start`) are counted and skipped. When more than half of the programmes seen are skipped this way, the URL's stored `error` is exactly `epg_unreadable:<skipped>:<seen>` (two integers, no other text; C15). The settings EPG section matches `^epg_unreadable:(\d+):(\d+)$` and shows the translated `epgUnreadable` string with those counts; any other error text is shown as it is.
- Window: only programmes with `stop > now - 2 days` and `start <= now + 14 days` are kept.
- Overlapping programmes are stored as they are. Queries clip them (see below).
- A cut-off feed is rejected and the old guide kept: a document that opens `<tv>` but ends before `</tv>` (cleanly or with a read error, a cut gzip stream included; a gzip stream cut before its first byte too) fails as Invalid with `xmltv::CUT_OFF_MESSAGE` ("The guide download was cut off; kept the previous guide."). The staging rows are discarded, so the stored programmes and the stored ETag stay (a later 304 cannot keep a partial guide), and the stored error adds "Refresh to try again.". An XML error after `</tv>`, or in a document without `<tv>`, keeps everything read before it and records a warning (`ParseStats.truncated`). A document without `<tv>`, such as an HTML error page, or with no channels or programmes is rejected as Invalid, and the stored data is left alone.

## Storage: staging and swap

Tables (C3): `epg_sources`, `epg_channels`, `epg_programs` (start and stop are unix seconds), and `epg_channel_map`. Migration 0007 adds a unique index on `(epg_url, channel_id, start)`; on upgrade it drops and recreates `epg_programs` and clears each feed's `last_fetch_at`, `etag` and `program_count`, so the cached guide is empty until the next scheduler pass downloads every feed again. Feeds, channel lists and mappings stay.

1. `begin_staging` creates a hidden `epg_sources` row keyed `"<url>\u{1}staging"` (`origin='staging'`, `enabled=0`) and clears earlier staged rows.
2. `StagingWriter` buffers rows and flushes 2000 per IMMEDIATE transaction with cached statements: `INSERT OR IGNORE` for channels, `INSERT` for programmes. During the load the pooled connection runs with a 64 MB page cache and WAL autocheckpoint disabled. Both settings are restored afterwards, and a TRUNCATE checkpoint (`db::checkpoint_truncate`) folds the load back into the database file and empties the WAL, which a 100-250 MB guide grows the most. It never waits: with the busy handler off, a busy reader or writer turns it into a passive checkpoint, and a later one truncates the WAL.
3. `commit_staging` is one transaction. It deletes the URL's live rows, re-keys the staged rows to the URL, deletes the staging row, and sets `status=ok`, the counts, `last_fetch_at` and the ETag.
4. Any error discards the staging rows. Old data stays visible throughout, because readers only join `epg_sources` rows with `enabled=1 AND origin<>'staging'`.

At boot, leftover staging rows are removed and rows stuck in `fetching` are reset to `idle`. Each scheduler pass prunes rows and data for URLs that are no longer configured.

## Refresh runtime

- `epg.refresh {url?}` returns immediately. The work runs on `tokio::spawn`. Omitting `url` refreshes every enabled configured URL. A URL that is not configured returns NotFound.
- Each URL runs at most once at a time (`EpgRuntime.running`). A second request while one is running is ignored by `spawn_refresh`, and `refresh_now` returns Conflict.
- A global semaphore allows 2 concurrent refreshes. Parsing and inserts run on `spawn_blocking` with a pooled connection.
- Events:
  - `epg.progress {url, phase, programs, message?}`, where `phase` is `fetching`, `parsing` (at most every 250 ms), `saving`, `done` or `error`.
  - `epg.changed {}` after every finished refresh, mapping change or enable change. When only a URL's status moved (a refresh started, or the server answered 304 and the stored guide was kept) the payload is `{reason: 'status'}`: the runtime generation is not bumped, and clients refetch `epg.sources` only, not their now/next and grid queries (`invalidationPrefixes` in `src/api/query.ts`).
- Errors are stored in `epg_sources.error` as a user message with a next step.
- `init` waits 10 s, then every 30 s refreshes URLs that have never been fetched or were last fetched more than 12 h ago. URLs in error are retried after 30 min.

## Resolution (`epg.resolve`)

Resolution tries these in order:

1. Manual: an `epg_channel_map` row. A row with a NULL id means "explicitly unmapped" and returns `via: manual` with no id.
2. Item: `items.epg_channel_id`. It matches declared channel ids case-insensitively, also with a trailing `.xx`/`.xxx` stripped, and falls back to any channel id that has programmes even if it was never declared.
3. Name: `normalize_name(title)` against normalized display names and ids. Normalization lowercases, strips country prefixes (`UK:`, `|UK|`, `[UK]`, `UK -`) and quality suffixes (`HD`, `FHD`, `4K`, `HEVC`, `1080`, `50fps`, `backup`, and so on), maps `&` to `and` and `+` to `plus`, and keeps only alphanumerics. An exact match comes first. Otherwise strsim `normalized_levenshtein >= 0.9` is used, for keys of at least 9 characters (`MIN_FUZZY_KEY`): two different keys score at most `1 - 1/longer` and `shorter/longer`, so a shorter key can only match exactly and skips the scan of every guide channel.
4. Otherwise `via: none`.

The channel directory is cached and rebuilt when the generation counter changes, which happens after a refresh that stored data (not a 304), a prune or an enable change. One caller rebuilds it while concurrent callers wait for that build (the cache lock is held during the load). Each directory remembers the fuzzy result per title (up to 50,000, then cleared), so now/next and grid refetches do not rescan the guide channels for the same unmatched names. Items, manual mappings, `has_programmes` and `tvg-shift` are read with cached prepared statements.

## Queries

- `epg.nowNext {refs}`, `epg.programs {ref, from, to}`, `epg.grid {refs, from, to}`:
  - Each ref is resolved once per call.
  - `from` and `to` are RFC 3339. A range must be positive and at most 31 days.
  - Programme times are returned as RFC 3339 UTC.
  - A channel's guide shift moves its programmes: the range is read at `[from - shift, to - shift)` and every time comes back moved by the shift (`query::item_shift`, `rows`). `epg.search` applies the same shift to its hits (guide-search.md). The shift is the channel's own shift when one is set (`epg.setChannelShift`, the mapping dialog; table `epg_channel_shift`, migration 0021), else its `tvg-shift` (`extraJson.tvgShift` from the M3U import; hours, signed or fractional, ignored beyond 24), plus the source's shift (`EpgLinks.shiftMinutes` in `sources.epg_json`, set with `sources.update {patch: {epg: {shiftMinutes}}}` from the source dialog's Guide tab; 0 removes it). Both are whole minutes within 720 either way (`query::MAX_SHIFT_MINUTES`). The global `settings.epgOffsetMinutes` comes on top in the UI (below). Changing either emits `epg.changed`. The per-channel row is keyed by catalog id like the manual mapping, so a refresh keeps it, the m3u remapper moves it (`REF_TABLES`) and removing the source cascades it; backups do not carry it (the source shift travels with the source's EPG links).
  - Rows from all enabled URLs are merged in start order. Zero-length rows are dropped, equal starts are deduplicated, and overlaps are clipped to the next start.
  - A channel's programmes come from one URL (`FEED_SQL`): the first enabled URL by rowid with a programme running in the range. Each URL is probed once through the `(epg_url, channel_id, start)` index, read backwards from the range end, so the probe usually stops at its first row instead of reading the whole 36 h lookback of every feed.
  - At most 3000 programmes are returned per channel.
  - `epg.nowNext` and `epg.grid` also take `withDescription` (default true). Only `false` leaves `description` off every programme: the reads select `NULL` in its place (`BEFORE_BRIEF_SQL`, `INSIDE_BRIEF_SQL`) with the same index plan, which takes about half the bytes off a guide page or a now/next list. `epg.programs` always returns descriptions. Callers that never show one pass `false`: the Live list pages (`usePagedChannels`), lists (`useListChannels`, `ListRails`), the dashboard, multiview (`useWallData`), the fullscreen channel panel's guide (`ChannelPanelGuide`), channel history, and every /epg grid query and prefetch (`gridArgs`). The playing channel's call in `LivePage` keeps the default, because it feeds the ribbon, which shows descriptions; the player's `src/features/player/nowNext.ts` asks under the same query key, so a zap asks once. The /epg programme popover (`ProgramPopover`) asks `epg.programs` for the programme's own span when it opens (`useProgramDescription` in `src/features/live/guide/programDescription.ts`), prefetched on the press that opens it, and shows the text when it arrives; a programme that already has a description, or comes from the provider's guide (`fromProvider`), needs no request.
  - `epg.nowNext` also takes `offsetMinutes` (`settings.epgOffsetMinutes`, -720..720). The UI shows every programme moved by the offset, so "now" is the programme airing at `now - offset`; times still come back unshifted and the UI shifts them, so channel rows, the dashboard rail and the ribbon agree. On Stalker sources the UI's row previews treat a `stalker.epg` timeout or network error as a source-wide outage: the preview queue pauses that source (30 s, doubling to 5 min), rows say the guide is not answering, and one "Try again" asks at once. The pause and the cached answers belong to the source, not to one view: the live list, the /epg grid and a moved grid window share them (answers keyed by channel, `limit` and `from`). The /epg grid asks `epg.grid` (and the Stalker archive `from`) for its display window moved back by the offset, then shifts the answer for display.
- /epg grid windows (`src/features/live/components/EpgGridPage.tsx`): `epg.grid` is asked per chunk of 40 channel rows, for the one or two chunks the rendered rows (visible plus overscan) span. The window is at least 6 h and spans the page width plus 1200 px of scroll room (`GRID_SCROLL_ROOM_PX`: 3 h of track plus one 150 px slot at each edge). Scrolling horizontally toward an edge, within one slot (150 px) of it, moves the window 3 h that way (`GRID_EXTEND`) and moves the scroll position by the same distance, so the view holds still; an arrow key that takes the cursor past the window does the same. A cursor within two programmes of the window's edge prefetches the window past it, and while the cursor's row has no answer yet for the window on screen and nothing shown covers the cursor's time, a left or right press is held back (unless the guide failed) rather than skipping a programme it cannot see. These moves replace the history entry instead of adding one. While the scroll moves toward an edge and is within a screen width of its edge zone, the visible chunks' `epg.grid` for the neighbouring window is prefetched (fresh for 5 min, like the grid's own answers), so it arrives drawn. While the next chunk or window loads, the previous `epg.grid` answer stays shown (`keepPrevious`): rows it has programmes for keep them and the no-guide notice does not blink; rows it does not cover show as loading. Below 640 px of viewport width (`GUIDE_BAR_STACK_PX`) the channel column is 72 px (`GRID_CHANNEL_COMPACT`, otherwise 168 px, or 220 px from 1024 px) and shows the logo over the channel number, with the name as the button's label and tooltip, and the programme dialog opens as a bottom sheet over a scrim instead of a popover beside the cell.
- The /epg page's toolbar (`GuideToolbar`): the group select lists All channels, Favorites, each custom list ("List: <name>") and then the source's groups. Favorites (`view=favorites`) shows the source's favorite live channels in favorites order (`favorites.list`, with `catalog.item` for the rows on screen); a list (`view=list:<id>`) shows the list's available live channels of this source in list order (`lists.items`). A view and a group replace each other in the URL; a view stays when the source changes, and a search hit opens in all channels (`useGuideViewChannels` in `src/features/live/guide/viewChannels.ts`). Zoom out and Zoom in step the time scale through 75, 110, 150, 225 and 300 px per 30-minute slot (`GUIDE_ZOOM_SLOT_PX`, 150 by default, kept in localStorage `tsrust.guideZoom`); Ctrl+scroll over the grid does the same, one step per 150 ms (`WHEEL_ZOOM_MS`), and the time at the track's visible start holds still. The window, the scroll room and the now line's lead follow the step (`gridWindowFor`, `gridScrollRoomPx`, `nowLead`). A phone-width toolbar has no zoom buttons.
- The /epg channel row menu (`GuideRowMenu`) has the Live page's entries: Play, Browse archive, Add to (or Remove from) favorites, multi-view, lists, rename and hide, "Match guide channel" (the Live page's `EpgMappingDialog`) and the parental lock. When the guides hold programmes (`epg.sources`: an enabled feed with `programCount > 0`) but no row in the window has any, the floating notice says no channel matches a loaded guide and its button opens the mapping dialog for the cursor row's channel; with no programmes loaded it still points at EPG settings. Per-feed match counts are not shown: matching includes the fuzzy name match (resolve.rs), which would mean resolving every channel of every source.
- Provider fallback: on Xtream sources, channels with no XMLTV programme airing show the panel's short EPG (`epg.shortEpg`, see xtream.md) in the ribbon, the channel rows' now line, the fullscreen channel panel and empty /epg grid rows. The grid asks only while its window reaches now to now + 6 h (`SHORT_EPG_REACH_MS`), since the short EPG holds the airing programme and a few after it, and only for the visible rows once they have held still for 200 ms (`SHORT_EPG_SETTLE_MS`); a Stalker grid asks the portal's guide for the same settled rows. Fallback programmes are shifted by the guide offset like XMLTV ones and carry `fromProvider`, which the ribbon and the programme dialog show as "From the provider's guide". A Stalker portal's own programmes (`stalker.epg`, merged over XMLTV in the ribbon and the grid) carry it too. Programmes with `fromProvider` offer no "Record series", since series rules only match the XMLTV guide (recording.md). `settings.epgShortFallback` (default on, Settings > Guide) turns it off.
- Archive browser (`/live/archive/:sourceId/:channelId`, lazy): a day picker over the channel's archive window and that day's programmes. The list comes from XMLTV (`epg.programs`); when XMLTV has nothing for the day it falls back to `catchup.programs` (Xtream archive table), then the short EPG for today; Stalker uses `stalker.epg` with `from` set to the day's start. Past programmes play through catch-up, the airing one offers "Watch from start", and future ones are disabled. A day that none of these fill offers hour-long slots instead (`archiveHourSlots` in `src/features/live/lib/archive.ts`): every whole local hour from the archive window's start (`durationHours`, else the whole days `archiveDayCount` gives) or the day's start up to the hour airing now, each played (or downloaded) through the same catch-up URL builders from its start for 60 minutes. Entry points: the live context menu, the fullscreen channel panel and the programme dialog's "Browse archive".
- `epg.channelsSearch {query, limit?}` is a LIKE search on display name or id. Results are ordered by name prefix, then id prefix, then length. The default limit is 50 and the maximum is 500.
- `epg.search {sourceId, query, from?, to?, limit?}` finds programmes by title on a source's channels. It is documented in [guide-search.md](guide-search.md), with the index it reads and the series rules the guide adds from a hit (recording.md).
- `epg.setMapping {ref, epgChannelId|null}` and `epg.clearMapping {ref}` write or delete the manual row.
- `epg.setChannelShift {ref, minutes|null}` sets the channel's own guide shift (minutes, -720..720; `null` removes it, so `tvg-shift` applies again). `epg.resolve` returns it as `shiftMinutes`, which `EpgMappingDialog` shows and edits ("Time shift for this channel"; blank clears it, 0 overrides a `tvg-shift` with none).
- `epg.clearAll` deletes every programme and guide channel in one transaction and resets each URL to `idle` with zero counts, no error and no ETag (so the next refresh downloads the whole feed). URLs, enabled flags, `last_fetch_at` (so the scheduler does not re-download at once) and manual mappings are kept, as are the staging rows of a refresh that is running. It bumps the runtime generation and emits `epg.changed`.

## Limits

| Limit | Value |
| --- | --- |
| Batch size | 2000 rows per transaction |
| Concurrency | 2 refreshes globally, 1 per URL |
| Download cap | 2 GB |
| Window | now - 2 d to now + 14 d |
| Staleness | 12 h (30 min retry after an error) |
| Performance (check 5) | 120 MB XMLTV, 288k programmes: about 7.2 s in release, peak RSS delta 75 MB (most of it the bulk-load page cache) |
