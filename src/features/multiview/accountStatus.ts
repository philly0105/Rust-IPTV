/**
 * An account's connection limit (`account.status`, cached by the core). The wall reads it for
 * its limit banner; adding a channel asks it ahead, so the wall opens with the banner in place
 * instead of pushing the tiles down when the answer comes (L2-live-13).
 */

import { queryClient, rpcKey } from '@/api/query';
import type { AccountStatus } from '@/api/rpc';
import { rpcRaw } from '@/api/transport';
import type { Source } from '@/api/types';

/** Query options of one account's `account.status`, shared by the wall and the prefetch. */
export function accountStatusQuery(sourceId: string) {
  return {
    queryKey: rpcKey('account.status', { sourceId }),
    queryFn: async ({ signal }: { signal: AbortSignal }) => (await rpcRaw('account.status', { sourceId }, { signal })) as AccountStatus | null,
    staleTime: 60_000,
  };
}

/** Asks an Xtream account's limit ahead of the wall. Only Xtream panels report one; others are not asked. */
export function prefetchAccountStatus(sourceId: string): void {
  const sources = queryClient.getQueryData<Source[]>(rpcKey('sources.list'));
  if (sources?.find((s) => s.id === sourceId)?.kind !== 'xtream') return;
  void queryClient.prefetchQuery(accountStatusQuery(sourceId));
}
