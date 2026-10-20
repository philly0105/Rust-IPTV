/**
 * Data hooks for the VOD feature. Query keys are always `[cmd, args]` so the
 * shell's event invalidation (`invalidate('catalog.')`, `'favorites.'`, ...)
 * reaches them.
 */

import { queryOptions, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';

import { RECENTLY_ADDED_LIMIT, recentlyAddedArgs } from '@/api/bootPrefetch';
import { onAppEvent } from '@/api/events';
import { invalidate, queryDefaultsFor, rpcKey, useRpcQuery } from '@/api/query';
import { RpcError, rpcRaw } from '@/api/transport';
import type {
  ItemRef,
  Page,
  PlaybackPosition,
  SeriesDetail,
  SeriesItem,
  Settings,
  Source,
  SourceKind,
  TmdbMovie,
  TmdbTv,
  VodDetail,
  VodItem,
} from '@/api/types';
import { DEFAULT_SETTINGS } from '@/api/types';

import { buildPageRequest, type GridQueryInput } from '../lib/paging';
import { invalidateWatched } from '../lib/watchedQueries';

/**
 * Grid pages, SQLite or portal, use the catalog row of the C4 table (2 min fresh, 10 min
 * cached), so going back to a grid within that time shows the pages without a refetch.
 * Explicit here so portal commands (`stalker.movies`) get the same timing.
 */
const PAGE_TIMING = queryDefaultsFor('catalog.movies');

/** Detail data stays fresh for 5 minutes, so a hover prefetch is still good when the page opens. */
export const DETAIL_STALE_MS = 5 * 60_000;

// Timing comes from queryDefaultsFor (C4): events and setSettingsCache keep settings fresh.
export function useSettings(): Settings {
  const q = useRpcQuery('settings.get', undefined);
  return q.data ?? DEFAULT_SETTINGS;
}

/** How many continue-watching entries a grid reads to mark resumable posters. */
const RESUME_LOOKUP_LIMIT = 500;

/** `sourceId|contentType|itemId` for matching saved positions to grid items. */
export function resumeKey(ref: ItemRef): string {
  return `${ref.sourceId}|${ref.contentType}|${ref.itemId}`;
}

/**
 * Watched fraction per title for one source and kind, from continue watching
 * (newest first, so a series shows the episode you were last in). Grids draw
 * it as the thin progress bar on the poster.
 */
export function useResumeMap(sourceId: string, kind: 'movie' | 'series'): Map<string, number> {
  return useResumeLookup(!!sourceId, (ref) => ref.sourceId === sourceId && ref.contentType === kind, `${sourceId}|${kind}`);
}

/**
 * Watched fraction per title across every source (search results, rails that
 * mix sources), keyed by `resumeKey`. `accept` narrows which refs count;
 * `filterKey` names what `accept` checks, so a new filter recomputes the map.
 */
export function useResumeLookup(enabled = true, accept?: (ref: ItemRef) => boolean, filterKey = ''): Map<string, number> {
  const q = useRpcQuery('positions.continueWatching', { limit: RESUME_LOOKUP_LIMIT }, { enabled });
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  return useMemo(() => {
    const out = new Map<string, number>();
    for (const p of q.data ?? []) {
      if (p.watched || (p.ref.contentType !== 'movie' && p.ref.contentType !== 'series')) continue;
      if (acceptRef.current && !acceptRef.current(p.ref)) continue;
      if (!p.durationSeconds || !Number.isFinite(p.durationSeconds) || p.durationSeconds <= 0) continue;
      const key = resumeKey(p.ref);
      if (out.has(key)) continue;
      const f = Math.min(1, Math.max(0, p.positionSeconds / p.durationSeconds));
      if (f > 0) out.set(key, f);
    }
    return out;
  }, [q.data, filterKey]);
}

/** Cards in a landing's Continue watching rail. */
export const CONTINUE_RAIL_LIMIT = 20;

/**
 * Continue watching for one source and section (CB-VOD-LANDING): the titles with a saved,
 * unfinished position, newest first, one entry per title (a series shows the episode you were
 * last in). Reads the same `positions.continueWatching` answer as {@link useResumeMap}, so the
 * landing asks for it once.
 */
export function useSectionContinue(sourceId: string, kind: 'movie' | 'series'): PlaybackPosition[] {
  const q = useRpcQuery('positions.continueWatching', { limit: RESUME_LOOKUP_LIMIT }, { enabled: !!sourceId });
  return useMemo(() => {
    const out: PlaybackPosition[] = [];
    const seen = new Set<string>();
    for (const p of q.data ?? []) {
      if (p.watched || p.ref.sourceId !== sourceId || p.ref.contentType !== kind) continue;
      if (!p.durationSeconds || !(p.positionSeconds > 0)) continue;
      const key = resumeKey(p.ref);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      if (out.length >= CONTINUE_RAIL_LIMIT) break;
    }
    return out;
  }, [q.data, sourceId, kind]);
}

/**
 * One source. Seeded from the cached `sources.list` (the sidebar loads it at startup), so a VOD
 * page knows the source's name and kind in its first frame instead of after a `sources.get`
 * round trip: its shelves and toolbars mount at once and nothing shifts when the record arrives
 * (L2-vod-5). The seed counts as old as the list, so the usual staleness rules still refetch it.
 */
export function useSource(sourceId: string | undefined): UseQueryResult<Source, RpcError> {
  const qc = useQueryClient();
  const args = { id: sourceId ?? '' };
  const listKey = rpcKey('sources.list', undefined);
  return useQuery<Source, RpcError>({
    queryKey: rpcKey('sources.get', args),
    queryFn: async ({ signal }) => (await rpcRaw('sources.get', args, { signal })) as Source,
    enabled: !!sourceId,
    initialData: () => (sourceId ? qc.getQueryData<Source[]>(listKey)?.find((s) => s.id === sourceId) : undefined),
    initialDataUpdatedAt: () => qc.getQueryState(listKey)?.dataUpdatedAt,
  });
}

export function useSourcesList(): UseQueryResult<Source[], RpcError> {
  return useRpcQuery('sources.list', undefined);
}

/**
 * True when two page-query keys ask for the same slot of the same grid: the same command, source,
 * category, offset and page size. Sort, search, rating, years and Hide watched may differ.
 */
export function sameGridSlot(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a[0] !== b[0]) return false;
  const slot = (k: unknown) => {
    if (typeof k !== 'object' || k === null) return k;
    const { sourceId, categoryId, query } = k as { sourceId?: unknown; categoryId?: unknown; query?: { offset?: unknown; limit?: unknown } };
    return { sourceId, categoryId, offset: query?.offset, limit: query?.limit };
  };
  return JSON.stringify(slot(a[1])) === JSON.stringify(slot(b[1]));
}

