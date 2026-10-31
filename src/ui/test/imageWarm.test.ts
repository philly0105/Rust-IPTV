/**
 * The fetch gate warms a cold wall: once every slot holds a picture the cache is fetching
 * upstream, it names the pictures waiting in view to the core (`images.warm`) once each, so the
 * core fetches them in parallel instead of a few at a time behind the browser's connections. A wall
 * already on disk, a page that scrolls and pictures out of view are not warmed. Over HTTP/2 or
 * HTTP/3 the server-mode cap rises, since requests no longer wait for a free connection.
 */
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { imageCacheRequest, imageUrl, WEB_IMAGE_ROUTE } from '@/api/images';

import {
  DESKTOP_MAX_ACTIVE,
  gateImage,
  imageGateStats,
  MAX_ACTIVE,
  maxActive,
  MULTIPLEXED_MAX_ACTIVE,
  resetImageGate,
  SETTLE_MS,
  WARM_AFTER_MS,
  WARM_MAX,
} from '../imageGate';

const transport = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown }[],
  fail: false,
}));

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => {
    transport.calls.push({ cmd, args });
    return transport.fail ? Promise.reject(new Error('offline')) : Promise.resolve(undefined);
  },
}));

/** The items of every `images.warm` sent so far, one array per call. */
const warms = () =>
  transport.calls.filter((c) => c.cmd === 'images.warm').map((c) => (c.args as { items: unknown[] }).items);

