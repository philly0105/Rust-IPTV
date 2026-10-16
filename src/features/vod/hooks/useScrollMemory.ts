import { useLayoutEffect, useRef } from 'react';

/** Where a scroller was left: its offset and the item last opened from it. */
export interface ScrollSpot {
  scrollTop: number;
  /** Grid index (or category index) of the item the user opened. */
  index?: number;
}

const MAX_SPOTS = 64;
/** localStorage key: the memory survives a restart (the shell reopens the last route). */
export const SCROLL_STORAGE_KEY = 'vod.scrollMemory';
const PERSIST_DELAY_MS = 400;
/** Per-URL scroll memory (a route remount reads it back). */
const spots = new Map<string, ScrollSpot>();
/** Season tab picked per series (`sourceId|itemId`). */
const seasons = new Map<string, number>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function isSpot(v: unknown): v is ScrollSpot {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['scrollTop'] === 'number' && Number.isFinite(o['scrollTop']) && (o['index'] === undefined || (typeof o['index'] === 'number' && Number.isInteger(o['index'])));
}

/** Reads the stored memory once; anything malformed is ignored. */
function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SCROLL_STORAGE_KEY) : null;
    if (!raw) return;
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return;
    const { spots: s, seasons: z } = data as { spots?: unknown; seasons?: unknown };
    if (Array.isArray(s)) {
      for (const e of s.slice(-MAX_SPOTS)) if (Array.isArray(e) && typeof e[0] === 'string' && isSpot(e[1])) spots.set(e[0], e[1]);
    }
    if (Array.isArray(z)) {
      for (const e of z.slice(-MAX_SPOTS)) if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number' && Number.isInteger(e[1])) seasons.set(e[0], e[1]);
    }
  } catch {
    // corrupt or unavailable storage: start empty
  }
}

function persistNow(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  try {
    localStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify({ spots: [...spots], seasons: [...seasons] }));
  } catch {
    // storage full or unavailable: memory still works for this session
  }
}

/** Scroll events are frequent: write at most every few hundred ms, and on page hide. */
function persistSoon(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(persistNow, PERSIST_DELAY_MS);
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', () => persistTimer && persistNow());

export function recallSpot(key: string): ScrollSpot | undefined {
  load();
  return spots.get(key);
}

export function rememberSpot(key: string, patch: Partial<ScrollSpot>): void {
  load();
  const prev = spots.get(key);
  const next: ScrollSpot = { scrollTop: patch.scrollTop ?? prev?.scrollTop ?? 0 };
  const index = 'index' in patch ? patch.index : prev?.index;
  if (index !== undefined) next.index = index;
  spots.delete(key);
  spots.set(key, next);
  // Oldest first in insertion order: trim from the front.
  while (spots.size > MAX_SPOTS) spots.delete(spots.keys().next().value!);
  persistSoon();
}

export function recallSeason(key: string): number | undefined {
  load();
  return seasons.get(key);
}

export function rememberSeason(key: string, season: number): void {
  load();
  seasons.delete(key);
  seasons.set(key, season);
  while (seasons.size > MAX_SPOTS) seasons.delete(seasons.keys().next().value!);
  persistSoon();
}

/** Test helper: clears scroll spots and season picks (memory and storage). */
export function forgetSpots(): void {
  spots.clear();
  seasons.clear();
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  loaded = true;
  try {
    localStorage.removeItem(SCROLL_STORAGE_KEY);
  } catch {
    // unavailable
  }
}

/** Test helper: drop the in-memory copy so the next read loads from storage (a restart). */
export function reloadSpotsForTests(persist = true): void {
  if (persist) persistNow();
  else if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  spots.clear();
  seasons.clear();
  loaded = false;
}

export interface ScrollMemoryOptions {
  /** Memory key, normally pathname + search. */
  key: string;
  /** The scrolling element (looked up lazily: virtual grids mount it late). */
  getScroller: () => HTMLElement | null;
  /** True once the content is rendered at full height, so the offset can be applied. */
  ready: boolean;
  /** Runs once after the offset is restored (focus the last item, mark it). */
  onRestored?: (spot: ScrollSpot, scroller: HTMLElement) => void;
  /**
   * False makes this visit start at the top (a PUSH: a link or a new sort is a fresh visit).
   * Read when the key first becomes ready; the offset is recorded either way. Defaults to true.
   */
  restore?: boolean;
}

/**
 * Keeps a scroller's position across a route round trip: records the offset
 * while you scroll, and puts it back the first time the content is ready
 * after the page mounts again (back from a detail view).
 */
export function useScrollMemory({ key, getScroller, ready, onRestored, restore = true }: ScrollMemoryOptions): void {
  const restoredFor = useRef<string | null>(null);
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const getRef = useRef(getScroller);
  getRef.current = getScroller;
  const onRestoredRef = useRef(onRestored);
  onRestoredRef.current = onRestored;

  useLayoutEffect(() => {
    if (!ready || restoredFor.current === key) return;
    const el = getRef.current();
    if (!el) return;
    restoredFor.current = key;
    if (!restoreRef.current) return;
    const spot = recallSpot(key);
    if (!spot) return;
    el.scrollTop = spot.scrollTop;
    // Virtualizers render the rows for the new offset on the next frame. A grid
    // that measured its real width meanwhile may have clamped the offset, so
    // apply it once more before handing over.
    let done = false;
    const raf = requestAnimationFrame(() => {
      done = true;
      if (el.scrollTop !== spot.scrollTop) el.scrollTop = spot.scrollTop;
      onRestoredRef.current?.(spot, el);
    });
    return () => {
      cancelAnimationFrame(raf);
      // Cancelled before it ran (StrictMode's mount/unmount/mount, or a quick re-render): restore again next run.
      if (!done) restoredFor.current = null;
    };
  }, [key, ready]);

  // A layout effect, so its cleanup runs while the scroller is still in the page (React detaches
  // the DOM after the layout cleanups of a removed tree) and can still read the last offset.
  useLayoutEffect(() => {
    if (!ready) return;
    const el = getRef.current();
    if (!el) return;
    // One read per frame, at its start (L2-perf-ui-9): reading scrollTop inside every scroll
    // event, right after a virtualizer changed the DOM, forced a layout per event.
    let frame = 0;
    const record = () => {
      frame = 0;
      rememberSpot(key, { scrollTop: el.scrollTop });
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(record);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      // Leaving within the frame of the last scroll: keep that offset.
      if (frame) {
        cancelAnimationFrame(frame);
        if (el.isConnected) record();
      }
    };
  }, [key, ready]);
}
