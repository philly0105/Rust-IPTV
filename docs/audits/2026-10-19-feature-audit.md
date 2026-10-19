# Feature audit

Tsrust IPTV, master at `0c0ef59`, which holds the 2026-10-16 nuts-polish-features work, fast-forwarded onto master on 2026-10-19. The audit is from the same day. The companion performance audit is in `2026-10-19-performance-audit.md`.

## Summary

For a six-day build the feature set is wide and mostly finished. Of 22 areas, 9 are complete, 12 are mostly complete and one, the updater, is a stub. The wiring is clean: the core registers 196 commands, the UI's typed map lists the same 196, nothing the UI calls is missing, and every event the core emits has a consumer. No setting is dead. The 3,864 vitest tests all pass on gmk1, and typecheck passes.

The gaps users will notice first:

1. M3U series episodes import as thousands of separate movies, and M3U sources never get a Series section.
2. Out of the box, playback depends on what WebView2 can decode. The built-in player is the default, the standard installer doesn't bundle mpv, and multi-view can't use mpv at all.
3. A new source never refreshes on its own, because auto refresh defaults to off. When it is on, every launch re-imports it in full (performance audit ST-1).
4. Catch-up dead-ends on channels without guide data. The archive page shows nothing and offers no time picker.
5. In browser mode the UI offers controls the server always refuses. Picking MPV or VLC in Settings stops all playback.
6. Non-English users see raw English error text inside translated error screens, and English key names everywhere.
7. While anything plays, even in the mini player, Space and the arrow keys stop scrolling pages and change the volume instead.

Shipping is blocked by four things: the installer is unsigned, the updater has a placeholder feed and no key, no licence is chosen, and there is no CI.

Against IPTVnator and the main IPTV players, this rebuild leads on recording, multi-view, parental controls, live failover and cross-source lists. IPTVnator has no multi-view, scheduled recording or parental controls, and its failover covers movies only. The rebuild trails on platforms, because IPTVnator users on macOS and Linux have no build here. It also trails on updates, ClearKey DRM, aspect, zoom and deinterlace controls, channel reordering, and season downloads. Most of those are small changes.

## Method

Four reviewers worked in parallel. One covered backend wiring and host parity. One covered the cross-cutting UI: routes, shortcuts, i18n, accessibility, the phone layout and the test map. One went feature by feature with the git history, and one compared the app with other IPTV players. I re-checked the claims that rank highest below against the code. On gmk1 I ran the typecheck, the production build and the full vitest suite. The 1,399 cargo tests and 143 Playwright tests were counted from the repo, not run, because Rust isn't installed here.

## Feature status

| Area | Status | Summary |
| --- | --- | --- |
| Live TV | Mostly complete | Groups, search, favorites, recents, digit zapping and catch-up work. Catch-up dead-ends without guide data, and the rail links to sections that are empty. |
| Guide | Mostly complete | Fast grid, jump to time, programme search, reminders and recording. One source at a time, no favorites or list view, no guide mapping from the grid. |
| Movies and series | Mostly complete | Grids, filters, Hide watched, detail pages, resume and seasons are solid. M3U series arrive as separate movies. |
| Search | Mostly complete | Channels, movies and series across every source, Stalker through the portal. Programmes only show up inside the guide. |
| Sources | Mostly complete | Add, test, cancel, edit, undo, scheduled refresh and account status. Auto refresh is off by default, and pasted or uploaded playlists can't be updated. |
| Player | Mostly complete | Web engines, embedded mpv, external players, tracks, subtitles, screenshots, PiP, failover, sleep timer and rewind. Browser mode lets you pick players that can't run there. |
| Multi-view | Mostly complete | 2 to 4 tiles with layouts, sound and keyboard control. Built-in engines only; the connection warning covers Xtream only. |
| Recording | Mostly complete | Reminders, timed and series recordings, the Scheduled page and the recordings library. HLS needs mpv, and series rules made from provider-guide programmes never schedule anything. |
| Downloads and offline library | Mostly complete | Solid queue and My Videos. Only Xtream and Stalker titles get a Download button. |
| My List | Complete | Save, reorder, mark watched, rail and page. It overlaps with Favorites. |
| Custom lists | Complete | Lists across sources, zapping in list order, rails, manage with undo. |
| Channel edits | Complete | Rename, hide, Unhide all. No overview of renamed channels. |
| Parental controls | Complete | PIN, Ask and Hide modes, enforced in the core's readers. No PIN recovery. |
| TMDB | Complete | Opt-in with your own key. Only tested against a stub. |
| Backup and IPTVnator migration | Mostly complete | Merge and replace work. VOD source pins aren't connected, and compatibility is tested only on a fixture the repo generates itself. |
| Remote control | Mostly complete | Loopback remote and QR-paired phones for channels and volume. No play/pause, and the channel list is published only from the Live page. |
| Settings | Complete | 12 sections and reset. Browser mode shows several fields the server refuses. |
| Onboarding | Mostly complete | The tour works. What's new never fires again because the version never changes. |
| Stats | Complete | 7- and 30-day chart and top lists. |
| Dashboard | Complete | Hero, rails with toggles, account alerts, one shared error state. |
| Theming | Complete | Theme, OLED black, 7 accents, density, UI scale. |
| Updater | Stub | Off behind a cargo feature, placeholder feed, no signing key. |

## Gaps by area

### Live TV and catch-up

- Catch-up has no fallback when a channel has no guide data. For M3U the archive loader returns an empty list (`src/features/live/hooks/useArchiveDay.ts:40-52`), and the page shows "Nothing listed for this day" with no time picker (`ArchivePage.tsx:263-265`). Channels that advertise `catchup-days` can't be rewound at all. Hourly slots across the archive window would fix it.
- Xtream and Stalker sources always get Radio, Movies and Series links (`src/shell/railLinks.ts:39-40`), even when a section is empty and `radioCount` is known. The empty Radio page tells the user to check the source's address. SPEC C7 asks for these links, so changing it is a spec decision.
- A VOD-only source opens on an empty Live page, both from `/s/:id` (`src/routes.tsx:172`) and from the add toast.
- Favorites can't be zapped in order; only custom lists set a zap context (`src/features/lists/lib/play.ts:9`).

### Guide

