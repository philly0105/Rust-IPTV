import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { rpcKey } from '@/api/query';
import { rpcRaw } from '@/api/transport';
import type { Channel, ItemRef, ParentalLock } from '@/api/types';
import { buildLocks, locksShown, type ParentalLocks } from '@/features/live/hooks/useParentalLocks';
import { useParentalStatus } from '@/features/parental/status';

const LOCKS_STALE_MS = 30_000;
const KINDS = ['movie', 'series'] as const;

/**
 * Parental locks for search results from several sources at once (VL-search-locks): the rule of
 * `useVodLocks` (own lock, its category's, an adult category; Ask mode only), with the lock list
 * and adult categories of every source that has hits. The queries share their keys with
 * `useParentalLocks`, so a grid or rail of the same source reads them from the cache.
 */
export function useSearchLocks(sourceIds: readonly string[]): (item: { ref: ItemRef; categoryId?: string | undefined }) => boolean {
  const status = useParentalStatus().data;
  const on = locksShown(status);
  const adultOn = on && status?.autoAdult === true;
  const ids = on ? [...new Set(sourceIds)].sort() : [];
  const locks = useQueries({
    queries: ids.map((sourceId) => ({
      queryKey: rpcKey('parental.locks', { sourceId }),
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await rpcRaw('parental.locks', { sourceId }, { signal })) as ParentalLock[],
      staleTime: LOCKS_STALE_MS,
    })),
  });
  const adult = useQueries({
    queries: (adultOn ? ids : []).flatMap((sourceId) =>
      KINDS.map((contentType) => ({
        queryKey: rpcKey('parental.adultCategories', { sourceId, contentType }),
        queryFn: async ({ signal }: { signal: AbortSignal }) => (await rpcRaw('parental.adultCategories', { sourceId, contentType }, { signal })) as string[],
        staleTime: LOCKS_STALE_MS,
      })),
    ),
  });
  const stamp = `${ids.join(',')}|${adultOn}|${locks.map((q) => q.dataUpdatedAt).join(',')}|${adult.map((q) => q.dataUpdatedAt).join(',')}`;
  return useMemo((): ((item: { ref: ItemRef; categoryId?: string | undefined }) => boolean) => {
    if (ids.length === 0) return () => false;
    const lookup = new Map<string, ParentalLocks>();
    ids.forEach((sourceId, i) => {
      const list = locks[i]?.data ?? [];
      KINDS.forEach((kind, k) => {
        const adultIds = adultOn ? (adult[i * KINDS.length + k]?.data ?? []) : [];
        lookup.set(`${sourceId}|${kind}`, buildLocks(list, adultIds, sourceId, kind));
      });
    });
    return (item) =>
      lookup.get(`${item.ref.sourceId}|${item.ref.contentType}`)?.channelLocked({ ref: item.ref, categoryId: item.categoryId ?? '' } as Channel) ?? false;
    // `stamp` names every answer the lookup is built from.
  }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps
}
