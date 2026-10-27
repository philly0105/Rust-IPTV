# Settings and window state

Code: `crates/iptv-core/src/settings/`. Tests: `crates/iptv-core/tests/settings_rpc.rs` plus unit tests in `mod.rs`.

`Settings` (model.rs) is stored as one JSON document in the C3 `settings` table (`id = 1`). `AppState` loads it at startup into `state.settings`. This module is the only writer.

## Commands (C4)

| Command | Behaviour |
| --- | --- |
| `settings.get` | Current settings. |
| `settings.update {patch}` | RFC 7396 merge patch over the current JSON: objects merge recursively, `null` removes a key (so the field falls back to its default or `None`), anything else replaces. The result is deserialized, normalized and validated, then persisted, cached in `state.settings`, and announced with `settings.changed` (payload: the full settings). A patch that changes nothing writes nothing and emits nothing. A change to `lastRoute` alone is saved and returned but not announced: it is one window's navigation state, and broadcasting it made every window refetch and re-render its settings readers on each navigation. The caller writes the reply into its own `settings.get` cache (`useLastRoutePersistence` in `src/shell/effects.ts`, `StartupRedirect.tsx`). Any other change, alone or with `lastRoute`, is announced as before. |
| `settings.reset` | Writes `Settings::default()` and emits `settings.changed`. `tourCompleted` and `lastSeenVersion` keep their values: they record what the user has already seen, so a reset neither replays the first-run tour nor shows What's new for an unchanged version (the tour can still be replayed by hand). `epgUrls` and `tmdb.apiKey` keep their values too: they are data the user entered, and no default can restore them; `tmdb.enabled` and `tmdb.language` reset. `imageCacheMaxMb` resets to 500 like any preference. |
| `settings.detectPlayers` | `crate::player::detect(&settings)` on the blocking pool. Returns `{mpvPath?, vlcPath?}`. Desktop only: in server mode it returns `Unsupported` ("Players run only in the desktop app"), like `player.detect`, so a browser never learns the server's player paths. |
| `window.getState` | `app_state` key `window_state`, or `null`. Unreadable JSON reads as `null`. |
| `window.setState {state}` | Validates and stores `{x?, y?, width, height, maximized}`. |

Writers are serialized by a `tokio::sync::Mutex` stored in `state.extensions["settings_write_lock"]`, so two concurrent patches cannot lose each other's fields. The row is then written through `AppState::db_write`, the gate that admits one user write at a time to the database pool (lock order: the settings lock, then the gate). While an import holds SQLite's write lock, a burst of `lastRoute` writes, favourite toggles and position saves waits at the gate instead of taking every pooled connection from the readers.

## Normalization

Strings are trimmed, and empty optional strings (`mpvPath`, `vlcPath`, `downloadsDir`, `recordingsDir`, `lastRoute`) become `None`. `language` is lowercased. `epgUrls` and `downloadSingleConnection` are trimmed, emptied entries dropped, and exact duplicates removed (first one wins).

## Validation (errors are `Invalid`)

- `language` must be one of the 19 UI languages: ar, ary, by, de, el, en, es, fr, hu, it, ja, ko, nl, pl, pt, ru, tr, zh, zhtw.
- `remoteControl.port` must be in 1024..=65535 (u16 rejects larger values during deserialization).
- `mpvPath` and `vlcPath` must be existing files, and `downloadsDir` and `recordingsDir` existing folders. These are checked only when the value changes, so a setting that pointed at a since-removed path does not block unrelated updates.
- `epgOffsetMinutes` must be in -720..=720 (an integer), and `vodMinRating` a number in 0..=10.
- `lastRoute` must start with `/` and be at most 2048 characters.
- `sourceRefreshIntervalHours` 0..=168, `accountExpiryWarnDays` 0..=60.
- `recordingPaddingBeforeMinutes` 0..=60, `recordingPaddingAfterMinutes` 0..=120, `reminderLeadMinutes` 0..=60.
- `uiScale` is rounded to 4 decimal places first (slider noise such as `1.2500000000000002`), then must be finite and in 0.9..=1.25 (`UI_SCALE_RANGE`).
- `subtitlePosition` must be a whole number in 0..=40 (`SUBTITLE_POSITION_RANGE`); a fraction or a negative number fails deserialization.
- `imageCacheMaxMb` must be a whole number in 50..=5000 (`IMAGE_CACHE_MAX_MB_RANGE`).
- `lastSeenVersion` must be `''` or 1..=32 characters of `[0-9A-Za-z.+-]` (a version such as `0.1.0` or `1.2.0-beta.1+42`).
- Unknown enum values or wrong types fail deserialization.
- Window state: width and height 1..=32768 px, and |x|, |y| <= 100000.

