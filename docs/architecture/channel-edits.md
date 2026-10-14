# Channel edits

`crates/iptv-core/src/channeledit/` (Run 2 contract C2) lets the user hide or rename individual live and radio channels. A hidden channel leaves every list, count, search and zap path; a renamed channel shows its custom name everywhere the app shows a channel name. The provider's data is never changed: `items.title` keeps the provider name, and edits are applied when the catalog is read.

Files: `mod.rs` (storage, writers, reader helpers, SQL clause builders, backup functions), `rpc.rs` (the four commands). The readers that use it live in `catalog/mod.rs`, `catalog/rpc.rs`, `userstate/mod.rs`, `lists/` and `epg/search.rs`.

## Storage

Migration `0013_catalog_edits.sql`:

- `channel_edits`: primary key `(source_id, content_type, item_id)`, plus `hidden` (0/1), `name` (custom name, NULL = provider name), `original_name` (the provider name when the row was last written) and `updated_at` (RFC 3339 UTC with milliseconds, as in userstate). `content_type` is `live` or `radio` (CHECK).
- Rows are keyed by the stable catalog id (m3u: the hash-based `item_id`; Xtream: stream id; Stalker: portal id), not by a foreign key to `items`. Every refresh deletes and reinserts a source's items, and edits must survive that. `source_id` references `sources` with `ON DELETE CASCADE`, so removing a source removes its edits.
- A row that ends up with `hidden = 0 AND name IS NULL` is deleted by the writer, so every row is a real edit.
- `idx_channel_edits_hidden (source_id, content_type) WHERE hidden = 1` and `idx_channel_edits_named (source_id, content_type) WHERE name IS NOT NULL` answer the per-call probes (see "Cost rule"). The second index is not in the contract text; it was added so a search can skip the custom-name pass in one lookup.
- The same migration adds `idx_items_year (source_id, content_type, year)` for the C4 year filter.

## Commands

All four are registered in `rpc.rs`. A write that changes a row emits `channels.changed` with payload `{ sourceId }`, once per source touched. A write that changes nothing emits nothing and leaves `updatedAt` alone: hiding a channel that is already hidden, unhiding one that is not, renaming to the current name (or clearing a name that is not set), and resetting a source with no edits.

- `channels.edits {sourceId, hiddenOnly?}` → `ChannelEdit[]`, newest first. `ChannelEdit` is `{ref, hidden, name?, originalName, updatedAt}`. `originalName` is the current provider name while the channel is in the catalog, else the name stored with the row (the hidden-channels dialog can still label a channel the provider dropped). Empty `sourceId` is `invalid`; an unknown source returns `[]`.
- `channels.setHidden {refs, hidden}`: 1 to 500 refs (duplicates collapse), live or radio only, ids non-empty and at most 2048 characters (`lists::MAX_ID_CHARS`), else `invalid`. One transaction. A `not_found` message shortens ids to 64 characters.
  - `hidden: true` needs every channel in the catalog; one missing ref is `not_found` and nothing is written.
  - `hidden: false` never answers `not_found`. It clears the hidden flag whether or not the provider still lists the channel, so a channel that has left the playlist can be removed from the hidden-channels list. A ref with no hidden row is a no-op (no write, no event). This is a change to C2, which asked for `not_found` on a ref missing from the catalog; the channel-edit UI (B9) asked for it because such a channel could otherwise never leave the dialog.
- `channels.rename {ref, name}` → `ChannelEdit | null`. The name is trimmed. `null`, a missing `name` and `""` reset to the provider name; a name equal to the provider name also resets. A name that is blank after trimming, longer than 120 characters, or holds a control character or a U+2028 / U+2029 line or paragraph separator is `invalid`. A name with no visible character counts as blank: white space, format characters (category Cf, such as U+200B ZERO WIDTH SPACE or U+200F RIGHT-TO-LEFT MARK), other default-ignorable code points and the Hangul and Braille blanks are not visible (`is_invisible`). Inside a visible name they are kept, since U+200D and the variation selectors build emoji. Names are not normalised to NFC; that would need a Unicode normalisation crate. Setting a name needs the channel in the catalog (`not_found`); clearing one also works for a channel the provider dropped while its row exists. Returns the row, or `null` when no edit is left.
- `channels.reset {sourceId}` deletes every edit of the source. Empty id is `invalid`; unknown source is `not_found`.

After each write the touched source's category `item_count` values and `source_counts` are recomputed (`catalog::recount_categories`, `catalog::update_counts`).

## Hidden channels in readers

| Reader | How |
| --- | --- |
| `catalog.channels` (pages, totals, in-list search, sort) | `scoped` clause |
| `catalog.categories` (`itemCount`) | stored counts exclude hidden channels; English-only and parental counts subtract overlaps |
| `catalog.neighbors`, `catalog.allLiveChannels` | `scoped` clause |
| `catalog.channelByNumber` | `item_row` probe; answers `null` for a hidden channel |
| `catalog.search` | `item_set` clause |
| `favorites.list`, `recent.list` | `by_ref` probe (the stored rows are kept) |
| `lists.items` (B2) | `VISIBLE_PREDICATE` |
| `epg.search` (B5) | `hidden_set` |
| `sources.list` / `source_counts` | stored counts exclude hidden channels; `radioCount` (counted live from `items`) leaves out hidden stations |

`catalog.item` still returns a hidden channel: the hidden-channels dialog and an open player need it. `favorites.contains` still reports it, since the favorite row is kept and comes back on unhide.

Counts:

