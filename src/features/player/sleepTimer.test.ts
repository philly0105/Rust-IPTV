/**
 * Sleep timer (C5, SC5) on fake timers: the linear fade over the last 30 s through the player
 * store's volume API (what both the web engines and embedded mpv receive), stop or pause at
 * expiry, the volume put back, and the toasts around it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { itemKey, type EpgNowNext, type ItemRef, type PlayerSource } from '@/api/types';

const handlers: Record<string, (args: unknown) => unknown> = {};
const rpcMock = vi.fn(async (name: string, args?: unknown) => {
  const h = handlers[name];
  if (!h) throw new Error(`unmocked rpc ${name}`);
  return h(args);
});

vi.mock('@/api/transport', () => ({
  rpc: (name: string, args?: unknown) => rpcMock(name, args),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));

// A fade cut short by closing the app: its marker is read when the module loads.
localStorage.setItem('player.volume', JSON.stringify({ volume: 0.05, muted: false }));
localStorage.setItem('player.sleepFade', JSON.stringify({ volume: 0.7 }));

const store = await import('./store');
const media = await import('./media');
const nowNext = await import('./nowNext');
const sleep = await import('./sleepTimer');
const { useToastStore } = await import('@/ui/Toast');
const { usePlayerStore } = store;
const { useSleepTimer, useSleepTimerExtras, SLEEP_FADE_KEY } = sleep;

const volumeAtLoad = usePlayerStore.getState().volume;
const markerAtLoad = localStorage.getItem(SLEEP_FADE_KEY);

const MIN = 60_000;
const T0 = Date.parse('2026-10-13T21:00:00Z');

const liveRef: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '101' };
const live: PlayerSource = { url: 'http://h/live/101.m3u8', kind: 'hls', title: 'News 24', isLive: true, isRadio: false, ref: liveRef };
const movie: PlayerSource = {
  url: 'http://h/movie/7.mp4',
  kind: 'direct',
  title: 'The Long Night',
  isLive: false,
  isRadio: false,
  ref: { sourceId: 's1', contentType: 'movie', itemId: '7' },
};

/** The surface the store drives: records every level the fade sets. */
function controller() {
  return { play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(), setVolume: vi.fn(), setMuted: vi.fn() };
}
let ctl: ReturnType<typeof controller>;

function playing(source: PlayerSource, extra: Partial<ReturnType<typeof usePlayerStore.getState>> = {}): void {
  usePlayerStore.setState({ source, mode: 'inline', status: 'playing', volume: 0.8, muted: false, dock: 'stage', ...extra });
  // Registration pushed the starting level: count only what follows.
  ctl.setVolume.mockClear();
}

/** Plays along for `seconds` of wall time, the position moving at `rate`, one tick a second. */
async function playAlong(seconds: number, rate = 1): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    usePlayerStore.setState({ positionSeconds: usePlayerStore.getState().positionSeconds + rate });
    await vi.advanceTimersByTimeAsync(1000);
  }
}

const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
const volume = (): number => usePlayerStore.getState().volume;
const toasts = () => useToastStore.getState().toasts;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  for (const k of Object.keys(handlers)) delete handlers[k];
  rpcMock.mockClear();
  store.__resetPlayerForTests();
  media.resetMedia();
  nowNext.__resetNowNextForTests();
  sleep.__resetSleepTimerForTests();
  useToastStore.setState({ toasts: [] });
  handlers['settings.get'] = () => ({ epgOffsetMinutes: 0, epgShortFallback: false });
  handlers['positions.set'] = () => undefined;
  handlers['recent.add'] = () => undefined;
  ctl = controller();
  store.setController(ctl);
});

afterEach(() => {
  sleep.__resetSleepTimerForTests();
  store.__resetPlayerForTests();
  vi.useRealTimers();
});

describe('interrupted fade', () => {
  it('puts back the level from before a fade the app closed during', () => {
    expect(volumeAtLoad).toBe(0.7);
    expect(markerAtLoad).toBeNull();
  });
});