/**
 * One grid page. Cells subscribe to the page containing them; unused pages are garbage-collected.
 * A new sort, search, rating, year range or Hide watched keeps each page's previous titles on
 * screen until the new page answers (L2-vod-8, L3-vod-3), so the grid stays mounted and its cells
 * refill, instead of the whole grid dropping to skeletons and every cell being built again.
 */
export function useVodPage(
  input: GridQueryInput | undefined,
  pageIndex: number,
  /** False holds the request (a grid page the user is dragging past, VD-2); cached data still shows. */
  fetchNow = true,
): UseQueryResult<Page<VodItem | SeriesItem>, RpcError> {
  const req = input ? buildPageRequest(input, pageIndex) : undefined;
  const queryKey = req ? [req.cmd, req.args] : ['catalog.movies', 'disabled'];
  return useQuery<Page<VodItem | SeriesItem>, RpcError>({
    queryKey,
    queryFn: async ({ signal }) => {
      if (!req) throw new RpcError('invalid', 'No source');
      return (await rpcRaw(req.cmd, req.args, { signal })) as Page<VodItem | SeriesItem>;
    },
    enabled: !!req && fetchNow,
    placeholderData: (prev, prevQuery) => (prev && prevQuery && sameGridSlot(prevQuery.queryKey, queryKey) ? prev : undefined),
    ...PAGE_TIMING,
  });
}

/**
 * Sequential pages for a rating-filtered Stalker grid. The portal cannot
 * filter by rating, so a minimum hides an unknown number of items per page and
 * sparse index paging cannot work; the grid loads pages in order instead and
 * filters them as they arrive. SQLite-backed grids filter in the core.
 */
