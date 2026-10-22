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
| `--allow-private-targets` | `IPTV_ALLOW_PRIVATE_TARGETS` | off | Let the proxy, downloads and playlist/EPG/Xtream/Stalker fetches reach any LAN host (env accepts `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`) |
| `--allowed-hosts` | `IPTV_ALLOWED_HOSTS` | empty | Extra `Host` names accepted on `/api` (comma list; `*` turns the check off) |
| `--health` | | | Probe `/api/health` on `--port` and exit 0 when healthy (Docker HEALTHCHECK) |

Logs go to stderr and to the rotating JSON log under `<data-dir>/logs`
(`RUST_LOG` sets the filter). Ctrl-C (and SIGTERM on Unix) starts a graceful
shutdown: event sockets get a close frame, new connections stop, and open
requests get 10 s to finish. Then running recordings are closed
(`recording::shutdown`) and `db::note_clean_shutdown` removes the
database's running marker, so the next start can skip the background check
of a large database (SPEC C3).

## Layout

| File | Role |
| --- | --- |
| `src/main.rs` | CLI (clap), boot (`logging::init`, `AppState::new` with a `BroadcastSink`, `rpc::init_all`), bind, shutdown |
| `src/lib.rs` | `Server` (shared state), `ServerOptions`, `router()`, request tracing, response compression (`compression()`) |
| `src/api.rs` | `/api/rpc/{cmd}`, `/api/events`, `/api/health`, API 404 |
| `src/guard.rs` | Origin / Host checks on `/api`, hardening headers |
| `src/proxy/mod.rs` | `/api/proxy` handler, upstream client, redirects, streaming |
| `src/proxy/readahead.rs` | Read-ahead and resume for media bodies of known length |
| `src/proxy/target.rs` | SSRF rules, guarded DNS resolver |
| `src/proxy/hls.rs` | Streaming HLS playlist rewriter |
| `src/files.rs` | `/api/files/{downloadId}` |
| `src/recordings.rs` | `/api/recordings/{id}` (recording slice) |
| `src/static_files.rs` | Built UI, SPA fallback, cache headers |
| `tests/server.rs` | End-to-end tests over real sockets |
| `tests/l2_import_detached.rs` | A `sources.add` whose client goes away still finishes |
| `tests/l2_cross_cancel.rs` | Which commands stop when the client goes away (`CANCEL_ON_DISCONNECT`); every write runs detached |
| `tests/l3_serve_compression.rs` | Which replies are compressed; precompressed files win; Range and images stay plain |

## Routes

### `POST /api/rpc/{cmd}`
Body is the JSON args; an empty body means `null`. 200 with the JSON result.
Errors return the `RpcError` JSON with the C1 status: NotFound 404, Invalid 400,
Auth 401, Timeout 504, Network 502, Server 502, EngineMissing 503, Unsupported 501,
Conflict 409, and Io, Db or Internal 500 (`RpcErrorCode::http_status` in error.rs).
A body that is not JSON is 400 `invalid`. Limit 256 MiB (backup imports,
pasted playlists). Errors are logged with the command name and message, never
the args.

Each call runs on its own task (`api::dispatch_detached`: `tokio::spawn`,
then the handler awaits the `JoinHandle`). Axum drops a handler's future when
the client goes away (a reload, Back, a closed tab), and a call awaited
inline would stop at its next await point: `sources.add` or `sources.refresh`
left a source with no catalog, no `lastError` and no final progress event.
On its own task the call finishes and emits its events whatever the client
does, as on the desktop. A task that panics or is cancelled is a 500
`internal` ("the request failed inside the server"). The server-mode
refusals (see Security) and the JSON check run before the task starts.

The exceptions are the read-only queries the UI supersedes and aborts while the
user scrolls or types, listed in `api::CANCEL_ON_DISCONNECT`: `epg.grid`,
`epg.programs`, `epg.search`, `epg.nowNext`, `epg.channelsSearch`,
`catalog.search`, `catalog.channels`, `catalog.movies`, `catalog.series`,
`catalog.categories` and `catalog.yearFacets`. They run inline under
`iptv_core::state::cancel_on_drop`. When the client goes away, axum drops the
call, and `AppState::db_call` interrupts its SQLite statement (or skips it
while it still waits for a pooled connection) instead of running it for
nobody. Writes are never on the list, because an interrupted write rolls
back; they finish as above. The desktop app does not use this path.
`crates/iptv-core/tests/l2_cross_core.rs` covers the interrupt.

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