describe('sleep timer: fade, stop, restore (SC5)', () => {
  it('ramps the volume linearly to 0 over the last 30 s, stops live playback at expiry, and restores the volume', async () => {
    playing(live);
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 });
    expect(useSleepTimer.getState()).toMatchObject({ target: { kind: 'minutes', minutes: 15 }, endsAt: T0 + 15 * MIN, fading: false });

    // Untouched until the last 30 s.
    await advance(14 * MIN + 29_000);
    expect(useSleepTimer.getState().fading).toBe(false);
    expect(volume()).toBe(0.8);
    ctl.setVolume.mockClear();

    // Linear: the share of the 30 s left, times the level before the fade.
    const samples: number[] = [];
    for (const left of [25, 20, 15, 10, 5, 1]) {
      await advance(T0 + 15 * MIN - left * 1000 - Date.now());
      expect(useSleepTimer.getState().fading).toBe(true);
      expect(Math.abs(volume() - 0.8 * (left / 30))).toBeLessThan(0.01);
      samples.push(volume());
    }
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeLessThan(samples[i - 1]!);
    // Every step reached the surface through the store's public volume API.
    const sent = ctl.setVolume.mock.calls.map((c) => c[0] as number);
    expect(sent.length).toBeGreaterThan(100);
    for (let i = 1; i < sent.length; i++) expect(sent[i]).toBeLessThanOrEqual(sent[i - 1]!);
    expect(usePlayerStore.getState().source).toBe(live);

    await advance(1000);
    const s = usePlayerStore.getState();
    expect(s.source).toBeUndefined();
    expect(s.status).toBe('idle');
    // Silence on the way out, then the earlier level back for next time.
    const tail = ctl.setVolume.mock.calls.map((c) => c[0] as number).slice(-2);
    expect(tail).toEqual([0, 0.8]);
    expect(volume()).toBe(0.8);
    expect(s.muted).toBe(false);
    expect(useSleepTimer.getState()).toMatchObject({ target: null, endsAt: null, fading: false });
    expect(localStorage.getItem(SLEEP_FADE_KEY)).toBeNull();
    expect(toasts().at(-1)).toMatchObject({ id: sleep.SLEEP_DONE_TOAST, title: 'Sleep timer stopped playback' });
  });

  it('pauses VOD instead of stopping it, and restores the volume', async () => {
    playing(movie, { positionSeconds: 600, durationSeconds: 6000 });
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 30 });
    await advance(30 * MIN - 15_000);
    expect(Math.abs(volume() - 0.4)).toBeLessThan(0.01);
    await advance(15_000);
    expect(ctl.pause).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().source).toBe(movie);
    expect(volume()).toBe(0.8);
    expect(useSleepTimer.getState().target).toBeNull();
    // Paused on screen (maybe fullscreen, where toasts are hidden): the readout says so too.
    expect(media.useMediaStore.getState().osd).toMatchObject({ primary: 'Sleep timer', secondary: 'Sleep timer stopped playback' });
  });

  it('keeps the level a person sets during the fade (nothing restored over it)', async () => {
    playing(live);
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 });
    await advance(15 * MIN - 20_000);
    expect(volume()).toBeLessThan(0.8);
    usePlayerStore.getState().setVolume(0.5);
    await advance(10_000);
    expect(volume()).toBe(0.5);
    await advance(10_000);
    expect(usePlayerStore.getState().source).toBeUndefined();
    expect(volume()).toBe(0.5);
  });

  it('keeps the level an arrow key sets during the fade', async () => {
    playing(live);
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 });
    await advance(15 * MIN - 15_000);
    usePlayerStore.getState().adjustVolume(0.05);
    const set = volume();
    expect(set).toBeCloseTo(0.45, 2);
    await advance(15_000);
    expect(usePlayerStore.getState().source).toBeUndefined();
    expect(volume()).toBe(set);
    expect(localStorage.getItem(SLEEP_FADE_KEY)).toBeNull();
  });

  it('a mute during the fade only silences it: the level before comes back at expiry, still muted', async () => {
    playing(live);
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 });
    await advance(15 * MIN - 10_000);
    expect(Math.abs(volume() - 0.8 / 3)).toBeLessThan(0.01);
    usePlayerStore.getState().toggleMute();
    ctl.setVolume.mockClear();
    await advance(5_000);
    // The ramp holds while muted (a level write would lift the mute); the restore marker stays.
    expect(ctl.setVolume).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().muted).toBe(true);
    expect(JSON.parse(localStorage.getItem(SLEEP_FADE_KEY)!)).toEqual({ volume: 0.8 });
    await advance(5_000);
    expect(usePlayerStore.getState().source).toBeUndefined();
    expect(usePlayerStore.getState()).toMatchObject({ volume: 0.8, muted: true });
    expect(JSON.parse(localStorage.getItem('player.volume')!)).toEqual({ volume: 0.8, muted: true });
    expect(localStorage.getItem(SLEEP_FADE_KEY)).toBeNull();
  });

  it('an unmute during the fade carries on fading, and the level before still comes back', async () => {
    playing(live);
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 });
    await advance(15 * MIN - 20_000);
    usePlayerStore.getState().toggleMute();
    await advance(5_000);
    usePlayerStore.getState().toggleMute();
    await advance(5_000);
    expect(usePlayerStore.getState().muted).toBe(false);
    expect(Math.abs(volume() - 0.8 / 3)).toBeLessThan(0.01);
    await advance(10_000);
    expect(usePlayerStore.getState().source).toBeUndefined();
    expect(usePlayerStore.getState()).toMatchObject({ volume: 0.8, muted: false });
  });

  it('Cancel after a mute during the fade puts the level back and keeps the mute', async () => {
    playing(live);
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 });
    await advance(15 * MIN - 10_000);
    usePlayerStore.getState().toggleMute();
    ctl.setMuted.mockClear();
    useSleepTimer.getState().cancel();
    // The level comes back on a still-muted surface: no unmute blip on the way.
    expect(ctl.setMuted).not.toHaveBeenCalledWith(false);
    expect(ctl.setVolume).toHaveBeenLastCalledWith(0.8);
    expect(usePlayerStore.getState()).toMatchObject({ source: live, volume: 0.8, muted: true });
    expect(JSON.parse(localStorage.getItem('player.volume')!)).toEqual({ volume: 0.8, muted: true });
    expect(localStorage.getItem(SLEEP_FADE_KEY)).toBeNull();
  });

  it('fades nothing while muted, and still stops at expiry', async () => {
    playing(live, { muted: true });
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 });
    await advance(15 * MIN - 10_000);
    expect(useSleepTimer.getState().fading).toBe(true);
    expect(ctl.setVolume).not.toHaveBeenCalled();
    await advance(10_000);
    expect(usePlayerStore.getState().source).toBeUndefined();
    expect(usePlayerStore.getState()).toMatchObject({ volume: 0.8, muted: true });
  });

  it('Cancel during the fade puts the volume back at once and keeps playing', async () => {
    playing(live);
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 });
    await advance(15 * MIN - 12_000);
    expect(useSleepTimerExtras.getState().warning).toBe(true);
    useSleepTimer.getState().cancel();
    expect(volume()).toBe(0.8);
    expect(useSleepTimer.getState()).toMatchObject({ target: null, endsAt: null, fading: false });
    expect(useSleepTimerExtras.getState().warning).toBe(false);
    await advance(10 * MIN);
    expect(usePlayerStore.getState().source).toBe(live);
    expect(volume()).toBe(0.8);
  });

  it('Keep watching adds 15 minutes from the warning and ends a fade in progress', async () => {
    playing(live);
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 });
    await advance(14 * MIN);
    expect(useSleepTimerExtras.getState().warning).toBe(true);
    await advance(40_000);
    expect(volume()).toBeLessThan(0.8);
    useSleepTimer.getState().extend(sleep.SLEEP_EXTEND_MINUTES);
    expect(useSleepTimer.getState().endsAt).toBe(T0 + 30 * MIN);
    expect(useSleepTimer.getState().fading).toBe(false);
    expect(useSleepTimerExtras.getState().warning).toBe(false);
    expect(volume()).toBe(0.8);
    await advance(T0 + 30 * MIN - 1000 - Date.now());
    expect(usePlayerStore.getState().source).toBe(live);
    await advance(1000);
    expect(usePlayerStore.getState().source).toBeUndefined();
  });

  it('raises the one-minute warning on time and drops it when the end moves away', async () => {
    playing(movie, { positionSeconds: 0, durationSeconds: 1200 });
    useSleepTimer.getState().start({ kind: 'episodeEnd' });
    expect(useSleepTimer.getState().endsAt).toBe(T0 + 1200_000);
    await advance(1200_000 - 59_000);
    usePlayerStore.setState({ positionSeconds: 1141 });
    await advance(1000);
    expect(useSleepTimerExtras.getState().warning).toBe(true);
    // Seeking back pushes the end out again.
    usePlayerStore.setState({ positionSeconds: 600 });
    await advance(1000);
    expect(useSleepTimerExtras.getState().warning).toBe(false);
    expect(useSleepTimer.getState().endsAt).toBe(Date.now() + 600_000);
  });

  it('turns off with playback stopped by other means, without touching the volume', async () => {
    playing(live);
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 45 });
    usePlayerStore.getState().stop();
    expect(useSleepTimer.getState().target).toBeNull();
    await advance(60 * MIN);
    expect(toasts()).toEqual([]);
  });

  it('does not start without in-app playback, and rejects nonsense durations', () => {
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 });
    expect(useSleepTimer.getState().target).toBeNull();
    playing(live);
    for (const minutes of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      useSleepTimer.getState().start({ kind: 'minutes', minutes });
      expect(useSleepTimer.getState().target).toBeNull();
    }
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 100_000 });
    expect(useSleepTimer.getState().endsAt).toBe(T0 + sleep.SLEEP_MAX_MINUTES * MIN);
  });
});

