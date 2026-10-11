import { afterEach, describe, expect, it, vi } from 'vitest';

import { RpcError, isDesktop, proxiedUrl, rpc } from './transport';
import type { PlayerSource } from './types';

const base: PlayerSource = { url: 'http://cdn.example/a.m3u8', kind: 'hls', title: 't', isLive: true, isRadio: false };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RpcError.from', () => {
  it('keeps code, message and retryable from a payload', () => {
    const e = RpcError.from({ code: 'network', message: 'down', retryable: true });
    expect(e).toBeInstanceOf(RpcError);
    expect(e.code).toBe('network');
    expect(e.message).toBe('down');
    expect(e.retryable).toBe(true);
  });

  it('parses JSON string rejections and wraps plain strings', () => {
    expect(RpcError.from('{"code":"auth","message":"no","retryable":false}').code).toBe('auth');
    const plain = RpcError.from('boom');
    expect(plain.code).toBe('internal');
    expect(plain.retryable).toBe(false);
  });
});

describe('rpc (web)', () => {
  it('runs in web mode under jsdom', () => {
    expect(isDesktop).toBe(false);
  });

  it('posts args and returns the JSON result', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(rpc('app.ping')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/rpc/app.ping', expect.objectContaining({ method: 'POST', body: 'null' }));
  });

  it('surfaces the server error body as RpcError without retrying', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"code":"not_found","message":"missing","retryable":false}', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(rpc('sources.get', { id: 'x' })).rejects.toMatchObject({ code: 'not_found', message: 'missing' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps fetch failures to a retryable network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(rpc('app.info')).rejects.toMatchObject({ code: 'network', retryable: true });
  });
});

describe('proxiedUrl (web)', () => {
  it('passes plain urls through', () => {
    expect(proxiedUrl(base)).toBe(base.url);
  });

  it('proxies when headers are present', () => {
    const url = proxiedUrl({
      ...base,
      headers: { userAgent: 'UA' },
      ref: { sourceId: 's1', contentType: 'live', itemId: '1' },
    });
    expect(url).toBe(`/api/proxy?url=${encodeURIComponent(base.url)}&sourceId=s1`);
  });

  it('leaves relative urls alone', () => {
    expect(proxiedUrl({ ...base, url: '/api/files/3', kind: 'file', headers: { userAgent: 'UA' } })).toBe('/api/files/3');
  });
});
