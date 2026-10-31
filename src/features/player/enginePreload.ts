/**
 * Warms the playback engines before they are needed. hls.js (about 590 KB) and mpegts.js load
 * on demand (`engines.ts`); fetched only after the click, they made the first play of a session
 * about three times slower than the next. A page that plays streams asks for both while the
 * browser is idle (`preloadEngines`), and every play request asks for the one its URL needs
 * right away (`preloadEngineFor`). Each module is fetched once; the engines' own `import()`
 * then resolves from the module cache.
 */

import { queryClient, rpcKey } from '@/api/query';
import { isDesktop } from '@/api/transport';
import type { Settings, VideoPlayer } from '@/api/types';

type Loader = () => Promise<unknown>;

const DEFAULT_LOADERS: Record<'hls' | 'mpegts', Loader> = {
  hls: () => import('hls.js'),
  mpegts: () => import('mpegts.js'),
};

let loaders = DEFAULT_LOADERS;
/** Unit tests run without it (jsdom has no MSE; loading the engines there only costs time). */
let enabled = import.meta.env.MODE !== 'test';
const loaded = new Map<keyof typeof DEFAULT_LOADERS, Promise<unknown>>();
let idleQueued = false;

function load(name: keyof typeof DEFAULT_LOADERS): void {
  if (!enabled || loaded.has(name)) return;
  const job = loaders[name]().catch(() => {
    // A failed fetch (offline in server mode) is tried again by the next request.
    loaded.delete(name);
  });
  loaded.set(name, job);
}

/**
 * Run `fn` once the frame that answers the current input has painted: a click paints the tuned
 * state first, and engine work (fetching, evaluating and starting hls.js or mpegts.js) comes
 * after it instead of delaying that frame. A hidden page paints nothing, so a timer stands in.
 * Returns a cancel.
 */
export function afterPaint(fn: () => void): () => void {
  let done = false;
  let raf: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (): void => {
    if (done) return;
    done = true;
    if (raf !== undefined) cancelAnimationFrame(raf);
    clearTimeout(timer);
    clearTimeout(fallback);
    fn();
  };
  const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  if (visible && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(() => (timer = setTimeout(run, 0)));
  else timer = setTimeout(run, 0);
  // rAF stalls in a background tab or an occluded window: never hold playback on it.
  const fallback = setTimeout(run, 100);
  return () => {
    done = true;
    if (raf !== undefined) cancelAnimationFrame(raf);
    clearTimeout(timer);
    clearTimeout(fallback);
  };
}

function whenIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') ric(fn, { timeout: 3000 });
  else setTimeout(fn, 300);
}

const OUTSIDE_PLAYERS: ReadonlySet<VideoPlayer> = new Set(['mpv', 'vlc', 'embedded-mpv']);

/**
 * Whether the saved players leave the built-in engines nothing to play (F1-5): desktop, live in
 * mpv or VLC, VOD and catch-up in those or embedded mpv. Live in embedded mpv still needs them,
 * because radio plays in the built-in `<audio>` unless the player is mpv or VLC
 * (`modeForSettings`). Read from the query cache (the shell loads settings at boot), not the
 * player store, which would pull its 72 kB into the entry chunk; settings not there yet warm as
 * before.
 */
function playersAllOutside(): boolean {
  if (!isDesktop) return false;
  const s = queryClient.getQueryData<Settings>(rpcKey('settings.get'));
  if (!s) return false;
  const live = s.livePlayer ?? s.player;
  return (live === 'mpv' || live === 'vlc') && OUTSIDE_PLAYERS.has(s.vodPlayer ?? s.player) && OUTSIDE_PLAYERS.has(s.catchupPlayer ?? s.player);
}

/**
 * Both engines, once the browser is idle. For pages that play streams (live TV, VOD, the
 * dashboard). Skipped when every saved player is mpv or VLC (about 890 kB fetched, compiled and
 * held for the session otherwise); a built-in play still gets its engine through
 * `preloadEngineFor` and `createEngine`, both left ungated.
 */
export function preloadEngines(): void {
  if (!enabled || idleQueued || (loaded.has('hls') && loaded.has('mpegts'))) return;
  idleQueued = true;
  whenIdle(() => {
    idleQueued = false;
    // Checked when the work would run: settings that land while the page waits for idle count.
    if (playersAllOutside()) return;
    load('hls');
    load('mpegts');
  });
}

const HLS_URL = /\.m3u8(?:$|[?#])|[?&]output=(?:m3u8|hls)\b/i;
const TS_URL = /\.ts(?:$|[?#])|[?&]output=(?:ts|mpegts)\b/i;

/**
 * The engine a play of `url` will need, right after the click's frame paints (the fetch then
 * overlaps the stream lookup). Without a telling URL (it is still being looked up, or it has no
 * extension) both: IPTV links rarely say up front which one they are.
 */
export function preloadEngineFor(url: string | undefined): void {
  if (!enabled) return;
  const hls = !url || HLS_URL.test(url) || !TS_URL.test(url);
  const ts = !url || TS_URL.test(url) || !HLS_URL.test(url);
  if ((!hls || loaded.has('hls')) && (!ts || loaded.has('mpegts'))) return;
  afterPaint(() => {
    if (hls) load('hls');
    if (ts) load('mpegts');
  });
}

/** Testing only: swap the loaders (and turn preloading on) or put the defaults back. */
export function __setEngineLoadersForTests(next: Record<'hls' | 'mpegts', Loader> | null): void {
  loaders = next ?? DEFAULT_LOADERS;
  enabled = next !== null;
  loaded.clear();
  idleQueued = false;
}
