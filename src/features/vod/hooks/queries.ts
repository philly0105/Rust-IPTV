/**
 * Data hooks for the VOD feature. Query keys are always `[cmd, args]` so the
 * shell's event invalidation (`invalidate('catalog.')`, `'favorites.'`, ...)
 * reaches them.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { onAppEvent } from '@/api/events';
import { invalidate, useRpcQuery } from '@/api/query';
import { RpcError, rpcRaw } from '@/api/transport';
import type {
  ItemRef,
  Page,
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

/** Grid pages stay cached for a minute after their cells scroll away. */
const PAGE_CACHE_MS = 60_000;

export function useSettings(): Settings {
  const q = useRpcQuery('settings.get', undefined, { staleTime: 60_000 });
  return q.data ?? DEFAULT_SETTINGS;
}

export function useSource(sourceId: string | undefined): UseQueryResult<Source, RpcError> {
  return useRpcQuery('sources.get', { id: sourceId ?? '' }, { enabled: !!sourceId, staleTime: 60_000 });
}

export function useSourcesList(): UseQueryResult<Source[], RpcError> {
  return useRpcQuery('sources.list', undefined, { staleTime: 60_000 });
}

/** One grid page. Cells subscribe to the page containing them; unused pages are garbage-collected. */
export function useVodPage(
  input: GridQueryInput | undefined,
  pageIndex: number,
): UseQueryResult<Page<VodItem | SeriesItem>, RpcError> {
  const req = input ? buildPageRequest(input, pageIndex) : undefined;
  return useQuery<Page<VodItem | SeriesItem>, RpcError>({
    queryKey: req ? [req.cmd, req.args] : ['catalog.movies', 'disabled'],
    queryFn: async () => {
      if (!req) throw new RpcError('invalid', 'No source');
      return (await rpcRaw(req.cmd, req.args)) as Page<VodItem | SeriesItem>;
    },
    enabled: !!req,
    staleTime: PAGE_CACHE_MS,
    gcTime: PAGE_CACHE_MS,
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
    queryFn: async ({ pageParam }) => {
      if (!input) throw new RpcError('invalid', 'No source');
      const req = buildPageRequest(input, pageParam as number);
      return (await rpcRaw(req.cmd, req.args)) as Page<VodItem | SeriesItem>;
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? pages.length : undefined;
    },
    enabled: enabled && !!input,
    staleTime: PAGE_CACHE_MS,
    gcTime: PAGE_CACHE_MS,
  });
}

/** Recently added rail. Stalker VOD is not in SQLite, so it reads the portal's first page sorted by added. */
export function useRecentlyAdded(
  source: Source | undefined,
  kind: 'movie' | 'series',
  limit = 24,
): UseQueryResult<(VodItem | SeriesItem)[], RpcError> {
  return useQuery<(VodItem | SeriesItem)[], RpcError>({
    queryKey: source?.kind === 'stalker'
      ? [kind === 'movie' ? 'stalker.movies' : 'stalker.series', { sourceId: source.id, query: { offset: 0, limit: 28, sort: 'added', dir: 'desc' } }]
      : ['catalog.recentlyAdded', { sourceId: source?.id ?? '', contentType: kind, limit }],
    queryFn: async () => {
      if (!source) return [];
      if (source.kind === 'stalker') {
        const page = (await rpcRaw(kind === 'movie' ? 'stalker.movies' : 'stalker.series', {
          sourceId: source.id,
          query: { offset: 0, limit: 28, sort: 'added', dir: 'desc' },
        })) as Page<VodItem | SeriesItem>;
        return page.items.slice(0, limit);
      }
      return (await rpcRaw('catalog.recentlyAdded', { sourceId: source.id, contentType: kind, limit })) as (VodItem | SeriesItem)[];
    },
    enabled: !!source,
    staleTime: 60_000,
  });
}

function detailCommand(sourceKind: SourceKind, kind: 'movie' | 'series'): string {
  if (sourceKind === 'stalker') return kind === 'movie' ? 'stalker.vodDetail' : 'stalker.seriesDetail';
  if (sourceKind === 'xtream') return kind === 'movie' ? 'xtream.vodDetail' : 'xtream.seriesDetail';
  return 'catalog.item';
}

