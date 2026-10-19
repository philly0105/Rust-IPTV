import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, ItemRef, PlayerSource, Settings } from '@/api/types';

const handlers: Record<string, (args: unknown) => unknown> = {};
const rpcMock = vi.fn(async (name: string, args?: unknown) => {
  const h = handlers[name];
  if (!h) throw new Error(`unmocked rpc ${name}`);
  return h(args);
});

const env = vi.hoisted(() => ({ desktop: false }));
vi.mock('@/api/transport', () => ({
  rpc: (name: string, args?: unknown) => rpcMock(name, args),
  get isDesktop() {
    return env.desktop;
  },
  proxiedUrl: (s: { url: string }) => s.url,
}));
// The parental gate has its own tests (parentalHook.test.ts); here everything may play.
vi.mock('./parentalHook', () => ({ ensurePlaybackAllowed: async () => true }));
const invalidateWatched = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/features/vod/lib/watchedQueries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/vod/lib/watchedQueries')>()),
  invalidateWatched: () => invalidateWatched(),
}));

const store = await import('./store');
const media = await import('./media');
const nowNext = await import('./nowNext');
const { queryClient, rpcKey } = await import('@/api/query');
const { itemKey } = await import('@/api/types');
const { usePlayerStore, playItem, playChannel, playSource, restorePlayback, zap, zapToNumber, handleEnded, registerStage, RESUME_KEY, SAVE_INTERVAL_MS } =
  store;

const liveRef: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '101' };
const movieRef: ItemRef = { sourceId: 's1', contentType: 'movie', itemId: '201' };

function vod(id: string, extra: Partial<PlayerSource> = {}): PlayerSource {
  return {
    url: `http://h/movie/${id}.mp4`,
    kind: 'direct',
    title: `Movie ${id}`,
    isLive: false,
    isRadio: false,
    ref: { sourceId: 's1', contentType: 'movie', itemId: id },
    ...extra,
  };
}

function channel(n: number, extra: Partial<Channel> = {}): Channel {
  return {
    ref: { sourceId: 's1', contentType: 'live', itemId: String(100 + n) },
    name: `Channel ${n}`,
    number: n,
    categoryId: 'news',
    categoryName: 'News',
    isRadio: false,
    ...extra,
  };
}

const calls = (name: string): unknown[] => rpcMock.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
  rpcMock.mockClear();
  sessionStorage.clear();
  localStorage.clear();
  store.__resetPlayerForTests();
  media.resetMedia();
  handlers['settings.get'] = () => ({ player: 'html5', playerAutoplayNextEpisode: true });
  handlers['recent.add'] = () => undefined;
  handlers['positions.set'] = () => undefined;
  handlers['positions.get'] = () => null;
  handlers['sources.get'] = () => ({ id: 's1', kind: 'xtream' });
});

afterEach(() => {
  store.__resetPlayerForTests();
  vi.useRealTimers();
});

describe('store transitions', () => {
  it('play -> loading in the mini dock, recent.add, then stop -> idle', async () => {
    await usePlayerStore.getState().play(vod('1'));
    let s = usePlayerStore.getState();
    expect(s.status).toBe('loading');
    expect(s.mode).toBe('inline');
    expect(s.dock).toBe('mini');
    expect(calls('recent.add')).toEqual([
      {
        ref: { sourceId: 's1', contentType: 'movie', itemId: '1' },
        snapshot: expect.objectContaining({ title: 'Movie 1', contentType: 'movie' }),
      },
    ]);

    usePlayerStore.getState().stop();
    s = usePlayerStore.getState();
    expect(s.status).toBe('idle');
    expect(s.source).toBeUndefined();
    expect(s.dock).toBe('hidden');
  });

  it('docks into a mounted stage and falls back to mini when the stage unmounts', async () => {
    const unregister = registerStage();
    await usePlayerStore.getState().play(vod('1'));
    expect(usePlayerStore.getState().dock).toBe('stage');
    unregister();
    expect(usePlayerStore.getState().dock).toBe('mini');
  });

  it('drives the registered controller', async () => {
    const ctl = { play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(), setVolume: vi.fn(), setMuted: vi.fn() };
    store.setController(ctl);
    await usePlayerStore.getState().play(vod('1'));
    store.reportStatus('playing');
    store.reportProgress(30, 100);
    usePlayerStore.getState().togglePlay();
    expect(ctl.pause).toHaveBeenCalled();
    usePlayerStore.getState().seekBy(500);
    expect(ctl.seekTo).toHaveBeenLastCalledWith(100);
    usePlayerStore.getState().setVolume(1.7);
    expect(usePlayerStore.getState().volume).toBe(1);
    usePlayerStore.getState().toggleMute();
    expect(ctl.setMuted).toHaveBeenLastCalledWith(true);
    expect(usePlayerStore.getState().muted).toBe(true);
  });

  it('external player setting opens vlc and hides the dock (desktop)', async () => {
    env.desktop = true;
    try {
      handlers['settings.get'] = () => ({ player: 'vlc' });
      handlers['player.openExternal'] = () => undefined;
      await usePlayerStore.getState().play(vod('1'));
      const s = usePlayerStore.getState();
      expect(s.mode).toBe('external');
      expect(s.dock).toBe('hidden');
      expect(s.status).toBe('playing');
      expect(calls('player.openExternal')).toEqual([
        { player: 'vlc', source: expect.objectContaining({ url: 'http://h/movie/1.mp4' }) },
      ]);
      expect(sessionStorage.getItem(RESUME_KEY)).toBeNull();
    } finally {
      env.desktop = false;
    }
  });

  it('a saved mpv or vlc plays in the built-in player in the browser', async () => {
    for (const player of ['mpv', 'vlc'] as const) {
      store.setSettingsCache({ player } as Settings);
      await usePlayerStore.getState().play(vod('1'));
      expect(usePlayerStore.getState().mode).toBe('inline');
    }
    expect(calls('player.openExternal')).toEqual([]);
    expect(store.modeForSettings('mpv', { ...vod('2'), isRadio: true })).toBe('radio');
  });

  it('embedded-mpv falls back to inline outside the desktop shell; radio gets radio mode', async () => {
    handlers['settings.get'] = () => ({ player: 'embedded-mpv' });
    await usePlayerStore.getState().play(vod('1'));
    expect(usePlayerStore.getState().mode).toBe('inline');
    expect(store.modeForSettings('html5', { ...vod('2'), isRadio: true })).toBe('radio');
    env.desktop = true;
    expect(store.modeForSettings('mpv', { ...vod('2'), isRadio: true })).toBe('external');
    env.desktop = false;
  });

  it('queue next/prev and the autoplay-next card at the end', async () => {
    const queue = [vod('1'), vod('2'), vod('3')];
    await usePlayerStore.getState().play(queue[1]!, { queue });
    expect(store.nextInQueue()?.ref?.itemId).toBe('3');
    expect(store.prevInQueue()?.ref?.itemId).toBe('1');

    store.reportProgress(90, 100);
    handleEnded();
    expect(usePlayerStore.getState().status).toBe('paused');
    expect(media.useMediaStore.getState().upNext?.source.ref?.itemId).toBe('3');
    expect(calls('positions.set').at(-1)).toMatchObject({ positionSeconds: 100, durationSeconds: 100 });

    usePlayerStore.getState().next();
    await flush();
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('3');
    expect(usePlayerStore.getState().queue).toHaveLength(3);
  });
});

describe('startup and stall watchdog', () => {
  const { reportStatus, STARTUP_TIMEOUT_MS } = store;

  it('a stream that never starts (401 Basic, no engine event) ends in a timeout error with Retry', async () => {
    vi.useFakeTimers();
    await usePlayerStore.getState().play(vod('1'));
    expect(usePlayerStore.getState().status).toBe('loading');
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS - 1);
    expect(usePlayerStore.getState().status).toBe('loading');
    await vi.advanceTimersByTimeAsync(1);
    expect(usePlayerStore.getState().status).toBe('error');
    expect(media.useMediaStore.getState().errorCode).toBe('timeout');
    const { classifyStreamError } = await import('./errors');
    expect(classifyStreamError({ code: 'timeout', message: usePlayerStore.getState().error })).toBe('timeout');
  });

  it('starting playback, pausing, stopping or switching items disarms or restarts it', async () => {
    vi.useFakeTimers();
    await usePlayerStore.getState().play(vod('1'));
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS - 1000);
    reportStatus('playing');
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS * 2);
    expect(usePlayerStore.getState().status).toBe('playing');

    // A stall later in playback gets a fresh full window.
    reportStatus('loading');
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS - 1);
    expect(usePlayerStore.getState().status).toBe('loading');
    reportStatus('paused');
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS);
    expect(usePlayerStore.getState().status).toBe('paused');

    await usePlayerStore.getState().play(vod('2'));
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS - 1000);
    await usePlayerStore.getState().play(vod('3'));
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS - 1000);
    expect(usePlayerStore.getState().status).toBe('loading');
    usePlayerStore.getState().stop();
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS * 2);
    expect(usePlayerStore.getState().status).toBe('idle');
  });
});

