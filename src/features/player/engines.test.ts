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

class FakeHls {
  static created: FakeHls[] = [];
  static isSupported = (): boolean => true;
  static Events = {
    MANIFEST_PARSED: 'manifestParsed',
    LEVELS_UPDATED: 'levelsUpdated',
    LEVEL_SWITCHED: 'levelSwitched',
    AUDIO_TRACKS_UPDATED: 'audioTracksUpdated',
    AUDIO_TRACK_SWITCHED: 'audioTrackSwitched',
    SUBTITLE_TRACKS_UPDATED: 'subtitleTracksUpdated',
    SUBTITLE_TRACK_SWITCH: 'subtitleTrackSwitch',
    ERROR: 'hlsError',
  };
  static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
  levels = [];
  audioTracks = [];
  subtitleTracks = [];
  subtitleDisplay = false;
  bandwidthEstimate = Number.NaN;
  destroyed = false;
  constructor(public config: Record<string, unknown>) {
    FakeHls.created.push(this);
  }
  on(): void {}
  loadSource(): void {}
  attachMedia(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}
vi.mock('hls.js', () => ({ default: FakeHls }));

class FakeShaka {
  static created: FakeShaka[] = [];
  static isBrowserSupported = (): boolean => true;
  /** Resolves `destroy()`; a test that never calls it leaves shaka's teardown pending. */
  release: () => void = () => undefined;
  constructor() {
    FakeShaka.created.push(this);
  }
  configure(): void {}
  getNetworkingEngine(): null {
    return null;
  }
  addEventListener(): void {}
  async attach(): Promise<void> {}
  async load(): Promise<void> {}
  getVariantTracks(): [] {
    return [];
  }
  getAudioLanguagesAndRoles(): [] {
    return [];
  }
  getTextTracks(): [] {
    return [];
  }
  destroy(): Promise<void> {
    return new Promise((resolve) => {
      this.release = resolve;
    });
  }
}
vi.mock('shaka-player', () => ({
  default: {
    polyfill: { installAll() {} },
    Player: FakeShaka,
    net: { NetworkingEngine: { RequestType: { MANIFEST: 0 } } },
    util: { Error: { Severity: { CRITICAL: 2 }, Category: { NETWORK: 1 } } },
  },
}));

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
  FakeHls.created = [];
  FakeShaka.created = [];
  engines.resetHlsBandwidth();
  localStorage.clear();
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
    // Desktop recordings on the loopback proxy end in a name that carries the extension.
    expect(looksLikeMpegTs(src('http://127.0.0.1:5555/t/api/recordings/f.61/media.ts', { kind: 'file' }))).toBe(true);
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

describe('hls.js setup', () => {
  const hls = (extra: Partial<PlayerSource> = {}): PlayerSource => src('http://h/live/1.m3u8', { kind: 'hls', ...extra });

  it('transmuxes in a worker: the config names the worker script (PB-1)', async () => {
    await createEngine(video(), hls(), 'http://h/live/1.m3u8', cb(), { captions: false });
    const config = FakeHls.created[0]!.config;
    expect(config['enableWorker']).toBe(true);
    expect(config['workerPath']).toEqual(expect.stringContaining('hls.worker'));
  });

  it("starts the next stream from the main player's last bandwidth estimate (PB-6)", async () => {
    const first = await createEngine(video(), hls(), 'http://h/live/1.m3u8', cb(), { captions: false });
    // No estimate yet: hls.js keeps its own default (an undefined key would replace it).
    expect(FakeHls.created[0]!.config).not.toHaveProperty('abrEwmaDefaultEstimate');
    FakeHls.created[0]!.bandwidthEstimate = 8_000_000;
    first.destroy();
    await createEngine(video(), hls(), 'http://h/live/2.m3u8', cb(), { captions: false });
    expect(FakeHls.created[1]!.config['abrEwmaDefaultEstimate']).toBe(8_000_000);

    // A tile reads it but does not write its share of the link back.
    const tile = await createEngine(video(), hls(), 'http://h/live/3.m3u8', cb(), { captions: false, profile: 'tile' });
    expect(FakeHls.created[2]!.config['abrEwmaDefaultEstimate']).toBe(8_000_000);
    FakeHls.created[2]!.bandwidthEstimate = 2_000_000;
    tile.destroy();
    await createEngine(video(), hls(), 'http://h/live/4.m3u8', cb(), { captions: false });
    expect(FakeHls.created[3]!.config['abrEwmaDefaultEstimate']).toBe(8_000_000);
  });

  it('a multi-view tile keeps a short buffer and caps the rendition at its size (PB-5)', async () => {
    await createEngine(video(), hls(), 'http://h/live/1.m3u8', cb(), { captions: false });
    await createEngine(video(), hls(), 'http://h/live/1.m3u8', cb(), { captions: false, profile: 'tile' });
    const [main, tile] = FakeHls.created.map((x) => x.config);
    expect(main).toMatchObject({ backBufferLength: 30 });
    expect(main).not.toHaveProperty('capLevelToPlayerSize');
    expect(tile).toMatchObject({ backBufferLength: 5, maxBufferLength: 10, capLevelToPlayerSize: true });
  });

  it('a movie buffers a minute ahead; live keeps the default', async () => {
    await createEngine(video(), hls({ isLive: false }), 'http://h/movie/1.m3u8', cb(), { captions: false });
    await createEngine(video(), hls(), 'http://h/live/1.m3u8', cb(), { captions: false });
    const [movie, live] = FakeHls.created.map((x) => x.config);
    expect(movie).toMatchObject({ maxBufferLength: 60, backBufferLength: 90 });
    expect(live).not.toHaveProperty('maxBufferLength');
  });
});

describe('mpegts.js buffer profile (PB-5)', () => {
  it('a tile cleans up behind the playhead after 10 s, down to 5 s', async () => {
    await createEngine(video(), src('http://h/a.ts'), 'http://h/a.ts', cb(), { captions: false, profile: 'tile' });
    await createEngine(video(), src('http://h/a.ts'), 'http://h/a.ts', cb(), { captions: false });
    const [tile, main] = FakeTsPlayer.created.map((p) => p.config);
    expect(tile).toMatchObject({ autoCleanupMaxBackwardDuration: 10, autoCleanupMinBackwardDuration: 5 });
    expect(main).toMatchObject({ autoCleanupMaxBackwardDuration: 60, autoCleanupMinBackwardDuration: 30 });
  });
});

describe("shaka's async teardown (PB-7)", () => {
  const dash = src('http://h/m.mpd', { kind: 'dash', isLive: false });

  it('the next engine on the element waits until shaka has let go of it', async () => {
    const el = video();
    const old = await createEngine(el, dash, 'http://h/m.mpd', cb(), { captions: false });
    old.destroy();
    let attached = false;
    const next = createEngine(el, src('http://h/n.mp4', { isLive: false }), 'http://h/n.mp4', cb(), { captions: false }).then((e) => {
      attached = true;
      return e;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(attached).toBe(false);
    expect(el.hasAttribute('src')).toBe(false);
    FakeShaka.created[0]!.release();
    expect((await next).kind).toBe('native');
    expect(el.getAttribute('src')).toBe('http://h/n.mp4');
  });

  it('waits at most SHAKA_TEARDOWN_WAIT_MS, and a superseded request never touches the element', async () => {
    vi.useFakeTimers();
    const el = video();
    (await createEngine(el, dash, 'http://h/m.mpd', cb(), { captions: false })).destroy();
    const abort = new AbortController();
    const stale = createEngine(el, src('http://h/a.mp4', { isLive: false }), 'http://h/a.mp4', cb(), { captions: false, signal: abort.signal });
    const next = createEngine(el, src('http://h/b.mp4', { isLive: false }), 'http://h/b.mp4', cb(), { captions: false });
    abort.abort();
    await vi.advanceTimersByTimeAsync(engines.SHAKA_TEARDOWN_WAIT_MS);
    (await stale).destroy();
    expect((await next).kind).toBe('native');
    expect(el.getAttribute('src')).toBe('http://h/b.mp4');
  });

  it('an element shaka never held starts at once', async () => {
    vi.useFakeTimers();
    const pending = createEngine(video(), src('http://h/a.mp4', { isLive: false }), 'http://h/a.mp4', cb(), { captions: false });
    await vi.advanceTimersByTimeAsync(0);
    expect((await pending).kind).toBe('native');
  });
});

describe('extensionless live streams start in mpegts.js (PB-2)', () => {
  const { liveFormatFor, rememberLiveFormat, isUnlabelledLive } = engines;
  const ref = { sourceId: 's1', contentType: 'live' as const, itemId: '1' };
  const ch = (url: string, extra: Partial<PlayerSource> = {}): PlayerSource => src(url, { ref, ...extra });

  it('only live TV with no container in the URL counts', () => {
    expect(isUnlabelledLive(ch('http://h/live/u/p/101'))).toBe(true);
    expect(isUnlabelledLive(ch('http://h/live/u/p/101', { isRadio: true }))).toBe(false);
    expect(isUnlabelledLive(ch('http://h/movie/u/p/9', { isLive: false }))).toBe(false);
    expect(isUnlabelledLive(ch('http://h/live/u/p/101.m3u8'))).toBe(false);
    expect(isUnlabelledLive(ch('http://h/live/u/p/101.ts'))).toBe(false); // mpegts.js anyway, nothing to learn
  });

  it('starts in mpegts.js and remembers the host as MPEG-TS once it plays', async () => {
    const el = video();
    const engine = await createEngine(el, ch('http://h/live/u/p/101'), 'http://h/live/u/p/101', cb(), { captions: false });
    expect(engine.kind).toBe('mpegts');
    expect(FakeTsPlayer.created).toHaveLength(1);
    expect(liveFormatFor(ch('http://h/live/u/p/102'))).toBeUndefined();
    el.dispatchEvent(new Event('loadeddata'));
    expect(liveFormatFor(ch('http://h/live/u/p/102'))).toBe('ts');
    expect(JSON.parse(localStorage.getItem(engines.LIVE_FORMATS_KEY)!)).toEqual({ 's1|h': 'ts' });
  });

  it('hands the stream to the element once when mpegts.js finds no MPEG-TS, and remembers that', async () => {
    const el = video();
    const callbacks = cb();
    const engine = await createEngine(el, ch('http://h/live/u/p/101'), 'http://h/live/u/p/101', callbacks, { captions: false });
    const ts = FakeTsPlayer.created[0]!;
    ts.emit('error', 'MediaError', 'FormatUnsupported', { msg: 'Non MPEG-TS/FLV' });
    ts.emit('error', 'MediaError', 'FormatUnsupported', { msg: 'Non MPEG-TS/FLV' });
    await Promise.resolve();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(ts.destroyed).toBe(true);
    expect(engine.kind).toBe('native');
    expect(engine.fellBack).toBe(true);
    expect(el.getAttribute('src')).toBe('http://h/live/u/p/101');
    expect(el.play).toHaveBeenCalled();
    expect(liveFormatFor(ch('http://h/live/u/p/102'))).toBeUndefined();
    el.dispatchEvent(new Event('loadeddata'));
    expect(liveFormatFor(ch('http://h/live/u/p/102'))).toBe('native');

    // The next channel from that host goes to the element directly.
    const next = await createEngine(video(), ch('http://h/live/u/p/102'), 'http://h/live/u/p/102', cb(), { captions: false });
    expect(next.kind).toBe('native');
    expect(FakeTsPlayer.created).toHaveLength(1);
    engine.destroy();
    expect(el.hasAttribute('src')).toBe(false);
  });

  it('a format error after media played, or a refusal, is reported instead', async () => {
    const el = video();
    const callbacks = cb();
    const engine = await createEngine(el, ch('http://h/live/u/p/101'), 'http://h/live/u/p/101', callbacks, { captions: false });
    el.dispatchEvent(new Event('loadeddata'));
    FakeTsPlayer.created[0]!.emit('error', 'MediaError', 'FormatError', {});
    await Promise.resolve();
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'media', fatal: true }));
    expect(engine.kind).toBe('mpegts');

    const refused = cb();
    await createEngine(video(), ch('http://h2/live/u/p/7'), 'http://h2/live/u/p/7', refused, { captions: false });
    FakeTsPlayer.created[1]!.emit('error', 'NetworkError', 'HttpStatusCodeInvalid', { code: 404 });
    expect(refused.onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'network', message: 'HttpStatusCodeInvalid (HTTP 404)' }));
  });

  it('remembers per source and host; radio, VOD and named containers stay on the element', async () => {
    rememberLiveFormat(ch('http://h/live/u/p/1'), 'native');
    const otherSource = await createEngine(video(), ch('http://h/live/u/p/2', { ref: { ...ref, sourceId: 's2' } }), 'http://h/live/u/p/2', cb(), { captions: false });
    const otherHost = await createEngine(video(), ch('http://h2/live/u/p/2'), 'http://h2/live/u/p/2', cb(), { captions: false });
    expect([otherSource.kind, otherHost.kind]).toEqual(['mpegts', 'mpegts']);

    const radio = await createEngine(video(), ch('http://r/stream', { isRadio: true }), 'http://r/stream', cb(), { captions: false });
    const vod = await createEngine(video(), ch('http://h/movie/u/p/9', { isLive: false }), 'http://h/movie/u/p/9', cb(), { captions: false });
    const mp4 = await createEngine(video(), ch('http://h/live/clip.mp4'), 'http://h/live/clip.mp4', cb(), { captions: false });
    expect([radio.kind, vod.kind, mp4.kind]).toEqual(['native', 'native', 'native']);
    expect(FakeTsPlayer.created).toHaveLength(2);
  });

  it('a host remembered as native that the element rejects, and then plays in mpegts.js, is MPEG-TS again', async () => {
    rememberLiveFormat(ch('http://h/live/u/p/1'), 'native');
    const el = video();
    // The player's own retry after the element's error (`forceMpegts`).
    const engine = await createEngine(el, ch('http://h/live/u/p/1'), 'http://h/live/u/p/1', cb(), { captions: false, forceMpegts: true });
    expect(engine.kind).toBe('mpegts');
    expect(engine.fellBack).toBeUndefined();
    el.dispatchEvent(new Event('loadeddata'));
    expect(liveFormatFor(ch('http://h/live/u/p/3'))).toBe('ts');
  });

  it('a stored entry that is not a format map reads as nothing remembered', () => {
    localStorage.setItem(engines.LIVE_FORMATS_KEY, '["ts"]');
    expect(liveFormatFor(ch('http://h/live/u/p/1'))).toBeUndefined();
    localStorage.setItem(engines.LIVE_FORMATS_KEY, '{"s1|h":"flv"}');
    expect(liveFormatFor(ch('http://h/live/u/p/1'))).toBeUndefined();
    localStorage.setItem(engines.LIVE_FORMATS_KEY, '{oops');
    expect(liveFormatFor(ch('http://h/live/u/p/1'))).toBeUndefined();
  });
});