- `item_count` is stored without hidden channels. `CatalogWriter::finish` and every edit call `recount_categories`, which counts the items and subtracts the hidden ones per category.
- A category that hiding empties is dropped from `catalog.categories` (its stored count is 0 but it had channels); with `includeHidden` (the manage-categories view) it stays, with 0.
- English-only counts (`english_categories`) add the `scoped` clause to their count query.
- Parental hide mode subtracts locked items from the counts; a channel that is both locked and hidden would be subtracted twice, so `visible_categories` adds back the overlap (`locked_hidden_counts`).

## Renames

Custom names are applied on read, after the rows are fetched:

- `apply_names(conn, &mut [Channel])` for `catalog.channels`, `catalog.item`, `catalog.channelByNumber`, `catalog.neighbors`, `catalog.search` (live), `catalog.allLiveChannels`, and `lists.items` (B2).
- `apply_snapshot_names` for the snapshot titles of `favorites.list` and `recent.list` (live and radio only).
- `custom_name` for one channel (used by `epg.search`).

Both batch helpers make one query per distinct source and nothing when no source has a custom name.

Because `items.title` keeps the provider name:

- EPG resolution (`epg.resolve`, now/next, the guide) matches by the provider name, so renaming a channel does not break its guide data.
- Sorting by name uses the provider name. A renamed channel keeps its place in a name-sorted list.
- The FTS index stays on provider names. Search by custom name is a second pass:
  - `catalog.search` first finds channels whose custom name contains the text (`LIKE`, case-insensitive for ASCII) and lists them first, shortest name first, then the provider-name matches without repeating them. Searching by the old provider name still finds a renamed channel.
  - The in-list search of `catalog.channels` adds the rowids whose custom name matches (`named_rowids`) to both the FTS and the `LIKE` strategy.

## Cost rule and clause shapes

Every builder first runs one indexed `EXISTS` (on the partial indexes above) and returns an empty clause when nothing applies. A source without edits pays nothing per row.

- `scoped(conn, source, type, ...)`: one source and type, many rows. A non-correlated `i.rowid NOT IN (SELECT h.rowid FROM channel_edits e CROSS JOIN items h ... WHERE e.hidden = 1)`, built once per statement. This keeps the English-only zap list (amendment 10:06) free of a per-row probe.
- `item_set(conn, source?)`: any source, many rows (global search). The same rowid set over every hidden row. A row-value `(source_id, content_type, item_id) NOT IN (SELECT ...)` was tried first and measured about 20 times slower on a search matching 45k rows (6.2 s against 0.25 s in a debug build): SQLite rescans the set for each row. `parental::filter::item_set` still uses the row-value shape for item locks.
- `item_row` / `VISIBLE_PREDICATE` / `by_ref`: few rows. A correlated primary-key probe per row.

`tests/channel_edits.rs` checks the budget (check 4): 50k channels, 1,000 hidden, 1,000 renamed, English-only on. Each call is timed after a warm-up call against 100 ms in release (300 ms in debug). The test takes a write lock that every other test in the file holds for reading, so it runs alone: in parallel with them a debug deep page once took 346 ms against 52 ms alone. The 20k-row zap list gets four budgets, as in `catalog_perf`.

The 1001-row search (the UI's "show up to 1000" step) has its own budget, 150 ms in release (450 ms in debug, `WIDE_SEARCH_BUDGET`). This is an amendment to check 4, which asked for 100 ms for every `catalog.search`. The query "channel" matches 49k titles, 34k of them left after English-only. The statement ranks every match before the limit applies, so limit 30 costs about 90 % as much as limit 1001. On a quiet machine the call takes 85 to 94 ms in release (median about 90 ms), so a 100 ms budget failed about one run in four. Measured parts of one live pass (about 70 ms): bm25 ranking about 30 ms, the category join that the hidden-category and English-only filters need about 18 ms. The movie and series passes return nothing and take about 9 ms each. The Run 2 hidden-channel set adds about 9 %. Cheaper shapes were tried and were not faster: sorting rowids first and fetching the columns for the 1001 rows afterwards (80 ms), and ranking inside an FTS subquery (100 ms). A cheaper search needs a capped candidate set or the content type in the FTS table, which changes the ranking or the schema.

Release timings on 2026-10-14, with other builds running on the machine:

- `catalog.channels`: first page 18 ms, deep page 53 ms, category page 3 ms, sorted by name 17 ms.
- In-list search: custom name 23 ms, provider name 28 ms, one letter 45 ms.
- `catalog.search` (default limit): custom name 31 ms, provider name 9 ms. With limit 1001 and a one-word query matching 49k titles: 90 ms (the test run alone; 111 to 139 ms with other cargo builds running).
- `catalog.categories` 29 ms, `catalog.allLiveChannels` 74 ms, `catalog.neighbors` 2 ms.

## Refresh and removal

Edits are keyed by catalog id, so a refresh that rewrites the catalog keeps them: the writer's recount applies them to the new counts. A channel the provider drops keeps its edit row. The row applies again if the channel comes back, and stays visible in `channels.edits` until the user unhides or resets it. Removing a source removes its edits through the cascade.

## Backup

`export_edits(conn, source_id) -> Vec<ChannelEditBackup>` and `import_edits(conn, source_id, &[ChannelEditBackup]) -> usize` are for the backup module. Import upserts by key and keeps the newer `updatedAt` (an older copy does not roll a row back). It skips entries that are not live or radio, have an empty item id or one over 2048 characters, or are neither hidden nor carry a valid name, and then recounts. Entries are matched by catalog id, so they apply to whatever the source lists now.

## Finished movies (C2, userstate)

A movie (empty episode id) that reaches the completion ratio is no longer deleted. Its row becomes `watched = 1` with `position_seconds` at the duration, as finished episodes already were. That watched row keeps it out of Continue Watching and is the movie's watched mark for the C4 "hide watched" filter. Replaying part of the movie later keeps the mark (see [vod-browsing.md](vod-browsing.md#what-watched-means)).