- One source at a time (`EpgGridPage.tsx:1347-1356`), with no view of favorites or a custom list.
- The row menu has no "Map guide" (`EpgGridPage.tsx:1422-1458`), though the Live page has one.
- When guides are loaded but none of the channels match, the notice still says to add an XMLTV address (`src/i18n/en/live.json:68`), and Settings shows no match counts.
- Guide search, series rules and re-matching only see XMLTV, not Stalker portal EPG or the Xtream short EPG (guide-search.md, recording.md:95). The ribbon still offers "Record series" on provider-guide programmes (`RibbonActions.tsx:68-72`), and those rules stay at "Nothing scheduled" forever.
- EpgGridPage.tsx is 1,649 lines, and its main component spans lines 303-1261. It changed in 14 of the 20 wave commits.

### Movies, series and search

- M3U classifies Xtream `/series/` URLs as movies (`crates/iptv-core/src/m3u/importer.rs:158-168`), so every m3u_plus list floods Movies with episodes. m3u.md calls this temporary "until M3U series grouping exists". Of all the gaps in this audit, I'd fix this one first.
- Stalker titles get no "Other sources" (`MovieDetailPage.tsx:86-89`).
- Global search and the command palette never search programmes; neither calls `epg.search`.
- Only Xtream and Stalker titles show a Download button (`src/features/vod/hooks/usePlayback.ts:82`), though the core downloads M3U rows too (downloads.md:57).

### Sources

- `autoRefresh` defaults to false (`src/features/sources/lib/draft.ts:127`), and the scheduler skips such sources (sources.md:91), so a source added with the defaults never refreshes on its own. Turning it on by default is right, but only after the startup pass stops re-importing everything on every launch (performance audit ST-1). Otherwise every user pays that cost.
- Pasted playlists, and every playlist uploaded in the browser, are stored as text and can't be updated in place. The edit dialog says to remove and re-add the source (`src/i18n/en/sources.json:146`), and removing a source deletes its favorites, history, positions, edits and locks.

### Player and multi-view

- The default player is the built-in one (`crates/iptv-core/src/model.rs:1180`), and `pnpm tauri:build` doesn't bundle mpv, so out of the box only what WebView2 decodes will play. Extensionless MPEG-TS live streams also pay a failed native attempt per zap (performance audit PB-2).
- Multi-view tiles use the built-in engines only (`src/features/multiview/types.ts:3`), so a channel that plays only in mpv can't go on the wall. The connection-limit warning reads Xtream accounts only.
- In the browser, an unsupported-codec error on an Xtream or Stalker stream says "Open it in MPV or VLC" but offers only Retry (`InlinePlayer.tsx:628-660`).
- `showCaptions` reaches only the HLS and DASH engines. mpegts.js, native playback, embedded mpv and external players ignore it, though its hint says it turns on subtitles whenever a stream has them.
- `player/store.ts` is 2,060 lines and mixes resume, surface wiring, Up next, stall detection, the parental gate, source resolution and zapping. The mpv overlay stacking needed fixes in two loops, and `crates/iptv-core/src/player/embedded.rs` is 1,499 lines with 3 unit tests.

### Recording, downloads and remote control

- The Docker image has no mpv (`Dockerfile:37`), so Record is hidden in the default server deployment, and the remote control binds the container's loopback, where nothing can reach it.
- Live playback isn't counted against the provider's connection limit when scheduling recordings (recording.md:75).
- The remote's channel list is published only while the Live page is mounted (`useRemoteBridge.ts:58`) and is kept in memory, so after a restart the phone shows no channels until someone opens Live. That publish is also expensive (performance audit LV-7). The remote has no play/pause, stop or seek, and its page is English-only.
- On non-Windows hosts the recording engine stops mpv by killing it, has no free-space check, and the delete message says Recycle Bin when files are deleted for good (`crates/iptv-core/src/recording/engine.rs:264-267, 439-455`).

### Backup, channel edits and parental

- VOD "Other sources" pins live in localStorage (`src/features/vod/lib/pins.ts:1-13`), because no command exposes the `vod_source_pins` table. Backups export and import that table (`backup/export.rs:522`, `backup/import.rs:746-749`), and nothing in the UI writes or reads it. Pins made in the app are never backed up, and restored pins are never used. Live failover pins are localStorage-only too.
- IPTVnator compatibility is tested only against a fixture this repo generates (`fixtures/README.md:27`). A real user's first migration is untested.
- `channels.reset` exists, but nothing calls it, so there's no "Reset all renames".
- A forgotten parental PIN has no recovery, and disabling controls needs the PIN (parental.md:100). A locked-out household has to delete the app data.

### Onboarding and updates

- The version is pinned at 0.1.0 in four places, and `RELEASE_NOTES` has one entry (`src/features/onboarding/notes.ts:39-57`), so What's new never fires again and nothing from Loops 1-5 is announced.
- The updater is behind an `updater` cargo feature that no script enables, with a placeholder endpoint and an empty pubkey (`crates/iptv-tauri/tauri.conf.json:79-84`). About shows "Updates are not configured". Even with the feature on, checking is manual only.

## Commands, events and settings

The core registers 196 commands (`crates/iptv-core/src/rpc/mod.rs:153-192`), and `RPC_COMMANDS` in `src/api/rpc.ts` lists the same 196. A test checks that the two lists match, and `RpcMap` is checked against the list at compile time. No command is called without being registered, and the reviewer found no argument or result shape mismatches across 76 shared types.

Twelve commands are never called from `src/`:

| Command | Verdict |
| --- | --- |
| `channels.reset` | Unbuilt UI, documented in channel-edits.md:26 |
| `screenshot.reveal` | Unbuilt UI; the screenshot toast offers Open only |
| `m3u.raw` | Unbuilt; there is no raw playlist view |
| `xtream.shortEpg` | Replaced by `epg.shortEpg` |
| `player.detect` | Duplicate of `settings.detectPlayers`, gated differently |
| `catalog.setCategoryHidden` | Replaced by `setCategoriesHidden` |
| `sources.refreshAll` | The UI loops over `sources.refresh` so Stop works |
| `xtream.sync`, `stalker.sync` | The UI uses `sources.refresh` |
| `sources.counts` | Counts come with `sources.list`; one e2e spec uses it |
| `downloads.get` | The UI reads `downloads.list` |
| `app.ping` | Diagnostic; the web client probes `/api/health` |