The web UI (`startWeb` in `src/api/events.ts`) keeps one socket per page while
anything is subscribed:

- Reconnect backoff: 500 ms doubling, plus up to 30 % jitter, at most 4 s
  between attempts. An open resets it.
- A waiting socket skips the rest of its wait and connects at once (backoff
  reset) on window `focus`, `online`, the page becoming visible, or an RPC the
  server answered. The transport reports an answer through
  `notifyServerAnswered` (`src/api/reachability.ts`) on a success or on one of
  the core's own error payloads, not on a proxy's 502.
- While the wait before the next attempt is longer than 1 s
  (`HEALTH_POLL_MS`), the page asks `GET /api/health` every second, and an
  ok answer connects at once, so a restarted server is noticed within about a
  second without any other nudge.
- Any open that follows a closed socket or a failed attempt dispatches a local
  `events.lagged`, so every cached query is refetched: events sent while the
  socket was down are lost, and RPCs made while the server was unreachable
  failed. This includes the first successful open of a page whose first
  attempt failed (a page opened during a server restart). The refetch goes
  through the 50 ms event burst (performance.md).

### `GET /api/health`
`{"ok": true, "version": "<core version>"}`. No guard beyond the Host check;
use it for container and Playwright readiness probes.

### `GET /api/proxy?url=<enc>&sourceId=<id>[&ua=&referer=&origin=&from=&release=]`
Used by the web UI (`proxiedUrl()` in `src/api/transport.ts`) when a stream
needs source headers or would be mixed content.

1. Validate: `http`/`https` only; no userinfo; `sourceId`, when given, must
   exist (404).
2. Load the source's `RequestHeaders` from `sources.config_json` (m3u and
   stalker carry `headers`; xtream has none) and its own host (m3u `url`,
   xtream `serverUrl`, stalker `portalUrl`).
3. Address policy (below). Refusals are 403 with an `RpcError` body.
4. Fetch with the source's User-Agent / Referer / Origin (non-empty `ua`,
   `referer` and `origin` query parameters override them, for per-channel
   `#EXTVLCOPT` headers; an override that is not a valid header value, such
   as one with CR/LF, is a 400) and the client's
   `Range` / `If-Range` (not for `.m3u8`/`.m3u` paths). With `from=<byte>`
   the body starts at that byte: no Range asks for `bytes=<from>-`, and the
   client's `bytes=a-b` moves up by `from` (`files::shifted_range`), so the
   built-in player can restart an MPEG-TS file mid-way and mpegts.js's later
   Range requests still line up (players.md, Seeking in MPEG-TS). An upstream
   that answers such a GET with 200, the whole file, is refused with 502
   instead of being played from its start. Redirects are followed by
   hand, up to 5, and each hop is re-validated. Connect failures and timeouts
   are retried twice with the core's backoff. Response headers must arrive
   within 15 s.
5. Upstream 4xx pass through with their status; 5xx become 502. The body is an
   `RpcError` with `details.upstreamStatus`.
