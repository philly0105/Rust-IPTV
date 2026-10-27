/**
 * Data hooks shared by the library pages: downloads (kept live by the shell's
 * event binding: `downloads.update` refetches `downloads.list` and `myvideos.`),
 * the source lookup used for badges and playback, and a pending-id tracker
 * that blocks duplicate clicks until an action settles.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useRpcQuery } from '@/api/query';
import type { ItemRef, Source } from '@/api/types';

import { progressStore } from '../lib/progress';

/** The full download list, live. */
export function useDownloads() {
  const query = useRpcQuery('downloads.list', undefined, { staleTime: 5_000 });
  const data = query.data;
  useEffect(() => {
    if (data) progressStore.prune(data.filter((d) => d.status === 'downloading').map((d) => d.id));
  }, [data]);
  return query;
}

/** Completed downloads (with `fileAvailable`), live. */
export function useMyVideos() {
  return useRpcQuery('myvideos.list', undefined, { staleTime: 10_000 });
}

/** Map of sources by id. Unknown ids (deleted sources) resolve to undefined. */
export function useSourcesById(): { byId: Map<string, Source>; isLoading: boolean } {
  const q = useRpcQuery('sources.list', undefined, { staleTime: 60_000 });
  const byId = useMemo(() => new Map((q.data ?? []).map((s) => [s.id, s])), [q.data]);
  return { byId, isLoading: q.isLoading };
}

/**
 * Whether a page's rows should name their source. With one source set up and every row from it,
 * the same name on each row says nothing and takes room the title and the programme need. With
 * more than one source set up, or rows from several (a removed source among them), it says which.
 */
export function useNamesSources(refs: readonly ItemRef[], sources: ReadonlyMap<string, Source>): boolean {
  return useMemo(() => sources.size > 1 || new Set(refs.map((r) => r.sourceId)).size > 1, [refs, sources]);
}

/** Tracks in-flight actions per key so a second click cannot dispatch twice. */
export function usePending<K extends string | number>() {
  const [pending, setPending] = useState<ReadonlySet<K>>(() => new Set());
  const ref = useRef(new Set<K>());
  const run = useCallback(async <T>(key: K, fn: () => Promise<T>): Promise<T | undefined> => {
    if (ref.current.has(key)) return undefined;
    ref.current.add(key);
    setPending(new Set(ref.current));
    try {
      return await fn();
    } finally {
      ref.current.delete(key);
      setPending(new Set(ref.current));
    }
  }, []);
  return { pending, run };
}
