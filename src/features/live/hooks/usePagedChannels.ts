import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { invalidate, useRpcQuery } from '@/api/query';
import { itemKey, type Channel, type EpgNowNext, type ItemKey, type ItemRef, type Page } from '@/api/types';

import { nowNextFrom, preferNowNext } from '../lib/epgMerge';
import { MINUTE } from '../lib/epgTime';
import { useStalkerPreviews } from './useStalkerPreviews';

export const CHANNEL_PAGE_SIZE = 120;

export interface PagedChannelsArgs {
  sourceId: string;
  categoryId?: string;
  search?: string;
  radio?: boolean;
  /** Also fetch EPG now/next and favorite flags for loaded pages. */
  withExtras?: boolean;
  pageSize?: number;
  now?: number;
  /**
   * The source is a Stalker portal: visible rows also ask the portal's own guide
   * (`stalker.epg`, throttled) and show it where XMLTV has nothing airing.
   */
  stalkerEpg?: boolean;
  /**
   * `settings.epgOffsetMinutes`: rows show programmes moved by it, so "now" is picked on the
   * shifted clock (`epg.nowNext` `offsetMinutes`, and the portal previews at `now - offset`).
   */
  epgOffsetMinutes?: number;
}

export interface PagedChannels {
  /** undefined until the first page of the current list arrives */
  total: number | undefined;
  getChannel(index: number): Channel | undefined;
  getNowNext(index: number): EpgNowNext | undefined;
  isFavorite(index: number): boolean;
  /** Report the rendered index range; at most two pages are requested at once. */
  setVisibleRange(start: number, end: number): void;
  isLoading: boolean;
  error: unknown;
  retry(): void;
  /** Channels currently held in memory, in index order. */
  loaded: { index: number; channel: Channel }[];
  pageSize: number;
  /** Stalker: the portal's guide is not answering (timeout / network); previews are backing off. */
  guideUnavailable: boolean;
  /** Stalker: ask the portal's guide again now. */
  retryGuide(): void;
}

function inPage(page: Page<Channel> | undefined, index: number): Channel | undefined {
  if (!page) return undefined;
  const i = index - page.offset;
  return i >= 0 && i < page.items.length ? page.items[i] : undefined;
}

function usePageExtras(page: Page<Channel> | undefined, enabled: boolean, offsetMinutes: number) {
  const refs = useMemo(() => page?.items.map((c) => c.ref) ?? [], [page]);
  const has = enabled && refs.length > 0;
  const nowNext = useRpcQuery('epg.nowNext', offsetMinutes ? { refs, offsetMinutes } : { refs }, { enabled: has, staleTime: 60_000 });
  const favs = useRpcQuery('favorites.contains', { refs }, { enabled: has });
  const favSet = useMemo(() => new Set<ItemKey>((favs.data ?? []).map(itemKey)), [favs.data]);
  return { nowNext: nowNext.data, favSet };
}

/**
 * Pages a channel list out of SQLite. The view virtualizes `total` rows and reports its
 * visible range; only the one or two pages that cover it are queried (C1 `useRpcQuery`
 * with offset paging), so memory never holds more than two pages of a 50k list.
 */
