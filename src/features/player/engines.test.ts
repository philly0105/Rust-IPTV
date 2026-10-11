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

  it('keeps the displayed live position monotonic across reconnects', async () => {
    vi.useFakeTimers();
    const el = video();
    let t = 0;
    let ready = 4;
    Object.defineProperty(el, 'currentTime', { get: () => t, set: (v: number) => (t = v), configurable: true });
    Object.defineProperty(el, 'readyState', { get: () => ready, configurable: true });
    const engine = await createEngine(el, src('http://h/a.ts'), 'http://h/a.ts', cb(), { captions: false });
    const shown = (): number => t + (engine.timeOffset?.() ?? 0);

    t = 30;
    el.dispatchEvent(new Event('timeupdate'));
    expect(shown()).toBe(30);

    // The server drops the connection; the element ends and the pipeline is rebuilt at time 0.
    el.dispatchEvent(new Event('ended'));
    await vi.advanceTimersByTimeAsync(tsRestartDelay(1));
    t = 0;
    ready = 0;
    el.dispatchEvent(new Event('timeupdate'));
    expect(shown()).toBe(30); // held while reconnecting

    ready = 4;
    t = 0.4;
    el.dispatchEvent(new Event('timeupdate'));
    expect(shown()).toBe(30);
    t = 5.4;
    el.dispatchEvent(new Event('timeupdate'));
    expect(shown()).toBeCloseTo(35);

    // A second drop keeps accumulating.
    el.dispatchEvent(new Event('ended'));
    await vi.advanceTimersByTimeAsync(tsRestartDelay(2));
    t = 1;
    el.dispatchEvent(new Event('timeupdate'));
    expect(shown()).toBeCloseTo(35);
    t = 3;
    el.dispatchEvent(new Event('timeupdate'));
    expect(shown()).toBeCloseTo(37);
  });

  it('VOD reconnects do not offset the position', async () => {
    vi.useFakeTimers();
    const el = video();
    const engine = await createEngine(el, src('http://h/v.ts', { isLive: false }), 'http://h/v.ts', cb(), { captions: false });
    FakeTsPlayer.created[0]!.emit('error', 'NetworkError', 'Exception', { code: -1 });
    await vi.advanceTimersByTimeAsync(tsRestartDelay(1));
    expect(FakeTsPlayer.created).toHaveLength(2);
    expect(engine.timeOffset?.()).toBe(0);
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

describe('server refusal reasons', () => {
  const { isOwnServerUrl, reasonFromBody, withReason, fetchFailureReason } = engines;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('only treats our own server routes as having readable bodies', () => {
    expect(isOwnServerUrl('/api/proxy?url=x')).toBe(true);
    expect(isOwnServerUrl(`${window.location.origin}/api/files/abc`)).toBe(true);
    expect(isOwnServerUrl('http://127.0.0.1:51234/api/proxy?url=x')).toBe(true); // desktop loopback proxy
    expect(isOwnServerUrl('http://provider.example/live/1.ts')).toBe(false);
    expect(isOwnServerUrl('http://provider.example/api/stream')).toBe(false);
  });

  it('reads an RpcError message, plain text or bytes, and skips HTML and empty bodies', () => {
    expect(reasonFromBody('{"code":"invalid","message":"blocked: private address 10.0.0.1"}')).toBe('blocked: private address 10.0.0.1');
    expect(reasonFromBody(' the media proxy only serves the Tsrust IPTV window \n')).toBe('the media proxy only serves the Tsrust IPTV window');
    expect(reasonFromBody(new TextEncoder().encode('denied').buffer)).toBe('denied');
    expect(reasonFromBody('<!DOCTYPE html><p>x</p>')).toBeNull();
    expect(reasonFromBody('   ')).toBeNull();
    expect(reasonFromBody(undefined)).toBeNull();
    expect(reasonFromBody('x'.repeat(1000))!.length).toBe(300);
    expect(withReason('fallback', null, 403)).toBe('fallback');
    expect(withReason('fallback', 'blocked', 403)).toBe('blocked (HTTP 403)');
  });

  it('asks our own server once and returns the reason of a non-2xx answer', async () => {
    const fetchMock = vi.fn(async () => new Response('{"code":"invalid","message":"blocked: loopback address"}', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchFailureReason('/api/proxy?url=http%3A%2F%2F127.0.0.1')).resolves.toEqual({ status: 403, reason: 'blocked: loopback address' });
    await expect(fetchFailureReason('http://provider.example/a.ts')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await expect(fetchFailureReason('/api/proxy?url=x')).resolves.toBeNull();
  });

  it('shows the proxy guard reason when mpegts.js gets a 403 from /api/proxy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":"invalid","message":"blocked: private address"}', { status: 403 })));
    const callbacks = cb();
    await createEngine(video(), src('http://10.0.0.1/a.ts'), '/api/proxy?url=http%3A%2F%2F10.0.0.1%2Fa.ts', callbacks, { captions: false });
    FakeTsPlayer.created[0]!.emit('error', 'NetworkError', 'HttpStatusCodeInvalid', { code: 403 });
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalled());
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'network', fatal: true, message: 'blocked: private address (HTTP 403)' }),
    );
  });
});
