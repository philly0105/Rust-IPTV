/**
 * Seeking in MPEG-TS played by mpegts.js (players.md, Seeking in MPEG-TS). mpegts.js can't seek in
 * MPEG-TS: a seek past what it holds waited while it loaded everything before the target, and a
 * resume started at 0 and did the same. So the engine restarts its pipeline where a `TsSeeker` says
 * the target is:
 * - Xtream catch-up: the archive link, asked for again from the target minute;
 * - a recording or a download (the app's own file routes), and a remote file through the proxy:
 *   the byte where the target time is, found from the PTS in small Range probes and loaded with
 *   `?from=<byte>` (server.md), which the routes and the proxy serve as if the file began there.
 */

import { proxiedUrl, rpc } from '@/api/transport';
import type { ItemRef, PlayerSource } from '@/api/types';

import { proxyRoute } from './engines';

/** Where a restarted pipeline starts. */
export interface TsStart {
  /** The URL to load: the same media from `at` on. */
  url: string;
  /** Item time, in seconds, of the new stream's first media. */
  at: number;
}

export interface TsSeeker {
  /** The item's length in seconds, once known: the stream itself never says. */
  duration(): number | undefined;
  /** False once it is known that this media can only start at its beginning. */
  usable(): boolean;
  /** Learns the length up front where that is cheap (a local file). Never throws. */
  prepare?(): Promise<void>;
  /**
   * Where to restart for `seconds`: at it or a little before. Null when this media can only start
   * at its beginning. Throws when asking failed and may work later (the archive link, a refused
   * probe).
   */
  startAt(seconds: number, signal: AbortSignal): Promise<TsStart | null>;
}

/** The seeker for a non-live source loaded from `loadUrl`, or undefined when none can seek it. */
export function tsSeekerFor(source: PlayerSource, loadUrl: string): TsSeeker | undefined {
  if (source.isLive) return undefined;
  const { ref, catchup } = source;
  if (catchup && ref) return catchupSeeker(source, ref, catchup, loadUrl);
  if (isFileRoute(loadUrl)) return byteSeeker(loadUrl, source.durationSeconds, true);
  if (proxyRoute(loadUrl)) return byteSeeker(loadUrl, source.durationSeconds, false);
  return undefined;
}

// ---------------------------------------------------------------------------
// Xtream catch-up
// ---------------------------------------------------------------------------

function catchupSeeker(source: PlayerSource, ref: ItemRef, archive: NonNullable<PlayerSource['catchup']>, loadUrl: string): TsSeeker {
  const startMs = Date.parse(archive.start);
  return {
    duration: () => source.durationSeconds,
    usable: () => Number.isFinite(startMs),
    async startAt(seconds) {
      // The panel starts an archive link on a whole minute (`catchup_stamp`), and refuses one that
      // has not aired yet: a programme still on air restarts at its last aired minute.
      const aired = Math.floor((Date.now() - startMs) / 60_000) - 1;
      const minute = Math.max(0, Math.min(Math.floor(seconds / 60), aired, archive.durationMinutes - 1));
      if (!minute) return { url: loadUrl, at: 0 };
      const fresh = await rpc('xtream.catchupUrl', {
        ref,
        start: new Date(startMs + minute * 60_000).toISOString(),
        durationMinutes: archive.durationMinutes - minute,
      });
      return { url: proxiedUrl({ ...source, url: fresh.url, headers: fresh.headers ?? source.headers }), at: minute * 60 };
    },
  };
}

// ---------------------------------------------------------------------------
// Byte offsets from PTS
// ---------------------------------------------------------------------------

/** Bytes per probe: a few tenths of a second of an HD stream, so it holds a PES header. */
export const PROBE_BYTES = 128 * 1024;
/**
 * Probes per seek. A local file answers in about a millisecond, so the search runs until it is
 * within a second; each remote probe is a request to the provider, so three refine the estimate
 * and the in-buffer seek after the restart covers what is left.
 */
export const LOCAL_PROBES = 12;
export const REMOTE_PROBES = 3;
const TS_CLOCK = 90_000;
const PTS_WRAP = 2 ** 33;

/** The app's own file routes: `/api/files/{id}`, `/api/recordings/{id}`, the loopback `/<token>/api/.../{id}/{name}`. */
const FILE_ROUTE = /\/api\/(files|recordings)\/[^/]+(\/[^/]+)?$/;