6. Media responses stream through `reqwest::bytes_stream` with status (200,
   206, 304), `Content-Length`, `Content-Range`, `Accept-Ranges`,
   `ETag`, `Last-Modified`, `Cache-Control`, `Expires` preserved. Compression is
   off on the proxy client so lengths and ranges stay byte-exact. HEAD becomes
   an upstream HEAD. `Content-Type` passes only for media (`video/*`,
   `audio/*`, `image/*`, HLS/DASH manifests, `application/octet-stream`,
   `application/x-mpegts`); anything else, such as HTML or JSON, is sent as
   `application/octet-stream` with `Content-Disposition: attachment`. Every proxy response, errors
   included, carries `Content-Security-Policy: sandbox; default-src 'none'`
   and `nosniff`, so upstream content never runs as a page on the app's
   origin.
   A 200 or 206 body with a `Content-Length` (a movie, an episode, an HLS
   segment) goes through a reader task (`src/proxy/readahead.rs`) that keeps
   up to 32 MiB ahead of the player, so the provider's connection keeps
   flowing while `<video>` pauses its own reads (it buffers about ten seconds
   of a progressive file). When that connection drops before the body is
   complete, the server takes byte ranges (206, or `Accept-Ranges: bytes`)
   and its answer carried a strong ETag or a Last-Modified date, the reader
   asks for the rest (`Range: bytes=<offset>-<end>`, with that validator as
   `If-Range`, redirects followed again from the requested URL), checks the
   206 `Content-Range`, and carries on in the same response; three failed
   tries in a row end it. The player never sees the drop, and the log notes
   each resume with the host. Without a validator the reader cannot tell the
   same file from a replacement of the same length, so it does not resume
   and the drop reaches the player. The reader stops as soon
   as the client lets go of the response, which frees the provider's
   connection. Bodies without a length (live MPEG-TS) pass through as they
   come.
   The exception is a GET for MPEG-TS (`video/mp2t`, `application/x-mpegts`,
   or an untyped `.ts` path) of 16 MiB or more (`src/proxy/park.rs`):
   mpegts.js loads catch-up and TS movies lazily, lets go of the request once
   it holds 60 s ahead and asks for the rest (`Range: bytes=<n>-`) after
   30 s of playback, which used to close the provider's connection and open
   a new one about twice a minute, and a panel that ignores Range answered
   the resume from byte 0. When such a client lets go before the end, its
   reader parks for 45 s: it keeps the connection and what it read from at
   least 16 MiB behind what the client took (the socket and the browser
   still hold some of that), and reads on until it holds 48 MiB. A GET for
   the same URL, source and header overrides whose `bytes=<n>-` (after
   `from`) starts at a byte it holds is answered 206 from it, with no new
   upstream request. Any other request with the same `sourceId` (or for the
   same host, without one) lets the parked reader go, and waits (at most
   0.5 s) until the reader has dropped its upstream body before it asks
   upstream itself, so a seek or the next item doesn't run two connections.
   A body whose source had a later request never parks: a seek's request can
   reach the proxy before it notices the old player went away, and that
   request is the player now. A newer park on that source, the time running
   out, and `release=1` let the reader go too; the built-in player sends that
   when it tears an MPEG-TS player down (a stop, another item, Open in MPV):
   it fetches nothing, answers 204, and keeps a reader of that source from
   parking for the next 5 s, since it can land before the proxy noticed the
   player let go. At most 4 readers are parked at once.
7. HLS playlists are detected by content type (`*mpegurl*`) or, for untyped
   responses (`text/plain`, `application/octet-stream`, none), by sniffing
   `#EXTM3U` in the first bytes. They are rewritten line by line as chunks
   arrive (no whole-body buffering; a single line over 1 MiB aborts): every
   URI line and every `URI="..."` attribute (EXT-X-KEY, EXT-X-MAP,
   EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF, EXT-X-PART, ...) is resolved against
   the final URL and replaced with `/api/proxy?url=<absolute>&sourceId=<id>`
   (plus any `ua`/`referer`/`origin` overrides). The path comes from
   `ServerOptions::proxy_path`: `/api/proxy` here, `/<token>/api/proxy` on
   the desktop loopback proxy.
   `data:` and `skd:` URIs are left alone. The response is 200
   `application/vnd.apple.mpegurl` (always; the upstream type is never
   echoed) with `Cache-Control: no-cache`.