describe('up next and queue advance', () => {
  /** A queue entry the way series pages build them: no URL yet, resolved on advance. */
  const placeholder = (ep: string): PlayerSource => ({
    url: '',
    kind: 'direct',
    title: `Episode ${ep}`,
    isLive: false,
    isRadio: false,
    ref: { sourceId: 's1', contentType: 'series', itemId: '9' },
    episodeId: ep,
  });

  it('the countdown advances by itself, with no card mounted', async () => {
    vi.useFakeTimers();
    const queue = [vod('1'), vod('2')];
    await usePlayerStore.getState().play(queue[0]!, { queue });
    store.reportProgress(100, 100);
    handleEnded();
    expect(media.useMediaStore.getState().upNext).toBeTruthy();
    await vi.advanceTimersByTimeAsync(media.UP_NEXT_SECONDS * 1000 + 50);
    expect(media.useMediaStore.getState().upNext).toBeUndefined();
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('2');
  });

  it('seeking back into the episode cancels the countdown', async () => {
    vi.useFakeTimers();
    const queue = [vod('1'), vod('2')];
    await usePlayerStore.getState().play(queue[0]!, { queue });
    store.reportProgress(100, 100);
    handleEnded();
    usePlayerStore.getState().seekTo(40);
    expect(media.useMediaStore.getState().upNext).toBeUndefined();
    await vi.advanceTimersByTimeAsync(media.UP_NEXT_SECONDS * 1000 + 50);
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('1');
  });

  it('next() resolves a placeholder entry and resumes its saved position', async () => {
    handlers['xtream.streamUrl'] = (a) => ({
      url: `http://x/series/${(a as { episodeId: string }).episodeId}.mkv`,
      kind: 'direct',
      title: 'srv',
      isLive: false,
      isRadio: false,
    });
    handlers['positions.get'] = (a) =>
      (a as { episodeId?: string }).episodeId === 'e2' ? { positionSeconds: 300, durationSeconds: 1200, updatedAt: '' } : null;
    const queue = [placeholder('e1'), placeholder('e2')];
    await usePlayerStore.getState().play({ ...queue[0]!, url: 'http://x/series/e1.mkv' }, { queue });
    usePlayerStore.getState().next();
    await vi.waitFor(() => expect(usePlayerStore.getState().source?.url).toBe('http://x/series/e2.mkv'));
    expect(calls('xtream.streamUrl').at(-1)).toMatchObject({ episodeId: 'e2' });
    expect(usePlayerStore.getState().source).toMatchObject({ episodeId: 'e2', title: 'Episode e2', resumeSeconds: 300 });
    expect(usePlayerStore.getState().queue).toHaveLength(2);
  });

  it('a failed advance shows the error on the new item, and Retry resolves again', async () => {
    let fail = true;
    handlers['xtream.streamUrl'] = () => {
      if (fail) throw Object.assign(new Error('HTTP 403'), { code: 'auth' });
      return { url: 'http://x/series/e2.mkv', kind: 'direct', title: 'srv', isLive: false, isRadio: false };
    };
    const queue = [placeholder('e1'), placeholder('e2')];
    await usePlayerStore.getState().play({ ...queue[0]!, url: 'http://x/series/e1.mkv' }, { queue });
    usePlayerStore.getState().next();
    await vi.waitFor(() => expect(usePlayerStore.getState().status).toBe('error'));
    // The error belongs to episode 2, with no media URL left from episode 1.
    expect(usePlayerStore.getState().source).toMatchObject({ episodeId: 'e2', url: '' });
    expect(media.useMediaStore.getState().errorCode).toBe('auth');

    fail = false;
    expect(store.retryResolve()).toBe(true);
    await vi.waitFor(() => expect(usePlayerStore.getState().source?.url).toBe('http://x/series/e2.mkv'));
    expect(media.useMediaStore.getState().errorCode).toBeUndefined();
  });

  it('retryResolve leaves media errors to the surface', async () => {
    await usePlayerStore.getState().play(vod('1'));
    store.reportStatus('error', 'HTTP 404');
    expect(store.retryResolve()).toBe(false);
  });

  it.each([
    ['marked watched, core resume mid-way', { positionSeconds: 600, durationSeconds: 1200, watched: true }, 600],
    ['kept at its end (C13), core resume at the end', { positionSeconds: 1200, durationSeconds: 1200, watched: true }, 1200],
    ['finished past 95 %, not flagged', { positionSeconds: 1170, durationSeconds: 1200, watched: false }, 1170],
  ])('a direct play of an episode %s starts at 0', async (_name, row, coreResume) => {
    handlers['sources.get'] = () => ({ id: 's1', kind: 'xtream' });
    handlers['xtream.streamUrl'] = () => ({
      url: 'http://x/series/e5.mkv',
      kind: 'direct',
      title: 'srv',
      isLive: false,
      isRadio: false,
      resumeSeconds: coreResume,
    });
    handlers['positions.get'] = () => ({ ref: { sourceId: 's1', contentType: 'series', itemId: '9' }, episodeId: 'e5', updatedAt: '', ...row });
    await playItem({ ref: { sourceId: 's1', contentType: 'series', itemId: '9' }, episodeId: 'e5', title: 'Show', isLive: false, sourceKind: 'xtream' });
    expect(usePlayerStore.getState().source?.url).toBe('http://x/series/e5.mkv');
    expect(usePlayerStore.getState().source?.resumeSeconds).toBeUndefined();
    expect(usePlayerStore.getState().positionSeconds).toBe(0);
  });

  it('a core resume on an unfinished episode is kept, and kept when the saved row cannot be read', async () => {
    handlers['xtream.streamUrl'] = () => ({ url: 'http://x/series/e5.mkv', kind: 'direct', title: 'srv', isLive: false, isRadio: false, resumeSeconds: 300 });
    handlers['positions.get'] = () => ({ ref: { sourceId: 's1', contentType: 'series', itemId: '9' }, episodeId: 'e5', positionSeconds: 300, durationSeconds: 1200, updatedAt: '', watched: false });
    const args = { ref: { sourceId: 's1', contentType: 'series' as const, itemId: '9' }, episodeId: 'e5', title: 'Show', isLive: false, sourceKind: 'xtream' as const };
    await playItem(args);
    expect(usePlayerStore.getState().source?.resumeSeconds).toBe(300);
    handlers['positions.get'] = () => {
      throw new Error('db busy');
    };
    await playItem(args);
    expect(usePlayerStore.getState().source?.resumeSeconds).toBe(300);
  });

  it('a resume of a few seconds is not applied', async () => {
    handlers['positions.get'] = () => ({ ref: movieRef, positionSeconds: 3, durationSeconds: 1000, updatedAt: '' });
    await playSource(vod('201'));
    expect(usePlayerStore.getState().source?.resumeSeconds).toBeUndefined();
    await playSource(vod('202', { resumeSeconds: 4 }));
    expect(usePlayerStore.getState().source?.resumeSeconds).toBeUndefined();
    await playSource(vod('203', { resumeSeconds: 60 }));
    expect(usePlayerStore.getState().source?.resumeSeconds).toBe(60);
  });
});

