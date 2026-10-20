/**
 * LG-12: Live's two pinned groups, Favorites and Recently watched, as `PagedChannels`, so the
 * same `ChannelList` shows them with what is on, progress, the ribbon and the stage. They used to
 * be separate pages with an "Added 3 days ago" column and no programme at all.
 *
 * The route names them like a group (`/s/:id/live/@favorites`, `?category=@recent` on Radio).
 * Both come from the core as refs (`favorites.list` in the user's order, `recent.list` newest
 * first); the rows on screen ask `catalog.item` for their channels, and now/next follows the
 * visible rows in fixed chunks, keyed by the entries' refs so it does not wait on the channels.
 * Only XMLTV now/next: a Stalker portal's own guide and the short EPG stay with the groups.
 */

import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { invalidate, rpcKey, useRpcQuery } from '@/api/query';
import { rpcRaw, type RpcResult } from '@/api/transport';
import { itemKey, type Channel, type ContentType, type EpgNowNext, type FavoriteEntry, type ItemKey, type ItemRef, type RecentEntry } from '@/api/types';

import { foldForFilter } from '../components/CategorySidebar';
import { MINUTE, ms } from '../lib/epgTime';
import type { PagedChannels } from './usePagedChannels';

export type LiveView = 'favorites' | 'recent';

/** The pinned groups' ids in the route, where a group id would be. */
export const LIVE_VIEW_ID: Record<LiveView, string> = { favorites: '@favorites', recent: '@recent' };

/** The view a route's group id names, if any. */
export function liveViewOf(categoryId: string | undefined): LiveView | undefined {
  if (categoryId === LIVE_VIEW_ID.favorites) return 'favorites';
  if (categoryId === LIVE_VIEW_ID.recent) return 'recent';
  return undefined;
}

/** Recently watched keeps this many channels; favorites past this many are left to their page. */
const RECENT_LIMIT = 100;
const VIEW_CAP = 1000;
/** Rows fetched beyond the visible ones, so a short scroll finds them drawn. */
const AROUND = 20;
/** now/next chunk: the one or two chunks on screen are asked, with stable keys while scrolling. */
const CHUNK = 60;
const CHANNEL_STALE_MS = 5 * 60_000;
const NO_ENTRIES: (FavoriteEntry | RecentEntry)[] = [];

/** An entry the catalog no longer answers for: its stored name and logo still fill the row. */
function snapshotChannel(e: FavoriteEntry | RecentEntry): Channel {
  return {
    ref: e.ref,
    name: e.snapshot.title,
    logoUrl: e.snapshot.posterUrl,
    categoryId: '',
    categoryName: e.snapshot.subtitle ?? '',
    isRadio: e.ref.contentType === 'radio',
  };
}

export interface LiveViewArgs {
  sourceId: string;
  contentType: ContentType;
  search?: string;
  /** The page clock: now/next refreshes once an airing programme ends. */
  now?: number;
  epgOffsetMinutes?: number;
}

