// @vitest-environment node
/**
 * public/sw.js on activate (performance audit SH-11): the build writes its asset list into the
 * worker (vite.config.ts `withAssetList`), so each deploy installs a new worker, and activating it
 * deletes the cached /assets/* files of earlier builds. The shell entry and the current build's
 * files stay. An unbuilt worker (no list) deletes nothing.
 *
 * On fetch (F1-4): the page gets a fetched response without waiting for its Cache Storage copy,
 * and a navigation uses the navigation preload that activate turns on.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withAssetList } from '../../../vite.config';

const SOURCE = readFileSync(join(__dirname, '..', '..', '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://tv.example';

class FakeCache {
  readonly urls = new Set<string>();
  async keys() {
    return [...this.urls].map((url) => ({ url }));
  }
  async delete(request: { url: string }) {
    return this.urls.delete(request.url);
  }
}

/** Runs the worker script against fake `self` and `caches`, fires activate, returns what is cached. */
async function activate(source: string, cached: Record<string, string[]>): Promise<Record<string, string[]>> {
  const stores = new Map(Object.entries(cached).map(([name, paths]) => {
    const cache = new FakeCache();
    for (const p of paths) cache.urls.add(`${ORIGIN}${p}`);
    return [name, cache] as const;
  }));
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name)!;
    },
  };
  const listeners = new Map<string, (event: unknown) => void>();
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  new Function('self', 'caches', 'fetch', source)(self, caches, async () => new Response(''));
  let done: Promise<unknown> = Promise.resolve();
  listeners.get('activate')!({ waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
  return Object.fromEntries([...stores].map(([name, cache]) => [name, [...cache.urls].map((u) => u.slice(ORIGIN.length)).sort()]));
}

describe('service worker activate', () => {
  it("deletes cached assets of earlier builds and keeps this build's and the shell", async () => {
    const built = withAssetList(SOURCE, ['assets/index-new.js', 'assets/DashboardPage-new.js', 'assets/index-new.css', 'index.html']);
    const after = await activate(built, {
      'tsrust-iptv-v1': ['/', '/assets/index-old.js', '/assets/index-new.js', '/assets/DashboardPage-old.js', '/assets/index-new.css'],
      'tsrust-iptv-v0': ['/assets/ancient.js'],
    });
    expect(after).toEqual({ 'tsrust-iptv-v1': ['/', '/assets/index-new.css', '/assets/index-new.js'] });
  });

  it('deletes no asset when the worker was not built', async () => {
    const after = await activate(SOURCE, { 'tsrust-iptv-v1': ['/', '/assets/index-old.js'] });
    expect(after).toEqual({ 'tsrust-iptv-v1': ['/', '/assets/index-old.js'] });
  });

  it('turns on navigation preload where the browser has it', async () => {
    const sw = loadWorker({ preload: true });
    let done: Promise<unknown> = Promise.resolve();
    sw.listeners.get('activate')!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect(sw.preloadEnabled).toBe(true);
  });
});

/** A Cache whose `put` stays pending until the test lets it finish, as a large body would. */
class SlowCache {
  readonly stored = new Map<string, Response>();
  readonly writes: { key: string; finish: () => void }[] = [];
  async match(request: Request | string) {
    return this.stored.get(typeof request === 'string' ? `${ORIGIN}${request}` : request.url);
  }
  put(request: Request | string, response: Response) {
    const key = typeof request === 'string' ? `${ORIGIN}${request}` : request.url;
    return new Promise<void>((resolve) => {
      this.writes.push({ key, finish: () => { this.stored.set(key, response); resolve(); } });
    });
  }
}

/** Loads the worker with a SlowCache and a fetch the test answers; returns its handlers and logs. */
function loadWorker({ preload = false, offline = false } = {}) {
  const cache = new SlowCache();
  const fetched: string[] = [];
  const caches = { open: async () => cache, keys: async () => [], delete: async () => true };
  const listeners = new Map<string, (event: unknown) => void>();
  const sw = { listeners, cache, fetched, preloadEnabled: false };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
    registration: preload ? { navigationPreload: { enable: async () => { sw.preloadEnabled = true; } } } : undefined,
  };
  const fetch = async (request: Request) => {
    fetched.push(new URL(request.url).pathname);
    if (offline) throw new TypeError('Failed to fetch');
    return new Response(`body of ${new URL(request.url).pathname}`);
  };
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, fetch);
  return sw;
}

/** Fires a fetch event; returns what respondWith got and the promises handed to waitUntil. */
function dispatchFetch(sw: ReturnType<typeof loadWorker>, path: string, init: { mode?: string; preload?: Response } = {}) {
  const request = new Request(`${ORIGIN}${path}`);
  if (init.mode) Object.defineProperty(request, 'mode', { value: init.mode });
  let responded: Promise<Response> | undefined;
  const extended: Promise<unknown>[] = [];
  sw.listeners.get('fetch')!({
    request,
    preloadResponse: Promise.resolve(init.preload),
    respondWith: (p: Promise<Response>) => (responded = p),
    waitUntil: (p: Promise<unknown>) => extended.push(p),
  });
  return { responded: responded!, extended };
}

describe('service worker fetch', () => {
  it('answers an asset miss before its cached copy is written, and a hit from the cache', async () => {
    const sw = loadWorker();
    const { responded, extended } = dispatchFetch(sw, '/assets/hls-abc.js');
    // The put is still pending: the page streams the body meanwhile.
    expect(await (await responded).text()).toBe('body of /assets/hls-abc.js');
    expect(sw.cache.writes.map((w) => w.key)).toEqual([`${ORIGIN}/assets/hls-abc.js`]);
    expect(extended).toHaveLength(1);
    sw.cache.writes[0].finish();
    await extended[0];

    const again = dispatchFetch(sw, '/assets/hls-abc.js');
    expect(await (await again.responded).text()).toBe('body of /assets/hls-abc.js');
    expect(sw.fetched).toEqual(['/assets/hls-abc.js']);
    expect(again.extended).toHaveLength(0);
  });

  it('answers a navigation from its preload and keeps a copy as the shell', async () => {
    const sw = loadWorker({ preload: true });
    const { responded, extended } = dispatchFetch(sw, '/s/a/live', { mode: 'navigate', preload: new Response('preloaded shell') });
    expect(await (await responded).text()).toBe('preloaded shell');
    expect(sw.fetched).toEqual([]);
    expect(sw.cache.writes.map((w) => w.key)).toEqual([`${ORIGIN}/`]);
    sw.cache.writes[0].finish();
    await extended[0];
  });

  it('fetches a navigation without a preload and answers offline from the cached shell', async () => {
    const online = loadWorker();
    const first = dispatchFetch(online, '/dashboard', { mode: 'navigate' });
    expect(await (await first.responded).text()).toBe('body of /dashboard');
    expect(online.fetched).toEqual(['/dashboard']);

    const offline = loadWorker({ offline: true });
    offline.cache.stored.set(`${ORIGIN}/`, new Response('cached shell'));
    const second = dispatchFetch(offline, '/dashboard', { mode: 'navigate' });
    expect(await (await second.responded).text()).toBe('cached shell');
    expect(second.extended).toHaveLength(0);
  });
});
