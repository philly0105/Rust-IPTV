# Remote control

The remote control lets a phone or another browser tab on the same machine change channels and volume on the running app. It is a small HTTP server inside `iptv-core` (`crates/iptv-core/src/remote/`), bound to `127.0.0.1` only. LAN access is out of scope.

## Pieces

| File | Role |
| --- | --- |
| `remote/mod.rs` | `RemoteHub` (latest status, published channels, server handle), `start`, `start_on`, `stop`, `server_status`, `init`, settings watcher |
| `remote/server.rs` | axum router, loopback guard, JSON handlers, `is_loopback_host` |
| `remote/rpc.rs` | the five `remote.*` RPC commands |
| `remote/remote-ui/index.html` | the remote web page, embedded with `include_str!` |
| `tests/remote_control.rs` | check 10 (SC8) |

## Flow

1. The user turns on Settings > Remote (or the UI calls `remote.start`). The server binds `127.0.0.1:{settings.remoteControl.port}` (default 7310).
2. The remote page at `http://127.0.0.1:{port}` polls `GET /api/remote-control/status` once a second and posts commands.
3. Each command becomes a `remote.command` app event (C1). The player store (`src/features/player`) listens with `onAppEvent('remote.command', ...)` and applies it: channel up/down and number select through `useChannelZap`, `selectId` by splitting `${sourceId}|${itemId}`, volume through the store actions.
4. The UI reports what is playing with `remote.reportStatus` and publishes the current live list with `remote.publishChannels`. Both are kept in memory only; the channel list is capped at 20 000 entries.

The core never changes playback itself, so the same server works for the desktop shell and the PWA server mode.

## Lifecycle

- `remote.start` -> `{url}`: binds `settings.remoteControl.port`. Already running on that port: returns the current URL. Running on another port: binds the new port first, then stops the old server, so a failed switch leaves the old server up.
- `remote.stop`: signals graceful shutdown, waits up to 3 s for open connections, then aborts. Idempotent.
- `remote.status` -> `{running, url?, port}`: `port` is the bound port while running, else the configured port.
- `init(state)` starts the server when `settings.remoteControl.enabled`, then watches the settings cache once a second. A change to `enabled` or `port` starts, stops, or moves the server. Explicit `remote.start` / `remote.stop` calls stand until the settings change again. The watcher holds a `Weak<AppState>` and exits with the app.
- `start_on(state, port)` is the public helper behind `remote.start`; port `0` picks a free port (tests use it).

A busy port returns `Conflict` ("port N is already in use; choose another remote control port in Settings > Remote").

The hub lives at `state.extensions["remote"]` (`remote::EXT_KEY`).

## HTTP API

All routes sit under `/api/remote-control`. Responses are JSON with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`. No CORS headers are sent.

| Method and path | Body | Effect |
| --- | --- | --- |
| `GET /` | | remote page (CSP: inline script and style only, `connect-src 'self'`) |
| `GET /status` | | `RemoteStatus` plus `updatedAt` (absent until the app reports) and `channelCount` |
| `GET /channels?q=&offset=&limit=` | | `{channels, total, updatedAt}`; `q` matches names case-insensitively and number prefixes; no params returns the whole list |
| `GET /health` | | `{app, version, ready, protocolVersion: 2}` |
| `POST /channel/up`, `/channel/down` | ignored | `channelUp` / `channelDown` |
| `POST /channel/select` | `{number}` (1..999999, integer or numeric string) | `selectNumber {number}` |
| `POST /channel/select-id` | `{id}` (`channelId` also accepted) | `selectId {id}`; 404 when a list is published and the id is not in it |
| `POST /volume` | `{delta?, level?, mute?}` | `level` -> `setVolume {level}`; else `delta` > 0 -> `volumeUp`, < 0 -> `volumeDown`; `mute` -> `mute` |

Volume levels use the HTML media scale 0..1. A `level` in (1, 100] is read as a percentage. `mute` toggles in the player, so the server skips it when the last reported `muted` already equals the requested value; `{mute: true}` is therefore idempotent. Command responses are `{ok: true, commands: [...]}` listing the events emitted.

Old IPTVnator paths are kept as aliases: `/channel/select-number`, `/volume/up`, `/volume/down`, `/volume/toggle-mute`.

Bad input returns 400 `{error: "invalid", message}`; bodies over 16 KB return 413.

## Loopback guard

Middleware runs before every route, including the page:

- `Host` (or the request URI authority when `Host` is missing) must be `127.0.0.1`, `localhost`, or `[::1]`, with or without a numeric port. Anything else gets 403. This blocks LAN clients that reach the port through forwarding and DNS-rebinding pages whose Host is their own domain.
- When `Origin` is present it must equal `http://127.0.0.1:{port}` or `http://localhost:{port}` for the bound port. `null`, other ports, `https`, and other hosts get 403. Browsers send `Origin` on cross-site POSTs and fetches, so other sites cannot drive the player or read the status.

403 bodies are `{error: "forbidden", message}`. Rejections are logged without headers or bodies.

## Remote page

`remote-ui/index.html` is one file with inline CSS and JS and no network assets besides channel logos.

- An amber LCD panel shows the channel number, name, EPG now, and source with a live dot.
- Channel and volume rockers sit side by side, with mute and the channel list between them.
- The keypad collects up to six digits on the LCD. It commits 1.5 s after the last digit (a bar shows the countdown) or on Go. Delete removes a digit.
- A volume slider sends `level`. Volume controls are disabled when the status says `canVolume: false`.
- The channel sheet searches `/channels?q=` (debounced 200 ms, 200 rows per page) and selects with `select-id`. It has loading skeletons and empty states for "no list yet" and "no matches".
- Status polls every second. After errors it backs off (2 s, 4 s ... up to 15 s) and shows a banner. Polling stops while the tab is hidden.
- Touch targets are at least 44 px. The page uses a dark theme, honors `prefers-reduced-motion`, and gives haptic feedback where supported. On a desktop keyboard: arrows or PageUp/PageDown change channel, +/- change volume, m mutes, digits and Enter select a number, / opens search, Escape closes it.

## Testing

`cargo test -p iptv-core --test remote_control` binds port 0 and checks:

- channel up/down, select, select-id, and volume commands emit `remote.command` on the `BroadcastSink`
- invalid bodies return 400 and emit nothing
- `Origin: http://evil.example`, `null`, wrong port, and `https` return 403
- Hosts `192.168.1.5` and `evil.example` return 403; loopback hosts pass
- the `reportStatus` -> `/status` and `publishChannels` -> `/channels` round trips
- the RPC lifecycle: start, idempotent start, busy port keeps the old server, stop
- all five `remote.*` names are registered

Unit tests in `server.rs` and `mod.rs` cover host parsing, origin matching, number and level parsing, and channel sanitizing.
