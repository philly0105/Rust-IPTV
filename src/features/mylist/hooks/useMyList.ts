import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery, type RpcQueryOptions } from '@/api/query';
import { itemKey, type ItemRef } from '@/api/types';

import { useToast } from '../deps';
import { LIST_ARGS } from '../lib/cache';
import { keysOf } from '../lib/list';

/**
 * The whole of My List in the user's order (the shared `watchlist.list {}`
 * query). Every write that changes it invalidates the key (see lib/cache.ts),
 * so readers follow invalidations rather than refetching on each mount.
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
 * Whether the saved keys can be trusted: `loading` until the shared list first
 * arrives (and while a retry runs), `error` when it could not be read and no
 * earlier copy is cached, `ready` otherwise. An empty key set means "not
 * saved" only when `ready`; toggles stay off until then, because a toggle
 * from an unknown state would take a saved title off the list.
 */
export type MyListStatus = 'loading' | 'error' | 'ready';

export interface MyListState {
  keys: ReadonlySet<string>;
  status: MyListStatus;
  /** Reads the list again; says so in a toast when it fails again. Resolves true once loaded. */
  retry: () => Promise<boolean>;
}

export function useMyListState(): MyListState {
  const { t } = useTranslation('mylist');
  const { toast } = useToast();
  const { data, isError, isFetching, refetch } = useMyList();
  const status: MyListStatus = data !== undefined ? 'ready' : isError && !isFetching ? 'error' : 'loading';
  const retry = useCallback(
    () =>
      refetch().then((r) => {
        if (r.data !== undefined) return true;
        toast({ title: t('loadFailed'), description: t('errorHint'), variant: 'error' });
        return false;
      }),
    [refetch, t, toast],
  );
  return { keys: keysOf(data), status, retry };
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
