import { afterEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES, RpcError, isCancelledRun, isDesktop, proxiedUrl, rpc, rpcRaw, sourceRunDetails } from './transport';
import { onServerAnswered } from './reachability';
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

describe('source run error details (C8)', () => {
  it('reads details.cancelled and sourceId from the core rejection', () => {
    const cancelled = RpcError.from({
      code: 'conflict',
      message: 'the import stopped before saving',
      retryable: false,
      details: { sourceId: 's1', cancelled: true },
    });
    expect(isCancelledRun(cancelled)).toBe(true);
    expect(sourceRunDetails(cancelled)).toEqual({ sourceId: 's1', cancelled: true });
  });

  it('is false for a real failure, a missing or malformed details, and non-errors', () => {
    expect(isCancelledRun(RpcError.from({ code: 'network', message: 'down', retryable: true, details: { sourceId: 's1' } }))).toBe(false);
    expect(isCancelledRun(new RpcError('conflict', 'x', false, { cancelled: 'yes' }))).toBe(false);
    expect(isCancelledRun(new RpcError('conflict', 'cancelled'))).toBe(false);
    expect(isCancelledRun(null)).toBe(false);
    expect(sourceRunDetails(new RpcError('internal', 'x', false, 'text'))).toBeUndefined();
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

  it('sends with keepalive only when asked (a pagehide flush)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('null', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await rpc('app.ping');
    await rpcRaw('app.ping', undefined, { keepalive: true });
    expect(fetchMock.mock.calls.map(([, init]) => init?.keepalive)).toEqual([undefined, true]);
  });

  it('aborts the request with the signal and rejects with its AbortError, not an RpcError', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const ctl = new AbortController();
    const call = rpcRaw('catalog.channels', { sourceId: 's1' }, { signal: ctl.signal });
    expect(fetchMock.mock.calls[0]![1]?.signal).toBe(ctl.signal);
    ctl.abort();
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    await expect(call).rejects.not.toBeInstanceOf(RpcError);
  });

  it('reports a server answer (success or its own error payload) but not a proxy 502', async () => {
    const answered = vi.fn();
    const off = onServerAnswered(answered);
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200 })));
      await rpc('app.ping');
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":"invalid","message":"bad"}', { status: 400 })));
      await expect(rpc('app.ping')).rejects.toBeInstanceOf(RpcError);
      expect(answered).toHaveBeenCalledTimes(2);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 502 })));
      await expect(rpc('app.ping')).rejects.toBeInstanceOf(RpcError);
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
      await expect(rpc('app.ping')).rejects.toMatchObject({ code: 'network' });
      expect(answered).toHaveBeenCalledTimes(2);
    } finally {
      off();
    }
  });

  it('surfaces the server error body as RpcError without retrying', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"code":"not_found","message":"missing","retryable":false}', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(rpc('sources.get', { id: 'x' })).rejects.toMatchObject({ code: 'not_found', message: 'missing' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('knows every core error code (C12), including engine_missing and server', () => {
    expect(RPC_ERROR_CODES).toEqual(expect.arrayContaining(['engine_missing', 'server', 'not_found', 'internal']));
    expect(RPC_ERROR_CODES).toHaveLength(12);
  });

  it.each(RPC_ERROR_CODES.flatMap((code) => [502, 503, 500, 404].map((status) => [code, status] as const)))(
    'keeps code %s and details from a JSON error body (HTTP %i), never the bare status',
    async (code, status) => {
      const body = JSON.stringify({ code, message: `boom ${code}`, details: { sourceId: 's9' } });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, statusText: 'Bad Gateway' })));
      const err = await rpc('sources.get', { id: 'x' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect(err).toMatchObject({ code, message: `boom ${code}` });
      expect(sourceRunDetails(err)).toEqual({ sourceId: 's9' });
    },
  );

  it('falls back to the HTTP status only when the body is not an error payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502, statusText: 'Bad Gateway' })));
    await expect(rpc('app.info')).rejects.toMatchObject({ code: 'network', message: 'HTTP 502 Bad Gateway' });
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
    expect(url).toBe(`/api/proxy?url=${encodeURIComponent(base.url)}&sourceId=s1&ua=UA`);
  });

  it('sends the merged headers as ua / referer / origin params', () => {
    const url = proxiedUrl({
      ...base,
      headers: { userAgent: 'VLC/3', referrer: 'http://ref.example/', origin: 'http://o.example' },
      ref: { sourceId: 's1', contentType: 'live', itemId: '1' },
    });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('url')).toBe(base.url);
    expect(params.get('sourceId')).toBe('s1');
    expect(params.get('ua')).toBe('VLC/3');
    expect(params.get('referer')).toBe('http://ref.example/');
    expect(params.get('origin')).toBe('http://o.example');
  });

  it('leaves relative urls alone', () => {
    expect(proxiedUrl({ ...base, url: '/api/files/3', kind: 'file', headers: { userAgent: 'UA' } })).toBe('/api/files/3');
  });
});
