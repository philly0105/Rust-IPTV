import { afterEach, describe, expect, it, vi } from 'vitest';

import { queryClient, rpcKey } from '@/api/query';
import type { Settings } from '@/api/types';

import { __setEngineLoadersForTests, afterPaint, preloadEngineFor, preloadEngines, prewarmTsWorkers } from './enginePreload';

const env = vi.hoisted(() => ({ desktop: false }));
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  get isDesktop() {
    return env.desktop;
  },
}));

function loaders() {
  return { hls: vi.fn(async (): Promise<unknown> => ({})), mpegts: vi.fn(async (): Promise<unknown> => ({})) };
}

afterEach(() => {
  __setEngineLoadersForTests(null);
  vi.useRealTimers();
  env.desktop = false;
  queryClient.removeQueries({ queryKey: ['settings.get'] });
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

describe('no idle warm-up for mpv and VLC players (F1-5)', () => {
  const players = (p: Partial<Settings>): void => void queryClient.setQueryData(rpcKey('settings.get'), { player: 'html5', ...p } as Settings);

  async function idleWarmUp(): Promise<ReturnType<typeof loaders>> {
    vi.useFakeTimers();
    const l = loaders();
    __setEngineLoadersForTests(l);
    preloadEngines();
    await vi.advanceTimersByTimeAsync(3_000);
    return l;
  }

  it('skips both engines on desktop when live, VOD and catch-up all play outside the app', async () => {
    env.desktop = true;
    players({ player: 'mpv', vodPlayer: 'embedded-mpv', catchupPlayer: 'vlc' });
    const l = await idleWarmUp();
    expect(l.hls).not.toHaveBeenCalled();
    expect(l.mpegts).not.toHaveBeenCalled();
    // A play still asks for its engine at once.
    preloadEngineFor('http://h/live/1.ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(l.mpegts).toHaveBeenCalledTimes(1);
  });

  it('settings that land while the page waits for idle count', async () => {
    env.desktop = true;
    vi.useFakeTimers();
    const l = loaders();
    __setEngineLoadersForTests(l);
    preloadEngines();
    players({ player: 'vlc' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(l.hls).not.toHaveBeenCalled();
  });

  it('still warms them when any of the three plays in the app, or for radio under embedded mpv', async () => {
    env.desktop = true;
    for (const p of [
      { player: 'mpv', vodPlayer: 'html5' },
      { player: 'mpv', catchupPlayer: 'videojs' },
      // Radio plays in the built-in <audio> unless live is mpv or VLC.
      { player: 'embedded-mpv' },
      { player: 'vlc', livePlayer: 'embedded-mpv' },
    ] as const) {
      players(p);
      const l = await idleWarmUp();
      expect(l.hls, JSON.stringify(p)).toHaveBeenCalledTimes(1);
      expect(l.mpegts, JSON.stringify(p)).toHaveBeenCalledTimes(1);
    }
  });

  it('warms them before settings load, and always in the browser, where mpv and VLC play in the app', async () => {
    env.desktop = true;
    let l = await idleWarmUp();
    expect(l.hls).toHaveBeenCalledTimes(1);
    env.desktop = false;
    players({ player: 'mpv' });
    l = await idleWarmUp();
    expect(l.hls).toHaveBeenCalledTimes(1);
    expect(l.mpegts).toHaveBeenCalledTimes(1);
  });
});

describe('spare mpegts.js workers (F2-2)', () => {
  function tsLoaders(supported = true) {
    const prewarmWorkers = vi.fn();
    const mpegts = vi.fn(async (): Promise<unknown> => ({ default: { isSupported: () => supported, prewarmWorkers } }));
    return { loaders: { hls: vi.fn(async (): Promise<unknown> => ({})), mpegts }, prewarmWorkers };
  }

  it('loading mpegts.js for a play boots one spare worker, once', async () => {
    vi.useFakeTimers();
    const { loaders: l, prewarmWorkers } = tsLoaders();
    __setEngineLoadersForTests(l);
    preloadEngineFor('http://h/live/1.ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(prewarmWorkers.mock.calls).toEqual([[1]]);
    preloadEngineFor('http://h/live/2.ts');
    preloadEngineFor('http://h/live/3.m3u8');
    await vi.advanceTimersByTimeAsync(100);
    expect(prewarmWorkers).toHaveBeenCalledTimes(1);
  });

  it('the wall asks for one per tile, at most 4, after the frame paints', async () => {
    vi.useFakeTimers();
    const { loaders: l, prewarmWorkers } = tsLoaders();
    __setEngineLoadersForTests(l);
    prewarmTsWorkers(6);
    expect(l.mpegts).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(l.mpegts).toHaveBeenCalledTimes(1);
    expect(prewarmWorkers.mock.calls).toEqual([[1], [4]]);
    // Already loaded: no second fetch.
    prewarmTsWorkers(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(l.mpegts).toHaveBeenCalledTimes(1);
    expect(prewarmWorkers.mock.calls.at(-1)).toEqual([2]);
    prewarmTsWorkers(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(prewarmWorkers).toHaveBeenCalledTimes(3);
  });

  it('boots no spare when a play loads mpegts.js for mpv or VLC, though the wall still does', async () => {
    env.desktop = true;
    queryClient.setQueryData(rpcKey('settings.get'), { player: 'mpv', vodPlayer: 'vlc', catchupPlayer: 'embedded-mpv' } as Settings);
    vi.useFakeTimers();
    const { loaders: l, prewarmWorkers } = tsLoaders();
    __setEngineLoadersForTests(l);
    // Every play asks for its engine before the mode is decided.
    preloadEngineFor('http://h/live/1.ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(l.mpegts).toHaveBeenCalledTimes(1);
    expect(prewarmWorkers).not.toHaveBeenCalled();
    // The wall always plays in the built-in engines.
    prewarmTsWorkers(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(prewarmWorkers.mock.calls).toEqual([[2]]);
  });

  it('boots none without MSE, and an older bundle without the call is no error', async () => {
    vi.useFakeTimers();
    const { loaders: l, prewarmWorkers } = tsLoaders(false);
    __setEngineLoadersForTests(l);
    prewarmTsWorkers(4);
    await vi.advanceTimersByTimeAsync(100);
    expect(prewarmWorkers).not.toHaveBeenCalled();
    // An unhandled TypeError here would fail the run.
    const older = vi.fn(async (): Promise<unknown> => ({ default: { isSupported: () => true } }));
    __setEngineLoadersForTests({ hls: async () => ({}), mpegts: older });
    prewarmTsWorkers(4);
    await vi.advanceTimersByTimeAsync(100);
    expect(older).toHaveBeenCalledTimes(1);
  });
});