function isFileRoute(url: string): boolean {
  try {
    const u = new URL(url, window.location.href);
    return FILE_ROUTE.test(u.pathname) && (u.origin === window.location.origin || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** `url` loaded from byte `byte` on (`?from=`, server.md). */
export function withByteStart(url: string, byte: number): string {
  const u = new URL(url, window.location.href);
  u.searchParams.set('from', String(byte));
  return u.href;
}

/** The packet size (188, or 192 for M2TS) and the offset of the first whole packet in `b`; null when `b` is not MPEG-TS. */
export function tsGrid(b: Uint8Array): { size: number; origin: number } | null {
  for (const size of [188, 192]) {
    // M2TS puts a 4-byte timestamp before each sync byte.
    const lead = size - 188;
    for (let i = lead; i < size + lead && i + 2 * size < b.length; i++) {
      if (b[i] === 0x47 && b[i + size] === 0x47 && b[i + 2 * size] === 0x47) return { size, origin: i - lead };
    }
  }
  return null;
}

export interface PesStart {
  /** Offset in the bytes of the packet the PES starts in. */
  offset: number;
  pid: number;
  /** 90 kHz. */
  pts: number;
  video: boolean;
}

/** Every audio or video PES that starts with a PTS in `b`, in order. */
export function pesStarts(b: Uint8Array): PesStart[] {
  const grid = tsGrid(b);
  if (!grid) return [];
  const lead = grid.size - 188;
  const out: PesStart[] = [];
  for (let at = grid.origin; at + grid.size <= b.length; at += grid.size) {
    const i = at + lead;
    // Payload unit start, and a payload.
    if (b[i] !== 0x47 || !(b[i + 1]! & 0x40) || !(b[i + 3]! & 0x10)) continue;
    const pid = ((b[i + 1]! & 0x1f) << 8) | b[i + 2]!;
    const p = b[i + 3]! & 0x20 ? i + 5 + b[i + 4]! : i + 4;
    if (p + 14 > i + 188 || b[p] !== 0 || b[p + 1] !== 0 || b[p + 2] !== 1) continue;
    const sid = b[p + 3]!;
    const video = sid >= 0xe0 && sid <= 0xef;
    const audio = (sid >= 0xc0 && sid <= 0xdf) || sid === 0xbd;
    if ((!video && !audio) || !(b[p + 7]! & 0x80)) continue;
    const o = p + 9;
    // 33 bits: the top three go past 32-bit integer arithmetic.
    const pts = (b[o]! & 0x0e) * 2 ** 29 + ((b[o + 1]! << 22) | ((b[o + 2]! & 0xfe) << 14) | (b[o + 3]! << 7) | (b[o + 4]! >> 1));
    out.push({ offset: at, pid, pts, video });
  }
  return out;
}

/** Seconds from PTS `first` to `pts`, across a 33-bit wrap. */
function since(first: number, pts: number): number {
  return ((((pts - first) % PTS_WRAP) + PTS_WRAP) % PTS_WRAP) / TS_CLOCK;
}

interface Layout {
  total: number;
  size: number;
  origin: number;
  /** The PID whose PTS stand for the time: the first video PES's, else the first one's. */
  pid: number;
  firstPts: number;
  /** From the last PES in the file; undefined when its tail had none. */
  duration?: number;
}

interface Point {
  byte: number;
  time: number;
}

/**
 * `length` bytes from `from`. Null when the server sent the whole file (200): it takes no byte
 * ranges. Any other answer throws, since it may pass (a one-connection account still counting the
 * stream just closed).
 */
async function probe(url: string, from: number, length: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; total: number } | null> {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${from + length - 1}` }, cache: 'no-store', signal });
  const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('Content-Range') ?? '')?.[1]);
  if (res.status !== 206 || !Number.isFinite(total)) {
    // Let go of the body (a 200 is the whole file) at once.
    void res.body?.cancel().catch(() => undefined);
    if (res.status === 200) return null;
    throw new Error(`HTTP ${res.status} to a byte range request`);
  }
  return { bytes: new Uint8Array(await res.arrayBuffer()), total };
}

async function readLayout(url: string, wantEnd: boolean): Promise<Layout | null> {
  const head = await probe(url, 0, PROBE_BYTES);
  const grid = head && tsGrid(head.bytes);
  if (!head || !grid) return null;
  const starts = pesStarts(head.bytes);
  const first = starts.find((s) => s.video) ?? starts[0];
  if (!first) return null;
  const out: Layout = { total: head.total, ...grid, pid: first.pid, firstPts: first.pts };
  if (wantEnd && head.total > PROBE_BYTES) {
    const tail = await probe(url, head.total - PROBE_BYTES, PROBE_BYTES);
    const last = tail ? pesStarts(tail.bytes).filter((s) => s.pid === first.pid).pop() : undefined;
    if (last) out.duration = since(first.pts, last.pts);
  }
  return out;
}

/**
 * Seeks by byte offset in a file served with Range: `known` is the item's length when its source
 * says (catch-up), else the file's own (its last PTS). `local` files are probed up front and
 * searched to within a second; remote ones only when a seek needs it.
 */
function byteSeeker(loadUrl: string, known: number | undefined, local: boolean): TsSeeker {
  const budget = local ? LOCAL_PROBES : REMOTE_PROBES;
  const close = local ? 1 : 3;
  let layout: Layout | null = null;
  /** The file takes no byte ranges or is not MPEG-TS: it only starts at its beginning. */
  let failed = false;
  let learning: Promise<Layout | null> | null = null;
  /** Throws when asking failed in a way the next seek may get past. */
  const learn = (): Promise<Layout | null> => {
    if (layout || failed) return Promise.resolve(layout);
    learning ??= readLayout(loadUrl, known === undefined).then(
      (l) => {
        learning = null;
        layout = l;
        failed = !l;
        return l;
      },
      (err: unknown) => {
        learning = null;
        throw err;
      },
    );
    return learning;
  };
  const length = (): number | undefined => known ?? layout?.duration;
  /** The first PES at or after `byte` (on the time PID if it has one there); null when it can't tell. */
  const pointAt = async (l: Layout, byte: number, signal: AbortSignal): Promise<Point | null> => {
    const chunk = await probe(loadUrl, byte, PROBE_BYTES, signal).catch(() => null);
    if (!chunk) return null;
    const starts = pesStarts(chunk.bytes);
    const hit = starts.find((s) => s.pid === l.pid) ?? starts[0];
    return hit ? { byte: byte + hit.offset, time: since(l.firstPts, hit.pts) } : null;
  };
  return {
    duration: length,
    usable: () => !failed,
    prepare: local ? () => learn().then(() => undefined, () => undefined) : undefined,
    async startAt(seconds, signal) {
      const l = await learn();
      const end = length();
      if (!l || !end || end <= 0) return null;
      if (seconds < close) return { url: loadUrl, at: 0 };
      // Search the byte between the closest known points before and after the target (`lo`,
      // `hi`): the first guess is proportional, later ones follow the bitrate between the last two
      // probes (secant), which a file of changing bitrate needs. Each aims a little early, so
      // the search ends on a point just before the target.
      const aim = seconds - close / 2;
      let lo: Point = { byte: 0, time: 0 };
      let hi: Point = { byte: l.total, time: end };
      let last: Point | null = null;
      let prev: Point | null = null;
      for (let n = 0; n < budget && seconds - lo.time > close; n++) {
        if (hi.time <= lo.time || hi.byte - lo.byte <= 2 * PROBE_BYTES) break;
        const [a, b] = last && prev && last.time !== prev.time ? [prev, last] : [lo, hi];
        let guess = a.byte + ((aim - a.time) / (b.time - a.time)) * (b.byte - a.byte);
        if (!(guess > lo.byte && guess < hi.byte)) guess = lo.byte + ((aim - lo.time) / (hi.time - lo.time)) * (hi.byte - lo.byte);
        const clamped = Math.min(Math.max(guess, lo.byte + l.size), hi.byte - PROBE_BYTES);
        const byte = l.origin + Math.floor((clamped - l.origin) / l.size) * l.size;
        const hit = await pointAt(l, byte, signal);
        if (!hit || hit.byte <= lo.byte || hit.byte >= hi.byte) break;
        prev = last;
        last = hit;
        if (hit.time <= seconds) lo = hit;
        else hi = hit;
      }
      if (lo.byte > 0) return { url: withByteStart(loadUrl, lo.byte), at: lo.time };
      // Nothing found before the target: a start a moment after it beats loading all before it.
      if (hi.byte < l.total && hi.time - seconds <= close) return { url: withByteStart(loadUrl, hi.byte), at: hi.time };
      return { url: loadUrl, at: 0 };
    },
  };
}
