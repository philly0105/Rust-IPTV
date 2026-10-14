# Parental controls

`crates/iptv-core/src/parental/` (contract C2) keeps a PIN, category and item locks per source, and an in-memory session unlock. While a PIN is set and no unlock is active, locked content is either hidden from every catalog and user-state reader (hide mode) or shown and gated by the UI (ask mode).

Files: `mod.rs` (runtime, commands, backup hooks, timer), `store.rs` (SQL for config and locks), `pin.rs` (PBKDF2), `filter.rs` (hide-mode SQL), `rpc.rs` (argument parsing).

## Storage

Migration `0011_parental.sql`:

- `parental_config`: one row (`id = 1`, inserted by the migration) with `pin_hash`, `pin_salt` (both NULL = no PIN, controls off), `mode` (`hide` | `ask`, default `hide`), `auto_adult` (default 1), `unlock_minutes` (default 15, 0..720), `failed_attempts`, `lockout_until` (RFC 3339), `updated_at`.
- `parental_locks`: `(source_id, content_type, kind, target_id)` primary key, `WITHOUT ROWID`, plus `name` (display only, trimmed, at most 200 characters) and `created_at`. `kind` is `category` or `item`; `target_id` is the category or item id exactly as the catalog stores it. `source_id` references `sources` with `ON DELETE CASCADE`, so removing a source removes its locks.

Every filter looks locks up by a prefix of the primary key (source, type, kind) or the whole key, so the table needs no other index. Locks may name items or categories the catalog does not have (yet); they apply when the item appears.

The config row is cached in memory (never with PIN material) and refreshed after every write.

## PIN

- 4 to 8 ASCII digits. Anything else is `invalid` ("newPin must be 4 to 8 digits.").
- Stored as PBKDF2-HMAC-SHA256, 100 000 iterations, 16-byte random salt (`OsRng`): `pin_hash = "pbkdf2-sha256$100000$<hex>"`, `pin_salt` = 32 hex characters. A new salt for every PIN. Verification recomputes with the stored iteration count and compares in constant time.
- The PIN, its hash and its salt are never returned by a command, put in an event, written to a log, or exported. The router logs every error message and serde quotes bad values, so every PIN argument is a `Pin` (its deserializer fails with a fixed message whatever it is given, its `Debug` is redacted) and every argument struct holding one is wrapped in `Obj` (a non-object payload such as `"1234"` fails before serde can quote it).

## Wrong-PIN lockout

Every PIN check (`unlock`, `disable`, `configure`, `setLocked` removal, `setPin` current PIN) goes through one place, serialized by a write mutex so concurrent tries are all counted.

- A wrong PIN increments `failed_attempts`. Tries 1 to 4 fail with `auth` ("Wrong PIN. 3 tries left before a pause.").
- From the 5th wrong PIN on, `lockout_until` is set to now + 30 s, doubling with each further wrong PIN (60, 120, 240) up to 300 s. The try that starts a lockout already fails with `conflict`, `retryable: true`, `details: {retryAfterSeconds}` ("Too many wrong PINs. Try again in 30 seconds.").
- During a lockout the PIN is not checked at all, right or wrong: every PIN command fails with that `conflict` and the try is not counted.
- A correct PIN clears the counter and the lockout.
- Counter and lockout are stored, so they survive a restart. `ParentalStatus.failedAttempts` and `retryAfterSeconds` (seconds left, rounded up; absent when not locked out) report them.

## Session unlock

- `parental.unlock {pin}` starts an unlock of `unlockMinutes` (0 = until the app restarts). It lives in memory only; a restart is always locked.
- `parental.lockNow` ends it. `parental.disable` ends it too. The UI calls `lockNow` from Settings > Parental controls, the command palette, and Ctrl+Alt+L (`mod+alt+l`, bound in `src/features/parental/status.ts` only while a PIN is set and an unlock is running, and not while typing, since Ctrl+Alt is AltGr on Windows).
- Changing `unlockMinutes` applies to the next unlock, not the running one.
- Expiry is found two ways, and either emits `parental.changed` once: lazily, by every parental, catalog and user-state reader call (they all go through `hide_filter` or `status`); and by a timer task started from `parental::init` (via `rpc::init_all`) that sleeps until the unlock ends (at most 60 s at a time, woken when an unlock starts or ends). The timer holds a weak reference to `AppState` and stops with it.
- Tests move the clock with `parental::advance_clock` (hidden from docs; the app never calls it).

