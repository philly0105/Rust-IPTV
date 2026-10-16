import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type PlayerSource, type Settings } from '@/api/types';

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

const store = await import('./store');
const media = await import('./media');
const failover = await import('./failover');
const reconnect = await import('./reconnect');
const { usePlayerStore, reportStatus, reportProgress } = store;
const { useReconnectStore, RECONNECT_DELAYS_MS, ATTEMPT_TIMEOUT_MS, HEALTHY_MS, STALL_MS } = reconnect;

const live: PlayerSource = {
  url: 'http://h/live/101.m3u8',
  kind: 'hls',
  title: 'News',
  isLive: true,
  isRadio: false,
  ref: { sourceId: 's1', contentType: 'live', itemId: '101' },
};
const movie: PlayerSource = {
  url: 'http://h/movie/201.mp4',
  kind: 'direct',
  title: 'Movie',
  isLive: false,
  isRadio: false,
  ref: { sourceId: 's1', contentType: 'movie', itemId: '201' },
};

const retry = vi.fn();
let unbind: () => void = () => undefined;

function settings(patch: Partial<Settings> = {}): void {
  store.setSettingsCache({ ...DEFAULT_SETTINGS, liveFailover: false, ...patch });
}

function start(src: PlayerSource, position = 0): void {
  usePlayerStore.setState({ source: src, mode: 'inline', status: 'playing', positionSeconds: position });
}

function fail(message = 'HTTP 503'): void {
  reportStatus('error', message);
}

const phase = (): string => useReconnectStore.getState().phase;

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(handlers)) delete handlers[k];
  rpcMock.mockClear();
  retry.mockClear();
  localStorage.clear();
  store.__resetPlayerForTests();
  failover.__resetFailover();
  media.resetMedia();
  handlers['live.alternates'] = () => ({ key: 'news', alternates: [] });
  handlers['recent.add'] = () => undefined;
  settings();
  media.setMediaCommands({
    setQuality: () => undefined,
    setAudio: () => undefined,
    setText: () => undefined,
    setRate: () => undefined,
    togglePip: () => undefined,
    retry,
  });
  unbind = reconnect.bindRecovery();
});

afterEach(() => {
  unbind();
  store.__resetPlayerForTests();
  vi.useRealTimers();
});