/** Movie detail: provider detail for portals; for m3u the catalog row wrapped as a detail. */
export function useMovieDetail(source: Source | undefined, ref: ItemRef): UseQueryResult<VodDetail, RpcError> {
  const cmd = source ? detailCommand(source.kind, 'movie') : 'catalog.item';
  return useQuery<VodDetail, RpcError>({
    queryKey: [cmd, { ref }],
    queryFn: async () => {
      const res = await rpcRaw(cmd, { ref });
      if (cmd === 'catalog.item') return { item: res as VodItem, cast: [], backdrops: [], providerDetailsUnavailable: false };
      return res as VodDetail;
    },
    enabled: !!source,
    staleTime: 5 * 60_000,
  });
}

export function useSeriesDetail(source: Source | undefined, ref: ItemRef): UseQueryResult<SeriesDetail, RpcError> {
  const cmd = source ? detailCommand(source.kind, 'series') : 'xtream.seriesDetail';
  return useQuery<SeriesDetail, RpcError>({
    queryKey: [cmd, { ref }],
    queryFn: async () => {
      if (cmd === 'catalog.item') {
        // m3u playlists have no series metadata; show the row with no episodes.
        const item = (await rpcRaw(cmd, { ref })) as SeriesItem;
        return { item, seasons: [], cast: [], backdrops: [], providerDetailsUnavailable: false };
      }
      return (await rpcRaw(cmd, { ref })) as SeriesDetail;
    },
    enabled: !!source,
    staleTime: 5 * 60_000,
  });
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
  return useRpcQuery('tmdb.movie', args ?? { title: '' }, { enabled: enabled && !!args, staleTime: Infinity });
}

export function useTmdbTv(item: SeriesItem | undefined, enabled: boolean): UseQueryResult<TmdbTv | null, RpcError> {
  const args = lookupArgs(item);
  return useRpcQuery('tmdb.tv', args ?? { title: '' }, { enabled: enabled && !!args, staleTime: Infinity });
}

export function useTmdbSimilar(mediaType: 'movie' | 'tv', tmdbId: number | undefined, enabled: boolean) {
  return useRpcQuery('tmdb.similar', { mediaType, tmdbId: tmdbId ?? 0 }, { enabled: enabled && !!tmdbId, staleTime: Infinity });
}

export function useIsFavorite(ref: ItemRef): boolean {
  const q = useRpcQuery('favorites.contains', { refs: [ref] }, { staleTime: 30_000 });
  return (q.data?.length ?? 0) > 0;
}

/** Downloads list kept fresh by `downloads.update` / `downloads.progress` events. */
export function useDownloads(enabled = true) {
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
    const off2 = onAppEvent('downloads.progress', bump);
    return () => {
      off1();
      off2();
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
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
    queryFn: async () => {
      if (!source) return null;
      const cmd = source.kind === 'stalker' ? detailCommand('stalker', twin.contentType === 'movie' ? 'movie' : 'series') : 'catalog.item';
      try {
        await rpcRaw(cmd, { ref: twin });
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
    queryFn: async () => (await rpcRaw('tmdb.testKey', { apiKey: '' })) as { ok: boolean; message?: string },
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
}

/**
 * Marks a movie, or a set of episodes, watched or unwatched through
 * `userstate.setWatched` (B2-fix1), then refreshes positions.
 */
export function useSetWatched() {
  const qc = useQueryClient();
  return useMutation<void, RpcError, SetWatchedArgs>({
    mutationFn: async ({ ref, episodeIds, watched }) => {
      if (!episodeIds) {
        await rpcRaw('userstate.setWatched', { ref, watched });
        return;
      }
      await Promise.all(episodeIds.map((episodeId) => rpcRaw('userstate.setWatched', { ref, episodeId, watched })));
    },
    onSettled: async () => {
      await qc.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === 'string' && (q.queryKey[0].startsWith('positions.') || q.queryKey[0].startsWith('userstate.')),
      });
    },
  });
}
