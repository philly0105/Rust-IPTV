import { afterEach, describe, expect, it, vi } from 'vitest';

import { queryClient, rpcKey } from '@/api/query';
import type { Settings, VideoPlayer } from '@/api/types';

import { __setEngineLoadersForTests, afterPaint, preloadEngineFor, preloadEngines } from './enginePreload';

const platform = vi.hoisted(() => ({ desktop: false }));
vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  return {
    ...actual,
    get isDesktop() {
      return platform.desktop;
    },
  };
});

function loaders() {
  return { hls: vi.fn(async (): Promise<unknown> => ({})), mpegts: vi.fn(async (): Promise<unknown> => ({})) };
}

afterEach(() => {
  __setEngineLoadersForTests(null);
  vi.useRealTimers();
  platform.desktop = false;
  queryClient.clear();
});

function players(player: VideoPlayer, per: Partial<Pick<Settings, 'livePlayer' | 'vodPlayer' | 'catchupPlayer'>> = {}): void {
  queryClient.setQueryData(rpcKey('settings.get'), { player, ...per } as Settings);
}

/** Runs the idle warm-up and says which engines it loaded. */
async function idleWarmUp(): Promise<{ hls: number; mpegts: number }> {
  vi.useFakeTimers();
  const l = loaders();
  __setEngineLoadersForTests(l);
  preloadEngines();
  await vi.advanceTimersByTimeAsync(3_000);
  return { hls: l.hls.mock.calls.length, mpegts: l.mpegts.mock.calls.length };
}

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

describe('idle warm-up and the configured players', () => {
  it('loads nothing on desktop when live, VOD and catch-up all play outside the built-in player', async () => {
    platform.desktop = true;
    players('embedded-mpv', { vodPlayer: 'mpv', catchupPlayer: 'vlc' });
    expect(await idleWarmUp()).toEqual({ hls: 0, mpegts: 0 });
  });

  it('still loads the engine a play asks for after the click', async () => {
    platform.desktop = true;
    players('mpv');
    vi.useFakeTimers();
    const l = loaders();
    __setEngineLoadersForTests(l);
    preloadEngines();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(l.hls).not.toHaveBeenCalled();
    preloadEngineFor('http://h/radio.m3u8');
    await vi.advanceTimersByTimeAsync(100);
    expect(l.hls).toHaveBeenCalledTimes(1);
  });

  it('loads both when any one of them is the built-in player, catch-up included', async () => {
    platform.desktop = true;
    players('mpv', { catchupPlayer: 'html5' });
    expect(await idleWarmUp()).toEqual({ hls: 1, mpegts: 1 });
    __setEngineLoadersForTests(null);
    players('embedded-mpv', { livePlayer: 'videojs' });
    expect(await idleWarmUp()).toEqual({ hls: 1, mpegts: 1 });
  });

  it('loads both while the settings are not known yet', async () => {
    platform.desktop = true;
    expect(await idleWarmUp()).toEqual({ hls: 1, mpegts: 1 });
  });

  it('loads both on the web, where mpv and VLC fall back to the built-in player', async () => {
    players('embedded-mpv', { vodPlayer: 'mpv', catchupPlayer: 'vlc' });
    expect(await idleWarmUp()).toEqual({ hls: 1, mpegts: 1 });
  });

  it('warms them on a later call once the player changes to the built-in one', async () => {
    platform.desktop = true;
    players('mpv');
    vi.useFakeTimers();
    const l = loaders();
    __setEngineLoadersForTests(l);
    preloadEngines();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(l.hls).not.toHaveBeenCalled();
    players('html5');
    preloadEngines();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(l.hls).toHaveBeenCalledTimes(1);
    expect(l.mpegts).toHaveBeenCalledTimes(1);
  });
});
