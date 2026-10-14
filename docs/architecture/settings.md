# Settings and window state

Code: `crates/iptv-core/src/settings/`. Tests: `crates/iptv-core/tests/settings_rpc.rs` plus unit tests in `mod.rs`.

`Settings` (model.rs) is stored as one JSON document in the C3 `settings` table (`id = 1`). `AppState` loads it at startup into `state.settings`. This module is the only writer.

## Commands (C4)

| Command | Behaviour |
| --- | --- |
| `settings.get` | Current settings. |
| `settings.update {patch}` | RFC 7396 merge patch over the current JSON: objects merge recursively, `null` removes a key (so the field falls back to its default or `None`), anything else replaces. The result is deserialized, normalized and validated, then persisted, cached in `state.settings`, and announced with `settings.changed` (payload: the full settings). A patch that changes nothing writes nothing and emits nothing. |
| `settings.reset` | Writes `Settings::default()` and emits `settings.changed`. |
| `settings.detectPlayers` | `crate::player::detect(&settings)` on the blocking pool. Returns `{mpvPath?, vlcPath?}`. |
| `window.getState` | `app_state` key `window_state`, or `null`. Unreadable JSON reads as `null`. |
| `window.setState {state}` | Validates and stores `{x?, y?, width, height, maximized}`. |

Writers are serialized by a `tokio::sync::Mutex` stored in `state.extensions["settings_write_lock"]`, so two concurrent patches cannot lose each other's fields.

## Normalization

Strings are trimmed, and empty optional strings (`mpvPath`, `vlcPath`, `downloadsDir`, `recordingsDir`, `lastRoute`) become `None`. `language` is lowercased. `epgUrls` are trimmed, emptied entries dropped, and exact duplicates removed (first one wins).

## Validation (errors are `Invalid`)

- `language` must be one of the 19 UI languages: ar, ary, by, de, el, en, es, fr, hu, it, ja, ko, nl, pl, pt, ru, tr, zh, zhtw.
- `remoteControl.port` must be in 1024..=65535 (u16 rejects larger values during deserialization).
- `mpvPath` and `vlcPath` must be existing files, and `downloadsDir` and `recordingsDir` existing folders. These are checked only when the value changes, so a setting that pointed at a since-removed path does not block unrelated updates.
- `epgOffsetMinutes` must be in -720..=720 (an integer), and `vodMinRating` a number in 0..=10.
- `lastRoute` must start with `/` and be at most 2048 characters.
- `sourceRefreshIntervalHours` 0..=168, `accountExpiryWarnDays` 0..=60.
- `recordingPaddingBeforeMinutes` 0..=60, `recordingPaddingAfterMinutes` 0..=120, `reminderLeadMinutes` 0..=60.
- `uiScale` is rounded to 4 decimal places first (slider noise such as `1.2500000000000002`), then must be finite and in 0.9..=1.25 (`UI_SCALE_RANGE`).
- Unknown enum values or wrong types fail deserialization.
- Window state: width and height 1..=32768 px, and |x|, |y| <= 100000.

`settings::save(state: &AppState, next: Settings) -> CoreResult<Settings>` is the Rust entry point for modules that change a field directly (for example `downloads.setDir`). It normalizes, validates against the current settings, persists, refreshes the cache and emits `settings.changed`, under the same lock. Empty strings for `mpvPath`, `vlcPath`, `downloadsDir` and `lastRoute` are normalized to unset before validation, so the UI clears a path by sending `""`.

## Desktop-only fields (server mode)

When `state.is_desktop` is false (the PWA server), `settings.update` refuses with `Unsupported` ("player and folder settings apply only to the desktop app") any patch that changes `mpvPath`, `vlcPath`, `mpvArgs`, `vlcArgs`, `downloadsDir` or `recordingsDir`. Any browser on the network can reach the server, and these fields name programs, their arguments and folders on the host. The check runs before validation, so a refused patch reveals nothing about which paths exist. Sending the current values back unchanged (a full-document patch) is allowed. `settings::save` applies the same rule except for `downloadsDir`, whose only caller (`downloads.setDir`) enforces its own server rule. `settings.reset` is allowed: it only restores defaults.

## Fields added after wave 1

