/**
 * Hover and focus prefetch of VOD detail pages (Run 3 contract C4).
 *
 * When the pointer rests on a poster for 120 ms, or the poster takes focus,
 * the detail page's data, its route chunk and its artwork start loading, so
 * the click lands on a page that is already filled in. Each title is
 * prefetched at most once per session; Data Saver and touch screens skip it.
 * See docs/architecture/performance.md.
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

/** Pointer and focus handlers returned by `usePrefetchIntent`. Spread them onto the card's link. */
export interface PrefetchIntent {
  onPointerEnter(e?: PointerLike): void;
  onPointerLeave(): void;
  onFocus(): void;
}

/** How long the pointer has to rest on a card before it counts as intent. */
export const PREFETCH_REST_MS = 120;

/** Keys already prefetched this session (see `targetKey`). */
const prefetched = new Set<string>();

/** Forgets every prefetch, so the next intent fires again. For tests. */
export function resetPrefetchMemory(): void {
  prefetched.clear();
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
  const afterData = (detail: { item: { backdropUrl?: string }; backdrops: string[] } | undefined) => {
    if (t.backdropUrl || !detail) return;
    preloadImage(detail.item.backdropUrl ?? detail.backdrops[0], ref.sourceId);
  };
  // retry: false: a failed prefetch costs nothing; the page asks again (with retries) on open.
  if (ref.contentType === 'movie') {
    warmChunk(loadMovieDetailPage);
    const q = movieDetailQuery(t.sourceKind, ref);
    void qc.prefetchQuery({ ...q, retry: false }).then(() => afterData(qc.getQueryData(q.queryKey)));
  } else {
    warmChunk(loadSeriesDetailPage);
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
    queryFn: async () => (await rpcRaw('catalog.search', args)) as CatalogSearchResult,
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

interface IntentState {
  key: string | null;
  fire: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function cancel(s: IntentState): void {
  if (s.timer === undefined) return;
  clearTimeout(s.timer);
  s.timer = undefined;
}

/** Runs `s.fire` once per key per session, unless prefetching is off right now. */
function fireOnce(s: IntentState): void {
  cancel(s);
  const key = s.key;
  if (key === null || prefetched.has(key) || !prefetchAllowed()) return;
  prefetched.add(key);
  s.fire();
}

/** Stable handlers for one card. A new key, or unmounting, cancels a pending rest. */
function useIntent(key: string | null, fire: () => void): PrefetchIntent {
  const ref = useRef<IntentState>({ key, fire, timer: undefined });
  ref.current.key = key;
  ref.current.fire = fire;
  useEffect(() => {
    const s = ref.current;
    return () => cancel(s);
  }, [key]);
  return useMemo(() => {
    const s = ref.current;
    return {
      onPointerEnter(e?: PointerLike) {
        if (e?.pointerType === 'touch' || s.key === null || prefetched.has(s.key)) return;
        cancel(s);
        s.timer = setTimeout(() => fireOnce(s), PREFETCH_REST_MS);
      },
      onPointerLeave() {
        cancel(s);
      },
      onFocus() {
        fireOnce(s);
      },
    };
  }, []);
}

/** Fires after the pointer rests 120 ms (or on focus); once per ref per session; skipped when navigator.connection?.saveData or the pointer is coarse. */
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
 */
export function usePrefetchOnRest(t: PrefetchTarget | null): void {
  const intent = usePrefetchIntent(t);
  const key = t ? targetKey(t) : null;
  useEffect(() => {
    if (key === null) return;
    intent.onPointerEnter();
    return () => intent.onPointerLeave();
  }, [intent, key]);
}
