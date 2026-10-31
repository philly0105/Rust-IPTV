/**
 * Artwork fetch gate (L3-live-1, L3-perf-desktop-3).
 *
 * Posters and logos load from the app's own image cache route: `/api/img` on the same origin
 * as `/api/rpc` in server mode; on desktop, the loopback proxy's image listener, a port that
 * carries nothing but artwork (RPCs go over Tauri IPC, streams to the proxy's other port).
 * A browser opens about six HTTP/1.1 connections per host and port, so a fast scroll through
 * artwork that is not cached yet queued 290-370 image requests ahead of the page RPCs: channel
 * pages that the server answered in 6-10 ms reached the page after 1-1.7 s, and the rows stayed
 * blank.
 *
 * The gate sets `src` on a cache-route <img> itself, and keeps at most {@link maxActive} such
 * fetches in flight: {@link MAX_ACTIVE} in server mode, so RPCs always find a free connection,
 * {@link DESKTOP_MAX_ACTIVE} on desktop, where no RPC needs that port, and
 * {@link MULTIPLEXED_MAX_ACTIVE} for a page served over HTTP/2 or HTTP/3, where one connection
 * carries every request:
 * - the newest pictures go first (what the user scrolled to), in DOM order within one commit;
 * - while anything on the page scrolls (the virtual lists and grids, a rail), nothing starts
 *   until the scrolling has stopped for {@link SETTLE_MS}, so cards flung past never ask (nor
 *   make the cache resize them); only a picture that has stayed in view {@link SCROLL_DWELL_MS}
 *   starts during a slow, continuous scroll, so reading down a grid still fills in;
 * - a picture out of view (IntersectionObserver, with a margin) waits, and gives its slot back
 *   if it turns out to be out of view after it started (a lazy <img> the browser parks);
 * - a picture that already loaded in this session, and any URL that is not a cache-route URL
 *   (an original provider URL, data:, blob:), starts at once without a slot;
 * - a slot is freed on load, error, unmount, or after {@link SLOT_TIMEOUT_MS};
 * - on unmount a picture still loading loses its `src`, also one that gave its slot back, so a
 *   row that scrolled away or a page that closed does not keep holding a connection;
 * - when every slot is taken by a picture the cache is still fetching upstream (one has been
 *   loading {@link WARM_AFTER_MS}) and the page is still, the pictures waiting in view are named
 *   to the core once each (`images.warm`), which fetches them in parallel; their own requests
 *   then join those fetches or find the files. A cold wall otherwise came in a few pictures at a
 *   time, each holding a connection for a whole upstream round trip.
 *
 * Without IntersectionObserver (jsdom, very old engines) every picture starts at once, as it
 * did before the gate.
 */

import { imageCacheRequest, type ImageWarmItem, isImageCacheUrl } from '@/api/images';
import { rpc } from '@/api/transport';

/** Server mode: cache-route fetches in flight at once; the rest of the browser's six connections stay free for RPCs. */
export const MAX_ACTIVE = 4;
/** Desktop: the image listener serves artwork only, so the gate may use all six of the webview's connections to it. */
export const DESKTOP_MAX_ACTIVE = 6;
/** Server mode over HTTP/2 or HTTP/3 (behind a TLS reverse proxy): requests share one connection, so none waits for a free one. */
export const MULTIPLEXED_MAX_ACTIVE = 12;

/** Whether the page came over HTTP/2 or HTTP/3, read once (undefined until then). */
let multiplexed: boolean | undefined;

/**
 * True when the page itself came over HTTP/2 or HTTP/3: the image route is on its origin, so it
 * shares that connection. An unknown protocol (no navigation timing, a page from a cache) counts
 * as HTTP/1.1.
 */
function pageIsMultiplexed(): boolean {
  if (multiplexed === undefined) {
    let protocol = '';
    try {
      const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
      protocol = nav?.nextHopProtocol ?? '';
    } catch {
      // No timing API: HTTP/1.1.
    }
    multiplexed = protocol === 'h2' || protocol.startsWith('h3');
  }
  return multiplexed;
}

/**
 * The cap for this window. It checks the Tauri global, as `isDesktop` in transport.ts does, but
 * when the gate pumps rather than at import, so a test can stand in for the desktop.
 */
export function maxActive(): number {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) return DESKTOP_MAX_ACTIVE;
  return pageIsMultiplexed() ? MULTIPLEXED_MAX_ACTIVE : MAX_ACTIVE;
}

/** How long the page must stay still after a scroll before waiting pictures start. */
export const SETTLE_MS = 120;
/** During a continuous scroll, a picture that has been in view this long starts anyway. */
export const SCROLL_DWELL_MS = 400;
/** A started picture gives its slot back after this long even when it never reports. */
export const SLOT_TIMEOUT_MS = 3000;
/**
 * A running picture still loading after this long is being fetched upstream by the cache; one read
 * from its disk takes a few ms. Only then are waiting pictures warmed, so a wall already on disk
 * costs the core no second lookup per picture.
 */