`settings::save(state: &AppState, next: Settings) -> CoreResult<Settings>` is the Rust entry point for modules that change a field directly (for example `downloads.setDir`). It normalizes, validates against the current settings, persists, refreshes the cache and emits `settings.changed` (with the same `lastRoute`-only exception), under the same lock. Empty strings for `mpvPath`, `vlcPath`, `downloadsDir` and `lastRoute` are normalized to unset before validation, so the UI clears a path by sending `""`.

## Desktop-only fields (server mode)

When `state.is_desktop` is false (the PWA server), `settings.update` refuses with `Unsupported` ("player and folder settings apply only to the desktop app") any patch that changes `mpvPath`, `vlcPath`, `mpvArgs`, `vlcArgs`, `downloadsDir` or `recordingsDir`. Any browser on the network can reach the server, and these fields name programs, their arguments and folders on the host. The check runs before validation, so a refused patch reveals nothing about which paths exist. Sending the current values back unchanged (a full-document patch) is allowed. `settings::save` applies the same rule except for `downloadsDir`, whose only caller (`downloads.setDir`) enforces its own server rule. `settings.reset` is allowed and keeps these six fields as they are: a server client cannot set them, so an Undo that sent them back would be refused.

The browser UI follows the same rule: Settings has no External players section there, Settings > Playback shows the built-in player as a single row with a note that mpv and VLC are in the desktop app (a saved `mpv` or `vlc` shows, and plays, as the built-in one), and Settings > General names the downloads folder, and Settings > Recording the recordings folder, as read-only text instead of offering inputs the core would refuse.

## The Settings page

`src/features/settings/SettingsPage.tsx` shows one section per route (`/settings/<section>`). From 768 px up the section nav is a sticky column at the page's inline start, grouped as App (General, Appearance, Shortcuts), Watching (Playback, External players, Guide, Recording, Metadata), Household (Parental controls, Remote control) and System (Backup and storage, About); the chosen section has the selected fill and the tuning tick. Below 768 px `/settings` is a list of the sections with their one-line leads, and each opens on its own screen whose shell header names the section and holds the way back to the list (the header's Back, labelled "Settings"; `allSettings`): the page's sr-only h1 says the same as the header, the section's h2 is visually hidden below md (`max-md:sr-only`), and the window title stays "Settings". From the list Back goes back in history; a section opened any other way replaces itself with the list. On a touch-only device (`TOUCH_ONLY_QUERY`, `(hover: none) and (pointer: coarse)`) the nav leaves out Keyboard shortcuts; its route stays, so the palette or a link still opens it. The page does not use the shell's context panel.

A section is a heading and groups of rows (`SettingsGroup`). The heading is `text-title-sm`, a step under the shell header's "Settings", so the header stays the page title. There is no lead under it: the lead only listed the groups below, and the phone's list of sections, where it helps pick one, still shows it (every section has one there, About included). When a section has more than one group, every group has a title, so an untitled group never reads as the overflow of the one above; a single-group section such as Metadata may go without. A test renders every section and checks the rule. The command palette keeps its own copy of the section ids (`SETTINGS_SECTIONS` in `src/shell/CommandPalette.tsx`, checked against `SECTION_IDS` by a shell test) and its labels and search words in `shell.json` (`settings<Section>`, `settings<Section>Keywords`).

