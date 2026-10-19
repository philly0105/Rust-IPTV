# Tsrust IPTV

An IPTV player for Windows, rebuilt from the IPTVnator fork on Tauri 2 with a Rust core. It plays M3U/M3U8 playlists, Xtream Codes accounts, and Stalker/Ministra portals. It has live TV with a searchable EPG, custom channel lists that mix sources, a multi-view wall for up to four channels, movies and series (M3U episodes are grouped into series with seasons) with a My List, catch-up, parental controls with a PIN, a sleep timer, series recording rules, watch stats, downloads with an offline library, optional TMDB metadata, and a remote control for a browser on this computer or, after QR pairing, phones on the local network. The same core also runs as a small web server, so the UI works in a browser (self-hosted PWA mode).

The Rust core (`crates/iptv-core`) owns parsing, storage, portals, EPG, downloads, TMDB, remote control, and players. The React UI never holds a whole catalog: it pages rows out of SQLite over one `rpc(cmd, args)` call.

No IPTV content ships with the app. Bring your own playlists.

## Prerequisites

- Rust stable, 1.85 or newer (`rust-version` in `Cargo.toml`). `rust-toolchain.toml` selects the current stable channel with rustfmt and clippy; it does not pin a version, so builds use whatever stable rustup has. The Docker image builds with `rust:1.96`.
- Node 24 and pnpm 10 (`corepack enable`)
- Microsoft Edge WebView2 runtime (preinstalled on Windows 11)
- Optional: mpv for embedded and external playback. Put a Windows build in `vendor/mpv/` (so that `vendor/mpv/mpv.exe` exists), install it with WinGet/scoop/choco, or set its path in Settings > External players. See `docs/architecture/players.md`.
- Optional: VLC for external playback.

```
pnpm install
```

## Run

| What | Command |
| --- | --- |
| Desktop app, dev mode | `pnpm tauri:dev`, or double-click `Start Tsrust IPTV.cmd` |
| Desktop installer (NSIS) | `pnpm tauri:build` (output in `release/bundle/nsis/` under the cargo target dir: `target/` unless a local `.cargo/config.toml` moves it; `cargo metadata --format-version 1 --no-deps` reports it as `target_directory`) |
| Desktop installer with mpv bundled | `pnpm tauri:build:mpv` (needs `vendor/mpv/`; makes the installer much larger) |
| Web UI against a server | `pnpm build`, then `pnpm server`, then open http://127.0.0.1:7180 |
| Web UI with hot reload | `pnpm server` in one terminal, `pnpm dev` in another, open http://localhost:5173 (Vite proxies `/api`) |
| Mock Xtream/Stalker/M3U/XMLTV servers | `pnpm mock` (port 7290) |
| Docker (server mode) | `docker build -t tsrust-iptv .` then `docker run --rm -p 127.0.0.1:7180:7180 -v tsrust-iptv-data:/data tsrust-iptv` |

