# Playlist backup (manifest v1)

Code: `crates/iptv-core/src/backup/`. Tests: `crates/iptv-core/tests/backup_import.rs` (check 8), `backup_export.rs`, `backup_run2.rs` (Run 2 check 5) plus unit tests in `mod.rs` and `import.rs`.

The file format is the old app's `PlaylistBackupManifestV1` (`libs/shared/interfaces/src/lib/playlist-backup.interface.ts`), so a file exported by IPTVnator imports here and the reverse also works.

```
{ kind: "iptvnator-playlist-backup", version: 1, exportedAt, includeSecrets,
  settings?: { epgUrls: string[] },
  playlists: (M3U | Xtream | Stalker entry)[],
  tsrustCustomLists?: CustomListBackup[] }
```

## Layout

| File | Role |
| --- | --- |
| `mod.rs` | Types (`ImportMode`, `ImportReport`, `ExportResult`). Direct reads of C3 `sources` rows. Source fingerprints. Import lock. `init`, which retries parked state at boot. |
| `export.rs` | `export` and `build_manifest`. |
| `import.rs` | `import` and `apply_pending_restore`. |
| `rpc.rs` | `backup.export {includeSecrets?, path?}` returns `{json, fileName, path?}` (see Export to a file below). `backup.import {json, mode?, background?}` returns `{imported, skipped, warnings, refreshing?}`, where `mode` is `merge` (the default) or `replace`, and `background: true` makes a merge return before its catalogs load (step 9 of Import). |

## Export

One entry per source, in `sources.list` order. Common fields: `portalType`, `exportedId` (the source id), `title`, `autoRefresh`, `position`.

- m3u: `source.kind` is `url`, `file` or `text`, taken from the config origin. `source.rawM3u` holds the stored playlist text from `m3u_raw`. Also `url`, `userAgent`, `referrer`, `origin`, and `filePathHint`. User state:
  - `favorites`: channel URLs, in favorite order.
  - `recentlyViewed`: `{source:'m3u', id, url, title, category_id:'live', added_at, poster_url?, tvg_id?, group_title?}`.
  - `hiddenGroupTitles`: names of hidden categories.
- xtream: `connection {serverUrl, username, password?}`. User state:
  - `hiddenCategories {categoryType: live|movies|series, xtreamId}`.
  - `favorites {contentType: live|movie|series, xtreamId, addedAt, position}`.
  - `recentlyViewed {contentType, xtreamId, viewedAt}`.
  - `playbackPositions`: `vod` for movies, and `episode` with `seriesXtreamId` plus `seasonNumber`/`episodeNumber` when known. A watched row adds `watched: true` (Tsrust extension). Unwatched rows leave the key out, so they keep the old app's exact shape.
  - `sourcePins {matchKey, contentId, updatedAt}`.
  - Ids that are not numeric are left out, since the old format requires numbers.
- stalker: `connection {portalUrl, macAddress, isFullStalkerPortal, username?, userAgent?, referrer?, origin?, stalkerSerialNumber?, stalkerDeviceId1?, stalkerDeviceId2?, password?, stalkerSignature1?, stalkerSignature2?}`. `favorites` and `recentlyViewed` are `StalkerPortalItem`s: the original portal object when the row came from a backup (kept as `portalItem` in the snapshot), otherwise a minimal `{id, name, title, type, category_id, logo/cover, added_at}`.

Tsrust extensions in an entry's `userState` (`backup::EXT_*`). Export writes each key only when it has data, IPTVnator ignores unknown keys, and backups without them import as before:

- `tsrustEpgMappings` (every kind): manual EPG mappings `[{contentType, itemId, epgChannelId}]`; `epgChannelId: null` means explicitly unmapped. On import a mapping the source already has for the item is kept.
- `tsrustPlaybackPositions` (M3U and Stalker; Xtream uses `playbackPositions`): `[{contentType, itemId, episodeId?, positionSeconds, durationSeconds?, updatedAt, watched?, snapshot?}]` by catalog id. Import follows the same rules as the IPTVnator positions: dated rows only replace older ones, undated rows only fill gaps. M3U rows need the item in the local catalog; Stalker VOD is not stored locally, so its rows apply as they are.
- `tsrustHiddenCategories` (Stalker): `[{contentType, categoryId}]`.
- `tsrustParentalLocks` (every kind): the source's parental locks `[{contentType, kind, targetId, name, createdAt}]`. Import adds them to the source the entry went into (existing locks stay, no PIN needed, as with `parental.setLocked`), even when its catalog did not load; unreadable rows are skipped with a warning. Never PIN material. Details in [parental.md](parental.md#backup).
- `tsrustWatchlist` (every kind): the source's My List rows `[{sourceId, contentType, itemId, title, subtitle?, posterUrl?, addedAt, position}]`. The rows of every entry are stored in one call at the end; `replace` clears My List first, even when the backup has none, and `merge` adds to it. Details in [watchlist.md](watchlist.md#backup).
- `tsrustChannelEdits` (every kind): the source's hidden and renamed channels `[{contentType, itemId, hidden, name?, originalName, updatedAt}]` (`channeledit::ChannelEditBackup`). Import keeps the newer `updatedAt` per channel.
- `tsrustRecordingRules` (every kind): the source's series recording rules `[{contentType, itemId, channelName, title, enabled, createdAt}]` (`recording::RecordingRuleBackup`). Import skips a rule the source already has (same channel and title) and anything past the limit of 100 rules; the scheduler matches airings on its next pass.
- `tsrustWatchLog` (every kind): the source's daily watch log `[{day, contentType, itemId, title, posterUrl?, seconds, lastAt}]` (`stats::WatchLogBackup`). Import skips days outside the retention window and keeps the larger `seconds` of a day that is already there.

These three are stored by their module's own import function under the id the entry went into. They do not need the item in the catalog. Each runs in its own savepoint: unreadable rows are skipped, and a store that fails is rolled back on its own; both show in the entry's "not found and skipped" warning. Watch log rows that `stats::import_log` refuses (an unreadable day, one outside the retention window, a blank title or id, no seconds) are counted in one more warning per entry, "<entry>: N watch history entries in the backup were not restored (...)".

Channel edits and the watch log travel with the rest of the entry's user state, so an entry whose catalog did not load parks them too (step 7 of Import). Recording rules do not: every imported entry's rules are queued and restored once after all entries, after `replace` has removed the old sources (step 8 of Import), through `recording::rules::import_counted` in one write transaction. The old sources' rules therefore do not count toward the limit, and an install restoring its own backup keeps every rule. Rules a full limit leaves out (new ones only; a rule already there is not counted) are reported in one warning, "N series recording rules in the backup were not restored: you can keep up to 100 series rules". `recordings.update` is emitted when any rule was written.

## Custom lists

Custom channel lists mix sources, so they sit at the top level of the manifest under `tsrustCustomLists` (`backup::EXT_CUSTOM_LISTS`), next to `playlists`, and are written only when at least one list exists:

```
{ id, name, position, onDashboard, createdAt,
  items: [{ sourceExportedId, contentType, itemId, title, logoUrl?, position, addedAt }] }
```

`sourceExportedId` is the `exportedId` of the item's source entry. On import every entry records `exportedId -> the source id it was imported as` (a new UUID when the id is taken, the matched source on a merge, the first copy's target for a duplicate entry), and the lists are restored once after all entries, in one transaction, through `lists::import_lists`:

- `replace` deletes every custom list first, even when the file has none, like My List. `merge` adds each list's items to the list of the same name (names compare without regard to case) or creates it, appending the channels it does not hold yet.
- A new list keeps the backup's `id` when it is free and its `createdAt` when readable; names are trimmed, control characters become spaces, and they are cut to 60 characters.
- Items whose source is not in the file are dropped with one warning, "Custom lists (source not in the backup): N channels not found and skipped (examples)". Items refused for another reason (the source did not import, not live or radio, bad ids, the list or the 50-list limit is full) are counted in a second warning. Entries that cannot be read at all (no name, an item without source, type or id) are counted in a third. Lists that cannot be created at all (a blank name, or the 50-list limit reached) are counted in one more, "Custom lists: N lists in the backup were not restored (a blank name, or you can keep up to 50 lists)", even when they hold no items; `lists::import_lists` returns that count (`ListImport.lists_dropped`) next to the lists written and the items dropped.
- An item whose channel is not in the catalog yet is kept and shows as unavailable until a refresh brings it back.
- `lists.changed` is emitted when anything was written, and always on `replace`.