describe('CORS mode of the element (screenshots of local files and proxied streams, C6)', () => {
  const { mediaCrossOrigin } = engines;
  const PROXY = 'http://127.0.0.1:51234/0123456789abcdef0123456789abcdef01234567/api/proxy?url=http%3A%2F%2Fh%2Fm.mp4';

  it('loads the asset protocol and the desktop loopback proxy as anonymous', () => {
    expect(mediaCrossOrigin(`http://asset.localhost/${encodeURIComponent('C:\\Downloads\\Film.mp4')}`)).toBe('anonymous');
    expect(mediaCrossOrigin('https://asset.localhost/%2Fhome%2Fa%2Ffilm.mkv')).toBe('anonymous');
    expect(mediaCrossOrigin('asset://localhost/%2FUsers%2Fa%2Ffilm.mp4')).toBe('anonymous');
    expect(mediaCrossOrigin(PROXY)).toBe('anonymous');
    const token = 'http://127.0.0.1:51234/0123456789abcdef0123456789abcdef01234567/api';
    expect(mediaCrossOrigin(`${token}/recordings/f.636c69702e6d7034/media.mp4`)).toBe('anonymous');
    expect(mediaCrossOrigin(`${token}/files/7/media.mkv`)).toBe('anonymous');
  });

  it('leaves third-party and same-origin URLs alone', () => {
    // A provider without CORS would refuse a CORS load: the stream must still play.
    expect(mediaCrossOrigin('http://h/m.mp4')).toBeNull();
    expect(mediaCrossOrigin('http://127.0.0.1:7290/movie/u/p/1.mp4')).toBeNull();
    expect(mediaCrossOrigin('http://evil.example/x/api/proxy?url=y')).toBeNull();
    expect(mediaCrossOrigin('/api/proxy?url=http%3A%2F%2Fh%2Fm.mp4')).toBeNull();
    expect(mediaCrossOrigin('/api/files/abc')).toBeNull();
    expect(mediaCrossOrigin('http://evil.example/x/api/files/7/media.mp4')).toBeNull();
    expect(mediaCrossOrigin('blob:http://localhost/1')).toBeNull();
  });

  it('sets the mode before the load, and drops it for the next direct stream and on destroy', async () => {
    const el = video();
    const seen: (string | null)[] = [];
    const set = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!.set!;
    Object.defineProperty(el, 'src', {
      configurable: true,
      set(v: string) {
        seen.push(el.getAttribute('crossorigin'));
        set.call(el, v);
      },
    });
    const file = 'http://asset.localhost/C%3A%5Cv%5Ca.mp4';
    const local = await createEngine(el, src('C:\\v\\a.mp4', { kind: 'file', isLive: false }), file, cb(), { captions: false });
    expect(local.kind).toBe('native');
    expect(el.crossOrigin).toBe('anonymous');
    await createEngine(el, src('http://h/m.mp4', { isLive: false }), 'http://h/m.mp4', cb(), { captions: false });
    expect(el.hasAttribute('crossorigin')).toBe(false);
    const proxied = await createEngine(el, src('http://h/n.mp4', { isLive: false }), PROXY, cb(), { captions: false });
    proxied.destroy();
    expect(el.hasAttribute('crossorigin')).toBe(false);
    // The attribute was in place when each `src` was set.
    expect(seen).toEqual(['anonymous', null, 'anonymous']);
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

  it('maps errors: any HTTP status fails at once (the player reconnect owns retries), codec errors are unsupported', async () => {
    vi.useFakeTimers();
    const callbacks = cb();
    await createEngine(video(), src('http://h/a.ts'), 'http://h/a.ts', callbacks, { captions: false });
    const p2 = FakeTsPlayer.created[0]!;
    // A 503 used to restart here as well, stacking on the player's own retries (L2-live-5).
    p2.emit('error', 'NetworkError', 'HttpStatusCodeInvalid', { code: 503 });
    expect(callbacks.onError).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'network', message: 'HttpStatusCodeInvalid (HTTP 503)' }),
    );
    await vi.advanceTimersByTimeAsync(tsRestartDelay(1) * 4);
    expect(FakeTsPlayer.created).toHaveLength(1);
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
    el.dispatchEvent(new Event('loadeddata'));
    FakeTsPlayer.created[0]!.emit('error', 'NetworkError', 'Exception', { code: -1 });
    await vi.advanceTimersByTimeAsync(tsRestartDelay(1));
    expect(FakeTsPlayer.created).toHaveLength(2);
    expect(engine.timeOffset?.()).toBe(0);
  });

  it('a connection error restarts only a stream that produced media; before that it fails at once', async () => {
    vi.useFakeTimers();
    const el = video();
    const callbacks = cb();
    await createEngine(el, src('http://h/a.ts'), 'http://h/a.ts', callbacks, { captions: false });
    FakeTsPlayer.created[0]!.emit('error', 'NetworkError', 'Exception', { code: -1 });
    expect(callbacks.onError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'network', fatal: true }));
    await vi.advanceTimersByTimeAsync(tsRestartDelay(1) * 4);
    expect(FakeTsPlayer.created).toHaveLength(1);

    const el2 = video();
    const callbacks2 = cb();
    await createEngine(el2, src('http://h/b.ts'), 'http://h/b.ts', callbacks2, { captions: false });
    el2.dispatchEvent(new Event('loadeddata'));
    FakeTsPlayer.created[1]!.emit('error', 'NetworkError', 'Exception', { code: -1 });
    expect(callbacks2.onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(tsRestartDelay(1));
    expect(FakeTsPlayer.created).toHaveLength(3);
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

describe('MPEG-TS restarts at a seek or a resume (PL-2)', () => {
  type Plan = { url: string; at: number } | null;
  function seekerOf(plan: (t: number) => Plan | Promise<Plan>, duration = 1800) {
    return { duration: () => duration, usable: () => true, startAt: vi.fn(async (t: number) => plan(t)) };
  }
  /** An element whose clock, readiness, play state and buffered ranges the test sets. */
  function clockedVideo() {
    const el = video();
    const state = { t: 0, ready: 0, paused: false, ranges: [] as [number, number][] };
    Object.defineProperty(el, 'currentTime', { get: () => state.t, set: (v: number) => (state.t = v), configurable: true });
    Object.defineProperty(el, 'readyState', { get: () => state.ready, configurable: true });
    Object.defineProperty(el, 'paused', { get: () => state.paused, configurable: true });
    Object.defineProperty(el, 'buffered', {
      get: () => ({ length: state.ranges.length, start: (i: number) => state.ranges[i]![0], end: (i: number) => state.ranges[i]![1] }),
      configurable: true,
    });
    return { el, state };
  }
  const vodTs = (extra: Partial<PlayerSource> = {}) => src('http://h/v.ts', { isLive: false, ...extra });

  it('a resume starts where the seeker says, and the rest is sought inside the new stream', async () => {
    const { el, state } = clockedVideo();
    const seeker = seekerOf((t) => ({ url: 'http://h/v.ts?from=188000', at: Math.floor(t / 60) * 60 }));
    const engine = await createEngine(el, vodTs({ resumeSeconds: 1234 }), 'http://h/v.ts', cb(), { captions: false, seeker });
    expect(engine.resumes).toBe(true);
    expect(engine.duration?.()).toBe(1800);
    expect(seeker.startAt).toHaveBeenCalledWith(1234, expect.any(AbortSignal));
    await vi.waitFor(() => expect(FakeTsPlayer.created).toHaveLength(1));
    // Never a load from byte 0.
    expect(FakeTsPlayer.created[0]!.source.url).toBe('http://h/v.ts?from=188000');
    const shown = (): number => state.t + (engine.timeOffset?.() ?? 0);
    expect(shown()).toBe(1234);

    state.ready = 1;
    el.dispatchEvent(new Event('loadedmetadata'));
    expect(state.t).toBe(34);
    expect(shown()).toBe(1234);
    state.t = 40;
    expect(shown()).toBe(1240);
  });

  it('a seek past the buffer tears the pipeline down before asking where to start; one inside it is left to the element', async () => {
    const { el, state } = clockedVideo();
    const callbacks = cb();
    const order: string[] = [];
    const seeker = seekerOf((t) => {
      order.push(`asked with the old pipeline ${FakeTsPlayer.created[0]!.destroyed ? 'gone' : 'open'}`);
      return { url: `http://h/v.ts?from=${t * 1000}`, at: t };
    });
    const engine = await createEngine(el, vodTs(), 'http://h/v.ts', { ...callbacks, onWaiting: vi.fn() }, { captions: false, seeker });
    expect(engine.resumes).toBe(false);
    expect(FakeTsPlayer.created[0]!.source.url).toBe('http://h/v.ts');
    state.ranges = [[0, 40]];
    expect(engine.seek?.(30)).toBe(false);
    expect(seeker.startAt).not.toHaveBeenCalled();

    expect(engine.seek?.(600)).toBe(true);
    await vi.waitFor(() => expect(FakeTsPlayer.created).toHaveLength(2));
    expect(order).toEqual(['asked with the old pipeline gone']);
    expect(FakeTsPlayer.created[1]!.source.url).toBe('http://h/v.ts?from=600000');
    expect(el.play).toHaveBeenCalled();

    // Inside the new stream the element seeks again; before its start is a restart.
    state.ready = 1;
    el.dispatchEvent(new Event('loadedmetadata'));
    state.ranges = [[0, 30]];
    expect(engine.seek?.(610)).toBe(false);
    expect(engine.seek?.(590)).toBe(true);
    await vi.waitFor(() => expect(FakeTsPlayer.created).toHaveLength(3));
  });

  it('a seek while a restart resolves replaces it, and a paused player stays paused', async () => {
    const { el, state } = clockedVideo();
    state.paused = true;
    let first!: (p: Plan) => void;
    const seeker = seekerOf((t) => (t === 600 ? new Promise<Plan>((r) => (first = r)) : { url: `http://h/v.ts?from=${t}`, at: t }));
    const engine = await createEngine(el, vodTs(), 'http://h/v.ts', cb(), { captions: false, seeker });
    engine.seek?.(600);
    engine.seek?.(900);
    first({ url: 'http://h/v.ts?from=600', at: 600 });
    await vi.waitFor(() => expect(FakeTsPlayer.created).toHaveLength(2));
    await Promise.resolve();
    expect(FakeTsPlayer.created.map((p) => p.source.url)).toEqual(['http://h/v.ts', 'http://h/v.ts?from=900']);
    expect(el.play).not.toHaveBeenCalled();
    expect(state.t + (engine.timeOffset?.() ?? 0)).toBe(900);
  });

  it('without a start from the seeker it loads from 0 and seeks there; a failed lookup is a network error', async () => {
    const { el, state } = clockedVideo();
    const engine = await createEngine(el, vodTs(), 'http://h/v.ts', cb(), { captions: false, seeker: seekerOf(() => null) });
    engine.seek?.(300);
    await vi.waitFor(() => expect(FakeTsPlayer.created).toHaveLength(2));
    expect(FakeTsPlayer.created[1]!.source.url).toBe('http://h/v.ts');
    state.ready = 1;
    el.dispatchEvent(new Event('loadedmetadata'));
    expect(state.t).toBe(300);

    const callbacks = cb();
    const failing = seekerOf(() => Promise.reject(new Error('panel down')));
    await createEngine(clockedVideo().el, vodTs({ resumeSeconds: 900 }), 'http://h/v.ts', callbacks, { captions: false, seeker: failing });
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'panel down', kind: 'network' })));
  });

  it('a dropped connection comes back where it was, not at the start', async () => {
    vi.useFakeTimers();
    const { el, state } = clockedVideo();
    const seeker = seekerOf((t) => ({ url: `http://h/v.ts?from=${t}`, at: t }));
    const engine = await createEngine(el, vodTs(), 'http://h/v.ts', cb(), { captions: false, seeker });
    el.dispatchEvent(new Event('loadeddata'));
    state.t = 754;
    FakeTsPlayer.created[0]!.emit('error', 'NetworkError', 'Exception', { code: -1 });
    await vi.advanceTimersByTimeAsync(tsRestartDelay(1));
    expect(seeker.startAt).toHaveBeenCalledWith(754, expect.any(AbortSignal));
    await vi.waitFor(() => expect(FakeTsPlayer.created).toHaveLength(2));
    expect(FakeTsPlayer.created[1]!.source.url).toBe('http://h/v.ts?from=754');
    // The new pipeline's clock starts at 0; the shown position stays.
    state.t = 0;
    expect(state.t + (engine.timeOffset?.() ?? 0)).toBe(754);
    state.ready = 1;
    el.dispatchEvent(new Event('loadedmetadata'));
    state.t = 2;
    expect(state.t + (engine.timeOffset?.() ?? 0)).toBe(756);
  });

  it('a torn-down player asks the proxy to let go of the connection it keeps for a resume (PL-M1)', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const proxied = '/api/proxy?url=http%3A%2F%2Fh%2Fv.ts&sourceId=s1';
      (await createEngine(video(), vodTs(), proxied, cb(), { captions: false })).destroy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const asked = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
      expect(asked.pathname).toBe('/api/proxy');
      expect(Object.fromEntries(asked.searchParams)).toEqual({ url: 'http://h/v.ts', sourceId: 's1', release: '1' });
      // Live is never parked, and a URL off the proxy has nothing to release.
      (await createEngine(video(), src('http://h/a.ts'), '/api/proxy?url=http%3A%2F%2Fh%2Fa.ts&sourceId=s1', cb(), { captions: false })).destroy();
      (await createEngine(video(), vodTs(), 'http://h/v.ts', cb(), { captions: false })).destroy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bufferedAt: inside a range, not at its end', () => {
    const { el, state } = clockedVideo();
    state.ranges = [
      [0, 40],
      [100, 130],
    ];
    expect([0, 39.9, 40, 99, 100, 129.9, 130].map((t) => engines.bufferedAt(el, t))).toEqual([true, true, false, false, true, true, false]);
  });

  it('live streams and other engines ignore the seeker', async () => {
    const seeker = seekerOf(() => ({ url: 'x', at: 1 }));
    const live = await createEngine(video(), src('http://h/a.ts', { resumeSeconds: 50 }), 'http://h/a.ts', cb(), { captions: false, seeker });
    expect(live.resumes).toBe(false);
    expect(live.seek?.(100)).toBe(false);
    expect(live.duration?.()).toBeUndefined();
    const mp4 = await createEngine(video(), src('http://h/m.mp4', { isLive: false, resumeSeconds: 50 }), 'http://h/m.mp4', cb(), { captions: false, seeker });
    expect(mp4.seek).toBeUndefined();
    expect(seeker.startAt).not.toHaveBeenCalled();
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
    expect(isOwnServerUrl('http://127.0.0.1:51234/api/proxy?url=x')).toBe(true); // desktop loopback proxy (legacy form)
    expect(isOwnServerUrl('http://127.0.0.1:51234/s3cr3tTok/api/proxy?url=x')).toBe(true); // desktop loopback proxy with token
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

describe('showCaptions in the native engine', () => {
  const tracksOf = (callbacks: ReturnType<typeof cb>): boolean[] =>
    (callbacks.onTracks.mock.calls.at(-1)?.[0] as { text: { selected: boolean }[] }).text.map((x) => x.selected);

  it('turns the first subtitle track on once it appears; the menu wins after that', async () => {
    const el = video();
    const chapters = { kind: 'chapters', label: '', language: '', mode: 'disabled' as TextTrackMode };
    const en = { kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled' as TextTrackMode };
    const fr = { kind: 'captions', label: 'French', language: 'fr', mode: 'disabled' as TextTrackMode };
    Object.defineProperty(el, 'textTracks', { value: Object.assign([chapters, en, fr], { addEventListener() {}, removeEventListener() {} }) });
    const callbacks = cb();
    const engine = await createEngine(el, src('http://h/m.mp4', { isLive: false }), 'http://h/m.mp4', callbacks, { captions: true });
    el.dispatchEvent(new Event('loadedmetadata'));
    expect([en.mode, fr.mode]).toEqual(['showing', 'disabled']);
    expect(tracksOf(callbacks)).toEqual([true, false]);
    engine.setText(null);
    el.dispatchEvent(new Event('loadedmetadata'));
    expect([en.mode, tracksOf(callbacks)]).toEqual(['disabled', [false, false]]);
  });

  it('leaves the tracks alone when off, or when one is already on', async () => {
    const el = video();
    const en = { kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled' as TextTrackMode };
    Object.defineProperty(el, 'textTracks', { value: Object.assign([en], { addEventListener() {}, removeEventListener() {} }) });
    await createEngine(el, src('http://h/m.mp4', { isLive: false }), 'http://h/m.mp4', cb(), { captions: false });
    el.dispatchEvent(new Event('loadedmetadata'));
    expect(en.mode).toBe('disabled');

    const el2 = video();
    const de = { kind: 'subtitles', label: 'German', language: 'de', mode: 'disabled' as TextTrackMode };
    const it2 = { kind: 'subtitles', label: 'Italian', language: 'it', mode: 'showing' as TextTrackMode };
    Object.defineProperty(el2, 'textTracks', { value: Object.assign([de, it2], { addEventListener() {}, removeEventListener() {} }) });
    await createEngine(el2, src('http://h/n.mp4', { isLive: false }), 'http://h/n.mp4', cb(), { captions: true });
    el2.dispatchEvent(new Event('loadedmetadata'));
    expect([de.mode, it2.mode]).toEqual(['disabled', 'showing']);
  });
});

describe('subtitles drawn by the player (subtitles/inline.ts)', () => {
  it('native: a track the overlay draws (hidden) still counts as on, an engine-hidden one does not', async () => {
    const { drawTrack, isShownTrack } = await import('./subtitles/tracks');
    const el = video();
    const en = { kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled' as TextTrackMode };
    const fr = { kind: 'subtitles', label: 'French', language: 'fr', mode: 'hidden' as TextTrackMode };
    Object.defineProperty(el, 'textTracks', { value: Object.assign([en, fr], { addEventListener() {}, removeEventListener() {} }) });
    const callbacks = cb();
    const engine = await createEngine(el, src('http://h/m.mp4', { isLive: false }), 'http://h/m.mp4', callbacks, { captions: false });
    const selected = (): boolean[] => {
      el.dispatchEvent(new Event('loadedmetadata'));
      const last = callbacks.onTracks.mock.calls.at(-1)?.[0] as { text: { selected: boolean }[] };
      return last.text.map((x) => x.selected);
    };

    engine.setText('0');
    expect([en.mode, fr.mode]).toEqual(['showing', 'disabled']);
    // The overlay takes it over: hidden for the browser, still on for the menu.
    drawTrack(en as unknown as TextTrack);
    expect(en.mode).toBe('hidden');
    expect(selected()).toEqual([true, false]);

    engine.setText(null);
    expect(en.mode).toBe('disabled');
    // Hidden again later by someone else: not drawn, not on.
    en.mode = 'hidden';
    expect(isShownTrack(en as unknown as TextTrack)).toBe(false);
    expect(selected()).toEqual([false, false]);
  });
  it('native: across picture-in-picture the track that is on stays on, and Off there stays off', async () => {
    const { bindSubtitleOverlay } = await import('./subtitles/inline');
    const el = video();
    const en = Object.assign(new EventTarget(), { kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled' as TextTrackMode, activeCues: [] });
    const list = Object.assign(new EventTarget(), { 0: en, length: 1 });
    Object.defineProperty(el, 'textTracks', { value: list });
    const callbacks = cb();
    const engine = await createEngine(el, src('http://h/m.mp4', { isLive: false }), 'http://h/m.mp4', callbacks, { captions: false });
    const box = document.createElement('div');
    const stop = bindSubtitleOverlay(el, box);
    const selected = (): boolean => {
      el.dispatchEvent(new Event('loadedmetadata'));
      const last = callbacks.onTracks.mock.calls.at(-1)?.[0] as { text: { selected: boolean }[] };
      return last.text[0]!.selected;
    };
    const change = (): boolean => list.dispatchEvent(new Event('change'));

    engine.setText('0');
    change();
    expect([en.mode, selected()]).toEqual(['hidden', true]);
    el.dispatchEvent(new Event('enterpictureinpicture'));
    expect([en.mode, selected(), box.hidden]).toEqual(['showing', true, true]);
    el.dispatchEvent(new Event('leavepictureinpicture'));
    expect([en.mode, selected(), box.hidden]).toEqual(['hidden', true, false]);

    el.dispatchEvent(new Event('enterpictureinpicture'));
    engine.setText(null);
    change();
    expect([en.mode, selected()]).toEqual(['disabled', false]);
    el.dispatchEvent(new Event('leavepictureinpicture'));
    expect([en.mode, selected()]).toEqual(['disabled', false]);
    stop();
  });
});
