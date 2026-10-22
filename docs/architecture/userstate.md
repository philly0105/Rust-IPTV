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
| `favorites.list {sourceId?}` | Ordered by `position`, then `added_at`. While the Live TV quality filter is on, live favorites whose catalog row it hides are left out; one whose channel is gone from the catalog stays (catalog.md). |
| `favorites.toggle {ref, snapshot}` | Adds at the end of the global order, or removes. Returns `{isFavorite}`. |
| `favorites.contains {refs}` | The subset of `refs` that are favorites, deduplicated, in request order. |
| `favorites.reorder {sourceId?, refs}` | One transaction. The listed refs take positions 0..n in that order. Favorites in scope that `favorites.list` shows but `refs` leaves out follow in their previous order. Favorites that `favorites.list` does not show (parental hide mode, a channel hidden by a channel edit, the Live TV quality filter) and `refs` leaves out keep their slots, so they come back in place when shown again. |
| `favorites.remove {ref}` | No-op when absent. |
| `recent.list {sourceId?, limit?}` | Newest first. Default limit 100, max 1000. Leaves out live channels the Live TV quality filter hides, as `favorites.list` does. |
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

`favorites.toggle`, `recent.add` and `positions.set`, the writes a user makes most often, go through `AppState::db_write` (`state.rs`) rather than `db_call`. It is a process-wide gate (a one-permit semaphore) that admits one user write at a time before it takes a pooled connection; the settings store uses it too. The pool has 8 connections (`db::POOL_MAX`). While an import's save transaction holds SQLite's write lock, one gated write waits on a connection and the rest wait at the gate, so reads keep the other connections. Measured on a release build with a 20k live, 60k movie and 8k series Xtream refresh: a read while 13 toggles wait went from 2.2-2.9 s to 2-4 ms. A single toggle that lands in the save still waits for that save to commit. The other writes here (`favorites.reorder`, `favorites.remove`, `recent.remove`, `recent.clear`, `positions.remove`, `userstate.setWatched` and the series mark it keeps in step) go through the gate too, as do `stats.record`, `stats.clear`, every `watchlist.*` and `lists.*` write, the `channels.*` edits and `catalog.setCategoryHidden` / `setCategoriesHidden` (DB-1 in the 2026-10-19 performance audit). `favorites.reorder` opens its transaction as IMMEDIATE: it reads before it writes, and a DEFERRED one failed with SQLITE_BUSY when another write committed in between.

Best-effort cache writes that a read fills (TMDB lookups, listed Stalker rows) run through the same gate in the background (`AppState::writer`, `DbWriter::spawn`): the read answers without waiting for the write lock. `AppState::flush_background_writes` waits for them (a TMDB cache clear, tests).

The periodic writes nobody waits on, a download's progress, a recording's byte count and the image cache's index batches, pass a gate of their own, one at a time (`AppState::db_background`; DB-1R in the 2026-10-22 speed pass). While an import holds the write lock they park one pooled connection between them instead of one each, and user writes never queue behind them. With an import holding the lock and three connections (its own and two guide ingests), one gated user write and six of these waiting, 14 category pages at once took 2.6-3.5 ms in a release build; with the six as plain `db_call` writes they had no connection left, and every read failed at the 15 s checkout timeout (`l2_import_pool.rs`). The parental PIN, settings and lock writes and `epg.setEnabled` are user writes and go through `db_write`.

## Timestamps

Rows are written in RFC 3339 UTC with milliseconds, so ordering by text matches ordering by time. `now_ts` is strictly increasing within the process (a second write in the same millisecond gets the next millisecond), so live writes never tie. Every newest-first query (`recent.list`, the recent trim, `positions.forSeries`, `positions.continueWatching`) orders by the timestamp DESC, then `rowid DESC`, for rows that still tie (imported timestamps). `normalize_ts` accepts what backups contain: RFC 3339, SQLite `YYYY-MM-DD HH:MM:SS`, and unix seconds or milliseconds (values above 1e11 are taken as milliseconds).

## Helpers used by `backup`

`favorite_upsert_json`, `recent_upsert_json` (keeps the newer `viewed_at` on conflict, then trims), `position_set` with `PositionInput.updated_at` and `PositionInput.watched`, `normalize_ts`, `now_ts`. They take a `&Connection` so an import applies a whole source in one transaction.
