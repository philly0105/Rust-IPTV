# My List (watchlist)

Code: `crates/iptv-core/src/watchlist/` (core) and `src/features/mylist/` (UI). Tests: `crates/iptv-core/tests/watchlist.rs`, unit tests in `watchlist/mod.rs` and `watchlist/rpc.rs`, `src/features/mylist/test/`, and `e2e/mylist.spec.ts`.

My List is a user-ordered list of movies and series to watch later (contract C3). Live channels and radio are not saved there; favorites cover those. Each row is keyed by an `ItemRef` and stores a snapshot (title, subtitle, poster) taken when the title was added. The list renders without the catalog and survives a catalog refresh that drops the item.

## Storage

Migration `0012_watchlist.sql` creates the `watchlist` table:

| Column | Notes |
| --- | --- |
| `source_id`, `content_type`, `item_id` | Primary key. `source_id` references `sources(id)` with `ON DELETE CASCADE`. `content_type` is checked to be `movie` or `series`. |
| `title`, `subtitle`, `poster_url` | The snapshot. Titles and subtitles are trimmed and cut to 500 characters. Blank parts become `NULL`. A poster URL longer than 4096 characters is dropped, because a cut URL never loads. |
| `added_at` | RFC 3339 UTC with milliseconds, from `userstate::now_ts`. |
| `position` | The user's order, ascending. |

Order is `position ASC, added_at DESC, rowid DESC`. A new entry takes `MIN(position) - 1`, so the newest add is on top until the user reorders. The other two keys only break ties between imported rows.

The table does not store watched state. `watchlist.list` reads it from the item-level `playback_positions` row (`episode_id = ''`, `watched = 1`), which is the row `userstate.setWatched` writes without an episode id. For a series, that row means the whole series was marked watched. Episode rows do not count, because the core does not know a series' full episode list. So the UI offers the watched tick for movies only, and series are marked episode by episode on their own page.

A row without a stored poster falls back to the catalog's current poster or logo for the item.

### Source removal

Removing a source deletes its rows through the cascade, so `sources::store::delete` needs no extra step. While a source removal is waiting out its Undo (`usePendingRemovals`), the UI hides that source's titles from the rail and the page.

## Commands (C3)

Every write that changes the list emits `watchlist.changed` (payload `{}`) after it commits. A remove of an absent item changes nothing and emits nothing.

| Command | Behaviour |
| --- | --- |
| `watchlist.list {sourceId?, contentType?}` | The list in the user's order. `contentType` must be `movie` or `series` (`invalid` otherwise). While parental hide mode is on (C2), the result leaves out titles that are locked, in a locked category, or in an adult category, as `favorites.list` does. The rows stay stored and return on unlock. |
| `watchlist.toggle {ref, snapshot}` | Adds the item when absent and removes it when present. Returns `{inList}`. Adding needs a non-blank `snapshot.title` (`invalid`), a known source (`not_found`) and room in the list (`conflict` at 5,000 entries). The ref decides the stored type; the snapshot's `contentType` is ignored. It runs in one IMMEDIATE transaction, so two toggles of the same ref serialize. |
| `watchlist.contains {refs}` | The subset of `refs` that are in the list, in input order with duplicates collapsed. Live, radio and blank refs are skipped rather than rejected, so a mixed grid can ask about every card. At most 5,000 refs. |
| `watchlist.remove {ref}` | Removes one entry. Removing an absent item is not an error. |
| `watchlist.reorder {refs}` | One transaction. The listed titles fill the slots they held before, in the given order, and unlisted titles stay in place. Refs not in the list are ignored, and a ref listed twice keeps its first place. A client may send only the part it reordered: swapping two neighbours needs just those two refs. Titles the client cannot see (for example ones hidden by parental controls, C2, or filtered out on screen) are unlisted, so a reorder sent from a hide-mode list leaves the locked titles in their places. |

Live and radio refs, blank ids and ids over 2048 characters are `invalid` for `toggle`, `remove` and `reorder`.

## Backup

The backup manifest carries My List per source in the `tsrustWatchlist` extension of each playlist entry's `userState` (`backup::EXT_WATCHLIST`). The signatures the backup module calls are fixed:

- `export_entries(conn) -> Vec<WatchlistBackupEntry>`: every row in list order. `position` is the index in that order (0, 1, 2...), not the stored number, so export is stable across replace-import and re-export.
- `import_entries(conn, entries, replace) -> usize`: runs inside a savepoint. On error nothing changes, and it nests inside the caller's transaction. `replace` clears the list first; otherwise entries merge. Entries are applied in `position` order, and only the first per item counts. Live and radio entries, blank ids or titles, unknown sources, and new entries past the 5,000 cap are skipped. A merge keeps an existing row's place and snapshot, fills a missing subtitle or poster, and keeps the earlier `addedAt`. New rows go after the existing ones. `addedAt` accepts RFC 3339, unix seconds or milliseconds, or SQLite format; anything else becomes the import time.

The import reports skipped entries as a warning and emits `watchlist.changed` when it changed anything (always on replace).

## UI

`src/features/mylist/index.ts` exports:

| Export | Use |
| --- | --- |
| `MyListButton {itemRef, snapshot, variant?, size?}` | The add/remove toggle. `variant="button"` (default) for detail pages; `variant="icon"` for poster corners, placed as a sibling overlay of the poster link (not inside it). It renders nothing for live and radio refs. It is a real toggle (`aria-pressed`), and the state flips at once. Until the shared list has loaded, the button does not guess: it shows a plain bookmark (the `button` variant a spinner), is busy (`aria-busy`) and `aria-disabled`, and has no `aria-pressed`. After a failed read it offers to read the list again instead of toggling. A failed write rolls back with a toast that says why. Adding toasts with "Open My List"; removing toasts with Undo, which puts the title back where it was. Callers pass the base title (`titleBase`) with the year as the subtitle: `myListTarget` builds that for posters and the movie and series pages do the same, so a title reads the same wherever it was saved. |
| `MyListRail {hideError?}` | The dashboard rail: up to `MY_LIST_RAIL_LIMIT` posters in the user's order, a count, and "See all". It renders nothing when `settings.dashboardRails.myList` is off or the list is empty. |
| `myListRoutes` | `/my-list` (lazy). Mount among the shell layout route's children. |
| `useInMyList(refs)` | A `Set` of `${sourceId}\|${contentType}\|${itemId}` keys for the refs that are saved. One shared query answers every card. |
| `useMyListState()` | The saved keys plus `status` (`loading`, `error` or `ready`) and `retry`, for callers that must not act on an unknown list. |
| `useMyListMenuItem(target)` | The same toggle shaped as a context-menu action (`MenuAction`); `null` for no target or a live ref. The category-grid poster menu uses it (right click, Shift+F10, or the context-menu key). |
| `useMyListToggle` | The toggle behind the button, the menu item and the grid's S key. While the list is unknown (loading or failed) it sends nothing and shows an info toast. |
| `useMyList`, `MY_LIST_PATH`, `canSave` | Lower-level pieces of the above. |

On the movie and series category grids (`src/features/vod/pages/CategoryGridPage.tsx`), each poster shows a saved marker once the title is in My List and a corner toggle (`GridMyListToggle` in `src/features/vod/components/PosterCard.tsx`). A listbox option cannot hold a nested button, so the toggle is pointer only and hidden from assistive technology, and the option's name says "In My List" instead. S toggles My List on the title under the grid cursor, and the poster menu (right click, Shift+F10, or the context-menu key) offers Open details and Add to or Remove from My List.

Every piece reads one shared `watchlist.list {}` query (`lib/cache.ts`: `LIST_KEY`), and writes patch that cache first. `watchlist.changed` should invalidate `watchlist.` through `EVENT_INVALIDATION`. Watched changes refresh positions, user state and the list together (`refreshWatched`). The /my-list page reads the list with a 5-minute stale time (`MY_LIST_STALE_MS`), so a visit within that time shows the cached list without asking again. Because some writes to playback rows only mark `positions.` stale, `lib/cache.ts` marks the list stale too whenever a `positions.` query is invalidated, without refetching, so the next page or rail mount reads the watched ticks again.

### The /my-list page

- It opens as a poster grid (`MyListCard` in a `VirtualCardGrid`); the View switch in the toolbar turns it into ranked rows (`MyListRow`), and the choice is kept in localStorage (`mylist.view`, only `list` is stored). Rank, the grip and the move buttons are the list view's; Enter, Delete, W and Alt+arrows work on the focused card in both. When the focused card or row goes (Delete, its remove button), focus moves to the one now in its place, or the one before when it was the last, so the keys keep working without a click.
- Filter by type (pill tabs with counts), sort by the user's order, newest add, or title, hide watched titles, and search in the page toolbar (a `data-page-search` box that Ctrl+F focuses; Enter or ArrowDown moves on to the list). All four live in the URL (`?type=movie|series`, `?sort=added|title`, `?watched=hide`, `?q=`). Search folds case and accents and needs every word in the title or subtitle.
- In the user's order each row shows its rank in the whole list and can be moved three ways: drag the grip (fine pointers), the up/down buttons, or Alt+ArrowUp and Alt+ArrowDown on the focused row. In a filtered view a move reshuffles only the rows on screen, and the other titles keep their slots. Moves read the cache rather than the last render, so key repeats stack. They reach the core one at a time, in press order, with one refetch after the last. A failed reorder puts the old order back with a toast.
- The row is the keyboard stop, and arrow keys rove between rows. Enter opens the title, Delete removes it with Undo, and W marks a movie watched or unwatched with Undo. The shortcuts are registered under the "My List" area of the `?` overlay. They act only on a focused row, never while typing.
- The page has designed states for loading (a skeleton with the row geometry), errors (with a hint and Try again), an empty list (browse links to the first source with movies or series, or "Add a source" when there is none), an empty type filter, all-watched with Hide watched on, and no search match. Each one offers the action that gets out of it.
- The layout works from 390 px to wide desktop. Below 640 px (`sm`) the rank sits on the poster's corner, and the row actions take a line under a two-line title. It uses logical properties for RTL, `motion-safe:` for transitions, and `--color-*` tokens.
