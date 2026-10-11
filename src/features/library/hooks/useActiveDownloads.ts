import { useMemo } from 'react';

import { queueCounts, type QueueCounts } from '../lib/queue';
import { useDownloads } from './useLibraryData';

/**
 * Live queue counts for a rail badge or status line, e.g.
 * `const { downloading, queued } = useActiveDownloads()`.
 */
export function useActiveDownloads(): QueueCounts & { active: number } {
  const { data } = useDownloads();
  return useMemo(() => {
    const c = queueCounts(data ?? []);
    return { ...c, active: c.downloading + c.queued };
  }, [data]);
}
