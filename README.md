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
| Ctrl+B | Toggle the live TV group sidebar |
| 0-9 | Type a channel number to zap |
| Space or K | Play / pause |
| F | Fullscreen |
| Left / Right | Seek 5 s |
| Up / Down | Volume 5 % |
| M | Mute |
| Esc | Close the open dialog or overlay |

## Remote control

Settings > Remote turns on a small web remote served at `http://127.0.0.1:7310/` (the port is configurable). Open it in another browser tab or window on the same machine to change channels, type a number, and set volume. It binds to 127.0.0.1 only and rejects requests whose `Host` or `Origin` is not loopback, so other devices on the network cannot use it. See `docs/architecture/remote-control.md`.

## Backups and migrating from IPTVnator

Settings > Backup exports and imports the IPTVnator playlist backup format (`iptvnator-playlist-backup`, version 1). A backup exported from IPTVnator imports here with its playlists, favorites, recently viewed items, hidden groups, playback positions, and EPG URLs, and a backup exported here opens in IPTVnator. Export leaves passwords out unless you tick "Include passwords and keys". Xtream and Stalker entries are re-synced on import. If a portal cannot be reached, the source is still added, and its favorites and history are applied once the portal has synced (at the latest on the next app start after a successful refresh). See `docs/architecture/backup.md`.

## TMDB

Movie and series pages can show plots, cast, trailers, ratings, artwork, similar titles, and actor pages from TMDB. This is off by default. Turn it on in Settings > Metadata and enter your own API key there, or put `TMDB_API_KEY=...` in a `.env` file in the app data folder or the working directory (see `.env.example`). Results are cached in SQLite.

This product uses the TMDB API but is not endorsed or certified by TMDB.

## Languages

The UI ships in 19 languages (Settings > General > Language; English is the fallback). English is bundled with the app; every other locale is a lazy-loaded chunk fetched when you pick it or on start-up, and the first frame waits for it, so there is no English flash. Strings live in `src/i18n/<lang>/<namespace>.json`.

## Architecture

Start at `docs/README.md`. It links the build spec (`docs/SPEC.md`) and one document per subsystem under `docs/architecture/`.

## Licence

Licence not chosen yet. The workspace manifests say MIT as a placeholder; confirm before publishing.