The core emits 21 event kinds, the desktop host adds 4 and the server adds `events.lagged`. Every one has a UI consumer. `AppEventMap` in `src/api/types.ts` lacks `account.changed`, which the core emits and `effects.ts` handles untyped.

The settings document has 56 top-level fields, and each has a reader that changes behaviour. Four are only partly honoured: `showCaptions` (HLS and DASH only), `playerAmbientMode` (built-in player only), `vodMinRating` (applied by the UI, only validated by the core) and `streamFormat` (Xtream live URLs only).

Docs and types have drifted in small ways. SPEC C4 gives `sources.counts` three fields where the code returns four, players.md counts 13 player commands where there are 14, `updater.ts` still treats `updaterAvailable` as missing from `AppInfo`, and SPEC C16 says arrow keys seek 5 s where the code and README use 10 s.

## Browser mode

The server runs the same UI, and most of the differences are handled: open-folder actions are hidden, local files are refused with clear hints, and LAN remote pairing shows a note. Three controls are not handled.

1. Settings > Playback lists external mpv and VLC as available in the browser (`src/features/settings/sections/PlaybackSection.tsx:109-124`). After the user picks one, every play calls `player.openExternal`, which the server refuses with "Players run only in the desktop app" (`crates/iptv-core/src/player/rpc.rs:34-40`). The live context menu already hides these entries, so this looks like an oversight.
2. Settings > External players renders in the browser. Its path and argument fields save through `settings.update`, which refuses them in server mode. "Detect players" calls `settings.detectPlayers`, which has no desktop gate, so the browser shows the server's own player paths.
3. The Downloads and Recordings folder inputs render in the browser with the hint "A full folder path on the computer running the server", and the core refuses both, "Use default" included. The web-build unit tests still expect a typed path to save (`src/features/settings/test/settings.test.tsx:161-197`).

| Feature | Windows desktop | Browser (server mode) |
| --- | --- | --- |
| Built-in player | Through the loopback proxy | Direct, or `/api/proxy` for headers and mixed content |
| Embedded mpv | If mpv is found; not bundled by default | Unsupported; falls back to the built-in player |
| External mpv and VLC | Yes | Unsupported, but offered in Settings |
| Live recording | Embedded mpv only | No |
| Scheduled recording | Headless mpv or HTTP copy | Only with mpv on the host; the Docker image has none |
| Downloads folder | Picker | Fixed `<data>/downloads`, but the UI shows an input |
| Local playlist, guide and backup files | Read in place | Refused; upload text or use http(s) |
| Screenshots | Pictures folder | Browser download; fails on streams without CORS |
| Remote control | Loopback and LAN pairing | Server loopback only; unreachable in Docker; every open tab obeys each command |
| PiP | Window PiP for mpv, browser PiP otherwise | Browser PiP |
| Reminders | Native notification | Toast; a browser notice only if permission was already granted |

macOS and Linux desktop builds have code fallbacks but no bundle target, and README calls the app Windows-only.

## Navigation, shortcuts, language and layout

### Navigation

Every literal link and `navigate()` target resolves to a route. Four problems remain.

- "Go to Home" on Stats (`StatsPage.tsx:115`) and "Browse channels" on an empty list (`ListPage.tsx:373`) link to `/`. With the default `restore-last-view` startup setting, `/` redirects to the last saved route, which is the page the user is on, so the button lands where it started. Link to `/dashboard` instead.
- The deep-link parser in use (`src/shell/effects.ts:48-63`) drops `&kind=` and ignores the `iptv://add/<url>` form. `addSourcePathFromDeepLink` in `src/features/sources/lib/links.ts:16` handles both and is unit-tested, but nothing calls it.
- Startup restores dead screens. Only `/s/:id/...` paths are checked against the source list, so a 404 path, a removed source's archive page or a deleted list comes back on the next start.
- The archive route sits outside `/s/:id`, so the rail doesn't open or mark the source while it is shown.

### Shortcuts

- Playback keys are registered with `enabled: active` (`src/features/player/usePlaybackShortcuts.ts:128`), so they apply app-wide whenever anything plays, the mini dock included. Space and the arrows stop scrolling pages, and Up and Down change the volume. `isArrowTarget` (`src/shell/shortcuts.ts:190-196`) doesn't treat native radio inputs as arrow targets, so the radio groups in Settings > Playback and Settings > Appearance stop responding to arrows while anything plays. Scope these keys to the player surface, or skip them when focus is in a form control.
- On `/multiview`, starting main playback re-registers the playback entries as newest, and they override the wall's `l`, `f` and `m` keys.
- Every `mod+` combination fires inside modal dialogs, and Ctrl+R and Ctrl+F navigate without checking (`ShellLayout.tsx:198-220`). In the Add source dialog either key throws away the typed URL or credentials.
- Delete on My Videos is in README and the shortcut overlay, but the grid doesn't bind it (`MyVideosPage.tsx:181-209`). Alt+Up/Down for reordering sources and Shift+PageUp/PageDown in the channel list work but aren't documented.

### Language

`i18n-parity.test.ts` already enforces key sets, placeholders and plural categories across 19 languages, and every locale is fully translated. The share of values identical to English is 3.1 % at most, all product names and loanwords. The components contain almost no hardcoded English. The leaks are elsewhere.

- `ErrorState` prints the raw `err.message` between a translated title and hint (`src/ui/States.tsx:147`). It has 53 call sites, and 79 toasts pass a raw `.message` too. The core builds about 400 English error strings. Only source errors, import toasts, player and multi-view errors, and recording errors are localized.
- Key names in `src/ui/Misc.tsx:9-45` are English in every language, including the screen-reader names "Play/Pause" and "Next track". They show in the shortcut overlay, the command palette, Settings > Shortcuts and the tour.
- Moroccan Arabic (`ary`) reaches `Intl` unmapped in most formatters, so its dates, times and numbers follow the machine's locale. Only `src/features/stats/lib/format.ts:10` and the plural rules map it to `ar`. One shared helper for Intl locales would fix every formatter at once.
- Smaller items: dashboard rails format ratings with `toFixed(1)` while the hero uses Intl, so German users see both "7,5" and "7.5" on one page. Track language names follow the OS language instead of the app's. Seven `.join(', ')` lists ignore Arabic and CJK separators.

