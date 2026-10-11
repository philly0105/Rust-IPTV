# M3U

Code: `crates/iptv-core/src/m3u/`. Tests: `crates/iptv-core/tests/m3u_parse.rs`, `m3u_import.rs`, `m3u_perf.rs` (check 4), with helpers in `m3u_support.rs`.

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

1. Get the bytes and their sha256:
   - `text`: read `m3u_raw.raw`.
   - `file` and `file://` URLs: hashed in a streaming pass.
   - `http(s)` URLs: `fetch_to_file` sends the request with the source's headers through `http::apply_source_headers` and `with_retry` (3 attempts). It streams `bytes_stream()` into `data_dir/tmp/m3u-<id>-<uuid>.part` and hashes as it writes. A drop guard deletes the temp file. URLs are redacted in logs.
2. If the sha256 matches `m3u_raw.sha256` and the source has been imported before, only `fetched_at` is updated and the cached counts are returned. Hidden categories, favorites and positions are untouched.
3. Otherwise `write_catalog` runs on the blocking pool in one IMMEDIATE transaction:
   - A `CatalogWriter` covers live, radio, movie and series.
   - The parser streams entries through `RowBuilder` into the writer. `import.progress {phase: "parsing"}` is emitted every 2,000 items.
   - A file with no `#EXTM3U` and no entries fails with `Invalid`.
   - `m3u_raw` is upserted with the sha256 and, for playlists up to `RAW_INLINE_MAX` (8 MB), the text. Larger file / URL playlists store `raw = ''` and keep a copy at `data_dir/playlists/<id>.m3u` (the downloaded temp file is renamed there; a user file is copied), written after the commit, so an import never holds the whole file in memory. `stored_text` returns the inline text or the copy; `m3u.raw` uses it. A text-origin source whose `raw` is `''` and that has a cached copy (a large playlist restored from a backup, see `place_raw_text`) is parsed from the copy.
   - `epg_json.detectedUrls` is set from the header; manual and disabled lists are left alone.
   - Any error rolls everything back, so a failed refresh keeps the previous catalog.

The whole remote body is never held in a `String` while downloading or parsing.

### Row mapping

- `item_id` is 16 hex chars of sha256(url + `\n` + name). An exact duplicate entry (same URL and name) gets the hash of `url\nname\n#n`, with n starting at 2, so every copy survives.
- `category_id` is 16 hex chars of sha256(group). Entries without a group use "Uncategorized". Categories keep first-seen order per type.
- Content type: `radio="true"` is radio. An mp4, mkv, avi, m4v or mov URL in a group whose name contains movie, vod or film is a movie. Everything else is live.
- `number` is `tvg-chno` when present, else one running counter shared by live and radio, so a radio number never repeats a live one (movies get none). `position` is the order within the playlist.
- `logo_url` comes from `tvg-logo`, `epg_channel_id` from `tvg-id`, and `archive_hours` from `catchup-days` × 24 when the catch-up type is usable (see catalog.md). `catchup` is lowercased; a `catchup-source` without `catchup` means `default`.
- Movies get `poster_url`, `title_base`, `year` and `container_extension`.
- `extra_json` holds `tvgName`, `tvgShift`, `catchup {type, days, source}`, `headers {userAgent, referrer, origin}`, `vlcOpts` and `kodiProps` when present.

## Performance (check 4)

`tests/m3u_perf.rs` imports a generated 50,000-channel file through `sources.add`. On this machine a release build takes about 1.1 s with a peak RSS delta of about 31 MB; the limits are 3 s and 200 MB. The fast path relies on the FTS trigger suspension and `temp_store=MEMORY` described in catalog.md.

## rpc

- `m3u.raw {sourceId}` returns `{text, sha256, fetchedAt}`, or NotFound before the first successful fetch.
- `m3u.parsePreview {text}` parses the first 2 MB, cut at a line boundary, and returns `{channelCount, groups (max 500), epgUrls}`.

## Known limits

- Playlists over 8 MB are not copied into `m3u_raw.raw`; readers other than `m3u.raw` (backup export, backup fingerprint) must read through `m3u::stored_text`. An 82 MB, 480k-channel file imports with a peak RSS delta of about 50 MB (`m3u_perf::import_80mb_playlist_with_flat_memory`, ignored by default).
- An import holds the write lock for its whole transaction (about 1 s per 50k rows in release). Other writers wait, up to the 5 s busy timeout.