| Field | Default | Meaning |
| --- | --- | --- |
| `stripCountryPrefix` | `false` | UI strips a leading `XX: ` / `XX \| ` / `[XX] ` tag from channel names. |
| `epgOffsetMinutes` | `0` | UI shifts displayed programme times. |
| `playerReuseInstance` | `true` | External launch closes the previous external player first. |
| `showExternalBar` | `true` | External-playback footer visible. |
| `vodMinRating` | `0` | VOD grids hide items rated below this. |
| `englishOnly` | `false` | Channel lists, VOD grids, categories, search, neighbours, recently added and `allLiveChannels` drop items whose title or category clearly marks another language (`catalog::language`). Readers of one source and type (channel, movie and series pages and their counts, categories, neighbours, `allLiveChannels`) filter through a per-connection cached temp table of hidden item rowids, `temp.english_hidden`, built with the SQL functions `english_title` and `english_category` and rebuilt after any database write or when another source or type is asked for (`language::hidden_rowids`). Cross-source search and recently added still test each row with the SQL function `non_english`. Items without a clear language, multi-subtitle and African groups stay. Categories left empty are dropped and `itemCount` counts what remains. Stalker VOD grids filter loaded pages in the UI. |
| `recordingsDir` | `null` | `null` = `<downloadsDir>/recordings`. Serialized as `null`, not omitted. |
| `sourceRefreshIntervalHours` | `12` | Hours between scheduled refreshes of `autoRefresh` sources; 0 = only at startup. 0..168, else `Invalid`. See sources.md. |
| `accountExpiryWarnDays` | `7` | Days before a subscription's expiry date that the dashboard and source cards warn; 0 = off. 0..60, else `Invalid`. |
| `liveFailover` | `true` | A live channel that fails switches to the same channel on another source. |
| `streamReconnect` | `true` | A dropped or stalled stream is retried quietly before the error shows. |
| `remoteLanEnabled` | `false` | The remote control also listens on private network addresses for paired phones. Desktop only: the server ignores it. |
| `epgShortFallback` | `true` | Xtream channels without XMLTV programmes use the panel's short EPG. |
| `recordingPaddingBeforeMinutes` | `1` | Minutes a scheduled recording starts early. 0..60, else `Invalid`. |
| `recordingPaddingAfterMinutes` | `5` | Minutes a scheduled recording runs past the programme end. 0..120, else `Invalid`. |
| `remindersEnabled` | `true` | Guide reminders fire while the app runs. |
| `reminderLeadMinutes` | `2` | Minutes before the start a reminder fires. 0..60, else `Invalid`. |
| `reminderAction` | `"notify"` | `"notify"` shows a notification; `"switch"` tunes to the channel. |
| `accent` | `"amber"` | Accent colour: `amber`, `teal`, `violet`, `rose`, `lime`, `sky` or `coral`. Settings > Appearance; see appearance.md. |
| `oledBlack` | `false` | Pure black surfaces whenever the dark theme is in effect. |
| `density` | `"comfortable"` | `"compact"` tightens spacing in lists, rails and rows. |
| `uiScale` | `1` | Interface size, 0.9..1.25 (the root font size is 15 px times it). |
| `zapBanner` | `true` | The player shows the channel's logo, number and now/next for 5 s after each live channel change. Settings > Playback. |
| `dashboardRails.myList` | `true` | The dashboard's My List rail (Settings > General, dashboard rails). |

Parental controls are not part of `Settings`: their options and PIN live in the `parental_config` table and change only through the `parental.*` commands (see parental.md); Settings > Parental controls is their page.

`englishOnly`, `sourceRefreshIntervalHours`, `accountExpiryWarnDays`, `epgShortFallback`, the five recording and reminder fields, and the five appearance and playback fields above (`accent`, `oledBlack`, `density`, `uiScale`, `zapBanner`) are in `backup::APP_SETTING_KEYS`, so they round-trip through `backup.export` / `backup.import`. `liveFailover`, `streamReconnect` and `remoteLanEnabled` are left out: they describe this machine's playback and network setup (see backup.md).

Stored JSON from older builds reads with these defaults (struct-level `#[serde(default)]`).

`settings.changed` carries the full document, including `tmdb.apiKey` when the user set one; the module never logs the document.