### Accessibility

The basics are in good shape. A scan of 481 files found no unnamed buttons, no unlabelled inputs, no images without alt text and no positive tabindex, and the modal dialogs trap focus. The gaps:

- axe never runs on `/scheduled`, `/live/archive`, `/my-videos/:id` or the `/lists` empty state, and the RTL sweep also skips `/lists/:id` and `/stats`.
- The fullscreen channel panel opens only from a 12 px edge strip or the `c` key, with no visible control.
- In right-to-left languages the mini player covers the rail's bottom buttons, because it is placed with physical right and bottom (`PlayerDock.tsx:32-43`).

### Phone layout

Below 1024 px the rail collapses to icons and side panels move into drawers. What breaks on a 390 px phone:

- The rail can't be hidden below 1024 px (`Rail.tsx:576`), so it takes 18 % of the width on every page.
- The mini player is at least 280 px wide (`PlayerDock.tsx:282`), 88 % of the content column.
- A tap on the video toggles play/pause (`PlayerSurface.tsx:732-750`), so tapping to show the controls pauses live TV. Only the seek bar checks `pointerType`.
- Nothing tests interaction at phone width: drawers, rail menus, the mini dock or touch.

## Tests and fragility

On gmk1, 288 vitest files with 3,864 tests pass in 405 s. The repo also has 1,399 cargo tests and 143 Playwright tests in 30 specs. Only three tests are skipped, all deliberately: two `#[ignore]` perf tests and one e2e test that skips when recording isn't available.

The blind spots are structural.

- There is no CI in the repo, so `pnpm check` runs only when someone runs it.
- Playwright runs only against `iptv-server` in a browser. The Tauri shell, embedded mpv, window PiP, the tray, LAN pairing, external players, deep links and the updater have no end-to-end coverage, and they include the code that changed most.
- Recording has the thinnest UI coverage: about 49 unit cases, no e2e for `/scheduled`, reminders, or one-off record and stop, and no axe run.
- Downloads and My Videos get only route smoke tests, axe and a header check in e2e.
- Unit cases per 1,000 source lines are lowest for the dashboard (21.5), settings (24.5), the API layer (24.5), multi-view (27.2) and the library (27.5). Everything else falls between 31 and 87.
- `routes.test.tsx` lacks `/scheduled`, `/my-list`, `/multiview`, `/lists`, `/stats` and `/live/archive`.
- Flakiness is acknowledged in `vitest.config.ts:16-20` and in two commit messages.

The git history shows where the fixes have clustered. CategoryGridPage, PosterCard, Controls and LivePage changed in 15 of the 20 wave commits; EpgGridPage, SearchPage, DashboardPage and `shell/effects.ts` in 14. Loops 2-4 skipped 20 findings "with reasons in the run reports", and those reports aren't in the repo.

## Compared with other players

The research compared upstream IPTVnator (README, the v0.17 to v0.24 release notes and its features page), TiviMate, IPTV Smarters Pro, Kodi with PVR IPTV Simple Client and Channels DVR, and looked more briefly at OTT Navigator, Sparkle TV, UHF, Hypnotix, Megacubo, Jellyfin and Plex. TiviMate's and Smarters' official pages couldn't be fetched, so their cells rest on vendor and third-party guides, and many are "?". I verified the claims about this app's code that the rankings depend on: Xtream sends a hardcoded `VLC/3.0.18` User-Agent (`crates/iptv-core/src/xtream/client.rs:23, 187`), `#KODIPROP` lines are parsed (`m3u/parser.rs:256`) and nothing in `src/` reads them, and the player has no aspect, zoom or deinterlace code.

### Where this app leads

- Live failover to the same channel on another source, ranked by guide id and name with quality and region guards, plus a preferred-source pin. No compared player documents this.
- A real DVR inside a desktop app: scheduled recordings with padding, series rules that re-match after guide refreshes, reconnects into part files, and missed-recording detection. IPTVnator, Kodi IPTV Simple, Hypnotix and Megacubo have no scheduled recording.
- Custom channel lists that mix sources, zap in list order and can be dashboard rails.
- Parental controls with hide and ask modes, adult-group detection, lockout and timed unlock, beyond the PIN locks of TiviMate, Smarters and Kodi.
- Programme search across 14 days, with "Record series" from a result.
- Subscription monitoring tied to playback, including connection-limit warnings for multi-view and recordings.
- Two-way IPTVnator backup compatibility, plus its own extensions.
- One core for both the desktop app and a self-hosted server with guide, recording and backup. IPTVnator's self-hosted build has no guide panels, embedded mpv, downloads or remote.
- Scale: a 50k-channel M3U imports in about 1.1 s and a 120 MB XMLTV guide in about 7 s, per the repo's own perf tests.

### Regressions against IPTVnator

People migrating from IPTVnator will notice these, roughly in order of how many of them it affects.

1. No macOS or Linux desktop. Upstream ships Windows, macOS and Linux through Homebrew, Snap, AUR, Flatpak and AppImage, including ARM builds. Here the only bundle target is NSIS, and every `mpv.*` command returns Unsupported outside Windows.
2. No working auto-update. Upstream has a self-updater with stable and nightly channels.
3. No ClearKey DRM. Upstream plays ClearKey DASH from M3U `#KODIPROP` lines. Here the lines are parsed and stored, then ignored.
4. No season or catch-up downloads. Upstream can queue a whole season and save Xtream catch-up programmes as TS. Here downloads go one item at a time, and the archive page can only play.
5. Fewer guide conveniences. Upstream can hide channels without guide data, change row density, zoom with steps or Ctrl+scroll, and open the guide with G.
6. No HTPC start options. Upstream has fullscreen or maximized on startup, a `--fullscreen` flag and Ctrl+/- zoom.
7. Smaller items: no fullscreen episode panel for series, settings search finds sections rather than individual settings, no availability check or bulk cleanup for M3U and Stalker sources, no "Because you watched" rail or TMDB Discover view, no IINA support, and copying stream links is limited to M3U links without credentials. That last one is a deliberate privacy choice.

Upstream's phone remote works on the LAN once enabled; here it also needs QR pairing. That is a behaviour change rather than a regression. In the other direction, upstream documents no multi-view, scheduled or series recording, parental controls, cross-source lists or live failover, and this rebuild has all of them.