describe('smart reconnect', () => {
  it('retries a dropped live stream quietly instead of showing the error', () => {
    start(live);
    fail('Network error');
    expect(usePlayerStore.getState().status).toBe('loading');
    expect(usePlayerStore.getState().error).toBeUndefined();
    expect(useReconnectStore.getState()).toMatchObject({ phase: 'retrying', attempt: 1, max: 3 });

    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0] - 1);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);

    reportStatus('playing');
    expect(phase()).toBe('idle');
  });

  it('backs off 1, 2, 4 s, then gives up and shows the original error', () => {
    start(live);
    const at: number[] = [];
    const t0 = Date.now();
    retry.mockImplementation(() => at.push(Date.now() - t0));
    for (let i = 0; i < 3; i++) {
      fail('HTTP 503');
      vi.advanceTimersByTime(RECONNECT_DELAYS_MS[i]!);
    }
    expect(at).toEqual([1000, 3000, 7000]);
    media.useMediaStore.setState({ errorCode: 'server' });
    fail('HTTP 503');
    expect(usePlayerStore.getState()).toMatchObject({ status: 'error', error: 'HTTP 503' });
    expect(media.useMediaStore.getState().errorCode).toBe('server');
    expect(phase()).toBe('idle');
    vi.advanceTimersByTime(60_000);
    expect(retry).toHaveBeenCalledTimes(3);
  });

  it('counts a retry that never starts playing as failed', () => {
    start(live);
    fail('Network error');
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]);
    expect(retry).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(ATTEMPT_TIMEOUT_MS);
    expect(useReconnectStore.getState()).toMatchObject({ phase: 'retrying', attempt: 2 });
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[1]);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('keeps every retry inside the 20 s window', () => {
    start(live);
    fail('Network error');
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0] + ATTEMPT_TIMEOUT_MS);
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[1] + ATTEMPT_TIMEOUT_MS);
    // The third retry would start after the window: the error shows instead.
    expect(retry).toHaveBeenCalledTimes(2);
    expect(usePlayerStore.getState().status).toBe('error');
    expect(media.useMediaStore.getState().errorCode).toBe('timeout');
  });

  it('restores the full budget after healthy playback', () => {
    start(live);
    for (let i = 0; i < 2; i++) {
      fail('Network error');
      vi.advanceTimersByTime(RECONNECT_DELAYS_MS[i]!);
      reportStatus('playing');
    }
    for (let s = 1; s <= HEALTHY_MS / 1000; s++) {
      vi.advanceTimersByTime(1000);
      reportProgress(s);
    }
    expect(phase()).toBe('idle');
    fail('Network error');
    expect(useReconnectStore.getState().attempt).toBe(1);
  });

  it('keeps the count across a quick recovery (a flapping stream still gives up)', () => {
    start(live);
    for (let i = 0; i < 3; i++) {
      fail('Network error');
      vi.advanceTimersByTime(RECONNECT_DELAYS_MS[i]!);
      reportStatus('playing');
      vi.advanceTimersByTime(5_000);
    }
    fail('Network error');
    expect(usePlayerStore.getState().status).toBe('error');
  });

  it.each([
    ['auth', 'HTTP 403'],
    ['not found', 'HTTP 404'],
    ['unsupported codec', 'Unsupported codec'],
    ['missing player', 'mpv was not found'],
  ])('does not retry %s errors', (_label, message) => {
    start(live);
    fail(message);
    expect(usePlayerStore.getState()).toMatchObject({ status: 'error', error: message });
    vi.advanceTimersByTime(30_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it('does nothing when reconnect is off', () => {
    settings({ streamReconnect: false });
    start(live);
    fail('Network error');
    expect(usePlayerStore.getState().status).toBe('error');
    vi.advanceTimersByTime(30_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it('a Retry after giving up starts a fresh budget', () => {
    settings({ streamReconnect: false });
    start(live);
    fail('Network error');
    expect(usePlayerStore.getState().status).toBe('error');
    settings();
    usePlayerStore.setState({ status: 'loading', error: undefined });
    fail('Network error');
    expect(useReconnectStore.getState()).toMatchObject({ phase: 'retrying', attempt: 1 });
  });

  it('resumes a movie at the position it dropped at', () => {
    start(movie, 600);
    fail('Network error');
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().source?.resumeSeconds).toBe(600);
    expect(usePlayerStore.getState().positionSeconds).toBe(600);
  });

  it('treats a stream that stops moving while playing as a drop', () => {
    start(live, 10);
    for (let s = 1; s <= 5; s++) {
      vi.advanceTimersByTime(1000);
      reportProgress(10 + s);
    }
    expect(phase()).toBe('idle');
    vi.advanceTimersByTime(STALL_MS + 1000);
    expect(useReconnectStore.getState()).toMatchObject({ phase: 'retrying', attempt: 1 });
    expect(usePlayerStore.getState().status).toBe('loading');
  });

  it('reconnects a live stream the engine reports as buffering after LIVE_STALL_MS, not STALL_MS (L3-desktop-3, L3-live-3)', () => {
    const { LIVE_STALL_MS } = reconnect;
    expect(LIVE_STALL_MS).toBeLessThanOrEqual(6_000);
    for (const mode of ['inline', 'embedded-mpv'] as const) {
      usePlayerStore.setState({ source: live, mode, status: 'playing', positionSeconds: 10 });
      // The element's `waiting` / mpv's paused-for-cache; the status stays `playing`.
      media.useMediaStore.setState({ waiting: true });
      vi.advanceTimersByTime(LIVE_STALL_MS - 1000);
      expect(phase()).toBe('idle');
      vi.advanceTimersByTime(2000);
      expect(useReconnectStore.getState()).toMatchObject({ phase: 'retrying', attempt: 1 });
      store.__resetPlayerForTests();
      reconnect.__resetReconnect();
      media.resetMedia();
    }
  });

  it('keeps STALL_MS for a live stream that is not buffering, and for VOD that is', () => {
    const { LIVE_STALL_MS } = reconnect;
    start(live, 10);
    vi.advanceTimersByTime(LIVE_STALL_MS + 2000);
    expect(phase()).toBe('idle');
    store.__resetPlayerForTests();
    reconnect.__resetReconnect();
    start(movie, 600);
    media.useMediaStore.setState({ waiting: true });
    vi.advanceTimersByTime(LIVE_STALL_MS + 2000);
    expect(phase()).toBe('idle');
    vi.advanceTimersByTime(STALL_MS);
    expect(phase()).toBe('retrying');
  });

  it('embedded mpv: a stalled stream that keeps saying playing is still reloaded, and gives up', () => {
    usePlayerStore.setState({ source: live, mode: 'embedded-mpv', status: 'playing', positionSeconds: 10 });
    vi.advanceTimersByTime(STALL_MS + 1000);
    expect(useReconnectStore.getState()).toMatchObject({ phase: 'retrying', attempt: 1 });
    // mpv's next state event: the frozen file is loaded and not paused.
    reportStatus('playing');
    expect(phase()).toBe('retrying');
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]);
    expect(retry).toHaveBeenCalledTimes(1);
    // Still frozen after the reload: the next retries, then the error, which mpv cannot hide.
    for (let i = 0; i < 4; i++) {
      reportStatus('playing');
      vi.advanceTimersByTime(ATTEMPT_TIMEOUT_MS + 4_000);
    }
    expect(retry).toHaveBeenCalledTimes(2);
    expect(usePlayerStore.getState().status).toBe('error');
    reportStatus('playing');
    expect(usePlayerStore.getState().status).toBe('error');
    expect(phase()).toBe('idle');
    vi.advanceTimersByTime(60_000);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('embedded mpv: a stall ends when the position moves again', () => {
    usePlayerStore.setState({ source: live, mode: 'embedded-mpv', status: 'playing', positionSeconds: 10 });
    vi.advanceTimersByTime(STALL_MS + 1000);
    reportStatus('playing');
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]);
    expect(retry).toHaveBeenCalledTimes(1);
    reportProgress(11);
    expect(phase()).toBe('idle');
    vi.advanceTimersByTime(ATTEMPT_TIMEOUT_MS);
    expect(useReconnectStore.getState().attempt).toBe(0);
  });

  it('checks the account before retrying, and stops retrying a full one', async () => {
    handlers['account.status'] = () => ({ maxConnections: 2, activeCons: 3, checkedAt: new Date().toISOString() });
    handlers['recordings.list'] = () => [];
    start(live);
    fail('HTTP 503');
    expect(phase()).toBe('retrying');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(rpcMock).toHaveBeenCalledWith('account.status', { sourceId: 's1', refresh: true });
    expect(usePlayerStore.getState()).toMatchObject({ status: 'error', error: 'HTTP 503' });
    vi.advanceTimersByTime(30_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it('keeps retrying when the account has room', async () => {
    handlers['account.status'] = () => ({ maxConnections: 2, activeCons: 0, checkedAt: new Date().toISOString() });
    handlers['recordings.list'] = () => [];
    start(live);
    fail('HTTP 503');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('does not call a paused stream stalled', () => {
    start(live, 10);
    reportStatus('paused');
    vi.advanceTimersByTime(STALL_MS * 3);
    expect(phase()).toBe('idle');
  });

  it('drops the retry when the user plays something else', () => {
    start(live);
    fail('Network error');
    start({ ...movie });
    expect(phase()).toBe('idle');
    vi.advanceTimersByTime(10_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it('a late error while a retry is pending keeps the notice up without counting', () => {
    start(live);
    fail('Network error');
    fail('Network error again');
    expect(usePlayerStore.getState().status).toBe('loading');
    expect(useReconnectStore.getState().attempt).toBe(1);
  });

  it('re-resolves a Stalker link before retrying', async () => {
    handlers['stalker.streamUrl'] = () => ({ url: 'http://portal/fresh.ts', kind: 'mpegts', title: 'News', isLive: true, isRadio: false });
    handlers['sources.get'] = () => ({ id: 'st', kind: 'stalker', name: 'Portal' });
    const src: PlayerSource = { ...live, url: 'http://portal/old.ts', ref: { sourceId: 'st', contentType: 'live', itemId: '7' } };
    await store.sourceKindOf('st');
    start(src);
    fail('Network error');
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]);
    await vi.waitFor(() => expect(usePlayerStore.getState().source?.url).toBe('http://portal/fresh.ts'));
    expect(rpcMock).toHaveBeenCalledWith('stalker.streamUrl', { ref: src.ref });
    // A new url reloads the media by itself.
    expect(retry).not.toHaveBeenCalled();
  });
});

describe('recoveryFor', () => {
  it('switches first for errors a retry cannot fix', () => {
    expect(reconnect.recoveryFor('notFound')).toEqual({ retry: false, canSwitch: true, switchNow: true });
    expect(reconnect.recoveryFor('server')).toEqual({ retry: true, canSwitch: true, switchNow: true });
    expect(reconnect.recoveryFor('network')).toEqual({ retry: true, canSwitch: true, switchNow: false });
    expect(reconnect.recoveryFor('offline')).toEqual({ retry: false, canSwitch: false, switchNow: false });
  });
});

describe('streams that never played (L2-live-5, L2-player-4)', () => {
  /** A play that has not shown a frame yet. */
  function begin(src: PlayerSource): void {
    usePlayerStore.setState({ source: src, mode: 'inline', status: 'loading', positionSeconds: 0 });
  }

  it('a 503 before the first frame gets one quiet retry, then the error (no stacked ladders)', () => {
    begin(live);
    fail('HTTP 503');
    expect(useReconnectStore.getState()).toMatchObject({ phase: 'retrying', attempt: 1, max: reconnect.STARTUP_RETRIES });
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]);
    expect(retry).toHaveBeenCalledTimes(1);
    fail('HTTP 503');
    expect(usePlayerStore.getState()).toMatchObject({ status: 'error', error: 'HTTP 503' });
    vi.advanceTimersByTime(60_000);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('a 4xx before the first frame is not retried', () => {
    begin(live);
    fail('HTTP 404');
    expect(usePlayerStore.getState()).toMatchObject({ status: 'error', error: 'HTTP 404' });
    vi.advanceTimersByTime(60_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it('a stream that played keeps the full ladder', () => {
    start(live);
    fail('HTTP 503');
    expect(useReconnectStore.getState()).toMatchObject({ phase: 'retrying', attempt: 1, max: RECONNECT_DELAYS_MS.length });
  });

  it('says it is still connecting after SLOW_START_MS, until the first frame', () => {
    begin(live);
    vi.advanceTimersByTime(reconnect.SLOW_START_MS - 1);
    expect(phase()).toBe('idle');
    vi.advanceTimersByTime(1);
    expect(phase()).toBe('connecting');
    reportStatus('playing');
    expect(phase()).toBe('idle');
  });

  it('Try another source with no other copy keeps waiting on this one', async () => {
    settings({ liveFailover: true });
    begin(live);
    vi.advanceTimersByTime(reconnect.SLOW_START_MS);
    expect(phase()).toBe('connecting');
    await expect(reconnect.tryAnotherSource()).resolves.toBe(false);
    expect(phase()).toBe('connecting');
    expect(usePlayerStore.getState().source).toEqual(live);
  });
});