Details of the lists themselves in [lists.md](lists.md).

The manifest's `settings` also carries `tsrustParental` (`backup::EXT_PARENTAL_SETTINGS`): the parental options `{mode, autoAdult, unlockMinutes}`, never the PIN, its hash or its salt. They are applied only while parental controls are off or unlocked; with a PIN set and locked they are skipped with a warning, so a backup cannot weaken them.

M3U entries carry the stored playlist text in `rawM3u`. Playlists over 8 MB keep an empty `m3u_raw.raw` and live in `data_dir/playlists/<id>.m3u`; export and the merge fingerprint both read the text through `m3u::stored_text`, so large file sources export their real text and match on re-import.

## Export to a file

Without `path`, `backup.export` returns the manifest as `json` (serialized on the blocking pool; playlist text makes it tens of MB) and a suggested `fileName` (`tsrust-iptv-backup-YYYY-MM-DD.json`); the UI downloads it. The desktop settings page instead asks for a location with the native save dialog and sends `path`. The core then:

- refuses with `Unsupported` when it runs as the server (`is_desktop` false), so a browser client cannot write files on the server's disk;
- requires an absolute path whose folder exists and that is not itself a folder (`Invalid` otherwise);
- canonicalizes the folder (symlinks and `..` resolved) and refuses any target inside the app data dir (`Invalid`), so a backup can never overwrite the database or cached playlists;
- streams the JSON (`serde_json::to_writer_pretty` through a buffered writer, on the blocking pool, so no string copy of the manifest is made) to a hidden `.<name>.<uuid>.tmp` file in the same folder, flushes it, and renames it over the target (an existing file is replaced; the temp file is removed on failure);
- returns `{json: "", fileName: <file name of the target>, path: <saved path>}`.

A UI that gets a non-empty `json` back (a core that predates `path`) falls back to the download.

`settings` always carries `epgUrls` (possibly empty; IPTVnator reads it unconditionally), the 39 app-level preferences in `backup::APP_SETTING_KEYS`, and `tsrustParental` (above). The keys, in the groups the code lists them:

- general: `language`, `theme`, `showDashboard`, `dashboardRails`, `startupBehavior`, `openStreamOnDoubleClick`, `showCaptions`, `coverSize`, `epgViewMode`;
- player: `streamFormat`, `playerAmbientMode`, `playerAutoplayNextEpisode`, `playerUpNextRail`, `fullscreenChannelPanel`, `vodAutoFailover`, `stripCountryPrefix`, `epgOffsetMinutes`, `playerReuseInstance`, `showExternalBar`, `vodMinRating`, `englishOnly`;
- account: `sourceRefreshIntervalHours`, `accountExpiryWarnDays`;
- guide: `epgShortFallback`;
- recording: `recordingPaddingBeforeMinutes`, `recordingPaddingAfterMinutes`, `remindersEnabled`, `reminderLeadMinutes`, `reminderAction`;
- appearance: `accent`, `oledBlack`, `density`, `uiScale`, `zapBanner`;
- subtitles: `subtitleSize`, `subtitleColor`, `subtitleBackground`, `subtitlePosition`;
- vod: `vodHideWatched`.

Every other settings field is in `backup::APP_SETTING_EXCLUDED` with its reason, and `tests/l2_data_backup_settings.rs` fails for a field in neither list:

| Field | Reason it stays out |
| --- | --- |
| `epgUrls` | Exported as the manifest's own `settings.epgUrls` (listed only so the test accounts for it). |
| `player` | Depends on the players installed here; embedded mpv is desktop-only. |
| `mpvPath`, `vlcPath` | A path on this machine. |
| `mpvArgs`, `vlcArgs` | Tuned for this machine's player build. |
| `downloadsDir`, `recordingsDir` | A folder on this machine. |
| `lastRoute` | Navigation state, not a preference. |
| `tmdb` | Holds the TMDB API key, a secret; `enabled` and `language` need it. |
| `remoteControl` | Network exposure: a restore must never open a port. |
| `remoteLanEnabled` | Network exposure: a restore must never open the remote control to the LAN. |
| `liveFailover`, `streamReconnect` | Describe this machine's playback setup. |
| `imageCacheMaxMb` | Sizes this machine's disk cache. |
| `tourCompleted`, `lastSeenVersion` | Record what this install has shown. |

The remote pairing token is a secret and never appears in a backup.

Secrets (the Xtream password, and the Stalker password and signatures) are written only when `includeSecrets` is true. Nothing in this module logs a connection or a secret. Log lines carry counts and source ids only.

## Import

1. Parse and check. Invalid JSON, a legacy JSON array export, a wrong `kind`, a `version` other than 1, or a missing `playlists` array rejects the file (`Invalid`). Anything else is lenient: a bad entry is skipped with a warning (`skipped += 1`), and a bad user-state item is dropped.
2. `replace` removes every source and their parental locks with them, so while parental controls are on and locked it fails with `auth` before anything changes (`parental::require_unlocked`; the user unlocks with the PIN and imports again). It never deletes first. Every entry is parsed before anything changes, and a backup none of whose entries can be used is refused (`Invalid`, "nothing was replaced"). The backup's playlists are imported next to the existing sources. Only once at least one new catalog has loaded are the old sources removed (user state cascades), with their VOD pins, parked state, Stalker tokens and cached playlist copies (`data_dir/playlists/<id>.m3u`), and the backup's settings applied. When no catalog loads, the new sources are rolled back, the old pins restored, and the call fails with `Invalid`; nothing changes.
3. EPG URLs go through `settings::update`:
   - `merge`: the backup's URLs come first, then the current ones, deduplicated by URL identity.
   - `replace`: exactly the backup's URLs. A replace with no `settings` clears them.

   The app-level preferences present in `settings` are applied in a second `settings::update`. An invalid value becomes a warning. Manifests without them leave the current values alone.
