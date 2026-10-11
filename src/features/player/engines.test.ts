import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlayerSource } from '@/api/types';

type Listener = (...args: unknown[]) => void;

class FakeTsPlayer {
  static created: FakeTsPlayer[] = [];
  listeners = new Map<string, Listener[]>();
  attached: HTMLMediaElement | null = null;
  loaded = false;
  destroyed = false;
  constructor(
    public source: { type: string; isLive?: boolean; url?: string },
    public config: Record<string, unknown>,
  ) {
    FakeTsPlayer.created.push(this);
  }
  on(evt: string, l: Listener): void {
    this.listeners.set(evt, [...(this.listeners.get(evt) ?? []), l]);
  }
  off(): void {}
  emit(evt: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(evt) ?? []) l(...args);
  }
  attachMediaElement(el: HTMLMediaElement): void {
    this.attached = el;
  }
  detachMediaElement(): void {
    this.attached = null;
  }
  load(): void {
    this.loaded = true;
  }
  unload(): void {
    this.loaded = false;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

const mpegtsMock = {
  isSupported: vi.fn(() => true),
  getFeatureList: vi.fn(() => ({ mseLivePlayback: true })),
  createPlayer: vi.fn((src: FakeTsPlayer['source'], cfg: Record<string, unknown>) => new FakeTsPlayer(src, cfg)),
  LoggingControl: { applyConfig: vi.fn() },
  Events: { ERROR: 'error', LOADING_COMPLETE: 'loading_complete', STATISTICS_INFO: 'statistics_info' },
  ErrorTypes: { NETWORK_ERROR: 'NetworkError', MEDIA_ERROR: 'MediaError', OTHER_ERROR: 'OtherError' },
  ErrorDetails: { MEDIA_CODEC_UNSUPPORTED: 'CodecUnsupported', MEDIA_FORMAT_UNSUPPORTED: 'FormatUnsupported', MEDIA_FORMAT_ERROR: 'FormatError' },
};
vi.mock('mpegts.js', () => ({ default: mpegtsMock }));

const engines = await import('./engines');
const { createEngine, looksLikeMpegTs, worthSniffingAsMpegTs, tsRestartDelay, TS_MAX_RESTARTS } = engines;

function src(url: string, extra: Partial<PlayerSource> = {}): PlayerSource {
  return { url, kind: 'direct', title: 't', isLive: true, isRadio: false, ...extra };
}

function video(): HTMLVideoElement {
  const el = document.createElement('video');
  el.play = vi.fn(() => Promise.resolve());
  el.load = vi.fn();
  return el;
}

const cb = () => ({ onTracks: vi.fn(), onError: vi.fn() });

beforeEach(() => {
  FakeTsPlayer.created = [];
  mpegtsMock.createPlayer.mockClear();
  mpegtsMock.isSupported.mockReturnValue(true);
  (window as unknown as { MediaSource?: unknown }).MediaSource = function MediaSource() {};
});

afterEach(() => {
  delete (window as unknown as { MediaSource?: unknown }).MediaSource;
  vi.useRealTimers();
});

describe('MPEG-TS detection', () => {
  it('recognises .ts paths and ts query hints on direct/file sources only', () => {
    expect(looksLikeMpegTs(src('http://h/live/u/p/101.ts'))).toBe(true);
    expect(looksLikeMpegTs(src('http://h/live/u/p/101.TS?token=1'))).toBe(true);
    expect(looksLikeMpegTs(src('http://h/play?id=1&output=ts'))).toBe(true);
    expect(looksLikeMpegTs(src('/media/rec.m2ts', { kind: 'file' }))).toBe(true);
    expect(looksLikeMpegTs(src('http://h/101.m3u8', { kind: 'hls' }))).toBe(false);
    expect(looksLikeMpegTs(src('http://h/movie.mp4'))).toBe(false);
    expect(looksLikeMpegTs(src('http://h/seg.ts/index.m3u8'))).toBe(false);
  });

  it('only sniffs extensionless or unknown direct streams', () => {
    expect(worthSniffingAsMpegTs(src('http://h/live/u/p/101'))).toBe(true);
    expect(worthSniffingAsMpegTs(src('/api/files/abc'))).toBe(true);
    expect(worthSniffingAsMpegTs(src('http://h/movie.mkv'))).toBe(false);
    expect(worthSniffingAsMpegTs(src('http://h/a.ts'))).toBe(false); // already MPEG-TS
    expect(worthSniffingAsMpegTs(src('http://h/x', { kind: 'hls' }))).toBe(false);
  });

  it('backs off restarts and caps the delay', () => {
    expect([1, 2, 3, 4, 5, 9].map(tsRestartDelay)).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
  });
});

describe('engine selection', () => {
  it('uses mpegts.js for a .ts stream when MSE exists', async () => {
    const el = video();
    const engine = await createEngine(el, src('http://h/live/u/p/101.ts'), 'http://h/live/u/p/101.ts', cb(), { captions: false });
    expect(engine.kind).toBe('mpegts');
    const p = FakeTsPlayer.created[0]!;
    expect(p.source).toMatchObject({ type: 'mpegts', isLive: true, url: 'http://h/live/u/p/101.ts' });
    expect(p.config).toMatchObject({ liveBufferLatencyChasing: false, enableStashBuffer: false, autoCleanupSourceBuffer: true, lazyLoad: false });
    expect(p.attached).toBe(el);
    expect(p.loaded).toBe(true);
    engine.destroy();
    expect(p.destroyed).toBe(true);
  });

  it('resolves a same-origin proxy url to an absolute one and keeps VOD read-ahead bounded', async () => {
    await createEngine(video(), src('http://h/a.ts', { isLive: false }), '/api/proxy?url=x', cb(), { captions: false });
    const p = FakeTsPlayer.created[0]!;
    expect(p.source.url).toBe(new URL('/api/proxy?url=x', window.location.href).href);
    expect(p.config).toMatchObject({ lazyLoad: true, lazyLoadMaxDuration: 60, enableStashBuffer: true });
  });

  it('forceMpegts routes an extensionless stream through mpegts.js', async () => {
    const engine = await createEngine(video(), src('http://h/live/u/p/101'), 'http://h/live/u/p/101', cb(), { captions: false, forceMpegts: true });
    expect(engine.kind).toBe('mpegts');
  });

  it('falls back to the element without MSE, and for plain mp4', async () => {
    const mp4 = await createEngine(video(), src('http://h/m.mp4', { isLive: false }), 'http://h/m.mp4', cb(), { captions: false });
    expect(mp4.kind).toBe('native');
    delete (window as unknown as { MediaSource?: unknown }).MediaSource;
    const el = video();
    const ts = await createEngine(el, src('http://h/a.ts'), 'http://h/a.ts', cb(), { captions: false });
    expect(ts.kind).toBe('native');
    expect(el.getAttribute('src')).toBe('http://h/a.ts');
    expect(mpegtsMock.createPlayer).not.toHaveBeenCalled();
  });

  it('stale-engine guard: an aborted request never touches the element', async () => {
    const el = video();
    el.setAttribute('src', 'http://h/newer.mp4');
    const abort = new AbortController();
    const pending = createEngine(el, src('http://h/a.ts'), 'http://h/a.ts', cb(), { captions: false, signal: abort.signal });
    abort.abort();
    const engine = await pending;
    expect(mpegtsMock.createPlayer).not.toHaveBeenCalled();
    engine.destroy();
    expect(el.getAttribute('src')).toBe('http://h/newer.mp4');
  });

  it('a superseded native engine does not reset the element on destroy', async () => {
    const el = video();
    const old = await createEngine(el, src('http://h/a.mp4', { isLive: false }), 'http://h/a.mp4', cb(), { captions: false });
    await createEngine(el, src('http://h/b.ts'), 'http://h/b.ts', cb(), { captions: false });
    el.setAttribute('src', 'blob:mse');
    old.destroy();
    expect(el.getAttribute('src')).toBe('blob:mse');
  });
});

describe('mpegts.js engine recovery', () => {
  it('reconnects a live stream that closed, then reports after the restart budget', async () => {
    vi.useFakeTimers();
    const el = video();
    const callbacks = cb();
    await createEngine(el, src('http://h/a.ts'), 'http://h/a.ts', callbacks, { captions: false });
    for (let i = 1; i <= TS_MAX_RESTARTS; i++) {
      el.dispatchEvent(new Event('ended'));
      await vi.advanceTimersByTimeAsync(tsRestartDelay(i));
      expect(FakeTsPlayer.created).toHaveLength(i + 1);
      expect(FakeTsPlayer.created[i - 1]!.destroyed).toBe(true);
    }
    expect(callbacks.onError).not.toHaveBeenCalled();
    el.dispatchEvent(new Event('ended'));
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'network', fatal: true }));
  });

  it('loader activity without playback does not refill the budget', async () => {
    vi.useFakeTimers();
    const el = video(); // paused
    const callbacks = cb();
    await createEngine(el, src('http://h/a.ts'), 'http://h/a.ts', callbacks, { captions: false });
    for (let i = 1; i <= TS_MAX_RESTARTS; i++) {
      el.dispatchEvent(new Event('ended'));
      await vi.advanceTimersByTimeAsync(tsRestartDelay(i));
    }
    el.dispatchEvent(new Event('timeupdate'));
    await vi.advanceTimersByTimeAsync(engines.TS_STABLE_MS);
    el.dispatchEvent(new Event('ended'));
    expect(callbacks.onError).toHaveBeenCalled();
  });

  it('stable playback refills the restart budget', async () => {
    vi.useFakeTimers();
    const el = video();
    const callbacks = cb();
    await createEngine(el, src('http://h/a.ts'), 'http://h/a.ts', callbacks, { captions: false });
    for (let round = 0; round < 3; round++) {
      for (let i = 1; i <= TS_MAX_RESTARTS; i++) {
        el.dispatchEvent(new Event('ended'));
        await vi.advanceTimersByTimeAsync(tsRestartDelay(i));
      }
      Object.defineProperty(el, 'paused', { value: false, configurable: true });
      el.dispatchEvent(new Event('timeupdate'));
      await vi.advanceTimersByTimeAsync(engines.TS_STABLE_MS);
    }
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('a stall after the live connection completed reconnects; VOD end does not', async () => {
    vi.useFakeTimers();
    const live = video();
    await createEngine(live, src('http://h/a.ts'), 'http://h/a.ts', cb(), { captions: false });
    live.dispatchEvent(new Event('waiting'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeTsPlayer.created).toHaveLength(1); // ordinary buffering
    FakeTsPlayer.created[0]!.emit('loading_complete');
    live.dispatchEvent(new Event('waiting'));
    await vi.advanceTimersByTimeAsync(tsRestartDelay(1));
    expect(FakeTsPlayer.created).toHaveLength(2);

    const vod = video();
    await createEngine(vod, src('http://h/v.ts', { isLive: false }), 'http://h/v.ts', cb(), { captions: false });
    vod.dispatchEvent(new Event('ended'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeTsPlayer.created).toHaveLength(3);
  });

  it('maps errors: 4xx fails at once, codec errors are unsupported, 5xx retries', async () => {
    vi.useFakeTimers();
    const callbacks = cb();
    await createEngine(video(), src('http://h/a.ts'), 'http://h/a.ts', callbacks, { captions: false });
    const p = FakeTsPlayer.created[0]!;
    p.emit('error', 'NetworkError', 'HttpStatusCodeInvalid', { code: 503 });
    expect(callbacks.onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(tsRestartDelay(1));
    const p2 = FakeTsPlayer.created[1]!;
    p.emit('error', 'NetworkError', 'HttpStatusCodeInvalid', { code: 404 }); // stale player: ignored
    expect(callbacks.onError).not.toHaveBeenCalled();
    p2.emit('error', 'NetworkError', 'HttpStatusCodeInvalid', { code: 403 });
    expect(callbacks.onError).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'network', message: 'HttpStatusCodeInvalid (HTTP 403)' }),
    );
    p2.emit('error', 'MediaError', 'CodecUnsupported', { msg: 'hevc' });
    expect(callbacks.onError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'unsupported' }));
    p2.emit('error', 'MediaError', 'FormatError', {});
    expect(callbacks.onError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'media' }));
  });

  it('destroy cancels a pending restart', async () => {
    vi.useFakeTimers();
    const el = video();
    const engine = await createEngine(el, src('http://h/a.ts'), 'http://h/a.ts', cb(), { captions: false });
    el.dispatchEvent(new Event('ended'));
    engine.destroy();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeTsPlayer.created).toHaveLength(1);
  });
});
