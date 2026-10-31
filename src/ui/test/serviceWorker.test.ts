// @vitest-environment node
/**
 * public/sw.js, run against fake `self`, `caches` and `fetch`.
 *
 * - Activate (performance audit SH-11): the build writes its asset list into the worker
 *   (vite.config.ts `withAssetList`), so each deploy installs a new worker, and activating it
 *   deletes the cached /assets/* files of earlier builds. The shell entry and the current build's
 *   files stay. An unbuilt worker (no list) deletes nothing.
 * - Install registers static routes where the browser has them, so the requests the fetch handler
 *   leaves alone (API calls, cross-origin streams) never wait for the worker to start.
 * - Fetch hands a first-time asset or the shell to the page at once and stores its copy in the
 *   background, instead of holding the response until the copy is written.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { withAssetList } from '../../../vite.config';

const SOURCE = readFileSync(join(__dirname, '..', '..', '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://tv.example';
const CACHE = 'tsrust-iptv-v1';

type Key = string | { url: string };
const urlOf = (key: Key) => (typeof key === 'string' ? new URL(key, ORIGIN).href : key.url);

class FakeCache {
  readonly entries = new Map<string, Response>();
  /** Runs before each put stores its entry; tests swap it to hold a write back or fail it. */
  write: () => Promise<void> = async () => undefined;
  async add(key: Key) {
    this.entries.set(urlOf(key), new Response('shell'));
  }
  async put(key: Key, response: Response) {
    await this.write();
    this.entries.set(urlOf(key), response);
  }
  async match(key: Key) {
    return this.entries.get(urlOf(key));
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(request: { url: string }) {
    return this.entries.delete(request.url);
  }
}

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
}