describe('resume persistence', () => {
  it('writes sessionStorage on play and positions.set every 5 s for VOD', async () => {
    vi.useFakeTimers();
    await usePlayerStore.getState().play(vod('1'));
    expect(JSON.parse(sessionStorage.getItem(RESUME_KEY)!)).toMatchObject({
      source: { url: 'http://h/movie/1.mp4' },
      mode: 'inline',
    });

    store.reportStatus('playing');
    store.reportProgress(42.7, 600);
    vi.advanceTimersByTime(SAVE_INTERVAL_MS);
    expect(calls('positions.set')).toEqual([
      expect.objectContaining({
        ref: { sourceId: 's1', contentType: 'movie', itemId: '1' },
        positionSeconds: 42,
        durationSeconds: 600,
      }),
    ]);
    expect(JSON.parse(sessionStorage.getItem(RESUME_KEY)!).positionSeconds).toBeCloseTo(42.7);

    // No progress, no duplicate write.
    vi.advanceTimersByTime(SAVE_INTERVAL_MS);
    expect(calls('positions.set')).toHaveLength(1);

    store.reportProgress(50, 600);
    usePlayerStore.getState().stop();
    expect(calls('positions.set').at(-1)).toMatchObject({ positionSeconds: 50 });
    expect(sessionStorage.getItem(RESUME_KEY)).toBeNull();
  });

  it('tray Quit saves a seek made since the last 5 s save, and the quit waits for it', async () => {
    const { QUIT_FLUSH_EVENT } = await import('@/api/window');
    let landed = false;
    handlers['positions.set'] = async () => {
      await new Promise((r) => setTimeout(r, 5));
      landed = true;
    };
    await usePlayerStore.getState().play(vod('1'));
    store.reportStatus('playing');
    store.reportProgress(300, 600); // a seek, 2 s before the next periodic save
    const work: Promise<unknown>[] = [];
    window.dispatchEvent(new CustomEvent(QUIT_FLUSH_EVENT, { detail: { waitUntil: (p: Promise<unknown>) => work.push(p) } }));
    expect(calls('positions.set').at(-1)).toMatchObject({ positionSeconds: 300 });
    expect(JSON.parse(sessionStorage.getItem(RESUME_KEY)!).positionSeconds).toBe(300);
    expect(work).toHaveLength(1);
    expect(landed).toBe(false);
    await Promise.all(work);
    expect(landed).toBe(true);
  });

  it('does not track positions for live channels', async () => {
    vi.useFakeTimers();
    await usePlayerStore
      .getState()
      .play({ url: 'http://h/live.m3u8', kind: 'hls', title: 'Live', isLive: true, isRadio: false, ref: liveRef });
    store.reportStatus('playing');
    store.reportProgress(120);
    vi.advanceTimersByTime(SAVE_INTERVAL_MS * 2);
    expect(calls('positions.set')).toHaveLength(0);
  });

  it('restorePlayback replays the saved item with its position', async () => {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({ source: vod('7'), positionSeconds: 321, mode: 'inline', savedAt: 1 }));
    await expect(restorePlayback()).resolves.toBe(true);
    const s = usePlayerStore.getState();
    expect(s.source?.ref?.itemId).toBe('7');
    expect(s.source?.resumeSeconds).toBe(321);
    expect(s.positionSeconds).toBe(321);
  });

  it('restorePlayback ignores missing, corrupt and external records', async () => {
    await expect(restorePlayback()).resolves.toBe(false);
    sessionStorage.setItem(RESUME_KEY, '{nope');
    await expect(restorePlayback()).resolves.toBe(false);
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({ source: vod('7'), positionSeconds: 3, mode: 'external' }));
    await expect(restorePlayback()).resolves.toBe(false);
    expect(usePlayerStore.getState().source).toBeUndefined();
  });

  it('playSource picks up a saved backend position below 95 %', async () => {
    handlers['positions.get'] = () => ({ ref: movieRef, positionSeconds: 400, durationSeconds: 1000, updatedAt: '' });
    await playSource(vod('201'));
    expect(usePlayerStore.getState().source?.resumeSeconds).toBe(400);
    handlers['positions.get'] = () => ({ ref: movieRef, positionSeconds: 990, durationSeconds: 1000, updatedAt: '' });
    await playSource(vod('202'));
    expect(usePlayerStore.getState().source?.resumeSeconds).toBeUndefined();
  });
});

describe('playItem resolution by kind', () => {
  const base = { title: 'Demo', isLive: true } as const;

  it('xtream uses xtream.streamUrl', async () => {
    handlers['xtream.streamUrl'] = () => ({ url: 'http://x/live/101.m3u8', kind: 'hls', title: 'srv', isLive: true, isRadio: false });
    await playItem({ ...base, ref: liveRef, sourceKind: 'xtream' });
    expect(calls('xtream.streamUrl')).toEqual([{ ref: liveRef }]);
    expect(usePlayerStore.getState().source).toMatchObject({
      url: 'http://x/live/101.m3u8',
      kind: 'hls',
      title: 'Demo',
      ref: liveRef,
    });
  });

  it('stalker uses stalker.streamUrl with the episode id', async () => {
    const ref: ItemRef = { sourceId: 's2', contentType: 'series', itemId: '9' };
    handlers['stalker.streamUrl'] = () => ({ url: 'http://st/e.mp4', kind: 'direct', title: 'x', isLive: false, isRadio: false });
    await playItem({ title: 'Show', isLive: false, ref, episodeId: 'e3', sourceKind: 'stalker' });
    expect(calls('stalker.streamUrl')).toEqual([{ ref, episodeId: 'e3' }]);
    expect(usePlayerStore.getState().source).toMatchObject({ url: 'http://st/e.mp4', episodeId: 'e3' });
  });

  it('m3u uses the catalog.item url plus the source headers', async () => {
    handlers['catalog.item'] = () => ({ ...channel(1), url: 'http://m/stream.mpd' });
    handlers['sources.get'] = () => ({ id: 's1', kind: 'm3u', m3u: { headers: { userAgent: 'UA/1', referer: '' } } });
    await playItem({ ...base, ref: liveRef, sourceKind: 'm3u' });
    expect(usePlayerStore.getState().source).toMatchObject({
      url: 'http://m/stream.mpd',
      kind: 'dash',
      headers: { userAgent: 'UA/1' },
    });
  });

  it('an m3u item without a url ends in the error state', async () => {
    handlers['catalog.item'] = () => channel(1);
    await expect(playItem({ ...base, ref: liveRef, sourceKind: 'm3u' })).rejects.toThrow(/no stream URL/);
    expect(usePlayerStore.getState().status).toBe('error');
  });

  it('the newest request wins a race', async () => {
    let release!: () => void;
    handlers['xtream.streamUrl'] = (a) => {
      const id = (a as { ref: ItemRef }).ref.itemId;
      const src = { url: `http://x/${id}.m3u8`, kind: 'hls', title: id, isLive: true, isRadio: false };
      return id === 'slow' ? new Promise((r) => (release = () => r(src))) : src;
    };
    const slow = playItem({ ...base, ref: { ...liveRef, itemId: 'slow' }, sourceKind: 'xtream' });
    // Past the parental gate and waiting on its stream URL when the newer pick arrives.
    await flush();
    await playItem({ ...base, ref: { ...liveRef, itemId: 'fast' }, sourceKind: 'xtream' });
    release();
    await slow;
    expect(usePlayerStore.getState().source?.url).toBe('http://x/fast.m3u8');
  });

  it('a request overtaken while at the parental gate never resolves its stream', async () => {
    handlers['xtream.streamUrl'] = (a) => {
      const id = (a as { ref: ItemRef }).ref.itemId;
      return { url: `http://x/${id}.m3u8`, kind: 'hls', title: id, isLive: true, isRadio: false };
    };
    const first = playItem({ ...base, ref: { ...liveRef, itemId: 'first' }, sourceKind: 'xtream' });
    await playItem({ ...base, ref: { ...liveRef, itemId: 'second' }, sourceKind: 'xtream' });
    await first;
    expect(calls('xtream.streamUrl')).toEqual([{ ref: { ...liveRef, itemId: 'second' } }]);
    expect(usePlayerStore.getState().source?.url).toBe('http://x/second.m3u8');
  });

  it('kindFromUrl', () => {
    expect(store.kindFromUrl('http://a/b.m3u8?x=1')).toBe('hls');
    expect(store.kindFromUrl('http://a/b.mpd')).toBe('dash');
    expect(store.kindFromUrl('http://a/b.mp4')).toBe('direct');
  });
});