Address policy. A target must be a public address unless it is the
requesting source's own `host:port` (another port on the same LAN host is
refused), or the server runs with `--allow-private-targets`. The refusal
message names that flag. Loopback, RFC 1918, link-local (including
169.254.169.254), CGNAT, multicast, reserved, ULA, and IPv4-mapped or
NAT64/6to4-embedded private addresses are refused. IP literals are checked
per hop; host names are checked by the proxy client's own DNS resolver at
connect time, so a name cannot pass the check and then rebind to a private
address. A resolver sees host names without ports, so the client whose
resolver trusts the requesting source's own host is used only for a URL or
redirect hop on exactly the source's `host:port`; every other hop, the same
host name on another port included, goes through the client that trusts
nothing, which drops private addresses when it connects. Trust is per
request (nothing is remembered), so using one source never opens its host
to requests without a source, to another source, or to a redirect from
another source.

The same guard lives in `iptv_core::http` (`NetGuard`, `ServerMode`), and
`iptv-server` installs it on the core at startup: in server mode downloads,
M3U URL imports, XMLTV downloads and Xtream/Stalker API calls use a guarded
client too, each trusting only its own source's `host:port` (a guide URL is
trusted when any source listing it sits on its `host:port`). A fetch of a URL
that may be elsewhere (a download, a recording, a logo) gets the
source-trusting client only when the URL is on the source's exact
`host:port`. Its redirect policy applies the port rule above: a redirect to
another port of a trusted host name that resolves privately is refused, and
one that is followed first ends that name's trust in the client's resolver,
so the hop (and every later connection of that client) reaches only public
addresses whatever the name resolves to by then. No client sends `Referer`, so redirects never
carry Xtream credentials. Local EPG paths and `file://` guide URLs are
refused (501). The desktop app does not install it and
may fetch from the LAN freely. Its loopback media proxy reuses this route with
private targets allowed; see [desktop.md](desktop.md).

Consequence: an M3U playlist fetched from a public URL whose channels live on
a LAN box will be refused for those channels; run with
`--allow-private-targets` on a trusted network if you need that.

### `GET /api/files/{downloadId}`
Serves a completed download for the web player (`myvideos.playSource` returns
`/api/files/{id}` in server mode). The path is read from the `downloads` table,
never from the request. Not completed: 409. Missing row, missing file, or a
path that is not a regular file (directories and symlinks are refused): 404.
Range, `If-Range`, conditional GET and HEAD are handled by
`tower_http::services::ServeFile`. `?from=<byte>` serves the file as if it
began at that byte (`files::byte_start`): the request's Range is moved up by it
before `ServeFile` reads it, and a request without one gets `bytes=<from>-`
(206). The built-in player seeks in MPEG-TS downloads and recordings that way.
`Content-Disposition: inline` (video,
audio and image types) or `attachment` (anything else) with an RFC 5987
filename, plus the sandbox CSP and `nosniff`. Downloads whose extension is not
a media/subtitle type are saved as `.bin`.

### `GET /api/recordings/{id}`
Serves a recording file for the web player (`recordings.playSource` returns
`/api/recordings/{id}` in server mode). `id` is a `recordings.library` entry id;
the core resolves it to a path inside the recordings folder, never taking a
path from the request. Unknown id or missing file: 404. Range handling,
`?from=<byte>` and headers as for `/api/files`.

### Everything else: the UI
`ServeDir` over `--static` (`precompressed_br`, `precompressed_gzip`). When
the client accepts it and a file has a `.br` or `.gz` copy beside it (a web
`pnpm build` writes them; see performance.md), that copy is sent as it is,
with its `Content-Encoding`.

- `/assets/*-<hash>.*` (Vite output): `Cache-Control: public, max-age=31536000, immutable`.
- `index.html` and other root files (service worker, manifest): `no-cache`.
- A miss on a path whose last segment has no extension and is outside
  `/assets/` returns `index.html` (client-side routes deep-link). Missing
  assets stay 404, so a stale tab never gets HTML for a script. This
  fallback (`serve_index`) serves `index.html` with `precompressed_br` and
  `precompressed_gzip` too, so a deep link gets the build's
  `index.html.br` or `.gz` like `/`.
- If `index.html` is missing, a short 503 page says to run `pnpm build`; the
  API keeps working.
