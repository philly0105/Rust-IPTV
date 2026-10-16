/**
 * Watched ticks and the grid's W key (Run 2 C4). A movie or series is watched
 * when it has an item-level watched row: finished, or marked as a whole.
 * Watched episodes never tick their series.
 */

import { hashKey, useQueries, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { rpcKey, useRpcQuery } from '@/api/query';
import { RpcError, rpc, rpcRaw } from '@/api/transport';
import { itemKey, type ItemRef } from '@/api/types';
import { captureWatched, undoWatched } from '@/features/library/lib/watchedUndo';
import { useToast } from '@/ui';

import { invalidateWatched, useSetWatched } from './queries';

/** `positions.watchedContains` takes at most this many refs. */
export const WATCHED_LOOKUP_MAX = 500;
const WATCHED_STALE_MS = 30_000;

type WithRef = { ref: ItemRef };

function refsOf(items: readonly WithRef[] | undefined): ItemRef[] {
  return (items ?? []).slice(0, WATCHED_LOOKUP_MAX).map((i) => i.ref);
}

const NO_REFS: ItemRef[] = [];
const NO_KEYS: ReadonlySet<string> = new Set();
/** The lookup refs of a page's items, the hash of their query key, and the watched set of an answer: built once and shared. */
const refsByItems = new WeakMap<readonly WithRef[], ItemRef[]>();
const hashByRefs = new WeakMap<readonly ItemRef[], string>();
const keysByAnswer = new WeakMap<readonly ItemRef[], ReadonlySet<string>>();

function sharedRefs(items: readonly WithRef[] | undefined): ItemRef[] {
  if (!items) return NO_REFS;
  let refs = refsByItems.get(items);
  if (!refs) {
    refs = refsOf(items);
    refsByItems.set(items, refs);
  }
  return refs;
}

/** TanStack's own hash (so every reader shares the cache entry), computed once per refs array. */
function watchedKeyHash(key: QueryKey): string {
  const refs = (key[1] as { refs?: readonly ItemRef[] } | null | undefined)?.refs;
  if (!refs) return hashKey(key);
  let hash = hashByRefs.get(refs);
  if (hash === undefined) {
    hash = hashKey(key);
    hashByRefs.set(refs, hash);
  }
  return hash;
}

/**
 * Item keys of the watched titles among one loaded page. Grid cells of the
 * same page share the query. A failed lookup ticks nothing.
 *
 * Every cell of a page calls this with the same page array (L3-perf-ui-3), so the refs, the
 * query key's hash and the answer's set are made once per page and shared: built per cell, up
 * to 120 refs were copied and hashed on every render of every cell, and a fast scroll through a
 * big grid spent its frames in garbage collection.
 */
export function useWatchedKeys(items: readonly WithRef[] | undefined): ReadonlySet<string> {
  const refs = sharedRefs(items);
  const q = useRpcQuery('positions.watchedContains', { refs }, { enabled: refs.length > 0, staleTime: WATCHED_STALE_MS, queryKeyHashFn: watchedKeyHash });
  const data = q.data;
  if (!data) return NO_KEYS;
  let keys = keysByAnswer.get(data);
  if (!keys) {
    keys = new Set(data.map(itemKey));
    keysByAnswer.set(data, keys);
  }
  return keys;
}

/**
 * Watched keys across pages loaded in order (Stalker grids that filter on
 * the client). `settled` counts the leading pages whose lookup has answered
 * (or failed), so "Hide watched" never shows a title it has not checked.
 */
export function useWatchedPages(
  pages: readonly { items: readonly WithRef[] }[] | undefined,
  enabled: boolean,
): { keys: ReadonlySet<string>; settled: number } {
  const refsPerPage = useMemo(() => (pages ?? []).map((p) => refsOf(p.items)), [pages]);
  const results = useQueries({
    queries: refsPerPage.map((refs) => ({
      queryKey: rpcKey('positions.watchedContains', { refs }),
      queryFn: async ({ signal }) => (await rpcRaw('positions.watchedContains', { refs }, { signal })) as ItemRef[],
      enabled: enabled && refs.length > 0,
      staleTime: WATCHED_STALE_MS,
    })),
  });
  const latest = useRef({ results, refsPerPage });
  latest.current = { results, refsPerPage };
  // `results` is a new array every render; this names its content.
  const version = results.map((r) => `${r.status}:${r.dataUpdatedAt}`).join(',');
  return useMemo(() => {
    const { results: rs, refsPerPage: perPage } = latest.current;
    const keys = new Set<string>();
    for (const r of rs) for (const ref of r.data ?? []) keys.add(itemKey(ref));
    let settled = 0;
    while (settled < rs.length && ((perPage[settled]?.length ?? 0) === 0 || rs[settled]!.isSuccess || rs[settled]!.isError)) settled += 1;
    return { keys, settled };
  }, [version]);
}

/**
 * Marks a title watched, or unwatched when it already is (the grid's W key).
 * It asks the core first, so the toggle never acts on a stale tick, and the
 * toast offers Undo with the rows the mark replaced.
 */
export function useToggleWatched(): (ref: ItemRef) => Promise<void> {
  const { t } = useTranslation('vod');
  const { toast } = useToast();
  const qc = useQueryClient();
  const { mutate } = useSetWatched();
  return useCallback(
    async (ref: ItemRef) => {
      let watched: boolean;
      try {
        watched = (await rpc('positions.watchedContains', { refs: [ref] })).length > 0;
      } catch (e) {
        toast({ title: t('watchedFailed'), description: RpcError.from(e).message, variant: 'error' });
        return;
      }
      const next = !watched;
      const target = { ref };
      // The row about to change, so Undo can put it back; without it the toast has no Undo.
      const before = await captureWatched(target).catch(() => undefined);
      mutate(
        { ref, watched: next },
        {
          onSuccess: () =>
            toast({
              title: next ? t('markedWatched') : t('markedUnwatched'),
              variant: 'success',
              ...(before
                ? {
                    action: {
                      label: t('undo', { ns: 'library' }),
                      onClick: () => {
                        const failed = () => toast({ title: t('undoFailed', { ns: 'library' }), variant: 'error' });
                        void undoWatched(target, before)
                          .then((ok) => {
                            if (!ok) failed();
                          }, failed)
                          .finally(() => invalidateWatched(qc));
                      },
                    },
                  }
                : {}),
            }),
          onError: (err) => toast({ title: t('watchedFailed'), description: err.message, variant: 'error' }),
        },
      );
    },
    [mutate, qc, t, toast],
  );
}
