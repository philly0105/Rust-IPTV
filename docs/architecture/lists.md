# Custom lists

Code: `crates/iptv-core/src/lists/` (core). Tests: `crates/iptv-core/tests/lists.rs`, `crates/iptv-core/tests/backup_run2.rs` (backup), and unit tests in `lists/mod.rs` and `lists/rpc.rs`.

Custom lists are user-named lists of live and radio channels (Run 2 contract C3). One list can mix channels from several sources. Live shows them as groups, and the dashboard shows each list with `onDashboard` as a rail. Each item is keyed by an `ItemRef` and keeps a title and logo snapshot taken when it was added. A channel the provider drops stays in the list as unavailable instead of vanishing on the next refresh.

## Storage

Migration `0014_custom_lists.sql`:

| Table | Notes |
| --- | --- |
| `custom_lists` | `id` (UUID, primary key), `name`, `position`, `on_dashboard` (default 1), `created_at`, `updated_at`. `idx_custom_lists_name` is unique on `name COLLATE NOCASE`. |
| `custom_list_items` | `list_id` references `custom_lists(id)` and `source_id` references `sources(id)`, both `ON DELETE CASCADE`. `content_type` is checked to be `live` or `radio`. Also `item_id`, `title`, `logo_url`, `position`, `added_at`. Primary key `(list_id, source_id, content_type, item_id)`. `idx_custom_list_items_order` serves list order and `idx_custom_list_items_ref` serves `lists.containing`. |

Timestamps are RFC 3339 UTC with milliseconds (`userstate::now_ts`).

Limits:

- 50 lists (`MAX_LISTS`). Creating a 51st is `invalid`.
- 2000 channels per list (`MAX_ITEMS`). An add that would pass it is `invalid` and writes nothing.
- Names are trimmed and must be 1 to 60 characters (`MAX_NAME_CHARS`) with no control characters. They are unique without regard to case. The check uses Unicode lower case, which is stricter than the index's ASCII `NOCASE`, so "ÉTÉ" and "été" conflict.
- `sourceId` and `itemId` up to 2048 characters. Titles are cut to 500 characters, and a blank title is `invalid`. A logo URL over 4096 characters is dropped, because a cut URL never loads.

Order: `position` ascending, with `rowid` breaking ties. New lists and new items go at the end, and every write keeps positions distinct.

## What a reader sees

`lists.items` returns a list's channels in order with:

- `ref` and `snapshot` (the stored title and logo).
- `channel`: the catalog channel with custom names (`channeledit::apply_names`) and M3U catch-up overrides applied. It is absent when the catalog does not have the channel.
- `available`: whether `channel` is present.
- `position` and `addedAt`.

It leaves out:

- channels hidden by a channel edit (`channeledit::VISIBLE_PREDICATE`);
- while parental hide mode is on, channels that are locked, in a locked category, or in an adult category (`parental::filter::by_ref`).

The rows stay stored, and they come back when the edit or lock goes. `itemCount` in `lists.list` counts what `lists.items` would return, unavailable channels included.

## Commands

| Command | Args | Result |
| --- | --- | --- |
| `lists.list` | none | `CustomList[]` in list order: `{id, name, position, onDashboard, itemCount, createdAt, updatedAt}`. |
| `lists.create` | `{name, items?: {ref, snapshot}[]}` | The new `CustomList`. Duplicate refs in `items` collapse, and the first one wins. |
| `lists.update` | `{id, name?, onDashboard?}` | The `CustomList`. Changing only the case of the list's own name is a rename, not a conflict. |
| `lists.remove` | `{id}` | Nothing. An unknown id is not an error, so a repeated delete is safe. |
| `lists.reorder` | `{ids}` | Nothing. `ids` must name every list exactly once. |
| `lists.items` | `{id}` | `CustomListEntry[]` (above). |
| `lists.addItems` | `{id, items: {ref, snapshot}[]}` | `{added}`. Channels already in the list are ignored. |
| `lists.removeItems` | `{id, refs}` | Nothing. Refs the list does not hold are ignored. |
| `lists.reorderItems` | `{id, refs}` | Nothing. See below. |
| `lists.containing` | `{ref}` | Ids of the lists that hold `ref`, in list order. A movie or series gives `[]`, so a context menu can ask about anything. |
| `lists.neighbors` | `{id, ref}` | `{prev?, next?}` channels for zapping inside a list. |

Errors:

- `invalid`: a bad name, a bad item (not live or radio, blank ids or title), a limit, or a reorder that names something unknown or names it twice.
- `conflict`: another list already has the name.
- `not_found`: an unknown list (every command but `lists.remove`), a ref the list does not hold (`neighbors`), or an item whose source does not exist (`create`, `addItems`).

Nothing is written on any error.

`lists.reorderItems` follows the same rule as `watchlist.reorder`: the listed refs fill the slots they held before, in the given order, and every channel that is not listed keeps its slot. The contract asked for a permutation of every channel. That fails whenever `lists.items` has left channels out (hidden by a channel edit or by parental hide mode), because the UI cannot send refs it never saw. Under this rule, sending back exactly what `lists.items` returned always works, hidden channels stay where they were, and Undo of a removal (re-add the channel, which goes to the end, then send the order shown before) restores the old order. A client may also send just the part it reordered. A ref the list does not hold, or a ref listed twice, is `invalid`, and nothing changes. Lists themselves are never hidden, so `lists.reorder` still requires every list id exactly once.

`lists.neighbors` walks outward from `ref` in list order. It skips channels that are unavailable or that `lists.items` leaves out, and wraps around at both ends like `catalog.neighbors`. `ref` itself may be hidden or unavailable. A list with one other playable channel returns it as both `prev` and `next`. A list with none returns `{}`.

## Events

`lists.changed` (payload `{}`) is emitted after a write that changed something. `create`, `reorder` and `reorderItems` always emit. `update`, `remove`, `addItems` and `removeItems` emit only when they changed a row.

Removing a source deletes its list items through the cascade. `lists::forget_source(state, id)` emits `lists.changed` when any list exists, so counts and rails refresh. It must be called from `sources::remove` after the source row is gone, and it never fails the removal. The call is wired by integration; until then the UI only refreshes on `sources.changed`.

## Backup

Lists cross sources, so the backup writes them at the manifest's top level under `tsrustCustomLists`. Each item names its source by the entry's `exportedId`, and import maps that back to whatever id the source was imported as. Replace clears every list, even when the file has none. Merge adds to the list of the same name. Items whose source is not in the file are dropped with a warning. The details are in [backup.md](backup.md#custom-lists).