describe('zap', () => {
  beforeEach(() => {
    handlers['parental.status'] = () => ({ enabled: false });
    handlers['xtream.streamUrl'] = (a) => {
      const id = (a as { ref: ItemRef }).ref.itemId;
      return { url: `http://x/live/${id}.m3u8`, kind: 'hls', title: id, isLive: true, isRadio: false };
    };
  });

  it('uses catalog.neighbors with the zap category and plays the neighbor', async () => {
    await playItem({ title: 'Ch 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    usePlayerStore.setState({ zapContext: { sourceId: 's1', categoryId: 'news' } });
    handlers['catalog.neighbors'] = () => ({ prev: channel(0), next: channel(2) });
    const played = await zap('down');
    // The press asks once; the target's own neighbours are fetched ahead for the next press.
    expect(calls('catalog.neighbors')).toEqual([
      { ref: channel(1).ref, categoryId: 'news' },
      { ref: channel(2).ref, categoryId: 'news' },
    ]);
    expect(played?.number).toBe(2);
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('102');
    // No guide data: no subtitle (never the category), as on the list click path.
    expect(usePlayerStore.getState().source?.subtitle).toBeUndefined();
    expect(media.useMediaStore.getState().osd).toMatchObject({ primary: '2', secondary: 'Channel 2' });

    await zap('up');
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('100');
  });

  it('ignores a zap category from another source and does nothing for VOD', async () => {
    await playItem({ title: 'Ch 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    usePlayerStore.setState({ zapContext: { sourceId: 'other', categoryId: 'news' } });
    handlers['catalog.neighbors'] = () => ({});
    await expect(zap('down')).resolves.toBeUndefined();
    expect(calls('catalog.neighbors')).toEqual([{ ref: channel(1).ref }]);

    usePlayerStore.getState().stop();
    rpcMock.mockClear();
    await usePlayerStore.getState().play(vod('1'));
    await expect(zap('down')).resolves.toBeUndefined();
    expect(calls('catalog.neighbors')).toHaveLength(0);
  });

  it('titles player, OSD and resume record with the stripped name and subtitles with the airing programme', async () => {
    handlers['settings.get'] = () => ({ player: 'html5', stripCountryPrefix: true, epgOffsetMinutes: 30 });
    handlers['epg.nowNext'] = (a) => {
      const { refs } = a as { refs: ItemRef[] };
      const ref = refs[0] as ItemRef;
      const end = new Date(Date.now() + 3_600_000).toISOString();
      return { [`${ref.sourceId}|${ref.contentType}|${ref.itemId}`]: { now: { title: 'Evening News', end } } };
    };
    await playItem({ title: 'Alpha One', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    handlers['catalog.neighbors'] = () => ({ next: channel(2, { name: 'UK | Beta Two', categoryName: 'UK' }) });
    await zap('down');
    const src = usePlayerStore.getState().source;
    expect(src?.title).toBe('Beta Two');
    expect(src?.subtitle).toBe('Evening News');
    expect(media.useMediaStore.getState().osd).toMatchObject({ primary: '2', secondary: 'Beta Two' });
    expect(calls('epg.nowNext')).toEqual([{ refs: [channel(2).ref], offsetMinutes: 30 }]);
    expect(JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? '{}').source?.title).toBe('Beta Two');

    // Number zap with the setting off keeps the raw name.
    store.setSettingsCache({ player: 'html5', stripCountryPrefix: false } as never);
    handlers['catalog.channelByNumber'] = () => channel(7, { name: 'UK | Gamma' });
    await zapToNumber(7);
    expect(usePlayerStore.getState().source?.title).toBe('UK | Gamma');
  });

  it('walks lists.neighbors when the zap context names a list; digit entry keeps source numbering', async () => {
    await playItem({ title: 'Ch 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    usePlayerStore.setState({ zapContext: { sourceId: 's1', categoryId: 'news', listId: 'list-7' } });
    // The list's neighbour lives on another source: lists cross sources.
    const other = channel(9, { ref: { sourceId: 's2', contentType: 'live', itemId: '555' } });
    handlers['lists.neighbors'] = () => ({ prev: channel(0), next: other });
    const played = await zap('down');
    expect(calls('lists.neighbors')).toEqual([
      { id: 'list-7', ref: channel(1).ref },
      { id: 'list-7', ref: other.ref },
    ]);
    expect(calls('catalog.neighbors')).toHaveLength(0);
    expect(played?.ref.itemId).toBe('555');
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('555');

    // Digit entry uses the playing channel's own source numbering, not the list order.
    handlers['catalog.channelByNumber'] = () => channel(4);
    await zapToNumber(4);
    expect(calls('catalog.channelByNumber')).toEqual([{ sourceId: 's2', number: 4 }]);

    usePlayerStore.setState({ zapContext: { sourceId: 's1', listId: 'list-7' } });
    await zap('up');
    expect(calls('lists.neighbors')).toEqual([
      { id: 'list-7', ref: channel(1).ref },
      { id: 'list-7', ref: other.ref },
      { id: 'list-7', ref: channel(4).ref },
      { id: 'list-7', ref: channel(0).ref },
    ]);
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('100');
    expect(calls('catalog.neighbors')).toHaveLength(0);
  });

  it('a list that no longer holds the channel (or is gone) zaps through the channel source', async () => {
    await playItem({ title: 'Ch 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    usePlayerStore.setState({ zapContext: { sourceId: 's1', listId: 'list-7' } });
    // What the core answers when the list was deleted or the playing channel was taken out of it.
    handlers['lists.neighbors'] = () => {
      throw Object.assign(new Error('list list-7 not found'), { code: 'not_found' });
    };
    handlers['catalog.neighbors'] = () => ({ next: channel(2) });
    const played = await zap('down');
    expect(calls('lists.neighbors')).toEqual([{ id: 'list-7', ref: channel(1).ref }]);
    expect(calls('catalog.neighbors')).toEqual([{ ref: channel(1).ref }, { ref: channel(2).ref }]);
    expect(played?.ref.itemId).toBe('102');
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('102');
    // The stale list is dropped: the next press goes straight to the source.
    expect(usePlayerStore.getState().zapContext).toEqual({ sourceId: 's1' });
    await zap('down');
    expect(calls('lists.neighbors')).toHaveLength(1);
    // The press from channel 2 was answered by the fetch ahead: no new lookup.
    expect(calls('catalog.neighbors')).toHaveLength(2);

    // Other failures still reach the caller.
    usePlayerStore.setState({ zapContext: { sourceId: 's1', listId: 'list-8' } });
    handlers['lists.neighbors'] = () => {
      throw Object.assign(new Error('core down'), { code: 'internal' });
    };
    await expect(zap('down')).rejects.toThrow('core down');
  });

  it('a channel played outside the list ends list zapping; a zap and the list keep it', async () => {
    await playItem({ title: 'Ch 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    usePlayerStore.setState({ zapContext: { sourceId: 's1', listId: 'list-7' } });
    handlers['lists.neighbors'] = () => ({ next: channel(3) });
    await zap('down');
    expect(usePlayerStore.getState().zapContext).toEqual({ sourceId: 's1', listId: 'list-7' });
    // The panel steps through the list too.
    await playChannel(channel(4), 'xtream', { keepList: true });
    expect(usePlayerStore.getState().zapContext?.listId).toBe('list-7');

    // Search, history, digits, another page: the next zap must not ask the list about it.
    await playChannel(channel(5, { ref: { sourceId: 's2', contentType: 'live', itemId: '777' } }), 'xtream');
    expect(usePlayerStore.getState().zapContext).toEqual({ sourceId: 's2' });
    handlers['catalog.neighbors'] = () => ({ next: channel(6) });
    await zap('down');
    expect(calls('lists.neighbors')).toHaveLength(2);
    expect(calls('catalog.neighbors')).toEqual([{ ref: { sourceId: 's2', contentType: 'live', itemId: '777' } }, { ref: channel(6).ref }]);
  });

  it('walks the favorites in their order when playback started from favorites (F-FAVORITES-ZAP)', async () => {
    await playItem({ title: 'Ch 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    usePlayerStore.setState({ zapContext: { sourceId: 's1', favorites: {} } });
    const fav = (ch: Channel, position: number) => ({ ref: ch.ref, position, addedAt: '2026-01-01T00:00:00Z', snapshot: { title: ch.name, contentType: ch.ref.contentType } });
    const other = channel(9, { ref: { sourceId: 's2', contentType: 'live', itemId: '555' } });
    const gone = channel(8);
    // Stored order, not catalog order: 5, gone, 1, movie, radio, other source. Gone is stepped over;
    // the movie and the radio station are not live channels.
    handlers['favorites.list'] = () => [
      fav(channel(1), 2),
      fav(other, 5),
      fav(channel(5), 0),
      fav(gone, 1),
      { ...fav(channel(3), 3), ref: { sourceId: 's1', contentType: 'movie', itemId: 'm1' } },
      { ...fav(channel(4), 4), ref: { sourceId: 's1', contentType: 'radio', itemId: 'r1' } },
    ];
    handlers['catalog.item'] = (a) => {
      const id = (a as { ref: ItemRef }).ref.itemId;
      if (id === '555') return other;
      if (id === '105') return channel(5);
      if (id === '101') return channel(1);
      throw Object.assign(new Error(`item ${id} not found`), { code: 'not_found' });
    };
    const played = await zap('down');
    expect(played?.ref.itemId).toBe('555');
    expect(calls('catalog.neighbors')).toHaveLength(0);
    expect(calls('favorites.list')[0]).toEqual({});
    // Up from the first favorite wraps to the last one; from 555 the one before 1 skips "gone".
    await zap('up');
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('101');
    await zap('up');
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('105');
    expect(usePlayerStore.getState().zapContext?.favorites).toEqual({});

    // A channel that is not a favorite zaps through its source, and the favorites order ends.
    await playChannel(channel(6), 'xtream');
    expect(usePlayerStore.getState().zapContext).toEqual({ sourceId: 's1' });
    usePlayerStore.setState({ zapContext: { sourceId: 's1', favorites: { sourceId: 's1' } } });
    handlers['catalog.neighbors'] = () => ({ next: channel(7) });
    await zap('down');
    expect(calls('favorites.list').at(-1)).toEqual({ sourceId: 's1' });
    expect(calls('catalog.neighbors')[0]).toEqual({ ref: channel(6).ref });
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('107');
    expect(usePlayerStore.getState().zapContext).toEqual({ sourceId: 's1' });
  });

  it('zapToNumber resolves catalog.channelByNumber', async () => {
    await playItem({ title: 'Ch 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    handlers['catalog.channelByNumber'] = () => channel(42);
    const ch = await zapToNumber(42);
    expect(calls('catalog.channelByNumber')).toEqual([{ sourceId: 's1', number: 42 }]);
    expect(ch?.number).toBe(42);
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('142');
    handlers['catalog.channelByNumber'] = () => null;
    await expect(zapToNumber(999)).resolves.toBeUndefined();
  });
});

describe('zap bursts, catch-up zapping and channel renames', () => {
  beforeEach(() => {
    handlers['parental.status'] = () => ({ enabled: false });
    handlers['xtream.streamUrl'] = (a) => {
      const id = (a as { ref: ItemRef }).ref.itemId;
      return { url: `http://x/live/${id}.m3u8`, kind: 'hls', title: id, isLive: true, isRadio: false };
    };
    // Channels 0 to 20 in a row: each one's neighbours are the numbers either side.
    handlers['catalog.neighbors'] = (a) => {
      const n = Number((a as { ref: ItemRef }).ref.itemId) - 100;
      return { prev: n > 0 ? channel(n - 1) : null, next: n < 20 ? channel(n + 1) : null };
    };
    // An Xtream account that allows two connections (an unknown limit holds every press).
    queryClient.removeQueries({ queryKey: ['account.status'] });
    handlers['account.status'] = () => ({ sourceId: 's1', kind: 'xtream', isTrial: false, maxConnections: 2, checkedAt: new Date().toISOString() });
  });

  it('three quick presses land three channels away, move the title at once and open one stream', async () => {
    await playItem({ title: 'Channel 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    rpcMock.mockClear();
    const presses = [zap('down'), zap('down'), zap('down')];
    // Every press moves the title before any stream is asked for (L2-player-1, L2-player-3).
    await vi.waitFor(() => expect(usePlayerStore.getState().source?.title).toBe('Channel 4'));
    expect(usePlayerStore.getState().status).toBe('loading');
    expect(calls('xtream.streamUrl')).toHaveLength(0);
    const landed = await Promise.all(presses);
    expect(landed.map((c) => c?.number)).toEqual([4, 4, 4]);
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('104');
    expect(usePlayerStore.getState().source?.url).toBe('http://x/live/104.m3u8');
    // Channels 2 and 3 were passed on the way: no stream and no Recent row for them.
    expect(calls('xtream.streamUrl')).toEqual([{ ref: channel(4).ref }]);
    expect(calls('recent.add')).toEqual([expect.objectContaining({ ref: channel(4).ref })]);
    expect(media.useMediaStore.getState().osd).toMatchObject({ primary: '4', secondary: 'Channel 4' });
  });

  it('a zap during catch-up of a channel goes to the neighbour live (L2-player-5)', async () => {
    await playSource({ url: 'http://x/timeshift/101.m3u8', kind: 'hls', title: 'Channel 1', isLive: false, isRadio: false, ref: channel(1).ref });
    expect(store.canZap(usePlayerStore.getState())).toBe(true);
    const played = await zap('down');
    expect(played?.number).toBe(2);
    expect(usePlayerStore.getState().source).toMatchObject({ isLive: true, ref: channel(2).ref });
    // A movie still has no neighbours.
    expect(store.canZap({ source: vod('1') })).toBe(false);
  });

  it('a rename of the playing channel retitles the player (L2-player-11)', async () => {
    await playItem({ title: 'Channel 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    handlers['catalog.item'] = () => channel(1, { name: 'UK | Channel One HD' });
    store.setSettingsCache({ player: 'html5', stripCountryPrefix: true } as never);
    await store.refreshPlayingChannel('s2');
    expect(calls('catalog.item')).toHaveLength(0);
    await store.refreshPlayingChannel('s1');
    expect(usePlayerStore.getState().source?.title).toBe('Channel One HD');
    expect(usePlayerStore.getState().source?.url).toBe('http://x/live/101.m3u8');
  });

  it('a single press tunes at once, without waiting for the burst to go quiet (L3-player-2)', async () => {
    await playItem({ title: 'Channel 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    rpcMock.mockClear();
    vi.useFakeTimers();
    const press = zap('down');
    await vi.advanceTimersByTimeAsync(store.ZAP_SETTLE_MS - 50);
    // The stream is asked for and playing before ZAP_SETTLE_MS has passed.
    expect(calls('xtream.streamUrl')).toEqual([{ ref: channel(2).ref }]);
    expect(usePlayerStore.getState().source?.url).toBe('http://x/live/102.m3u8');
    await vi.advanceTimersByTimeAsync(1000);
    expect((await press)?.number).toBe(2);
    expect(calls('xtream.streamUrl')).toHaveLength(1);
  });

  it("keeps the last channel's picture under the next channel's name until it is tuned (L3-player-2)", async () => {
    await playItem({ title: 'Channel 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    const presses = [zap('down'), zap('down')];
    await vi.waitFor(() => expect(usePlayerStore.getState().source?.title).toBe('Channel 3'));
    const shown = usePlayerStore.getState().source;
    // Same url and kind: the surfaces keep the stream they have instead of a black frame.
    expect(shown).toMatchObject({ url: 'http://x/live/101.m3u8', kind: 'hls', ref: channel(3).ref });
    expect(store.isPendingZap(shown)).toBe(true);
    await Promise.all(presses);
    expect(usePlayerStore.getState().source?.url).toBe('http://x/live/103.m3u8');
    expect(store.isPendingZap(usePlayerStore.getState().source)).toBe(false);
  });

  it('a press away and straight back leaves the channel playing untouched (L3-player-2)', async () => {
    await playItem({ title: 'Channel 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    usePlayerStore.setState({ status: 'playing' });
    const playing = usePlayerStore.getState().source;
    rpcMock.mockClear();
    const presses = [zap('down'), zap('up')];
    const landed = await Promise.all(presses);
    expect(landed.map((c) => c?.number)).toEqual([1, 1]);
    // The very same item: no new stream, no Recent row, nothing restarted.
    expect(usePlayerStore.getState().source).toBe(playing);
    expect(usePlayerStore.getState().status).toBe('playing');
    expect(calls('xtream.streamUrl')).toEqual([]);
    expect(calls('recent.add')).toEqual([]);
  });

  it('a burst asks the guide only for the channel it stops on (L3-live-ch-x1)', async () => {
    handlers['epg.nowNext'] = () => ({});
    await playItem({ title: 'Channel 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    rpcMock.mockClear();
    const presses = Array.from({ length: 8 }, () => zap('down'));
    expect((await Promise.all(presses)).map((c) => c?.number)).toEqual(Array(8).fill(9));
    await vi.waitFor(() => expect(calls('epg.nowNext')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, store.ZAP_SETTLE_MS + 50));
    expect(calls('epg.nowNext')).toEqual([{ refs: [channel(9).ref] }]);
  });

  it('takes the guide a Live list page already holds instead of asking (L3-live-ch-x1)', async () => {
    handlers['epg.nowNext'] = () => ({});
    const now = Date.now();
    const airing = { channelId: 'c2', title: 'News at Nine', start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() };
    // A list page's request: several channels, without descriptions.
    queryClient.setQueryData(rpcKey('epg.nowNext', { refs: [channel(2).ref, channel(3).ref], withDescription: false }), {
      [itemKey(channel(2).ref)]: { now: airing },
    });
    await playItem({ title: 'Channel 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    rpcMock.mockClear();
    await zap('down');
    expect(nowNext.peekNowNext(channel(2).ref)?.now?.title).toBe('News at Nine');
    expect(usePlayerStore.getState().source?.subtitle).toBe('News at Nine');
    expect(calls('epg.nowNext')).toEqual([]);
  });

  it("seeds the catalog's item rows from the neighbours a zap fetched (L3-player-9)", async () => {
    await playItem({ title: 'Channel 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    await zap('down');
    expect(queryClient.getQueryData(rpcKey('catalog.item', { ref: channel(3).ref }))).toMatchObject({ name: 'Channel 3', number: 3 });
  });

  it('fetches the neighbours of a channel as soon as it is tuned (L3-player-10)', async () => {
    rpcMock.mockClear();
    await playItem({ title: 'Channel 5', isLive: true, ref: channel(5).ref, sourceKind: 'xtream' });
    await vi.waitFor(() => expect(calls('catalog.neighbors')).toEqual([expect.objectContaining({ ref: channel(5).ref })]));
    rpcMock.mockClear();
    // The first press steps from what is held: no lookup before the title moves.
    const press = zap('down');
    await vi.waitFor(() => expect(usePlayerStore.getState().source?.title).toBe('Channel 6'));
    expect(calls('catalog.neighbors').map((a) => (a as { ref: ItemRef }).ref.itemId)).not.toContain('105');
    await press;
  });

  describe('the connection limit (L3-player-core-x3)', () => {
    /** The account status the core keeps for s1: `max` is the panel's `user_info.max_connections`. */
    const limit = (max: number) => () => ({ sourceId: 's1', kind: 'xtream', isTrial: false, activeCons: 0, maxConnections: max, checkedAt: new Date().toISOString() });
    /** Fake time in small steps, so every step's promise chain (lookups, gate, stream) runs out. */
    const step = async (ms: number): Promise<void> => {
      for (let t = 0; t < ms; t += 10) await vi.advanceTimersByTimeAsync(10);
    };
    const tuneChannel1 = async (): Promise<void> => {
      queryClient.removeQueries({ queryKey: rpcKey('account.status', { sourceId: 's1' }) });
      await playItem({ title: 'Channel 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
      // Asked for after the tune, ahead of the first press.
      await vi.waitFor(() => expect(queryClient.getQueryData(rpcKey('account.status', { sourceId: 's1' }))).toBeTruthy());
      rpcMock.mockClear();
    };

    it('one connection: presses 80 ms apart open only the channel the burst stops on, after the quiet', async () => {
      handlers['account.status'] = limit(1);
      await tuneChannel1();
      vi.useFakeTimers();
      const presses = [zap('down')];
      await step(80);
      // The first press moved the name at once but opened nothing: the picture held is channel 1's.
      expect(usePlayerStore.getState().source).toMatchObject({ title: 'Channel 2', url: 'http://x/live/101.m3u8' });
      expect(calls('xtream.streamUrl')).toEqual([]);
      presses.push(zap('down'));
      await step(80);
      presses.push(zap('down'));
      await step(80);
      expect(usePlayerStore.getState().source?.title).toBe('Channel 4');
      expect(calls('xtream.streamUrl')).toEqual([]);
      await step(store.ZAP_SETTLE_MS + 50);
      expect((await Promise.all(presses)).map((c) => c?.number)).toEqual([4, 4, 4]);
      expect(calls('xtream.streamUrl')).toEqual([{ ref: channel(4).ref }]);
      expect(usePlayerStore.getState().source?.url).toBe('http://x/live/104.m3u8');
    });

    it('one connection: a single press opens once the quiet has passed', async () => {
      handlers['account.status'] = limit(1);
      await tuneChannel1();
      vi.useFakeTimers();
      const press = zap('down');
      await step(store.ZAP_SETTLE_MS - 50);
      expect(usePlayerStore.getState().source?.title).toBe('Channel 2');
      expect(calls('xtream.streamUrl')).toEqual([]);
      await step(100);
      expect(calls('xtream.streamUrl')).toEqual([{ ref: channel(2).ref }]);
      expect((await press)?.number).toBe(2);
    });

    it('two connections: a single press still opens at once, and a burst after it opens the last channel', async () => {
      handlers['account.status'] = limit(2);
      await tuneChannel1();
      vi.useFakeTimers();
      const presses = [zap('down')];
      await step(80);
      expect(calls('xtream.streamUrl')).toEqual([{ ref: channel(2).ref }]);
      presses.push(zap('down'));
      await step(store.ZAP_SETTLE_MS + 50);
      expect((await Promise.all(presses)).map((c) => c?.number)).toEqual([3, 3]);
      expect(calls('xtream.streamUrl')).toEqual([{ ref: channel(2).ref }, { ref: channel(3).ref }]);
    });

    it('unknown limit on an Xtream source: a burst opens only where it stops, and account.status is asked once (L4-zap-gap)', async () => {
      // A source just added: the status request is still out when the burst starts.
      let answer: (v: unknown) => void = () => undefined;
      handlers['account.status'] = () => new Promise((r) => (answer = r));
      queryClient.removeQueries({ queryKey: rpcKey('account.status', { sourceId: 's1' }) });
      await playItem({ title: 'Channel 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
      await vi.waitFor(() => expect(calls('account.status')).toHaveLength(1));
      vi.useFakeTimers();
      const presses = [zap('down')];
      await step(80);
      presses.push(zap('down'));
      await step(80);
      presses.push(zap('down'));
      await step(80);
      expect(usePlayerStore.getState().source?.title).toBe('Channel 4');
      expect(calls('xtream.streamUrl')).toEqual([{ ref: channel(1).ref }]);
      await step(store.ZAP_SETTLE_MS + 50);
      expect((await Promise.all(presses)).map((c) => c?.number)).toEqual([4, 4, 4]);
      expect(calls('xtream.streamUrl')).toEqual([{ ref: channel(1).ref }, { ref: channel(4).ref }]);
      answer(limit(1)());
      await step(50);
      // Every press joined the request the tune had started.
      expect(calls('account.status')).toEqual([{ sourceId: 's1' }]);
      expect(calls('xtream.streamUrl')).toHaveLength(2);
    });

    it('unknown limit: a single press opens as soon as the answer allows two, before the quiet (L4-zap-gap)', async () => {
      let answer: (v: unknown) => void = () => undefined;
      handlers['account.status'] = () => new Promise((r) => (answer = r));
      queryClient.removeQueries({ queryKey: rpcKey('account.status', { sourceId: 's1' }) });
      await playItem({ title: 'Channel 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
      await vi.waitFor(() => expect(calls('account.status')).toHaveLength(1));
      rpcMock.mockClear();
      vi.useFakeTimers();
      const press = zap('down');
      await step(50);
      expect(usePlayerStore.getState().source?.title).toBe('Channel 2');
      expect(calls('xtream.streamUrl')).toEqual([]);
      answer(limit(2)());
      await step(50);
      expect(calls('xtream.streamUrl')).toEqual([{ ref: channel(2).ref }]);
      await step(store.ZAP_SETTLE_MS + 50);
      expect((await press)?.number).toBe(2);
      expect(calls('xtream.streamUrl')).toHaveLength(1);
      expect(calls('account.status')).toEqual([]);
    });

    it('an M3U source opens a single press at once and never asks account.status (L4-zap-gap)', async () => {
      const m3u = (n: number): Channel => ({ ...channel(n), ref: { ...channel(n).ref, sourceId: 'm1' }, url: `http://m/${n}.ts` });
      handlers['sources.get'] = () => ({ id: 'm1', kind: 'm3u', m3u: { headers: {} } });
      handlers['catalog.item'] = (a) => m3u(Number((a as { ref: ItemRef }).ref.itemId) - 100);
      handlers['catalog.neighbors'] = (a) => {
        const n = Number((a as { ref: ItemRef }).ref.itemId) - 100;
        return { prev: m3u(n - 1), next: m3u(n + 1) };
      };
      delete handlers['account.status'];
      queryClient.removeQueries({ queryKey: rpcKey('account.status', { sourceId: 'm1' }) });
      await playItem({ title: 'Channel 1', isLive: true, ref: m3u(1).ref, sourceKind: 'm3u' });
      vi.useFakeTimers();
      const press = zap('down');
      await step(80);
      expect(usePlayerStore.getState().source?.url).toBe('http://m/2.ts');
      await step(store.ZAP_SETTLE_MS + 50);
      expect((await press)?.number).toBe(2);
      expect(calls('account.status')).toEqual([]);
    });
  });
});

describe('external players (need live-channels#2)', () => {
  it("opens the player a menu chose, and the stage's Reopen opens the same one", async () => {
    handlers['player.openExternal'] = () => ({ pid: 1 });
    const players = (): unknown[] => calls('player.openExternal').map((a) => (a as { player: string }).player);
    await usePlayerStore.getState().play(vod('5'), { mode: 'external', externalPlayer: 'vlc' });
    expect(usePlayerStore.getState()).toMatchObject({ mode: 'external', status: 'playing', dock: 'hidden' });
    // Reopen: the same item, no player named.
    await usePlayerStore.getState().play(usePlayerStore.getState().source!, { mode: 'external' });
    // Another item without a choice: the settings' player (here none set: mpv).
    await usePlayerStore.getState().play(vod('6'), { mode: 'external' });
    expect(players()).toEqual(['vlc', 'vlc', 'mpv']);
  });
});

describe('the guide answer the player shares with the live page (L3-player-9)', () => {
  it('asks the core once when the banner and the live page ask together', async () => {
    let n = 0;
    handlers['epg.nowNext'] = () => {
      n++;
      return {};
    };
    const args = { refs: [liveRef] };
    await Promise.all([
      nowNext.fetchNowNext(liveRef),
      queryClient.fetchQuery({ queryKey: rpcKey('epg.nowNext', args), queryFn: () => rpcMock('epg.nowNext', args) }),
      nowNext.fetchNowNext(liveRef),
    ]);
    expect(n).toBe(1);
  });
});

describe('settings and the first-frame watchdog', () => {
  it('concurrent settings reads, the shell query included, share one settings.get (L2-player-12)', async () => {
    const { queryClient, rpcKey } = await import('@/api/query');
    const shell = queryClient.fetchQuery({ queryKey: rpcKey('settings.get'), queryFn: () => rpcMock('settings.get') });
    const [a, b] = await Promise.all([store.getSettings(), store.getSettings(), shell]);
    expect(a).toEqual(b);
    await store.getSettings();
    expect(calls('settings.get')).toHaveLength(1);
  });

  it('a live channel that shows no frame fails after LIVE_STARTUP_TIMEOUT_MS, even when the surface reports a pause', async () => {
    vi.useFakeTimers();
    handlers['xtream.streamUrl'] = () => ({ url: 'http://x/live/101.ts', kind: 'mpegts', title: 'News', isLive: true, isRadio: false });
    await playItem({ title: 'News', isLive: true, ref: liveRef, sourceKind: 'xtream' });
    // The element rejected the media and paused itself (L2-player-2).
    store.reportStatus('paused');
    await vi.advanceTimersByTimeAsync(store.LIVE_STARTUP_TIMEOUT_MS - 1);
    expect(usePlayerStore.getState().status).toBe('paused');
    await vi.advanceTimersByTimeAsync(1);
    expect(usePlayerStore.getState().status).toBe('error');
    expect(media.useMediaStore.getState().errorCode).toBe('timeout');
  });

  it('a pause the user asked for before the first frame is not a hang', async () => {
    vi.useFakeTimers();
    await usePlayerStore.getState().play(vod('1'));
    store.setPaused(true);
    await vi.advanceTimersByTimeAsync(store.STARTUP_TIMEOUT_MS * 2);
    expect(usePlayerStore.getState().status).toBe('paused');
  });
});

describe('the open page after a stop from the player (L4-player-1)', () => {
  it('refetches an active positions.get once the stop\'s positions.set has landed; a 5 s tick does not', async () => {
    const { QueryObserver } = await import('@tanstack/react-query');
    const ref = vod('1').ref!;
    const key = rpcKey('positions.get', { ref });
    let stored = 0;
    let land: () => void = () => undefined;
    handlers['positions.set'] = (a) =>
      new Promise<void>((resolve) => {
        land = () => {
          stored = (a as { positionSeconds: number }).positionSeconds;
          resolve();
        };
      });
    handlers['positions.get'] = () => (stored ? { ref, positionSeconds: stored, updatedAt: '', watched: false } : null);
    // A VOD detail page left open behind the mini player.
    const page = new QueryObserver(queryClient, { queryKey: key, queryFn: () => rpcMock('positions.get', { ref }) as Promise<unknown> });
    const unsub = page.subscribe(() => undefined);
    await vi.waitFor(() => expect(queryClient.getQueryState(key)?.status).toBe('success'));
    await usePlayerStore.getState().play(vod('1'));
    store.reportStatus('playing');
    store.reportProgress(80, 1000);
    rpcMock.mockClear();
    store.flushProgress(); // what the 5 s saver runs
    land();
    await flush();
    expect(calls('positions.set')).toEqual([expect.objectContaining({ positionSeconds: 80 })]);
    expect(calls('positions.get')).toEqual([]);
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);

    store.reportProgress(120, 1000);
    usePlayerStore.getState().stop();
    await flush();
    // Not while the save is in flight: that would bring back the previous position.
    expect(calls('positions.get')).toEqual([]);
    land();
    await vi.waitFor(() => expect(queryClient.getQueryData(key)).toMatchObject({ positionSeconds: 120 }));
    expect(calls('positions.get')).toHaveLength(1);
    unsub();
  });
});

describe('ended (derived: paused at the end of a VOD item)', () => {
  it('isEndedState needs VOD, paused, and a position at the end', () => {
    const base = { source: vod('1'), status: 'paused' as const, positionSeconds: 100, durationSeconds: 100 };
    expect(store.isEndedState(base)).toBe(true);
    expect(store.isEndedState({ ...base, positionSeconds: 99.5 })).toBe(true); // mpv keep-open stops short
    expect(store.isEndedState({ ...base, positionSeconds: 50 })).toBe(false);
    expect(store.isEndedState({ ...base, status: 'playing' })).toBe(false);
    expect(store.isEndedState({ ...base, durationSeconds: undefined })).toBe(false);
    expect(store.isEndedState({ ...base, source: { ...vod('1'), isLive: true } })).toBe(false);
  });

  it('handleEnded parks at the end, clears the resume record and keeps it cleared', async () => {
    vi.useFakeTimers();
    await usePlayerStore.getState().play(vod('1'));
    store.reportStatus('playing');
    store.reportProgress(80, 100);
    store.flushProgress();
    expect(sessionStorage.getItem(RESUME_KEY)).not.toBeNull();

    store.reportProgress(100, 100);
    handleEnded();
    expect(store.selectEnded(usePlayerStore.getState())).toBe(true);
    expect(usePlayerStore.getState().positionSeconds).toBe(100);
    expect(sessionStorage.getItem(RESUME_KEY)).toBeNull();

    // The 5 s saver and page-hide flushes must not bring it back.
    await vi.advanceTimersByTimeAsync(SAVE_INTERVAL_MS * 2);
    store.flushProgress();
    expect(sessionStorage.getItem(RESUME_KEY)).toBeNull();
    expect(await restorePlayback()).toBe(false);
  });

  it('handleEnded ignores live sources', async () => {
    await usePlayerStore.getState().play({ url: 'http://h/1.m3u8', kind: 'hls', title: 'L', isLive: true, isRadio: false, ref: liveRef });
    store.reportStatus('playing');
    handleEnded();
    expect(usePlayerStore.getState().status).toBe('playing');
  });

  it('replay and togglePlay at the end restart from zero through the controller', async () => {
    const ctl = { play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(), setVolume: vi.fn(), setMuted: vi.fn() };
    store.setController(ctl);
    await usePlayerStore.getState().play(vod('1'));
    store.reportProgress(100, 100);
    handleEnded();

    usePlayerStore.getState().togglePlay();
    expect(ctl.seekTo).toHaveBeenLastCalledWith(0);
    expect(ctl.play).toHaveBeenCalled();
    expect(usePlayerStore.getState().positionSeconds).toBe(0);
    expect(store.selectEnded(usePlayerStore.getState())).toBe(false);
    expect(sessionStorage.getItem(RESUME_KEY)).not.toBeNull();

    store.reportProgress(100, 100);
    store.reportStatus('paused');
    ctl.seekTo.mockClear();
    store.replay();
    expect(ctl.seekTo).toHaveBeenCalledWith(0);
    expect(media.useMediaStore.getState().upNext).toBeUndefined();
  });

  it('replay without a mounted surface replays the source without its resume point', async () => {
    await usePlayerStore.getState().play(vod('1', { resumeSeconds: 40 }));
    store.reportProgress(100, 100);
    handleEnded();
    store.replay();
    await flush();
    expect(usePlayerStore.getState().source?.resumeSeconds).toBeUndefined();
    expect(usePlayerStore.getState().positionSeconds).toBe(0);
  });
});

describe('watched movies (Run 2 C4)', () => {
  beforeEach(() => invalidateWatched.mockClear());

  it('the save that finishes a title refreshes the watched queries, once per source', async () => {
    await usePlayerStore.getState().play(vod('1'));
    store.reportProgress(50, 100);
    store.flushProgress();
    await flush();
    expect(calls('positions.set')).toHaveLength(1);
    expect(invalidateWatched).not.toHaveBeenCalled();

    // A stop past 95 %.
    store.reportProgress(96, 100);
    store.flushProgress();
    await flush();
    expect(invalidateWatched).toHaveBeenCalledTimes(1);

    // The end saves again (position = duration): still the same transition.
    handleEnded();
    await flush();
    expect(calls('positions.set').at(-1)).toMatchObject({ positionSeconds: 100, durationSeconds: 100 });
    expect(invalidateWatched).toHaveBeenCalledTimes(1);

    // Played again from earlier and finished again: a new transition.
    store.reportProgress(10, 100);
    store.flushProgress();
    await flush();
    expect(invalidateWatched).toHaveBeenCalledTimes(1);
    store.reportProgress(100, 100);
    handleEnded();
    await flush();
    expect(invalidateWatched).toHaveBeenCalledTimes(2);

    // Another title finishing is its own transition.
    await usePlayerStore.getState().play(vod('2'));
    store.reportProgress(1000, 1000);
    handleEnded();
    await flush();
    expect(invalidateWatched).toHaveBeenCalledTimes(3);
  });

  it('a failed finishing save does not refresh, and the retry that lands does', async () => {
    let fail = true;
    handlers['positions.set'] = () => {
      if (fail) throw new Error('db busy');
      return undefined;
    };
    await usePlayerStore.getState().play(vod('1'));
    store.reportProgress(99, 100);
    store.flushProgress();
    await flush();
    expect(invalidateWatched).not.toHaveBeenCalled();
    fail = false;
    store.flushProgress();
    await flush();
    expect(invalidateWatched).toHaveBeenCalledTimes(1);
  });

  it('live channels and episodes before the end never refresh', async () => {
    handlers['sources.get'] = () => ({ id: 's1', kind: 'xtream' });
    await usePlayerStore.getState().play(vod('3', { ref: { sourceId: 's1', contentType: 'series', itemId: '9' }, episodeId: 'e1' }));
    store.reportProgress(500, 1000);
    store.flushProgress();
    await flush();
    expect(invalidateWatched).not.toHaveBeenCalled();
  });

  it.each([
    ['replayed to half', 600, 1200, 600],
    ['replayed to exactly 5 %', 60, 1200, 60],
  ])('a watched movie %s resumes there', async (_name, positionSeconds, durationSeconds, resume) => {
    handlers['positions.get'] = () => ({ ref: movieRef, positionSeconds, durationSeconds, updatedAt: '', watched: true });
    await playSource(vod('201'));
    expect(usePlayerStore.getState().source?.resumeSeconds).toBe(resume);
  });

  it.each([
    ['finished (at its end)', 1200, 1200],
    ['past 95 %', 1150, 1200],
    ['under 5 % into the replay', 50, 1200],
    ['with no known duration', 600, undefined],
  ])('a watched movie %s starts at 0', async (_name, positionSeconds, durationSeconds) => {
    handlers['positions.get'] = () => ({ ref: movieRef, positionSeconds, durationSeconds, updatedAt: '', watched: true });
    await playSource(vod('201'));
    expect(usePlayerStore.getState().source?.resumeSeconds).toBeUndefined();
  });

  it('a core resume on a watched movie is kept between 5 % and 95 %, dropped past the end', async () => {
    handlers['positions.get'] = () => ({ ref: movieRef, positionSeconds: 600, durationSeconds: 1200, updatedAt: '', watched: true });
    await playSource(vod('201', { resumeSeconds: 600 }));
    expect(usePlayerStore.getState().source?.resumeSeconds).toBe(600);
    handlers['positions.get'] = () => ({ ref: movieRef, positionSeconds: 1200, durationSeconds: 1200, updatedAt: '', watched: true });
    await playSource(vod('201', { resumeSeconds: 1200 }));
    expect(usePlayerStore.getState().source?.resumeSeconds).toBeUndefined();
  });

  it('isWatchedReplay holds for item-level movie rows only', () => {
    const row = { positionSeconds: 600, durationSeconds: 1200, watched: true };
    expect(store.isWatchedReplay({ ...row, ref: movieRef })).toBe(true);
    expect(store.isWatchedReplay({ ...row, ref: movieRef, watched: false })).toBe(false);
    expect(store.isWatchedReplay({ ...row, ref: { sourceId: 's1', contentType: 'series', itemId: '9' }, episodeId: 'e1' })).toBe(false);
    expect(store.isWatchedReplay({ ...row, ref: { sourceId: 's1', contentType: 'series', itemId: '9' } })).toBe(false);
  });
});

describe('query cache after saves (Run 3 C4)', () => {
  it('recent.add refreshes `recent.` queries and a position save marks `positions.` stale', async () => {
    const { queryClient } = await import('@/api/query');
    queryClient.clear();
    queryClient.setQueryData(['recent.list', null], []);
    queryClient.setQueryData(['positions.continueWatching', null], []);
    queryClient.setQueryData(['favorites.list', null], []);
    const stale = (key: unknown[]) => queryClient.getQueryState(key)?.isInvalidated;

    await usePlayerStore.getState().play(vod('1'));
    await flush();
    expect(stale(['recent.list', null])).toBe(true);
    expect(stale(['positions.continueWatching', null])).toBe(false);

    store.reportStatus('playing');
    store.reportProgress(42, 600);
    usePlayerStore.getState().stop();
    await flush();
    expect(calls('positions.set')).toHaveLength(1);
    expect(stale(['positions.continueWatching', null])).toBe(true);
    expect(stale(['favorites.list', null])).toBe(false);
    queryClient.clear();
  });
});

describe('saved titles (L2-fix-app-library)', () => {
  it('position and recent snapshots keep the core titleBase the detail page or catalog row holds', async () => {
    vi.useFakeTimers();
    const { queryClient } = await import('@/api/query');
    queryClient.clear();
    const ref = { sourceId: 's1', contentType: 'movie' as const, itemId: '1' };
    // The Xtream detail page's cache, keyed the way vod/hooks/queries.ts keys it.
    queryClient.setQueryData(['xtream.vodDetail', { ref }], { item: { ref, title: 'EN - Movie 1 (2020)', titleBase: 'Movie 1' }, cast: [], backdrops: [] });
    await usePlayerStore.getState().play(vod('1', { title: 'EN - Movie 1 (2020)' }));
    store.reportStatus('playing');
    store.reportProgress(42, 600);
    vi.advanceTimersByTime(SAVE_INTERVAL_MS);
    expect(calls('recent.add')).toEqual([expect.objectContaining({ snapshot: expect.objectContaining({ title: 'Movie 1' }) })]);
    expect(calls('positions.set')).toEqual([expect.objectContaining({ snapshot: expect.objectContaining({ title: 'Movie 1' }) })]);
    usePlayerStore.getState().stop();

    // A bare catalog row (an m3u movie) works the same; an item it does not describe keeps its title.
    queryClient.setQueryData(['catalog.item', { ref: { ...ref, itemId: '2' } }], { ref: { ...ref, itemId: '2' }, title: '|FR| Movie 2', titleBase: 'Movie 2' });
    await usePlayerStore.getState().play(vod('2', { title: '|FR| Movie 2' }));
    await usePlayerStore.getState().play(vod('3', { title: 'EN - Movie 3' }));
    expect(calls('recent.add').slice(1).map((c) => (c as { snapshot: { title: string } }).snapshot.title)).toEqual(['Movie 2', 'EN - Movie 3']);
    queryClient.clear();
  });
});
