# Sources

Code: `crates/iptv-core/src/sources/`. Tests: `crates/iptv-core/tests/sources_crud.rs` plus unit tests in `mod.rs`.

A source is one playlist provider: an m3u playlist (URL, file or pasted text), an Xtream account or a Stalker portal. Rows live in `sources` (C3). Kind-specific settings are in `config_json`, and EPG links are in `epg_json`.

## Layout

| File | Role |
| --- | --- |
| `mod.rs` | Importer registry and progress (A1), arg types, validation, the service functions (`list`, `get`, `add`, `update`, `remove`, `reorder`, `refresh`, `refresh_all`, `counts`, `run_import`) and `init`. |
| `store.rs` | SQL for `sources`: `SourceConfig`, `list`, `find`, `get`, `insert`, `record_import`, `move_to`, `reorder`, `delete`. |
| `rpc.rs` | Every `sources.*` command in C4. |

## Importers

Each kind registers an `Importer` from its module `init`:

```rust
sources::register_importer(&state, Arc::new(MyImporter));
```

m3u registers in `m3u::init`, xtream in B3's init and stalker in B4's init. An importer only builds the catalog. It may emit `import.progress` phases `fetching`, `parsing` and `saving` through `sources::progress`. It does not touch `last_refresh_at` or `last_error` and does not emit `done`, `error` or `sources.changed`. `run_import` does all of that.

`run_import(state, id)`:

1. Takes a per-source async lock, so concurrent refreshes and a remove of the same source run one after another.
2. Calls the importer.
3. On success it sets `last_refresh_at`, clears `last_error`, refreshes `source_counts` (for stalker, the movie and series totals come from the importer's `ImportSummary`; see Counts), applies user state a backup import parked for this source (`backup::apply_pending_restore`, so restored favorites and positions appear right away rather than on the next start; a failure there is logged and never fails the refresh), and emits `import.progress {phase: "done"}` and `sources.changed`. It then starts the source's guides in the background (see Guides after import).
4. On failure it stores the error text in `last_error` and emits `import.progress {phase: "error", message}` and `sources.changed`. The importer must leave the previous catalog in place, and both catalog write paths do (see catalog.md).

### Guides after import

A successful `run_import` takes the source's guide URLs (`sources::guide_urls`: `detectedUrls` then `manualUrls`, trimmed, blanks and `disabledUrls` dropped, first occurrence kept) and, in a spawned task, calls `epg::spawn_refresh` for each one that needs data. A URL is skipped when its `epg_sources` row is switched off globally (`epg.setEnabled false`) or has status `ok` with a `last_fetch_at` younger than `epg::ingest::STALE_AFTER` (12 h). Never-fetched, failed and stale URLs are queued. This covers every way a source gets imported (`sources.add`, `sources.refresh`, `refreshAll`, the startup auto-refresh, `backup.import`, deep links), so a new source has a guide without waiting for the EPG scheduler or a UI call.

The import never waits for or fails on a guide. Fetch errors land in `epg_sources.error` and the log, with the URL passed through `epg::fetch::log_url`, which redacts credentials (Xtream `xmltv.php` URLs carry the password). A URL that is already refreshing, from the UI's `epg.refresh` or the scheduler, is coalesced by the EPG runtime: `spawn_refresh` returns false and nothing extra runs.

`run_import_with(state, id, fut)` runs any future under the same per-source lock. A partial sync (for example `xtream.sync` with a `contentTypes` subset) uses it so it never interleaves with a full refresh of that source. The lock is not reentrant: the future must not call `run_import` or `remove` for the same source.

## add

`sources.add` checks the arguments before anything is written:

- m3u URL: `http`, `https` or `file`.
- m3u file: must exist.
- m3u text: must not be blank.
- Xtream: the server URL loses a trailing `/` and a pasted `/player_api.php`, `/get.php` or `/panel_api.php`; username and password are required.
- Stalker: the MAC is normalized to `AA:BB:CC:DD:EE:FF`.
- The kind must have a registered importer, otherwise `Unsupported`.

A blank name becomes the last URL path segment, the file name, the server host or "Pasted playlist". The new source goes last in the list. Pasted text is stored in `m3u_raw` in the same transaction.

The importer then runs. If it fails, the source is kept with `last_error` set, and the rpc error carries `details: {sourceId}` so the UI can open the source for editing.

## update, reorder, remove

- `sources.update {id, patch}` validates a config patch the same way. The patch must match the source's kind. `position` moves the source and renumbers the rest. `epg` lists are trimmed and de-duplicated, and only the given lists change. Config changes do not re-import; the UI calls `sources.refresh` for that. When the stored config actually changes (URL, MAC, credentials, headers), the cached portal session `stalker_token:<id>` in `app_state` is deleted in the same transaction, so the next portal call handshakes with the new settings. A rename or an identical config keeps it.
- `sources.reorder {ids}` puts the listed ids first in the given order. Unknown ids are ignored, and unlisted sources keep their relative order after them. Positions are renumbered from 0.
- `sources.remove {id}` waits for a running import of that source, then deletes it. Items, categories, `m3u_raw`, `source_counts`, favorites, recent entries, positions and EPG mappings cascade. The `stalker_token:<id>` and `backup_pending:<id>` keys in `app_state` are removed too.

## refresh

- `sources.refresh {id}` re-imports one source and returns it. It works for any source, whatever its `autoRefresh` setting.
- `sources.refreshAll` re-imports every `autoRefresh` source, one at a time, and returns `{refreshed: [id], failed: [{id, error}]}`.
- `init` spawns a background task that runs `refresh_all` 3 s after boot. Boot does not wait for it. A second `init` call on the same state does nothing.

## Counts

`sources.list` and `sources.get` return `channelCount` (live plus radio), `movieCount` and `seriesCount` from the `source_counts` cache. `sources.counts {id}` returns the same three numbers.

Stalker portals serve VOD and series live; only their categories are stored. For stalker sources `catalog::update_counts` therefore refreshes only `channelCount`, and `run_import` records the portal's movie and series totals from the importer's `ImportSummary` with `catalog::set_remote_counts`. A direct `stalker.sync` (not through `run_import`) must call `set_remote_counts` itself to refresh those two numbers.
