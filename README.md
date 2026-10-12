# Tsrust IPTV

An IPTV player for Windows, rebuilt from the IPTVnator fork on Tauri 2 with a Rust core. It plays M3U/M3U8 playlists, Xtream Codes accounts, and Stalker/Ministra portals. It has live TV with an EPG, movies and series, catch-up, downloads with an offline library, optional TMDB metadata, and a loopback remote control. The same core also runs as a small web server, so the UI works in a browser (self-hosted PWA mode).

The Rust core (`crates/iptv-core`) owns parsing, storage, portals, EPG, downloads, TMDB, remote control, and players. The React UI never holds a whole catalog: it pages rows out of SQLite over one `rpc(cmd, args)` call.

No IPTV content ships with the app. Bring your own playlists.

## Prerequisites

- Rust stable (pinned by `rust-toolchain.toml`)
- Node 24 and pnpm 10 (`corepack enable`)
- Microsoft Edge WebView2 runtime (preinstalled on Windows 11)
- Optional: mpv for embedded and external playback. Put a Windows build in `vendor/mpv/` (so that `vendor/mpv/mpv.exe` exists), install it with WinGet/scoop/choco, or set its path in Settings > Players. See `docs/architecture/players.md`.
- Optional: VLC for external playback.

```
pnpm install
```

## Run

| What | Command |
| --- | --- |
| Desktop app, dev mode | `pnpm tauri:dev`, or double-click `Start Tsrust IPTV.cmd` |
| Desktop installer (NSIS) | `pnpm tauri:build` (output in `target/release/bundle/nsis/`) |
| Desktop installer with mpv bundled | `pnpm tauri:build:mpv` (needs `vendor/mpv/`; makes the installer much larger) |
| Web UI against a server | `pnpm build`, then `pnpm server`, then open http://127.0.0.1:7180 |
| Web UI with hot reload | `pnpm server` in one terminal, `pnpm dev` in another, open http://localhost:5173 (Vite proxies `/api`) |
| Mock Xtream/Stalker/M3U/XMLTV servers | `pnpm mock` (port 7290) |
| Docker (server mode) | `docker build -t tsrust-iptv .` then `docker run --rm -p 127.0.0.1:7180:7180 -v tsrust-iptv-data:/data tsrust-iptv` |

`Start Tsrust IPTV.cmd` starts the installed app if there is one, then a finished `pnpm tauri:build` output, and otherwise falls back to `pnpm tauri dev`.

Server flags: `iptv-server --port 7180 --data-dir ./.data --static ./dist`. It binds 127.0.0.1 unless you pass `--host`. Details are in `docs/architecture/server.md`.

- The API answers only when the browser uses localhost, an IP address, or a name listed in `--allowed-hosts` / `IPTV_ALLOWED_HOSTS` (comma list). Behind a reverse proxy at `tv.example.com`, set `IPTV_ALLOWED_HOSTS=tv.example.com`.
- The stream proxy, downloads and playlist, guide, Xtream and Stalker requests only reach LAN addresses that belong to the source's own host and port. Pass `--allow-private-targets` (`IPTV_ALLOW_PRIVATE_TARGETS=true`, or `1`/`yes`/`on`) on a trusted network to lift that.
- In the browser, playlists and EPG files cannot be opened from the server's disk (upload the playlist text or use an http(s) guide URL instead), and downloads always go to `<data dir>/downloads`.
- `iptv-server --health` checks a running server; the Docker image uses it as its HEALTHCHECK.
- The web build can be installed as an app (PWA manifest and service worker).

To try the app without a real provider, run `pnpm mock` and add a source:

- M3U URL: `http://127.0.0.1:7290/m3u/sample.m3u`
- Xtream: server `http://127.0.0.1:7290/xtream`, user `demo`, password `secret`
- Stalker: portal `http://127.0.0.1:7290/stalker/portal.php`, MAC `00:1A:79:00:00:01`

## Data

The desktop app keeps everything under the platform app data folder (`%APPDATA%\com.philly.tsrustiptv` on Windows): `iptv.db` (SQLite), `logs/` (rotating JSON logs, secrets redacted), and `downloads/` unless you choose another downloads folder. A corrupt database is moved aside as `iptv.db.corrupt-<timestamp>` and a fresh one is created.

## Checks

```
pnpm check
```

This runs, in order: `pnpm typecheck` (tsc-rs), `pnpm test` (vitest), `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo fmt --all -- --check`. Two more:

- `pnpm build` produces `dist/`.
- `pnpm e2e` runs Playwright against `iptv-server` (port 7180) and `iptv-mock` (port 7290) with a fresh `./.e2e-data`. It needs `dist/` and uses installed Microsoft Edge by default (`PW_CHANNEL=chromium` switches to Playwright's bundled Chromium, which cannot play H.264).

The performance tests run in release mode: `cargo test -p iptv-core --release --test m3u_perf` (50k channels) and `--test epg_perf` (120 MB XMLTV).

## Keyboard

Press `?` in the app for the full list. The main ones:

| Keys | Action |
| --- | --- |
| Ctrl+K | Command palette |
| Ctrl+F | Global search |
| Ctrl+R | Recently watched |
| Ctrl+Shift+L | Switch light / dark theme |
| F8 | Move focus to notifications |
| ? | Shortcut help |
| Ctrl+B | Toggle the live TV group sidebar |
| / | Focus the live TV channel search |
| 0-9 | Type a channel number to zap |
| Page Up / Page Down | Previous / next channel (live TV) |
| Space or K | Play / pause |
| F | Fullscreen (in picture-in-picture: back to the full window) |
| Left / Right | Seek 10 s |
| Shift+Left / Shift+Right | Seek 30 s while the seek bar has focus |
| Up / Down | Volume 5 % |
| M | Mute |
| C | Captions on / off (in fullscreen live TV: the channel panel) |
| Shift+N | Add a source (Sources page) |
| Alt+Up / Alt+Down | Move the focused favorite up / down (Favorites) |
| P / R / X / Delete | Pause or resume / retry / cancel / remove the focused download (Downloads) |
| Backspace | Back to My Videos from a video's page |
| Esc | Close the open dialog or overlay; leave picture-in-picture; on a movie or series page, go back to where you came from (a grid returns to the title you opened) |

## Picture-in-picture

The PiP button in the player controls shrinks the window to a small always-on-top player. Resizing keeps the video's aspect ratio. Esc, F, or the restore button in the PiP title bar returns to the full window at its previous size and position. If you quit while in PiP, the next launch opens at the normal window size, not the PiP size: the saved window state never records PiP bounds.

## Remote control

Settings > Remote turns on a small web remote served at `http://127.0.0.1:7310/` (the port is configurable). Open it in another browser tab or window on the same machine to change channels, type a number, and set volume. It binds to 127.0.0.1 only and rejects requests whose `Host` or `Origin` is not loopback, so other devices on the network cannot use it. See `docs/architecture/remote-control.md`.

## Backups and migrating from IPTVnator

Settings > Backup exports and imports the IPTVnator playlist backup format (`iptvnator-playlist-backup`, version 1). A backup exported from IPTVnator imports here with its playlists, favorites, recently viewed items, hidden groups, playback positions, and EPG URLs, and a backup exported here opens in IPTVnator. Export leaves passwords out unless you tick "Include passwords and keys". Xtream and Stalker entries are re-synced on import. If a portal cannot be reached, the source is still added, and its favorites and history are applied once the portal has synced (at the latest on the next app start after a successful refresh). See `docs/architecture/backup.md`.

## Troubleshooting sources

A source that fails to load keeps its name and details, and its card on the Sources page says what went wrong with a Try again button. Edit fixes the details without removing the source or its favorites.

- Timeouts ("didn't answer in time"): the app gives a server 10 s to accept the connection and 15 s to start answering, then stops waiting instead of hanging. Check that the server address and port are right and that the server is online in a browser, then use Try again. Large playlists are not cut off by these limits; only a stalled download is.
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

## Updates

The updater is off unless the app is built with `--features updater` (for example `pnpm tauri build --features updater`). `tauri.conf.json` carries `plugins.updater` with a placeholder endpoint (`https://example.invalid/...`) and an empty `pubkey`, so an updater build cannot install anything until both are replaced: generate a key pair with `pnpm tauri signer generate`, put the public key in `pubkey`, point `endpoints` at your `latest.json`, set `bundle.createUpdaterArtifacts`, and sign releases with the private key. `app.info` reports `updaterAvailable`. No signing key or feed exists in this repository.

## Licence

Licence not chosen yet. The workspace manifests say MIT as a placeholder; confirm before publishing.

The mpv build bundled by `pnpm tauri:build:mpv` is GPL-2.0-or-later and ships with its licence and source notice in `vendor/mpv/LICENSE.txt`, which is installed beside `mpv.exe`. Tsrust IPTV runs mpv as a separate process and does not link it. That file is the only tracked file in `vendor/mpv/` and describes one specific build: when you replace the mpv build, update its version and commit lines (mpv, FFmpeg, libplacebo) to match the new one before building the installer.
