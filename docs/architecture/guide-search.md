# Guide programme search

Code: `crates/iptv-core/src/epg/search.rs` (core), migration `crates/iptv-core/src/db/migrations/0015_guide.sql`. Tests: `crates/iptv-core/tests/guide_search.rs` (matching, window, limit, hidden and locked channels, the scan before the index exists, index upkeep, query plans, 200k-programme timing) and unit tests in `search.rs`.

## Command

`epg.search {sourceId, query, from?, to?, limit?}` returns `GuideSearchHit[]`:

```
{ ref, channelName, channelNumber?, logoUrl?, categoryId?, program: EpgProgram }
```

- `query`: 2 to 100 characters after trimming. Every word of the query (a run of letters and digits, lowercased, diacritics removed) must start a word of the title, so `cafe soc` finds "Café Society" and "CAFE SOCIETY" but `afe` finds nothing.
- `from` and `to`: RFC 3339. `from` defaults to now, `to` to `from` + 14 days; `to` must be after `from` and at most 16 days later. A programme matches when it overlaps the window (`stop > from` and `start < to`), so the one on air at `from` counts.
- `limit`: 1 to 200, default 50.
- `program.start` and `program.end` are raw guide times, like `epg.programs`; the UI applies `epgOffsetMinutes`.
- Errors: `invalid` for bad arguments (including an empty `sourceId`), `not_found` for an unknown source.

## Which channels a hit belongs to

Hits are mapped to the live and radio channels of the requested source only. A guide channel maps to an item the way the grid maps it, minus fuzzy matching:

1. A manual mapping in `epg_channel_map` wins. A mapping to NULL means "no guide" and the item gets no hits.
2. Otherwise the item's `epg_channel_id` (tvg-id), compared case-insensitively against the enabled feeds.
3. Otherwise the exact normalised channel name. Similar names ("Channel Threee") never match here, so search does not show programmes from a guessed channel.

A guide channel can map to several items (an HD and an SD copy); each gets its own hit. When two feeds carry the same channel and start, the feed added first wins.

Left out:
- channels hidden with channel edits (`channeledit::hidden_set`); a renamed channel shows its custom name in `channelName`;
- parental-locked channels while hide mode is on. The core then gathers up to 2,000 candidates before filtering, so locked channels do not eat into the limit.
- disabled feeds and the staging rows of a refresh in progress.

Order: programme start, then channel number (channels without one last), then channel name, then item id.

## The index

`epg_programs_fts` is an external-content FTS5 table over `epg_programs.title` (`tokenize='unicode61 remove_diacritics 2'`). It is not kept in step row by row: a refresh writes its programmes through staging and swaps them in with a few bulk statements, and triggers would add their cost to every one of those rows. Instead the index is rebuilt in one statement (`INSERT INTO epg_programs_fts(epg_programs_fts) VALUES('rebuild')`), which takes about 0.1 s for 200k programmes.

The `app_state` key `epg_search_index` says whether the index matches the table:

- Every statement that deletes or swaps programmes removes the key in the same transaction: `store::commit_staging`, `clear_all`, `prune`, and the staging cleanups when they deleted rows.
- `rebuild_index` rebuilds and sets the key in one transaction. It runs after each refresh (while the import's larger page cache is still set), after `epg.clearAll`, after a prune, and once in the background at startup when the key is missing and programmes exist (a database upgraded from before migration 15, or a crash between a swap and its rebuild).
- The migration leaves the index empty so the upgrade stays fast.

Search reads the index only while the key is present. Otherwise it scans the time window (`idx_epg_programs_stop`) and matches titles in Rust with the same word rule. Results are the same either way, only slower (about 1 s for 200k programmes in a debug build), and never stale: a rowid reused by a later insert cannot point a hit at the wrong programme, because the key is gone until the next rebuild.

The index path stops reading once it has `limit` distinct programme slots on mapped channels, finishing the last start time so ties are ordered the same as in the scan.

## Speed

On 1,000 channels with 200 programmes each (200k), a common word (`news`, thousands of matches), a rare title and two-word queries each answer in under 25 ms in a debug build. The test asserts under 150 ms in release builds. The source's channel list is read on every search (no cache); with tens of thousands of channels that is the largest cost.

## Query plans

`tests/guide_search.rs` checks with `EXPLAIN QUERY PLAN` that the FTS statement drives from the virtual table index and reads each programme by rowid, and that the scan uses `idx_epg_programs_stop`. Both statements are also in the `db/mod.rs` index test (after every migration); that test accepts a rowid lookup (`USING INTEGER PRIMARY KEY`) as indexed, which the FTS statement's programme read is.
