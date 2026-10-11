# Server mode (`crates/iptv-server`)

`iptv-server` runs the same `iptv-core` as the desktop app behind HTTP, so the
React UI works in a browser as a self-hosted PWA. Contract: SPEC C12 and the
HTTP part of C1.

```
iptv-server --port 7180 --data-dir ./data --static ./dist
```

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--port` | `PORT` | 7180 | Listening port |
| `--host` | `IPTV_HOST` | 127.0.0.1 | Interface to bind |
| `--data-dir` | `IPTV_DATA_DIR` | `./data` | Database, logs, downloads |
| `--static` | `IPTV_STATIC_DIR` | `./dist` | Output of `pnpm build` |
| `--allow-private-targets` | `IPTV_ALLOW_PRIVATE_TARGETS` | off | Let `/api/proxy` reach any LAN host |

Logs go to stderr and to the rotating JSON log under `<data-dir>/logs`
(`RUST_LOG` sets the filter). Ctrl-C (and SIGTERM on Unix) starts a graceful
shutdown: event sockets get a close frame, new connections stop, and open
requests get 10 s to finish.

## Layout

| File | Role |
| --- | --- |
| `src/main.rs` | CLI (clap), boot (`logging::init`, `AppState::new` with a `BroadcastSink`, `rpc::init_all`), bind, shutdown |
| `src/lib.rs` | `Server` (shared state), `ServerOptions`, `router()`, request tracing |
| `src/api.rs` | `/api/rpc/{cmd}`, `/api/events`, `/api/health`, API 404 |
| `src/guard.rs` | Origin / Host checks on `/api`, hardening headers |
| `src/proxy/mod.rs` | `/api/proxy` handler, upstream client, redirects, streaming |
| `src/proxy/target.rs` | SSRF rules, guarded DNS resolver |
| `src/proxy/hls.rs` | Streaming HLS playlist rewriter |
| `src/files.rs` | `/api/files/{downloadId}` |
| `src/static_files.rs` | Built UI, SPA fallback, cache headers |
| `tests/server.rs` | End-to-end tests over real sockets |

## Routes

### `POST /api/rpc/{cmd}`
Body is the JSON args; an empty body means `null`. 200 with the JSON result.
Errors return the `RpcError` JSON with the C1 status: NotFound 404, Invalid 400,
Auth 401, Timeout 504, Network 502, Unsupported 501, Conflict 409, else 500.
A body that is not JSON is 400 `invalid`. Limit 256 MiB (backup imports,
pasted playlists). Errors are logged with the command name and message, never
the args.

### `GET /api/events` (WebSocket)
Each text frame is one `AppEvent` JSON (`{"type", "payload"}`) from the
core's broadcast channel (capacity 1024).

- Keepalive: the server pings every 20 s. A client that sends nothing, not
  even a pong, for 60 s is closed (1008).
- Lag policy: each client has its own receiver. A client that falls more than
  1024 events behind keeps its socket and receives
  `{"type":"events.lagged","payload":{"skipped":n}}` so it can refetch. A client
  that cannot take a single frame within 10 s is closed (1013) so it cannot pin
  memory; the UI reconnects with backoff.
- Shutdown sends close 1001.

### `GET /api/health`
`{"ok": true, "version": "<core version>"}`. No guard beyond the Host check;
use it for container and Playwright readiness probes.

### `GET /api/proxy?url=<enc>&sourceId=<id>`
Used by the web UI (`proxiedUrl()` in `src/api/transport.ts`) when a stream
needs source headers or would be mixed content.

1. Validate: `http`/`https` only; no userinfo; `sourceId`, when given, must
   exist (404).
2. Load the source's `RequestHeaders` from `sources.config_json` (m3u and
   stalker carry `headers`; xtream has none) and its own host (m3u `url`,
   xtream `serverUrl`, stalker `portalUrl`).
3. Address policy (below). Refusals are 403 with an `RpcError` body.
4. Fetch with the source's User-Agent / Referer / Origin and the client's
   `Range` / `If-Range` (not for `.m3u8`/`.m3u` paths). Redirects are followed by
   hand, up to 5, and each hop is re-validated. Connect failures and timeouts
   are retried twice with the core's backoff.
5. Upstream 4xx pass through with their status; 5xx become 502. The body is an
   `RpcError` with `details.upstreamStatus`.
6. Media responses stream through `reqwest::bytes_stream` with status (200,
   206, 304), `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`,
   `ETag`, `Last-Modified`, `Cache-Control`, `Expires` preserved. Compression is
   off on the proxy client so lengths and ranges stay byte-exact. HEAD becomes
   an upstream HEAD.
7. HLS playlists are detected by content type (`*mpegurl*`) or, for untyped
   responses (`text/plain`, `application/octet-stream`, none), by sniffing
   `#EXTM3U` in the first bytes. They are rewritten line by line as chunks
   arrive (no whole-body buffering; a single line over 1 MiB aborts): every
   URI line and every `URI="..."` attribute (EXT-X-KEY, EXT-X-MAP,
   EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF, EXT-X-PART, ...) is resolved against
   the final URL and replaced with `/api/proxy?url=<absolute>&sourceId=<id>`.
   `data:` and `skd:` URIs are left alone. The response is 200
   `application/vnd.apple.mpegurl` with `Cache-Control: no-cache`.

