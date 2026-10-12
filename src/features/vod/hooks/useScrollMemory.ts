import { useEffect, useLayoutEffect, useRef } from 'react';

/** Where a scroller was left: its offset and the item last opened from it. */
export interface ScrollSpot {
  scrollTop: number;
  /** Grid index (or category index) of the item the user opened. */
  index?: number;
}

const MAX_SPOTS = 64;
/** Per-URL scroll memory for this app session (a route remount reads it back). */
const spots = new Map<string, ScrollSpot>();

export function recallSpot(key: string): ScrollSpot | undefined {
  return spots.get(key);
}

export function rememberSpot(key: string, patch: Partial<ScrollSpot>): void {
  const prev = spots.get(key);
  const next: ScrollSpot = { scrollTop: patch.scrollTop ?? prev?.scrollTop ?? 0 };
  const index = 'index' in patch ? patch.index : prev?.index;
  if (index !== undefined) next.index = index;
  spots.delete(key);
  spots.set(key, next);
  // Oldest first in insertion order: trim from the front.
  while (spots.size > MAX_SPOTS) spots.delete(spots.keys().next().value!);
}

/** Season tab picked per series (`sourceId|itemId`), for this app session. */
const seasons = new Map<string, number>();

export function recallSeason(key: string): number | undefined {
  return seasons.get(key);
}

export function rememberSeason(key: string, season: number): void {
  seasons.delete(key);
  seasons.set(key, season);
  while (seasons.size > MAX_SPOTS) seasons.delete(seasons.keys().next().value!);
}

/** Test helper: clears scroll spots and season picks. */
export function forgetSpots(): void {
  spots.clear();
  seasons.clear();
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
}

/**
 * Keeps a scroller's position across a route round trip: records the offset
 * while you scroll, and puts it back the first time the content is ready
 * after the page mounts again (back from a detail view).
 */
export function useScrollMemory({ key, getScroller, ready, onRestored }: ScrollMemoryOptions): void {
  const restoredFor = useRef<string | null>(null);
  const getRef = useRef(getScroller);
  getRef.current = getScroller;
  const onRestoredRef = useRef(onRestored);
  onRestoredRef.current = onRestored;

  useLayoutEffect(() => {
    if (!ready || restoredFor.current === key) return;
    const el = getRef.current();
    if (!el) return;
    restoredFor.current = key;
    const spot = spots.get(key);
    if (!spot) return;
    el.scrollTop = spot.scrollTop;
    // Virtualizers render the rows for the new offset on the next frame. A grid
    // that measured its real width meanwhile may have clamped the offset, so
    // apply it once more before handing over.
    const raf = requestAnimationFrame(() => {
      if (el.scrollTop !== spot.scrollTop) el.scrollTop = spot.scrollTop;
      onRestoredRef.current?.(spot, el);
    });
    return () => cancelAnimationFrame(raf);
  }, [key, ready]);

  useEffect(() => {
    if (!ready) return;
    const el = getRef.current();
    if (!el) return;
    const onScroll = () => rememberSpot(key, { scrollTop: el.scrollTop });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [key, ready]);
}