### Gaps against the best competitor

| # | Gap | Who has it | Value | Effort | Where it fits |
| --- | --- | --- | --- | --- | --- |
| 1 | Working update channel, stable and nightly | IPTVnator | High | S, plus CI | The updater plugin is wired in `crates/iptv-tauri`; it needs a key, a `latest.json` feed and signed releases |
| 2 | macOS and Linux desktop builds | IPTVnator | High | L, M without embedded mpv | Bundle targets in `tauri.conf.json`; `player/mpv_window.rs` uses a Win32 child window |
| 3 | User-Agent for Xtream sources and a global default | IPTVnator, Kodi | Medium | S | Add headers to the Xtream source config; `xtream/client.rs` hardcodes VLC |
| 4 | ClearKey DRM from `#KODIPROP` | IPTVnator, OTT Navigator | Medium | S-M | Expose `kodiProps` on the channel and pass `drm.clearKeys` to Shaka in `engines.ts` |
| 5 | Aspect, zoom and deinterlace controls | OTT Navigator | Medium | S | mpv properties in `SETTABLE_PROPERTIES`, CSS `object-fit` for the built-in player, a menu row in `Controls.tsx` |
| 6 | Guide time shift per source and per channel | TiviMate, OTT Navigator, Kodi | Medium | S | `epg/query.rs` already applies `tvg-shift`; add an override in the source dialog and the mapping dialog |
| 7 | Reordering provider groups and channels | TiviMate | Medium | M | An order-override table next to channel edits, drag ordering in `ManageCategoriesDialog` |
| 8 | Season, multi-select, catch-up and M3U downloads | IPTVnator | Medium | S-M | The queue exists; add a season action on `SeriesDetailPage` and a TS download from `ArchivePage` |
| 9 | Guide: hide channels without data, zoom steps, favorites and list filter | IPTVnator | Medium | S | `EpgGridPage.tsx` |
| 10 | A login for server mode | None verified | Medium | M | `crates/iptv-server/src/guard.rs`; the docs currently advise an authenticating proxy |
| 11 | User profiles with their own history, favorites and PIN | OTT Navigator | Medium | L | A profile key on the user-state, watchlist, lists, stats and parental tables |
| 12 | M3U series grouping | Kodi | Medium | M | `classify` in `m3u/importer.rs` |
| 13 | Casting to Chromecast or DLNA | OTT Navigator, UHF, Megacubo | Medium | L | A new core module, streaming through the loopback proxy so headers survive |
| 14 | Sync between desktops | UHF PRO, Channels | Medium | L | Let the desktop shell use a remote `iptv-server`; the RPC already works over HTTP |
| 15 | Trakt scrobbling | UHF | Low to Medium | M | A module beside `tmdb`, fed by the stats reporter |
| 16 | Proxy, DNS-over-HTTPS and ignore-invalid-TLS options | OTT Navigator | Low to Medium | S | The client builder in `http.rs` plus mpv's `--http-proxy` |
| 17 | Auto frame rate | TiviMate, OTT Navigator | Low on desktop | M | Windows display-mode switching in `iptv-tauri`, using fps from mpv |
| 18 | More than 4 tiles, and mpv tiles in multi-view | OTT Navigator has 9 | Low | M | `MAX_TILES` and engine choice in `features/multiview` |
| 19 | Fullscreen on launch and start on boot | IPTVnator, OTT Navigator | Low | S | `iptv-tauri` boot code plus a setting |
| 20 | Commercial skip for recordings | Channels DVR | Low | L | Post-processing in `recording/library.rs` |

### Comparison matrix

Yes, Partial, No, or ? when the reviewer couldn't confirm. Tags point to the sources below. An IPTVnator "No" means the feature appears nowhere in its README, release notes or features page.

