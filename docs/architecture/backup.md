# Playlist backup (manifest v1)

Code: `crates/iptv-core/src/backup/`. Tests: `crates/iptv-core/tests/backup_import.rs` (check 8) plus unit tests in `mod.rs` and `import.rs`.

The file format is the old app's `PlaylistBackupManifestV1` (`libs/shared/interfaces/src/lib/playlist-backup.interface.ts`), so a file exported by IPTVnator imports here and the reverse also works.

```
{ kind: "iptvnator-playlist-backup", version: 1, exportedAt, includeSecrets,
  settings?: { epgUrls: string[] },
  playlists: (M3U | Xtream | Stalker entry)[] }
```

## Layout

| File | Role |
| --- | --- |
| `mod.rs` | Types (`ImportMode`, `ImportReport`, `ExportResult`). Direct reads of C3 `sources` rows. Source fingerprints. Import lock. `init`, which retries parked state at boot. |
| `export.rs` | `export` and `build_manifest`. |
| `import.rs` | `import` and `apply_pending_restore`. |
| `rpc.rs` | `backup.export {includeSecrets?}` returns `{json, fileName}`. `backup.import {json, mode?}` returns `{imported, skipped, warnings}`, where `mode` is `merge` (the default) or `replace`. |

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
  - `playbackPositions`: `vod` for movies, and `episode` with `seriesXtreamId` plus `seasonNumber`/`episodeNumber` when known.
  - `sourcePins {matchKey, contentId, updatedAt}`.
  - Ids that are not numeric are left out, since the old format requires numbers.
- stalker: `connection {portalUrl, macAddress, isFullStalkerPortal, username?, userAgent?, referrer?, origin?, stalkerSerialNumber?, stalkerDeviceId1?, stalkerDeviceId2?, password?, stalkerSignature1?, stalkerSignature2?}`. `favorites` and `recentlyViewed` are `StalkerPortalItem`s: the original portal object when the row came from a backup (kept as `portalItem` in the snapshot), otherwise a minimal `{id, name, title, type, category_id, logo/cover, added_at}`.

Secrets (the Xtream password, and the Stalker password and signatures) are written only when `includeSecrets` is true. Nothing in this module logs a connection or a secret. Log lines carry counts and source ids only.

## Import

1. Parse and check. Invalid JSON, a legacy JSON array export, a wrong `kind`, a `version` other than 1, or a missing `playlists` array rejects the file (`Invalid`). Anything else is lenient: a bad entry is skipped with a warning (`skipped += 1`), and a bad user-state item is dropped.
2. `replace` deletes every source (user state cascades), every VOD pin, parked state, and Stalker tokens.
3. EPG URLs go through `settings::update`:
   - `merge`: the backup's URLs come first, then the current ones, deduplicated by URL identity.
   - `replace`: exactly the backup's URLs. A replace with no `settings` clears them.
4. Each entry is matched to an existing source by fingerprint, as in the old app:
   - m3u: normalized URL, or else the SHA-256 of the canonical raw text.
   - xtream: server plus username.
   - stalker: portal plus lowercased MAC.

   A match is updated in place (`merge`). Otherwise a new source is created with `exportedId` as its id when that id is safe and free, or a new UUID. A duplicate fingerprint inside the same file is skipped.
5. Catalog:
   - m3u: the source is created with `origin = text`, and `rawM3u` is stored in `m3u_raw` with an empty `sha256`, so the m3u importer parses the embedded text and never downloads anything. After the import the config is switched to its real origin: `url`, `file` (only when `filePathHint` exists on disk), or `text`.
   - xtream and stalker: the registered importer runs against the portal.
   - Success sets `last_refresh_at` and clears `last_error`. Failure stores `last_error`, and the source is kept with a warning.
   - An Xtream entry without a password (exported without secrets) skips the sync with a warning asking the user to add the password.
6. User state is applied by provider id inside one transaction per source:
   - m3u: favorites and recent are matched by channel URL, and groups are hidden by name.
   - xtream: categories are matched by `(type, xtreamId)`. The listed types are unhidden first, so the backup is authoritative. Favorites keep their saved order. Positions map `vod` to the movie, and `episode` to the series row with `episode_id`, with a snapshot subtitle `S{n} E{m}`. `sourcePins`, when present, replace the source's pins; when absent they are left alone.
   - stalker: rows are written from the portal items directly. The type comes from `type`/`category_id`/`stream_type`, `is_series`, and `radio`; the id from `id`, `stream_id`, `series_id` or `movie_id`. No catalog is needed.
   - Items that are not in the catalog are skipped. One warning per kind lists the count and up to five ids.
7. When the catalog could not be loaded (m3u or xtream), the entry's user state is parked in `app_state` under `backup_pending:<sourceId>` and is not applied yet. `apply_pending_restore(state, id)` applies it once the source has items, and then deletes the key. `backup::init` retries every parked key at boot. The sources module should call it after a successful `sources.refresh`.

`imported` counts entries created or merged. `sources.changed` is emitted once at the end. Imports are serialized by a lock that is shared with `apply_pending_restore`.

## Round trip

Check 8 imports the manifest, then:
- re-imports it in `merge` mode and expects no change;
- exports with secrets, imports that export into an empty store with `replace`, and exports again;
- expects the same `settings` and `playlists` both times.
