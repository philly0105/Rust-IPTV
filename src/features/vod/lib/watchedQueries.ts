/**
 * What a watched change makes stale (Run 2 C4). A movie becomes watched when
 * it is marked, or when a position save reaches {@link COMPLETE_RATIO} of
 * its duration (the core keeps it as a watched row at its end). Either way
 * the watched ticks, the "Hide watched" grid pages and decade counts, and
 * Continue Watching must refetch, also while a grid stays mounted under the
 * mini player.
 *
 * Kept free of React and of the rest of the VOD feature, so the player store
 * can call {@link invalidateWatched} after the save that finishes a title.
 */

import type { QueryClient } from '@tanstack/react-query';

import { queryClient } from '@/api/query';

/**
 * The core's `userstate::COMPLETE_RATIO`: a `positions.set` at or past this
 * share of the duration finishes the title.
 */
export const COMPLETE_RATIO = 0.95;

/** True when saving `positionSeconds` of `durationSeconds` finishes the title, by the core's rule. */
export function finishesTitle(positionSeconds: number, durationSeconds: number | undefined): boolean {
  return !!durationSeconds && durationSeconds > 0 && positionSeconds >= COMPLETE_RATIO * durationSeconds;
}

/**
 * A query a watched change makes stale: positions (ticks, resume, Continue
 * Watching), user state, My List (its entries carry `watched`), and the grid
 * pages and year facets "Hide watched" filters in the core.
 */
export function isWatchedQueryKey(key: readonly unknown[]): boolean {
  const head = key[0];
  if (typeof head !== 'string') return false;
  if (head.startsWith('positions.') || head.startsWith('userstate.') || head.startsWith('watchlist.')) return true;
  const args = key[1] as { hideWatched?: boolean } | null | undefined;
  return (head === 'catalog.movies' || head === 'catalog.series' || head === 'catalog.yearFacets') && args?.hideWatched === true;
}

/** Refetches every {@link isWatchedQueryKey} query (the app's client unless one is given). */
export function invalidateWatched(qc: QueryClient = queryClient): Promise<void> {
  return qc.invalidateQueries({ predicate: (q) => isWatchedQueryKey(q.queryKey) });
}
