/**
 * `useListChannels(listId)`: a custom list as `PagedChannels`, so the Live
 * `ChannelList` renders it unchanged.
 *
 * A list holds at most 2000 channels, so `lists.items` loads it whole. The
 * extras (now/next and favorite flags) follow the visible rows the way
 * `usePagedChannels` does: the rows are cut into fixed chunks of
 * `CHANNEL_PAGE_SIZE` and only the one or two chunks on screen are asked
 * about, with stable query keys while scrolling within a chunk.
 *
 * Channels the provider dropped (`available: false`) are not rows of the
 * list; they come back separately in `unavailable` for the page to offer a
 * Remove.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { invalidate, useRpcQuery } from '@/api/query';
import { itemKey, type Channel, type CustomListEntry, type EpgNowNext, type ItemKey } from '@/api/types';

import { CHANNEL_PAGE_SIZE, type PagedChannels } from '../deps';

export interface ListChannels extends PagedChannels {
  /** Every entry in the user's order, available or not; undefined until loaded. */
  entries: CustomListEntry[] | undefined;
  /** Entries whose channel the provider no longer offers. */
  unavailable: CustomListEntry[];
  /** The rows: available channels in list order. */
  channels: Channel[];
}

export interface ListChannelsOptions {
  /** The page clock (`useNow`): now/next refreshes once the airing programme ends. */
  now?: number;
  /** `settings.epgOffsetMinutes`. */
  epgOffsetMinutes?: number;
  pageSize?: number;
}

const NO_ENTRIES: CustomListEntry[] = [];
const MINUTE = 60_000;
const ms = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0);

function useChunkExtras(refs: Channel['ref'][], offsetMinutes: number) {
  const has = refs.length > 0;
  const nowNext = useRpcQuery('epg.nowNext', offsetMinutes ? { refs, offsetMinutes } : { refs }, { enabled: has, staleTime: 60_000 });
  const favs = useRpcQuery('favorites.contains', { refs }, { enabled: has });
  const favSet = useMemo(() => new Set<ItemKey>((favs.data ?? []).map(itemKey)), [favs.data]);
  return { nowNext: nowNext.data, favSet };
}

export function useListChannels(listId: string, opts: ListChannelsOptions = {}): ListChannels {
  const size = opts.pageSize ?? CHANNEL_PAGE_SIZE;
  const offsetMinutes = opts.epgOffsetMinutes ?? 0;
  // keepPrevious: switching lists keeps the old rows up (dimmed) until the new list lands.
  const items = useRpcQuery('lists.items', { id: listId }, { enabled: !!listId, staleTime: 60_000, keepPrevious: true });
  const entries = listId ? items.data : undefined;
  const refreshing = !!listId && items.isPlaceholderData && !items.error;

  const channels = useMemo(() => (entries ?? NO_ENTRIES).flatMap((e) => (e.available && e.channel ? [e.channel] : [])), [entries]);
  const unavailable = useMemo(() => (entries ?? NO_ENTRIES).filter((e) => !e.available || !e.channel), [entries]);

  const [chunks, setChunks] = useState<{ key: string; a: number; b: number }>({ key: listId, a: 0, b: 0 });
  const { a, b } = chunks.key === listId ? chunks : { a: 0, b: 0 };
  const refsA = useMemo(() => channels.slice(a * size, (a + 1) * size).map((c) => c.ref), [channels, a, size]);
  const refsB = useMemo(() => (b !== a ? channels.slice(b * size, (b + 1) * size).map((c) => c.ref) : []), [channels, a, b, size]);
  const exA = useChunkExtras(refsA, offsetMinutes);
  const exB = useChunkExtras(refsB, offsetMinutes);

  const setVisibleRange = useCallback(
    (start: number, end: number) => {
      const na = Math.max(0, Math.floor(start / size));
      const nb = Math.max(na, Math.floor(Math.max(start, end) / size));
      setChunks((c) => (c.key === listId && c.a === na && c.b === nb ? c : { key: listId, a: na, b: nb }));
    },
    [listId, size],
  );

  const getChannel = useCallback((i: number) => channels[i], [channels]);
  const getNowNext = useCallback(
    (i: number): EpgNowNext | undefined => {
      const ch = channels[i];
      if (!ch) return undefined;
      const key = itemKey(ch.ref);
      return exA.nowNext?.[key] ?? exB.nowNext?.[key];
    },
    [channels, exA.nowNext, exB.nowNext],
  );
  const isFavorite = useCallback(
    (i: number) => {
      const ch = channels[i];
      if (!ch) return false;
      const key = itemKey(ch.ref);
      return exA.favSet.has(key) || exB.favSet.has(key);
    },
    [channels, exA.favSet, exB.favSet],
  );

  // Refresh now/next once an airing programme has ended (or the next one after a gap began),
  // at most once per clock tick so a core whose clock lags ours cannot make it spin.
  const now = opts.now;
  const refreshedAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (now === undefined) return;
    const guideNow = now - offsetMinutes * MINUTE;
    const ended = (nn: EpgNowNext) =>
      nn.now ? ms(nn.now.end) > 0 && ms(nn.now.end) <= guideNow : !!nn.next && ms(nn.next.start) > 0 && ms(nn.next.start) <= guideNow;
    const stale = [exA.nowNext, exB.nowNext].some((m) => m && Object.values(m).some(ended));
    if (stale && refreshedAt.current !== now) {
      refreshedAt.current = now;
      void invalidate('epg.nowNext');
    }
  }, [now, offsetMinutes, exA.nowNext, exB.nowNext]);

  const loaded = useMemo(() => channels.map((channel, index) => ({ index, channel })), [channels]);
  const error = listId ? items.error : null;
  const refetch = items.refetch;
  const retry = useCallback(() => void refetch(), [refetch]);

  return {
    total: entries ? channels.length : undefined,
    getChannel,
    getNowNext,
    isFavorite,
    setVisibleRange,
    isLoading: !!listId && !entries && !error,
    refreshing,
    error,
    retry,
    loaded,
    pageSize: size,
    guideUnavailable: false,
    retryGuide: noop,
    entries,
    unavailable,
    channels,
  };
}

function noop() {}
