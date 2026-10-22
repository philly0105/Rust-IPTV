/**
 * The first data of the screen the app opens on, asked for at boot (L3-ui-data-x7). A cold start
 * or reload of a channel list, a VOD landing page or Home otherwise sends its first requests only
 * once the page chunk has loaded and the page has rendered. main.tsx calls {@link prefetchScreenData}
 * with the URL (a deep link) or the saved screen (after settings arrive), so those requests run
 * alongside the chunk download and the first render, under the keys and arguments the pages ask
 * with: the pages' queries then read the cache (or join the request in flight) instead of asking
 * again. The pages build their arguments with the same functions below, so the two cannot drift.
 *
 * Kept small and free of page code: it is part of the entry chunk.
 */

import { matchPath } from 'react-router';

import { queryClient, rpcKey, type RpcCommand } from './query';
import { rpcRaw, type RpcArgs } from './transport';
import type { ContentType, Settings, Source } from './types';

/** Rows per `catalog.channels` page (usePagedChannels). */
export const CHANNEL_PAGE_SIZE = 120;

/** Titles in the recently added rail (useRecentlyAdded). */
export const RECENTLY_ADDED_LIMIT = 24;

/** `catalog.categories` as the live, radio and VOD landing pages ask it: shown and hidden in one request. */
export function categoriesArgs(sourceId: string, contentType: ContentType): RpcArgs<'catalog.categories'> {
  return { sourceId, contentType, includeHidden: true };
}

export interface ChannelListArgs {
  sourceId: string;
  categoryId?: string;
  search?: string;
  radio?: boolean;
}

/** One `catalog.channels` page of a channel list, as usePagedChannels asks it. */
export function channelPageArgs(list: ChannelListArgs, page: number, size: number = CHANNEL_PAGE_SIZE): RpcArgs<'catalog.channels'> {
  return {
    sourceId: list.sourceId,
    categoryId: list.categoryId,
    radio: list.radio || undefined,
    query: { offset: page * size, limit: size, search: list.search || undefined },
  };
}

/**
 * Live's pinned views, Favorites and Recently watched, by the ids the route has where a group id
 * would be (`/s/:id/live/@favorites`, `?category=@recent` on Radio).
 */
export const LIVE_VIEW_ID = { favorites: '@favorites', recent: '@recent' } as const;

/** Recently watched entries Live's view reads. */
export const LIVE_RECENT_LIMIT = 100;

/** `favorites.list` as Live's Favorites view (and the guide's) asks it: the source's favorites. */
export function liveFavoritesArgs(sourceId: string): RpcArgs<'favorites.list'> {
  return { sourceId };
}

/** `recent.list` as Live's Recently watched view asks it. */
export function liveRecentArgs(sourceId: string): RpcArgs<'recent.list'> {
  return { sourceId, limit: LIVE_RECENT_LIMIT };
}

/** `catalog.recentlyAdded` for the recently added rail of a source kept in SQLite (not Stalker). */
export function recentlyAddedArgs(sourceId: string, kind: 'movie' | 'series', limit: number = RECENTLY_ADDED_LIMIT): RpcArgs<'catalog.recentlyAdded'> {
  return { sourceId, contentType: kind, limit };
}

/** Cards in each Home rail (DashboardPage). */
export const HOME_RAIL_LIMIT = 24;

/** Recent entries Home reads: its recently watched live rail and the source ranking. */
export const HOME_RECENT_LIMIT = 60;

/** `positions.continueWatching` as Home's hero and Continue watching rail ask it. */
export function homeContinueArgs(): RpcArgs<'positions.continueWatching'> {
  return { limit: HOME_RAIL_LIMIT };
}

/** `favorites.list` as Home's two favourites rails ask it: every source. */
export function homeFavoritesArgs(): RpcArgs<'favorites.list'> {
  return {};
}

/** `recent.list` as Home asks it. */
export function homeRecentArgs(): RpcArgs<'recent.list'> {
  return { limit: HOME_RECENT_LIMIT };
}

/** `catalog.recentlyAdded` across every source, for Home's hero and new arrivals rail. */
export function homeRecentlyAddedArgs(kind: 'movie' | 'series'): RpcArgs<'catalog.recentlyAdded'> {
  return { contentType: kind, limit: HOME_RAIL_LIMIT };
}

function prefetch<K extends RpcCommand>(cmd: K, args: RpcArgs<K>): void {
  void queryClient.prefetchQuery({ queryKey: rpcKey(cmd, args), queryFn: () => rpcRaw(cmd, args) });
}

