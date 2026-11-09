/**
 * public/boot-rpc.js: in the browser it asks for the settings and the sources before the app's
 * modules have loaded, and the transport takes those answers (transport.test.ts). index.html runs
 * it before the module script.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const root = join(__dirname, '..', '..');
const SCRIPT = readFileSync(join(root, 'public', 'boot-rpc.js'), 'utf8');
const INDEX = readFileSync(join(root, 'index.html'), 'utf8');

type BootWindow = { __tsrustEarlyRpc?: Record<string, Promise<Response | null>>; __TAURI_INTERNALS__?: unknown };
const win = () => window as unknown as BootWindow;

afterEach(() => {
  vi.unstubAllGlobals();
  delete win().__tsrustEarlyRpc;
  delete win().__TAURI_INTERNALS__;
});

describe('boot-rpc.js', () => {
  it('asks for settings.get and sources.list as the transport would, once each', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    new Function(SCRIPT)();
    expect(fetchMock.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['/api/rpc/settings.get', '/api/rpc/sources.list']);
    for (const call of fetchMock.mock.calls) {
      expect((call as unknown[])[1]).toEqual({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' });
    }
    expect(Object.keys(win().__tsrustEarlyRpc ?? {})).toEqual(['settings.get', 'sources.list']);
    await expect(win().__tsrustEarlyRpc!['settings.get']).resolves.toBeInstanceOf(Response);
  });

  it('turns a failed request into null, so the app asks again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    new Function(SCRIPT)();
    await expect(win().__tsrustEarlyRpc!['sources.list']).resolves.toBeNull();
  });

  it('does nothing in the desktop app', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    win().__TAURI_INTERNALS__ = {};
    new Function(SCRIPT)();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(win().__tsrustEarlyRpc).toBeUndefined();
  });

  it('index.html runs it as an external blocking script, before the app module', () => {
    expect(INDEX).toMatch(/<script src="\/boot-rpc\.js"><\/script>/);
    expect(INDEX.indexOf('/boot-rpc.js')).toBeLessThan(INDEX.indexOf('type="module"'));
  });
});