describe('Z cycles the presets', () => {
  it('off, 15, 30, 45, 60, 90, off', () => {
    playing(live);
    const seen = Array.from({ length: 6 }, () => {
      const target = sleep.cycleSleepTimer();
      return target?.kind === 'minutes' ? target.minutes : null;
    });
    expect(seen).toEqual([15, 30, 45, 60, 90, null]);
    expect(useSleepTimer.getState().target).toBeNull();
    // Each step counts from the press.
    sleep.cycleSleepTimer();
    sleep.cycleSleepTimer();
    expect(useSleepTimer.getState().endsAt).toBe(Date.now() + 30 * MIN);
  });

  it('turns a programme-end timer off', async () => {
    playing(live);
    handlers['epg.nowNext'] = () => ({ [itemKey(liveRef)]: guide(T0 - 10 * MIN, T0 + 20 * MIN) });
    useSleepTimer.getState().start({ kind: 'programmeEnd' });
    await advance(0);
    expect(useSleepTimer.getState().target?.kind).toBe('programmeEnd');
    expect(sleep.cycleSleepTimer()).toBeNull();
  });

  it('turns a countdown Keep watching made off, even when it lands on a preset', async () => {
    playing(live);
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 });
    await advance(14 * MIN + 40_000);
    useSleepTimer.getState().extend(sleep.SLEEP_EXTEND_MINUTES);
    expect(useSleepTimer.getState().target).toEqual({ kind: 'minutes', minutes: 15 });
    expect(sleep.cycleSleepTimer()).toBeNull();
    expect(useSleepTimer.getState().target).toBeNull();
    // A preset picked afresh steps up again.
    useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 });
    expect(sleep.cycleSleepTimer()).toEqual({ kind: 'minutes', minutes: 30 });
  });
});

