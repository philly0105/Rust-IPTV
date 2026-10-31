/**
 * The guide's views besides a group (IPTVnator parity): the source's favorite channels, in
 * favorites order, or a custom list's channels of the source, in list order. The URL names the
 * view (`view=favorites`, `view=list:<id>`); the grid reads it through the same `PagedChannels`
 * shape as a source's paged channel list.
 */

import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { liveFavoritesArgs } from '@/api/bootPrefetch';
import { batchedItemQuery, rpcKey, useRpcQuery } from '@/api/query';
import type { RpcResult } from '@/api/transport';
import { sameRef, type Channel, type FavoriteEntry, type ItemRef } from '@/api/types';

import type { PagedChannels } from '../hooks/usePagedChannels';

export type GuideView = { kind: 'favorites' } | { kind: 'list'; id: string };

/** The `view` URL value of a view. */
export function guideViewParam(view: GuideView): string {
  return view.kind === 'favorites' ? 'favorites' : `list:${view.id}`;
}

/** The view a `view` URL value names; undefined for none or an unknown value. */
export function parseGuideView(raw: string | null | undefined): GuideView | undefined {
  if (raw === 'favorites') return { kind: 'favorites' };
  if (raw?.startsWith('list:') && raw.length > 5) return { kind: 'list', id: raw.slice(5) };
  return undefined;
}

/** Rows fetched beyond the visible ones, so a short scroll finds its favorites drawn. */
const AROUND = 20;
const CHANNEL_STALE_MS = 5 * 60_000;
const NO_FAVORITES: FavoriteEntry[] = [];

/** A favorite the catalog does not answer for: its stored name and logo still fill the row. */
function snapshotChannel(e: FavoriteEntry): Channel {
  return { ref: e.ref, name: e.snapshot.title, logoUrl: e.snapshot.posterUrl, categoryId: '', categoryName: e.snapshot.subtitle ?? '', isRadio: false };
}

/**
 * The channels of `view` for the source `sourceId`, as `PagedChannels`; null without a view.
 * A list loads whole (`lists.items`, at most 2000 entries, its channels included). Favorites come
 * as refs (`favorites.list`), and the rows on screen ask for their channels in one `catalog.items`
 * call (lib/itemBatch.ts).
 * Only live channels: the guide has no radio rows.
 */
export function useGuideViewChannels(view: GuideView | undefined, sourceId: string): PagedChannels | null {
  const queryClient = useQueryClient();
  const listId = view?.kind === 'list' ? view.id : '';
  const favoritesOn = view?.kind === 'favorites' && !!sourceId;
  const list = useRpcQuery('lists.items', { id: listId }, { enabled: !!listId, staleTime: 60_000 });
  const favs = useRpcQuery('favorites.list', liveFavoritesArgs(sourceId), { enabled: favoritesOn });

  const listChannels = useMemo(
    () =>
      (listId ? (list.data ?? []) : []).flatMap((e) =>
        e.available && e.channel && e.ref.sourceId === sourceId && e.ref.contentType === 'live' ? [e.channel] : [],
      ),
    [listId, list.data, sourceId],
  );
  const favorites = useMemo(
    () =>
      favoritesOn
        ? [...(favs.data ?? NO_FAVORITES)]
            .filter((e) => e.ref.contentType === 'live')
            .sort((a, b) => a.position - b.position || a.addedAt.localeCompare(b.addedAt))
        : NO_FAVORITES,
    [favoritesOn, favs.data],
  );

  const [range, setRange] = useState({ start: 0, end: 0 });
  const setVisibleRange = useCallback((start: number, end: number) => {
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
  }, []);
  const nearFrom = Math.max(0, range.start - AROUND);
  const near = favorites.slice(nearFrom, range.end + AROUND + 1);
  // One `catalog.items` call for the rows asked for together, each under its own `catalog.item` key.
  const items = useQueries({ queries: near.map((e) => batchedItemQuery(e.ref, CHANNEL_STALE_MS)) });
  // A new function whenever a favorite's channel arrives, so the rows read it.
  const stamp = items.map((q) => `${q.dataUpdatedAt}:${q.errorUpdatedAt}`).join(',');
  const favoriteChannel = useCallback(
    (index: number): Channel | undefined => {
      const e = favorites[index];
      if (!e) return undefined;
      const state = queryClient.getQueryState<RpcResult<'catalog.item'>>(rpcKey('catalog.item', { ref: e.ref }));
      if (state?.data && 'isRadio' in state.data) return state.data;
      return state?.status === 'error' ? snapshotChannel(e) : undefined;
    },
    [favorites, queryClient, stamp], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const listChannel = useCallback((index: number): Channel | undefined => listChannels[index], [listChannels]);
  // Every entry's ref is known without its channel: the guide finds a favorite's row (a focus link,
  // a typed number, Go to playing) even when it is far from the rows on screen.
  const listIndexOf = useCallback(
    (ref: ItemRef) => {
      const i = listChannels.findIndex((c) => sameRef(c.ref, ref));
      return i < 0 ? undefined : i;
    },
    [listChannels],
  );
  const listRefAt = useCallback((index: number) => listChannels[index]?.ref, [listChannels]);
  const favoriteRefAt = useCallback((index: number) => favorites[index]?.ref, [favorites]);
  const favoriteIndexOf = useCallback(
    (ref: ItemRef) => {
      const i = favorites.findIndex((e) => sameRef(e.ref, ref));
      return i < 0 ? undefined : i;
    },
    [favorites],
  );

  // The query fields the view reads, not the results themselves: useQuery returns a new tracking
  // object on every render, so depending on it rebuilt the view (and walked every favorite, a
  // query-cache hash each) on every guide render, 1 ms at 1,000 favorites (F3-4).
  const isList = view?.kind === 'list';
  const q = isList ? list : favs;
  const { data, isLoading, error, refetch } = q;
  return useMemo(() => {
    if (!view) return null;
    const total = isList ? listChannels.length : favorites.length;
    const getChannel = isList ? listChannel : favoriteChannel;
    // Favorites have channels only near the rows on screen, as on Live (useLiveViewChannels): the
    // callers that need a far row (a reveal, Go to playing) fall back to `indexOf`.
    const loaded: { index: number; channel: Channel }[] = [];
    const [from, to] = isList ? [0, total] : [nearFrom, nearFrom + near.length];
    for (let i = from; i < to; i++) {
      const channel = getChannel(i);
      if (channel) loaded.push({ index: i, channel });
    }
    return {
      total: data ? total : undefined,
      getChannel,
      getNowNext: () => undefined,
      isFavorite: () => false,
      setVisibleRange,
      isLoading,
      refreshing: false,
      error,
      retry: () => void refetch(),
      loaded,
      indexOf: isList ? listIndexOf : favoriteIndexOf,
      refAt: isList ? listRefAt : favoriteRefAt,
      pageSize: total,
      guideUnavailable: false,
      retryGuide: () => undefined,
    };
    // `near` follows `favorites` and the range.
  }, [view?.kind, data, isLoading, error, refetch, listChannels, favorites, nearFrom, near.length, listChannel, favoriteChannel, listIndexOf, favoriteIndexOf, listRefAt, favoriteRefAt, setVisibleRange]); // eslint-disable-line react-hooks/exhaustive-deps
}
