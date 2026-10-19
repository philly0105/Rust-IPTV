# Remote control

The remote control lets a phone or another browser tab on the same machine change channels and volume, and play, pause or stop, on the running app. It is a small HTTP server inside `iptv-core` (`crates/iptv-core/src/remote/`), bound to `127.0.0.1`. In the desktop app the user can also turn on LAN mode (`settings.remoteLanEnabled`), which adds listeners on the computer's private IPv4 addresses for phones that pair with a QR code. See [LAN mode](#lan-mode).

## Pieces

| File | Role |
| --- | --- |
| `remote/mod.rs` | `RemoteHub` (latest status, channel list, published source, server handle), `start`, `start_on`, `stop`, `server_status`, `publish_source`, `refresh_channels`, `channels_may_have_changed`, `init`, settings watcher |
| `remote/server.rs` | axum router, access guard (`check_access`), pairing endpoint, JSON handlers, `is_loopback_host` |
| `remote/lan.rs` | private IPv4 selection (`select_lan_addrs`), bind plan (`plan_binds`), interface listing |
| `remote/pairing.rs` | pairing code, pair rate limiter, paired-device sessions, cookie helpers, QR rendering |
| `remote/rpc.rs` | the ten `remote.*` RPC commands |
| `remote/remote-ui/index.html` | the remote web page, embedded with `include_str!` |
| `tests/remote_control.rs` | check 10 (SC8) |
| `tests/remote_lan.rs` | LAN pairing, sessions and guard, with simulated LAN peers on a loopback listener |
| `src/features/settings/sections/RemoteLanPanel.tsx` | Settings > Remote: LAN toggle, QR code, paired phones |

## Flow

