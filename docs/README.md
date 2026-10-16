# Tsrust IPTV documentation

- [SPEC.md](SPEC.md): the build spec. Stack, repository layout, every cross-module contract (C1 RPC and events through C16 shell hooks), run commands, ports, and the acceptance checks.

## How the pieces fit

The desktop shell (`crates/iptv-tauri`) and the web server (`crates/iptv-server`) are thin hosts around `crates/iptv-core`. Each builds an `AppState` (SQLite pool, HTTP client, settings cache, event sink), registers every module's commands with `rpc::build_router()`, and starts module runtimes with `rpc::init_all()`. The UI calls `rpc(cmd, args)`: a Tauri command on desktop, `POST /api/rpc/{cmd}` on the server. Core events reach the UI as the Tauri `app-event` event or over the `/api/events` WebSocket, and `src/api/query.ts` turns them into TanStack Query invalidations.

`init_all` order: the importers (m3u, xtream, stalker) register first, then `sources` schedules the startup refresh, then catalog, userstate, settings, backup (applies parked restores), epg, downloads, tmdb, remote, recording, parental (starts the unlock-expiry timer), watchlist, lists, stats (prunes the watch log), imagecache (reconciles the image cache index with its files in the background), and player. A module that fails to start is logged and skipped.

## Core subsystems (`crates/iptv-core`)

| Document | Covers |
| --- | --- |
| [sources.md](architecture/sources.md) | Sources table, importer registry, add/refresh/remove, startup refresh |
| [account.md](architecture/account.md) | Xtream and Stalker subscription status (expiry, trial, connections in use), its cache, source card badges and the dashboard warning |
| [catalog.md](architecture/catalog.md) | Items and categories, paged queries, search, multi-source VOD matching |
| [m3u.md](architecture/m3u.md) | Streaming M3U parser and importer |
| [xtream.md](architecture/xtream.md) | Xtream Codes client, sync, stream and catch-up URLs |
| [stalker.md](architecture/stalker.md) | Stalker/Ministra session, handshake, sync, VOD paging |
| [epg.md](architecture/epg.md) | Streaming XMLTV import, storage, channel resolution, refresh |
| [userstate.md](architecture/userstate.md) | Favorites, recently viewed, playback positions |
| [watchlist.md](architecture/watchlist.md) | My List: the movie and series watchlist, its ordering, backup, and the poster button, dashboard rail and `/my-list` page |
| [parental.md](architecture/parental.md) | Parental controls: PIN (PBKDF2), wrong-PIN lockout, session unlock, category and item locks, adult group detection, hide mode in every catalog and user-state reader, backup |
| [settings.md](architecture/settings.md) | Settings document and window state |
| [backup.md](architecture/backup.md) | IPTVnator playlist backup v1 import and export |
| [downloads.md](architecture/downloads.md) | Download queue, range resume, `.part` policy, My Videos |
| [tmdb.md](architecture/tmdb.md) | TMDB client, matching, cache, attribution |
| [remote-control.md](architecture/remote-control.md) | Loopback remote control server and page |
| [players.md](architecture/players.md) | mpv/VLC detection, external launch, embedded mpv on Windows |
| [failover.md](architecture/failover.md) | Smart reconnect of dropped streams and live failover to the same channel on another source (`live.alternates`) |
| [recording.md](architecture/recording.md) | Guide reminders, scheduled recordings (headless mpv or HTTP copy), series recording rules, Scheduled page, My Videos > Recordings |
| [channel-edits.md](architecture/channel-edits.md) | Hiding and renaming live and radio channels without touching the provider's data, the Hidden channels dialog, F2 and Shift+Delete |
| [lists.md](architecture/lists.md) | Custom channel lists across sources: storage, ordering, unavailable items, zapping in list order, backup, the `/lists` pages and the Live sidebar section |
| [guide-search.md](architecture/guide-search.md) | Guide programme search (`epg.search`): word matching, the window, the title index and its scan fallback |
| [vod-browsing.md](architecture/vod-browsing.md) | Movie and series year filters, the watched tick, Hide watched and Mark series watched |
| [stats.md](architecture/stats.md) | Watch stats: the player's reporter, the per-day watch log (90 days) and the `/stats` page |
| [image-cache.md](architecture/image-cache.md) | Disk cache for posters, logos and backdrops: storage, LRU cap (`imageCacheMaxMb`), single-flight fetches, `images.stats` / `images.clear`, the `/api/img` route on the server and the desktop proxy |
| [screenshot.md](architecture/screenshot.md) | Player screenshots: the `screenshot.*` commands, the Pictures folder and file names, capture in embedded mpv and the built-in player, the `S` key |

## Hosts and UI

| Document | Covers |
| --- | --- |
| [server.md](architecture/server.md) | `iptv-server`: REST/WS API, stream proxy, file serving, Docker |
| [desktop.md](architecture/desktop.md) | Desktop shell: loopback media proxy (`proxyBase`, Host/Origin guards, private targets) and WebView2 memory trimming |
| [ui-shell.md](architecture/ui-shell.md) | Design tokens, UI primitives, shell layout, shortcuts, dashboard, i18n |
| [appearance.md](architecture/appearance.md) | Accent colours, OLED black, density and UI scale, glass tokens, contrast checks, cards, the dashboard hero |
| [multiview.md](architecture/multiview.md) | Multi-view wall at `/multiview`: store, layouts, independent tiles, sound, keyboard, connection-limit warning, parental gate |
| [subtitles.md](architecture/subtitles.md) | Subtitle files (SRT, WebVTT, ASS/SSA) in the built-in player and embedded mpv, and the subtitle look settings |
| [performance.md](architecture/performance.md) | Query cache timing per command, hover prefetch of VOD details, and the entry chunk budget (`pnpm size:check`) |
| [onboarding.md](architecture/onboarding.md) | The first-run tour and What's new: the startup decision, the settings markers, release notes, anchors |

The rest of the desktop shell is small enough to read directly: `crates/iptv-tauri/src/lib.rs` (plugins, tray, `rpc` command, event bridge, asset scope for the downloads folder, deep links, exit cleanup), `crates/iptv-tauri/src/mpv_window.rs` (the child window embedded mpv draws into, see players.md), `crates/iptv-tauri/src/proxy.rs` (the loopback media proxy) and `crates/iptv-tauri/src/memory.rs` (idle memory trimming on Windows); desktop.md covers the last two.

## Events

Event names and payloads are listed in SPEC C1, plus `deeplink.open {urls}` (desktop) and `events.lagged {skipped}` (server: the WebSocket fell behind and dropped events; the UI refetches every query).