- Only GET and HEAD; other methods 405.
- PWA: `public/manifest.webmanifest` (icons in `public/icons/`) and
  `public/sw.js` are copied into `dist/`. The service worker is registered
  only in the web build (never in Tauri). It serves `/assets/*` cache-first,
  page navigations network-first with the cached shell as the offline
  fallback, and never touches `/api/*`. `pnpm build` writes the build's
  `/assets/*` URLs into `dist/sw.js` (the `serviceWorkerAssets` plugin in
  `vite.config.ts` fills its `ASSETS` placeholder), so the worker's bytes
  change with every build and the browser installs the new one. Its
  activate handler then deletes cached `/assets/*` entries that are not in
  the list; before, each deploy's chunks piled up in the one cache
  (performance audit SH-11). A tab still running the old build can no
  longer load an old lazy chunk from the cache after that, which the server
  no longer has either.

### Compression
`compression()` in `src/lib.rs` (tower-http `CompressionLayer`) wraps only
`POST /api/rpc/{cmd}` and the UI fallback. It sends brotli or gzip at level
4 (`COMPRESS_LEVEL`), as the client's `Accept-Encoding` allows, for bodies of
at least 1 KiB (`COMPRESS_MIN_BYTES`), and adds `Vary: Accept-Encoding`. It
leaves alone images other than SVG, `text/event-stream`, fonts (`font/*`,
`application/font-woff`), and replies that already carry `Content-Encoding`
(the precompressed UI files) or `Content-Range` (a Range request).
`/api/events`, `/api/proxy`, `/api/img`, `/api/files` and `/api/recordings`
are outside the layer: they are streams, byte ranges or media that is
already compressed. The desktop loopback proxy does not use it.

## Security

Server mode has no login. Defaults keep it local:

- Binds 127.0.0.1.
- `/api` requires an allowed `Host` whatever the bind address, which defeats
  DNS rebinding: `localhost`, `*.localhost` and any IP literal always work;
  other names must be listed in `--allowed-hosts` / `IPTV_ALLOWED_HOSTS`
  (e.g. `tv.example.com` behind a reverse proxy). On a non-loopback bind the
  machine's host name (and its `.local` form) is added. Anything else gets 403.
- Server mode cannot be made to read or write paths on the server: adding or
  updating an M3U source with `origin: file` or a `file://` URL, changing the
  downloads folder (`downloads.setDir`, `settings.update` `downloadsDir`) are
  refused with `unsupported` (501). The downloads folder is
  `<IPTV_DATA_DIR>/downloads`. A backup's `filePathHint` is ignored and the
  embedded playlist text is imported instead.
- The SPA is served with a site CSP (`default-src 'self'`, `script-src
  'self'`, media/images/connect to any http(s) origin and `blob:`, YouTube
  nocookie frames for trailers, `object-src 'none'`, `frame-ancestors 'self'`)
  and `Referrer-Policy: same-origin`.
- State-changing `/api` requests and WebSocket upgrades are refused (403) when
  `Origin` is not the request's own origin or `Sec-Fetch-Site` is
  `cross-site`. This blocks CSRF through `text/plain` form posts and
  cross-site WebSocket hijacking. The Origin must match the request's scheme,
  host and port. The scheme is `X-Forwarded-Proto` from a reverse proxy, else
  `http` (what the server speaks), and a `Host` without a port means that
  scheme's default port, never the port the Origin names. A proxy that serves
  HTTPS must therefore send `X-Forwarded-Proto` (Caddy, Traefik and Tailscale
  Serve do; nginx needs `proxy_set_header X-Forwarded-Proto $scheme`).
  `X-Forwarded-Host` is accepted as an alternative match for reverse proxies.
- No CORS headers are sent: same-origin only.
- Request tracing logs method and path only; proxy query strings (which carry
  stream URLs with credentials) are never logged. `X-Content-Type-Options:
  nosniff` and `X-Frame-Options: SAMEORIGIN` on every response.

Binding beyond loopback (`--host 0.0.0.0`, the Docker default) logs a warning.
Publish the port on loopback or put an authenticating reverse proxy in front.

## Docker

