/**
 * Browsing a source's live channels in a picker (LG-19, LG-13): the multi-view picker and a custom
 * list's "Add channels" dialog. The scope is all channels, one group, the favorites or a custom
 * list; a typed query narrows the scope: a group searches its own pages, a view (favorites, recent,
 * a list) matches its entries by name, and all channels search the catalog. Rows come with what is
 * on now, so a pick can be made by programme ("the match"), not by guessing a channel name.
 */

import { useQueries } from '@tanstack/react-query';
import { History, LayoutList, ListVideo, Star } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { rpcKey, useRpcQuery } from '@/api/query';
import { rpcRaw, type RpcArgs, type RpcResult } from '@/api/transport';
import { itemKey, type Channel, type EpgNowNext, type FavoriteEntry, type ItemKey, type ItemRef, type RecentEntry } from '@/api/types';

import { foldForFilter } from '../components/CategorySidebar';
import { batchedItemQuery } from '../lib/itemBatch';
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
/**
 * Rows per catalog read, and refs per now/next request. "Show more" adds a read at the next
 * offset: one read from offset 0 growing by a page stopped at the core's 1000 rows a read, and
 * asked again for every row already shown.
 */
export const BROWSE_PAGE = 60;

/** `count` rows as reads of at most {@link BROWSE_PAGE}. */
function pagesOf(count: number): { offset: number; limit: number }[] {
  const out: { offset: number; limit: number }[] = [];
  for (let offset = 0; offset < count; offset += BROWSE_PAGE) out.push({ offset, limit: Math.min(BROWSE_PAGE, count - offset) });
  return out;
}

/** A favorite or recent entry the catalog no longer answers for: its stored name and logo still fill the row. */
function snapshotChannel(e: FavoriteEntry | RecentEntry): Channel {
  return { ref: e.ref, name: e.snapshot.title, logoUrl: e.snapshot.posterUrl, categoryId: '', categoryName: e.snapshot.subtitle ?? '', isRadio: false };
}

const queryOf = <K extends 'catalog.channels' | 'epg.nowNext'>(cmd: K, args: RpcArgs<K>, staleTime?: number) => ({
  queryKey: rpcKey(cmd, args),
  queryFn: async ({ signal }: { signal: AbortSignal }) => (await rpcRaw(cmd, args, { signal })) as RpcResult<K>,
  ...(staleTime !== undefined ? { staleTime } : {}),
});