## Events

`parental.changed`, payload `ParentalStatus`, after every change: PIN set or changed, disable, configure, unlock, lock now, an expired unlock, a wrong PIN (new counter or lockout; a try refused during a lockout re-sends the same status), a lock added or removed (only when the table changed: adding an existing lock with the same name emits nothing), and a backup import that added locks or applied options. A read emits only when it is the first to notice an expired unlock. The payload never carries PIN material.

## Modes

- `hide` (default): the core drops locked content from the readers below. Nothing to gate in the UI because nothing locked is listed.
- `ask`: the core filters nothing. The UI marks and gates locked items using `parental.check` (and `parental.adultCategories` for badges) and asks for the PIN before it plays or opens one.
- Both apply only while a PIN is set and no unlock is active. `parental.check` returns the locked refs in either mode, and nothing while controls are off or unlocked.

## What counts as locked

An item is locked when any of these holds:

1. an `item` lock on `(source, type, item id)`;
2. a `category` lock on `(source, type, the item's category id)`;
3. `autoAdult` is on and the item's category name is adult (`parental::is_adult_category`).

`is_adult_category`: case-insensitive whole-token match of `XXX`, `ADULT`, `ADULTS`, `18+`, `+18`, `PORN`, `EROTIC`, `PLAYBOY`, `HUSTLER` or `PRIVATE`. A token is a run of letters, digits and `+`; anything else separates tokens, so `[XXX]`, `|18+|` and `VOD | ADULT` match while `Pornography`, `Adulting`, `XXXL` and `118+` do not. `ADULT` directly followed by the token `SWIM` is the "Adult Swim" channel brand and is not adult (`Adult Swim Adult` still is, through its second `ADULT`). The same function is registered on every pooled connection as the SQL function `adult_category(name)` (from `catalog::language::register`), so the filters and the Rust code cannot disagree.

## Hide mode in the readers

`parental::hide_filter(state)` returns `Some(Hide { auto_adult })` while hide mode applies; readers pass it down and append the SQL from `filter.rs` to their `WHERE`:

| Shape | Used by | SQL |
| --- | --- | --- |
| `scoped` | `catalog.channels` / `movies` / `series` (page and `total`, every sort, in-list FTS search and its LIKE fallback, category pages), `catalog.neighbors`, `catalog.allLiveChannels` | `i.rowid NOT IN (... UNION ALL ...)` over the rowids of this source and type in locked or adult categories (from `idx_items_cat` ranges) and of locked items (by primary key). One non-correlated set built once per statement; each part is left out when that source and type has nothing locked or adult, and the clause is left out entirely when both are, so an unlocked source pays nothing. Rowids are in every index, so a hide-mode `count(*)` stays index-only. `catalog.channels` puts the clause after the search term, so the FTS matches are found before the set is probed. |
| `item_set` | `catalog.search` (all sources) | Row-value `(source_id, content_type, item_id) NOT IN (item locks)` and `(source_id, content_type, category_id) NOT IN (category locks UNION ALL adult categories)`. |
| `item_row` | `catalog.recentlyAdded`, `catalog.sameTitle`, `catalog.channelByNumber` (null when the channel is hidden), `catalog.item` | Correlated primary-key probes of `parental_locks` and `NOT adult_category(c.name)` on the joined category. |
| `by_ref` | `favorites.list`, `recent.list`, `positions.continueWatching`, `watchlist.list` | The row's own item lock; its category's lock and adult name when the item's category is known: from `items`, or for Stalker movies and series (never in `items`) from the remembered portal row, `stalker_items.category_id`. Entries whose item is gone from both are hidden only by an item lock. |

`catalog.categories` drops locked categories and (with `autoAdult`) adult ones, subtracts locked items from each remaining category's `itemCount` (counting only items the catalog has, and with English-only only items that filter keeps), and drops a category that this empties. `includeHidden: true` (category management) gets the same treatment: a locked category cannot be found and unhidden there either.

