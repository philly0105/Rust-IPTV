/**
 * Per-source rail links (SPEC C7). m3u: live, radio when it has any, movies
 * when movieCount > 0, series when seriesCount > 0, favorites, recent. xtream/stalker: everything until the
 * first import finished; then radio, movies and series only when they hold
 * something (stalker keeps movies and series: their totals come from the portal,
 * which may not report them).
 */

import { Clapperboard, Clock, Heart, Radio, Tv, Layers, type LucideIcon } from 'lucide-react';

import type { Source } from '@/api/types';

export type RailLinkId = 'live' | 'radio' | 'movies' | 'series' | 'favorites' | 'recent';

export interface RailLink {
  id: RailLinkId;
  /** Absolute path, e.g. `/s/abc/live`. */
  to: string;
  /** i18n key in the `shell` namespace. */
  labelKey: string;
  icon: LucideIcon;
}

export interface RailLinkOptions {
  /** m3u only: whether the source has radio channels. Unknown counts as false. */
  hasRadio?: boolean;
}

const DEFS: Record<RailLinkId, { labelKey: string; icon: LucideIcon }> = {
  live: { labelKey: 'railLive', icon: Tv },
  radio: { labelKey: 'railRadio', icon: Radio },
  movies: { labelKey: 'railMovies', icon: Clapperboard },
  series: { labelKey: 'railSeries', icon: Layers },
  favorites: { labelKey: 'railFavorites', icon: Heart },
  recent: { labelKey: 'railRecent', icon: Clock },
};

export function sourceBasePath(sourceId: string): string {
  return `/s/${encodeURIComponent(sourceId)}`;
}

/**
 * The source id a route belongs to, decoded: `/s/:id/...`, and the catch-up archive
 * `/live/archive/:id/...`, which sits outside `/s/:id`. Undefined for any other path.
 */
export function routeSourceId(path: string): string | undefined {
  const m = /^\/(?:s|live\/archive)\/([^/?#]+)/.exec(path);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1];
  }
}

/** The counts the links depend on; the optional ones count as unknown when absent. */
export type RailLinkSource = Pick<Source, 'kind' | 'movieCount'> & Partial<Pick<Source, 'radioCount' | 'seriesCount' | 'lastRefreshAt'>>;

export function railLinkIds(source: RailLinkSource, opts: RailLinkOptions = {}): RailLinkId[] {
  if (source.kind !== 'm3u') {
    // Before an import has finished the counts are zeros, not answers: every link shows.
    if (!source.lastRefreshAt) return ['live', 'radio', 'movies', 'series', 'favorites', 'recent'];
    const portal = source.kind === 'stalker';
    const ids: RailLinkId[] = ['live'];
    if ((source.radioCount ?? 0) > 0 || opts.hasRadio) ids.push('radio');
    if (portal || source.movieCount > 0) ids.push('movies');
    if (portal || (source.seriesCount ?? 0) > 0) ids.push('series');
    ids.push('favorites', 'recent');
    return ids;
  }
  const ids: RailLinkId[] = ['live'];
  if (opts.hasRadio) ids.push('radio');
  if (source.movieCount > 0) ids.push('movies');
  // Series grouped from playlist episodes (m3u.md, Series).
  if ((source.seriesCount ?? 0) > 0) ids.push('series');
  ids.push('favorites', 'recent');
  return ids;
}

export function railLinks(source: RailLinkSource & Pick<Source, 'id'>, opts: RailLinkOptions = {}): RailLink[] {
  const base = sourceBasePath(source.id);
  return railLinkIds(source, opts).map((id) => ({ id, to: `${base}/${id}`, ...DEFS[id] }));
}

/**
 * Where a source opens (`/s/:id`, the add toast, the source cards): its live channels, or, when
 * an import found none, the first section that holds something (movies, series, radio).
 */
export function sourceHomePath(source: Pick<Source, 'id' | 'channelCount' | 'movieCount'> & Partial<Pick<Source, 'radioCount' | 'seriesCount'>>): string {
  const base = sourceBasePath(source.id);
  if (source.channelCount > 0) return `${base}/live`;
  if (source.movieCount > 0) return `${base}/movies`;
  if ((source.seriesCount ?? 0) > 0) return `${base}/series`;
  if ((source.radioCount ?? 0) > 0) return `${base}/radio`;
  return `${base}/live`;
}