export const WARM_AFTER_MS = 150;
/** Pictures named in one `images.warm` at most (the core takes no more). */
export const WARM_MAX = 48;

interface Ticket {
  el: HTMLImageElement;
  url: string;
  /** Requests made in one commit share a batch; newer batches go first. */
  batch: number;
  seq: number;
  /** From the observer: undefined until it first reports (counted as in view while the page is still). */
  visible: boolean | undefined;
  /** performance.now() when it last came into view. */
  visibleAt: number;
  state: 'pending' | 'active' | 'parked' | 'done';
  timer: ReturnType<typeof setTimeout> | null;
  /** performance.now() when it started. */
  startedAt: number;
  /** Named to the core in an `images.warm` already. */
  warmed: boolean;
}

const pending: Ticket[] = [];
const tickets = new WeakMap<Element, Ticket>();
/** Pictures holding a slot. */
const running = new Set<Ticket>();
let seq = 0;
let batch = 0;
let batchOpen = false;
let lastScrollAt = Number.NEGATIVE_INFINITY;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;
/** performance.now() when {@link pumpTimer} fires. */
let pumpAt = 0;
let observer: IntersectionObserver | null | undefined;

/** Cache URLs that loaded in this session: the browser has them, so they skip the gate. */
const loaded = new Set<string>();
const LOADED_MAX = 4000;

/** True when `url` loaded before in this session (it shows from the browser's cache). */
export function imageLoadedBefore(url: string): boolean {
  return loaded.has(url);
}

/** Notes that `url` loaded, so a remount shows it at once. */
export function noteImageLoaded(url: string): void {
  if (loaded.size >= LOADED_MAX) loaded.clear();
  loaded.add(url);
}

/** Test hook: forget loaded pictures, every queued or running ticket and the page's protocol. */
export function resetImageGate(): void {
  loaded.clear();
  pending.length = 0;
  running.clear();
  lastScrollAt = Number.NEGATIVE_INFINITY;
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpTimer = null;
  observer?.disconnect();
  observer = undefined;
  multiplexed = undefined;
}

/** For tests and diagnostics: fetches in flight and pictures waiting. */
export function imageGateStats(): { active: number; pending: number } {
  return { active: running.size, pending: pending.length };
}

function now(): number {
  return performance.now();
}

function visibilityObserver(): IntersectionObserver | null {
  if (observer === undefined) {
    observer =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(
            (entries) => {
              let changed = false;
              for (const e of entries) {
                const t = tickets.get(e.target);
                if (!t) continue;
                if (e.isIntersecting && t.visible !== true) t.visibleAt = now();
                t.visible = e.isIntersecting;
                // Started but out of view: a lazy <img> the browser will not fetch yet. Its slot goes
                // to a picture on screen; the browser loads this one when it scrolls into view.
                if (t.state === 'active' && !t.visible && !t.el.complete) {
                  free(t, 'parked');
                }
                changed = true;
              }
              if (changed) pump();
            },
            // Rows just past the edge start before they show.
            { rootMargin: '200px' },
          )
        : null;
    if (observer) listenForScroll();
  }
  return observer;
}

let listening = false;

/**
 * Every scroll on the page (capture: element scrollers too) marks the time, like a virtualizer's
 * isScrolling. Installed on first use, not at import: a module with a top-level side effect would
 * be kept in the entry chunk through the `@/ui` barrel.
 */
function listenForScroll(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener(
    'scroll',
    () => {
      lastScrollAt = now();
    },
    { capture: true, passive: true },
  );
}

/**
 * True while anything on the page scrolled within the last {@link SETTLE_MS}: the same signal as
 * a virtualizer's isScrolling, for every scroller at once. For artwork that does not go through
 * {@link gateImage} and wants to hold its request during a fling.
 */
export function pageIsScrolling(): boolean {
  listenForScroll();
  return now() - lastScrollAt < SETTLE_MS;
}

function free(t: Ticket, next: Ticket['state']): void {
  if (t.state === 'active') running.delete(t);
  if (t.timer) clearTimeout(t.timer);
  t.timer = null;
  t.state = next;
}

function finish(t: Ticket, ok: boolean): void {
  if (ok) noteImageLoaded(t.url);
  free(t, 'done');
  observer?.unobserve(t.el);
  tickets.delete(t.el);
  pump();
}

function start(t: Ticket): void {
  t.state = 'active';
  t.startedAt = now();
  running.add(t);
  const el = t.el;
  el.addEventListener('load', () => finish(t, true), { once: true });
  el.addEventListener('error', () => finish(t, false), { once: true });
  t.timer = setTimeout(() => {
    if (t.state !== 'active') return;
    free(t, 'parked');
    pump();
  }, SLOT_TIMEOUT_MS);
  el.src = t.url;
}

function wakePump(): void {
  pumpTimer = null;
  pump();
}

