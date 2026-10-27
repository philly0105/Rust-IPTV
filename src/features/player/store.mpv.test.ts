/**
 * Desktop with embedded mpv chosen: once mpv is known not to start this session (not found),
 * plays go to the built-in player at once, so no mpv surface mounts to fail again
 * (L3-player-core-x1). Changing the player or the mpv path in Settings ends that verdict.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlayerSource, Settings } from '@/api/types';

const handlers: Record<string, (args: unknown) => unknown> = {};
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: async (name: string, args?: unknown) => {
    const h = handlers[name];
    if (!h) throw new Error(`unmocked rpc ${name}`);
    return h(args);
  },
  isDesktop: true,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const store = await import('./store');
const { markMpvUnavailable, clearMpvUnavailable } = await import('./mpvExtras');
const { usePlayerStore } = store;

const movie = (id: string): PlayerSource => ({ url: `http://h/movie/${id}.mp4`, kind: 'direct', title: `Movie ${id}`, isLive: false, isRadio: false });
const mpvSettings = (patch: Partial<Settings> = {}): Settings => ({ player: 'embedded-mpv', ...patch }) as Settings;

beforeEach(() => {
  store.__resetPlayerForTests();
  clearMpvUnavailable();
  handlers['settings.get'] = () => mpvSettings();
  store.setSettingsCache(mpvSettings());
});

afterEach(() => {
  store.__resetPlayerForTests();
  clearMpvUnavailable();
});

describe('embedded mpv known to be missing (L3-player-core-x1)', () => {
  it('plays in the built-in player instead, until the mpv settings change', async () => {
    await usePlayerStore.getState().play(movie('1'));
    expect(usePlayerStore.getState().mode).toBe('embedded-mpv');

    markMpvUnavailable();
    await usePlayerStore.getState().play(movie('2'));
    expect(usePlayerStore.getState().mode).toBe('inline');

    // A new mpv path in Settings: embedded mpv is tried again.
    store.setSettingsCache(mpvSettings({ mpvPath: 'D:/tools/mpv.exe' }));
    await usePlayerStore.getState().play(movie('3'));
    expect(usePlayerStore.getState().mode).toBe('embedded-mpv');
  });
});

describe('embedded mpv VOD switching', () => {
  it('waits for unload when a caller plays the next movie directly', async () => {
    await usePlayerStore.getState().play(movie('1'));
    let finishUnload: () => void = () => undefined;
    const unload = vi.fn(() => new Promise<void>((resolve) => { finishUnload = resolve; }));
    handlers['mpv.unload'] = unload;

    const next = usePlayerStore.getState().play(movie('2'));
    await vi.waitFor(() => expect(unload).toHaveBeenCalledOnce());
    expect(usePlayerStore.getState().source?.url).toBe(movie('1').url);
    finishUnload();
    await next;
    expect(usePlayerStore.getState().source?.url).toBe(movie('2').url);
  });

  it('unloads the previous movie before starting the next one', async () => {
    await usePlayerStore.getState().play(movie('1'));
    let finishUnload: () => void = () => undefined;
    const unload = vi.fn(() => new Promise<void>((resolve) => { finishUnload = resolve; }));
    handlers['mpv.unload'] = unload;

    const next = store.playSource(movie('2'));
    await vi.waitFor(() => expect(unload).toHaveBeenCalledOnce());
    expect(usePlayerStore.getState().source).toMatchObject({ url: '', title: 'Movie 2' });
    expect(usePlayerStore.getState().status).toBe('loading');
    // A late error from the stopped file belongs to movie 1, not movie 2.
    store.reportStatus('error', 'old stream disconnected');
    expect(usePlayerStore.getState().status).toBe('loading');

    finishUnload();
    await next;
    expect(usePlayerStore.getState().source?.url).toBe(movie('2').url);
  });

  it('keeps a rapid third selection behind the pending unload', async () => {
    await usePlayerStore.getState().play(movie('1'));
    let finishUnload: () => void = () => undefined;
    handlers['mpv.unload'] = () => new Promise<void>((resolve) => { finishUnload = resolve; });

    const second = store.playSource(movie('2'));
    await vi.waitFor(() => expect(usePlayerStore.getState().source?.title).toBe('Movie 2'));
    const third = store.playSource(movie('3'));
    await vi.waitFor(() => expect(usePlayerStore.getState().source?.title).toBe('Movie 3'));
    expect(usePlayerStore.getState().source?.url).toBe('');

    finishUnload();
    await Promise.all([second, third]);
    expect(usePlayerStore.getState().source?.url).toBe(movie('3').url);
  });
});
