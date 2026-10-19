/**
 * Per-source rail links (SPEC C7). m3u: live, radio when it has any, movies
 * when movieCount > 0, favorites, recent. xtream/stalker: everything.
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

export function railLinkIds(source: Pick<Source, 'kind' | 'movieCount'>, opts: RailLinkOptions = {}): RailLinkId[] {
  if (source.kind !== 'm3u') return ['live', 'radio', 'movies', 'series', 'favorites', 'recent'];
  const ids: RailLinkId[] = ['live'];
  if (opts.hasRadio) ids.push('radio');
  if (source.movieCount > 0) ids.push('movies');
  ids.push('favorites', 'recent');
  return ids;
}

export function railLinks(source: Pick<Source, 'id' | 'kind' | 'movieCount'>, opts: RailLinkOptions = {}): RailLink[] {
  const base = sourceBasePath(source.id);
  return railLinkIds(source, opts).map((id) => ({ id, to: `${base}/${id}`, ...DEFS[id] }));
}
