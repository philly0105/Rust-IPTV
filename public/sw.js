// Tsrust IPTV service worker (web build only; the desktop app never registers it).
//
// - /assets/* (hashed, immutable): cache-first.
// - Page navigations and the app shell (/): network-first, falling back to the
//   cached shell when offline.
// - /api/* (RPC, events, proxy, files) and anything cross-origin: never cached.

const CACHE = 'tsrust-iptv-v1';
const SHELL = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(SHELL, response.clone());
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
    event.respondWith(cacheFirst(request));
  } else if (request.mode === 'navigate' || url.pathname === SHELL) {
    event.respondWith(networkFirst(request));
  }
});