export function useChannelBrowse({ enabled, sourceId, scope, query, limit }: ChannelBrowseArgs): ChannelBrowse {
  const searching = query.length > 0;
  const listId = listOfScope(scope);
  const favorites = scope === SCOPE_FAVORITES;
  const recent = scope === SCOPE_RECENT;
  const isView = !!listId || favorites || recent;
  // A group belongs to one source: every source ('') has none.
  const group = !isView && scope !== SCOPE_ALL && !!sourceId ? scope : undefined;
  const needsQuery = !searching && !sourceId && scope === SCOPE_ALL;
  // The catalog's pages: all channels or a group of one source, and a group's search (the core
  // narrows the group before it counts and pages). All channels with a query search the catalog.
  const pagedOn = enabled && !isView && !!sourceId && (!searching || !!group);
  const searchOn = enabled && !isView && searching && !group;
  const folded = searching && isView ? foldForFilter(query) : '';

  const pages = pagesOf(Math.max(1, limit)).map(
    (p): RpcArgs<'catalog.channels'> => ({ sourceId, ...(group ? { categoryId: group } : {}), query: searching ? { ...p, search: query } : p }),
  );
  // The first page keeps the rows on screen while another scope or query loads; the pages
  // "Show more" adds come once it is in, and only those the total says exist.
  const first = useRpcQuery('catalog.channels', pages[0]!, { enabled: pagedOn, keepPrevious: true });
  const firstIn = !!first.data && !first.isPlaceholderData;
  const more = useQueries({
    queries: pages.slice(1).map((a) => ({ ...queryOf('catalog.channels', a), enabled: pagedOn && firstIn && a.query.offset < first.data!.total })),
  });
  const search = useRpcQuery(
    'catalog.search',
    { query, contentTypes: ['live'], limit, ...(sourceId ? { sourceId } : {}) },
    { enabled: searchOn, keepPrevious: true },
  );
  const list = useRpcQuery('lists.items', { id: listId ?? '' }, { enabled: enabled && !!listId, staleTime: STALE });
  const favs = useRpcQuery('favorites.list', sourceId ? { sourceId } : {}, { enabled: enabled && favorites });
  const recents = useRpcQuery('recent.list', sourceId ? { sourceId, limit: 50 } : { limit: 50 }, { enabled: enabled && recent });

  // Favorites and recent hold refs: the rows on screen ask the catalog for their channels. A
  // query keeps the entries whose name has it, as a search narrows Live's Favorites.
  const refEntries = useMemo((): (FavoriteEntry | RecentEntry)[] => {
    let rows: (FavoriteEntry | RecentEntry)[] = [];
    if (favorites) {
      rows = [...(favs.data ?? [])]
        .filter((e) => e.ref.contentType === 'live')
        .sort((a, b) => a.position - b.position || a.addedAt.localeCompare(b.addedAt));
    } else if (recent) rows = (recents.data ?? []).filter((e) => e.ref.contentType === 'live');
    return folded ? rows.filter((e) => foldForFilter(e.snapshot.title).includes(folded)) : rows;
  }, [favorites, recent, favs.data, recents.data, folded]);
  // One `catalog.items` call for the rows asked for together, not one call per row.
  const items = useQueries({ queries: refEntries.slice(0, limit).map((e) => batchedItemQuery(e.ref, 5 * 60_000)) });

  const view = favorites ? favs : recent ? recents : listId ? list : pagedOn || !searching ? first : search;
  const { channels, total } = useMemo((): { channels: Channel[]; total: number } => {
    if (listId) {
      const rows = (list.data ?? []).flatMap((e) =>
        e.available && e.channel && e.ref.contentType === 'live' && (!sourceId || e.ref.sourceId === sourceId) && (!folded || foldForFilter(e.channel.name).includes(folded))
          ? [e.channel]
          : [],
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
    if (searching && !group) {
      const found = (search.data?.live ?? []).filter((c) => !c.isRadio && c.ref.contentType === 'live');
      return { channels: found, total: found.length };
    }
    // The pages in order, up to the first one still loading. While the first page is the previous
    // scope's, so are the rows: none of the new scope's later pages join them.
    const read = [first, ...(first.isPlaceholderData ? [] : more)];
    const rows: Channel[] = [];
    for (const p of read) {
      if (!p.data) break;
      for (const c of p.data.items) if (!c.isRadio && c.ref.contentType === 'live') rows.push(c);
    }
    return { channels: rows, total: first.data?.total ?? 0 };
    // `items` and `more` are new arrays every render; their answers are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, search.data, group, listId, list.data, sourceId, limit, folded, favorites, recent, refEntries, first.data, first.isPlaceholderData, items.map((q) => q.dataUpdatedAt + q.errorUpdatedAt).join(), more.map((q) => q.dataUpdatedAt).join()]);

  // Favorites and recent know their refs before any `catalog.item` answers: the guide is asked
  // for those once. Keyed on the channels as they arrived, it was asked again for every wave of
  // answers (6, 12, 18 … 60 refs, ten requests for one page), and blanked the titles between.
  // The refs go in pages too, so "Show more" asks only about the rows it adds.
  const refs = useMemo(
    (): ItemRef[] => (favorites || recent ? refEntries.slice(0, limit).map((e) => e.ref) : channels.map((c) => c.ref)),
    [favorites, recent, refEntries, limit, channels],
  );
  const refPages = pagesOf(refs.length).map((p) => refs.slice(p.offset, p.offset + p.limit));
  const nnArgs = (r: ItemRef[]): RpcArgs<'epg.nowNext'> => ({ refs: r, withDescription: false });
  const nnFirst = useRpcQuery('epg.nowNext', nnArgs(refPages[0] ?? []), { enabled: enabled && refs.length > 0, staleTime: STALE, keepPrevious: true });
  const nnMore = useQueries({ queries: refPages.slice(1).map((r) => ({ ...queryOf('epg.nowNext', nnArgs(r), STALE), enabled })) });
  const nnStamp = nnMore.map((q) => q.dataUpdatedAt).join();
  const nowNext = useMemo(
    () => (nnMore.length === 0 ? nnFirst.data : Object.assign({}, nnFirst.data, ...nnMore.map((q) => q.data))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nnFirst.data, nnStamp, nnMore.length],
  );
  const itemsPending = (favorites || recent) && items.slice(0, limit).some((q) => q.isPending);
  const pagedMore = pagedOn && !first.isPlaceholderData ? more : [];

  return {
    channels,
    total,
    nowNext,
    isPending: needsQuery ? false : view.isPending || itemsPending,
    isFetching: view.isFetching || pagedMore.some((q) => q.isFetching),
    isError: view.isError || pagedMore.some((q) => q.isError),
    error: view.error ?? pagedMore.find((q) => q.isError)?.error,
    refetch: () => {
      void view.refetch();
      for (const q of pagedMore) if (q.isError) void q.refetch();
    },
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