| Feature | This app | IPTVnator | TiviMate | Smarters Pro | Kodi IPTV Simple | Channels DVR |
| --- | --- | --- | --- | --- | --- | --- |
| M3U playlists | Yes | Yes [I1] | Yes [T1] | Yes [M1] | Yes [K1] | Partial, 750-channel cap [C1] |
| Xtream login | Yes | Yes [I1] | Yes [T1] | Yes [M1] | Partial, as an M3U URL [K1] | Partial, as an M3U URL [C1] |
| Stalker/MAC portal | Yes | Yes [I1] | Yes [T5] | ? | No [K1] | No [C1] |
| Several sources at once | Yes | Yes [I1] | Yes, Premium [T2] | Yes [M1] | Yes, Kodi 20+ [K1] | Yes [C1] |
| Scheduled playlist refresh | Yes | Partial, at startup [I1] | ? | ? | Yes [K1] | ? |
| Custom User-Agent | Partial, not for Xtream | Yes, per playlist [I1, I3] | ? | ? | Yes [K1] | ? |
| External XMLTV | Yes | Yes [I1] | Yes [T2] | Yes [M2] | Yes [K1] | Yes [C1] |
| Several guide feeds merged | Yes | Yes [I2] | Yes [T2] | ? | Partial, one per instance [K1] | ? |
| Guide time shift | Partial, global plus tvg-shift | Partial, global [I3] | Yes, per feed [T2] | Yes [M2] | Yes, global and per channel [K1] | ? |
| Manual guide mapping | Yes | Yes [I2] | ? | ? | No [K1] | Partial, station-id tag [C1] |
| Guide grid | Yes | Yes [I3] | Yes [T3] | Yes [M1] | Yes [K2] | Yes [C2] |
| Programme search | Yes, 14 days | ? | ? | ? | ? | ? |
| Reminders | Yes | ? | Yes [T1] | ? | Yes [K2] | ? |
| Catch-up playback | Yes | Yes [I1] | Yes, Premium [T2] | Yes [M2] | Yes [K1] | ? |
| Pause and rewind live | Partial, mpv buffer | ? | ? | ? | Yes [K1] | Yes [C2] |
| Instant recording | Yes | Partial, embedded mpv only [I2] | Yes [T1] | Yes [M1] | No [K1] | Yes [C2] |
| Scheduled recording | Yes | No [I3] | Yes [T1] | ? | No [K1] | Yes [C2] |
| Series or recurring rules | Yes | No [I3] | Yes, recurring [T1] | ? | No [K1] | Yes, Series Pass [C1] |
| Commercial skip | No | No | ? | ? | No | Yes [C2] |
| Multi-view | Yes, 2 to 4 tiles | No [I4] | Yes, Premium [T2] | Yes, 4 [M1] | ? | Yes, 4 on Apple TV and iPad [C2] |
| Live failover to another source | Yes | Partial, movies only [I5] | ? | ? | ? | ? |
| External subtitle files | Yes | Yes [I2] | ? | ? | ? | ? |
| Audio and subtitle delay | Yes | Partial, subtitles only [I2] | Partial, audio only [T1] | ? | ? | ? |
| Auto frame rate | No | No | Yes [T1, T2] | ? | ? | ? |
| Aspect, zoom, deinterlace | No | ? | ? | ? | ? | ? |
| ClearKey DRM | No | Partial [I3] | ? | ? | Partial, KODIPROP pass-through [K1] | ? |
| External players | Yes, mpv and VLC | Yes, mpv, VLC and IINA [I1] | Yes [T1] | Yes [M2] | ? | ? |
| Stream info panel | Yes | Yes [I3] | ? | ? | ? | ? |
| Movies and series with resume | Yes | Yes [I1] | ? | Yes [T3] | Partial [K1] | No, live only [C1] |
| Offline downloads | Partial, one item at a time | Yes, with seasons and catch-up [I2, I3] | ? | ? | ? | Yes, recordings [C3] |
| Favorites and custom groups | Yes, lists across sources | Partial, favorites [I1] | Yes [T2] | Partial, favorites [M2] | Partial, groups via XML [K1] | Partial, channel groups [C2] |
| Hide, rename, reorder channels | Partial, no reordering | Partial, hide and group sort [I1, I2] | Yes [T1, T2] | ? | ? | ? |
| Search across sources | Yes | Yes [I1] | Yes [T4] | ? | ? | ? |
| Parental PIN | Yes | No [I4] | Yes, Premium [T1] | Yes [M2] | Yes [K2] | Partial, Kids section [C2] |
| User profiles | No | No [I4] | ? | ? | ? | ? |
| Backup and restore | Yes | Yes [I5] | Yes, Premium [T2] | Yes [T3] | ? | ? |
| Phone or web remote | Yes, QR pairing | Yes, QR [I4] | ? | ? | Yes, app [K4] | ? |
| Casting | No | No [I4] | ? | ? | ? | ? |
| Trakt | No | No | ? | ? | ? | ? |
| Self-hosted browser UI | Yes, no login | Partial, no guide panels [I1] | No [T2] | Partial, web player [M1] | ? | Yes [C3] |
| Platforms | Windows; any browser through the server | Windows, macOS, Linux, browser [I1] | Android TV, Fire TV [T2] | Android, iOS, Fire TV, Samsung, LG, Windows, macOS [M2] | ? | Server on Windows, macOS, Linux and NAS; Apple TV, iOS, Android and Fire TV apps [C2, C3] |
| Playlist editing or export | No | No [I3] | ? | ? | No [K1] | Partial, pasted text [C1] |
| Proxy or VPN settings | No | ? | ? | No, OS-level VPN [M2] | ? | ? |

### Sources

- I1 IPTVnator README: https://github.com/4gray/iptvnator
- I2 IPTVnator releases v0.17 to v0.24: https://github.com/4gray/iptvnator/releases
- I3 IPTVnator v0.24.0 notes: https://github.com/4gray/iptvnator/releases/tag/v0.24.0
- I4 IPTVnator features page: https://4gray.github.io/iptvnator/features/
- I5 IPTVnator guides: https://4gray.github.io/iptvnator/guides/ and the self-hosted storage PR https://github.com/4gray/iptvnator/pull/1903
- T1 TROYPOINT TiviMate guide, 2026-06-30: https://troypoint.com/tivimate/
- T2 Plume TiviMate guide, 2026-05-19: https://shop.plume.com/blogs/news/tivimate
- T3 TROYPOINT player roundup, updated 2026-10-15: https://troypoint.com/top-iptv-players/
- T4 AlternativeTo copy of TiviMate's description: https://alternativeto.net/software/tivimate/about/
- T5 APKMirror TiviMate 5.3.3 listing, seen only in a search snippet: https://www.apkmirror.com/apk/armobsoft-fze/tivimate-iptv-player-android-tv/
- M1 TROYPOINT IPTV Smarters Pro guide, October 2026: https://troypoint.com/iptv-smarters-pro-apk-1/
- M2 GISuser Smarters guide, 2026-04-15: https://gisuser.com/2026/04/iptv-smarters-pro-setup-guide/
- K1 pvr.iptvsimple README: https://github.com/kodi-pvr/pvr.iptvsimple
- K2 Kodi Live TV settings, seen in search: https://kodi.wiki/view/Settings/Live_TV
- K4 Official Kodi Remote: https://apps.apple.com/app/id520480364
- C1 Channels custom channels docs: https://getchannels.com/docs/channels-dvr-server/how-to/custom-channels/
- C2 Channels Live TV page: https://getchannels.com/live-tv/
- C3 Channels DVR Server page: https://getchannels.com/dvr-server/
- O1 OTT Navigator FAQ: https://ottnav.github.io/faq.html, and O2 its changelog: https://ottnav.github.io/changelog.html
- UHF: https://apps.apple.com/us/app/uhf-love-your-iptv/id6443751726
- Hypnotix: https://github.com/linuxmint/hypnotix
- Megacubo: https://github.com/EdenwareApps/Megacubo
- Jellyfin Live TV: https://jellyfin.org/docs/general/server/live-tv/
- Plex community tuners: https://support.plex.tv/articles/community-supported-tuners/
- Newer desktop players found but not compared in depth: dopeIPTV https://github.com/slimture/dopeIPTV and ynoTV, also Tauri with mpv, https://github.com/tbeezy/ynotv

## Release readiness