Where rows live:

- General: language, on startup and window at startup, how sources refresh and how early a subscription warns (`sourceRefreshIntervalHours`, `accountExpiryWarnDays`), the catalog filters (country prefix, English only, minimum rating) and the downloads folder.
- Appearance: theme (three cards side by side at every width; under `@md` the previews are shorter and the hint lines go), with OLED black, the accent color group (its title and hint describe the swatches; the live preview sits under them), size and spacing (density, interface size on one line like Minimum rating, with Reset, the slider and its step ticks, and the value; poster size, `coverSize`), and the Home screen group (`showDashboard`, `dashboardRails`).
- Playback: the player, then Streams and playback (stream format and the playback switches), then subtitles.
- Guide: the global XMLTV addresses, then one status row per guide source, led by the source, with its refresh button beside the switch; then Display (the view, time shift and short-guide fallback).
- Recording: Recordings (the folder, the padding before and after as one row), and Reminders.
- Metadata: while TMDB is off, a note says what turning it on opens and the rows it governs are dimmed.
- Remote control: the Control page group (whether the remote runs, and its address, show under the switch; the port), then phones on this network.
- Backup and storage: Export in the group's header, Import with a drop zone for the backup file (a dashed container edge, the control border on hover), the image cache row (the settings row's label column; its usage bar is a neutral level that turns to the warning tone from 90 % of the limit, since a level is not progress), and Reset settings.
- About: the product card (mark, name, version, platform, and What's new and Take the tour as one row of equal buttons under the text), links, updates, Your data (each path its own term list, the desktop's Open button beside it), and the folded diagnostics.

## Fields added after wave 1