4. Each entry is matched to an existing source by fingerprint, as in the old app:
   - m3u: normalized URL, or else the SHA-256 of the canonical raw text.
   - xtream: server plus username.
   - stalker: portal plus lowercased MAC.

   A match (`merge`) keeps its name (the backup's title is used only when the name is empty), auto refresh, position and config. The backup only fills top-level config keys the saved config lacks (missing, null, `""` or `{}`; for m3u only `headers` and `catchup`, so the origin, URL and file path stay), so an older backup never blanks a saved password or undoes later edits (`fill_blanks`). When the match already holds a catalog and filling changed nothing in its config, step 5 is skipped and step 6 applies the user state to the loaded catalog. Otherwise a new source is created with `exportedId` as its id when that id is safe and free, or a new UUID. A duplicate fingerprint inside the same file is skipped.
5. Catalog:
   - m3u: a new source row is written with its real origin up front: `url`, `file` (only when `filePathHint` exists on disk), or `text` (a match keeps its own, step 4). `rawM3u` is stored in `m3u_raw` with an empty `sha256`, and the m3u importer runs with a `text` origin for this run only, so it parses the embedded text and never downloads anything. Text over `RAW_INLINE_MAX` (8 MB) goes through `m3u::place_raw_text`: it is written to `data_dir/playlists/<id>.m3u` and `m3u_raw.raw` stays `''`, the same layout an import of a large file produces; a text source with `raw = ''` and a cached copy is parsed from that file. On re-import the stored `sha256` survives only when the text is unchanged (inline text compared directly, a cached copy compared by sha). Exception: a `url` entry whose `rawM3u` is empty or only a header (for example a URL source whose first import failed) is imported by fetching its URL instead.
   - xtream and stalker: the registered importer runs against the portal.
   - Success sets `last_refresh_at` and clears `last_error`. Failure stores `last_error`, and the source is kept with a warning.
   - An Xtream entry without a password (exported without secrets, and no saved one on a match) skips the sync with a warning asking the user to add the password.
   - A background merge does not load the catalog here; see step 9.
6. User state is applied by provider id inside one transaction per source:
   - m3u: favorites and recent are matched by channel URL, and groups are hidden by name.
   - xtream: categories are matched by `(type, xtreamId)`. The listed types are unhidden first, so the backup is authoritative. Favorites keep their saved order. Positions map `vod` to the movie, and `episode` to the series row with `episode_id`, with a snapshot subtitle `S{n} E{m}`. `watched` (optional, default false) restores the flag; a watched position is kept even when complete. `sourcePins`, when present, replace the source's pins; when absent they are left alone.
   - stalker: rows are written from the portal items directly. The type comes from `type`/`category_id`/`stream_type`, `is_series`, and `radio`; the id from `id`, `stream_id`, `series_id` or `movie_id`. No catalog is needed.
   - Items that are not in the catalog are skipped. One warning per kind lists the count and up to five ids.
7. When the catalog could not be loaded (m3u or xtream), the entry's user state is parked in `app_state` under `backup_pending:<sourceId>` and is not applied yet. `apply_pending_restore(state, id)` applies it once the source has items, and then deletes the key. `backup::init` retries every parked key at boot.
8. After every entry (and, for `replace`, after the old sources are gone): the recording rules (see the Tsrust keys above), My List, then the custom lists (see Custom lists above).
9. Background merge (`background: true`). `replace` ignores the flag: it removes the old sources only once a new catalog has loaded, so it has to wait for them. In a `merge`, an entry whose catalog must load (not a match skipped in step 4, not an Xtream entry without a password) gets its source row, its user state is parked as in step 7, and its source name is added to `refreshing`. Its parental locks, recording rules, My List rows and custom list items are restored before the call returns, as for any entry. A background task then loads the deferred catalogs one at a time through `sources::run_import_with`, with the usual `import.progress` events. After each load it applies the parked state (a Stalker entry's even when the load failed, as in the foreground), then emits `import.progress {phase: "done"}` for a load that succeeded and `sources.changed`, back to back, so clients refetch once for both; a failed m3u or Xtream load leaves the state parked, as in step 7. The task holds `backup_import_run_lock` until the last load, so the next `backup.import` waits for it.

`imported` counts entries created or merged. `refreshing` names the sources a background merge is still loading and is left out when empty. `sources.changed {reason: "catalog"}` is emitted once at the end of the call without `sourceId` (also when a `replace` rolled back, step 2), and again after each background load with that source's `sourceId`, whether the load succeeded or not (step 9).

Locking: whole imports are serialized against each other by `backup_import_run_lock`, which nothing else takes. The write lock shared with `apply_pending_restore` (`backup_import_lock`) is held only around database writes (the replace wipe, each entry's source row with its config, and its user state), never across a catalog sync. Each entry's sync runs through `sources::run_import_with`, the same per-source lock `sources.refresh` takes. `apply_pending_restore` returns without locking when nothing is parked for the source. A portal that hangs during a restore therefore blocks only that one source; `sources.add` and refreshes of other sources proceed.

## Round trip

Check 8 imports the manifest, then:
- re-imports it in `merge` mode and expects no change;
- exports with secrets, imports that export into an empty store with `replace`, and exports again;
- expects the same `settings` and `playlists` both times.

Run 2 check 5 (`backup_run2.rs`) exports two M3U sources with custom lists, channel edits, recording rules, a watch log day and the five subtitle and VOD settings, then Replace-imports the file into a fresh data folder whose only source already uses one of the exported ids. Everything comes back under the new source ids. It also checks that an IPTVnator file without the Tsrust keys imports as before, that an export with no Run 2 state writes none of the Run 2 keys, that a Merge maps lists by name, that Replace onto an install with 60 rules keeps all 60, and that rules past the limit of 100 are reported.