1. The user turns on Settings > Remote (or the UI calls `remote.start`). The server binds `127.0.0.1:{settings.remoteControl.port}` (default 7310).
2. The remote page at `http://127.0.0.1:{port}` polls `GET /api/remote-control/status` once a second and posts commands.
3. Each command becomes a `remote.command` app event (C1). The player store (`src/features/player`) listens with `onAppEvent('remote.command', ...)` and applies it: channel up/down and number select through `useChannelZap`, `selectId` by splitting `${sourceId}|${itemId}`, volume, `togglePlay`, `seekBy` and `stop` through the store actions (`stop` of an external player goes through `stopExternalPlayback`, like the stage's Stop button).
4. The UI reports what is playing with `remote.reportStatus`, kept in memory only.
5. The Live page names the source it shows with `remote.publishSource {sourceId}` (`useRemoteBridge`, while the server runs). The core fills the channel list itself (`refresh_channels`): `catalog::all_live_channels` with the readers' filters (hidden groups and channels, parental hide mode, English only), custom names from channel edits, at most 20 000 entries, of which the hub keeps only `id`, `name`, `number` and `logoUrl`. No channel row crosses the WebView (performance audit LV-7). The source is kept in memory and in `app_state` under `remote_source`, and every server start fills the list from it, so after a restart the phone lists channels before anyone opens Live TV. `channels_may_have_changed` refills it in the background when `parental.changed` fires (lock, unlock, an unlock running out), when `channels.changed` fires for that source, and when `sources.changed` reports a new catalog or a removal. Fills are serialized, and one that finds the published source changed meanwhile is dropped.
6. `remote.publishChannels {channels}` still replaces the list with the caller's own, for clients that build one.

The core never changes playback itself, so the same server works for the desktop shell and the PWA server mode. In server mode it still binds loopback only (there is no LAN mode there), so in the Docker image the remote is reachable only from inside the container.

## Lifecycle

- `remote.start` -> `{url}`: binds `settings.remoteControl.port`. Already running on that port: returns the current URL. Running on another port: binds the new port first, then stops the old server, so a failed switch leaves the old server up.
- `remote.stop`: signals graceful shutdown, waits up to 3 s for open connections, then aborts. Idempotent.
- `remote.status` -> `{running, url?, port, lanAddresses?, lanError?}`: `port` is the bound port while running, else the configured port. `lanAddresses` (`{ip, interface, url}[]`) lists the LAN listeners; `lanError` says why LAN mode has no or fewer listeners.
- `init(state)` starts the server when `settings.remoteControl.enabled`, then watches the settings cache once a second. A change to `enabled` or `port` starts, stops, or moves the server. A change to `remoteLanEnabled` restarts a running server in place. While LAN mode is on, the watcher rescans network addresses every 30 s and rebinds when the addresses differ from the ones actually bound (new Wi-Fi, DHCP renewal, or an address that failed to bind earlier; the Retry button in Settings does the same through `remote.start`). Any restart that cannot rebind loopback, including LAN restarts and rescans, is retried every 5 s while the settings still ask for the server. The decisions live in a small pure `Watch` state machine with unit tests. Explicit `remote.start` / `remote.stop` calls stand until the settings change again. The watcher holds a `Weak<AppState>` and exits with the app.
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
| `POST /playback/toggle` | ignored | `togglePlay` (play or pause the built-in player) |
| `POST /playback/stop` | ignored | `stop` |
| `POST /playback/seek` | `{seconds}` (non-zero, at most 6 hours either way; negative goes back) | `seekBy {seconds}` (the built-in player; external players ignore it) |

Volume levels use the HTML media scale 0..1. A `level` in (1, 100] is read as a percentage. `mute` toggles in the player, so the server skips it when the last reported `muted` already equals the requested value; `{mute: true}` is therefore idempotent. Command responses are `{ok: true, commands: [...]}` listing the events emitted.

Old IPTVnator paths are kept as aliases: `/channel/select-number`, `/volume/up`, `/volume/down`, `/volume/toggle-mute`.

Bad input returns 400 `{error: "invalid", message}`; bodies over 16 KB return 413.

## Access guard

Middleware runs before every route, including the page. The decision is the pure function `server::check_access(peer, host, origin, port, lan)`:

- Loopback peers: `Host` (or the request URI authority when `Host` is missing) must be `127.0.0.1`, `localhost`, or `[::1]`, with or without a numeric port. When `Origin` is present it must equal `http://127.0.0.1:{port}` or `http://localhost:{port}`. `null`, other ports, `https`, and other hosts get 403. Browsers send `Origin` on cross-site POSTs and fetches, so other sites cannot drive the player or read the status. Loopback needs no pairing.
- Other peers: only when LAN mode is listening and the peer is private IPv4 (RFC 1918 or link-local; IPv4-mapped IPv6 is unwrapped). `Host` must be one of the bound LAN addresses as an IP literal with the bound port (no port means 80). Hostnames, other private IPs, `localhost`, and other ports get 403, which defeats DNS rebinding: a rebinding page's `Host` is its own domain name. `Origin`, when present, must be `http://<bound LAN ip>:{port}`.
- Public peers, unknown peers, and LAN peers while LAN mode is off get 403.

403 bodies are `{error: "forbidden", message}`. Rejections are logged with method, path and reason only, never headers, cookies or bodies.

## LAN mode

Desktop only. `settings.remoteLanEnabled` (default false) is the only setting; it is in the settings JSON but not in backups (backups carry an allow-list of keys). Server mode (`iptv-server`, `AppState.is_desktop == false`) ignores it: the pairing RPCs return `unsupported` and the UI shows a note instead of the controls.

Binding: `lan::plan_binds` always plans `127.0.0.1:{port}`, and with LAN mode on adds every private IPv4 from `if-addrs`. Loopback, public, IPv6, and point-to-point adapters (PPP and tunnel interface types, which is how Windows types many VPNs) are skipped. The rest is ordered physical adapters first, then virtual adapters (vEthernet, WSL, VirtualBox, VMware, Docker), then adapters whose name looks like a VPN or overlay (VPN, TAP, TUN, WireGuard, NordLynx, ZeroTier, OpenVPN, Proton, Tailscale, AnyConnect, Fortinet, GlobalProtect and similar); within each group 192.168, then 10, then 172.16/12, then link-local. The first address is the default for the QR code and the user can pick another in Settings. The default route is not read (`if-addrs` does not expose gateways; reading it would need the IP Helper API), so a VPN adapter whose name gives nothing away and whose range sorts first can still be the default; the address picker is the way out. VPN-named adapters are still bound, because the name is only a guess: peers on such a virtual network can reach the page and `/pair`, but still need the code. Each address is its own listener on the same port; there is never a `0.0.0.0` bind. A LAN address that fails to bind is reported in `lanError` and the others keep working. With no private address, `lanError` is "no private network address found; connect this computer to Wi-Fi or Ethernet". Windows may ask to allow access on private networks the first time; the Settings text and the README say so.

Pairing:

1. The QR code is hidden until the user clicks Show pairing code, so it does not leak through screen sharing or a glance at the screen. While shown, Settings calls `remote.pairingCode {address?}` every 5 s. It hides again when the shown code is used by a phone (the next call returns a different code), when it expires, or on Hide code. A hidden code stays valid until it expires (at most 5 minutes); there is no separate revoke. It returns `{url, address, expiresAt, expiresInSecs, qr: {size, path}}` where `url` is `http://<lan-ip>:{port}/?pair=<code>` and `qr` is an SVG path rendered by `qrcodegen` (medium error correction).
2. The code is 16 random bytes, base64url (22 characters), kept in memory only. It lives 5 minutes, is used once, and is compared in constant time. The same code is returned until it expires or is used.
3. The phone opens the URL. The page removes `?pair=` from the address bar with `history.replaceState` and posts `{code}` to `POST /api/remote-control/pair`.
4. On success the core mints a 32-byte session token, stores only its SHA-256 hash with a device summary, and answers `{ok: true}` with `Set-Cookie: tsr_remote=<token>; Path=/api/remote-control; Max-Age=34560000; HttpOnly; SameSite=Strict`. A new code is minted for the next phone.

Cookie scope: the path keeps the token away from other pages and from other services on the same IP (MediaVault, dev servers) unless they also serve `/api/remote-control`. Residual: cookies are scoped by host, not port, and the page is plain HTTP, so a phone on another network where the same private IP belongs to a different machine sends the token to that machine on the remote port, and a peer that sniffs the home Wi-Fi can read it. The token only works on this app's listener and is cut off with Revoke or Reset pairing. Cookies from builds that used `Path=/` keep working; a refused cookie is cleared on both paths.

Pair responses: wrong code 401 `{error: "invalid_code"}`; rate limited 429 `{error: "rate_limited", retryAfter}` with `Retry-After`; from loopback 400 (loopback needs no pairing); 503 `{error: "unavailable"}` while the device list cannot be read.

Rate limit (`PairLimiter`): each address gets 5 failures per 60 s, tracked in a table of at most 256 addresses. Past 200 failures from everyone in 60 s, addresses that failed recently are refused without a look at their code, but an address with no recent failure still gets its code checked, so the owner's phone pairs while another device floods wrong codes. Trade-off: when the table is full of addresses that are still failing (an attacker with more than 256 addresses on the network) and the ceiling is reached, untracked addresses are refused as well, since they cannot be told apart from the attacker's; pairing then waits for the window. The 128-bit code is the real protection; the limiter slows guessing and bounds memory (at most 256 addresses and 200 timestamps).

Sessions: every LAN request except `GET /` and `POST /pair` needs a valid cookie, otherwise 401 `{error: "unpaired"}` (a stale cookie is cleared). The device list is loaded from the database on first use. If that read fails (database busy at startup), the list stays unloaded and is never written, LAN requests get 503 `{error: "unavailable"}` with `Retry-After: 5` and keep their cookie, pairing waits, and `remote.devices` / `remote.revokeDevice` / `remote.resetPairing` return the error; the next request tries the load again. Paired devices are stored in `app_state` under `remote_paired_devices` as `{id, hash, browser, os, pairedAt, lastSeen}` (at most 16; the least recently used is evicted). `app_state` is not exported, so tokens never reach settings, backups, or exports. `lastSeen` is written at most every 5 minutes per device. The user agent is reduced to a fixed browser and OS name ("Safari", "iPhone"); the raw string is not stored.

| RPC | Result |
| --- | --- |
| `remote.pairingCode {address?}` | `PairingInfo`; `conflict` when the server or LAN listeners are not running; `unsupported` in server mode |
| `remote.devices` | `{id, name: {browser, os?}, pairedAt, lastSeen}[]` |
| `remote.revokeDevice {id}` | removes the device; its phone gets 401 on the next request; `not_found` for unknown ids |
| `remote.resetPairing` | removes every device and invalidates the current code |

Redaction: `pair` and `tsr_remote` are in the logging `SECRET_PARAMS`, so `?pair=` values and the cookie are masked in any logged URL or text. `Pairing` and `StoredDevice` have hand-written `Debug` impls that print no secrets.

## Remote page

`remote-ui/index.html` is one file with inline CSS and JS and no network assets besides channel logos.

- An amber LCD panel shows the channel number, name, EPG now, and source with a live dot.
- Channel and volume rockers sit side by side, with mute and the channel list between them.
- The keypad collects up to six digits on the LCD. It commits 1.5 s after the last digit (a bar shows the countdown) or on Go. Delete removes a digit.
- A volume slider sends `level`. Volume controls are disabled when the status says `canVolume: false`.
- Back 10 s, Forward 30 s, Play / Pause and Stop sit under the rockers. Seeking and Play / Pause need the built-in player (`canVolume`); Stop also works while an external player has a channel open, and is disabled when nothing plays.
- The page is English only. Its strings live in the embedded HTML, outside the app's `src/i18n` catalogs, so the app's translations do not reach it.
- The channel sheet searches `/channels?q=` (debounced 200 ms, 200 rows per page) and selects with `select-id`. It has loading skeletons and empty states for "no list yet" and "no matches".
- Status polls every second. After errors it backs off (2 s, 4 s ... up to 15 s) and shows a banner. Polling stops while the tab is hidden.
- Over LAN, a 401 `unpaired` shows a "Not paired" screen with three steps (open Settings > Remote on the computer, scan the QR code, keep the phone on the same Wi-Fi) and a Check again button. Polling stops on that screen and resumes on Check again or when the phone comes back online. After an app restart the session cookie still works, so the page reconnects through the normal error backoff.
- Touch targets are at least 44 px. The page uses a dark theme, honors `prefers-reduced-motion`, and gives haptic feedback where supported. On a desktop keyboard: arrows or PageUp/PageDown change channel, +/- change volume, m mutes, k plays or pauses, j and l seek back 10 s and forward 30 s, digits and Enter select a number, / opens search, Escape closes it.

## Testing

`cargo test -p iptv-core --test remote_control` binds port 0 and checks:

- channel up/down, select, select-id, and volume commands emit `remote.command` on the `BroadcastSink`
- invalid bodies return 400 and emit nothing
- `Origin: http://evil.example`, `null`, wrong port, and `https` return 403
- Hosts `192.168.1.5` and `evil.example` return 403; loopback hosts pass
- the `reportStatus` -> `/status` and `publishChannels` -> `/channels` round trips
- `remote.publishSource` fills `/channels` from an imported playlist, and a new app state on the same data fills it again at start-up
- play/pause and stop emit `togglePlay` and `stop`; seek emits `seekBy {seconds}` and rejects a missing, zero or too large step
- the RPC lifecycle: start, idempotent start, busy port keeps the old server, stop
- all `remote.*` names in `rpc::COMMANDS` are registered

`cargo test -p iptv-core --test remote_lan` never binds a non-loopback address. It serves `router_with_lan(state, port, [192.168.1.5])` on `127.0.0.1:0` and fakes the peer with axum's `MockConnectInfo`, then checks: LAN requests without a session get 401, the pair round trip sets the cookie, single use, revoke and reset, sessions surviving a hub restart, the pair rate limit, an unreadable device list (503, nothing overwritten), the cookie path, rebinding hosts and origins, public peers, loopback unchanged, and `unsupported` in server mode.

Unit tests cover address selection and bind plans (`lan.rs`), code expiry, single use, the rate limiter, user-agent summaries, session add/touch/revoke/evict and QR output (`pairing.rs`), `check_access` including rebinding cases (`server.rs`), and `pair` / `tsr_remote` redaction (`logging.rs`). Older unit tests in `server.rs` and `mod.rs` cover host parsing, origin matching, number and level parsing, and channel sanitizing. Vitest covers the Settings panel (`src/features/settings/test/remoteLan*.test.tsx`), the Live page bridge (`src/features/live/test/remoteBridge.test.tsx`) and the player's command handling (`src/features/player/remote.test.ts`).
