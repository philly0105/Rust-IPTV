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
 * and {@link DESKTOP_MAX_ACTIVE} on desktop, where no RPC needs that port:
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
 *   row that scrolled away or a page that closed does not keep holding a connection.
 *
 * Without IntersectionObserver (jsdom, very old engines) every picture starts at once, as it
 * did before the gate.
 */

import { isImageCacheUrl } from '@/api/images';

/** Server mode: cache-route fetches in flight at once; the rest of the browser's six connections stay free for RPCs. */
export const MAX_ACTIVE = 4;
/** Desktop: the image listener serves artwork only, so the gate may use all six of the webview's connections to it. */
export const DESKTOP_MAX_ACTIVE = 6;

/**
 * The cap for this window. It checks the Tauri global, as `isDesktop` in transport.ts does, but
 * when the gate pumps rather than at import, so a test can stand in for the desktop.
 */
export function maxActive(): number {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? DESKTOP_MAX_ACTIVE : MAX_ACTIVE;
}

/** How long the page must stay still after a scroll before waiting pictures start. */
export const SETTLE_MS = 120;
/** During a continuous scroll, a picture that has been in view this long starts anyway. */
export const SCROLL_DWELL_MS = 400;
/** A started picture gives its slot back after this long even when it never reports. */
export const SLOT_TIMEOUT_MS = 3000;

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
}

const pending: Ticket[] = [];
const tickets = new WeakMap<Element, Ticket>();
let active = 0;
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

/** Test hook: forget loaded pictures and every queued or running ticket. */
export function resetImageGate(): void {
  loaded.clear();
  pending.length = 0;
  active = 0;
  lastScrollAt = Number.NEGATIVE_INFINITY;
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpTimer = null;
  observer?.disconnect();
  observer = undefined;
}

/** For tests and diagnostics: fetches in flight and pictures waiting. */
export function imageGateStats(): { active: number; pending: number } {
  return { active, pending: pending.length };
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
  if (t.state === 'active') active = Math.max(0, active - 1);
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
  active++;
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

/** Starts waiting pictures while slots are free, best first; re-arms itself for pictures held by a scroll. */
function pump(): void {
  const t0 = now();
  const scrolling = t0 - lastScrollAt < SETTLE_MS;
  let wake = Number.POSITIVE_INFINITY;
  const cap = maxActive();
  while (active < cap) {
    let best = -1;
    for (let i = 0; i < pending.length; i++) {
      const t = pending[i]!;
      if (t.visible === false) continue;
      if (scrolling && !(t.visible === true && t0 - t.visibleAt >= SCROLL_DWELL_MS)) {
        wake = Math.min(wake, lastScrollAt + SETTLE_MS, t.visible === true ? t.visibleAt + SCROLL_DWELL_MS : wake);
        continue;
      }
      const b = best < 0 ? null : pending[best]!;
      if (!b || t.batch > b.batch || (t.batch === b.batch && t.seq < b.seq)) best = i;
    }
    if (best < 0) break;
    const [t] = pending.splice(best, 1);
    start(t!);
  }
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
  const t: Ticket = { el, url, batch, seq: seq++, visible: undefined, visibleAt: 0, state: 'pending', timer: null };
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
