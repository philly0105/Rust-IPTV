/**
 * The guide's views besides a group (IPTVnator parity): the source's favorite channels, in
 * favorites order, a custom list's channels of the source, in list order, or the source's
 * channels that have guide data. The URL names the view (`view=favorites`, `view=list:<id>`,
 * `view=withGuide`); the grid reads it through the same `PagedChannels` shape as a source's paged
 * channel list.
 */

import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { liveFavoritesArgs } from '@/api/bootPrefetch';
import { batchedItemQuery, rpcKey, useRpcQuery } from '@/api/query';
import { rpc, type RpcResult } from '@/api/transport';
import { itemKey, sameRef, type Channel, type FavoriteEntry, type ItemRef } from '@/api/types';

import type { PagedChannels } from '../hooks/usePagedChannels';
import { HOUR, MINUTE } from '../lib/epgTime';

export type GuideView = { kind: 'favorites' } | { kind: 'list'; id: string } | { kind: 'withGuide' };

/** The `view` URL value of a view. */
export function guideViewParam(view: GuideView): string {
  return view.kind === 'list' ? `list:${view.id}` : view.kind;
}

/** The view a `view` URL value names; undefined for none or an unknown value. */
export function parseGuideView(raw: string | null | undefined): GuideView | undefined {
  if (raw === 'favorites') return { kind: 'favorites' };
  if (raw === 'withGuide') return { kind: 'withGuide' };
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

/** Channels read per step of the guide-data scan: one `catalog.channels` page and one `epg.grid`. */
export const GUIDE_SCAN_PAGE = 200;
/** The scan stops once it has found this many rows past the last one on screen. */
export const GUIDE_SCAN_AHEAD = 40;

interface GuideScan {
  key: string;
  /** The span asked about, fixed when the view opens: scrolling sideways does not start over. */
  from: string;
  to: string;
  found: Channel[];
  /** Channels of the source read so far. */
  offset: number;
  done: boolean;
  error: unknown;
}

function newScan(key: string, offsetMinutes: number): GuideScan {
  const at = Date.now() - offsetMinutes * MINUTE;
  return { key, from: new Date(at - 2 * HOUR).toISOString(), to: new Date(at + 10 * HOUR).toISOString(), found: [], offset: 0, done: false, error: null };
}

/**
 * The source's channels that have programmes in the 12 hours from two hours before the view
 * opened, in channel order. The frontend cannot ask the core for "channels with a guide" (a
 * patchy guide covers a fifth of a 30,000-channel source), so it reads the channel list a page
 * at a time and asks `epg.grid` (no descriptions, a 12-hour span) which of them have programmes.
 * It reads only as far as the rows on screen need (`GUIDE_SCAN_AHEAD` past the last), and the
 * rows it finds are appended, never inserted: the virtualised grid only grows at its end, so
 * nothing on screen moves. While more channels remain, one extra row past the last found one is
 * a loading row, and scrolling to it reads on.
 */
function useGuideScan(enabled: boolean, sourceId: string, offsetMinutes: number, wanted: number) {
  const key = enabled && sourceId ? `${sourceId}|${offsetMinutes}` : '';
  const [scan, setScan] = useState<GuideScan>(() => newScan(key, offsetMinutes));
  const current = scan.key === key ? scan : newScan(key, offsetMinutes);
  if (current !== scan) setScan(current);
  const need = !!key && !current.done && !current.error && current.found.length < wanted;
  const { offset, from, to } = current;
  useEffect(() => {
    if (!need) return;
    let cancelled = false;
    (async () => {
      const page = await rpc('catalog.channels', { sourceId, query: { offset, limit: GUIDE_SCAN_PAGE } });
      const refs = page.items.map((c) => c.ref);
      const grid = refs.length > 0 ? await rpc('epg.grid', { refs, from, to, withDescription: false }) : {};
      if (cancelled) return;
      const hits = page.items.filter((c) => (grid[itemKey(c.ref)]?.length ?? 0) > 0);
      const read = offset + page.items.length;
      setScan((s) =>
        s.key !== key || s.offset !== offset
          ? s
          : { ...s, found: hits.length > 0 ? [...s.found, ...hits] : s.found, offset: read, done: page.items.length === 0 || read >= page.total },
      );
    })().catch((error: unknown) => {
      if (!cancelled) setScan((s) => (s.key === key ? { ...s, error } : s));
    });
    return () => {
      cancelled = true;
    };
  }, [need, key, offset, sourceId, from, to]);
  const retry = useCallback(() => setScan((s) => (s.key === key ? { ...s, error: null } : s)), [key]);
  return { ...current, retry };
}

/**
 * The channels of `view` for the source `sourceId`, as `PagedChannels`; null without a view.
 * A list loads whole (`lists.items`, at most 2000 entries, its channels included). Favorites come
 * as refs (`favorites.list`), and the rows on screen ask for their channels in one `catalog.items`
 * call (lib/itemBatch.ts). Channels with guide data are found by `useGuideScan`.
 * Only live channels: the guide has no radio rows.
 */
export function useGuideViewChannels(view: GuideView | undefined, sourceId: string, offsetMinutes = 0): PagedChannels | null {
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
  const near = favorites.slice(Math.max(0, range.start - AROUND), range.end + AROUND + 1);
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
  const scanOn = view?.kind === 'withGuide';
  const scan = useGuideScan(scanOn, sourceId, offsetMinutes, scanOn ? range.end + GUIDE_SCAN_AHEAD : 0);
  const scanned = scan.found;
  const scanChannel = useCallback((index: number): Channel | undefined => scanned[index], [scanned]);
  const scanRefAt = useCallback((index: number) => scanned[index]?.ref, [scanned]);
  const scanIndexOf = useCallback(
    (ref: ItemRef) => {
      const i = scanned.findIndex((c) => sameRef(c.ref, ref));
      return i < 0 ? undefined : i;
    },
    [scanned],
  );
  const favoriteRefAt = useCallback((index: number) => favorites[index]?.ref, [favorites]);
  const favoriteIndexOf = useCallback(
    (ref: ItemRef) => {
      const i = favorites.findIndex((e) => sameRef(e.ref, ref));
      return i < 0 ? undefined : i;
    },
    [favorites],
  );

  const scanDone = scan.done;
  const scanError = scan.error;
  const scanRetry = scan.retry;
  return useMemo(() => {
    if (!view) return null;
    if (view.kind === 'withGuide') {
      const started = scanned.length > 0 || scanDone;
      return {
        // One loading row past the last channel found while the scan has more to read.
        total: started ? scanned.length + (scanDone ? 0 : 1) : undefined,
        getChannel: scanChannel,
        getNowNext: () => undefined,
        isFavorite: () => false,
        setVisibleRange,
        isLoading: !started && !scanError,
        refreshing: false,
        error: scanError,
        retry: scanRetry,
        loaded: scanned.map((channel, index) => ({ index, channel })),
        indexOf: scanIndexOf,
        refAt: scanRefAt,
        pageSize: GUIDE_SCAN_PAGE,
        guideUnavailable: false,
        retryGuide: () => undefined,
      };
    }
    const isList = view.kind === 'list';
    const q = isList ? list : favs;
    const total = isList ? listChannels.length : favorites.length;
    const getChannel = isList ? listChannel : favoriteChannel;
    const loaded: { index: number; channel: Channel }[] = [];
    for (let i = 0; i < total; i++) {
      const channel = getChannel(i);
      if (channel) loaded.push({ index: i, channel });
    }
    return {
      total: q.data ? total : undefined,
      getChannel,
      getNowNext: () => undefined,
      isFavorite: () => false,
      setVisibleRange,
      isLoading: q.isLoading,
      refreshing: false,
      error: q.error,
      retry: () => void q.refetch(),
      loaded,
      indexOf: isList ? listIndexOf : favoriteIndexOf,
      refAt: isList ? listRefAt : favoriteRefAt,
      pageSize: total,
      guideUnavailable: false,
      retryGuide: () => undefined,
    };
  }, [view?.kind, list, favs, listChannels, favorites, listChannel, favoriteChannel, listIndexOf, favoriteIndexOf, listRefAt, favoriteRefAt, setVisibleRange,
    scanned, scanDone, scanError, scanRetry, scanChannel, scanIndexOf, scanRefAt]); // eslint-disable-line react-hooks/exhaustive-deps
}