`Start Tsrust IPTV.cmd` starts the installed app if there is one, then a `pnpm tauri:build` output (`release\iptv-tauri.exe` in the `TSRUST_TARGET_DIR` environment variable's folder when that is set, else in the target dir `cargo metadata` reports, else in `target\` or `crates\iptv-tauri\target\`), and otherwise falls back to `pnpm tauri dev`.

Server flags: `iptv-server --port 7180 --data-dir ./.data --static ./dist`. It binds 127.0.0.1 unless you pass `--host`. Details are in `docs/architecture/server.md`.

- The API answers only when the browser uses localhost, an IP address, or a name listed in `--allowed-hosts` / `IPTV_ALLOWED_HOSTS` (comma list). Behind a reverse proxy at `tv.example.com`, set `IPTV_ALLOWED_HOSTS=tv.example.com`.
- The stream proxy, downloads and playlist, guide, Xtream and Stalker requests only reach LAN addresses that belong to the source's own host and port. Pass `--allow-private-targets` (`IPTV_ALLOW_PRIVATE_TARGETS=true`, or `1`/`yes`/`on`) on a trusted network to lift that.
- In the browser, playlists and EPG files cannot be opened from the server's disk (upload the playlist text or use an http(s) guide URL instead), and downloads always go to `<data dir>/downloads` (Settings shows the folder, read-only). Playback uses the built-in player only: MPV, VLC and the External players settings are desktop features.
- The Docker image includes mpv for scheduled recordings (it is not used for playback).
- `iptv-server --health` checks a running server; the Docker image uses it as its HEALTHCHECK.
- The web build can be installed as an app (PWA manifest and service worker).

To try the app without a real provider, run `pnpm mock` and add a source:

- M3U URL: `http://127.0.0.1:7290/m3u/sample.m3u`
- Xtream: server `http://127.0.0.1:7290/xtream`, user `demo`, password `secret`
- Stalker: portal `http://127.0.0.1:7290/stalker/c/`, MAC `00:1A:79:00:00:01`

## Using it

- Movies and episodes remember where you stopped. The detail page offers "Resume from m:ss" and "Start over".
- Near the end of an episode, an Up next card counts down to the next one. Use "Play now" to skip the countdown, or press N to play the next item in the queue.
- A stream that drops or stalls is reconnected quietly (up to three tries in about 20 s), and a movie picks up where it stopped. Settings > Playback > "Reconnect dropped streams".
- When a live channel stops working, the player switches to the same channel on another of your sources and says so, with Undo. The player's settings menu lists "Alternate sources" for the channel and can pin a preferred source. Settings > Playback > "Switch live channels to another source".
- An import or refresh can be cancelled while it runs. A cancelled run keeps the catalog the source had before, and a cancelled add leaves no source behind. "Refresh all" has a Stop button.
- Auto refresh is on by default for new playlist URLs, Xtream accounts and Stalker portals. A pasted or uploaded playlist has no address to refetch: to update it, open the source's Edit dialog and paste the new playlist or choose a file. The channels are replaced in place, so favorites, history, positions, renames and locks stay with the channels that are still there.
- Xtream accounts can send their own User-Agent, Referer and Origin (Request headers in the Add and Edit dialogs) instead of the VLC User-Agent the app uses by default.
- Sources with auto refresh on refresh in the background every 12 hours, also while the app is in the tray (Settings > General > Sources: only at startup, 6, 12, 24 or 48 hours). A source refreshes at most once at a time, a manual refresh always wins, and a failing source retries later with a growing delay. Source cards show "Next refresh in ..." and when a refresh last failed.
- Xtream and Stalker source cards show when the subscription expires, whether it is a trial, and how many connections are in use. The dashboard warns 7 days before a subscription expires (Settings > General > Sources; 0 days turns it off), and the warning can be dismissed until the next expiry date. When a stream fails because every connection is in use, the player says so ("Connection limit reached (2 of 2 in use)").
- Removing a source hides it and shows an Undo toast. The source is deleted 8 seconds later unless you press Undo, or right away when the app closes or reloads.
- Catch-up archive: right-click a channel with catch-up and choose "Browse archive" (also in the fullscreen channel list and the guide's programme dialog). Pick a day, then play any past programme, or "Watch from start" on the one airing now. A day with no guide at all lists the archive's hours instead, so you can still watch from a time. The download button next to a finished programme saves it (My Videos lists it under the channel).
- Movies and episodes download from every kind of source, and "Download season" on a series page queues every episode of the season not downloaded yet. An M3U movie that streams as an HLS playlist cannot be saved as a file and says so.
- When an Xtream channel has nothing in the XMLTV guide, the app shows the provider's own now and next, marked "From the provider's guide". Turn it off in Settings > Guide.
- An M3U playlist whose catch-up does not work as tagged can be overridden in the source's Edit dialog under "Catch-up override" (type, URL template and days).
- By default the app returns to the screen you last used (Settings > General > On startup). A fresh install opens the dashboard.
- The window reopens at its last size and position. If that spot is no longer on any monitor (for example, a screen was unplugged), it is moved back onto one. To always open maximized or fullscreen instead, use Settings > General > Window at startup (desktop app). F11 leaves a fullscreen start.
- Picture (player settings menu): aspect ratio (Original, 16:9, 4:3, Stretch), zoom or crop (Crop to fill, 110 %, 125 %, 150 %) and, with the MPV player, deinterlacing. The choice applies to every channel and is kept until you set it back.
- A guide that runs early or late can be shifted per source (Edit dialog, Guide tab, in minutes) and per channel ("Match guide channel", Time shift for this channel). Both come on top of the global shift in Settings > Guide; a channel's own shift replaces the playlist's `tvg-shift`.
- M3U channels with ClearKey DRM (`#KODIPROP` `inputstream.adaptive.license_type=clearkey` and `license_key`, as Kodi and IPTVnator read them) play DASH streams in the built-in player, which takes the keys. The MPV and VLC players cannot, so those channels always use the built-in player.
- Sync (settings menu or right-click menu) shifts subtitles and audio in 100 ms steps. Audio delay needs the MPV player; subtitle delay works in every player. Both go back to zero when the stream changes.
- Stream info (I, or the settings and right-click menus) shows the engine, codecs, resolution, frame rate, bitrates, channels, hardware decoding, dropped frames, buffer, container and server host. It never shows the full URL or credentials.
- B returns to the last live channel. Shift+B, or the history button in the live controls, lists the last 10 channels with what is on now. The series page and Shift+P go back one episode.
- Changing live channel shows a banner for a few seconds with the channel's logo, number, and what is on now and next. Settings > Playback > "Show channel info when switching channels" turns it off.
- Sleep timer (player settings menu, or Z to cycle off, 15, 30, 45, 60 and 90 minutes): stop after a number of minutes, at the end of the programme (live TV, from the guide), or at the end of the episode or movie. A minute before the end a notice offers "Keep watching" or "Cancel timer"; then the sound fades out over the last 30 seconds and live TV stops or a video pauses.
- My List keeps movies and series to watch later. Save a title with the bookmark on its poster or the My List button on its page; the list is in the side rail and on the dashboard. In a movie or series group, saved posters carry a marker and a corner toggle, S saves or removes the title under the cursor, and Shift+F10 or the context-menu key opens the poster menu (also on right click) with Add to or Remove from My List. Reorder it by dragging, with the arrow buttons, or with Alt+Up/Down, mark movies watched with W, and remove the focused title with Delete. Removing a source also removes its titles from My List.
- Multi-view plays two to four live channels at once: right-click a channel and choose "Add to multi-view". Pick side by side, a grid of four, or one large and three small. Only the tile you click has sound. When a source would play on more tiles than its account allows connections, the page warns. Keys on the multi-view page: 1 to 4 give that tile the sound, F fills the screen, M mutes the wall, L switches layout, and A adds a channel. On the focused tile, arrow keys move between tiles, Enter gives it the sound, R replaces its channel, S swaps it with another tile, and Delete closes it.
- Parental controls (Settings > Parental controls): set a 4 to 8 digit PIN, then lock whole groups there or from a group's right-click menu, a channel from its right-click menu, and a movie or series from its page. Adult groups can be locked automatically. Locked content is either hidden everywhere until the PIN is entered, or stays visible and asks for the PIN before it opens. An unlock lasts 15 minutes by default; "Lock now" (Settings > Parental controls, "Lock parental controls now" in the command palette, Ctrl+K, or Ctrl+Alt+L) ends it.
- Channel edits: right-click a live channel and choose "Rename…" (F2 on the focused channel) or "Hide channel" (Shift+Delete). A renamed channel shows its new name everywhere, and "Reset name" goes back to the provider's. A hidden channel leaves the channel list, search, the guide and zapping; "Hidden channels" under the group list shows them and brings them back, and its "Reset all edits" gives every channel of the source its provider's name back and unhides everything. The provider's catalog is never changed, so edits survive refreshes.
- Custom lists hold live channels from any of your sources. Press L on a channel or choose "Add to list…" in its right-click menu. Lists are in the side rail (`/lists`) and at the top of the live group sidebar, and a channel played from a list zaps through the list in its order (Page Up / Page Down). Manage lists renames, reorders (also with Alt+Up/Down) and deletes them with Undo, and a list can show as a rail on the dashboard. A channel the provider drops stays in the list, marked unavailable.
- TV guide: the time window is part of the URL, so Back and Forward step through it and a link opens the same window. T, or the window label, jumps to a date and time. / searches programme titles for the next 14 days, grouped by day; picking a hit moves the grid to it and marks the channel. "Record series" on a hit records every airing of that title on that channel (XMLTV programmes only: the provider's own guide cannot feed a rule); Library > Scheduled lists the rules, which can be paused or removed. The group menu also shows your favorites or a custom list, the zoom buttons (or Ctrl+scroll over the grid) change the time scale, and a row's right-click menu has "Match guide channel" and the favorite toggle. Global search (Ctrl+F) and the command palette find programmes too, and open the guide at the one you pick.
- A channel played from Favorites zaps through your favorites in their order.
- In fullscreen live TV, the channel list opens with C, by resting the pointer on the left edge (right in Arabic), or with the Channel list button that shows with the player controls.
- On a phone or narrow window (below 1024 px), "Hide sidebar" at the bottom of the side rail hides it, and the button at the start of the header brings it back. Below 640 px the mini player is narrower (45 % of the width, at least 190 px) and shows play, mute, the time and fullscreen. A tap on the video shows or hides the controls instead of pausing; use the play button to pause. Mouse clicks still pause, and a double tap or double click goes fullscreen.
- Subtitle files: in the player's options menu (Shift+C), Subtitles > "Load subtitle file…" takes SRT, WebVTT or ASS/SSA files, and Off turns them off. Settings > Playback sets the subtitle size, colour, background and position with a live preview; the player menu changes the same look in place.
- Movie and series grids filter by decade or an exact year range (kept in the URL), mark watched titles with a tick, and "Hide watched" (Shift+W) leaves them out. W marks the title under the cursor watched or unwatched, and a series page can mark the whole series watched.
- Watch stats (`/stats`, in the side rail): time watched per day over the last 7 or 30 days (7 and 3 switch), split into live TV and movies and series, with the most watched channels and titles. The log stays on this device, keeps 90 days, and Clear stats empties it.
- Settings > Appearance: light, dark or system theme, OLED black for the dark theme, seven accent colours, a compact density, and an interface size from 90 to 125 %.
- Posters, channel logos and backdrops are cached on disk the first time they show, so pages you have seen fill in at once, also offline. Settings > General > Image cache shows how much it holds, clears it, and sets its limit (250 MB to 5 GB, default 500 MB); past the limit the pictures used longest ago are dropped. In the browser the server keeps the cache. See `docs/architecture/image-cache.md`.
- Screenshots: the camera button in the player controls, "Take screenshot" in the embedded MPV right-click menu, or S while a video plays saves the current frame as a PNG in `Pictures\Tsrust IPTV` (in `<app data>\screenshots` when there is no Pictures folder), with an Open button in the toast. In the browser the picture goes to your downloads. A stream whose server forbids copying its picture (no CORS) says so. With an external player or radio the button stays but is disabled and says why. See `docs/architecture/screenshot.md`.
- After the first source is added, a three-step tour points at Live TV, My List (movies and series) and search (Next, Back, Skip; Esc skips). After an update, What's new lists what changed since the version you last used. Both show once; "Take the tour" and "What's new" in the command palette (Ctrl+K) and Settings > About open them again. See `docs/architecture/onboarding.md`.

## Data

The desktop app keeps everything under the platform app data folder (`%APPDATA%\com.philly.tsrustiptv` on Windows): `iptv.db` (SQLite), `logs/` (rotating JSON logs, secrets redacted), `image-cache/` (cached posters and logos, size-capped), and `downloads/` unless you choose another downloads folder. A corrupt database is moved aside as `iptv.db.corrupt-<timestamp>` and a fresh one is created.

## Checks

```
pnpm check
```

This runs, in order: `pnpm typecheck` (tsc-rs), `pnpm test` (vitest), `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo fmt --all -- --check`. Two more:

- `pnpm build` produces `dist/`. `pnpm size:check` then lists every chunk and fails when the entry chunk (`dist/assets/index-*.js`) is over 268,000 bytes (`tools/check-bundle.mjs`; see `docs/architecture/performance.md`).
- `pnpm e2e` runs Playwright against `iptv-server` (port 7180) and `iptv-mock` (port 7290) with a fresh `./.e2e-data`. It needs `dist/` and uses installed Microsoft Edge by default (`PW_CHANNEL=chromium` switches to Playwright's bundled Chromium, which cannot play H.264).

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and pull request: the frontend job runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm size:check` on Ubuntu; a Windows job runs `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` (with a placeholder `dist/`, since the desktop crate embeds it); a Linux job runs `cargo test -p iptv-core -p iptv-server -p iptv-mock`. Playwright and the release-mode performance tests are not part of it.

The performance tests run in release mode: `cargo test -p iptv-core --release --test m3u_perf` (50k channels) and `--test epg_perf` (120 MB XMLTV). `--test catalog_perf` checks that live list pages and searches over 50k channels answer in under 100 ms.

`tools/window-probe.ps1` checks the real desktop window from outside: frame and fullscreen state, window and monitor rects in physical pixels, the embedded mpv host, and synthetic clicks, double-clicks and PiP drags on the video. Run `powershell -NoProfile -ExecutionPolicy Bypass -File tools/window-probe.ps1` with the app open (the default `-Action Info` only reads). `-Action SelfTest` needs no running app: it checks offline how the probe picks the mpv IPC pipe (`\\.\pipe\tsrust-iptv-mpv-<pid>-<session>`, a new name for each attach). The script header lists every action.

## Keyboard

Press `?` in the app for the full list. The main ones:

| Keys | Action |
| --- | --- |
| Ctrl+K | Command palette |
| Ctrl+F | Global search |
| Ctrl+R | Recently watched |
| Ctrl+Shift+L | Switch light / dark theme |
| Ctrl+Alt+L | Lock parental controls now (while an unlock is running) |
| F8 | Move focus to notifications |
| F11 | Fullscreen: the player while something plays, otherwise the whole app |
| ? | Shortcut help |
| Ctrl+B | Toggle the live TV group sidebar |
| / | Focus the live TV channel search (in the TV guide: the programme search) |
| T | Jump to a date and time (TV guide) |
| 0-9 | Type a channel number to zap; Enter zaps at once instead of waiting |
| Page Up / Page Down | Previous / next channel (live TV; from a custom list, the list's order) |
| Shift+Page Up / Shift+Page Down | Page through the focused channel list (plain Page Up / Page Down change the channel while live TV plays) |
| Space or K | Play / pause |
| F | Fullscreen (in picture-in-picture: back to the full window) |
| Left / Right | Seek 10 s |
| Shift+Left / Shift+Right | Seek 30 s |
| N | Play the next episode in the queue |
| Shift+P | Play the previous episode in the queue |
| J / L | Seek 10 s (live TV only when the stream can seek) |
| B | Back to the last live channel |
| Shift+B | Channel history (live TV) |
| G / H | Subtitles 100 ms earlier / later |
| Shift+G / Shift+H | Audio 100 ms earlier / later (MPV player) |
| I | Show or hide stream info |
| Up / Down | Volume 5 % |
| M | Mute |
| C | Captions on / off (in fullscreen live TV: the channel panel) |
| Shift+C | Subtitles menu: load a subtitle file, pick a track, change the look |
| Z | Sleep timer: off, 15, 30, 45, 60, 90 minutes |
| S | Take a screenshot (while a video plays; in a focused live channel list S still toggles the favorite) |
| Play/Pause, Stop, Next track, Previous track | The keyboard's media keys: play or pause, stop, and next or previous channel on live TV (otherwise the next or previous item). They also work while typing |
| Shift+N | Add a source (Sources page) |
| L | Add the focused channel to a custom list (live TV, list pages) |
| F2 | Rename the focused channel (live TV, list pages) |
| Shift+Delete | Hide the focused channel (live TV, list pages) |
| Alt+Up / Alt+Down | Move the focused source, favorite, title, list or list channel up / down (Sources, Favorites, My List, and the Manage lists and Edit channels dialogs) |
| W | Mark the focused movie watched or unwatched (My List), or the title under the cursor (movie and series grids) |
| Shift+W | Hide or show watched titles (movie and series grids) |
| 7 / 3 | Show the last 7 / 30 days (Watch stats) |
| S | Add or remove the title under the cursor in My List (movie and series groups) |
| Shift+F10 or the context-menu key | Open the poster menu for the title under the cursor (movie and series groups) |
| Delete | Remove the focused title (My List), favorite (Favorites), item (Recently watched), or episode (a title's page in My Videos; the My Videos grid has no Delete) |
| P / R / X / Delete / O | Pause or resume / retry / cancel / remove / show in its folder the focused download (Downloads; O in the desktop app) |
| Backspace | Back to My Videos from a video's page |
| Esc | Close the open dialog or overlay; leave picture-in-picture; on a movie or series page, go back to where you came from (a grid returns to the title you opened) |

Space, the arrows and Page Up / Page Down control the player while it is expanded on a page, fullscreen, in picture-in-picture, or focused. While only the mini player shows and focus is on the page, they scroll the page and move through its lists and radio buttons as usual. Over an open dialog the app's shortcuts are off except Esc, F11, Ctrl+Shift+L, and Ctrl+K inside the command palette (it closes it). Ctrl+F and Ctrl+R also do nothing in a text field, so they never throw away what you typed.

On the multi-view page:

| Keys | Action |
| --- | --- |
| 1-4 | Give that tile the sound |
| F | Full screen for the wall |
| M | Mute or unmute the wall |
| L | Next layout that holds the tiles |
| A | Add a channel |
| Arrow keys | Move focus between tiles and empty slots |
| Home / End | Focus the first or last slot |
| Enter or Space | Give the focused tile the sound |
| R | Replace the focused tile's channel |
| S | Move the focused tile: press S, then S or Enter on another tile to swap the two (S again on the same tile, or Esc, cancels) |
| Delete or Backspace | Close the focused tile (Undo in the toast) |

## Picture-in-picture

The PiP button in the player controls shrinks the window to a small always-on-top player. Resizing keeps the video's aspect ratio. Esc, F, or the restore button in the PiP title bar returns to the full window at its previous size and position. If you quit while in PiP, the next launch opens at the normal window size, not the PiP size: the saved window state never records PiP bounds.

## Remote control

Settings > Remote turns on a small web remote served at `http://127.0.0.1:7310/` (the port is configurable). Open it in another browser tab or window on the same machine to change channels, type a number, set volume, and play, pause or stop. It lists the channels of the source you last opened in Live TV, also right after the app starts. The remote page is in English only. By default it binds to 127.0.0.1 only and rejects requests whose `Host` or `Origin` is not loopback, so other devices on the network cannot use it.

To use a phone, turn on "Allow phones on this network" under Settings > Remote (desktop app only, off by default). The app then also listens on this computer's private network addresses (home Wi-Fi or Ethernet, never public ones). Click Show pairing code and scan the QR code with the phone's camera; the code works once, expires after 5 minutes, and is hidden again after use. Each paired phone appears in the list below the code, where you can revoke it, and Reset pairing signs out every phone. Unpaired devices on the network see a "Not paired" page and cannot control playback. Windows may ask to allow access on private networks the first time; choose Allow. In server mode this option is hidden. See `docs/architecture/remote-control.md`.

## Backups and migrating from IPTVnator

Settings > Backup exports and imports the IPTVnator playlist backup format (`iptvnator-playlist-backup`, version 1). A backup exported from IPTVnator imports here with its playlists, favorites, recently viewed items, hidden groups, playback positions, and EPG URLs, and a backup exported here opens in IPTVnator. A backup made here also keeps My List, your custom channel lists, channel renames and hidden channels, series recording rules, the watch history behind the Stats page, the subtitle style and the Hide watched setting of the movie and series grids, parental locks and the parental options, never the PIN; while parental controls are locked, a "Replace" import is refused until you unlock them with the PIN. Export leaves passwords out unless you tick "Include passwords and keys". Xtream and Stalker entries are re-synced on import. If a portal cannot be reached, the source is still added, and its favorites and history are applied once the portal has synced (at the latest on the next app start after a successful refresh). See `docs/architecture/backup.md`.

## Troubleshooting

- mpv not found: embedded playback needs mpv. Without it the app says so once ("MPV wasn't found") and plays streams in the built-in player for the rest of the session. Put `mpv.exe` in `vendor/mpv/` or install mpv with WinGet, scoop or choco and restart the app, or set its path in Settings > External players, which makes the next stream try mpv again. When mpv is found but fails to start, the notice offers "Try MPV again".
- The window opens off-screen: the saved position is checked against the monitors connected at startup, and a window that would land off every monitor is moved back onto one. If it still happens, report it with the monitor layout.
- An import seems stuck: use "Cancel import" on the source card, or Cancel in the Add source dialog. For "Refresh all", use Stop. Nothing half-imported is kept. A playlist or guide download that stops sending data is dropped after 20 s.
- The TV guide is empty after an update: this version clears the saved guide once on its first start (database migration 0007) and the next EPG refresh, which starts within a minute of start-up, downloads every guide again. Settings > Guide > "Refresh all guides" starts it at once.
- Error codes: a failed source shows "Error code: X" on its card. `network` means the server could not be reached, `timeout` that it did not answer in time, `auth` that the credentials or MAC were rejected, `not_found` that the address is wrong, `invalid` that the response or the entered details are not usable, `unsupported` that the format or portal feature is not supported, `conflict` that another run of the same source is already going (or the run was cancelled), `server` that the provider answered with a server error (5xx) or a rate limit (429), so try again later, `engine_missing` that mpv was not found or would not run (see the mpv entry above), and `io`, `db` or `internal` a local file, database or app fault. Those last three are worth reporting with the logs.
- Logs live in `%APPDATA%\com.philly.tsrustiptv\logs` (Settings > About > "Open log folder"). Secrets are redacted.
- Reset settings: Settings > General > "Reset settings" puts every setting back to its default, including language, theme, player paths and the image cache limit. Sources, favorites, history and downloads stay, and the tour and What's new do not show again.

### Sources

A source that fails to load keeps its name and details, and its card on the Sources page says what went wrong with a Try again button. Edit fixes the details without removing the source or its favorites.

- Timeouts ("didn't answer in time"): the app gives a server 10 s to accept the connection and 15 s to start answering, then stops waiting instead of hanging. Check that the server address and port are right and that the server is online in a browser, then use Try again. Large playlists are not cut off by these limits; only a stalled download is.
- Unreachable server while adding a source or testing a connection: the app waits 3 s for the connection, without retries, and then says "Could not reach <host>" (error code `network`). After 2 s the dialog shows "Still trying to reach <host>" with Cancel.
- Bad credentials (Xtream username or password, Stalker MAC): the portal answers 401 or 403, or reports the account as expired or disabled. Fix the details with Edit; a Stalker portal only accepts the MAC registered with your provider.
- Not found (404): the playlist or portal address is wrong. For Xtream the server address is `http://host:port` (pasting a full `get.php` link fills in the fields for you); for Stalker use the portal address ending in `/c/`.
- A single stream address (an `.m3u8`, `.ts` or `.mp4` link) pasted as a playlist URL fails right away with a hint instead of downloading the stream. Use the address of the playlist that lists your channels.
- "Answered with a web page instead of a playlist": the address points at a login or error page, not an M3U file. Use the playlist URL your provider gives you (it usually ends in `.m3u`, `.m3u8` or `get.php?...&type=m3u`).

## TMDB

Movie and series pages can show plots, cast, trailers, ratings, artwork, similar titles, and actor pages from TMDB. This is off by default. Turn it on in Settings > Metadata and enter your own API key there, or put `TMDB_API_KEY=...` in a `.env` file in the app data folder or the working directory (see `.env.example`). Results are cached in SQLite.

This product uses the TMDB API but is not endorsed or certified by TMDB.

## Languages

The UI ships in 19 languages (Settings > General > Language; English is the fallback). English is bundled with the app; every other locale is a lazy-loaded chunk fetched when you pick it or on start-up, and the first frame waits for it, so there is no English flash. Strings live in `src/i18n/<lang>/<namespace>.json`.

## Architecture

Start at `docs/README.md`. It links the build spec (`docs/SPEC.md`) and one document per subsystem under `docs/architecture/`.

## Recording

In the desktop app, embedded mpv can record the playing stream (`mpv.record`). Files go to the folder set in Settings > General (Recordings folder), or `<downloads folder>/recordings` when that is not set, named `<title>-YYYYMMDD-HHMM.ts`. mpv copies the stream as is and starts at the next keyframe; its recorder is marked experimental upstream.

Scheduled recordings and reminders:

- In the TV guide, the programme dialog and the now/next ribbon offer "Remind me" and "Record". The ribbon's record menu can also record the channel for 30 minutes to 3 hours. A bell or a red dot marks those programmes in the grid and list views.
- Reminders fire a few minutes before the start (Settings > Recording) while the app runs, including when it is hidden in the tray. They show a Windows notification and a toast with "Watch now", or switch to the channel with Undo.
- Recordings run without the player, through a headless mpv (or a direct copy for plain MPEG-TS streams), with 1 minute of padding before and 5 after by default. Files are named `<Channel> - <Programme> - <YYYY-MM-DD HHmm>.ts`. A dropped stream is retried into part files. A recording that was due while the app was closed is marked missed.
- Library > Scheduled lists what is recording now, what is coming up, and recent results. My Videos > Recordings plays, shows and deletes the files (to the Recycle Bin, with Undo).
- In the browser (server mode), recording needs mpv on the server. The Docker image includes it; elsewhere, install mpv on the server's `PATH`. Without it Record is hidden. Reminders show in-app only.

See `docs/architecture/recording.md`.

## Updates

The updater is off unless the app is built with `--features updater` (for example `pnpm tauri build --features updater`). `tauri.conf.json` carries `plugins.updater` with a placeholder endpoint (`https://example.invalid/...`) and an empty `pubkey`, so an updater build cannot install anything until both are replaced: generate a key pair with `pnpm tauri signer generate`, put the public key in `pubkey`, point `endpoints` at your `latest.json`, set `bundle.createUpdaterArtifacts`, and sign releases with the private key. `app.info` reports `updaterAvailable`. No signing key or feed exists in this repository.

## Licence

Licence not chosen yet. The workspace manifests say MIT as a placeholder; confirm before publishing.

The mpv build bundled by `pnpm tauri:build:mpv` is GPL-2.0-or-later and ships with its licence and source notice in `vendor/mpv/LICENSE.txt`, which is installed beside `mpv.exe`. Tsrust IPTV runs mpv as a separate process and does not link it. That file is the only tracked file in `vendor/mpv/` and describes one specific build: when you replace the mpv build, update its version and commit lines (mpv, FFmpeg, libplacebo) to match the new one before building the installer.
