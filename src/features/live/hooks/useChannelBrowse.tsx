/**
 * Browsing a source's live channels in a picker (LG-19, LG-13): the multi-view picker and a custom
 * list's "Add channels" dialog. The scope is all channels, one group, the favorites or a custom
 * list; a typed query searches instead (within the scope). Rows come with what is on now, so a
 * pick can be made by programme ("the match"), not by guessing a channel name.
 */

import { useQueries } from '@tanstack/react-query';
import { History, LayoutList, ListVideo, Star } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { rpcKey, useRpcQuery } from '@/api/query';
import { rpcRaw, type RpcResult } from '@/api/transport';
import { itemKey, type Channel, type EpgNowNext, type FavoriteEntry, type ItemKey, type ItemRef, type RecentEntry } from '@/api/types';

import type { PickerSection } from '../components/ScopePicker';

/** `''` all channels, `@favorites`, `@recent`, `@list:<id>`, else a group id. */
export type BrowseScope = string;
export const SCOPE_ALL = '';
export const SCOPE_FAVORITES = '@favorites';
export const SCOPE_RECENT = '@recent';
export const scopeOfList = (id: string): BrowseScope => `@list:${id}`;
const listOfScope = (scope: BrowseScope) => (scope.startsWith('@list:') ? scope.slice(6) : undefined);

export interface ChannelBrowseArgs {
  enabled: boolean;
  /** One source, or '' for every source (then only search, favorites, recent and lists browse). */
  sourceId: string;
  scope: BrowseScope;
  /** Trimmed, debounced query; empty browses. */
  query: string;
  limit: number;
}

export interface ChannelBrowse {
  channels: Channel[];
  /** Rows the scope holds (browse) or found (search). */
  total: number;
  /** What is on now on each row's channel, by item key. */
  nowNext: Record<ItemKey, EpgNowNext> | undefined;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  refetch(): void;
  /** Browsing every source with no query and no view: nothing to list, the picker prompts instead. */
  needsQuery: boolean;
}

const STALE = 60_000;

/** A favorite or recent entry the catalog no longer answers for: its stored name and logo still fill the row. */
function snapshotChannel(e: FavoriteEntry | RecentEntry): Channel {
  return { ref: e.ref, name: e.snapshot.title, logoUrl: e.snapshot.posterUrl, categoryId: '', categoryName: e.snapshot.subtitle ?? '', isRadio: false };
}

