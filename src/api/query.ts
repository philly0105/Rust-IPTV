/**
 * TanStack Query bindings (SPEC C1). Query keys are `[cmd, args]`.
 * Only errors with `retryable` are retried, at most twice.
 */

import {
  QueryClient,
  keepPreviousData,
  useMutation,
  useQuery,
  type QueryKey,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';

import { onAnyAppEvent } from './events';
import { RpcError, rpcRaw, type RpcArgs, type RpcName, type RpcResult } from './transport';

const MAX_RETRIES = 2;

/** Any RPC command name, as used in key[0]. */
export type RpcCommand = RpcName;

/** Cache timing for one query: how long data counts as fresh, and how long an unused entry stays cached. */
export interface QueryTiming {
  staleTime: number;
  gcTime: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Default timing for commands the table below does not list (C4). */
export const DEFAULT_QUERY_TIMING: Readonly<QueryTiming> = { staleTime: 30 * SECOND, gcTime: 10 * MINUTE };

/**
 * Per-prefix timing (Run 3 C4). The first matching prefix wins. Event invalidation still
 * marks these stale whatever their staleTime, so long stale times only save idle refetches.
 */
const QUERY_TIMINGS: readonly (readonly [prefix: string, staleTime: number, gcTime: number])[] = [
  // Events and setSettingsCache keep these fresh.
  ['settings.get', Infinity, DEFAULT_QUERY_TIMING.gcTime],
  ['app.info', Infinity, DEFAULT_QUERY_TIMING.gcTime],
  ['sources.list', 5 * MINUTE, DEFAULT_QUERY_TIMING.gcTime],
  ['sources.get', 5 * MINUTE, DEFAULT_QUERY_TIMING.gcTime],
  ['catalog.categories', 5 * MINUTE, DEFAULT_QUERY_TIMING.gcTime],
  // Grid pages: back-navigation within 2 min shows the cached page without a refetch.
  ['catalog.channels', 2 * MINUTE, 10 * MINUTE],
  ['catalog.movies', 2 * MINUTE, 10 * MINUTE],
  ['catalog.series', 2 * MINUTE, 10 * MINUTE],
  ['catalog.yearFacets', 2 * MINUTE, 10 * MINUTE],
  // Guide windows are large; drop them soon after the guide closes.
  ['epg.grid', 5 * MINUTE, 2 * MINUTE],
  ['epg.programs', 5 * MINUTE, 2 * MINUTE],
  ['tmdb.', Infinity, 30 * MINUTE],
  ['positions.', 15 * SECOND, DEFAULT_QUERY_TIMING.gcTime],
  ['stats.', 15 * SECOND, DEFAULT_QUERY_TIMING.gcTime],
];

/** staleTime and gcTime for a command: its C4 table row, or {@link DEFAULT_QUERY_TIMING}. */
export function queryDefaultsFor(cmd: RpcCommand): QueryTiming {
  for (const [prefix, staleTime, gcTime] of QUERY_TIMINGS) {
    if (cmd.startsWith(prefix)) return { staleTime, gcTime };
  }
  return { ...DEFAULT_QUERY_TIMING };
}

/**
 * Applies {@link queryDefaultsFor} to every query whose key[0] is a command, including raw
 * `useQuery`/`prefetchQuery` callers. Precedence, lowest first: client defaults, the C4
 * table, `setQueryDefaults` entries, then the options passed with the query.
 */
class RpcQueryClient extends QueryClient {
  override getQueryDefaults(queryKey: QueryKey): ReturnType<QueryClient['getQueryDefaults']> {
    const registered = super.getQueryDefaults(queryKey);
    const head = queryKey[0];
    return typeof head === 'string' ? { ...queryDefaultsFor(head as RpcCommand), ...registered } : registered;
  }
}

export const queryClient: QueryClient = new RpcQueryClient({
  defaultOptions: {
    queries: {
      ...DEFAULT_QUERY_TIMING,
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
  /** Overrides the command's {@link queryDefaultsFor} staleTime. */
  staleTime?: number;
  /** Overrides the command's {@link queryDefaultsFor} gcTime. */
  gcTime?: number;
  keepPrevious?: boolean;
}

export function useRpcQuery<K extends RpcName>(
  cmd: K,
  args: RpcArgs<K>,
  opts?: RpcQueryOptions,
): UseQueryResult<RpcResult<K>, RpcError> {
  const options: UseQueryOptions<RpcResult<K>, RpcError> = {
    queryKey: rpcKey(cmd, args),
    queryFn: async () => (await rpcRaw(cmd, args)) as RpcResult<K>,
  };
  // Only set what the caller gave: an explicit `undefined` would hide the per-command defaults.
  if (opts?.enabled !== undefined) options.enabled = opts.enabled;
  if (opts?.staleTime !== undefined) options.staleTime = opts.staleTime;
  if (opts?.gcTime !== undefined) options.gcTime = opts.gcTime;
  if (opts?.keepPrevious) options.placeholderData = keepPreviousData;
  return useQuery<RpcResult<K>, RpcError>(options);
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
  // lists.: a re-import or source change can make list items (un)available.
  'sources.changed': ['catalog.', 'sources.', 'lists.'],
  'import.progress': ['catalog.', 'sources.', 'lists.'],
  'epg.changed': ['epg.'],
  'downloads.update': ['downloads.', 'myvideos.'],
  'settings.changed': ['settings.'],
  // C7: My List writes (this window or another).
  'watchlist.changed': ['watchlist.'],
  // Run 2 C10: custom list writes, and channel renames/hides (which every channel reader shows).
  'lists.changed': ['lists.'],
  'channels.changed': ['catalog.', 'channels.', 'lists.', 'favorites.', 'recent.', 'epg.search'],
  // Also covers `recordings.rules` (same prefix).
  'recordings.update': ['recordings.'],
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
