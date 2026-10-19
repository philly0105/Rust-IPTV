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

const { isDesktop, proxiedUrl, setDesktopProxyBase, rpcRaw, RPC_ERROR_CODES, sourceRunDetails } = await import('./transport');

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
    // rewriter writes it), so they resolve against this URL with it intact.
    expect(new URL('/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432/api/proxy?url=seg.ts', out).pathname).toBe(u.pathname);
  });

  // L2-desktop-4: a provider that sends no CORS headers only plays in the inline player through
  // the proxy, so header-less streams go through it too (this test used to pin the direct load).
  it('routes header-less http(s) streams through the loopback proxy too', () => {
    const proxy = 'http://127.0.0.1:5555/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432/api/proxy';
    setDesktopProxyBase(proxy);
    const vod: PlayerSource = { ...base, url: 'https://cdn.example/m.mp4', kind: 'direct', isLive: false };
    for (const s of [base, { ...base, headers: { userAgent: '' } }, vod]) {
      const out = new URL(proxiedUrl(s));
      expect(`${out.origin}${out.pathname}`).toBe(proxy);
      expect(out.searchParams.get('url')).toBe(s.url);
      expect(out.searchParams.has('ua')).toBe(false);
    }
  });

  it("keeps local files, Tauri's own hosts and the proxy's own URLs direct", () => {
    const proxy = 'http://127.0.0.1:5555/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432/api/proxy';
    setDesktopProxyBase(proxy);
    expect(proxiedUrl({ ...base, kind: 'file', url: 'C:\\v\\a.mkv' })).toBe(
      `http://asset.localhost/${encodeURIComponent('C:\\v\\a.mkv')}`,
    );
    const asset = 'http://asset.localhost/C%3A%5Cv%5Ca.mkv';
    expect(proxiedUrl({ ...base, kind: 'file', url: asset })).toBe(asset);
    // recordings.playSource / myvideos.playSource: the proxy's own Range-capable file routes.
    const recording = 'http://127.0.0.1:5555/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432/api/recordings/f.636c69702e7473/media.ts';
    expect(proxiedUrl({ ...base, kind: 'file', url: recording })).toBe(recording);
    const already = `${proxy}?url=${encodeURIComponent(base.url)}`;
    expect(proxiedUrl({ ...base, url: already })).toBe(already);
    expect(proxiedUrl({ ...base, url: 'blob:http://tauri.localhost/1' })).toBe('blob:http://tauri.localhost/1');
  });

  it('falls back to the direct URL when the proxy is unavailable', () => {
    setDesktopProxyBase(null);
    expect(proxiedUrl({ ...base, headers: { userAgent: 'UA' } })).toBe(base.url);
  });
});

describe('rpc errors (desktop)', () => {
  it.each(RPC_ERROR_CODES.flatMap((code) => [[code, 'object'], [code, 'json string']] as const))(
    'keeps code %s from a Tauri rejection (%s), with its details',
    async (code, shape) => {
      const payload = { code, message: `boom ${code}`, details: { sourceId: 's9' } };
      invoke.mockImplementationOnce(() => Promise.reject(shape === 'object' ? payload : JSON.stringify(payload)));
      const err = await rpcRaw('sources.get', { id: 'x' }).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: 'RpcError', code, message: `boom ${code}` });
      expect(sourceRunDetails(err)).toEqual({ sourceId: 's9' });
    },
  );
});

describe('rpcRaw (desktop) with a signal', () => {
  it('skips the invoke when the signal is already aborted', async () => {
    invoke.mockClear();
    const ctl = new AbortController();
    ctl.abort();
    await expect(rpcRaw('catalog.channels', { sourceId: 's1' }, { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
    await rpcRaw('app.ping', null, { signal: new AbortController().signal });
    expect(invoke).toHaveBeenCalledWith('rpc', { cmd: 'app.ping', args: null });
  });
});
