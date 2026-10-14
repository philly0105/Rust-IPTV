import { useMemo } from 'react';

import { useRpcQuery, type RpcQueryOptions } from '@/api/query';
import { itemKey, type ItemRef } from '@/api/types';

import { LIST_ARGS } from '../lib/cache';
import { keysOf } from '../lib/list';

/**
 * The whole of My List in the user's order (the shared `watchlist.list {}`
 * query). Pages that must show fresh watched ticks pass `staleTime: 0`;
 * buttons keep the default and follow invalidations.
 */
export function useMyList(opts?: RpcQueryOptions) {
  return useRpcQuery('watchlist.list', LIST_ARGS, opts);
}

/** Keys (`${sourceId}|${contentType}|${itemId}`) of every My List entry; empty until loaded. */
export function useMyListKeys(): ReadonlySet<string> {
  const { data } = useMyList();
  return keysOf(data);
}

/**
 * Which of `refs` are in My List, as `${sourceId}|${contentType}|${itemId}`
 * keys (contract C3). One shared query answers every card on screen, so a
 * grid of posters costs no extra calls. Empty until the list has loaded.
 */
export function useInMyList(refs: readonly ItemRef[]): Set<string> {
  const keys = useMyListKeys();
  const signature = refs.map(itemKey).join('\n');
  return useMemo(() => {
    const out = new Set<string>();
    if (keys.size === 0) return out;
    for (const key of signature.split('\n')) if (key && keys.has(key)) out.add(key);
    return out;
  }, [keys, signature]);
}