1. The installer is unsigned. `bundle.windows` has no certificate, sign command or timestamp URL, so SmartScreen will warn on the installer and the exe. The publisher is "philly".
2. The updater can't work. Beyond the placeholder feed and key, `createUpdaterArtifacts` isn't set, and a build with the feature on would show a "Check for updates" button that always fails.
3. No licence is chosen. The manifests say MIT as a placeholder, no LICENSE or third-party notice file exists apart from mpv's, and the installer has no licence page. README calls this a rebuild of the IPTVnator fork, so code or assets carried over need IPTVnator's MIT notice.
4. There is no CI and no release pipeline.
5. Crash reporting is local only. Rust panics go to the log, but UI exceptions stop at the route error page and never reach it, and release builds strip symbols. There is no telemetry, which is good for privacy, but nothing reports failures from the field.
6. The version is 0.1.0 in four files that must be bumped by hand. README says the toolchain is pinned, but `rust-toolchain.toml` tracks `stable` while the Dockerfile uses `rust:1.96`.
7. The installer is per-user NSIS only, with no WebView2 install mode set, no copyright or homepage, and a generic `iptv://` scheme other players may claim. The identifier fixes the data folder, so settle it before the first public build.
8. The Docker image has no mpv and an unreachable remote control.

## Top issues by user impact

| # | Issue | Area | Effort |
| --- | --- | --- | --- |
| 1 | M3U series import as movies; no Series section for M3U | VOD, M3U | L |
| 2 | Out-of-the-box codecs: built-in player default, mpv not bundled, multi-view can't use mpv | Player | M to bundle mpv, L for mpv tiles |
| 3 | Sources never refresh by default; when enabled, every launch re-imports | Sources | S each, fix ST-1 first |
| 4 | Catch-up dead-ends without guide data | Live | M |
| 5 | Browser mode offers MPV/VLC, player paths and folders that the server refuses | Settings | S |
| 6 | Raw English error text and key names for non-English users | i18n | M |
| 7 | Playback keys captured app-wide while anything plays | Shortcuts | S-M |
| 8 | Unsigned installer, no updater, no licence, no CI | Release | M each |
| 9 | Windows only; IPTVnator users on macOS and Linux have no build | Platform | L |
| 10 | Guide: one source, no favorites or list view, no mapping from the grid, misleading no-match notice, none of IPTVnator's hide-without-data or zoom options | Guide | M |
| 11 | Pasted and uploaded playlists can only be updated by remove and re-add, which drops all user state | Sources | M |
| 12 | No ClearKey DRM although `#KODIPROP` is parsed; no aspect, zoom or deinterlace controls | Player | S-M each |
| 13 | VOD source pins never backed up, restored pins never used | Backup | M |
| 14 | Provider guides excluded from guide search and series rules; "Record series" on them does nothing | Guide, recording | S to hide, L to support |
| 15 | Phone layout: wide mini player, tap pauses, rail can't hide; RTL mini player covers rail buttons | Layout | M |
| 16 | Downloads: no seasons, no catch-up programmes, no M3U movies though the core supports them | Downloads | S-M |
| 17 | "Go to Home" and "Browse channels" bounce back to the same page | Navigation | S |
| 18 | Remote: no channels until Live is opened, no play/pause, English-only; unreachable in Docker | Remote | M |
| 19 | No parental PIN recovery | Parental | M |
| 20 | Xtream sources can't set a User-Agent; the core always sends VLC's | Sources | S |
| 21 | Global search doesn't find programmes | Search | M |

## Quick wins

Each of these is an hour or less.

- In browser mode, hide MPV, VLC, the external-player section and the folder inputs, map a saved `mpv` or `vlc` to the built-in player when not on desktop (`store.ts:342`), and gate `settings.detectPlayers` to desktop.
- Link "Go to Home" and "Browse channels" to `/dashboard`.
- Call `addSourcePathFromDeepLink` from the deep-link handler in `effects.ts`.
- Add "Map guide…" and a favorite toggle to the guide's row menu, and point the no-match notice at mapping.
- Hide rail links whose count is zero, and open VOD-only sources on Movies.
- Allow M3U movie downloads (`usePlayback.ts:82`).
- Hide "Record series" for provider-guide programmes, or say it needs an XMLTV guide.
- Add a "Reset all renames" button to the Hidden channels dialog using `channels.reset`.
- Route every `Intl` constructor through one locale helper that maps `ary`, and use Intl for dashboard ratings.
- Treat native radio inputs as arrow targets in `isArrowTarget`, and stop `mod+` shortcuts that navigate from firing inside modal dialogs.
- Bind Delete on the My Videos grid, or drop it from README and the overlay.
- Install mpv in the Docker runtime stage so server-mode recording works.
- Bump the version for each release and add a `RELEASE_NOTES` entry, so What's new fires.
- Add `account.changed` to `AppEventMap` and fix the four small doc and type drifts.

## Status on the audit/fixes branch

The audit/fixes branch merges the feature lane (audit/feature-fixes) and the performance lane (audit/perf-fixes). The feature lane merged after the performance lane's startup fix (ST-1), so the new auto-refresh default and the M3U `IMPORT_VERSION` bump to 3 do not re-import every source on each launch. The Rust changes were written without a compiler on gmk1, so `cargo test`, clippy and rustfmt still have to run on the PC.

