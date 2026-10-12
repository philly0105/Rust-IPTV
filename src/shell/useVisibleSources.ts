import { useMemo } from 'react';

import { useRpcQuery } from '@/api/query';
import type { Source } from '@/api/types';
import { usePendingRemovals } from '@/features/sources/lib/pendingRemoval';

/**
 * `sources.list` without the sources waiting out their delete-undo window
 * (pendingRemoval.ts). The Sources page hides them at once; the rail, the
 * dashboard and the command palette must not keep listing them for those
 * eight seconds. The query object is otherwise unchanged.
 */
export function useVisibleSources() {
  const query = useRpcQuery('sources.list', undefined);
  const hidden = usePendingRemovals((s) => s.ids);
  const data = useMemo<Source[] | undefined>(
    () => (query.data && hidden.size > 0 ? query.data.filter((s) => !hidden.has(s.id)) : query.data),
    [query.data, hidden],
  );
  return { ...query, data };
}