function prefetchChannelList(sourceId: string, categoryId: string | undefined, radio: boolean): void {
  prefetch('sources.get', { id: sourceId });
  prefetch('catalog.categories', categoriesArgs(sourceId, radio ? 'radio' : 'live'));
  // The pinned views list the user's entries, not a page of a group: no group has their ids.
  if (categoryId === LIVE_VIEW_ID.favorites) return prefetch('favorites.list', liveFavoritesArgs(sourceId));
  if (categoryId === LIVE_VIEW_ID.recent) return prefetch('recent.list', liveRecentArgs(sourceId));
  prefetch('catalog.channels', channelPageArgs({ sourceId, categoryId, radio }, 0));
}

function prefetchVodLanding(sourceId: string, kind: 'movie' | 'series'): void {
  prefetch('catalog.categories', categoriesArgs(sourceId, kind));
  // The rail's request depends on the source's kind, which the boot `sources.list` answers (the
  // page seeds `sources.get` from it too, so that one is not asked for here).
  void queryClient
    .ensureQueryData({ queryKey: rpcKey('sources.list'), queryFn: () => rpcRaw('sources.list') })
    .then((list) => {
      const source = (list as Source[] | undefined)?.find((s) => s.id === sourceId);
      if (source && source.kind !== 'stalker') prefetch('catalog.recentlyAdded', recentlyAddedArgs(sourceId, kind));
    })
    .catch(() => undefined);
}

/**
 * Home's rail queries (performance audit SH-3), once the boot `settings.get` and `sources.list`
 * answer, under DashboardPage's keys and arguments: nothing without a source (Home shows its
 * welcome), and the new arrivals and TMDB trending only when a rail on screen reads them.
 */
function prefetchHome(): void {
  void Promise.all([
    queryClient.ensureQueryData({ queryKey: rpcKey('settings.get'), queryFn: () => rpcRaw('settings.get') }),
    queryClient.ensureQueryData({ queryKey: rpcKey('sources.list'), queryFn: () => rpcRaw('sources.list') }),
  ])
    .then(([settings, sources]) => {
      if (((sources as Source[] | undefined)?.length ?? 0) === 0) return;
      const s = settings as Settings | undefined;
      const show = (rail: keyof Settings['dashboardRails']) => s?.dashboardRails?.[rail] ?? true;
      prefetch('positions.continueWatching', homeContinueArgs());
      prefetch('favorites.list', homeFavoritesArgs());
      prefetch('recent.list', homeRecentArgs());
      if (show('hero') || show('recentlyAdded')) {
        prefetch('catalog.recentlyAdded', homeRecentlyAddedArgs('movie'));
        prefetch('catalog.recentlyAdded', homeRecentlyAddedArgs('series'));
      }
      // My List's shared query (LIST_ARGS in features/mylist/lib/cache.ts) and the custom list rails.
      prefetch('watchlist.list', {});
      prefetch('lists.list', undefined);
      if (s?.tmdb?.enabled && show('tmdbTrending')) prefetch('tmdb.trending', undefined);
    })
    .catch(() => undefined);
}

/**
 * Starts the first requests of the page at `path` (pathname and query), if it is a channel list
 * (`/s/:id/live[/:categoryId]`, `/s/:id/radio[?category=]`, Favorites and Recently watched
 * included), a VOD landing page
 * (`/s/:id/movies`, `/s/:id/series`) or Home (`/dashboard`). Any other path asks for nothing.
 */
export function prefetchScreenData(path: string): void {
  let url: URL;
  try {
    url = new URL(path, 'http://boot.invalid');
  } catch {
    return;
  }
  const at = (pattern: string) => matchPath(pattern, url.pathname)?.params;
  if (at('/dashboard')) return prefetchHome();
  const live = at('/s/:sourceId/live/:categoryId') ?? at('/s/:sourceId/live');
  if (live?.sourceId) return prefetchChannelList(live.sourceId, live.categoryId, false);
  const radio = at('/s/:sourceId/radio');
  if (radio?.sourceId) return prefetchChannelList(radio.sourceId, url.searchParams.get('category') ?? undefined, true);
  const movies = at('/s/:sourceId/movies');
  if (movies?.sourceId) return prefetchVodLanding(movies.sourceId, 'movie');
  const series = at('/s/:sourceId/series');
  if (series?.sourceId) return prefetchVodLanding(series.sourceId, 'series');
}
