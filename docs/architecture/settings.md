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

Strings are trimmed, and empty optional strings (`mpvPath`, `vlcPath`, `downloadsDir`, `lastRoute`) become `None`. `language` is lowercased. `epgUrls` are trimmed, emptied entries dropped, and exact duplicates removed (first one wins).

## Validation (errors are `Invalid`)

- `language` must be one of the 19 UI languages: ar, ary, by, de, el, en, es, fr, hu, it, ja, ko, nl, pl, pt, ru, tr, zh, zhtw.
- `remoteControl.port` must be in 1024..=65535 (u16 rejects larger values during deserialization).
- `mpvPath` and `vlcPath` must be existing files, and `downloadsDir` an existing folder. These are checked only when the value changes, so a setting that pointed at a since-removed path does not block unrelated updates.
- `lastRoute` must start with `/` and be at most 2048 characters.
- Unknown enum values or wrong types fail deserialization.
- Window state: width and height 1..=32768 px, and |x|, |y| <= 100000.

`settings::save(state: &AppState, next: Settings) -> CoreResult<Settings>` is the Rust entry point for modules that change a field directly (for example `downloads.setDir`). It normalizes, validates against the current settings, persists, refreshes the cache and emits `settings.changed`, under the same lock. Empty strings for `mpvPath`, `vlcPath`, `downloadsDir` and `lastRoute` are normalized to unset before validation, so the UI clears a path by sending `""`.

`settings.changed` carries the full document, including `tmdb.apiKey` when the user set one; the module never logs the document.
