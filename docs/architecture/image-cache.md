# Image cache

Code: `crates/iptv-core/src/imagecache/` (core: `mod.rs` request flow, `fetch.rs` upstream fetch and type checks, `store.rs` index writer, eviction and reconcile, `resize.rs` width variants, `rpc.rs` commands) and `crates/iptv-server/src/img.rs` (the HTTP route). Tests: `crates/iptv-core/tests/image_cache.rs`, `l2_import_img.rs` (posters answered while the write lock is held), `l3_serve_image_variants.rs` (width variants), the `img_*` cases in `crates/iptv-server/tests/server.rs`, `image_route_caches_behind_the_token_and_exposes_the_cache_header` and `cross_site_webview_requests_are_served_but_server_mode_refuses_them` in `crates/iptv-tauri/src/proxy.rs`, and unit tests in each core file.

Posters, channel logos and backdrops are cached on disk, so a poster wall that was seen once loads from the device on the next visit and offline (Run 3 contract C2). The UI sends every http(s) image through `<base>/img?url=<absolute url>&sourceId=<id?>&w=<px?>` (C3, `src/api/images.ts`); `w` asks for a smaller copy ([Width hints](#width-hints)). The first request fetches the image upstream; later requests read it from disk. The cache has a size cap from `settings.imageCacheMaxMb` (default 500, 50 to 5000) and drops the least recently used images when it goes over.

## Storage

Files live under `data_dir/image-cache/<first 2 hex>/<key>`, where the key is the lowercase hex SHA-256 of the normalised URL. The bytes are stored exactly as received; only a width variant holds a resized copy, under its own key. A download is written to `<key>.<random>.tmp` in the shard folder and renamed into place, so a reader never sees half a file.

Migration `0017_image_cache.sql` creates the index:

| Column | Notes |
| --- | --- |
| `key` | Primary key, the file name. |
| `url` | The normalised URL (absolute http(s), no user info, no fragment, at most 8 KiB). A width variant's row records `<url>#w=<bucket>`. |
| `content_type` | The stored type, `image/*` only. It is served as `Content-Type`. |
| `bytes` | File size. A row whose file is missing or has another size counts as a miss. |
| `created_at`, `last_access` | Unix seconds. `last_access` orders eviction (`idx_image_cache_lru`). |

A data dir that ran the empty Run 3 placeholder of migration 0017 has no table. The first use of the cache creates it from the same SQL (`CREATE TABLE IF NOT EXISTS`).

### Writer

Every index write goes through one writer task (`store::run`). It takes inserts, `last_access` touches, row removals, eviction and Clear from a channel and applies up to 256 of them in one IMMEDIATE transaction. Fifty posters that load during a catalog import therefore wait on the write lock as one connection, not fifty. The writer owns the running byte total, which starts from `SUM(bytes)`.

No request waits for the writer. A fetch that has stored its file adds a pending entry for the key (`PendingRows`: the flight, the content type and the size), queues the insert and answers at once, so a catalog import holding the write lock for its whole save does not hold up posters. Until the batch holding that insert is done, lookups serve the file from the pending entry when it is on disk with the recorded size, and the writer keeps the file from eviction and Clear. Once the batch is done, committed or not, the writer drops the entry; after a failed batch the file is an orphan that the next fetch or the reconcile replaces.

The running total counts only this process's writes. Two processes can share a data dir: the desktop app and an `iptv-server --data-dir` pointed at it, or two servers. Each then adds rows the other's total does not see. So the writer re-reads `SUM(bytes)` inside its transaction on every `images.stats` and, while inserting, at least once a minute (`RESYNC_INTERVAL`). Together the processes go over the cap by at most what they insert between two resyncs, not by a whole cap each. An `images.stats` under the cap reads the sum without taking the write lock.

### LRU

After an insert takes the total over the cap, the writer deletes rows and files in `last_access`, `created_at`, `key` order until the total is at most 90 % of the cap (`EVICT_TARGET_PERCENT`). Eviction starts from `SUM(bytes)` read in its transaction, so it sees every process's rows. A lowered cap takes effect on the next insert or the next `images.stats`. A hit moves `last_access` forward at most once a minute per key (`TOUCH_INTERVAL_SECS`), so scrolling a cached wall does not write the database on every image.

Eviction and Clear keep the file of a key whose fetch is still running, because that fetch may already have renamed a fresh copy into place, and the file of a key whose row is still pending. Without a row, such a file is overwritten by the next fetch or removed by a reconcile.

### Reconcile

`imagecache::init` (run at core startup) loads the total and starts a background pass over the folder:

- a row whose file is missing or has the wrong size is removed;
- a file without a row, a file whose size does not match its row, and a leftover `.tmp` file are deleted once they are 10 minutes old (younger ones may belong to a fetch in progress);
- a file without a row that is over the 10 MB limit is deleted at once.

## Request flow

`imagecache::fetch(state, url, source_id)` returns a `CachedImage { path, content_type, bytes, hit }` or an `ImageError` with a kind. `imagecache::get` is the same with the error mapped onto `CoreError`.

1. The URL is parsed and normalised. Anything that is not an absolute http(s) URL is `BadUrl`.
2. The source, when `sourceId` names one, contributes its request headers (`config_json.headers`: User-Agent, Referer and the others a provider may need) and, in server mode, its own `host:port` as trusted by the SSRF guard. An unknown `sourceId` adds nothing; the image still loads without it.
3. In server mode the guard checks the URL before the cache is read. This check does not resolve names: it refuses private and loopback IP literals and `localhost` names, and those stay refused even when the cache already holds the image. A host name that resolves to a private address is refused when it is fetched (see [Server mode and trust](#server-mode-and-trust)).
4. A pending entry or a row whose file is on disk with the recorded size is a hit.
5. Otherwise the request joins or starts the single fetch for that key and scope (`flight_scope`). The scope holds the source's trusted `host:port` while the guard is active, and a hash of the source's request headers as they are sent (trimmed, blank ones dropped). An image host that wants the provider's User-Agent or Referer refuses a request without them. A request without the source therefore never joins the source's fetch or inherits its refusal, and the reverse holds too. The stored file is keyed by URL (and width bucket) alone, so once one request has stored the image, every request for it hits it. The fetch runs as its own task, so a client that disconnects does not cancel it for the others. Concurrent requests share its result and all report `miss`. A request that joins a fetch that has already answered reports `hit`, as does a fetch that found the image already stored by an earlier one.
6. The fetch sends an image `Accept` header with a 15 s limit for the response head, a 20 s idle limit between body chunks and a 60 s limit overall.
7. The response is checked. 404 and 410 become `NotFound`; any other non-2xx status or transport error becomes `Upstream`. An `image/*` type is accepted, unless the body is really HTML. A generic type (`application/octet-stream`, `binary/octet-stream`, `text/plain` and similar) or a missing one is sniffed (PNG, JPEG, GIF, WebP, AVIF, ICO, BMP, SVG) and stored as the type found. Anything else is `NotImage`. A body over 10 MB (`MAX_IMAGE_BYTES`) is `TooLarge`, and an empty body is `Upstream`.
8. The file is written and renamed, a pending entry is added, and the insert is queued for the writer. The answer goes out without waiting for the row (see [Writer](#writer)), and the fetch ends. A request that follows before the row commits finds the pending entry and is a hit, so a busy database (a catalog import, say) never makes a poster wait or fetch twice.

A failed fetch is remembered for 10 minutes (`FAILURE_TTL`, at most 4096 entries) per key and scope, so a broken poster wall does not refetch on every scroll. A local disk or database error is not remembered. `images.clear` forgets every failure.

## Width hints

`w` is the width a picture is drawn at, in device pixels (CSS width times `devicePixelRatio`). The route takes it when it is a positive whole number (`ImgQuery::width`), and `imagecache::fetch_sized` rounds it up to the next of `resize::WIDTH_BUCKETS`: 64, 96, 128, 192, 256, 384, 512, 768 or 1024. Without `w`, or with 0, a non-number or anything above 1024, the route serves the original.

A variant is stored under `variant_key`, the SHA-256 of `<normalised url>#w=<bucket>`, with its own row, so it counts against the cap and is evicted like any other file. The normalised URL never has a fragment, so the key cannot collide with another image's. The variant has its own flight and failure memory (its key and scope); the guard check is the same.

- When the original is cached (a row or a pending entry), the variant is made from that file with no upstream request, and the reply reports `hit`.
- Otherwise the image is fetched once and only the resized copy is stored.
- Only still JPEG and PNG wider than the bucket are resized (wider as shown, after the EXIF orientation). The copy is the bucket's width with the aspect ratio kept (Catmull-Rom). JPEG is encoded at quality 82 (`JPEG_QUALITY`); PNG stays PNG and keeps its alpha channel. The orientation is applied and the ICC profile carried over. Sources over 8192 px on a side, or needing more than 192 MiB to decode, are not decoded. Decode, resize and encode run on `spawn_blocking`.
- Everything else is served as stored: SVG, GIF, WebP, AVIF, ICO, BMP, animated PNG, images no wider than the bucket, files that do not decode, and copies that would not be smaller. The answer is then the original (fetched and stored under its own key when it was not cached), and the variant key is remembered in memory (`kept`, at most 65,536 keys, emptied by `images.clear`), so later requests at that width read the original without decoding it again. The memory does not survive a restart.

In the UI, `imageUrl(src, sourceId, width)` and the helpers built on it (`imageAttempts`, `imageCandidates`, `preloadImage`, and `useImageChain` in `src/ui/image.ts`) take the CSS width and add `w`, rounded up on the client to the same buckets (`IMAGE_WIDTH_BUCKETS`, `imageWidthBucket`). A card then keeps one URL, and one browser-cache entry, across small layout changes; a picture wider than 1024 device px gets no `w`. Callers:

- `Poster` measures its frame when the `<img>` mounts and adds `w` from its `clientWidth` (`sizedImageUrl`). `priority` posters (the movie, series and My Videos detail pages) load the original.
- `ChannelLogo` passes its `size` (36 by default: 64 at 1x, 96 at 2x), and the fullscreen channel panel passes 32.
- No `w`: backdrops and heroes (`DetailHero`, `HeroCarousel`), cast photos, player artwork, the zap banner, channel history, multiview marks and the hover prefetch (`preloadImage` in `src/features/vod/hooks/prefetch.ts`, which warms the detail page's original).

The desktop loopback proxy mounts the same handler, so `w` works there too.

## Commands (C2)

| Command | Behaviour |
| --- | --- |
| `images.stats` | `{bytes, files, maxBytes}`. Evicts down to the cap first, so it also applies a lowered `imageCacheMaxMb`. |
| `images.clear` | Deletes every file and row, forgets failures, and returns the empty stats. |

## HTTP route

`iptv_server::img::handler` serves `GET <base>/img?url=<absolute http(s) url>&sourceId=<id?>&w=<px?>`. The first value of each parameter wins (`w` trimmed), a blank `sourceId` counts as absent, and any other parameter is ignored (see [Browser copies after Clear](#browser-copies-after-clear)).

- Server mode mounts it at `/api/img`, before the `/{*rest}` catch-all, outside the response compression layer (server.md): images go out as stored.
- The desktop loopback proxy mounts it at `/<token>/api/img`, next to `/proxy`, behind the same token, Origin and Host checks. CORS exposes `X-Image-Cache` to the webview.

| Status | When | Body |
| --- | --- | --- |
| 200 | Cached bytes, with the stored `Content-Type`, `Cache-Control: private, max-age=604800`, `X-Image-Cache: hit` or `miss`, and `Last-Modified`. HEAD, `If-Modified-Since` (304) and Range work through `tower_http::services::ServeFile`. | The image |
| 400 | Missing or bad URL (`invalid`) | JSON `RpcError` |
| 403 | Refused by the server-mode SSRF guard (`invalid`) | JSON |
| 404 | Upstream 404 or 410 (`not_found`) | JSON |
| 415 | Not an image (`unsupported`) | JSON |
| 502 | A body over 10 MB (`invalid`) | JSON |
| 502 | Any other upstream failure: status, connection, timeout, empty body (`network`) | JSON |
| 500 | Local disk or database failure (`io`) | JSON |
| 500 | A file that vanished twice while being read (`internal`) | JSON |

The handler's errors carry `Cache-Control: no-store`, so the browser asks again after the failure memory expires.

Every response from the handler carries `harden()`: CSP `sandbox; default-src 'none'` and `X-Content-Type-Options: nosniff`. An SVG poster is served from the app's own origin, so it must never run as a document.

Some requests are refused before they reach the handler, and those answers carry neither the sandbox CSP nor `no-store`:

- Server mode: `guard::api_guard` refuses a host name not in `--allowed-hosts` and a request with `Sec-Fetch-Site: cross-site` with 403 and a JSON `RpcError` with code `auth`. `guard::security_headers` then adds the site CSP (`SITE_CSP`), `nosniff` and the other site headers.
- Desktop: the loopback proxy refuses a missing or wrong token and a foreign `Origin` with a plain-text 403 before `api_guard` runs. Its `api_guard` keeps the host check but not the cross-site refusal (`ServerOptions::allow_cross_site`): the webview at `http://tauri.localhost` is cross-site to `127.0.0.1`, so every poster request it makes carries `Sec-Fetch-Site: cross-site`, and with the refusal on the desktop app would never use the cache ([desktop.md](desktop.md#guards)).

`get` maps the kinds onto `CoreError` as C2 asks: not an image is `Unsupported`, too large and bad or refused URLs are `Invalid`, upstream 404 is `NotFound`, other upstream failures are `Network`, and local failures are `Io`. The route answers 502 for a body over 10 MB rather than 400, because the failure is the upstream's, not the request's.

If eviction or Clear removes the file between the lookup and the read, the handler looks once more; that lookup sees the row gone and fetches again.

### Browser copies after Clear

The browser keeps each 200 for a week (`max-age=604800`), and `images.clear` cannot reach those copies. After Clear the client therefore bumps a generation (`bumpImageCacheGeneration` in `src/api/images.ts`), stored in `localStorage` under `tsrust.imageCacheGen` and picked up by the app's other tabs, and adds `gen=<n>` to every later cache URL. Those URLs miss the browser's HTTP cache and reach the emptied cache, which fetches each image again. Before the first Clear in a browser, URLs carry no `gen`.

The route must keep ignoring `gen` and any other parameter it does not know (`parse_query`): the cache key comes from `url` (and the `w` bucket) alone, so every generation hits the same stored file. The generation is per browser. In server mode another browser or device keeps showing its own copies for up to a week, and the Clear dialog says so. The desktop app has one webview, so its bump covers every picture it shows.

## Server mode and trust

With the guard active (`allow_private` off), a private or loopback target is refused unless the request names a source whose own `host:port` is that target. Flights and remembered failures are kept per scope, so an untrusted request never shares a fetch or a failure with a trusted one. The guard check comes before the cache lookup, so an image cached through a trusted source is still refused when it is asked for by IP literal or `localhost` name without the source. A host name that resolves to a private address is checked by the guarded client's resolver when it is fetched, not when a cached copy is served: a copy cached through the source is served to a request without it. That is not a hole, because any caller may name any `sourceId`. Resolving every name before each hit would cost a DNS lookup per cached image and break offline use.

## Desktop

The desktop app has no guard. Images are fetched with the shared client, plus the source's headers when `sourceId` is given. `imageUrl` builds the route from the proxy base (`.../proxy` becomes `.../img`), so images go through the token-protected loopback server.
