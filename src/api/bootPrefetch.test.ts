/**
 * L3-ui-data-x7: the boot prefetch asks for a channel list's or a VOD landing page's first data
 * under the keys and arguments the pages use, so the pages' own queries find it in the cache and
 * send nothing of their own. Performance audit SH-3: Home's rail queries too.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useLiveViewChannels } from '@/features/live/hooks/useLiveViewChannels';
import { usePagedChannels } from '@/features/live/hooks/usePagedChannels';
import { LIST_KEY } from '@/features/mylist/lib/cache';
import { useRecentlyAdded, useSource } from '@/features/vod/hooks/queries';

import {
  CHANNEL_PAGE_SIZE,
  categoriesArgs,
  channelPageArgs,
  homeContinueArgs,
  homeFavoritesArgs,
  homeRecentArgs,
  homeRecentlyAddedArgs,
  liveFavoritesArgs,
  liveRecentArgs,
  prefetchScreenData,
  recentlyAddedArgs,
} from './bootPrefetch';
import { queryClient, rpcKey } from './query';
import { rpcRaw } from './transport';
import type { Source } from './types';

const sources = vi.hoisted(() => ({ list: [] as Array<{ id: string; kind: string }>, settings: {} as Record<string, unknown> }));

vi.mock('./transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transport')>()),
  rpcRaw: vi.fn(async (cmd: string) => {
    if (cmd === 'sources.list') return sources.list;
    if (cmd === 'settings.get') return sources.settings;
    if (cmd === 'catalog.channels') return { items: [], total: 0 };
    if (cmd === 'catalog.categories' || cmd === 'catalog.recentlyAdded') return [];
    if (cmd === 'favorites.list' || cmd === 'recent.list') return [];
    return {};
  }),
}));

const raw = vi.mocked(rpcRaw);
const calls = (cmd: string) => raw.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);

afterEach(() => {
  queryClient.clear();
  raw.mockClear();
  sources.list = [];
  sources.settings = {};
});

describe('prefetchScreenData', () => {
  it('asks for a live list: the source, all its live groups and the first channel page', async () => {
    prefetchScreenData('/s/s1/live/c9');
    await waitFor(() => expect(raw).toHaveBeenCalledTimes(3));
    expect(calls('sources.get')).toEqual([{ id: 's1' }]);
    expect(calls('catalog.categories')).toEqual([{ sourceId: 's1', contentType: 'live', includeHidden: true }]);
    expect(calls('catalog.channels')).toEqual([
      { sourceId: 's1', categoryId: 'c9', radio: undefined, query: { offset: 0, limit: CHANNEL_PAGE_SIZE, search: undefined } },
    ]);
    expect(queryClient.getQueryState(rpcKey('catalog.channels', channelPageArgs({ sourceId: 's1', categoryId: 'c9' }, 0)))).toBeDefined();
  });

  it('reads the radio group from the query string', async () => {
    prefetchScreenData('/s/s1/radio?category=r2');
    await waitFor(() => expect(raw).toHaveBeenCalledTimes(3));
    expect(calls('catalog.categories')).toEqual([categoriesArgs('s1', 'radio')]);
    expect(calls('catalog.channels')).toEqual([channelPageArgs({ sourceId: 's1', categoryId: 'r2', radio: true }, 0)]);
  });

  it("asks for Live's Favorites and Recently watched by their lists, not as a group's channel page", async () => {
    prefetchScreenData('/s/s1/live/@favorites');
    await waitFor(() => expect(raw).toHaveBeenCalledTimes(3));
    expect(calls('favorites.list')).toEqual([{ sourceId: 's1' }]);
    expect(calls('catalog.channels')).toEqual([]);
    expect(calls('sources.get')).toEqual([{ id: 's1' }]);
    queryClient.clear();
    raw.mockClear();
    prefetchScreenData('/s/s1/radio?category=@recent');
    await waitFor(() => expect(raw).toHaveBeenCalledTimes(3));
    expect(calls('recent.list')).toEqual([{ sourceId: 's1', limit: 100 }]);
    expect(calls('catalog.categories')).toEqual([categoriesArgs('s1', 'radio')]);
    expect(calls('catalog.channels')).toEqual([]);
  });

  it('asks for a VOD landing page: the groups and, for a SQLite source, the recently added rail', async () => {
    sources.list = [{ id: 's1', kind: 'xtream' }];
    prefetchScreenData('/s/s1/series');
    await waitFor(() => expect(calls('catalog.recentlyAdded')).toHaveLength(1));
    expect(calls('catalog.categories')).toEqual([categoriesArgs('s1', 'series')]);
    expect(calls('catalog.recentlyAdded')).toEqual([{ sourceId: 's1', contentType: 'series', limit: 24 }]);
    // The page seeds `sources.get` from the list, so the prefetch leaves it alone.
    expect(calls('sources.get')).toEqual([]);
  });

  it('leaves the rail of a Stalker portal to the page (it reads the portal, not SQLite)', async () => {
    sources.list = [{ id: 's1', kind: 'stalker' }];
    prefetchScreenData('/s/s1/movies');
    await waitFor(() => expect(calls('sources.list')).toHaveLength(1));
    await Promise.resolve();
    expect(calls('catalog.categories')).toEqual([categoriesArgs('s1', 'movie')]);
    expect(calls('catalog.recentlyAdded')).toEqual([]);
  });

  it.each(['/', '/sources', '/s/s1/guide', '/s/s1/movie/7', '/s/s1/movies/c/5', '/s/s1/series/42'])('asks for nothing on %s', (path) => {
    prefetchScreenData(path);
    expect(raw).not.toHaveBeenCalled();
  });
});

describe('Home (SH-3)', () => {
  const homeCalls = () => raw.mock.calls.map(([c]) => c).filter((c) => c !== 'settings.get' && c !== 'sources.list');

  it("asks for Home's rails once settings and sources are in, under the page's arguments", async () => {
    sources.list = [{ id: 's1', kind: 'xtream' }];
    sources.settings = { tmdb: { enabled: true } };
    prefetchScreenData('/dashboard');
    await waitFor(() => expect(calls('tmdb.trending')).toHaveLength(1));
    expect(calls('positions.continueWatching')).toEqual([homeContinueArgs()]);
    expect(calls('favorites.list')).toEqual([homeFavoritesArgs()]);
    expect(calls('recent.list')).toEqual([homeRecentArgs()]);
    expect(calls('catalog.recentlyAdded')).toEqual([homeRecentlyAddedArgs('movie'), homeRecentlyAddedArgs('series')]);
    expect(calls('lists.list')).toEqual([undefined]);
    // My List's shared query, under its own key.
    expect(queryClient.getQueryState(LIST_KEY)).toBeDefined();
    expect(homeCalls()).toHaveLength(8);
  });

  it('asks only for what the switched-on rails read', async () => {
    sources.list = [{ id: 's1', kind: 'm3u' }];
    sources.settings = { tmdb: { enabled: true }, dashboardRails: { hero: false, recentlyAdded: false, tmdbTrending: false } };
    prefetchScreenData('/dashboard');
    await waitFor(() => expect(calls('lists.list')).toHaveLength(1));
    expect(calls('catalog.recentlyAdded')).toEqual([]);
    expect(calls('tmdb.trending')).toEqual([]);
  });

  it('asks for no rail without a source (Home shows its welcome)', async () => {
    prefetchScreenData('/dashboard');
    await waitFor(() => expect(calls('sources.list')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(homeCalls()).toEqual([]);
  });
});

describe('the pages read what the boot prefetch asked for', () => {
  it('usePagedChannels sends no second request for the first page', async () => {
    prefetchScreenData('/s/s1/live/c9');
    const { result } = renderHook(() => usePagedChannels({ sourceId: 's1', categoryId: 'c9' }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(calls('catalog.channels')).toHaveLength(1);
  });

  it.each([
    ['favorites', '/s/s1/live/@favorites', 'favorites.list', liveFavoritesArgs('s1')],
    ['recent', '/s/s1/live/@recent', 'recent.list', liveRecentArgs('s1')],
  ] as const)("Live's %s view sends no second request for its list", async (view, path, cmd, args) => {
    prefetchScreenData(path);
    const { result } = renderHook(() => useLiveViewChannels(view, { sourceId: 's1', contentType: 'live' }), { wrapper });
    await waitFor(() => expect(result.current?.total).toBe(0));
    expect(calls(cmd)).toEqual([args]);
  });

  it('useRecentlyAdded sends no second request for the rail', async () => {
    sources.list = [{ id: 's1', kind: 'm3u' }];
    prefetchScreenData('/s/s1/movies');
    await waitFor(() => expect(calls('catalog.recentlyAdded')).toHaveLength(1));
    const source = { id: 's1', kind: 'm3u' } as Source;
    const { result } = renderHook(() => useRecentlyAdded(source, 'movie'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls('catalog.recentlyAdded')).toEqual([recentlyAddedArgs('s1', 'movie')]);
  });

  it('the VOD page still gets its source from the boot list, with no sources.get', async () => {
    sources.list = [{ id: 's1', kind: 'xtream' }];
    await queryClient.prefetchQuery({ queryKey: rpcKey('sources.list'), queryFn: () => rpcRaw('sources.list') });
    prefetchScreenData('/s/s1/movies');
    const { result } = renderHook(() => useSource('s1'), { wrapper });
    await waitFor(() => expect(result.current.data?.id).toBe('s1'));
    expect(calls('sources.get')).toEqual([]);
  });
});
