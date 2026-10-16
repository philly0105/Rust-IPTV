import type { QueryClient } from '@tanstack/react-query';

import type { ItemRef } from '@/api/types';

/**
 * Cached per-title lists whose entries carry the title's `ref`: My List, Favorites, Recent and
 * Continue watching. The core drops a removed source's rows from all of them.
 */
export const SOURCE_SCOPED_LISTS = ['watchlist.list', 'favorites.list', 'recent.list', 'positions.continueWatching'] as const;

/**
 * Takes the titles of removed sources out of every cached copy of those lists (any arguments),
 * at once. A removal hides its source while the Undo toast runs; when it commits, the rails and
 * pages would otherwise show the old cached list again for the moment between un-hiding and the
 * refetch landing. Callers invalidate the same prefixes afterwards: that also cancels, without
 * reverting, any fetch that was already in flight with the old list.
 */
export function dropSourcesFromLists(qc: QueryClient, sourceIds: Iterable<string>): void {
  const gone = new Set(sourceIds);
  if (gone.size === 0) return;
  for (const cmd of SOURCE_SCOPED_LISTS) {
    qc.setQueriesData<{ ref: ItemRef }[]>({ queryKey: [cmd] }, (data) =>
      Array.isArray(data) && data.some((e) => gone.has(e.ref.sourceId)) ? data.filter((e) => !gone.has(e.ref.sourceId)) : data,
    );
  }
}
