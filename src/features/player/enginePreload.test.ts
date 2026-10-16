import { afterEach, describe, expect, it, vi } from 'vitest';

import { __setEngineLoadersForTests, afterPaint, preloadEngineFor, preloadEngines } from './enginePreload';

function loaders() {
  return { hls: vi.fn(async (): Promise<unknown> => ({})), mpegts: vi.fn(async (): Promise<unknown> => ({})) };
}

afterEach(() => {
  __setEngineLoadersForTests(null);
  vi.useRealTimers();
});

describe('engine preloading (L2-player-7)', () => {
  it('a play asks for the engine its URL needs, once, after the frame paints', async () => {
    vi.useFakeTimers();
    const l = loaders();
    __setEngineLoadersForTests(l);
    preloadEngineFor('http://h/live/1.m3u8');
    // Not inside the click's frame.
    expect(l.hls).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    preloadEngineFor('http://h/live/2.m3u8?token=x');
    await vi.advanceTimersByTimeAsync(100);
    expect(l.hls).toHaveBeenCalledTimes(1);
    expect(l.mpegts).not.toHaveBeenCalled();
    preloadEngineFor('http://h/live/3.ts');
    preloadEngineFor('http://h/player_api.php?stream=3&output=ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(l.mpegts).toHaveBeenCalledTimes(1);
  });

  it('a URL that does not say which (or none yet) loads both', async () => {
    vi.useFakeTimers();
    const l = loaders();
    __setEngineLoadersForTests(l);
    preloadEngineFor(undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(l.hls).toHaveBeenCalledTimes(1);
    expect(l.mpegts).toHaveBeenCalledTimes(1);
  });

  it('pages warm both engines once the browser is idle, not during their own render', async () => {
    vi.useFakeTimers();
    const l = loaders();
    __setEngineLoadersForTests(l);
    preloadEngines();
    preloadEngines();
    expect(l.hls).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(l.hls).toHaveBeenCalledTimes(1);
    expect(l.mpegts).toHaveBeenCalledTimes(1);
    preloadEngines();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(l.hls).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch is tried again by the next request', async () => {
    vi.useFakeTimers();
    const l = loaders();
    l.hls.mockRejectedValueOnce(new Error('offline'));
    __setEngineLoadersForTests(l);
    preloadEngineFor('http://h/a.m3u8');
    await vi.advanceTimersByTimeAsync(100);
    preloadEngineFor('http://h/a.m3u8');
    await vi.advanceTimersByTimeAsync(100);
    expect(l.hls).toHaveBeenCalledTimes(2);
  });

  it('afterPaint runs once, and not at all when cancelled', async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    afterPaint(fn);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(1);
    const other = vi.fn();
    afterPaint(other)();
    await vi.advanceTimersByTimeAsync(200);
    expect(other).not.toHaveBeenCalled();
  });
});
