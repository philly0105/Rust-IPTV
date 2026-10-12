# Desktop shell: loopback media proxy and memory trimming

Code: `crates/iptv-tauri/src/proxy.rs` and `crates/iptv-tauri/src/memory.rs`, wired up in `crates/iptv-tauri/src/lib.rs` (`setup` and `on_window_event`). RPC: `app.info` reports `proxyBase`. The rest of the shell (plugins, tray, the `rpc` command, event bridge, deep links, exit cleanup) is in `lib.rs`, and the embedded mpv child window is in `mpv_window.rs` ([players.md](players.md)).

| File | Role |
| --- | --- |
| `proxy.rs` | Loopback HTTP listener that serves `iptv-server`'s `/api/proxy` route inside the app process |
| `memory.rs` | Windows only: WebView2 memory target level and working-set trim |

## Loopback media proxy (`proxy.rs`)

### Why it exists

On desktop the webview fetches streams itself (hls.js, Shaka, mpegts.js, `<video>`). A browser cannot set `User-Agent` or `Referer` on those requests, so per-playlist and per-channel headers (`#EXTVLCOPT`, `url|User-Agent=...`, the source's header fields) would never reach the provider. Many providers refuse a stream without them. The proxy fetches the stream on the app's behalf with those headers added.

### What it serves

`proxy::start` binds `127.0.0.1:0` (a random free port on the IPv4 loopback interface only, never `0.0.0.0`) and serves one route on the Tauri async runtime:

```
GET|HEAD http://127.0.0.1:<port>/<token>/api/proxy?url=<enc>&sourceId=<id>[&ua=&referer=&origin=]
```

This is the same handler as the server's `/api/proxy` ([server.md](server.md)): stored source headers plus the `ua`/`referer`/`origin` overrides, Range pass-through, redirect handling, and HLS playlist rewriting (segment and key URIs point back at the proxy). A path without the token answers 403 (see Guards); under the token, every other path, including `/<token>/api/rpc`, `/<token>/api/events` and `/<token>/api/files`, answers 404. The proxy builds its own `iptv_server::Server` with an empty `RpcRouter`, so nothing but the stream route is reachable. DASH manifests pass through unrewritten; the inline player (`proxyRewrite` in `src/features/player/engines.ts`) resolves their segment, key and BaseURL URIs against the upstream manifest URL and sends them back through the same proxy base (web `/api/proxy` or this token base) with the same `sourceId`/`ua`/`referer`/`origin` params.

`setup` stores the returned base URL (`http://127.0.0.1:<port>/<token>/api/proxy`) in AppState (`DesktopInfo.proxy_base`), and `app.info` returns it as `proxyBase` (`null` in server mode). The UI reads it once at startup (`src/api/transport.ts`). On desktop, `proxiedUrl(source)` routes an `http(s)` URL through `proxyBase` when the source has request headers or when the page is `https:` and the stream is plain `http:` (mixed content); everything else loads directly, and local files go through the asset protocol. If the listener cannot bind, the error is logged, `proxyBase` stays `null`, and header-bearing streams play directly without their headers.

### Guards

Any local program, and any web page open in a browser on the same machine, can reach a loopback port. The proxy therefore checks every request:

- Token: `start` makes a random per-launch token (`new_token`, 160 bits) and serves the route only under `/<token>/api/proxy`, so `proxyBase` is `http://127.0.0.1:<port>/<token>/api/proxy`. `require_token` answers 403 to any other path (no token, a wrong one, a prefix of it), with or without an `Origin`, and rewrites `/api/proxy?` to `/<token>/api/proxy?` in rewritten playlists (`application/vnd.apple.mpegurl`, buffered up to 32 MB) so segment and key requests keep the token. Only `app.info` reveals the token, and it is never logged.
- Host: `iptv_server::guard::api_guard` runs with the default `AllowedHosts`, which accepts only `localhost`, `*.localhost` and IP literals. A DNS-rebinding page, whose requests carry `Host: attacker.example`, gets 403.
- Origin: `webview_origin_only` refuses (403) any request whose `Origin` header is not one of the app's own webview origins (`WEBVIEW_ORIGINS`: `http://tauri.localhost`, `https://tauri.localhost`, `tauri://localhost`, and the Vite dev server on port 5173). Requests without an `Origin` (plain media element loads) pass.
- CORS: `Access-Control-Allow-Origin` is sent only to those same origins, for `GET`/`HEAD` with `Range` and `If-Range`, exposing `Content-Range`, `Content-Length`, `Accept-Ranges` and `Content-Type`. Another page cannot read a proxied response even when its request carries no `Origin`.

The unit test `guards_origin_host_and_sends_cors_only_to_the_webview` covers each rule: a foreign Origin, a non-loopback Host, the webview Origin with CORS headers, and the 404 for `/api/rpc`.

### `allow_private_targets`

The server binary refuses loopback, RFC 1918, link-local and other non-public targets unless the source's own `host:port` or `--allow-private-targets` permits them. The desktop proxy runs with `allow_private_targets: true`, because users play streams from their own LAN (a tvheadend box, a NAS, a local restreamer) exactly as mpv or VLC would. The remaining checks still apply: only `http` and `https` targets, and no credentials in the URL's user-info part. The desktop `AppState` never installs `ServerMode`, so this setting affects only the proxy's own `NetGuard`; the core's downloads and playlist/XMLTV fetches on desktop are unguarded, as before.

Residual risk: before the per-launch token, a local process or a web page that guessed the random port could make the proxy issue a `GET` to a LAN address; now it also needs the token, which only the app's own webview receives. It cannot read the response (no CORS for foreign origins) and cannot reach the RPC surface. That is the trade for playing LAN streams with headers.

## Memory trimming (`memory.rs`, Windows)

Most of the desktop app's memory belongs to WebView2's browser, GPU, renderer and utility processes, not to the Rust process. The shell uses two levers:

- `set_webview_memory_low(window, low)` sets `ICoreWebView2_19::MemoryUsageTargetLevel` (through `webview2-com`, the version wry uses). `on_window_event` sets it to `Low` when the main window is minimized, which asks WebView2 to drop caches and trim its processes, and back to `Normal` on focus. Losing focus alone changes nothing: an unfocused window is often still playing (picture-in-picture, a second monitor), and `Low` there degrades playback and makes the UI fault back in on every alt-tab. If the WebView2 runtime is too old for `ICoreWebView2_19`, the call fails quietly with a debug log.
- `trim_working_set()` calls `SetProcessWorkingSetSize(GetCurrentProcess(), -1, -1)` on the app process 15 s after startup (pages touched only during boot) and again on every minimize. Trimmed pages move to the standby list and fault back in cheaply.

Static Chromium flags that keep the WebView2 process tree small (`--renderer-process-limit=1`, disabled Edge features, no extensions, no background networking) live in `tauri.conf.json` under `additionalBrowserArgs`. Other platforms do nothing here.
