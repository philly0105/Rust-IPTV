import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CHANNEL_PAGE_SIZE, channelPageArgs, favoritesContainsArgs, nowNextArgs } from '@/api/bootPrefetch';
import { invalidate, rpcKey, useRpcQuery } from '@/api/query';
import { rpcRaw, type RpcArgs } from '@/api/transport';
import { itemKey, sameRef, type Channel, type EpgNowNext, type ItemKey, type ItemRef, type Page } from '@/api/types';

import { nowNextFrom, preferNowNext } from '../lib/epgMerge';
import { MINUTE, ms } from '../lib/epgTime';
import { needsFallback } from '../lib/shortEpg';
import { useShortEpgPreviews } from './useShortEpg';
import { useStalkerPreviews } from './useStalkerPreviews';

// The page args and size, and the now/next and favourite flag args, live with the boot prefetch
// (L3-ui-data-x7), so it asks for the same first page and its extras.
export { CHANNEL_PAGE_SIZE };

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
   * guide: Xtream short-EPG fallback is on for this source: visible rows with nothing airing in
   * XMLTV ask the panel's short EPG (`epg.shortEpg`, throttled) instead.
   */
  shortEpg?: boolean;
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
  /**
   * The previous list's rows are still on screen while the new list (search, category) loads.
   * Lets the view dim them instead of flashing a skeleton on every keystroke.
   */
  refreshing: boolean;
  error: unknown;
  retry(): void;
  /** Channels currently held in memory, in index order. */
  loaded: { index: number; channel: Channel }[];
  pageSize: number;
  /** Stalker: the portal's guide is not answering (timeout / network); previews are backing off. */
  guideUnavailable: boolean;
  /** Stalker: ask the portal's guide again now. */
  retryGuide(): void;
  /**
   * The row index of a channel in this list when it is not loaded (a number typed, a zap from
   * elsewhere): pages are read until it turns up, guided by its channel number. Undefined when
   * it cannot be found in a few reads.
   */
  locate?(ref: ItemRef, number: number | undefined): Promise<number | undefined>;
  /**
   * The row index of a channel in a list whose every entry is known up front (the guide's
   * favorites and custom list views), whether or not its row is loaded; undefined when it is not
   * in the list. `loaded` holds only the favorites near the rows on screen.
   */
  indexOf?(ref: ItemRef): number | undefined;
  /**
   * The ref of the row at `index` in such a list, before its channel has arrived: the guide asks
   * a chunk's programmes once, with every ref, instead of again as each batch of channels lands.
   */
  refAt?(index: number): ItemRef | undefined;
}

type ChannelsArgs = RpcArgs<'catalog.channels'>;

/**
 * One page of `catalog.channels` under the same key `useRpcQuery` uses. Pages are replaced whole
 * and never patched, so structural sharing (a deep compare of 120 channels on every refetch and
 * remount, 10-15 ms per return to Live on a big list) buys nothing.
 */
function channelPageOptions(args: ChannelsArgs) {
  return {
    queryKey: rpcKey('catalog.channels', args),
    queryFn: async ({ signal }: { signal: AbortSignal }) => (await rpcRaw('catalog.channels', args, { signal })) as Page<Channel>,
    structuralSharing: false,
  };
}

/** How many pages to read at most while looking for an unloaded channel's row. */
const LOCATE_MAX_READS = 12;

function inPage(page: Page<Channel> | undefined, index: number): Channel | undefined {
  if (!page) return undefined;
  const i = index - page.offset;
  return i >= 0 && i < page.items.length ? page.items[i] : undefined;
}

function usePageExtras(page: Page<Channel> | undefined, enabled: boolean, offsetMinutes: number) {
  const refs = useMemo(() => page?.items.map((c) => c.ref) ?? [], [page]);
  const has = enabled && refs.length > 0;
  const nowNext = useRpcQuery('epg.nowNext', nowNextArgs(refs, offsetMinutes), { enabled: has, staleTime: NOW_NEXT_STALE_MS });
  const favs = useRpcQuery('favorites.contains', favoritesContainsArgs(refs), { enabled: has });
  const favSet = useMemo(() => new Set<ItemKey>((favs.data ?? []).map(itemKey)), [favs.data]);
  return { nowNext: nowNext.data, favSet };
}

const NOW_NEXT_STALE_MS = 60_000;

/** How long the visible range must hold still before the portal guide is asked for it. */
export const STALKER_RANGE_SETTLE_MS = 150;

/**
 * How long the range must rest before the list switches to pages it has not read (LV-1). A
 * scrollbar drag reports a new range every frame; switching on each would send a deep page read
 * per frame, and the page the user stops on would queue behind all of them.
 */
