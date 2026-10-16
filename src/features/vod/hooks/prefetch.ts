/**
 * Hover and focus prefetch of VOD detail pages (Run 3 contract C4).
 *
 * When the pointer rests on a poster for 120 ms, or the poster keeps focus
 * for 120 ms, the detail page's data, its route chunk and its artwork start
 * loading, so the click lands on a page that is already filled in. Each title
 * is prefetched at most once per session; Data Saver and touch screens skip
 * it. Posters that scroll under a still pointer are not intent: a scroll or
 * wheel cancels pending pointer rests, and only real pointer movement starts
 * new ones. See docs/architecture/performance.md.
 */

import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useRef } from 'react';

import { preloadImage } from '@/api/images';
import { queryClient as appQueryClient, rpcKey } from '@/api/query';
import type { CatalogSearchResult } from '@/api/rpc';
import { rpcRaw } from '@/api/transport';
import type { ItemRef, SourceKind } from '@/api/types';

import { normalizeQuery, SEARCH_LIMIT, searchRequestLimit } from '../lib/search';
import { loadMovieDetailPage, loadSearchPage, loadSeriesDetailPage } from '../routes';
import { movieDetailQuery, seriesDetailQuery } from './queries';

export interface PrefetchTarget {
  ref: ItemRef;
  sourceKind: SourceKind;
  posterUrl?: string;
  backdropUrl?: string;
}

/** What `onPointerEnter` reads from React's pointer event. */
export interface PointerLike {
  pointerType?: string;
}

/** What `onFocus` reads from React's focus event: the element that took focus. */
export interface FocusLike {
  currentTarget?: EventTarget | null;
}

/** Pointer and focus handlers returned by `usePrefetchIntent`. Spread them onto the card's link. */
export interface PrefetchIntent {
  onPointerEnter(e?: PointerLike): void;
  onPointerLeave(): void;
  onFocus(e?: FocusLike): void;
  onBlur(): void;
}

/** How long the pointer (or focus, or the grid's keyboard cursor) has to rest on a card before it counts as intent. */
export const PREFETCH_REST_MS = 120;

/** Keys already prefetched this session (see `targetKey`). */
const prefetched = new Set<string>();

/** What started a pending rest. Each is cancelled by its own events. */
type RestKind = 'pointer' | 'focus' | 'cursor';

interface IntentState {
  key: string | null;
  fire: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  kind: RestKind | undefined;
  /** For a focus rest: the element that took focus, which must still hold it when the rest ends. */
  focused: Element | null;
}

/** Pointer rests that are counting down. A scroll or wheel cancels them (the card moved, not the pointer). */
const pointerRests = new Set<IntentState>();
/**
 * Cards under a pointer that has not moved since the content last scrolled. Chromium sends
 * pointerenter to each card that scrolls under a still pointer; those wait here, and only
 * real pointer movement starts their rest. Leaving the card drops it.
 */
const parked = new Set<IntentState>();
/** The pending focus rest. Only one element has focus, so a new one replaces it (Tab or arrows through a rail). */
let focusRest: IntentState | null = null;
/** From a scroll or wheel until the pointer really moves. */
let pointerStill = false;
/** The pointer's last viewport position, to tell real movement from a move synthesised after a scroll. */
let lastPointer: { x: number; y: number } | null = null;
let listening = false;

/** Forgets every prefetch and pending rest, so the next intent fires again. For tests. */
export function resetPrefetchMemory(): void {
  prefetched.clear();
  detailChunks.clear();
  for (const s of [...pointerRests]) cancel(s);
  if (focusRest) cancel(focusRest);
  parked.clear();
  pointerStill = false;
  lastPointer = null;
}

/** False when the user asked to save data, or when the primary pointer is touch (hover means nothing there). */
export function prefetchAllowed(): boolean {
  if (typeof navigator !== 'undefined') {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) return false;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return false;
  return true;
}

/** Loads a route chunk; a failure only means the route loads it again on click. */
function warmChunk(load: () => Promise<unknown>): void {
  load().catch(() => undefined);
}

/** Detail chunk loads started this session, so hover, focus and the grids' idle warm-up share one. */
const detailChunks = new Map<'movie' | 'series', Promise<unknown>>();

/**
 * Downloads and evaluates the movie or series detail page chunk (the same
 * `import()` the route opens, so Vite shares one chunk), at most once per
 * session. A failure is swallowed and forgotten, so a later call tries again
 * (the route loads it on click anyway). The grids call it at idle on mount
 * (L2-vod-10); a hover or focus prefetch calls it with the data.
 */
export function preloadDetailChunk(kind: 'movie' | 'series'): void {
  if (detailChunks.has(kind)) return;
  const load = kind === 'movie' ? loadMovieDetailPage : loadSeriesDetailPage;
  detailChunks.set(
    kind,
    load().catch(() => {
      detailChunks.delete(kind);
    }),
  );
}