`catalog.item` on a hidden item fails with `not_found` ("catalog item X is locked by parental controls; unlock them to open it"), so a deep link or a stale reference cannot open it.

Totals of catalog reads count only what the pages can show, so paging and "N channels" labels stay right.

Readers outside the catalog:

- Stalker VOD pages are not stored in the catalog. `stalker.movies` and `stalker.series` (and `stalker.search`, which runs through them) drop what `parental::hidden(state, items)` returns for the page (`drop_hidden` in `stalker/rpc.rs`, with each row's category id). Their `total` stays the portal's count, as for rows the mapping drops: the portal cannot say how many hidden titles later pages hold.
- `live.alternates` drops every alternate `catalog::is_visible` rejects, so failover never switches to a hidden channel.
- Provider detail commands (`xtream.vodDetail`, `xtream.seriesDetail`, `stalker.vodDetail`, `stalker.seriesDetail`) and the stream and catch-up URL commands (`xtream.streamUrl`, `xtream.catchupUrl`, `stalker.streamUrl`, `stalker.catchupUrl`) take a ref directly, so they call `parental::refuse_hidden` first and fail with the same `not_found` as `catalog.item`. A remembered route, the zap history (B / Shift+B) or a resume record cannot open or play a hidden title. Episode URLs carry the series ref, so a locked series refuses its episodes too.
- Stalker movies and series: `stalker_items` (the persisted row cache, created on demand by the stalker module) keeps the category id each row was listed under. `parental.check` without a `categoryId`, `refuse_hidden` and `by_ref` fall back to it when `items` has no row, so category and adult-category locks reach Stalker titles saved in favorites, history, continue watching and My List. `stalker::init` adds and fills the column in a table an older build made (from the row's own `category_id` field, else the category with the remembered name); `stalker::items_have_categories` guards the SQL until then. The cache's cap (20,000 rows per source, least recently listed evicted first) never evicts a row whose title is in favorites, history, continue watching or My List.

## Removing sources

A removed source takes its locks with it (`ON DELETE CASCADE`), so removing and re-adding a playlist would shed every lock. `parental::require_unlocked_to_drop_locks(state, source_id, what)` is the guard: while a PIN is set and no unlock runs, it fails with `auth` when the source (`None`: any source) has a lock, and passes a source without locks (such as a fresh one a cancelled add takes back). `sources.remove` and `sources.removeAll` call it before anything changes; backup `replace` calls `require_unlocked` (see Backup).

The Sources page asks first: `removalMayNeedPin()` reads the cached status, and `unlockToRemoveSources(sourceId?, prompt)` (`src/features/parental/gate.ts`) asks for the PIN when the source (or, for Remove all, any source) has a lock, then unlocks the session with it, so the delayed `sources.remove` behind the Undo toast goes through. A removal that still fails with `auth` (the unlock ran out) says so in its toast and refreshes the status, so Try again asks for the PIN.

## Commands

| Command | Args | Result | PIN needed |
| --- | --- | --- | --- |
| `parental.status` | none | `ParentalStatus` | no |
| `parental.setPin` | `{currentPin?, newPin}` | `ParentalStatus` | the current PIN when one is set (`auth` without it) |
| `parental.disable` | `{pin}` | `ParentalStatus` | yes; removes PIN and unlock, keeps locks and options; no-op when already off |
| `parental.configure` | `{pin?, mode?, autoAdult?, unlockMinutes?}` | `ParentalStatus` | `pin` or an active unlock while a PIN is set; absent fields keep their value; `unlockMinutes` 0..720 |
| `parental.unlock` | `{pin}` | `ParentalStatus` | yes; `invalid` when no PIN is set |
| `parental.lockNow` | none | `ParentalStatus` | no |
| `parental.locks` | `{sourceId?}` | `ParentalLock[]` (source, type, kind, name, target id order) | no |
| `parental.setLocked` | `{target: ParentalLockTarget, locked, pin?}` | null | adding: never; removing: `pin` or an active unlock while a PIN is set |
| `parental.check` | `{items: [{ref, categoryId?}]}` (at most 500) | `ItemRef[]` locked now, input order, duplicates collapsed | no |
| `parental.adultCategories` | `{sourceId, contentType}` | category ids whose name is adult, whether or not `autoAdult` is on | no |

Errors use the existing codes: `invalid` (malformed args, bad PIN format, out-of-range `unlockMinutes`, empty or over-long (512) target ids, more than 500 check items), `auth` (missing or wrong PIN), `conflict` (lockout, retryable, `details.retryAfterSeconds`), `not_found` (lock on a source that does not exist). `parental.check` looks `categoryId` up from the catalog when it is absent or empty.

## Backup

Tsrust extensions of the manifest (IPTVnator ignores unknown keys):

- `settings.tsrustParental`: `{mode, autoAdult, unlockMinutes}`, always exported.
- Per playlist entry, `userState.tsrustParentalLocks`: `[{contentType, kind, targetId, name, createdAt}]`, when the source has locks.
- Per playlist entry, `userState.tsrustWatchlist`: My List rows from `watchlist::export_entries`, restored with `watchlist::import_entries` (C3).

The PIN, its hash and its salt are never exported; a restored app has controls off until a PIN is set (the backup test checks the file for all three).

Import:

- Locks are added to the source the entry was imported into (existing locks stay; adding needs no PIN, as with `parental.setLocked`). Unreadable rows are skipped with a warning ("N parental lock(s) in the backup were not readable and were skipped").
- Options are applied only while controls are off or unlocked. While a PIN is set and locked, a backup must not weaken them: they are skipped with a warning ("Parental settings in the backup were not applied: ...").
- `mode: "replace"` removes every current source and their locks with them, so it fails with `auth` ("Parental controls are locked. Unlock them with the PIN to replace your sources from a backup.") while a PIN is set and locked, before anything changes. `parental::require_unlocked` is the check; anything else that deletes sources wholesale should call it too.

## Performance

Measured on 50k channels in 250 groups, 10 groups adult by name, 2 locked, 200 channel locks (`hide_mode_queries_on_50k_channels_stay_fast`):

- Release build, the bar (100 ms a call, 400 ms for the zap list): categories 1 ms, first page 15 ms, deep page (offset 47 300) 48 ms (47 to 64 ms with the rest of the file running in parallel), group page 2 ms, sorted by name 15 ms, in-list search 13 ms, global search 6 ms, channel by number under 1 ms, zap list (20k rows) 74 ms, neighbors 2 ms. Debug is about 1.5x that; its budgets are doubled in the test.
- The first `scoped` shape tested `i.item_id` and `i.category_id` directly. Neither is in `idx_items_pos`, so the hide-mode count read all 50k table rows (30 ms instead of 3 ms) and the deep page took 71 ms in release, over 100 ms under parallel load. The rowid set halves both.
- `locked_item_counts` uses `CROSS JOIN` to keep the locks as the outer loop. With a plain join SQLite walked every item of the source through `idx_items_cat` to get its `GROUP BY` order for free: 250 ms instead of 1.5 ms.

## Tests

- `crates/iptv-core/tests/parental.rs`: registration; config defaults; PIN rules and storage (salted hash, new salt per PIN, nothing in status or events); setPin, disable, configure rules; the lockout timeline 30/60/120/240/300/300 and its persistence across a restart; unlock, lock now, `unlockMinutes: 0`; lazy and timer expiry; events; locks (add without PIN, remove with PIN or unlock, validation, unknown source, cascade on source removal); `check` and `adultCategories`; every reader above in hide mode, hide mode without `autoAdult`, ask mode, unlocked and without a PIN; paging totals; `catalog.item` and the four provider detail commands; the backup round trip with no PIN material in the file, a locked app refusing weaker options and Replace, unreadable rows; and the 50k-channel budget.
- Unit tests in `parental/mod.rs`, `store.rs`, `pin.rs` (PBKDF2 against known vectors, constant-time compare) and `rpc.rs` (registration, malformed args, PINs never echoed).
- `tests/watchlist.rs` covers My List in hide mode.
