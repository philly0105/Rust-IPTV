# M3U

Code: `crates/iptv-core/src/m3u/`. Tests: `crates/iptv-core/tests/m3u_parse.rs`, `m3u_import.rs`, `l1_m3u_import.rs` (remap, empty playlist, `IMPORT_VERSION`, `connecting` and `unchanged` progress), `m3u_disk_text.rs`, `m3u_channel_fields.rs`, `m3u_perf.rs` (check 4), with helpers in `m3u_support.rs`.

## Layout

| File | Role |
| --- | --- |
| `parser.rs` | `M3uReader<R: BufRead>`, a streaming iterator of `M3uEntry`, plus `M3uHeader`, `ParseStats` and `parse_str`. |
| `importer.rs` | `M3uImporter` (the m3u `Importer`), `import_source`, `RowBuilder`, `classify`, id helpers. |
| `rpc.rs` | `m3u.raw` and `m3u.parsePreview`. |
| `mod.rs` | `init`, which registers the importer and removes `tmp/m3u-*.part` files left by a crash. |

## Parser

The reader works on any `BufRead` and holds one line at a time. Lines are capped at 64 KB; a longer URL line is skipped. Edge cases handled, most taken from the old app's `iptv-playlist-parser` and `m3u-utils`:

- UTF-8 BOM, LF, CRLF and CR-only line endings (a lone `\r` ends a line; a CRLF split across reads is one break), and a case-insensitive `#EXTM3U`.
- Header EPG URLs from `url-tvg`, `x-tvg-url` and `tvg-url`. Comma-separated lists are split and de-duplicated. Repeated `#EXTM3U` lines in concatenated playlists are merged.
- Attribute values in double or single quotes, which may contain commas, and unquoted values. The name starts after the first comma outside quotes.
- `#EXTINF:0`, `-1` and missing durations.
- An empty name falls back to `tvg-name`, then the last URL path segment, then the URL.
- `#EXTGRP` overrides `group-title`. `#EXTVLCOPT:http-user-agent` and `http-referrer` set request headers. `#KODIPROP` lines before `#EXTINF` attach to that entry, and lines between `#EXTINF` and its URL attach to the same entry.
- `url|User-Agent=..&Referer=..` suffixes are cut off the URL and become headers.
- A bare `scheme://` line without `#EXTINF` becomes an entry.
- A dangling `#EXTINF` (no URL before the next one), junk text and overlong URLs are skipped and counted in `ParseStats.skipped`. They never fail the import.
- Duplicate URLs are kept as separate entries.

## Import

`import_source(state, source)`:

1. Get the bytes and their sha256. Every stored sha (`playlist_sha`, `playlist_hasher`) is seeded with `tsrust-m3u-import-v{IMPORT_VERSION}`, so bumping `IMPORT_VERSION` (2 now) re-imports every unchanged playlist (URL, file and pasted text) once on its next refresh and applies parser or classifier fixes; bump it whenever a change alters the rows an import writes. A sha stored by an older importer never matches.
   - `text`: read `m3u_raw.raw`.
   - `file` and `file://` URLs: hashed in a streaming pass.
   - `http(s)` URLs: `fetch_to_file` sends the request with the source's headers through `http::apply_source_headers` and retries network errors and 5xx (3 attempts), but not a timeout: a head that does not arrive within `PLAYLIST_HEADER_TIMEOUT` (120 s) comes from a slow generator and fails at once, and neither does a body that stalls after the head: body chunks are read through `http::next_body_chunk` with `BODY_IDLE_TIMEOUT` (20 s), and the stall fails once with a Timeout naming the host. A body that averages under 1 KB/s over a 60 s window (`m3u/body.rs` `MinRate`) fails the same way, so a drip-fed server cannot hold the import open. `sources.remove`, and a `sources.update` that changes the source's settings, cancel the running import through the per-source token `sources::import_cancel` (no waiting behind the import lock), and the cancelled download deletes its temp file. A non-2xx status names the host and adds a next step (`playlist_status_error`). In the first import of `sources.add` (`http::interactive`, see sources.md) the connection gets 3 s instead of 10 s, and a connect timeout ends the download at once, without retries, with "Could not reach <host>. The server did not answer. Check the address and port, and that the server is online, then try again." It streams `bytes_stream()` into `data_dir/tmp/m3u-<id>-<uuid>.part` and hashes as it writes. The temp file is not fsynced: it is parsed at once, and the kept copy is a cache. Conditional requests (ST-3): after an import or an unchanged refresh of a downloaded body, its `ETag` and `Last-Modified` are stored in `app_state` (`m3u_validators:<id>`, with the URL, the body's sha256 and `IMPORT_VERSION`; dropped when the server sends neither, and by `sources.remove`). A refresh of a source imported before sends them as `If-None-Match` / `If-Modified-Since` while they still describe the imported body (same URL, sha equal to `m3u_raw.sha256`, same `IMPORT_VERSION`), and a 304 keeps the catalog like an unchanged sha, without a download. A drop guard deletes the temp file. URLs are redacted in logs.
2. If the sha256 matches `m3u_raw.sha256` and the source has been imported before, only `fetched_at` is updated and the cached counts are returned with `ImportSummary.unchanged` set. Hidden categories, favorites and positions are untouched. `run_import` then emits `import.progress {phase: "done", message: "unchanged"}` and no `sources.changed` (see sources.md).
3. Otherwise `write_catalog` runs on the blocking pool in one IMMEDIATE transaction:
   - A `CatalogWriter` covers live, radio, movie and series.
   - The parser streams entries through `RowBuilder` into the writer. `import.progress {phase: "parsing"}` is emitted every 2,000 items, at most one per 250 ms (`sources::ProgressGate`, the gate the download phase uses), and the final count goes out when the gate held it back. Parsing and the write wait for the import save slot (`sources::save_slot`, see sources.md), so only one import parses and saves at a time.
   - Around that, `saving` names its step (see sources.md): `replacing` before the writer deletes the previous rows, when the source had rows (`Remapper::before` counted them), and `indexing` with `done` and `total` set to the entries written, once every entry is in and the ids are remapped, before the writer rebuilds the indexes, the search index and the counts.
   - A file with no `#EXTM3U` and no entries fails with `Invalid`.
   - A playlist with no entries (a bare `#EXTM3U`, which panels answer during maintenance or after an account lapses) never wipes the catalog: the import fails with `Invalid` before the commit and the previous rows stay ("The playlist came back empty; kept the previous channels"; on a first import, "The playlist is empty").
   - Item ids that changed on re-import are remapped so user state stays attached (`m3u/remap.rs`). An id hashes the stream URL and name, so a provider that rotates a token in its URLs gives every row a new id. Inside the same transaction, every table that stores item ids (favorites, recent, positions, downloads, reminders, recordings, My List, channel edits, custom lists, recording rules, watch log, EPG mappings, parental locks) is rewritten from a vanished id to the new id with the same identity: `tvg-id` + name when the entry has a `tvg-id`, otherwise name + group, same content type. Only unique matches move; anything ambiguous is left alone. The remapper keeps strings only for the referenced ids and their identities; every other old row adds a hash of its id and a count under a hash of its identity, and a new row is kept only when its identity is a referenced one (a hash collision can only make a match look ambiguous).
   - `m3u_raw` is upserted with the sha256 and, for playlists up to `RAW_INLINE_MAX` (8 MB), the text. The limit applies to the decoded text (`read_text_lossy`), because a small gzip file can unpack far past it; a file already over the limit on disk is not read just to measure it, and neither is one whose decoded size, counted by the parser (`ParseStats.bytes`), is over it. Larger file / URL playlists, a gzip that unpacks past the limit included, store `raw = ''` and keep a copy at `data_dir/playlists/<id>.m3u` (the downloaded temp file is renamed there; a user file is copied), written after the commit, so an import never holds the whole file in memory. `stored_text` returns the inline text or the copy; `m3u.raw` uses it. A text-origin source whose `raw` is `''` and that has a cached copy (a large pasted or restored playlist, see `place_raw_text`) is parsed from the copy. A text-origin source that was imported before and has a stored sha256 is unchanged without reading its text: pasted text only changes through `sources.add` or a restore, and both store its sha or `''`. `m3u::init` deletes `playlists/*.m3u` files with no `sources` row and leftover `.m3u.part` writes.
   - `epg_json.detectedUrls` is set from the header; manual and disabled lists are left alone.
   - Any error rolls everything back, so a failed refresh keeps the previous catalog.

The whole remote body is never held in a `String` while downloading or parsing.

### Row mapping

- `item_id` is 16 hex chars of sha256(url + `\n` + name). An exact duplicate entry (same URL and name) gets the hash of `url\nname\n#n`, with n starting at 2, so every copy survives.
- `category_id` is 16 hex chars of sha256(group). Entries without a group use "Uncategorized". Categories keep first-seen order per type.
- Content type (`classify`): `radio="true"` is radio. An Xtream VOD URL (a `/movie/` or `/series/` path, the shape of an Xtream `get.php?type=m3u_plus` list) is a movie whatever its group, and so is an mkv, avi, m4v or mov URL. An mp4 URL is a movie only in a group whose name contains movie, vod or film (looping live channels use mp4 too). Everything else is live. Series episodes import as movies until M3U series grouping exists.
- `number` is `tvg-chno` when present, else one running counter shared by live and radio, so a radio number never repeats a live one (movies get none). `position` is the order within the playlist.
- `logo_url` comes from `tvg-logo`, `epg_channel_id` from `tvg-id`, and `archive_hours` from `catchup-days` × 24 when the catch-up type is usable (see catalog.md). `catchup` is lowercased; a `catchup-source` without `catchup` means `default`.
- Movies get `poster_url`, `title_base`, `year` and `container_extension`.
- `extra_json` holds `tvgName`, `tvgShift`, `catchup {type, days, source}`, `headers {userAgent, referrer, origin}`, `vlcOpts` and `kodiProps` when present.

## Performance (check 4)

`tests/m3u_perf.rs` imports a generated 50,000-channel file through `sources.add`. On this machine a release build takes about 1.1 s with a peak RSS delta of about 31 MB; the limits are 3 s and 200 MB. The fast path relies on the FTS trigger suspension and `temp_store=MEMORY` described in catalog.md.

## Catch-up override

`M3uSourceConfig.catchup {type, template?, days?}` overrides every live channel's catch-up attributes; the source edit dialog sets it ("Catch-up override"). `type` is `default`, `append`, `shift`, `flussonic`, `xc` or `none` (catch-up off). `template` (at most 2048 characters, no control characters) replaces `catchup-source` and `days` (1..366) replaces `catchup-days`. `sources.add`/`sources.update` validate it (`catchup::m3u::validate_override`). It is applied when channel rows are read (`catchup::m3u::apply_overrides` on every catalog read path and on `live.alternates`), so changing it never needs a re-import, and an edit that changes only the override does not cancel a running refresh. Backups export and import it with the source.

The archive URL builder exists twice, in `catchup/m3u.rs` and `src/features/live/lib/catchup.ts`. Both are tested against `fixtures/catchup-url-cases.json`; override cases list the `effective` channel attributes after the override.

## rpc

- `m3u.raw {sourceId}` returns `{text, sha256, fetchedAt}`, or NotFound before the first successful fetch.
- `m3u.parsePreview {text}` parses the first 2 MB, cut at a line boundary, and returns `{channelCount, groups (max 500), epgUrls}`.

## Known limits

- Playlists over 8 MB are not copied into `m3u_raw.raw`; readers other than `m3u.raw` (backup export, backup fingerprint) must read through `m3u::stored_text`. An 82 MB, 480k-channel file imports with a peak RSS delta of about 50 MB (`m3u_perf::import_80mb_playlist_with_flat_memory`, ignored by default).
- An import holds the write lock for its whole transaction (about 1 s per 50k rows in release). Other writers wait for it: while a catalog import runs the busy wait is up to 600 s (`db::LONG_BUSY_TIMEOUT`) instead of the usual 5 s, so user writes (positions, favorites, settings) wait for the commit instead of failing.