Address policy. A target must be a public address unless it is the
requesting source's own host, or the server runs with
`--allow-private-targets`. Loopback, RFC 1918, link-local (including
169.254.169.254), CGNAT, multicast, reserved, ULA, and IPv4-mapped or
NAT64/6to4-embedded private addresses are refused. IP literals are checked
per hop; host names are checked by the proxy client's own DNS resolver at
connect time, so a name cannot pass the check and then rebind to a private
address. Hosts of sources that were used with the proxy are remembered (until
restart) as trusted to resolve privately.

Consequence: an M3U playlist fetched from a public URL whose channels live on
a LAN box will be refused for those channels; run with
`--allow-private-targets` on a trusted network if you need that.

### `GET /api/files/{downloadId}`
Serves a completed download for the web player (`myvideos.playSource` returns
`/api/files/{id}` in server mode). The path is read from the `downloads` table,
never from the request. Not completed: 409. Missing row, missing file, or a
path that is not a regular file (directories and symlinks are refused): 404.
Range, `If-Range`, conditional GET and HEAD are handled by
`tower_http::services::ServeFile`. `Content-Disposition: inline` with an
RFC 5987 filename.

### Everything else: the UI
`ServeDir` over `--static` with precompressed `.br`/`.gz` support.

- `/assets/*-<hash>.*` (Vite output): `Cache-Control: public, max-age=31536000, immutable`.
- `index.html` and other root files (service worker, manifest): `no-cache`.
- A miss on a path whose last segment has no extension and is outside
  `/assets/` returns `index.html` (client-side routes deep-link). Missing
  assets stay 404, so a stale tab never gets HTML for a script.
- If `index.html` is missing, a short 503 page says to run `pnpm build`; the
  API keeps working.
- Only GET and HEAD; other methods 405.

## Security

Server mode has no login. Defaults keep it local:

- Binds 127.0.0.1. While bound to loopback, `/api` requires a loopback `Host`
  (`localhost`, `*.localhost`, `127.x`, `[::1]`), which defeats DNS rebinding.
- State-changing `/api` requests and WebSocket upgrades are refused (403) when
  `Origin` names another host or `Sec-Fetch-Site` is `cross-site`. This blocks
  CSRF through `text/plain` form posts and cross-site WebSocket hijacking.
  `X-Forwarded-Host` is accepted as an alternative match for reverse proxies.
- No CORS headers are sent: same-origin only.
- Request tracing logs method and path only; proxy query strings (which carry
  stream URLs with credentials) are never logged. `X-Content-Type-Options:
  nosniff` and `X-Frame-Options: SAMEORIGIN` on every response.

Binding beyond loopback (`--host 0.0.0.0`, the Docker default) logs a warning.
Publish the port on loopback or put an authenticating reverse proxy in front.

## Docker

`Dockerfile` at the repo root: node 22 builds `dist/` with `pnpm build`, rust
1.96 builds `iptv-server` in release, and a `debian:bookworm-slim` runtime
runs it as uid 10001 under `tini`, with `VOLUME /data` and `EXPOSE 7180`.

```
docker build -t tsrust-iptv .
docker run --rm -p 127.0.0.1:7180:7180 -v tsrust-iptv-data:/data tsrust-iptv
```

A `.dockerignore` excluding `target/`, `node_modules/`, `dist/` and data dirs
keeps the build context small.

## Tests

`cargo test -p iptv-server` runs unit tests (rewriter, address rules, guards,
cache rules) and `tests/server.rs`, which starts the router on a free port
with a temp data dir and an in-test axum upstream:

- health and `app.info` RPC, error status mapping
- SPA fallback and cache headers, asset 404, 405
- playlist rewrite with header injection, follow-up segment fetch, sniffing,
  redirects (relative URIs resolve against the final URL)
- the mock's Xtream HLS playlist via `iptv_fixtures::spawn_mock()` (skips with a
  note while the mock route is missing)
- Range passthrough (206, `Content-Range`, length), HEAD
- refusal of private, metadata, loopback, credentialed, non-HTTP targets and of
  redirects into private space; `--allow-private-targets`
- `/api/files` Range and the 409/404/400 cases
- Origin/Host guards; the event socket's broadcast, origin check, and close on
  shutdown
