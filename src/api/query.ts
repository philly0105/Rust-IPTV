/**
 * TanStack Query bindings (SPEC C1). Query keys are `[cmd, args]`.
 * Only errors with `retryable` are retried, at most twice.
 */

import {
  QueryClient,
  keepPreviousData,
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { onAnyAppEvent } from './events';
import { RpcError, rpcRaw, type RpcArgs, type RpcName, type RpcResult } from './transport';

const MAX_RETRIES = 2;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => error instanceof RpcError && error.retryable && failureCount < MAX_RETRIES,
    },
    mutations: {
      retry: false,
    },
  },
});

export function rpcKey<K extends RpcName>(cmd: K, args?: RpcArgs<K>): readonly unknown[] {
  return [cmd, args ?? null];
}

export interface RpcQueryOptions {
  enabled?: boolean;
  staleTime?: number;
  keepPrevious?: boolean;
}

export function useRpcQuery<K extends RpcName>(
  cmd: K,
  args: RpcArgs<K>,
  opts?: RpcQueryOptions,
): UseQueryResult<RpcResult<K>, RpcError> {
  return useQuery<RpcResult<K>, RpcError>({
    queryKey: rpcKey(cmd, args),
    queryFn: async () => (await rpcRaw(cmd, args)) as RpcResult<K>,
    enabled: opts?.enabled,
    staleTime: opts?.staleTime,
    placeholderData: opts?.keepPrevious ? keepPreviousData : undefined,
  });
}

export function useRpcMutation<K extends RpcName>(
  cmd: K,
  opts?: { invalidate?: string[] },
): UseMutationResult<RpcResult<K>, RpcError, RpcArgs<K>> {
  return useMutation<RpcResult<K>, RpcError, RpcArgs<K>>({
    mutationFn: async (args) => (await rpcRaw(cmd, args)) as RpcResult<K>,
    onSuccess: async () => {
      const prefixes = opts?.invalidate ?? [];
      await Promise.all(prefixes.map((p) => invalidate(p)));
    },
  });
}

/** Invalidates queries whose key[0] starts with `prefix` (e.g. 'xtream.' or 'sources.list'). */
export function invalidate(prefix: string): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (q) => {
      const head = q.queryKey[0];
      return typeof head === 'string' && head.startsWith(prefix);
    },
  });
}

/**
 * Prefixes every client invalidates per event, whatever the caller adds.
 * `import.progress` only counts when `phase === 'done'`; `events.lagged`
 * (the server dropped events for a slow socket) invalidates everything.
 */
export const DEFAULT_EVENT_INVALIDATION: Readonly<Record<string, readonly string[]>> = {
  'sources.changed': ['catalog.', 'sources.'],
  'import.progress': ['catalog.', 'sources.'],
  'epg.changed': ['epg.'],
  'downloads.update': ['downloads.', 'myvideos.'],
  'settings.changed': ['settings.'],
};

/** Events after which no cached query can be trusted. */
const INVALIDATE_ALL_EVENTS = new Set(['events.lagged']);

/** Prefixes to invalidate for one event: defaults merged with `extra`, deduplicated. */
export function invalidationPrefixes(
  event: { type: string; payload?: unknown },
  extra: Record<string, readonly string[]> = {},
): string[] {
  if (event.type === 'import.progress') {
    const phase = (event.payload as { phase?: unknown } | null | undefined)?.phase;
    if (phase !== 'done') return [];
  }
  return [...new Set([...(DEFAULT_EVENT_INVALIDATION[event.type] ?? []), ...(extra[event.type] ?? [])])];
}

/**
 * Wires event types to query prefixes, e.g. `{ 'sources.changed': ['favorites.'] }`, on top of
 * {@link DEFAULT_EVENT_INVALIDATION}. Returns an unsubscribe function. Call once from the app shell.
 */
export function bindEventInvalidation(map: Record<string, readonly string[]> = {}): () => void {
  return onAnyAppEvent((event) => {
    if (INVALIDATE_ALL_EVENTS.has(event.type)) {
      void queryClient.invalidateQueries();
      return;
    }
    for (const p of invalidationPrefixes(event, map)) void invalidate(p);
  });
}
