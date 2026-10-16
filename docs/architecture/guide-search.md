# Guide programme search

Code: `crates/iptv-core/src/epg/search.rs` (core), migration `crates/iptv-core/src/db/migrations/0015_guide.sql`. Tests: `crates/iptv-core/tests/guide_search.rs` (matching, window, limit, hidden and locked channels, the scan before the index exists, scan and index parity on Greek and Vietnamese titles, index upkeep, query plans, timing on 200k programmes and a 50k-channel source) and unit tests in `search.rs` and `tmdb/normalize.rs` (the diacritic fold).

## Command

`epg.search {sourceId, query, from?, to?, limit?}` returns `GuideSearchHit[]`:

```
{ ref, channelName, channelNumber?, logoUrl?, categoryId?, program: EpgProgram }
```

- `query`: 2 to 100 characters after trimming. Every word of the query (a run of letters and digits, lowercased, diacritics removed, final sigma read as sigma) must start a word of the title, so `cafe soc` finds "Café Society" and "CAFE SOCIETY" but `afe` finds nothing. Diacritics are removed as Unicode NFD does (`tmdb::normalize::strip_diacritics`, a table generated from the Unicode decomposition data), so `ελληνικα` finds "Ελληνικά" and `thoi su` finds "Thời sự".
- `from` and `to`: RFC 3339. `from` defaults to now, `to` to `from` + 14 days; `to` must be after `from` and at most 16 days later. A programme matches when it overlaps the window (`stop > from` and `start < to`), so the one on air at `from` counts.
- `limit`: 1 to 200, default 50.
- `program.start` and `program.end` are guide times moved by the hit channel's `tvg-shift` (`query::item_shift`, read once per channel), as `epg.programs` and `epg.grid` return them, so a hit shows the same time as the grid cell it opens. The UI applies `epgOffsetMinutes`.
- Errors: `invalid` for bad arguments (including an empty `sourceId`), `not_found` for an unknown source.

## Which channels a hit belongs to

Hits are mapped to the live and radio channels of the requested source only. A guide channel maps to an item the way the grid maps it, minus fuzzy matching:

1. A manual mapping in `epg_channel_map` wins. A mapping to NULL means "no guide" and the item gets no hits.
2. Otherwise the item's `epg_channel_id` (tvg-id), compared case-insensitively against the enabled feeds.
3. Otherwise the exact normalised channel name. Similar names ("Channel Threee") never match here, so search does not show programmes from a guessed channel.

A guide channel can map to several items (an HD and an SD copy); each gets its own hit. When two feeds carry the same channel and start, the feed added first wins.

Left out:
- channels hidden with channel edits (`channeledit::scoped` in the channel query); a renamed channel shows its custom name in `channelName`;
- parental-locked channels and channels in locked or adult categories while hide mode is on (`parental::filter::scoped` in the same query). They never become candidates, so any number of hits on locked channels cannot push a visible hit past the limit;
- disabled feeds and the staging rows of a refresh in progress.

Order: programme start, then channel number (channels without one last), then channel name, then item id. Because a shift can move a hit past others, the hits are sorted again by their shifted start (a stable sort, so equal starts keep the channel order).

## The index

`epg_programs_fts` is an external-content FTS5 table over `epg_programs.title` (`tokenize='unicode61 remove_diacritics 2'`). It is not kept in step row by row: a refresh writes its programmes through staging and swaps them in with a few bulk statements, and triggers would add their cost to every one of those rows. Instead the whole index is rebuilt: `'delete-all'`, then one `INSERT INTO epg_programs_fts(rowid, title) SELECT rowid, epg_search_fold(title) FROM epg_programs`, which takes about 0.2 s for 200k programmes.

The index holds titles folded by the same Rust function the scan and the query use (`search::fold`, registered as the SQL function `epg_search_fold` for the rebuild), not the raw titles a `'rebuild'` would read from the content table. The tokenizer's own diacritic removal covers Latin letters only and keeps the Greek tonos, so with raw titles a Greek query found nothing through the index while the scan found it. Query terms are folded before they reach the tokenizer, so both sides of a match pass through the same fold and then the same tokenizer. The FTS table itself is unchanged (only its contents are), so there is no migration.

The `app_state` key `epg_search_index` says whether the index matches the table; its value is the index version (`folded-1`):

- Every statement that deletes or swaps programmes removes the key in the same transaction: `store::commit_staging`, `clear_all`, `prune`, and the staging cleanups when they deleted rows.
- `rebuild_index` rebuilds and sets the key in one transaction. It runs after each refresh (while the import's larger page cache is still set), after `epg.clearAll`, after a prune, and once in the background at startup when the key is missing or holds another version and programmes exist (a database upgraded from before migration 15, an index of raw titles marked `ready` by an earlier build, or a crash between a swap and its rebuild).
- The migration leaves the index empty so the upgrade stays fast.

Search reads the index only while the key holds the current version. Otherwise it scans the time window (`idx_epg_programs_stop`) and matches titles in Rust with the same word rule. Results are the same either way, only slower (about 1 s for 200k programmes in a debug build), and never stale: a rowid reused by a later insert cannot point a hit at the wrong programme, because the key is gone until the next rebuild.

The index path stops reading once it has `limit` distinct programme slots on mapped channels, finishing the last start time so ties are ordered the same as in the scan.

## Speed

The test searches 1,000 guide channels with 200 programmes each (200k) from a source of 50,000 channels, 49,000 of them with guide ids and names the guide does not know. A common word (`news`, thousands of matches), a rare title and two-word queries each answer in about 35 to 60 ms; the test asserts under 150 ms in release builds.

The source's channels are read on every search, so catalog changes, channel edits and locks apply at once; that read is now the largest cost. What depends only on the guide is memoized on the EPG runtime (`SearchMemo`) until its generation moves (a refresh, a clear, a prune, a feed enabled or disabled): whether an unknown `epg_channel_id` has programmes (one `epg_programs` probe each) and which guide channel a name matches exactly. Before the memo, every search repeated both for each unmatched channel, about 140 ms at 50k channels. The memo drops its entries past 500,000.

## Query plans

`tests/guide_search.rs` checks with `EXPLAIN QUERY PLAN` that the FTS statement drives from the virtual table index and reads each programme by rowid, and that the scan uses `idx_epg_programs_stop`. Both statements are also in the `db/mod.rs` index test (after every migration); that test accepts a rowid lookup (`USING INTEGER PRIMARY KEY`) as indexed, which the FTS statement's programme read is.