/**
 * Detail query with the same key and fn as useMovieDetail/useSeriesDetail
 * (staleTime 5 min), the detail route chunk, and the poster/backdrop through
 * the image cache (`preloadImage`, the same URL the page's <img> asks for,
 * at most once per session). When the target has no backdrop, the one the detail page shows
 * first (the item's, then the provider's first) is preloaded once the data
 * arrives. Live and other non-VOD refs are ignored.
 */
export function prefetchVodDetail(qc: QueryClient, t: PrefetchTarget): void {
  const { ref } = t;
  if (ref.contentType !== 'movie' && ref.contentType !== 'series') return;
  preloadImage(t.posterUrl, ref.sourceId);
  preloadImage(t.backdropUrl, ref.sourceId);
  // A provider detail, or for m3u the bare catalog row the detail query caches (queries.ts).
  const afterData = (data: { item?: { backdropUrl?: string }; backdrops?: string[]; backdropUrl?: string } | undefined) => {
    if (t.backdropUrl || !data) return;
    preloadImage(data.item ? (data.item.backdropUrl ?? data.backdrops?.[0]) : data.backdropUrl, ref.sourceId);
  };
  preloadDetailChunk(ref.contentType);
  // retry: false: a failed prefetch costs nothing; the page asks again (with retries) on open.
  if (ref.contentType === 'movie') {
    const q = movieDetailQuery(t.sourceKind, ref);
    void qc.prefetchQuery({ ...q, retry: false }).then(() => afterData(qc.getQueryData(q.queryKey)));
  } else {
    const q = seriesDetailQuery(t.sourceKind, ref);
    void qc.prefetchQuery({ ...q, retry: false }).then(() => afterData(qc.getQueryData(q.queryKey)));
  }
}

/** A title search to warm (TMDB rails link into search, not to a catalog item). */
export interface SearchPrefetchTarget {
  title: string;
  /** The source the search page is scoped to, as in `searchHref`. */
  sourceId?: string;
}

/**
 * Warms the search page for `searchHref(title, sourceId)`: its route chunk and
 * the first `catalog.search` page with exactly the args SearchPage sends, so
 * the results are on screen when the page opens.
 */
export function prefetchTitleSearch(qc: QueryClient, t: SearchPrefetchTarget): void {
  const query = normalizeQuery(t.title);
  if (!query) return;
  warmChunk(loadSearchPage);
  const limit = searchRequestLimit(SEARCH_LIMIT);
  const args = t.sourceId ? { query, sourceId: t.sourceId, limit } : { query, limit };
  void qc.prefetchQuery({
    queryKey: rpcKey('catalog.search', args),
    queryFn: async ({ signal }) => (await rpcRaw('catalog.search', args, { signal })) as CatalogSearchResult,
    // SearchPage asks for 30 s; matching it means a click soon after the hover reads the cache.
    staleTime: 30_000,
    retry: false,
  });
}

function targetKey(t: PrefetchTarget): string {
  return `${t.sourceKind}|${t.ref.sourceId}|${t.ref.contentType}|${t.ref.itemId}`;
}

function searchKey(t: SearchPrefetchTarget): string | null {
  const q = normalizeQuery(t.title);
  return q ? `search|${t.sourceId ?? ''}|${q.toLowerCase()}` : null;
}

/** The provider's client, or the app's when a card renders outside one (isolated component tests). */
function useClient(): QueryClient {
  return useContext(QueryClientContext) ?? appQueryClient;
}

function cancel(s: IntentState): void {
  if (s.timer !== undefined) clearTimeout(s.timer);
  s.timer = undefined;
  s.kind = undefined;
  s.focused = null;
  pointerRests.delete(s);
  if (focusRest === s) focusRest = null;
}

/** Cancels the pending rest only when `kind` started it (leaving a card does not cancel its focus rest). */
function cancelKind(s: IntentState, kind: RestKind): void {
  if (s.kind === kind) cancel(s);
}

/** Runs `s.fire` once per key per session, unless prefetching is off right now. */
function fireOnce(s: IntentState): void {
  cancel(s);
  const key = s.key;
  if (key === null || prefetched.has(key) || !prefetchAllowed()) return;
  prefetched.add(key);
  s.fire();
}