export function useLiveViewChannels(view: LiveView | undefined, args: LiveViewArgs): PagedChannels | null {
  const queryClient = useQueryClient();
  const { sourceId, contentType } = args;
  const offsetMinutes = args.epgOffsetMinutes ?? 0;
  const favs = useRpcQuery('favorites.list', { sourceId }, { enabled: view === 'favorites' && !!sourceId });
  const recents = useRpcQuery('recent.list', { sourceId, limit: RECENT_LIMIT }, { enabled: view === 'recent' && !!sourceId });
  const q = view === 'favorites' ? favs : recents;

  const search = foldForFilter(args.search?.trim() ?? '');
  const entries = useMemo(() => {
    if (!view) return NO_ENTRIES;
    const raw: (FavoriteEntry | RecentEntry)[] =
      view === 'favorites'
        ? [...(favs.data ?? [])].sort((a, b) => a.position - b.position || a.addedAt.localeCompare(b.addedAt))
        : [...(recents.data ?? [])];
    // A search narrows the view by name, as it narrows a group.
    return raw
      .filter((e) => e.ref.contentType === contentType && (!search || foldForFilter(e.snapshot.title).includes(search)))
      .slice(0, VIEW_CAP);
  }, [view, favs.data, recents.data, contentType, search]);

  const [range, setRange] = useState({ start: 0, end: 0 });
  const setVisibleRange = useCallback((start: number, end: number) => {
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
  }, []);
  const nearFrom = Math.max(0, range.start - AROUND);
  const near = entries.slice(nearFrom, range.end + AROUND + 1);
  const items = useQueries({
    queries: near.map((e) => ({
      queryKey: rpcKey('catalog.item', { ref: e.ref }),
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await rpcRaw('catalog.item', { ref: e.ref }, { signal })) as RpcResult<'catalog.item'>,
      staleTime: CHANNEL_STALE_MS,
      retry: false,
    })),
  });
  // A new function whenever a channel arrives, so the rows read it.
  const stamp = items.map((i) => `${i.dataUpdatedAt}:${i.errorUpdatedAt}`).join(',');
  const getChannel = useCallback(
    (index: number): Channel | undefined => {
      const e = entries[index];
      if (!e) return undefined;
      const state = queryClient.getQueryState<RpcResult<'catalog.item'>>(rpcKey('catalog.item', { ref: e.ref }));
      if (state?.data && 'isRadio' in state.data) return state.data;
      return state?.status === 'error' ? snapshotChannel(e) : undefined;
    },
    [entries, queryClient, stamp], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // now/next and the favorite flags of the one or two chunks on screen.
  const a = Math.floor(range.start / CHUNK);
  const b = Math.max(a, Math.floor(range.end / CHUNK));
  const refsA = useMemo((): ItemRef[] => entries.slice(a * CHUNK, (a + 1) * CHUNK).map((e) => e.ref), [entries, a]);
  const refsB = useMemo((): ItemRef[] => (b !== a ? entries.slice(b * CHUNK, (b + 1) * CHUNK).map((e) => e.ref) : []), [entries, a, b]);
  const nnArgs = (refs: ItemRef[]) => (offsetMinutes ? { refs, offsetMinutes, withDescription: false } : { refs, withDescription: false });
  const nnA = useRpcQuery('epg.nowNext', nnArgs(refsA), { enabled: refsA.length > 0, staleTime: 60_000 });
  const nnB = useRpcQuery('epg.nowNext', nnArgs(refsB), { enabled: refsB.length > 0, staleTime: 60_000 });
  const favA = useRpcQuery('favorites.contains', { refs: refsA }, { enabled: view === 'recent' && refsA.length > 0 });
  const favB = useRpcQuery('favorites.contains', { refs: refsB }, { enabled: view === 'recent' && refsB.length > 0 });
  const favSet = useMemo(() => new Set<ItemKey>([...(favA.data ?? []), ...(favB.data ?? [])].map(itemKey)), [favA.data, favB.data]);

  const getNowNext = useCallback(
    (index: number): EpgNowNext | undefined => {
      const e = entries[index];
      if (!e) return undefined;
      const key = itemKey(e.ref);
      return nnA.data?.[key] ?? nnB.data?.[key];
    },
    [entries, nnA.data, nnB.data],
  );
  const isFavorite = useCallback(
    (index: number) => {
      if (view === 'favorites') return true;
      const e = entries[index];
      return !!e && favSet.has(itemKey(e.ref));
    },
    [view, entries, favSet],
  );

  // Refresh now/next once an airing programme has ended, at most once per clock tick.
  const now = args.now;
  const refreshedAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (now === undefined || !view) return;
    const guideNow = now - offsetMinutes * MINUTE;
    const ended = (nn: EpgNowNext) =>
      nn.now ? ms(nn.now.end) > 0 && ms(nn.now.end) <= guideNow : !!nn.next && ms(nn.next.start) > 0 && ms(nn.next.start) <= guideNow;
    const stale = [nnA.data, nnB.data].some((m) => m && Object.values(m).some(ended));
    if (stale && refreshedAt.current !== now) {
      refreshedAt.current = now;
      void invalidate('epg.nowNext');
    }
  }, [now, view, offsetMinutes, nnA.data, nnB.data]);

  const refetch = q.refetch;
  const retry = useCallback(() => void refetch(), [refetch]);

  return useMemo(() => {
    if (!view) return null;
    const loaded: { index: number; channel: Channel }[] = [];
    for (let i = nearFrom; i < nearFrom + near.length; i++) {
      const channel = getChannel(i);
      if (channel) loaded.push({ index: i, channel });
    }
    return {
      total: q.data ? entries.length : undefined,
      getChannel,
      getNowNext,
      isFavorite,
      setVisibleRange,
      isLoading: q.isLoading,
      refreshing: false,
      error: q.error,
      retry,
      loaded,
      pageSize: CHUNK,
      guideUnavailable: false,
      retryGuide: () => undefined,
    };
    // `near` follows `entries` and the range.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, q.data, q.isLoading, q.error, entries, nearFrom, near.length, getChannel, getNowNext, isFavorite, setVisibleRange, retry]);
}
