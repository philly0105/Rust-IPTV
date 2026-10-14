# Watch stats

Code: `crates/iptv-core/src/stats/` (core) and `src/features/stats/` (reporter and page). Tests: `crates/iptv-core/tests/watch_stats.rs`, unit tests in `stats/mod.rs` and `stats/rpc.rs`, `src/features/stats/test/`, and `e2e/stats.spec.ts`.

Watch stats count how long the user watched each channel and title per day (contract C7). The player reports time, the core keeps one row per item per local day for 90 days, and `/stats` shows the last 7 or 30 days: a total, a per-day chart split into live and movies/series, and the most-watched channels and titles. Everything stays on the device. There is no change event: the page refetches on focus and every 60 s.

## Storage

Migration `0016_watch_log.sql` creates the `watch_log` table:

| Column | Notes |
| --- | --- |
| `day`, `source_id`, `content_type`, `item_id` | Primary key. `day` is the client's local date, `YYYY-MM-DD`. `source_id` references `sources(id)` with `ON DELETE CASCADE`. `content_type` is `live`, `radio`, `movie` or `series`; an episode counts under its series. |
| `title`, `poster_url` | A snapshot from the last report, so the lists render without the catalog. A later report replaces the title; a report without a poster keeps the stored one. |
| `seconds` | Watched seconds that day, capped at 86,400. |
| `last_at` | RFC 3339 UTC of the last report (`userstate::now_ts`). |

An index on `(source_id, content_type, item_id)` serves the top lists.

### Retention

Rows older than 90 days before today (UTC) are deleted at startup (`stats::init`) and on the first successful `stats.record` of each UTC day. An in-memory mark (`stats.pruneMark` in the AppState extensions) remembers the last prune day, so the other records of the day do not pay for it. A rejected record does not prune.

Removing a source deletes its rows through the cascade.

## Commands (C7)

| Command | Behaviour |
| --- | --- |
| `stats.record {ref, title, posterUrl?, seconds, day}` | Adds `seconds` to the item's row for `day`. `seconds` must be a whole number from 1 to 300, `day` a `YYYY-MM-DD` date within two days of the core's UTC date (time zones and midnight flushes stay valid, a broken clock does not), the trimmed title 1 to 300 characters, and the ref's ids non-blank and at most 2048 characters (`invalid` otherwise). An unknown source is `not_found`. A poster URL over 4096 characters is dropped. |
| `stats.summary {days, today, top?}` | `days` is 7 or 30 and `today` the client's local date (`invalid` otherwise). `days` lists exactly that many dates ending at `today`, oldest first, zero-filled, each with `seconds = liveSeconds + vodSeconds` (live and radio count as live). `totalSeconds` sums the range. `topChannels` (live and radio) and `topTitles` (movies and series) hold up to `top` items (default 10, 1 to 50), ordered by seconds, then title (case-insensitive), then ref. |
| `stats.clear` | Deletes every row. |

Each top item carries the title and poster of its latest row; a missing poster falls back to the latest poster in the log, then the catalog's poster or logo. `sourceName` is the source's current name. A channel the user renamed (C2 channel edits) shows the custom name.

While parental hide mode is on (C2), the top lists leave out items that are locked, in a locked category or in an adult category, as `favorites.list` does. The day totals still count them: the chart shows that time was spent without naming what. Channels hidden by channel edits are not filtered; the stats are history.

## Reporter

`useWatchStatsReporter` (mounted once in the shell effects) subscribes to the player store and never writes it. It counts wall time while the store's `status` is `playing`, the source has a catalog `ref`, and the mode is not `external` (an external player's time is unknown). Local files have no ref and multi-view tiles are not in the store, so neither counts.

- A 1 s interval runs only while counting. Each step adds the time since the previous step, capped at 2 s, so a laptop that sleeps through a film adds 2 s rather than the night.
- A flush sends one `stats.record` with the whole seconds counted so far, dated with the local day at flush time. It happens every 30 s while playing and whenever counting stops: pause, buffering, error, stop, a different item, a switch to an external player, the page unloading, and unmount. A periodic flush keeps the part second for later; a stopping flush rounds it.
- On the web the unload flush goes out with `keepalive` on `beforeunload`, before the navigation starts, and again on `pagehide` for anything counted since (browsers that skip `beforeunload`). A send made only in `pagehide` was seen to stall in Chromium until the tab closed.
- A failed flush is dropped, not retried, so a call that timed out after landing is never counted twice. At most 30 s are lost.
- Titles are trimmed and cut to 300 characters before sending; a blank title falls back to the item id.

The reporter is plain TypeScript with no i18n, so it can sit in the entry chunk.

## Page

`statsRoutes` mounts `/stats` as a lazy chunk. The range is in the URL (`?range=30`; 7 has no parameter) and on the keys `7` and `3`. The page shows:

- The total as a sentence ("2 hr 25 min watched in the last 7 days") with a live and movies/series legend.
- The per-day chart. Live is solid accent at the base of each bar; movies and series are accent hatching above it, so the parts differ by pattern as well as shade. Gridlines are labelled in hours or minutes. The bar area is one tab stop with the slider role: ArrowLeft and ArrowRight follow the screen (mirrored in RTL), Home and End jump to the ends, and the value text reads the picked day. The same numbers are in a table that is always in the accessibility tree and shown on screen with the table toggle.
- Top channels with logo, source name, time, a meter against the first, and Play (hidden when the source is gone). Top titles with poster, source name and time, linking to the title's page.
- Clear stats behind a confirm dialog, then a toast. The cached summaries are invalidated.

Empty: on 7 days the action switches to 30 days; on 30 days it links Home. Loading shows a skeleton in the page's shape; an error shows the shared error state with Try again.

Durations use `Intl.NumberFormat` units ("3 hr 20 min", "45 min", "40 sec"), dates `Intl.DateTimeFormat`, both in the app language (`by` as `be`, `zhtw` as `zh-TW`).

## Backup

The backup manifest carries the log per source in the `tsrustWatchLog` extension of each playlist entry's `userState` (`backup::EXT_WATCH_LOG`).

- `export_log(conn, source_id) -> Vec<WatchLogBackup>`: the source's rows, ordered by day, type and item.
- `import_log(conn, source_id, rows) -> usize`: runs inside a savepoint and nests inside the caller's transaction. An unknown source is `not_found`. Rows with a bad day, a day past retention, no seconds, a blank or overlong id, or a blank title are skipped; titles are cut to 300 characters and seconds capped at 86,400. A row that already exists keeps the larger `seconds`, takes the title and poster of the later `lastAt` (a missing poster is filled either way), and keeps the later `lastAt`. Importing the same file twice changes nothing and returns 0.