`Dockerfile` at the repo root: node 24 builds `dist/` with `pnpm build`, rust
1.96 builds `iptv-server` in release, and a `debian:bookworm-slim` runtime
runs it as uid 10001 under `tini`, with `VOLUME /data`, `EXPOSE 7180` and a
`HEALTHCHECK` that runs `iptv-server --health`. Set `IPTV_ALLOWED_HOSTS` when
the app is reached under a host name other than localhost or an IP address.
The runtime stage also installs Debian's `mpv` package (found on `PATH`), so
scheduled and series recordings work in the container; recordings go to
`/data/downloads/recordings`. Server mode does not run that mpv: it records
plain HTTP streams (and Xtream live channels) with its guarded HTTP copy and
refuses HLS, DASH and other streams, but `recordings.capabilities` still
requires mpv. It makes the image larger; an image built without it hides
Record (see recording.md). The remote control server listens on the
container's own 127.0.0.1 only, and server mode has no LAN pairing, so the
remote page cannot be reached from outside the container; publishing its
port does not change that (remote-control.md).

```
docker build -t tsrust-iptv .
docker run --rm -p 127.0.0.1:7180:7180 -v tsrust-iptv-data:/data tsrust-iptv
```

A `.dockerignore` excluding `**/target/`, `node_modules/`, `dist/` and data
dirs (`.*-data/`) keeps the build context small.

The runtime stage carries OCI labels (title, description, source, and
`org.opencontainers.image.version` from the `VERSION` build arg; no licence
label until the project licence is chosen). `NOTICE` (IPTVnator's copyright
and MIT licence) is always copied to `/usr/share/doc/tsrust-iptv/`, and so is
`THIRD_PARTY_NOTICES.md` (written by `tools/third-party-notices.mjs`) when the
build context holds it.

Released images are on `ghcr.io/philly0105/tsrust-iptv` for linux/amd64 and
linux/arm64. The version tag is pushed when the release is built
(`.github/workflows/release.yml`); `latest` moves to it only when the owner
publishes the draft release (`.github/workflows/image-latest.yml`). CI builds
the image and checks
`/api/health` on pull requests without pushing (`ci.yml`, job `docker`).

### Deployment for other devices

[`deploy/`](../../deploy/README.md) runs the image behind Caddy with Compose:
Caddy terminates TLS (`tls internal` for a LAN name or IP address, or a Let's
Encrypt certificate for a public domain), asks for a password with
`basic_auth`, and proxies to the app, which publishes no port of its own.
Compose sets `IPTV_ALLOWED_HOSTS` to the same host name Caddy serves, and
Caddy passes the `Host` header through unchanged and adds
`X-Forwarded-Proto: https`, so the guard above accepts both. `/manifest.webmanifest` and `/icons/*` stay outside the password because
browsers fetch the manifest without credentials.

### HTTPS and secure context

HTTPS matters for more than the password. A page on plain
`http://<lan-ip>:7180` is not a secure context, so the browser turns off the
service worker and PWA install, `navigator.clipboard` (the copy buttons) and
EME (ClearKey channels). `localhost` is a secure context, so none of this
applies on the server machine itself. On a page that is not a secure context
the app says so once per browser, in a toast that links to this section
(`src/shell/SecureContextNotice.tsx`, localStorage
`tsrust.insecureNoticeShown`). `Notification` is secure-context only too, but
the UI never calls `Notification.requestPermission`: a guide reminder is an
in-app toast, plus a browser notification only where the user already allowed
notifications for the site (`src/features/recording/lib/fire.ts`).

Safari has been reported to send no credentials on WebSocket upgrades behind
HTTP basic authentication, which would make `/api/events` fail with 401 there. This is untested with this setup;
`deploy/README.md` says what users see and points to `forward_auth` with a
cookie login. Exempting `/api/events` from the password is not a fix: a
non-browser client can send any `Origin`, so the event stream would be open to
anyone who can reach Caddy.

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
- sandbox CSP and attachment for non-media proxy and file responses, the site
  CSP on the SPA; a rebinding `Host` refused on a 0.0.0.0 bind
- `ua`/`referer`/`origin` overrides, carried into rewritten playlists
- server-mode downloads refused for loopback outside the source's own
  `host:port` (allowed on desktop); refusal of file origins, downloads folder
  changes and backup file paths
