/**
 * `stats.summary` for the page. There is no change event (contract C7), so
 * the query refetches when the window regains focus and every 60 s while the
 * page is open; `today` is the local date, re-read every minute so the range
 * rolls over at midnight. `useClearStats` runs `stats.clear` and drops every
 * cached summary.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { rpcKey } from '@/api/query';
import { rpc } from '@/api/transport';
import type { RpcError } from '@/api/transport';
import type { WatchStats } from '@/api/types';

import type { StatsRange } from '../paths';
import { localDay } from '../reporter';

/** How often an open stats page refetches. */
export const REFRESH_MS = 60_000;
/** How many channels and titles the page lists. */
export const TOP_COUNT = 10;

/** The local date, updated each minute. */
export function useLocalDay(): string {
  const [day, setDay] = useState(() => localDay());
  useEffect(() => {
    const id = setInterval(() => setDay(localDay()), 60_000);
    return () => clearInterval(id);
  }, []);
  return day;
}

export function useWatchStats(range: StatsRange) {
  const today = useLocalDay();
  const args = { days: range, today, top: TOP_COUNT } as const;
  const query = useQuery<WatchStats, RpcError>({
    queryKey: rpcKey('stats.summary', args),
    queryFn: () => rpc('stats.summary', args),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: REFRESH_MS,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] && (prevQuery.queryKey[1] as { days?: number }).days === range ? prev : undefined),
  });
  return { query, today };
}

export function useClearStats() {
  const client = useQueryClient();
  return useMutation<void, RpcError>({
    mutationFn: () => rpc('stats.clear'),
    onSuccess: async () => {
      await client.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('stats.') });
    },
  });
}