/** Starts (or restarts) the 120 ms rest of `s`. */
function startRest(s: IntentState, kind: RestKind, focused: Element | null = null): void {
  if (s.key === null || prefetched.has(s.key)) return;
  cancel(s);
  if (kind === 'pointer') pointerRests.add(s);
  if (kind === 'focus') {
    if (focusRest) cancel(focusRest);
    focusRest = s;
    s.focused = focused;
  }
  s.kind = kind;
  s.timer = setTimeout(() => {
    // A caller that does not pass onBlur still loses the rest once focus has moved on.
    const el = s.kind === 'focus' ? s.focused : null;
    if (el && typeof document !== 'undefined' && !el.contains(document.activeElement)) cancel(s);
    else fireOnce(s);
  }, PREFETCH_REST_MS);
}

function onPointerMove(e: PointerEvent): void {
  const { clientX: x, clientY: y } = e;
  if (typeof x === 'number' && typeof y === 'number') {
    // The same spot again: a move synthesised after the content scrolled, not the user's hand.
    if (lastPointer && lastPointer.x === x && lastPointer.y === y) return;
    lastPointer = { x, y };
  }
  pointerStill = false;
  if (parked.size === 0) return;
  const waiting = [...parked];
  parked.clear();
  for (const s of waiting) startRest(s, 'pointer');
}

/** Content moved under the pointer: pending pointer rests stop, and their cards wait for real movement. */
function onContentScroll(): void {
  pointerStill = true;
  for (const s of [...pointerRests]) {
    cancel(s);
    parked.add(s);
  }
}

/** One set of window listeners for every card: pointer movement, wheel, and scrolls of any container (captured). */
function listenForScroll(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  window.addEventListener('pointermove', onPointerMove, opts);
  window.addEventListener('wheel', onContentScroll, opts);
  window.addEventListener('scroll', onContentScroll, opts);
}

/** The rest state of one card. A new key, or unmounting, cancels a pending rest. */
function useIntentState(key: string | null, fire: () => void): IntentState {
  const ref = useRef<IntentState>({ key, fire, timer: undefined, kind: undefined, focused: null });
  ref.current.key = key;
  ref.current.fire = fire;
  useEffect(() => listenForScroll(), []);
  useEffect(() => {
    const s = ref.current;
    return () => {
      cancel(s);
      parked.delete(s);
    };
  }, [key]);
  return ref.current;
}

/** Stable handlers for one card. */
function useIntent(key: string | null, fire: () => void): PrefetchIntent {
  const s = useIntentState(key, fire);
  return useMemo(
    () => ({
      onPointerEnter(e?: PointerLike) {
        if (e?.pointerType === 'touch' || s.key === null || prefetched.has(s.key)) return;
        if (pointerStill) {
          // The card scrolled under a pointer that has not moved: not intent until the pointer moves.
          parked.add(s);
          return;
        }
        startRest(s, 'pointer');
      },
      onPointerLeave() {
        parked.delete(s);
        cancelKind(s, 'pointer');
      },
      onFocus(e?: FocusLike) {
        // Debounced like the pointer: Tab or a held arrow key passing through a rail warms only where it stops.
        const el = e?.currentTarget;
        startRest(s, 'focus', typeof Element !== 'undefined' && el instanceof Element ? el : null);
      },
      onBlur() {
        cancelKind(s, 'focus');
      },
    }),
    [s],
  );
}

/**
 * Fires after the pointer rests 120 ms (or on focus, after the same rest); once per ref per session; skipped when
 * navigator.connection?.saveData or the pointer is coarse. A card that scrolls under a still pointer waits for the
 * pointer to move.
 */
export function usePrefetchIntent(t: PrefetchTarget | null): PrefetchIntent {
  const qc = useClient();
  const latest = useRef(t);
  latest.current = t;
  return useIntent(t ? targetKey(t) : null, () => {
    if (latest.current) prefetchVodDetail(qc, latest.current);
  });
}

/** `usePrefetchIntent` for a link into title search (TMDB rails). */
export function useSearchPrefetchIntent(t: SearchPrefetchTarget | null): PrefetchIntent {
  const qc = useClient();
  const latest = useRef(t);
  latest.current = t;
  return useIntent(t ? searchKey(t) : null, () => {
    if (latest.current) prefetchTitleSearch(qc, latest.current);
  });
}

/**
 * Prefetches `t` once it has stayed the same for 120 ms: the keyboard cursor
 * of a virtual grid, which moves `aria-activedescendant` rather than focus.
 * Its rest is not a pointer rest, so the grid scrolling the cursor into view
 * does not cancel it.
 */
export function usePrefetchOnRest(t: PrefetchTarget | null): void {
  const qc = useClient();
  const latest = useRef(t);
  latest.current = t;
  const key = t ? targetKey(t) : null;
  const s = useIntentState(key, () => {
    if (latest.current) prefetchVodDetail(qc, latest.current);
  });
  useEffect(() => {
    if (key === null) return;
    startRest(s, 'cursor');
    return () => cancelKind(s, 'cursor');
  }, [s, key]);
}
