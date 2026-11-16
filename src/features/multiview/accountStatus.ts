/**
 * An account's connection limit (`account.status`, cached by the core). The wall reads it for
 * its limit banner; adding a channel asks it ahead, so the wall opens with the banner in place
 * instead of pushing the tiles down when the answer comes (L2-live-13).
 */

import { queryClient, rpcKey } from '@/api/query';
import type { AccountStatus } from '@/api/rpc';
import { rpcRaw } from '@/api/transport';
import type { Source } from '@/api/types';

import { useMultiviewStore } from './store';

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

/**
 * After a channel went up from outside the wall (a channel menu): its Xtream account when the
 * wall now has more of its tiles than the account allows streams, so the confirmation can say
 * so; otherwise null. Reads the limit the add already asked for (`prefetchAccountStatus`).
 */
export async function wallOverLimit(sourceId: string): Promise<{ name: string; max: number; tiles: number } | null> {
  const source = queryClient.getQueryData<Source[]>(rpcKey('sources.list'))?.find((s) => s.id === sourceId);
  if (source?.kind !== 'xtream') return null;
  let max = 0;
  try {
    max = (await queryClient.fetchQuery(accountStatusQuery(sourceId)))?.maxConnections ?? 0;
  } catch {
    return null;
  }
  const tiles = useMultiviewStore.getState().tiles.filter((t) => t.ref.sourceId === sourceId).length;
  return max > 0 && tiles > max ? { name: source.name, max, tiles } : null;
}
