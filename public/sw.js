// Tsrust IPTV service worker (web build only; the desktop app never registers it).
//
// - /assets/* (hashed, immutable): cache-first.
// - Page navigations and the app shell (/): network-first, falling back to the
//   cached shell when offline.
// - /api/* (RPC, events, proxy, files) and anything cross-origin: never cached.
//   Where the browser supports static routes, these skip the worker entirely.

const CACHE = 'tsrust-iptv-v1';
const SHELL = '/';
// This build's /assets/* URLs. `pnpm build` writes the list here (`serviceWorkerAssets` in
// vite.config.ts), so every deploy changes this file, the browser installs the new worker, and
// activate drops the cached assets of earlier builds (performance audit SH-11). Stays null when
// the file is served unbuilt; activate then deletes nothing.
const ASSETS = /* build:assets */ null;

// Static routes (Chromium 123+) send the requests the fetch handler leaves alone straight to the
// network. Otherwise each RPC, image, proxied segment or direct stream fetch is dispatched to the
// worker first, and waits for it to start again whenever the browser has stopped it for idling.
// The /api rule also covers navigations to API URLs (file and recording links). The second rule
// covers everything else the handler ignores, cross-origin streams included, but needs the `not`
// and `or` conditions; a browser without them keeps the /api rule alone.
const API_ROUTE = { condition: { urlPattern: { pathname: '/api/*' } }, source: 'network' };
const UNHANDLED_ROUTE = {
  condition: {
    not: {
      or: [
        { requestMode: 'navigate' },
        { urlPattern: { pathname: '/assets/*' } },
        { urlPattern: { pathname: SHELL } },
      ],
    },
  },
  source: 'network',
};

/** Registers the static routes where supported. Never rejects: without them the fetch handler still answers. */
function addStaticRoutes(event) {
  if (typeof event.addRoutes !== 'function') return undefined;
  const add = (rules) => new Promise((resolve) => resolve(event.addRoutes(rules)));
  return add([API_ROUTE, UNHANDLED_ROUTE])
    .catch(() => add(API_ROUTE))
    .catch(() => undefined);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      addStaticRoutes(event),
      caches
        .open(CACHE)
        .then((cache) => cache.add(SHELL))
        .catch(() => undefined),
    ]).then(() => self.skipWaiting()),
  );
});

/** Deletes cached /assets/* entries that are not part of this build. */
async function dropStaleAssets() {
  if (!Array.isArray(ASSETS)) return;
  const current = new Set(ASSETS);
  const cache = await caches.open(CACHE);
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((request) => {
        const { pathname } = new URL(request.url);
        return pathname.startsWith('/assets/') && !current.has(pathname);
      })
      .map((request) => cache.delete(request)),
  );
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(dropStaleAssets)
      .catch(() => undefined)
      .then(() => self.clients.claim()),
  );
});

/**
 * Stores a copy of a good response in the background. The page gets the response at once and
 * reads it while the copy is written, instead of waiting for the whole body to be downloaded and
 * stored first. A failed write only leaves the entry uncached.
 */
function storeCopy(event, cache, key, response) {
  if (response.ok) event.waitUntil(cache.put(key, response.clone()).catch(() => undefined));
}

async function cacheFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  storeCopy(event, cache, request, response);
  return response;
}

async function networkFirst(event) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(event.request);
    storeCopy(event, cache, SHELL, response);
    return response;
  } catch (err) {
    const hit = await cache.match(SHELL);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(event));
  } else if (request.mode === 'navigate' || url.pathname === SHELL) {
    event.respondWith(networkFirst(event));
  }
});