export const PAGE_SETTLE_MS = 110;

/** Read-ahead pages further than this from the visible pages are cancelled while still in flight. */
const PREFETCH_KEEP_PAGES = 2;

/**
 * Pages a channel list out of SQLite. The view virtualizes `total` rows and reports its
 * visible range; only the one or two pages that cover it are queried (C1 `useRpcQuery`
 * with offset paging), so memory never holds more than two pages of a 50k list.
 */
export function usePagedChannels(args: PagedChannelsArgs): PagedChannels {
  const size = args.pageSize ?? CHANNEL_PAGE_SIZE;
  const queryClient = useQueryClient();
  const listKey = `${args.sourceId}|${args.categoryId ?? ''}|${args.search ?? ''}|${args.radio ? 'r' : 'l'}`;
  const [pages, setPages] = useState<{ key: string; a: number; b: number }>({ key: listKey, a: 0, b: 0 });
  const [range, setRange] = useState<{ key: string; start: number; end: number }>({ key: listKey, start: 0, end: 0 });
  const { a, b } = pages.key === listKey ? pages : { a: 0, b: 0 };

  const query = useCallback(
    (page: number): ChannelsArgs =>
      channelPageArgs({ sourceId: args.sourceId, categoryId: args.categoryId, radio: args.radio, search: args.search }, page, size),
    [args.sourceId, args.categoryId, args.radio, args.search, size],
  );
  // keepPrevious: a new search or group keeps the old rows up until its first page lands.
  const qa = useQuery({ ...channelPageOptions(query(a)), enabled: !!args.sourceId, placeholderData: keepPreviousData });
  const qb = useQuery({ ...channelPageOptions(query(b)), enabled: !!args.sourceId && b !== a });
  const pageA = qa.data;
  const pageB = b !== a ? qb.data : undefined;

  // Remember the total per list so the scroll height survives page switches.
  const totals = useRef(new Map<string, number>());
  // Placeholder data from another list must not be recorded as this list's total.
  const realDataKey = useRef<string | undefined>(undefined);
  if (qa.data && !qa.isPlaceholderData) realDataKey.current = listKey;
  const placeholderFromOtherList = qa.isPlaceholderData && !!pageA && realDataKey.current !== listKey;
  const freshTotal = pageA?.total ?? pageB?.total;
  if (freshTotal !== undefined && !placeholderFromOtherList) totals.current.set(listKey, freshTotal);
  const total = placeholderFromOtherList ? freshTotal : (freshTotal ?? totals.current.get(listKey));
  const totalRef = useRef(total);
  totalRef.current = placeholderFromOtherList ? undefined : total;

  const extrasOn = args.withExtras ?? true;
  const offsetMs = (args.epgOffsetMinutes ?? 0) * MINUTE;
  const exA = usePageExtras(pageA, extrasOn, args.epgOffsetMinutes ?? 0);
  const exB = usePageExtras(pageB, extrasOn, args.epgOffsetMinutes ?? 0);

  // Stalker: the portal's guide for the visible rows (the XMLTV now/next above covers the rest).
  const stalkerOn = extrasOn && !!args.stalkerEpg;
  const shortOn = extrasOn && !!args.shortEpg && !stalkerOn;
  const previewOn = stalkerOn || shortOn;
  const visibleRefs = useMemo(() => {
    if (!previewOn || range.key !== listKey) return [] as ItemRef[];
    const out: ItemRef[] = [];
    for (let i = range.start; i <= range.end; i++) {
      const fromA = inPage(pageA, i);
      const ch = fromA ?? inPage(pageB, i);
      if (!ch) continue;
      if (shortOn) {
        // Only rows whose XMLTV answer arrived without anything airing need the panel.
        const map = fromA ? exA.nowNext : exB.nowNext;
        if (!map || !needsFallback(map[itemKey(ch.ref)])) continue;
      }
      out.push(ch.ref);
    }
    return out;
  }, [previewOn, shortOn, range, listKey, pageA, pageB, exA.nowNext, exB.nowNext]);
  const portalPrograms = useStalkerPreviews(args.sourceId, stalkerOn, visibleRefs, args.now ?? 0);
  const shortPrograms = useShortEpgPreviews(args.sourceId, shortOn, visibleRefs, args.now ?? 0);

  // Pages ahead of a scroll are read before the rows reach the screen, so a brisk scroll lands on
  // rows that are already there (L2-live-4). Their now/next and favourite flags follow once the
  // rows are on screen (usePageExtras), not for every page read ahead (LV-1).
  const prefetched = useRef<{ key: string; pages: Set<number> }>({ key: '', pages: new Set() });
  const prefetchPage = useCallback(
    (page: number) => {
      const known = totalRef.current;
      if (page < 0 || known === undefined || page * size >= known || !args.sourceId) return;
      if (prefetched.current.key !== listKey) prefetched.current = { key: listKey, pages: new Set() };
      prefetched.current.pages.add(page);
      void queryClient.prefetchQuery(channelPageOptions(query(page)));
    },
    [queryClient, query, size, args.sourceId, listKey],
  );
  // Read-ahead that the range has left behind (more than two pages away) is cancelled while it
  // waits, so the pages the user stops on do not queue behind it.
  const dropFarPrefetches = useCallback(
    (na: number, nb: number) => {
      if (prefetched.current.key !== listKey) return;
      for (const page of prefetched.current.pages) {
        if (page >= na - PREFETCH_KEEP_PAGES && page <= nb + PREFETCH_KEEP_PAGES) continue;
        prefetched.current.pages.delete(page);
        const cached = queryClient.getQueryCache().find({ queryKey: rpcKey('catalog.channels', query(page)), exact: true });
        if (cached && cached.state.fetchStatus === 'fetching' && cached.getObserversCount() === 0) void cached.cancel();
      }
    },
    [queryClient, query, listKey],
  );

  // The pages on screen, for the range reports below (a and b of this list, or page 0 of a new one).
  const observed = useRef({ key: listKey, a, b });
  observed.current = { key: listKey, a, b };
  /** Page `page` is on screen already, cached, or on its way: switching to it sends nothing new. */
  const pageKnown = useCallback(
    (page: number) => {
      const o = observed.current;
      if (o.key === listKey && (o.a === page || o.b === page)) return true;
      const state = queryClient.getQueryState(rpcKey('catalog.channels', query(page)));
      return state?.data !== undefined || state?.fetchStatus === 'fetching';
    },
    [queryClient, query, listKey],
  );

  const rangeTimer = useRef<number | undefined>(undefined);
  const settleTimer = useRef<number | undefined>(undefined);
  const settlePages = useRef<() => void>(() => undefined);
  const lastRange = useRef<{ key: string; start: number }>({ key: '', start: 0 });
  useEffect(
    () => () => {
      window.clearTimeout(rangeTimer.current);
      window.clearTimeout(settleTimer.current);
    },
    [],
  );
  const setVisibleRange = useCallback(
    (start: number, end: number) => {
      const na = Math.max(0, Math.floor(start / size));
      const nb = Math.max(na, Math.floor(Math.max(start, end) / size));
      const showPages = () => {
        // A timer from a list the user has left since must not switch the new list's pages.
        if (lastRange.current.key !== listKey) return;
        setPages((p) => (p.key === listKey && p.a === na && p.b === nb ? p : { key: listKey, a: na, b: nb }));
      };
      const prev = lastRange.current;
      lastRange.current = { key: listKey, start };
      const step = prev.key === listKey ? start - prev.start : 0;
      dropFarPrefetches(na, nb);
      // LV-1: a range that jumps more than a page (a scrollbar drag, a fling) switches pages only
      // once it has rested PAGE_SETTLE_MS, and reads nothing ahead meanwhile. A smaller step onto
      // pages not read yet waits for the same timer without restarting it, so a slow drag reads
      // at most one page pair per PAGE_SETTLE_MS. A scroll onto known pages switches at once.
      const jump = Math.abs(step) > size;
      if (jump || !pageKnown(na) || !pageKnown(nb)) {
        settlePages.current = showPages;
        if (jump || settleTimer.current === undefined) {
          window.clearTimeout(settleTimer.current);
          settleTimer.current = window.setTimeout(() => {
            settleTimer.current = undefined;
            settlePages.current();
          }, PAGE_SETTLE_MS);
        }
      } else {
        window.clearTimeout(settleTimer.current);
        settleTimer.current = undefined;
        showPages();
        // Read ahead in the direction of travel once the range is within half a page of the next
        // page, and two pages ahead while moving fast (more than a few rows per report).
        const fast = Math.abs(step) > 4;
        if (step > 0 && (Math.max(start, end) % size >= size / 2 || fast)) {
          prefetchPage(nb + 1);
          if (fast) prefetchPage(nb + 2);
        } else if (step < 0 && (start % size < size / 2 || fast)) {
          prefetchPage(na - 1);
          if (fast) prefetchPage(na - 2);
        }
      }
      if (!previewOn) return;
      // The portal guide follows the visible rows once scrolling pauses: a range update per row of
      // a held arrow key would queue a render of the page behind every keystroke (React #185).
      window.clearTimeout(rangeTimer.current);
      rangeTimer.current = window.setTimeout(
        () => setRange((r) => (r.key === listKey && r.start === start && r.end === end ? r : { key: listKey, start, end })),
        STALKER_RANGE_SETTLE_MS,
      );
    },
    [listKey, size, previewOn, prefetchPage, dropFarPrefetches, pageKnown],
  );

  // Rows outside pages a and b come from any page of this list already in the cache (read
  // ahead, or seen before), so a page switch never blanks rows that are known.
  const getChannel = useCallback(
    (i: number) => {
      const hit = inPage(pageA, i) ?? inPage(pageB, i);
      if (hit || placeholderFromOtherList || i < 0) return hit;
      return inPage(queryClient.getQueryData<Page<Channel>>(rpcKey('catalog.channels', query(Math.floor(i / size)))), i);
    },
    [queryClient, pageA, pageB, placeholderFromOtherList, query, size],
  );

  const locate = useCallback(
    async (ref: ItemRef, number: number | undefined): Promise<number | undefined> => {
      const known = totalRef.current;
      if (!known || number === undefined || !args.sourceId) return undefined;
      // Rows run in playlist order, which providers number upwards: start at number - 1 (exact
      // for a densely numbered list), then narrow by the numbers each page holds.
      let lo = 0;
      let hi = Math.ceil(known / size) - 1;
      let page = Math.min(hi, Math.max(0, Math.floor((number - 1) / size)));
      for (let read = 0; read < LOCATE_MAX_READS && lo <= hi; read++) {
        const data = await queryClient.fetchQuery(channelPageOptions(query(page)));
        const at = data.items.findIndex((c) => sameRef(c.ref, ref));
        if (at >= 0) return data.offset + at;
        const nums = data.items.map((c) => c.number).filter((n): n is number => typeof n === 'number');
        const first = nums[0];
        const last = nums[nums.length - 1];
        if (first === undefined || last === undefined) return undefined;
        let guess: number;
        if (number < first) {
          hi = page - 1;
          guess = page - Math.ceil((first - number) / size);
        } else if (number > last) {
          lo = page + 1;
          guess = page + Math.ceil((number - last) / size);
        } else {
          return undefined; // its number falls inside this page, yet it is not here: numbers are not in order
        }
        page = read < 2 ? Math.min(hi, Math.max(lo, guess)) : Math.floor((lo + hi) / 2);
      }
      return undefined;
    },
    [queryClient, args.sourceId, query, size],
  );
  const nowForPreviews = args.now;
  const getNowNext = useCallback(
    (i: number) => {
      const fromA = inPage(pageA, i);
      const ch = fromA ?? inPage(pageB, i);
      if (!ch) return undefined;
      const xmltv = (fromA ? exA.nowNext : exB.nowNext)?.[itemKey(ch.ref)];
      if (shortOn) return preferNowNext(xmltv, nowNextFrom(shortPrograms(ch.ref), (nowForPreviews ?? Date.now()) - offsetMs));
      if (!stalkerOn) return xmltv;
      // Programmes come back unshifted: the one shown as airing is the one airing at `now - offset`.
      return preferNowNext(nowNextFrom(portalPrograms.get(ch.ref), (nowForPreviews ?? Date.now()) - offsetMs), xmltv);
    },
    [pageA, pageB, exA.nowNext, exB.nowNext, stalkerOn, shortOn, portalPrograms, shortPrograms, nowForPreviews, offsetMs],
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

  // Refresh now/next once the airing programme of any loaded channel has ended, or once the
  // programme after a gap (nothing airing, only `next`) has started.
  const now = args.now;
  const refreshedAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (now === undefined) return;
    const maps = [exA.nowNext, exB.nowNext];
    const guideNow = now - offsetMs;
    const changed = (nn: EpgNowNext) =>
      nn.now ? ms(nn.now.end) > 0 && ms(nn.now.end) <= guideNow : !!nn.next && ms(nn.next.start) > 0 && ms(nn.next.start) <= guideNow;
    const stale = maps.some((m) => m && Object.values(m).some(changed));
    // Once per clock tick: a core whose clock lags ours keeps answering with the "stale" pair,
    // and asking again on every answer would spin.
    if (stale && refreshedAt.current !== now) {
      refreshedAt.current = now;
      void invalidate('epg.nowNext');
    }
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
    refreshing: placeholderFromOtherList && !error,
    error,
    retry: () => {
      void qa.refetch();
      if (b !== a) void qb.refetch();
    },
    loaded,
    pageSize: size,
    guideUnavailable: portalPrograms.unavailable,
    retryGuide: portalPrograms.retry,
    locate,
  };
}