/** True when `a` starts before `b`: a newer batch first, DOM order within one. */
function before(a: Ticket, b: Ticket): boolean {
  return a.batch > b.batch || (a.batch === b.batch && a.seq < b.seq);
}

function warmable(t: Ticket): boolean {
  return t.visible === true && !t.warmed;
}

/**
 * Every slot is taken: once the page is still and a running picture has loaded for
 * {@link WARM_AFTER_MS}, names the pictures waiting in view to the core in one `images.warm`, best
 * first, each once. Returns when to look again (Infinity: no need).
 */
function warmWaiting(t0: number, scrolling: boolean): number {
  if (!pending.some(warmable)) return Number.POSITIVE_INFINITY;
  // Pictures flung past are never warmed: look again once the page is still.
  if (scrolling) return lastScrollAt + SETTLE_MS;
  let oldest = Number.POSITIVE_INFINITY;
  for (const t of running) oldest = Math.min(oldest, t.startedAt);
  if (t0 - oldest < WARM_AFTER_MS) return oldest + WARM_AFTER_MS;
  const waiting = pending.filter(warmable).sort((a, b) => b.batch - a.batch || a.seq - b.seq);
  const items: ImageWarmItem[] = [];
  for (const t of waiting.slice(0, WARM_MAX)) {
    t.warmed = true;
    const item = imageCacheRequest(t.url);
    if (item) items.push(item);
  }
  if (items.length > 0) sendWarm(items);
  return Number.POSITIVE_INFINITY;
}

function sendWarm(items: ImageWarmItem[]): void {
  try {
    // Only a head start: each picture's own request still loads it and reports any failure.
    void rpc('images.warm', { items }).catch(() => undefined);
  } catch {
    // A transport that cannot send right now changes nothing for the pictures.
  }
}

/** Starts waiting pictures while slots are free, best first; re-arms itself for pictures held by a scroll. */
function pump(): void {
  const t0 = now();
  const scrolling = t0 - lastScrollAt < SETTLE_MS;
  let wake = Number.POSITIVE_INFINITY;
  const cap = maxActive();
  while (running.size < cap) {
    let best = -1;
    for (let i = 0; i < pending.length; i++) {
      const t = pending[i]!;
      if (t.visible === false) continue;
      if (scrolling && !(t.visible === true && t0 - t.visibleAt >= SCROLL_DWELL_MS)) {
        wake = Math.min(wake, lastScrollAt + SETTLE_MS, t.visible === true ? t.visibleAt + SCROLL_DWELL_MS : wake);
        continue;
      }
      const b = best < 0 ? null : pending[best]!;
      if (!b || before(t, b)) best = i;
    }
    if (best < 0) break;
    const [t] = pending.splice(best, 1);
    start(t!);
  }
  if (running.size >= cap) wake = Math.min(wake, warmWaiting(t0, scrolling));
  if (pending.length === 0 || !Number.isFinite(wake)) return;
  // One timer: an armed one that fires no later is kept, and its pump re-arms (one with nothing to
  // start is harmless). Every poster a fling mounts or unmounts pumps, and clearing and setting
  // the timer each time cost more than the pump itself (P2-GRID-3).
  const at = Math.max(t0 + 16, wake);
  if (pumpTimer && pumpAt <= at) return;
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpAt = at;
  pumpTimer = setTimeout(wakePump, at - t0);
}

/**
 * Loads `url` into `el` through the gate. Returns the cancel function to call when the element
 * goes (a React ref cleanup): a waiting picture leaves the queue, a running one frees its slot,
 * and one still loading drops its request, parked or not. `immediate` (a priority or eager
 * picture) sets `src` at once.
 */
export function gateImage(el: HTMLImageElement, url: string, immediate = false): () => void {
  const io = immediate ? null : visibilityObserver();
  if (!io || loaded.has(url) || !isImageCacheUrl(url)) {
    el.src = url;
    return () => undefined;
  }
  if (!batchOpen) {
    batch++;
    batchOpen = true;
    queueMicrotask(() => {
      batchOpen = false;
    });
  }
  const t: Ticket = {
    el,
    url,
    batch,
    seq: seq++,
    visible: undefined,
    visibleAt: 0,
    state: 'pending',
    timer: null,
    startedAt: 0,
    warmed: false,
  };
  tickets.set(el, t);
  io.observe(el);
  pending.push(t);
  pump();
  return () => {
    if (t.state === 'pending') {
      const i = pending.indexOf(t);
      if (i >= 0) pending.splice(i, 1);
    }
    // A parked picture (slot timed out, or out of view) still has its request open.
    const loading = (t.state === 'active' || t.state === 'parked') && !el.complete;
    free(t, 'done');
    io.unobserve(el);
    tickets.delete(el);
    // A request for a row that scrolled away is dropped, so it does not hold a connection.
    if (loading) el.removeAttribute('src');
    pump();
  };
}
