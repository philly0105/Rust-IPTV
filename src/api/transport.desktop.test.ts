import { describe, expect, it, vi } from 'vitest';

import type { PlayerSource } from './types';

// Desktop mode: `isDesktop` is computed at import time from the Tauri global.
const invoke = vi.fn(async (_cmd: string, args: { cmd: string }) =>
  args.cmd === 'app.info' ? { proxyBase: 'http://127.0.0.1:5555/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432/api/proxy' } : null,
);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: { cmd: string }) => invoke(cmd, args),
  convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
}));
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

const { isDesktop, proxiedUrl, setDesktopProxyBase } = await import('./transport');

const base: PlayerSource = { url: 'http://cdn.example/a.m3u8', kind: 'hls', title: 't', isLive: true, isRadio: false };

describe('proxiedUrl (desktop)', () => {
  it('learns the loopback proxy base from app.info at startup', async () => {
    expect(isDesktop).toBe(true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('rpc', { cmd: 'app.info', args: null }));
    await vi.waitFor(() =>
      expect(proxiedUrl({ ...base, headers: { userAgent: 'UA' } })).toMatch(/^http:\/\/127\.0\.0\.1:5555\/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432\/api\/proxy\?/),
    );
  });

  it('routes header streams through the loopback proxy with the overrides', () => {
    setDesktopProxyBase('http://127.0.0.1:5555/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432/api/proxy');
    const out = new URL(
      proxiedUrl({
        ...base,
        ref: { sourceId: 's1', contentType: 'live', itemId: '1' },
        headers: { userAgent: 'MAG (KHTML, like Gecko)', referrer: 'http://r/', origin: 'http://o' },
      }),
    );
    expect(`${out.origin}${out.pathname}`).toBe('http://127.0.0.1:5555/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432/api/proxy');
    expect(out.searchParams.get('url')).toBe(base.url);
    expect(out.searchParams.get('sourceId')).toBe('s1');
    expect(out.searchParams.get('ua')).toBe('MAG (KHTML, like Gecko)');
    expect(out.searchParams.get('referer')).toBe('http://r/');
    expect(out.searchParams.get('origin')).toBe('http://o');
  });

  it('keeps the per-launch token path segment when building proxy URLs', () => {
    const tokenBase = 'http://127.0.0.1:5555/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432/api/proxy';
    setDesktopProxyBase(tokenBase);
    const out = proxiedUrl({ ...base, url: 'http://cdn.example/a.m3u8?token=abc&x=1', headers: { referrer: 'http://r/' } });
    expect(out.startsWith(`${tokenBase}?`)).toBe(true);
    const u = new URL(out);
    expect(u.pathname).toBe('/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432/api/proxy');
    expect(u.searchParams.get('url')).toBe('http://cdn.example/a.m3u8?token=abc&x=1');
    // The rewritten playlist's root-relative proxy URIs carry the token (the
    // proxy prefixes it), so they resolve against this URL with it intact.
    expect(new URL('/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432/api/proxy?url=seg.ts', out).pathname).toBe(u.pathname);
  });

  it('loads header-less streams and local files directly', () => {
    setDesktopProxyBase('http://127.0.0.1:5555/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432/api/proxy');
    expect(proxiedUrl(base)).toBe(base.url);
    expect(proxiedUrl({ ...base, headers: { userAgent: '' } })).toBe(base.url);
    expect(proxiedUrl({ ...base, kind: 'file', url: 'C:\\v\\a.mkv' })).toBe(
      `http://asset.localhost/${encodeURIComponent('C:\\v\\a.mkv')}`,
    );
  });

  it('falls back to the direct URL when the proxy is unavailable', () => {
    setDesktopProxyBase(null);
    expect(proxiedUrl({ ...base, headers: { userAgent: 'UA' } })).toBe(base.url);
  });
});