export function useVodPagesInOrder(input: GridQueryInput | undefined, enabled: boolean) {
  const first = input ? buildPageRequest(input, 0) : undefined;
  return useInfiniteQuery<Page<VodItem | SeriesItem>, RpcError>({
    queryKey: first ? [first.cmd, { ...first.args, query: { ...first.args.query, offset: undefined }, inOrder: true }] : ['catalog.movies', 'disabled-in-order'],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      if (!input) throw new RpcError('invalid', 'No source');
      const req = buildPageRequest(input, pageParam as number);
      return (await rpcRaw(req.cmd, req.args, { signal })) as Page<VodItem | SeriesItem>;
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? pages.length : undefined;
    },
    enabled: enabled && !!input,
    ...PAGE_TIMING,
  });
}

/**
 * Recently added rail. Stalker VOD is not in SQLite, so it reads the portal's first page sorted by added.
 * The SQLite args come from {@link recentlyAddedArgs}, which the boot prefetch asks with too (L3-ui-data-x7).
 */
export function useRecentlyAdded(
  source: Source | undefined,
  kind: 'movie' | 'series',
  limit = RECENTLY_ADDED_LIMIT,
): UseQueryResult<(VodItem | SeriesItem)[], RpcError> {
  return useQuery<(VodItem | SeriesItem)[], RpcError>({
    queryKey: source?.kind === 'stalker'
      ? [kind === 'movie' ? 'stalker.movies' : 'stalker.series', { sourceId: source.id, query: { offset: 0, limit: 28, sort: 'added', dir: 'desc' } }]
      : ['catalog.recentlyAdded', recentlyAddedArgs(source?.id ?? '', kind, limit)],
    queryFn: async ({ signal }) => {
      if (!source) return [];
      if (source.kind === 'stalker') {
        const page = (await rpcRaw(kind === 'movie' ? 'stalker.movies' : 'stalker.series', {
          sourceId: source.id,
          query: { offset: 0, limit: 28, sort: 'added', dir: 'desc' },
        }, { signal })) as Page<VodItem | SeriesItem>;
        return page.items.slice(0, limit);
      }
      return (await rpcRaw('catalog.recentlyAdded', recentlyAddedArgs(source.id, kind, limit), { signal })) as (VodItem | SeriesItem)[];
    },
    enabled: !!source,
    staleTime: 60_000,
  });
}

function detailCommand(sourceKind: SourceKind, kind: 'movie' | 'series'): string {
  if (sourceKind === 'stalker') return kind === 'movie' ? 'stalker.vodDetail' : 'stalker.seriesDetail';
  if (sourceKind === 'xtream') return kind === 'movie' ? 'xtream.vodDetail' : 'xtream.seriesDetail';
  // m3u series rows carry the episodes the importer grouped (m3u.md, Series).
  return kind === 'movie' ? 'catalog.item' : 'm3u.seriesDetail';
}

/** Only the ItemRef fields, so a ref carrying extra properties still hits the same cache entry. */
function plainRef(ref: ItemRef): ItemRef {
  return { sourceId: ref.sourceId, contentType: ref.contentType, itemId: ref.itemId };
}

/**
 * An m3u playlist has no provider detail: the movie detail query caches the bare `catalog.item`
 * row under `['catalog.item', { ref }]`, the key flat `useRpcQuery('catalog.item')` readers (the
 * player, live pages) share, so the two never hold different shapes for one ref; `select`
 * wraps it as a detail (L2 XB2-34).
 */
function toMovieDetail(data: VodDetail | VodItem): VodDetail {
  return 'item' in data ? data : { item: data, cast: [], backdrops: [], providerDetailsUnavailable: false };
}

/** As {@link toMovieDetail}, for a bare series row (an m3u series answers `m3u.seriesDetail` with its seasons). */
function toSeriesDetail(data: SeriesDetail | SeriesItem): SeriesDetail {
  return 'item' in data ? data : { item: data, seasons: [], cast: [], backdrops: [], providerDetailsUnavailable: false };
}

/**
 * Movie detail query: provider detail for portals; for m3u the catalog row, wrapped as a detail
 * by `select` (m3u series ask `m3u.seriesDetail`). Shared by useMovieDetail and the hover prefetch (C4), so both use one key and fn.
 */