function guide(start: number, end: number): EpgNowNext {
  return {
    now: { channelId: 'news', title: 'Evening News', start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    next: { channelId: 'news', title: 'Weather', start: new Date(end).toISOString(), end: new Date(end + 30 * MIN).toISOString() },
  };
}

describe('until the programme ends', () => {
  it('ends with the programme airing now, from the guide', async () => {
    playing(live);
    handlers['epg.nowNext'] = () => ({ [itemKey(liveRef)]: guide(T0 - 10 * MIN, T0 + 20 * MIN) });
    useSleepTimer.getState().start({ kind: 'programmeEnd' });
    expect(useSleepTimerExtras.getState().resolving).toBe(true);
    expect(useSleepTimer.getState().endsAt).toBeNull();
    await advance(0);
    expect(useSleepTimerExtras.getState().resolving).toBe(false);
    expect(useSleepTimer.getState().endsAt).toBe(T0 + 20 * MIN);
    await advance(20 * MIN);
    expect(usePlayerStore.getState().source).toBeUndefined();
    expect(volume()).toBe(0.8);
  });

  it('turns off and says why when the channel has no guide', async () => {
    playing(live);
    handlers['epg.nowNext'] = () => ({});
    useSleepTimer.getState().start({ kind: 'programmeEnd' });
    await advance(0);
    expect(useSleepTimer.getState().target).toBeNull();
    expect(toasts().at(-1)).toMatchObject({ title: 'No guide for this channel' });
  });

  it('keeps the old end as a plain countdown after a zap', async () => {
    playing(live);
    handlers['epg.nowNext'] = () => ({ [itemKey(liveRef)]: guide(T0 - 10 * MIN, T0 + 20 * MIN) });
    useSleepTimer.getState().start({ kind: 'programmeEnd' });
    await advance(0);
    usePlayerStore.setState({ source: { ...live, title: 'Sport 1', ref: { ...liveRef, itemId: '102' } } });
    expect(useSleepTimer.getState()).toMatchObject({ target: { kind: 'minutes', minutes: 20 }, endsAt: T0 + 20 * MIN });
    // Made from another timer: Z turns it off.
    expect(sleep.cycleSleepTimer()).toBeNull();
  });

  it('a zap while the guide is still asked also ends up as the old end, as a plain countdown', async () => {
    playing(live);
    handlers['epg.nowNext'] = () => ({ [itemKey(liveRef)]: guide(T0 - 10 * MIN, T0 + 20 * MIN) });
    useSleepTimer.getState().start({ kind: 'programmeEnd' });
    expect(useSleepTimerExtras.getState().resolving).toBe(true);
    usePlayerStore.setState({ source: { ...live, title: 'Sport 1', ref: { ...liveRef, itemId: '102' } } });
    expect(useSleepTimer.getState()).toMatchObject({ target: { kind: 'programmeEnd' }, endsAt: null });
    await advance(0);
    expect(useSleepTimerExtras.getState().resolving).toBe(false);
    expect(useSleepTimer.getState()).toMatchObject({ target: { kind: 'minutes', minutes: 20 }, endsAt: T0 + 20 * MIN });
    expect(sleep.cycleSleepTimer()).toBeNull();
  });
});

describe('until the episode or movie ends', () => {
  it('pauses where the item ends, following the position at the playback speed', async () => {
    playing(movie, { positionSeconds: 3000, durationSeconds: 3600 });
    media.useMediaStore.setState({ rate: 2 });
    useSleepTimer.getState().start({ kind: 'episodeEnd' });
    expect(useSleepTimer.getState().endsAt).toBe(T0 + 300_000);
    await playAlong(280, 2);
    expect(ctl.pause).not.toHaveBeenCalled();
    expect(Math.abs(volume() - 0.8 * (20 / 30))).toBeLessThan(0.02);
    await playAlong(20, 2);
    expect(ctl.pause).toHaveBeenCalledTimes(1);
    expect(volume()).toBe(0.8);
  });

  it('waits for the length when it is not known yet', async () => {
    playing(movie, { positionSeconds: 0, durationSeconds: undefined });
    useSleepTimer.getState().start({ kind: 'episodeEnd' });
    expect(useSleepTimer.getState()).toMatchObject({ target: { kind: 'episodeEnd' }, endsAt: null });
    usePlayerStore.setState({ durationSeconds: 1800, positionSeconds: 10 });
    await advance(1000);
    expect(useSleepTimer.getState().endsAt).toBe(Date.now() + 1790_000);
  });

  it('is refused for live TV, and turns off when live TV replaces the item', () => {
    playing(live);
    useSleepTimer.getState().start({ kind: 'episodeEnd' });
    expect(useSleepTimer.getState().target).toBeNull();
    playing(movie, { durationSeconds: 3600 });
    useSleepTimer.getState().start({ kind: 'episodeEnd' });
    expect(useSleepTimer.getState().target?.kind).toBe('episodeEnd');
    usePlayerStore.setState({ source: live });
    expect(useSleepTimer.getState().target).toBeNull();
    expect(toasts().at(-1)).toMatchObject({ title: 'Sleep timer off' });
  });
});
