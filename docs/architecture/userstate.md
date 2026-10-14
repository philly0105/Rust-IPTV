# User state: favorites, recently viewed, playback positions

Code: `crates/iptv-core/src/userstate/`. Tests: `crates/iptv-core/tests/userstate_rpc.rs` plus unit tests in `mod.rs`.

User state lives in the C3 tables `favorites`, `recent` and `playback_positions`. Every row is keyed by an `ItemRef` (`sourceId`, `contentType`, `itemId`) and cascades away with its source. Each row stores an `ItemSnapshot` (`title`, `subtitle?`, `posterUrl?`, `contentType`) as JSON, so lists render without a catalog lookup and survive a catalog refresh that drops the item.

## Layout

| File | Role |
| --- | --- |
| `mod.rs` | SQL operations on a `&Connection`, used by the RPC handlers and by `backup` import/export. Timestamp normalization. |
| `rpc.rs` | Registration of the `favorites.*`, `recent.*` and `positions.*` commands (C4). |

## Commands (C4)

| Command | Behaviour |
| --- | --- |
| `favorites.list {sourceId?}` | Ordered by `position`, then `added_at`. |
| `favorites.toggle {ref, snapshot}` | Adds at the end of the global order, or removes. Returns `{isFavorite}`. |
| `favorites.contains {refs}` | The subset of `refs` that are favorites, deduplicated, in request order. |
| `favorites.reorder {sourceId?, refs}` | One transaction. The listed refs take positions 0..n in that order. Favorites in scope that `favorites.list` shows but `refs` leaves out follow in their previous order. Favorites that `favorites.list` does not show (parental hide mode, a channel hidden by a channel edit) and `refs` leaves out keep their slots, so they come back in place when shown again. |
| `favorites.remove {ref}` | No-op when absent. |
| `recent.list {sourceId?, limit?}` | Newest first. Default limit 100, max 1000. |
| `recent.add {ref, snapshot, viewedAt?}` | Upserts with `viewed_at = now`, then trims the source to 200 rows (oldest go first). With `viewedAt` (C7, RFC 3339 with an offset; Recent undo passes it) the entry gets that date back instead of now. |
| `recent.remove {ref}`, `recent.clear {sourceId?}` | `clear` without a source clears everything. |
| `positions.get {ref, episodeId?}` | `null` when absent. |
| `positions.set {ref, episodeId?, positionSeconds, durationSeconds?, snapshot?, updatedAt?}` | Seconds are floored to integers. At or above 95% of a known duration the row is kept as a watched row at its end: an episode since C13, a movie (item-level row) since Run 2, where that watched row is what the VOD grid's tick and Hide watched read. A missing duration or snapshot keeps the stored one. With `updatedAt` (C14, RFC 3339; only undo and backup restore pass it) the row stores that time instead of now, and an existing row is only overwritten or deleted when that time is newer than the stored one. |
| `positions.forSeries {ref}` | Every episode row of one series. |
| `positions.continueWatching {limit?}` | One row per item, newest first. Default 20, max 200. A series is represented by its most recently updated episode row; when that row is watched or at or below 5 seconds, the series is left out, so an older half-watched episode never comes back (C13). A missing snapshot is filled in from `items` and `categories`, or from a minimal fallback, so every row has one. |
| `positions.remove {ref, episodeId?, allEpisodes?}` | Removes one row. With `allEpisodes: true` on a series ref (C13) it removes every unfinished episode row of that series and keeps the watched rows. |
| `userstate.setWatched {ref, episodeId?, watched}` | `watched: true` upserts the row with `watched = 1` and the position set to the stored duration (else the stored position, else 0). `watched: false` deletes the row. |

Every position carries `watched` (column added by migration 0004, default 0). `positions.continueWatching` skips watched rows. A watched row is kept (not deleted) when a later position reaches 95%. A live `positions.set` (no `updatedAt`) below 95% and above 5 seconds clears the flag for an episode only, because the episode is being rewatched; a save at or below 5 seconds, or one with `updatedAt`, keeps it. An item-level row (a movie) keeps `watched` on every partial save: the replay position is stored, the poster tick stays and the movie stays out of a Hide watched grid; only `userstate.setWatched(false)` clears it. The player and the movie page offer to resume such a replay when it is between 5% and 95% of the duration.

`episode_id` is stored as `''` when absent (C3 primary key) and returned as `null`.

Writes against a source id that does not exist return `NotFound` (foreign-key failure mapped), not an internal error.

## Timestamps

Rows are written in RFC 3339 UTC with milliseconds, so ordering by text matches ordering by time. `now_ts` is strictly increasing within the process (a second write in the same millisecond gets the next millisecond), so live writes never tie. Every newest-first query (`recent.list`, the recent trim, `positions.forSeries`, `positions.continueWatching`) orders by the timestamp DESC, then `rowid DESC`, for rows that still tie (imported timestamps). `normalize_ts` accepts what backups contain: RFC 3339, SQLite `YYYY-MM-DD HH:MM:SS`, and unix seconds or milliseconds (values above 1e11 are taken as milliseconds).

## Helpers used by `backup`

`favorite_upsert_json`, `recent_upsert_json` (keeps the newer `viewed_at` on conflict, then trims), `position_set` with `PositionInput.updated_at` and `PositionInput.watched`, `normalize_ts`, `now_ts`. They take a `&Connection` so an import applies a whole source in one transaction.