export function movieDetailQuery(sourceKind: SourceKind | undefined, ref: ItemRef) {
  const cmd = sourceKind ? detailCommand(sourceKind, 'movie') : 'catalog.item';
  const args = { ref: plainRef(ref) };
  return queryOptions<VodDetail | VodItem, RpcError, VodDetail>({
    queryKey: [cmd, args],
    queryFn: async ({ signal }) => (await rpcRaw(cmd, args, { signal })) as VodDetail | VodItem,
    select: toMovieDetail,
    staleTime: DETAIL_STALE_MS,
  });
}

/** Series detail query, shared by useSeriesDetail and the hover prefetch (C4). */
export function seriesDetailQuery(sourceKind: SourceKind | undefined, ref: ItemRef) {
  const cmd = sourceKind ? detailCommand(sourceKind, 'series') : 'xtream.seriesDetail';
  const args = { ref: plainRef(ref) };
  return queryOptions<SeriesDetail | SeriesItem, RpcError, SeriesDetail>({
    queryKey: [cmd, args],
    queryFn: async ({ signal }) => (await rpcRaw(cmd, args, { signal })) as SeriesDetail | SeriesItem,
    select: toSeriesDetail,
    staleTime: DETAIL_STALE_MS,
  });
}

export function useMovieDetail(source: Source | undefined, ref: ItemRef): UseQueryResult<VodDetail, RpcError> {
  return useQuery({ ...movieDetailQuery(source?.kind, ref), enabled: !!source });
}

export function useSeriesDetail(source: Source | undefined, ref: ItemRef): UseQueryResult<SeriesDetail, RpcError> {
  return useQuery({ ...seriesDetailQuery(source?.kind, ref), enabled: !!source });
}

interface TmdbLookup {
  title: string;
  year?: number;
  tmdbId?: number;
}

function lookupArgs(item: Pick<VodItem, 'title' | 'titleBase' | 'year' | 'tmdbId'> | undefined): TmdbLookup | undefined {
  if (!item) return undefined;
  const args: TmdbLookup = { title: item.titleBase || item.title };
  if (item.year) args.year = item.year;
  if (item.tmdbId) args.tmdbId = item.tmdbId;
  return args;
}

/** TMDB movie lookup, only when enrichment is on. Provider tmdbId goes first (the server tries it before the title). */
export function useTmdbMovie(item: VodItem | undefined, enabled: boolean): UseQueryResult<TmdbMovie | null, RpcError> {
  const args = lookupArgs(item);
  return useRpcQuery('tmdb.movie', args ?? { title: '' }, { enabled: enabled && !!args });
}

export function useTmdbTv(item: SeriesItem | undefined, enabled: boolean): UseQueryResult<TmdbTv | null, RpcError> {
  const args = lookupArgs(item);
  return useRpcQuery('tmdb.tv', args ?? { title: '' }, { enabled: enabled && !!args });
}

/**
 * Starts the TMDB lookup the detail page sends for `item` (the key and fn of useTmdbMovie and
 * useTmdbTv), when enrichment is on, so a hover prefetch has the cast and trailer ready with the
 * detail instead of after it (VD-8). A failure costs nothing; the page asks again on open.
 */
export function prefetchTmdb(qc: QueryClient, kind: 'movie' | 'series', item: Pick<VodItem, 'title' | 'titleBase' | 'year' | 'tmdbId'> | undefined): void {
  if (qc.getQueryData<Settings>(rpcKey('settings.get', undefined))?.tmdb.enabled !== true) return;
  const args = lookupArgs(item);
  if (!args) return;
  if (kind === 'movie') {
    void qc.prefetchQuery({
      queryKey: rpcKey('tmdb.movie', args),
      queryFn: async ({ signal }) => (await rpcRaw('tmdb.movie', args, { signal })) as TmdbMovie | null,
      retry: false,
    });
  } else {
    void qc.prefetchQuery({
      queryKey: rpcKey('tmdb.tv', args),
      queryFn: async ({ signal }) => (await rpcRaw('tmdb.tv', args, { signal })) as TmdbTv | null,
      retry: false,
    });
  }
}

export function useTmdbSimilar(mediaType: 'movie' | 'tv', tmdbId: number | undefined, enabled: boolean) {
  return useRpcQuery('tmdb.similar', { mediaType, tmdbId: tmdbId ?? 0 }, { enabled: enabled && !!tmdbId });
}

export function useIsFavorite(ref: ItemRef): boolean {
  const q = useRpcQuery('favorites.contains', { refs: [ref] }, { staleTime: 30_000 });
  return (q.data?.length ?? 0) > 0;
}

