import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlayerSource } from '@/api/types';

const rpcMock = vi.fn();
vi.mock('@/api/transport', () => ({
  rpc: (...args: unknown[]) => rpcMock(...args),
  proxiedUrl: (s: PlayerSource) => `/api/proxy?url=${encodeURIComponent(s.url)}`,
}));

const { GROW_CHECK_MS, LOCAL_PROBES, PROBE_BYTES, REMOTE_PROBES, pesStarts, tsGrid, tsSeekerFor, withByteStart } = await import('./tsSeek');

// ---------------------------------------------------------------------------
// MPEG-TS bytes
// ---------------------------------------------------------------------------

const VIDEO_PID = 0x100;
const AUDIO_PID = 0x101;

function ptsBytes(pts: number): number[] {
  return [
    0x21 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1),
    Math.floor(pts / 2 ** 22) & 0xff,
    ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1,
    Math.floor(pts / 2 ** 7) & 0xff,
    ((pts % 128) << 1) | 1,
  ];
}

/** One 188-byte packet; `pts` makes it the start of a PES (`sid` 0xe0 video, 0xc0 audio). */
function packet(pid: number, pts?: number, opts: { sid?: number; adaptation?: number } = {}): Uint8Array {
  const b = new Uint8Array(188).fill(0xff);
  const af = opts.adaptation ?? 0;
  b[0] = 0x47;
  b[1] = (pts !== undefined ? 0x40 : 0) | (pid >> 8);
  b[2] = pid & 0xff;
  b[3] = 0x10 | (af ? 0x20 : 0);
  let p = 4;
  if (af) {
    b[4] = af;
    p = 5 + af;
  }
  if (pts !== undefined) b.set([0, 0, 1, opts.sid ?? 0xe0, 0, 0, 0x80, 0x80, 5, ...ptsBytes(pts)], p);
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('MPEG-TS parsing', () => {
  it('finds the packet grid of 188- and 192-byte packets', () => {
    const ts = concat([packet(1), packet(1), packet(1), packet(1)]);
    expect(tsGrid(ts.subarray(37))).toEqual({ size: 188, origin: 151 });
    const m2ts = concat([0, 1, 2, 3].map(() => concat([new Uint8Array(4), packet(1)])));
    expect(tsGrid(m2ts)).toEqual({ size: 192, origin: 0 });
    expect(tsGrid(new Uint8Array(1000))).toBeNull();
  });

  it('reads 33-bit PTS of audio and video PES starts, past an adaptation field', () => {
    const big = 2 ** 33 - 90_000;
    const b = concat([packet(VIDEO_PID, 900_000), packet(VIDEO_PID), packet(AUDIO_PID, big, { sid: 0xc0, adaptation: 7 }), packet(0x1fff)]);
    expect(pesStarts(b)).toEqual([
      { offset: 0, pid: VIDEO_PID, pts: 900_000, video: true },
      { offset: 376, pid: AUDIO_PID, pts: big, video: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// A long virtual file behind a Range server
// ---------------------------------------------------------------------------

/**
 * 30 minutes at 25 frames a second, never held in memory: a video PES per frame on VIDEO_PID,
 * I-frames (every 50th) 40 packets long and the rest 4, and every frame in the second half twice
 * as long, so bytes are far from proportional to time. PTS start near the 33-bit wrap.
 */
const FRAMES = 30 * 60 * 25;
const FIRST_PTS = 2 ** 33 - 10 * 90_000;
const frameAt: number[] = [];
let PACKETS = 0;
for (let f = 0; f < FRAMES; f++) {
  frameAt.push(PACKETS);
  PACKETS += (f % 50 === 0 ? 40 : 4) * (f >= FRAMES / 2 ? 2 : 1);
}
const TOTAL = PACKETS * 188;
const frameOfPacket = new Int32Array(PACKETS).fill(-1);
frameAt.forEach((p, f) => (frameOfPacket[p] = f));
const ptsOf = (f: number): number => (FIRST_PTS + f * 3600) % 2 ** 33;
/** Each frame's PTS; undefined: no PES starts there. */
type PtsOf = (f: number) => number | undefined;

function fileBytes(from: number, to: number, pts: PtsOf = ptsOf): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(to - from + 1);
  for (let pkt = Math.floor(from / 188); pkt * 188 <= to; pkt++) {
    const f = frameOfPacket[pkt] ?? -1;
    const bytes = packet(VIDEO_PID, f >= 0 ? pts(f) : undefined);
    const start = pkt * 188;
    const lo = Math.max(from, start);
    const hi = Math.min(to, start + 187);
    out.set(bytes.subarray(lo - start, hi - start + 1), lo - from);
  }
  return out;
}

/** The byte where frame `f` (time f / 25) starts. */
const byteOfTime = (seconds: number): number => (frameAt[Math.round(seconds * 25)] ?? 0) * 188;

interface Served {
  requests: string[];
  bytes: number;
}

/**
 * Serves the virtual file with Range. `size`: how much of it exists now (a recording being
 * written); `noSize`: Content-Range gives `*` for the size; `pts`: the frames' PTS.
 */
function serveRanges(opts: { ranges?: boolean; size?: () => number; noSize?: boolean; pts?: PtsOf } = {}): Served {
  const served: Served = { requests: [], bytes: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('Range') ?? '';
      served.requests.push(range);
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!m || opts.ranges === false) return new Response(new Uint8Array(16), { status: 200 });
      const size = opts.size?.() ?? TOTAL;
      const from = Number(m[1]);
      const to = Math.min(Number(m[2]), size - 1);
      served.bytes += to - from + 1;
      const range206 = `bytes ${from}-${to}/${opts.noSize ? '*' : size}`;
      return new Response(fileBytes(from, to, opts.pts), { status: 206, headers: { 'Content-Range': range206 } });
    }),
  );
  return served;
}

function vod(url: string, extra: Partial<PlayerSource> = {}): PlayerSource {
  return { url, kind: 'file', title: 'Rec', isLive: false, isRadio: false, ...extra };
}

const signal = new AbortController().signal;

beforeEach(() => {
  rpcMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('seeking a local recording or download by byte (PL-2)', () => {
  const LOCAL = 'http://127.0.0.1:5555/tok/api/recordings/f.61/media.ts';

  it('learns the length from the PTS up front and starts within a second before the target', async () => {
    const served = serveRanges();
    const seeker = tsSeekerFor(vod(LOCAL), LOCAL)!;
    expect(seeker).toBeDefined();
    await seeker.prepare?.();
    // The last frame's PTS, across the wrap.
    expect(seeker.duration()).toBeCloseTo((FRAMES - 1) / 25, 3);
    // The head, the tail, and the middle, whose PTS must lie in between.
    const mid = Math.floor(TOTAL / 2 / 188) * 188;
    expect(served.requests).toEqual([`bytes=0-${PROBE_BYTES - 1}`, `bytes=${TOTAL - PROBE_BYTES}-${TOTAL - 1}`, `bytes=${mid}-${mid + PROBE_BYTES - 1}`]);

    for (const target of [600, 1200, 1500.5, 1790]) {
      served.requests.length = 0;
      served.bytes = 0;
      const plan = (await seeker.startAt(target, signal))!;
      expect(plan.at).toBeLessThanOrEqual(target);
      expect(target - plan.at).toBeLessThan(1);
      const from = Number(new URL(plan.url).searchParams.get('from'));
      expect(from % 188).toBe(0);
      // The byte is the start of the frame shown at `at`.
      expect(from).toBe(byteOfTime(plan.at));
      expect(served.requests.length).toBeLessThanOrEqual(LOCAL_PROBES);
      // A few probes against the whole prefix the player used to read first.
      expect(served.bytes).toBeLessThan(byteOfTime(target) / 4);
    }
  });

  it('starts at 0 for the first second, and not at all without Range', async () => {
    serveRanges();
    const seeker = tsSeekerFor(vod(LOCAL), LOCAL)!;
    expect(await seeker.startAt(0.4, signal)).toEqual({ url: LOCAL, at: 0 });

    serveRanges({ ranges: false });
    const plain = tsSeekerFor(vod(LOCAL), LOCAL)!;
    await plain.prepare?.();
    expect(plain.usable()).toBe(false);
    expect(await plain.startAt(600, signal)).toBeNull();
  });

  it('a refused probe fails that seek only', async () => {
    serveRanges();
    const ranges = globalThis.fetch;
    let refuse = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => (refuse ? new Response(null, { status: 403 }) : ranges(url, init))),
    );
    const seeker = tsSeekerFor(vod(LOCAL), LOCAL)!;
    await seeker.prepare?.();
    expect(seeker.usable()).toBe(true);
    await expect(seeker.startAt(600, signal)).rejects.toThrow('HTTP 403');
    expect(seeker.usable()).toBe(true);
    refuse = false;
    const plan = (await seeker.startAt(600, signal))!;
    expect(600 - plan.at).toBeLessThan(1);
  });

  it('a recording still being written: the length follows the file, and seeks reach past where it was', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T20:00:00Z'));
    let size = byteOfTime(600);
    const served = serveRanges({ size: () => size });
    const seeker = tsSeekerFor(vod(LOCAL), LOCAL)!;
    await seeker.prepare?.();
    expect(seeker.duration()).toBeCloseTo(599.96, 2);

    // Four minutes later the file holds 14.
    size = byteOfTime(840);
    const checked = Date.parse('2026-10-22T20:04:00Z');
    vi.setSystemTime(checked);
    seeker.duration();
    // (vi.waitFor moves the fake clock on.)
    await vi.waitFor(() => expect(seeker.duration()).toBeCloseTo(839.96, 2));
    const plan = (await seeker.startAt(800, signal))!;
    expect(800 - plan.at).toBeLessThan(1);
    expect(Number(new URL(plan.url).searchParams.get('from'))).toBe(byteOfTime(plan.at));

    // Looked at once per GROW_CHECK_MS, one byte each time it didn't grow.
    served.requests.length = 0;
    vi.setSystemTime(checked + GROW_CHECK_MS - 1);
    seeker.duration();
    expect(served.requests).toEqual([]);
    vi.setSystemTime(checked + GROW_CHECK_MS);
    seeker.duration();
    await vi.waitFor(() => expect(served.requests).toEqual(['bytes=0-0']));
  });

  it('a download is complete: its size is never looked at again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const served = serveRanges();
    const download = 'http://127.0.0.1:5555/tok/api/files/12/media.ts';
    const seeker = tsSeekerFor(vod(download), download)!;
    await seeker.prepare?.();
    served.requests.length = 0;
    vi.setSystemTime(Date.now() + 10 * GROW_CHECK_MS);
    seeker.duration();
    await Promise.resolve();
    expect(served.requests).toEqual([]);
  });

  it('a reconnect part whose clock restarted: no length, and the element seeks itself', async () => {
    // From minute 25 the PTS run on from two hours below the first: the last PTS read as about
    // 24.6 hours after it.
    const reset = 25 * 60 * 25;
    serveRanges({ pts: (f) => (f < reset ? ptsOf(f) : (FIRST_PTS - 2 * 3600 * 90_000 + (f - reset) * 3600 + 2 ** 33) % 2 ** 33) });
    const seeker = tsSeekerFor(vod(LOCAL), LOCAL)!;
    await seeker.prepare?.();
    expect(seeker.duration()).toBeUndefined();
    expect(seeker.usable()).toBe(false);
    expect(await seeker.startAt(600, signal)).toBeNull();
  });

  it('a file with no PES in its tail has no length: the element seeks itself', async () => {
    serveRanges({ pts: (f) => (f < FRAMES - 200 ? ptsOf(f) : undefined) });
    const seeker = tsSeekerFor(vod(LOCAL), LOCAL)!;
    await seeker.prepare?.();
    expect(seeker.duration()).toBeUndefined();
    expect(seeker.usable()).toBe(false);
  });

  it('server mode: the same-origin file route', () => {
    expect(tsSeekerFor(vod('/api/files/12'), '/api/files/12')).toBeDefined();
    expect(withByteStart('/api/files/12', 376)).toBe(new URL('/api/files/12?from=376', window.location.href).href);
  });
});

describe('seeking a remote TS file through the proxy by estimate (PL-2)', () => {
  const PROXIED = '/api/proxy?url=http%3A%2F%2Fprov%2Fmovie%2Fu%2Fp%2F7.ts&sourceId=x';

  it('probes only when a seek needs it, a couple of times, and gets within seconds', async () => {
    const served = serveRanges();
    const seeker = tsSeekerFor(vod('http://prov/movie/u/p/7.ts', { kind: 'direct', durationSeconds: (FRAMES - 1) / 25 }), PROXIED)!;
    expect(seeker.prepare).toBeUndefined();
    expect(seeker.duration()).toBeCloseTo(1799.96, 2);
    expect(served.requests).toEqual([]);

    const plan = (await seeker.startAt(1200, signal))!;
    // The head (first PTS and the size), then at most REMOTE_PROBES refinements, although bytes
    // per second double halfway through the file.
    expect(served.requests.length).toBeLessThanOrEqual(1 + REMOTE_PROBES);
    expect(plan.at).toBeLessThanOrEqual(1200);
    expect(1200 - plan.at).toBeLessThan(3);
    expect(new URL(plan.url).searchParams.get('url')).toBe('http://prov/movie/u/p/7.ts');
    expect(Number(new URL(plan.url).searchParams.get('from'))).toBe(byteOfTime(plan.at));

    served.requests.length = 0;
    await seeker.startAt(300, signal);
    expect(served.requests.length).toBeLessThanOrEqual(REMOTE_PROBES);
  });

  it('without a length from the source, the first seek reads it from the tail', async () => {
    const served = serveRanges();
    const seeker = tsSeekerFor(vod('http://prov/movie/u/p/7.ts', { kind: 'direct' }), PROXIED)!;
    expect(seeker.duration()).toBeUndefined();
    const plan = (await seeker.startAt(1200, signal))!;
    expect(seeker.duration()).toBeCloseTo(1799.96, 2);
    // The head and the tail, no middle (a request to the provider each), then the search.
    expect(served.requests.slice(0, 2)).toEqual([`bytes=0-${PROBE_BYTES - 1}`, `bytes=${TOTAL - PROBE_BYTES}-${TOTAL - 1}`]);
    expect(served.requests.length).toBeLessThanOrEqual(2 + REMOTE_PROBES);
    expect(1200 - plan.at).toBeLessThan(3);
  });

  it('a stream that answers a range without its size (`/*`) is not searched: no seek by restart', async () => {
    serveRanges({ noSize: true });
    const seeker = tsSeekerFor(vod('http://prov/movie/u/p/7.ts', { kind: 'direct' }), PROXIED)!;
    expect(await seeker.startAt(600, signal)).toBeNull();
    expect(seeker.usable()).toBe(false);
  });

  it('a direct remote URL and live TV get no seeker', () => {
    expect(tsSeekerFor(vod('http://prov/a.ts', { kind: 'direct' }), 'http://prov/a.ts')).toBeUndefined();
    expect(tsSeekerFor(vod('http://prov/a.ts', { isLive: true }), PROXIED)).toBeUndefined();
  });
});

describe('seeking Xtream catch-up by asking from a later minute (PL-2)', () => {
  const ref = { sourceId: 'x', contentType: 'live' as const, itemId: '10' };
  const archive = (extra: Partial<PlayerSource> = {}): PlayerSource =>
    vod('http://p/timeshift/u/p/90/2026-10-22:18-00/10.ts', {
      kind: 'direct',
      ref,
      durationSeconds: 5400,
      catchup: { start: '2026-10-22T18:00:00Z', durationMinutes: 90 },
      ...extra,
    });

  it('asks for the archive from the target minute with what is left of the programme', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T21:00:00Z'));
    rpcMock.mockResolvedValue({ url: 'http://p/timeshift/u/p/70/2026-10-22:18-20/10.ts', kind: 'direct', title: 'x', isLive: false, isRadio: false });
    const seeker = tsSeekerFor(archive(), '/api/proxy?url=first')!;
    expect(seeker.duration()).toBe(5400);

    const plan = await seeker.startAt(20 * 60 + 34, signal);
    expect(rpcMock).toHaveBeenCalledWith('xtream.catchupUrl', { ref, start: '2026-10-22T18:20:00.000Z', durationMinutes: 70 });
    expect(plan).toEqual({ url: `/api/proxy?url=${encodeURIComponent('http://p/timeshift/u/p/70/2026-10-22:18-20/10.ts')}`, at: 1200 });

    // The first minute is the link already playing.
    rpcMock.mockClear();
    expect(await seeker.startAt(42, signal)).toEqual({ url: '/api/proxy?url=first', at: 0 });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('a programme still on air restarts at its last aired minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T18:30:30Z'));
    rpcMock.mockResolvedValue({ url: 'http://p/x.ts', kind: 'direct', title: 'x', isLive: false, isRadio: false });
    const plan = await tsSeekerFor(archive(), '/api/proxy?url=first')!.startAt(60 * 60, signal);
    expect(rpcMock).toHaveBeenCalledWith('xtream.catchupUrl', expect.objectContaining({ start: '2026-10-22T18:29:00.000Z', durationMinutes: 61 }));
    expect(plan?.at).toBe(29 * 60);
  });

  it('a failed lookup is an error for the engine to report', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T21:00:00Z'));
    rpcMock.mockRejectedValue(new Error('panel down'));
    await expect(tsSeekerFor(archive(), '/api/proxy?url=first')!.startAt(1800, signal)).rejects.toThrow('panel down');
  });
});