| Item | Status | Note |
| --- | --- | --- |
| F-BROWSER-PLAYERS | Fixed | The browser lists only the built-in player and never calls `player.openExternal`; a saved mpv or vlc shows as the built-in player. |
| F-BROWSER-SETTINGS | Fixed | The External players section, its route and palette entry are gone in the browser; folder rows are read-only with server hints. |
| F-DETECT-GATE | Fixed | `settings.detectPlayers` returns `Unsupported` outside the desktop app. |
| F-CAPTIONS | Fixed | The native engine and embedded mpv turn the first subtitle track on when `showCaptions` is set. On this branch the native fallback after mpegts.js does too. |
| F-EVENTMAP | Fixed | `account.changed` is in `AppEventMap`. |
| F-DOC-DRIFT | Fixed | SPEC, players.md, settings.md and `updater.ts` match the code. |
| F-DOCKER-MPV | Fixed | The Docker runtime image installs mpv. |
| F-AUTOREFRESH-DEFAULT | Fixed | New URL, Xtream and Stalker sources start with auto refresh on; pasted and uploaded text does not. |
| F-PLAYLIST-UPDATE | Fixed | `sources.update` takes new text for pasted or uploaded playlists and keeps user state through the remapper; large text is staged until the commit. |
| F-XTREAM-UA | Fixed | Xtream sources can set User-Agent, Referer and Origin for API calls, streams, downloads and recordings; backups carry them. |
| F-DOWNLOADS | Fixed | Every source kind can download, Download season queues missing episodes, and finished archive programmes can be saved. |
| F-RENAMES-RESET | Fixed | The Hidden channels dialog has Reset all edits. |
| F-VOD-PINS | Fixed | Source pins live in the core (`sourcePins.*`), migrate from localStorage once and are backed up. |
| F-REMOTE | Partial | The core publishes the channel list, and play/pause, stop and seek work from the phone. The remote page is still English-only and is unreachable in Docker (server mode binds loopback only); both need a decision. |
| F-HOME-LINKS | Fixed | Go to Home and Browse channels lead to the dashboard or the first source's Live TV. |
| F-DEEPLINKS | Fixed | `iptv://add` links go through `addSourcePathFromDeepLink`. |
| F-RESTORE-ROUTES | Fixed | A saved route that no longer exists falls back to the default screen. |
| F-ARCHIVE-RAIL | Fixed | The rail marks the source of a catch-up archive page. |
| F-PLAYBACK-KEYS | Fixed | With only the mini dock showing, Space, arrows and Page keys act on the player only when focus is inside it. |
| F-MULTIVIEW-KEYS | Fixed | The wall's F, M and L win over playback keys through a registry priority. |
| F-MODAL-SHORTCUTS | Fixed | `mod+` combos no longer fire inside modals unless they opt in. |
| F-MYVIDEOS-DELETE | Fixed | README and the overlay now say Delete works on a title's page; the grid binding was dropped instead of added. |
| F-SHORTCUT-DOCS | Fixed | README, the overlay and the architecture docs list every shortcut and the mini-dock and modal rules. |
| F-ERROR-TEXT | Fixed | Error states and about 80 toasts lead with translated text and fold the raw message into details. |
| F-KEY-NAMES | Fixed | Key names are translated in all 19 locales. |
| F-INTL-LOCALE | Fixed | Every Intl constructor takes its locale from `intlLocale`; on this branch the cached formatters from the performance lane use it too. |
| F-NUMBER-FORMAT | Fixed | Ratings and counts that can pass 1,000 use Intl formatting. |
| F-A11Y-COVERAGE | Fixed | Axe sweeps cover /scheduled, the archive, My Videos detail, lists and stats. |
| F-RTL | Fixed | The mini player sits at the inline end and drags the right way in RTL; chevrons and padding are logical. |
| F-ARCHIVE-SLOTS | Fixed | A catch-up day without guide data lists hour slots that play or download. |
| F-RAIL-COUNTS | Fixed | Imported Xtream sources drop empty Radio, Movies and Series links; Stalker drops Radio only. |
| F-VOD-ONLY-SOURCE | Fixed | A source without live channels opens on Movies, Series or Radio. |
| F-GUIDE-MENU | Fixed | The guide row menu has the favorite toggle and Match guide channel. |
| F-GUIDE-NOMATCH | Partial | The notice says when no channel matches a loaded guide and opens mapping. Per-feed match counts in Settings are not shown; they need a core-side count over the resolve order. |
| F-RECORD-SERIES-PROVIDER | Fixed | Record series is hidden for provider-guide programmes. |
| F-SEARCH-PROGRAMMES | Fixed | Global search and the palette find guide programmes. |
| F-FAVORITES-ZAP | Fixed | Channel up and down walk the favorites list when playback started from Favorites. |
| F-GUIDE-CONVENIENCES | Partial | Zoom steps and favorites or list views in the guide are done. Hiding channels without guide data needs a core-side filter on `catalog.channels`. |
| F-M3U-SERIES | Fixed | M3U episodes are grouped into series rows with their own detail page and playback; `IMPORT_VERSION` 3 re-imports each M3U source once. |
| F-CLEARKEY | Fixed | `#KODIPROP` ClearKey licences reach shaka; ClearKey sources never go to mpv or an external player. |
| F-ASPECT-ZOOM | Fixed | The player menu has aspect, zoom or crop, and mpv deinterlace. |
| F-EPG-SHIFT | Fixed | Per-source and per-channel guide shifts (migration 0021), carried in backups for channels. The source shift is not in backups because backups carry no EPG links. |
| F-FULLSCREEN-LAUNCH | Fixed | `settings.windowStart` opens the desktop window normal, maximized or fullscreen. |
| F-PHONE-RAIL | Fixed | Below 1024 px the rail can be hidden. |
| F-PHONE-DOCK | Fixed | The phone mini player is narrower and drops picture-in-picture and the duration below 260 px. |
| F-TOUCH-TAP | Fixed | A touch tap shows the controls instead of pausing. |
| F-CHANNEL-PANEL-BUTTON | Fixed | Fullscreen has a Channel list button. |
| F-CI | Fixed | `.github/workflows/ci.yml` runs the frontend checks on Ubuntu and the Rust checks on Windows and Linux. |
| F-TOOLCHAIN-DOC | Fixed | README describes the toolchain channel, the 1.85 minimum and the CI jobs. |
| F-WHATS-NEW | Fixed | Version 0.2.0 with a translated RELEASE_NOTES entry. |

Not attempted, because they need the user's decision:

| Item | Status | Note |
| --- | --- | --- |
| Licence | Not done | Needs the user's choice of licence and the IPTVnator notice. |
| Code signing | Not done | Needs a certificate and a signing setup. |
| Updater key and feed | Not done | Needs a signing key and a hosted feed. |
| macOS and Linux builds | Not done | Needs a decision to support those platforms. |
| Bundling mpv by default | Not done | Changes installer size and licensing. |
| Parental PIN recovery | Not done | Needs a recovery design. |
| Server login | Not done | Changes server mode's security model. |
| User profiles | Not done | Product decision. |
| Casting | Not done | Product decision. |
| Trakt | Not done | Needs an account integration decision. |
| Cross-device sync | Not done | Needs a sync design. |
| Auto frame rate | Not done | Product decision. |
| Commercial skip | Not done | Product decision. |
| Channel and group reordering | Not done | Product decision. |
| mpv tiles and more than 4 tiles in multi-view | Not done | Product decision. |
| Settings search by individual setting | Not done | Product decision. |
| TMDB Discover | Not done | Product decision. |
| Source availability checks | Not done | Product decision. |
| Proxy or DNS-over-HTTPS options | Not done | Product decision. |
