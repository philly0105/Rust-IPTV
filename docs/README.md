# Tsrust IPTV documentation

- [SPEC.md](SPEC.md): the build spec. Stack, repository layout, every cross-module contract (C1 RPC and events through C16 shell hooks), run commands, ports, and the acceptance checks.

## How the pieces fit

The desktop shell (`crates/iptv-tauri`) and the web server (`crates/iptv-server`) are thin hosts around `crates/iptv-core`. Each builds an `AppState` (SQLite pool, HTTP client, settings cache, event sink), registers every module's commands with `rpc::build_router()`, and starts module runtimes with `rpc::init_all()`. The UI calls `rpc(cmd, args)`: a Tauri command on desktop, `POST /api/rpc/{cmd}` on the server. Core events reach the UI as the Tauri `app-event` event or over the `/api/events` WebSocket, and `src/api/query.ts` turns them into TanStack Query invalidations.

`init_all` order: the importers (m3u, xtream, stalker) register first, then `sources` schedules the startup refresh, then catalog, userstate, settings, backup (applies parked restores), epg, downloads, tmdb, remote, and player. A module that fails to start is logged and skipped.

## Core subsystems (`crates/iptv-core`)

| Document | Covers |
| --- | --- |
| [sources.md](architecture/sources.md) | Sources table, importer registry, add/refresh/remove, startup refresh |
| [catalog.md](architecture/catalog.md) | Items and categories, paged queries, search, multi-source VOD matching |
| [m3u.md](architecture/m3u.md) | Streaming M3U parser and importer |
| [xtream.md](architecture/xtream.md) | Xtream Codes client, sync, stream and catch-up URLs |
| [stalker.md](architecture/stalker.md) | Stalker/Ministra session, handshake, sync, VOD paging |
| [epg.md](architecture/epg.md) | Streaming XMLTV import, storage, channel resolution, refresh |
| [userstate.md](architecture/userstate.md) | Favorites, recently viewed, playback positions |
| [settings.md](architecture/settings.md) | Settings document and window state |
| [backup.md](architecture/backup.md) | IPTVnator playlist backup v1 import and export |
| [downloads.md](architecture/downloads.md) | Download queue, range resume, `.part` policy, My Videos |
| [tmdb.md](architecture/tmdb.md) | TMDB client, matching, cache, attribution |
| [remote-control.md](architecture/remote-control.md) | Loopback remote control server and page |
| [players.md](architecture/players.md) | mpv/VLC detection, external launch, embedded mpv on Windows |

## Hosts and UI

| Document | Covers |
| --- | --- |
| [server.md](architecture/server.md) | `iptv-server`: REST/WS API, stream proxy, file serving, Docker |
| [ui-shell.md](architecture/ui-shell.md) | Design tokens, UI primitives, shell layout, shortcuts, dashboard, i18n |

The desktop shell itself is small enough to read directly: `crates/iptv-tauri/src/lib.rs` (plugins, tray, `rpc` command, event bridge, asset scope for the downloads folder, deep links, exit cleanup) and `crates/iptv-tauri/src/mpv_window.rs` (the child window embedded mpv draws into).

## Events

Event names and payloads are listed in SPEC C1, plus `deeplink.open {urls}` (desktop) and `events.lagged {skipped}` (server: the WebSocket fell behind and dropped events; the UI refetches every query).