/** Runs the worker script against fakes. `cached` maps cache names to the paths stored in them. */
function load(
  source: string,
  { cached = {}, network = async () => new Response('network') }: { cached?: Record<string, string[]>; network?: () => Promise<Response> } = {},
) {
  const stores = new Map(
    Object.entries(cached).map(([name, paths]) => {
      const cache = new FakeCache();
      for (const p of paths) cache.entries.set(`${ORIGIN}${p}`, new Response(`cached ${p}`));
      return [name, cache] as const;
    }),
  );
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
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: async () => undefined },
  };
  const fetch = vi.fn((_request: FakeRequest) => network());
  new Function('self', 'caches', 'fetch', source)(self, caches, fetch);
  const cache = () => caches.open(CACHE);
  /** Fires an install or activate event and waits for all it extended its lifetime with. */
  async function lifecycle(type: 'install' | 'activate', extra: object = {}) {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({ ...extra, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  /** Fires a fetch event; `responded` is unset when the worker leaves the request to the browser. */
  function request(url: string, { method = 'GET', mode = 'cors' } = {}) {
    const event = {
      request: { url, method, mode },
      responded: undefined as Promise<Response> | undefined,
      waits: [] as Promise<unknown>[],
      respondWith: (p: Promise<Response>) => (event.responded = p),
      waitUntil: (p: Promise<unknown>) => event.waits.push(p),
    };
    listeners.get('fetch')!(event);
    return event;
  }
  return { stores, self, fetch, cache, lifecycle, request };
}

const PENDING = Symbol('pending');
/** What `promise` has resolved to once everything already queued has run, or PENDING. */
async function settled<T>(promise: Promise<T> | undefined): Promise<T | typeof PENDING> {
  let value: T | typeof PENDING = PENDING;
  void promise?.then((v) => (value = v));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return value;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Runs the worker script, fires activate, returns what is cached. */
async function activate(source: string, cached: Record<string, string[]>): Promise<Record<string, string[]>> {
  const worker = load(source, { cached });
  await worker.lifecycle('activate');
  return Object.fromEntries(
    [...worker.stores].map(([name, cache]) => [name, [...cache.entries.keys()].map((u) => u.slice(ORIGIN.length)).sort()]),
  );
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
});

interface Condition {
  urlPattern?: { pathname: string };
  requestMode?: string;
  or?: Condition[];
  not?: Condition;
}
interface Rule {
  condition: Condition;
  source: string;
}

/**
 * The browser's reading of the conditions the worker uses. A pattern given as a dictionary is
 * resolved against the worker's own URL, so it only matches same-origin requests.
 */
function matches(condition: Condition, request: FakeRequest): boolean {
  const url = new URL(request.url);
  const results: boolean[] = [];
  for (const [key, value] of Object.entries(condition)) {
    if (key === 'urlPattern') {
      const { pathname, ...rest } = value as { pathname: string };
      expect(rest, 'only pathname patterns are modelled').toEqual({});
      const path = pathname.endsWith('/*') ? url.pathname.startsWith(pathname.slice(0, -1)) : url.pathname === pathname;
      results.push(url.origin === ORIGIN && path);
    } else if (key === 'requestMode') results.push(request.mode === value);
    else if (key === 'or') results.push((value as Condition[]).some((c) => matches(c, request)));
    else if (key === 'not') results.push(!matches(value as Condition, request));
    else throw new Error(`condition ${key} is not modelled`);
  }
  return results.length > 0 && results.every(Boolean);
}

/** Where the browser sends a request: the first matching rule's source, else the fetch handler. */
const routed = (rules: Rule[], request: FakeRequest) => rules.find((r) => matches(r.condition, request))?.source ?? 'fetch-event';

const REQUESTS: FakeRequest[] = [
  { url: `${ORIGIN}/live`, method: 'GET', mode: 'navigate' },
  { url: `${ORIGIN}/`, method: 'GET', mode: 'navigate' },
  { url: `${ORIGIN}/`, method: 'GET', mode: 'cors' },
  { url: `${ORIGIN}/assets/index-a.js`, method: 'GET', mode: 'cors' },
  { url: `${ORIGIN}/assets/hls-b.js`, method: 'GET', mode: 'no-cors' },
  { url: `${ORIGIN}/api/files/7`, method: 'GET', mode: 'navigate' },
  { url: `${ORIGIN}/api/rpc/channels.list`, method: 'POST', mode: 'cors' },
  { url: `${ORIGIN}/api/img/abc?w=200`, method: 'GET', mode: 'no-cors' },
  { url: `${ORIGIN}/api/proxy/hls/1/seg.ts`, method: 'GET', mode: 'cors' },
  { url: 'https://cdn.example/live/1.m3u8', method: 'GET', mode: 'cors' },
  { url: 'https://cdn.example/assets/seg-1.ts', method: 'GET', mode: 'cors' },
  { url: `${ORIGIN}/manifest.webmanifest`, method: 'GET', mode: 'cors' },
  { url: `${ORIGIN}/theme-boot.js`, method: 'GET', mode: 'no-cors' },
];

/** Whether the fetch handler answers a request itself. */
function answers(request: FakeRequest): boolean {
  return load(SOURCE).request(request.url, request).responded !== undefined;
}

describe('service worker install', () => {
  it('caches the shell and takes over without static routes', async () => {
    const worker = load(SOURCE);
    await worker.lifecycle('install');
    expect((await worker.cache()).entries.has(`${ORIGIN}/`)).toBe(true);
    expect(worker.self.skipWaiting).toHaveBeenCalledOnce();
  });

  it('routes exactly the requests the fetch handler leaves alone to the network', async () => {
    const worker = load(SOURCE);
    const addRoutes = vi.fn(async (_rules: Rule[]) => undefined);
    await worker.lifecycle('install', { addRoutes });
    expect(addRoutes).toHaveBeenCalledOnce();
    const rules = addRoutes.mock.calls[0]![0];
    for (const request of REQUESTS) {
      expect(routed(rules, request), `${request.method} ${request.mode} ${request.url}`).toBe(answers(request) ? 'fetch-event' : 'network');
    }
    expect(REQUESTS.filter((r) => answers(r))).toHaveLength(5);
    expect((await worker.cache()).entries.has(`${ORIGIN}/`)).toBe(true);
    expect(worker.self.skipWaiting).toHaveBeenCalledOnce();
  });

  it('keeps the API route alone where the browser lacks the conditions for the rest', async () => {
    const worker = load(SOURCE);
    const addRoutes = vi.fn(async (rules: Rule | Rule[]) => {
      if (JSON.stringify(rules).includes('"not"')) throw new TypeError('unsupported condition');
    });
    await worker.lifecycle('install', { addRoutes });
    expect(addRoutes).toHaveBeenCalledTimes(2);
    const fallback = [addRoutes.mock.calls[1]![0]].flat();
    const toNetwork = REQUESTS.filter((r) => routed(fallback, r) === 'network').map((r) => r.url);
    expect(toNetwork).toEqual([
      `${ORIGIN}/api/files/7`,
      `${ORIGIN}/api/rpc/channels.list`,
      `${ORIGIN}/api/img/abc?w=200`,
      `${ORIGIN}/api/proxy/hls/1/seg.ts`,
    ]);
    expect(worker.self.skipWaiting).toHaveBeenCalledOnce();
  });

  it('still installs when the browser refuses every route', async () => {
    for (const addRoutes of [
      vi.fn(async () => Promise.reject(new TypeError('no'))),
      vi.fn(() => {
        throw new TypeError('no');
      }),
    ]) {
      const worker = load(SOURCE);
      await worker.lifecycle('install', { addRoutes });
      expect(addRoutes).toHaveBeenCalledTimes(2);
      expect((await worker.cache()).entries.has(`${ORIGIN}/`)).toBe(true);
      expect(worker.self.skipWaiting).toHaveBeenCalledOnce();
    }
  });
});

describe('service worker fetch', () => {
  it('answers a first-time asset before its copy is stored, then caches it', async () => {
    const fromNetwork = new Response('chunk');
    const worker = load(SOURCE, { network: async () => fromNetwork });
    const cache = await worker.cache();
    const write = deferred();
    cache.write = () => write.promise;
    const event = worker.request(`${ORIGIN}/assets/hls-a.js`);
    expect(await settled(event.responded)).toBe(fromNetwork);
    expect(cache.entries.has(`${ORIGIN}/assets/hls-a.js`)).toBe(false);
    expect(event.waits).toHaveLength(1);
    write.resolve();
    await Promise.all(event.waits);
    expect(cache.entries.has(`${ORIGIN}/assets/hls-a.js`)).toBe(true);
  });

  it('still answers when the copy cannot be stored', async () => {
    const fromNetwork = new Response('chunk');
    const worker = load(SOURCE, { network: async () => fromNetwork });
    const cache = await worker.cache();
    cache.write = () => Promise.reject(new DOMException('full', 'QuotaExceededError'));
    const event = worker.request(`${ORIGIN}/assets/hls-a.js`);
    expect(await event.responded).toBe(fromNetwork);
    await expect(Promise.all(event.waits)).resolves.toBeDefined();
    expect(cache.entries.has(`${ORIGIN}/assets/hls-a.js`)).toBe(false);
  });

  it('serves a cached asset without the network', async () => {
    const worker = load(SOURCE, { cached: { [CACHE]: ['/assets/index-a.js'] } });
    const event = worker.request(`${ORIGIN}/assets/index-a.js`);
    expect(await (await event.responded!).text()).toBe('cached /assets/index-a.js');
    expect(worker.fetch).not.toHaveBeenCalled();
    expect(event.waits).toHaveLength(0);
  });

  it('answers a navigation before the shell copy is stored', async () => {
    const fromNetwork = new Response('<!doctype html>');
    const worker = load(SOURCE, { network: async () => fromNetwork });
    const cache = await worker.cache();
    const write = deferred();
    cache.write = () => write.promise;
    const event = worker.request(`${ORIGIN}/live/42`, { mode: 'navigate' });
    expect(await settled(event.responded)).toBe(fromNetwork);
    write.resolve();
    await Promise.all(event.waits);
    expect([...cache.entries.keys()]).toEqual([`${ORIGIN}/`]);
  });

  it('serves the cached shell when the network is down', async () => {
    const worker = load(SOURCE, { cached: { [CACHE]: ['/'] }, network: () => Promise.reject(new TypeError('offline')) });
    const event = worker.request(`${ORIGIN}/guide`, { mode: 'navigate' });
    expect(await (await event.responded!).text()).toBe('cached /');
  });

  it('leaves API, non-GET and cross-origin requests to the browser', () => {
    const worker = load(SOURCE);
    for (const request of REQUESTS.filter((r) => r.url.includes('/api/') || !r.url.startsWith(ORIGIN))) {
      expect(worker.request(request.url, request).responded, request.url).toBeUndefined();
    }
    expect(worker.fetch).not.toHaveBeenCalled();
  });
});