| Field | Default | Meaning |
| --- | --- | --- |
| `stripCountryPrefix` | `false` | UI strips a leading `XX: ` / `XX \| ` / `[XX] ` tag from channel names. |
| `epgOffsetMinutes` | `0` | UI shifts displayed programme times. |
| `playerReuseInstance` | `true` | External launch closes the previous external player first. |
| `showExternalBar` | `true` | External-playback footer visible. |
| `vodMinRating` | `0` | VOD grids hide items rated below this. |
| `englishOnly` | `false` | Channel lists, VOD grids, categories, search, neighbours, recently added and `allLiveChannels` drop items whose title or category clearly marks another language (`catalog::language`). The verdict is stored with each item (`items.non_english`, migration 0018) and readers filter on it (`AND i.non_english = 0`). Catalogs written before the migration are listed in `english_pending` until a background pass at boot (`language::backfill_pending`) stores their verdicts; meanwhile readers of one such source and type use a per-connection cached temp table of hidden rowids (`language::hidden_rowids`), and cross-source search and recently added test each row with the SQL function `non_english`. catalog.md has the details. Items without a clear language, multi-subtitle and African groups stay. Categories left empty are dropped and `itemCount` counts what remains. Stalker VOD grids filter loaded pages in the UI. |
| `liveMinQuality` | `null` | The Live TV quality filter: the lowest picture quality a live channel's name may mark, `"sd"`, `"hd"`, `"fhd"` or `"uhd"` (the failover matcher's `Quality`); `null` = off. Channel lists, categories, search, neighbours, `channelByNumber`, `allLiveChannels` (and so the phone remote), favorites, recently watched, custom lists, the guide search and `live.alternates` drop live channels whose provider name (`items.title`; a rename does not count) marks a lower quality (`catalog::quality`). The quality is stored with each item as a code (`items.quality`, migration 0022) and readers filter on it; live rows written before the migration get theirs from a background pass at boot (`quality::backfill`) and read as untagged until then. Untagged channels stay unless `liveHideUntagged` is on. Radio, movies and series are never filtered. `"sd"` hides nothing tagged, so the UI does not offer it. There is no row in Settings: the quality picker in the Live TV page's list toolbar (`src/features/live/components/QualityFilterButton.tsx`, not on Radio) writes this field and the next one through the optimistic `useUpdateSettings`, and a Live list or the guide that the filter leaves empty shows `QualityEmptyState`, which offers to turn it off (or to show untagged channels again). A custom list (its page and the Edit channels dialog), Favorites or Recently watched page cannot tell a list the filter emptied from an empty one, so while the filter is on its own empty state adds `QualityFilterNote`, a line saying the filter may be hiding channels with the same buttons. Serialized as `null`, not omitted. catalog.md has the readers. |
| `liveHideUntagged` | `false` | While `liveMinQuality` is set, live channels whose name has no quality tag are hidden too; without a minimum it does nothing. A change to either field, like one to `englishOnly`, refills the phone remote's channel list (`settings::store`). |
| `recordingsDir` | `null` | `null` = `<downloadsDir>/recordings`. Serialized as `null`, not omitted. |
| `sourceRefreshIntervalHours` | `12` | Hours between scheduled refreshes of `autoRefresh` sources; 0 = only at startup. 0..168, else `Invalid`. See sources.md. |
| `accountExpiryWarnDays` | `7` | Days before a subscription's expiry date that the dashboard and source cards warn; 0 = off. 0..60, else `Invalid`. |
| `liveFailover` | `true` | A live channel that fails switches to the same channel on another source. |
| `streamReconnect` | `true` | A dropped or stalled stream is retried quietly before the error shows. |
| `remoteLanEnabled` | `false` | The remote control also listens on private network addresses for paired phones. Desktop only: the server ignores it. |
| `epgShortFallback` | `true` | Xtream channels without XMLTV programmes use the panel's short EPG. |
| `recordingPaddingBeforeMinutes` | `1` | Minutes a scheduled recording starts early. 0..60, else `Invalid`. |
| `downloadSingleConnection` | `[]` | Source ids whose downloads use one connection per file ("Connections per download: 1", Settings > General > Downloads); every other source is Auto. Ids are trimmed, empty ones dropped, duplicates removed. See downloads.md. |
| `recordingPaddingAfterMinutes` | `5` | Minutes a scheduled recording runs past the programme end. 0..120, else `Invalid`. |
| `remindersEnabled` | `true` | Guide reminders fire while the app runs. |
| `reminderLeadMinutes` | `2` | Minutes before the start a reminder fires. 0..60, else `Invalid`. |
| `reminderAction` | `"notify"` | `"notify"` shows a notification; `"switch"` tunes to the channel. |
| `accent` | `"amber"` | Accent colour: `amber`, `teal`, `violet`, `rose`, `lime`, `sky` or `coral`. Settings > Appearance; see appearance.md. |
| `oledBlack` | `false` | Pure black surfaces whenever the dark theme is in effect. |
| `density` | `"comfortable"` | `"compact"` tightens spacing in lists, rails and rows. |
| `uiScale` | `1` | Interface size, 0.9..1.25 (the root font size is 15 px times it). |
| `zapBanner` | `true` | The player shows the channel's logo, number and now/next for 5 s after each live channel change. Settings > Playback. |
| `dashboardRails.myList` | `true` | The dashboard's My List rail (Settings > Appearance, Home screen). |
| `subtitleSize` | `"medium"` | Subtitle text size in mpv and the built-in player: `small`, `medium`, `large` or `xlarge` (0.8, 1.0, 1.25 and 1.5 times the base size; mpv `sub-scale`, the built-in player's `::cue`). Settings > Playback. |
| `subtitleColor` | `"white"` | Subtitle text colour: `white`, `yellow`, `cyan` or `green`. |
| `subtitleBackground` | `"box"` | Behind subtitle text: `shadow` (a text shadow only), `box` (a translucent box) or `solid` (an opaque black box). |
| `subtitlePosition` | `0` | Percent of the picture height subtitles are raised from the bottom, a whole number 0..40 (`SUBTITLE_POSITION_RANGE`), else `Invalid`. |
| `vodHideWatched` | `false` | The movie and series grids' Hide watched toggle (Shift+W): `catalog.movies` / `catalog.series` are asked with `hideWatched`. See vod-browsing.md. |
| `imageCacheMaxMb` | `500` | Size cap of the poster and logo cache in MB, 50..5000, else `Invalid`. Applies in server mode too (to the server's cache). Settings > Backup and storage, image cache row (250 MB to 5 GB); see image-cache.md. |
| `tourCompleted` | `false` | The first-run tour was finished or skipped, so it does not start on its own again. Kept by `settings.reset`. See onboarding.md. |
| `lastSeenVersion` | `""` | The app version whose What's new the user has seen; `''` on a fresh profile. Kept by `settings.reset`. See onboarding.md. |

Parental controls are not part of `Settings`: their options and PIN live in the `parental_config` table and change only through the `parental.*` commands (see parental.md); Settings > Parental controls is their page.

`backup::APP_SETTING_KEYS` lists the fields that round-trip through `backup.export` / `backup.import`: the general fields (`language`, `theme`, `showDashboard`, `dashboardRails`, `startupBehavior`, `openStreamOnDoubleClick`, `showCaptions`, `coverSize`, `epgViewMode`), the player and list fields (`streamFormat`, `playerAmbientMode`, `playerAutoplayNextEpisode`, `playerUpNextRail`, `fullscreenChannelPanel`, `vodAutoFailover`, `stripCountryPrefix`, `epgOffsetMinutes`, `playerReuseInstance`, `showExternalBar`, `vodMinRating`, `englishOnly`, `liveMinQuality`, `liveHideUntagged`), `sourceRefreshIntervalHours`, `accountExpiryWarnDays`, `epgShortFallback`, the five recording and reminder fields (`recordingPaddingBeforeMinutes`, `recordingPaddingAfterMinutes`, `remindersEnabled`, `reminderLeadMinutes`, `reminderAction`), the five appearance and playback fields (`accent`, `oledBlack`, `density`, `uiScale`, `zapBanner`), and Run 2's four subtitle fields and `vodHideWatched` (`subtitleSize`, `subtitleColor`, `subtitleBackground`, `subtitlePosition`, `vodHideWatched`): 41 keys. Every other field is in `backup::APP_SETTING_EXCLUDED` with its reason, and a test (`tests/l2_data_backup_settings.rs`) fails for a field in neither list; backup.md lists them. `epgUrls` travels as the manifest's own `settings.epgUrls`. The player choice, its paths and arguments, the folders, `lastRoute` and `tmdb` (it holds the API key) stay out. So do `remoteControl`, `remoteLanEnabled`, `liveFailover` and `streamReconnect`: they describe this machine's playback and network setup. Run 3's three fields (`imageCacheMaxMb`, `tourCompleted`, `lastSeenVersion`) are machine-local too and also left out: a cache cap belongs to this disk, and the onboarding markers to this install. `windowStart` (`normal`, `maximized` or `fullscreen`, how the desktop window opens; desktop.md) stays out as well: it describes this machine's screen.

Stored JSON from older builds reads with these defaults (struct-level `#[serde(default)]`).

A changed default reaches only documents without the field, and every save writes every field, so an existing install keeps the old value. `streamFormat` is the one default moved for them: it became `auto` (Settings > Playback offers Auto, HLS and MPEG-TS; xtream.md says what Auto picks), and migration 0023 rewrote a stored `m3u8`, the old default, to `auto` once. A user who had picked HLS can't be told apart and picks it again; that pick then stays.

`settings.changed` carries the full document; the module never logs the document. In the desktop app it includes `tmdb.apiKey` as stored. In server mode `settings.get`, `settings.update`, `settings.reset` and `settings.changed` all pass through `settings::for_client`, which masks the key as `••••` plus its last 4 characters (only `••••` for 4 or fewer), so a browser on the network never gets it back. A server-mode patch whose `tmdb.apiKey` starts with that mask (the UI resends the whole `tmdb` object, and Undo after a reset resends the old settings) keeps the stored key.
