# EPG (XMLTV)

Code: `crates/iptv-core/src/epg/`. Tests: `crates/iptv-core/tests/epg_parser.rs`, `epg_store.rs`, `epg_http.rs`, `epg_perf.rs` (check 5), and `epg_limits.rs` (hostile-size feeds), plus unit tests in `xmltv.rs` and `ingest.rs`.

## Layout

| File | Role |
| --- | --- |
| `mod.rs` | Public async API behind the RPC commands. `init`. |
| `rpc.rs` | Registers the ten `epg.*` commands. |
| `fetch.rs` | Classifies a URL as remote or local, downloads remote bodies to a temp file, and opens a decoding reader (gzip, BOM). |
| `xmltv.rs` | Streaming quick-xml parser and XMLTV date parsing. |
| `store.rs` | `epg_sources` bookkeeping, the configured-URL merge, the staging writer, the atomic swap, pruning. |
| `ingest.rs` | Refresh runtime: per-URL claim, global semaphore, progress events, boot scheduler. |
| `resolve.rs` | Maps an item to an XMLTV channel id. |
| `query.rs` | Programme reads (now/next, ranges, grid) and channel search. |

## Configured URLs (`epg.sources`)

The list is `settings.epgUrls` (origin `settings`) followed by every source's `epg_json` `detectedUrls` and `manualUrls`, minus its `disabledUrls` (origin `source`, with `sourceId`). Sources are taken in `position, created_at, id` order. URLs are trimmed and deduplicated, and the first occurrence wins. A remote fetch for a source URL sends that source's `config_json.headers` (user agent, referrer). Status, ETag and counts come from `epg_sources`. A URL with no row yet reads as `idle`, enabled, with zero counts.

`epg.setEnabled` only accepts configured URLs. Disabled URLs are excluded from queries, resolution and the scheduler. Their data is kept, so re-enabling them is instant. Enabling a URL that has no data starts a refresh.

## Fetch

- `http(s)://` is streamed with reqwest `bytes_stream` to `<data_dir>/tmp/epg-<uuid>.part`, with a 2 GB cap.
  - `http::with_retry` gives up to 3 attempts on transient failures.
  - When the previous fetch succeeded with data and an ETag is stored, the request carries `If-None-Match`. A 304 only updates `last_fetch_at`.
  - Non-2xx responses go through `http::status_error`: 404 maps to NotFound, 401/403 map to Auth.
- `file://` URLs and plain paths are read in place.
- `open_reader` detects gzip by magic bytes `1f 8b`, independent of name and `Content-Encoding`, and uses `MultiGzDecoder`. Zip, xz and bzip2 are refused with a clear Unsupported error. A UTF-8 BOM is skipped.
- Logs only ever show `crate::logging::redact_url(url)`, because Xtream `xmltv.php` URLs carry credentials.
- Temp files are removed after ingest, and leftovers from a crash are cleared at boot.

## Parser (`xmltv::parse`)

The parser is a pull parser over `BufRead`. Memory use stays flat whatever the file size or line length, and the read buffer shrinks back once it has grown past 1 MB. Items go to a sink callback, so nothing is collected.

Size limits, enforced by a byte-level guard between the decoded reader and quick-xml (which would otherwise buffer a whole node before the length caps below apply):

- Document: more than `MAX_DOCUMENT_BYTES` (2 GB) read after decompression aborts the ingest with an Invalid error, even if some data was already parsed. Stored data is left alone. This caps gzip bombs.
- Node: a text, CDATA or comment node passes only its first `MAX_NODE_BYTES` (4 MB) to quick-xml. The rest is read and discarded up to the node's end, and parsing continues. A 300 MB title in a 1.4 MB `.xml.gz` ingests with a peak RSS delta of about 5 MB.
- Tag: a single tag (attributes included) larger than `MAX_NODE_BYTES` is an Invalid error, because cutting it would corrupt the document.
- `xmltv::parse_with_limits` takes both limits explicitly; `parse` uses the constants.

- `<channel id>`: the first non-empty `display-name` and the first non-empty `icon src`.
- `<programme start stop channel>`: the first non-empty `title`, `desc`, `category` and `icon src`, whatever their `lang`. Other children (`sub-title`, `credits`, and so on) are skipped.
- Text: XML, numeric and common HTML entities (`&nbsp;`, `&eacute;`, and so on) are decoded, and a bare `&` is kept as is. CDATA is kept literally. Whitespace runs, NBSP included, collapse to one space. Lengths are capped: title 512 characters, desc 8192, others 1024.
- Encoding: UTF-8 by default. ISO-8859-1 or Latin-1 is used when declared.
- Dates: `YYYYMMDD[hh[mm[ss]]][.frac] [offset]`, where the offset can be `+HHMM`, `+HH:MM`, `+HH`, `Z`, `UTC` or `GMT`. Missing offsets mean UTC. RFC 3339 is accepted as a fallback. The result is stored as unix seconds (UTC).
- Missing `stop`: the stop is inferred as the next programme's start on the same channel, or start + 1 h if nothing follows.
- Invalid rows (bad start, no channel, `stop <= start`) are counted and skipped.
- Window: only programmes with `stop > now - 2 days` and `start <= now + 14 days` are kept.
- Overlapping programmes are stored as they are. Queries clip them (see below).
- A truncated document keeps everything read before the XML error and records a warning. A document without `<tv>`, such as an HTML error page, or with no channels or programmes is rejected as Invalid, and the stored data is left alone.