describe('warming waiting pictures', () => {
  let now = 1000;
  let report: (els: HTMLImageElement[], inView: boolean) => void = () => undefined;

  beforeEach(() => {
    class ReportingIO {
      constructor(cb: IntersectionObserverCallback) {
        report = (els, inView) =>
          cb(
            els.map((target) => ({ target, isIntersecting: inView }) as unknown as IntersectionObserverEntry),
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', ReportingIO);
    vi.useFakeTimers();
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    transport.calls.length = 0;
    transport.fail = false;
    resetImageGate();
  });

  afterEach(() => {
    resetImageGate();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const poster = (n: number) => imageUrl(`http://cdn.example/${n}.jpg`, 's1', 180)!;
  const item = (n: number) => ({ url: `http://cdn.example/${n}.jpg`, sourceId: 's1', w: 192 });
  const later = (ms: number) => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };
  /** `n` pictures asked for in one commit, reported in view. */
  const wall = (n: number, from = 0) => {
    const els = Array.from({ length: n }, () => document.createElement('img'));
    els.forEach((el, i) => gateImage(el, poster(from + i)));
    report(els, true);
    return els;
  };

  it('names the pictures waiting in view once a running one has loaded for a while, each once', async () => {
    const els = wall(10);
    expect(imageGateStats()).toEqual({ active: MAX_ACTIVE, pending: 6 });
    later(WARM_AFTER_MS - 10);
    expect(warms()).toEqual([]);
    later(10);
    // One call, best first: the six waiting, in the order the gate will start them.
    expect(warms()).toEqual([[4, 5, 6, 7, 8, 9].map(item)]);

    // The next picture starts with its own request (it joins the warmed fetch); nothing is named again.
    fireEvent.load(els[0]!);
    expect(els[4]!.getAttribute('src')).toBe(poster(4));
    later(WARM_AFTER_MS * 3);
    expect(warms()).toHaveLength(1);

    // A newer commit's pictures are named in a call of their own.
    await Promise.resolve();
    wall(2, 20);
    later(16);
    expect(warms()).toEqual([[4, 5, 6, 7, 8, 9].map(item), [20, 21].map(item)]);
  });

  it(`names at most ${WARM_MAX} in one call and the rest once the wall moves on`, () => {
    const els = wall(MAX_ACTIVE + WARM_MAX + 3);
    later(WARM_AFTER_MS);
    expect(warms()).toHaveLength(1);
    expect(warms()[0]).toEqual(Array.from({ length: WARM_MAX }, (_, i) => item(MAX_ACTIVE + i)));
    later(WARM_AFTER_MS);
    expect(warms()).toHaveLength(1);
    fireEvent.load(els[0]!);
    expect(warms()).toHaveLength(2);
    expect(warms()[1]).toEqual([0, 1, 2].map((i) => item(MAX_ACTIVE + WARM_MAX + i)));
  });

  it('does not warm a wall the cache reads from disk', () => {
    const els = wall(12);
    // Each round answers within a few ms, as hits do.
    for (let round = 0; round < 3; round++) {
      later(20);
      for (const el of els.filter((e) => e.hasAttribute('src')).slice(-MAX_ACTIVE)) fireEvent.load(el);
    }
    later(WARM_AFTER_MS * 2);
    expect(imageGateStats().pending).toBe(0);
    expect(warms()).toEqual([]);
  });

  it('waits for the page to stop scrolling and leaves out pictures out of view', () => {
    const els = wall(10);
    report(els.slice(7), false);
    later(WARM_AFTER_MS - 50);
    document.dispatchEvent(new Event('scroll'));
    later(50);
    expect(warms()).toEqual([]);
    later(SETTLE_MS - 60);
    expect(warms()).toEqual([]);
    // Still for SETTLE_MS: the pump it re-armed names what waits in view.
    later(10);
    expect(warms()).toEqual([[4, 5, 6].map(item)]);
  });

  it('a warm that fails is only a lost head start', async () => {
    transport.fail = true;
    const els = wall(6);
    later(WARM_AFTER_MS);
    await Promise.resolve();
    expect(warms()).toHaveLength(1);
    fireEvent.load(els[0]!);
    expect(els[4]!.getAttribute('src')).toBe(poster(4));
  });
});

describe('the server-mode cap over HTTP/2 and HTTP/3', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetImageGate();
  });

  const servedOver = (protocol: string | null) => {
    vi.spyOn(performance, 'getEntriesByType').mockImplementation(() =>
      protocol === null ? [] : ([{ nextHopProtocol: protocol }] as unknown as PerformanceEntryList),
    );
    resetImageGate();
  };

  it('rises when the page came over HTTP/2 or HTTP/3, and stays put when the protocol is unknown', () => {
    for (const p of ['h2', 'h3']) {
      servedOver(p);
      expect(maxActive(), p).toBe(MULTIPLEXED_MAX_ACTIVE);
    }
    for (const p of ['http/1.1', '', null]) {
      servedOver(p);
      expect(maxActive(), String(p)).toBe(MAX_ACTIVE);
    }
  });

  it('stays at the desktop cap on desktop', () => {
    servedOver('h2');
    const w = window as unknown as Record<string, unknown>;
    w.__TAURI_INTERNALS__ = {};
    try {
      expect(maxActive()).toBe(DESKTOP_MAX_ACTIVE);
    } finally {
      delete w.__TAURI_INTERNALS__;
    }
  });
});

describe('imageCacheRequest', () => {
  const route = (query: string) => `${WEB_IMAGE_ROUTE}?${query}`;

  it('reads a cache URL as the route does', () => {
    const url = imageUrl('http://cdn.example/p.jpg?x=1&y=2', 's1', 180)!;
    expect(imageCacheRequest(url)).toEqual({ url: 'http://cdn.example/p.jpg?x=1&y=2', sourceId: 's1', w: 192 });
    expect(imageCacheRequest(`${url}&retry=1`)).toEqual(imageCacheRequest(url));
    expect(imageCacheRequest(route('url=http%3A%2F%2Fa.example%2Fp.png&sourceId=%20&gen=3'))).toEqual({
      url: 'http://a.example/p.png',
    });
    // First value wins, trimmed.
    expect(imageCacheRequest(route('url=http%3A%2F%2Fa%2Fp.png&w=%20180%20&w=999'))).toEqual({ url: 'http://a/p.png', w: 180 });
  });

  it('leaves out a width the route would not read, and caps one past the core field', () => {
    for (const w of ['0', '-5', '1.5', '1e3', 'big', '']) {
      expect(imageCacheRequest(route(`url=http%3A%2F%2Fa%2Fp.png&w=${w}`)), w).toEqual({ url: 'http://a/p.png' });
    }
    expect(imageCacheRequest(route('url=http%3A%2F%2Fa%2Fp.png&w=99999999999'))).toEqual({ url: 'http://a/p.png', w: 0xffff_ffff });
  });

  it('is null for anything but a cache URL with an address', () => {
    expect(imageCacheRequest('http://cdn.example/p.jpg')).toBeNull();
    expect(imageCacheRequest(route('sourceId=s1&w=192'))).toBeNull();
    expect(imageCacheRequest(route('url=%20'))).toBeNull();
  });
});
