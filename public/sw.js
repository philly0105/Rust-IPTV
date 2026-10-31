// Tsrust IPTV service worker (web build only; the desktop app never registers it).
//
// - /assets/* (hashed, immutable): cache-first.
// - Page navigations and the app shell (/): network-first, falling back to the
//   cached shell when offline.
// - /api/* (RPC, events, proxy, files) and anything cross-origin: never cached.
//
// Nothing the page waits for waits on Cache Storage (F1-4). Navigation preload starts the
// navigation's request while the worker boots, and a fetched response goes back at once while its
// copy is written under event.waitUntil. Cache.put resolves only once the whole body is read and
// stored, so awaiting it held every asset miss (each lazy chunk after a deploy, hls.js at 593 kB,
// shaka at 775 kB) until it was fully downloaded, and every app open behind a write of index.html;
// the worker added 20-25 ms to the navigation's first byte on a fast desktop.

const CACHE = 'tsrust-iptv-v1';
const SHELL = '/';
// This build's /assets/* URLs. `pnpm build` writes the list here (`serviceWorkerAssets` in
// vite.config.ts), so every deploy changes this file, the browser installs the new worker, and
// activate drops the cached assets of earlier builds (performance audit SH-11). Stays null when
// the file is served unbuilt; activate then deletes nothing.
const ASSETS = /* build:assets */ null;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
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
    // Browsers without navigation preload skip it, and navigations fetch from the worker as before.
    Promise.resolve(self.registration?.navigationPreload?.enable())
      .catch(() => undefined)
      .then(() => caches.keys())
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(dropStaleAssets)
      .catch(() => undefined)
      .then(() => self.clients.claim()),
  );
});

/** Stores a copy of `response` without holding it back: the page streams it meanwhile. */
function keepCopy(event, cache, key, response) {
  if (response.ok) event.waitUntil(cache.put(key, response.clone()).catch(() => undefined));
}

async function cacheFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  keepCopy(event, cache, request, response);
  return response;
}

async function networkFirst(event) {
  const cache = await caches.open(CACHE);
  try {
    // The preload, sent while the worker started; undefined for the shell fetched by the page.
    const response = (await event.preloadResponse) || (await fetch(event.request));
    keepCopy(event, cache, SHELL, response);
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