## Storage: staging and swap

Tables (C3): `epg_sources`, `epg_channels`, `epg_programs` (start and stop are unix seconds), and `epg_channel_map`.

1. `begin_staging` creates a hidden `epg_sources` row keyed `"<url>\u{1}staging"` (`origin='staging'`, `enabled=0`) and clears earlier staged rows.
2. `StagingWriter` buffers rows and flushes 2000 per IMMEDIATE transaction with cached statements: `INSERT OR IGNORE` for channels, `INSERT` for programmes. During the load the pooled connection runs with a 64 MB page cache and WAL autocheckpoint disabled. Both settings are restored afterwards and a passive checkpoint runs.
3. `commit_staging` is one transaction. It deletes the URL's live rows, re-keys the staged rows to the URL, deletes the staging row, and sets `status=ok`, the counts, `last_fetch_at` and the ETag.
4. Any error discards the staging rows. Old data stays visible throughout, because readers only join `epg_sources` rows with `enabled=1 AND origin<>'staging'`.

At boot, leftover staging rows are removed and rows stuck in `fetching` are reset to `idle`. Each scheduler pass prunes rows and data for URLs that are no longer configured.

## Refresh runtime

- `epg.refresh {url?}` returns immediately. The work runs on `tokio::spawn`. Omitting `url` refreshes every enabled configured URL. A URL that is not configured returns NotFound.
- Each URL runs at most once at a time (`EpgRuntime.running`). A second request while one is running is ignored by `spawn_refresh`, and `refresh_now` returns Conflict.
- A global semaphore allows 2 concurrent refreshes. Parsing and inserts run on `spawn_blocking` with a pooled connection.
- Events:
  - `epg.progress {url, phase, programs, message?}`, where `phase` is `fetching`, `parsing` (at most every 250 ms), `saving`, `done` or `error`.
  - `epg.changed {}` after every finished refresh, mapping change or enable change.
- Errors are stored in `epg_sources.error` as a user message with a next step.
- `init` waits 10 s, then every 30 s refreshes URLs that have never been fetched or were last fetched more than 12 h ago. URLs in error are retried after 30 min.

## Resolution (`epg.resolve`)

Resolution tries these in order:

1. Manual: an `epg_channel_map` row. A row with a NULL id means "explicitly unmapped" and returns `via: manual` with no id.
2. Item: `items.epg_channel_id`. It matches declared channel ids case-insensitively, also with a trailing `.xx`/`.xxx` stripped, and falls back to any channel id that has programmes even if it was never declared.
3. Name: `normalize_name(title)` against normalized display names and ids. Normalization lowercases, strips country prefixes (`UK:`, `|UK|`, `[UK]`, `UK -`) and quality suffixes (`HD`, `FHD`, `4K`, `HEVC`, `1080`, `50fps`, `backup`, and so on), maps `&` to `and` and `+` to `plus`, and keeps only alphanumerics. An exact match comes first. Otherwise strsim `normalized_levenshtein >= 0.9` is used, for keys of at least 4 characters.
4. Otherwise `via: none`.

The channel directory is cached and rebuilt when the generation counter changes, which happens after a refresh or an enable change. Items are read with plain SQL from `items`.

## Queries

- `epg.nowNext {refs}`, `epg.programs {ref, from, to}`, `epg.grid {refs, from, to}`:
  - Each ref is resolved once per call.
  - `from` and `to` are RFC 3339. A range must be positive and at most 31 days.
  - Programme times are returned as RFC 3339 UTC.
  - Rows from all enabled URLs are merged in start order. Zero-length rows are dropped, equal starts are deduplicated, and overlaps are clipped to the next start.
  - At most 3000 programmes are returned per channel.
- `epg.channelsSearch {query, limit?}` is a LIKE search on display name or id. Results are ordered by name prefix, then id prefix, then length. The default limit is 50 and the maximum is 500.
- `epg.setMapping {ref, epgChannelId|null}` and `epg.clearMapping {ref}` write or delete the manual row.
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