export function useChannelBrowse({ enabled, sourceId, scope, query, limit }: ChannelBrowseArgs): ChannelBrowse {
  const searching = query.length > 0;
  const listId = listOfScope(scope);
  const favorites = scope === SCOPE_FAVORITES;
  const recent = scope === SCOPE_RECENT;
  const group = !searching && !listId && !favorites && !recent && scope !== SCOPE_ALL ? scope : undefined;
  const needsQuery = !searching && !sourceId && scope === SCOPE_ALL;
  const browseOn = enabled && !searching && !listId && !favorites && !recent && !!sourceId;

  const browse = useRpcQuery(
    'catalog.channels',
    { sourceId, ...(group ? { categoryId: group } : {}), query: { offset: 0, limit } },
    { enabled: browseOn, keepPrevious: true },
  );
  const search = useRpcQuery(
    'catalog.search',
    { query, contentTypes: ['live'], limit, ...(sourceId ? { sourceId } : {}) },
    { enabled: enabled && searching, keepPrevious: true },
  );
  const list = useRpcQuery('lists.items', { id: listId ?? '' }, { enabled: enabled && !!listId, staleTime: STALE });
  const favs = useRpcQuery('favorites.list', sourceId ? { sourceId } : {}, { enabled: enabled && favorites });
  const recents = useRpcQuery('recent.list', sourceId ? { sourceId, limit: 50 } : { limit: 50 }, { enabled: enabled && recent });

  // Favorites and recent hold refs: the rows on screen ask the catalog for their channels.
  const refEntries = useMemo((): (FavoriteEntry | RecentEntry)[] => {
    if (favorites) {
      return [...(favs.data ?? [])]
        .filter((e) => e.ref.contentType === 'live')
        .sort((a, b) => a.position - b.position || a.addedAt.localeCompare(b.addedAt));
    }
    if (recent) return (recents.data ?? []).filter((e) => e.ref.contentType === 'live');
    return [];
  }, [favorites, recent, favs.data, recents.data]);
  const items = useQueries({
    queries: refEntries.slice(0, limit).map((e) => ({
      queryKey: rpcKey('catalog.item', { ref: e.ref }),
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await rpcRaw('catalog.item', { ref: e.ref }, { signal })) as RpcResult<'catalog.item'>,
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });

  const view = favorites ? favs : recent ? recents : listId ? list : searching ? search : browse;
  const { channels, total } = useMemo((): { channels: Channel[]; total: number } => {
    if (searching) {
      let found = (search.data?.live ?? []).filter((c) => !c.isRadio && c.ref.contentType === 'live');
      // Searching inside a group or view narrows the matches to it.
      if (group) found = found.filter((c) => c.categoryId === group);
      return { channels: found, total: found.length };
    }
    if (listId) {
      const rows = (list.data ?? []).flatMap((e) =>
        e.available && e.channel && e.ref.contentType === 'live' && (!sourceId || e.ref.sourceId === sourceId) ? [e.channel] : [],
      );
      return { channels: rows.slice(0, limit), total: rows.length };
    }
    if (favorites || recent) {
      const rows: Channel[] = [];
      refEntries.slice(0, limit).forEach((e, i) => {
        const q = items[i];
        const data = q?.data;
        if (data && 'isRadio' in data) rows.push(data);
        else if (q?.isError) rows.push(snapshotChannel(e));
      });
      return { channels: rows, total: refEntries.length };
    }
    const rows = (browse.data?.items ?? []).filter((c) => !c.isRadio && c.ref.contentType === 'live');
    return { channels: rows, total: browse.data?.total ?? 0 };
    // `items` is a new array every render; its answers are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, search.data, group, listId, list.data, sourceId, limit, favorites, recent, refEntries, browse.data, items.map((q) => q.dataUpdatedAt + q.errorUpdatedAt).join()]);

  const refs = useMemo((): ItemRef[] => channels.map((c) => c.ref), [channels]);
  const nowNext = useRpcQuery('epg.nowNext', { refs, withDescription: false }, { enabled: enabled && refs.length > 0, staleTime: STALE });
  const itemsPending = (favorites || recent) && items.slice(0, limit).some((q) => q.isPending);

  return {
    channels,
    total,
    nowNext: nowNext.data,
    isPending: needsQuery ? false : view.isPending || itemsPending,
    isFetching: view.isFetching,
    isError: view.isError,
    error: view.error,
    refetch: () => void view.refetch(),
    needsQuery,
  };
}

/** The now title of `channel` in a browse answer, if any. */
export function nowTitleOf(nowNext: Record<ItemKey, EpgNowNext> | undefined, channel: Channel): string | undefined {
  return nowNext?.[itemKey(channel.ref)]?.now?.title;
}

/**
 * The scope picker's sections for one source: all channels, then the views (favorites, recently
 * watched, every custom list) and the source's groups with their counts. Every source (`''`)
 * has no groups.
 */
export function useBrowseSections(sourceId: string, enabled: boolean, opts: { recent?: boolean } = {}): PickerSection[] {
  const { t } = useTranslation('live');
  const groups = useRpcQuery('catalog.categories', { sourceId, contentType: 'live' }, { enabled: enabled && !!sourceId, staleTime: STALE });
  const lists = useRpcQuery('lists.list', undefined, { enabled });
  const withRecent = opts.recent ?? true;
  return useMemo(
    () => [
      { id: 'all', options: [{ value: SCOPE_ALL, label: t('allChannels'), icon: <LayoutList size={14} /> }] },
      {
        id: 'views',
        heading: t('pickerViews'),
        options: [
          { value: SCOPE_FAVORITES, label: t('favoritesGroup'), icon: <Star size={14} /> },
          ...(withRecent ? [{ value: SCOPE_RECENT, label: t('recentGroup'), icon: <History size={14} /> }] : []),
          ...(lists.data ?? []).map((l) => ({ value: scopeOfList(l.id), label: l.name, count: l.itemCount, icon: <ListVideo size={14} /> })),
        ],
      },
      {
        id: 'groups',
        heading: t('groups'),
        options: (sourceId ? (groups.data ?? []) : []).filter((c) => !c.hidden).map((c) => ({ value: c.id, label: c.name, count: c.itemCount })),
      },
    ],
    [t, lists.data, groups.data, sourceId, withRecent],
  );
}