/**
 * Downloads list kept fresh by `downloads.update` / `downloads.progress` events. With `tracked`,
 * progress refetches only for the ids it holds (the page's own rows, VD-3): a transfer of some
 * other title does not refetch the whole list twice a second.
 */
export function useDownloads(enabled = true, tracked?: { readonly current: ReadonlySet<number> }) {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void invalidate('downloads.list');
      }, 500);
    };
    const off1 = onAppEvent('downloads.update', bump);
    const off2 = onAppEvent('downloads.progress', (e) => {
      if (!tracked || (e && tracked.current.has(e.id))) bump();
    });
    return () => {
      off1();
      off2();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, tracked]);
  return useRpcQuery('downloads.list', undefined, { enabled, staleTime: 10_000 });
}

/** Source id -> Source for badges and play routing. */
export function useSourceMap(): Map<string, Source> {
  const q = useSourcesList();
  return useMemo(() => new Map((q.data ?? []).map((s) => [s.id, s])), [q.data]);
}

/**
 * A cold link can name the wrong kind (`/movie/<id>` for a series). When the
 * detail lookup fails, ask whether the id exists as the other kind: the
 * SQLite catalog row for m3u and Xtream, the portal detail for Stalker (its
 * VOD is not in SQLite, and VOD-as-series rows are listed as series).
 * Resolves to the twin ref, or null.
 */
export function useTwinProbe(source: Source | undefined, ref: ItemRef, enabled: boolean): UseQueryResult<ItemRef | null, RpcError> {
  const twin: ItemRef = { ...ref, contentType: ref.contentType === 'movie' ? 'series' : 'movie' };
  return useQuery<ItemRef | null, RpcError>({
    queryKey: ['vod.twin', { ref: twin, kind: source?.kind }],
    queryFn: async ({ signal }) => {
      if (!source) return null;
      const cmd = source.kind === 'stalker' ? detailCommand('stalker', twin.contentType === 'movie' ? 'movie' : 'series') : 'catalog.item';
      try {
        await rpcRaw(cmd, { ref: twin }, { signal });
        return twin;
      } catch {
        return null;
      }
    },
    enabled: enabled && !!source,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * True when TMDB is on but no API key resolves (settings or `.env`). With no
 * key in settings it asks `tmdb.testKey` once with a blank key, which checks
 * the `.env` fallback; any other outcome counts as "a key exists".
 */
export function useTmdbKeyMissing(settings: Settings): boolean {
  const on = settings.tmdb.enabled;
  const inSettings = !!settings.tmdb.apiKey?.trim();
  const q = useQuery<{ ok: boolean; message?: string }, RpcError>({
    queryKey: ['tmdb.testKey', { apiKey: '' }],
    queryFn: async ({ signal }) => (await rpcRaw('tmdb.testKey', { apiKey: '' }, { signal })) as { ok: boolean; message?: string },
    enabled: on && !inSettings,
    staleTime: Infinity,
    retry: false,
  });
  return on && !inSettings && q.data?.ok === false && /no api key/i.test(q.data.message ?? '');
}

export interface SetWatchedArgs {
  ref: ItemRef;
  episodeIds?: string[];
  watched: boolean;
  /** With `episodeIds`: also set the series-level row, after the episodes (L1-vod-1, `lib/seriesWatched`). */
  series?: boolean;
}

/**
 * Marks a movie, or a set of episodes, watched or unwatched through
 * `userstate.setWatched` (B2-fix1), then refreshes positions.
 */
export function useSetWatched() {
  const qc = useQueryClient();
  return useMutation<void, RpcError, SetWatchedArgs>({
    mutationFn: async ({ ref, episodeIds, watched, series }) => {
      if (!episodeIds) {
        await rpcRaw('userstate.setWatched', { ref, watched });
        return;
      }
      await Promise.all(episodeIds.map((episodeId) => rpcRaw('userstate.setWatched', { ref, episodeId, watched })));
      if (series) await rpcRaw('userstate.setWatched', { ref, watched });
    },
    onSettled: () => invalidateWatched(qc),
  });
}

/**
 * Refreshes what a watched mark changes: positions, user state, My List, and
 * the grid pages that "Hide watched" filters in the core (C4). Lives in
 * `lib/watchedQueries` so the player store can use it after a finishing save.
 */
export { invalidateWatched };
