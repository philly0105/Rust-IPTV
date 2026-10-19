// @vitest-environment node
/**
 * public/sw.js on activate (performance audit SH-11): the build writes its asset list into the
 * worker (vite.config.ts `withAssetList`), so each deploy installs a new worker, and activating it
 * deletes the cached /assets/* files of earlier builds. The shell entry and the current build's
 * files stay. An unbuilt worker (no list) deletes nothing.
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
});