export function usePagedChannels(args: PagedChannelsArgs): PagedChannels {
  const size = args.pageSize ?? CHANNEL_PAGE_SIZE;
  const listKey = `${args.sourceId}|${args.categoryId ?? ''}|${args.search ?? ''}|${args.radio ? 'r' : 'l'}`;
  const [pages, setPages] = useState<{ key: string; a: number; b: number }>({ key: listKey, a: 0, b: 0 });
  const [range, setRange] = useState<{ key: string; start: number; end: number }>({ key: listKey, start: 0, end: 0 });
  const { a, b } = pages.key === listKey ? pages : { a: 0, b: 0 };

  const query = (page: number) => ({
    sourceId: args.sourceId,
    categoryId: args.categoryId,
    radio: args.radio || undefined,
    query: { offset: page * size, limit: size, search: args.search || undefined },
  });
  const qa = useRpcQuery('catalog.channels', query(a), { enabled: !!args.sourceId });
  const qb = useRpcQuery('catalog.channels', query(b), { enabled: !!args.sourceId && b !== a });
  const pageA = qa.data;
  const pageB = b !== a ? qb.data : undefined;

  // Remember the total per list so the scroll height survives page switches.
  const totals = useRef(new Map<string, number>());
  const freshTotal = pageA?.total ?? pageB?.total;
  if (freshTotal !== undefined) totals.current.set(listKey, freshTotal);
  const total = freshTotal ?? totals.current.get(listKey);

  const extrasOn = args.withExtras ?? true;
  const offsetMs = (args.epgOffsetMinutes ?? 0) * MINUTE;
  const exA = usePageExtras(pageA, extrasOn, args.epgOffsetMinutes ?? 0);
  const exB = usePageExtras(pageB, extrasOn, args.epgOffsetMinutes ?? 0);

  // Stalker: the portal's guide for the visible rows (the XMLTV now/next above covers the rest).
  const stalkerOn = extrasOn && !!args.stalkerEpg;
  const visibleRefs = useMemo(() => {
    if (!stalkerOn || range.key !== listKey) return [] as ItemRef[];
    const out: ItemRef[] = [];
    for (let i = range.start; i <= range.end; i++) {
      const ch = inPage(pageA, i) ?? inPage(pageB, i);
      if (ch) out.push(ch.ref);
    }
    return out;
  }, [stalkerOn, range, listKey, pageA, pageB]);
  const portalPrograms = useStalkerPreviews(args.sourceId, stalkerOn, visibleRefs, args.now ?? 0);

  const setVisibleRange = useCallback(
    (start: number, end: number) => {
      const na = Math.max(0, Math.floor(start / size));
      const nb = Math.max(na, Math.floor(Math.max(start, end) / size));
      setPages((p) => (p.key === listKey && p.a === na && p.b === nb ? p : { key: listKey, a: na, b: nb }));
      if (stalkerOn) setRange((r) => (r.key === listKey && r.start === start && r.end === end ? r : { key: listKey, start, end }));
    },
    [listKey, size, stalkerOn],
  );

  const getChannel = useCallback((i: number) => inPage(pageA, i) ?? inPage(pageB, i), [pageA, pageB]);
  const nowForPreviews = args.now;
  const getNowNext = useCallback(
    (i: number) => {
      const fromA = inPage(pageA, i);
      const ch = fromA ?? inPage(pageB, i);
      if (!ch) return undefined;
      const xmltv = (fromA ? exA.nowNext : exB.nowNext)?.[itemKey(ch.ref)];
      if (!stalkerOn) return xmltv;
      // Programmes come back unshifted: the one shown as airing is the one airing at `now - offset`.
      return preferNowNext(nowNextFrom(portalPrograms.get(ch.ref), (nowForPreviews ?? Date.now()) - offsetMs), xmltv);
    },
    [pageA, pageB, exA.nowNext, exB.nowNext, stalkerOn, portalPrograms, nowForPreviews, offsetMs],
  );
  const isFavorite = useCallback(
    (i: number) => {
      const fromA = inPage(pageA, i);
      if (fromA) return exA.favSet.has(itemKey(fromA.ref));
      const fromB = inPage(pageB, i);
      return fromB ? exB.favSet.has(itemKey(fromB.ref)) : false;
    },
    [pageA, pageB, exA.favSet, exB.favSet],
  );

  // Refresh now/next once the airing programme of any loaded channel has ended.
  const now = args.now;
  useEffect(() => {
    if (now === undefined) return;
    const maps = [exA.nowNext, exB.nowNext];
    const stale = maps.some((m) => m && Object.values(m).some((nn) => nn.now && Date.parse(nn.now.end) <= now - offsetMs));
    if (stale) void invalidate('epg.nowNext');
  }, [now, offsetMs, exA.nowNext, exB.nowNext]);

  const loaded = useMemo(() => {
    const out: { index: number; channel: Channel }[] = [];
    for (const p of [pageA, pageB]) p?.items.forEach((channel, i) => out.push({ index: p.offset + i, channel }));
    return out.sort((x, y) => x.index - y.index);
  }, [pageA, pageB]);

  const error = qa.error ?? (b !== a ? qb.error : null);
  return {
    total,
    getChannel,
    getNowNext,
    isFavorite,
    setVisibleRange,
    isLoading: total === undefined && !error,
    error,
    retry: () => {
      void qa.refetch();
      if (b !== a) void qb.refetch();
    },
    loaded,
    pageSize: size,
    guideUnavailable: portalPrograms.unavailable,
    retryGuide: portalPrograms.retry,
  };
}
