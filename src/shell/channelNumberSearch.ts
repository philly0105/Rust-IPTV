/**
 * A typed channel number ("12") as a search: IPTV users know channels by number, and the title
 * search alone found nothing for one. The Search page and the palette ask `catalog.channelByNumber`
 * of each searched source and list what it finds first among the channels.
 */

import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { rpcKey } from '@/api/query';
import { rpcRaw } from '@/api/transport';
import type { Channel } from '@/api/types';

/** The channel number a query is (1 to 5 digits and nothing else), else undefined. */
export function channelNumberQuery(query: string): number | undefined {
  const q = query.trim();
  return /^\d{1,5}$/.test(q) ? Number(q) : undefined;
}

/** The channel each source has at the number `query` names, in the sources' order. */
export function useChannelNumberHits(sourceIds: readonly string[], query: string, enabled: boolean): { channels: Channel[]; pending: boolean } {
  const number = channelNumberQuery(query);
  const on = enabled && number !== undefined;
  const results = useQueries({
    queries: sourceIds.map((sourceId) => {
      const args = { sourceId, number: number ?? 0 };
      return {
        queryKey: rpcKey('catalog.channelByNumber', args),
        queryFn: async ({ signal }: { signal: AbortSignal }) => (await rpcRaw('catalog.channelByNumber', args, { signal })) as Channel | null,
        enabled: on,
        staleTime: 60_000,
        retry: false,
      };
    }),
  });
  const pending = on && results.some((r) => r.isPending);
  // The answers are read through `stamp`: useQueries hands out a new array every render.
  const stamp = results.map((r) => r.dataUpdatedAt).join(',');
  const channels = useMemo(
    () => (on ? results.flatMap((r) => (r.data ? [r.data] : [])) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [on, stamp, sourceIds.join(',')],
  );
  return { channels, pending };
}
