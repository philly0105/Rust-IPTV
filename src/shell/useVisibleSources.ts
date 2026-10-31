import { useCallback } from 'react';

import { useRpcQuery } from '@/api/query';
import type { Source } from '@/api/types';
import { usePendingRemovals } from '@/features/sources/lib/pendingRemoval';

/**
 * `sources.list` without the sources waiting out their delete-undo window
 * (pendingRemoval.ts). The Sources page hides them at once; the rail, the
 * dashboard and the command palette must not keep listing them for those
 * eight seconds.
 *
 * The filter is the query's `select`, and TanStack's result comes back as it is. It is a tracked
 * proxy: a reader re-renders only for the fields it reads. Spreading it into a new object read every
 * field, so all 20 callers (the rail, the closed palette's five hooks, Home, Live and the rest)
 * re-rendered when a `sources.list` refetch started and ended even though `data` stayed the same
 * (F1-6).
 */
export function useVisibleSources() {
  const hidden = usePendingRemovals((s) => s.ids);
  // Memoized on `hidden`: a new select would run again on every render.
  const filter = useCallback((list: Source[]) => list.filter((s) => !hidden.has(s.id)), [hidden]);
  return useRpcQuery('sources.list', undefined, { select: hidden.size > 0 ? filter : undefined });
}
