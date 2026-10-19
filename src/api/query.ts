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

import { desktopAppInfo } from './bootInfo';
import { onAnyAppEvent } from './events';
import { RpcError, rpcRaw, type RpcArgs, type RpcName, type RpcResult } from './transport';
import type { Settings } from './types';

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
  // Guide windows: kept as long as they count as fresh, so reopening the guide
  // within 5 min shows the cached window instead of refetching a fresh one
  // that was already dropped (L2-perf-ui-10).
  ['epg.grid', 5 * MINUTE, 5 * MINUTE],
  ['epg.programs', 5 * MINUTE, 5 * MINUTE],
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

// Desktop: the launch's one `app.info` answer (bootInfo.ts) fills the cache before the first
// render, so `useRpcQuery('app.info')` readers never send a second request (L2-perf-desktop-10).
void desktopAppInfo.then((info) => {
  if (info && queryClient.getQueryData(rpcKey('app.info')) === undefined) queryClient.setQueryData(rpcKey('app.info'), info);
});

export interface RpcQueryOptions {
  enabled?: boolean;
  /** Overrides the command's {@link queryDefaultsFor} staleTime. */
  staleTime?: number;
  /** Overrides the command's {@link queryDefaultsFor} gcTime. */
  gcTime?: number;
  keepPrevious?: boolean;
  /**
   * Hashes the query key in place of TanStack's own. It must return the same hash as `hashKey` for
   * the same key, so other readers of the command share the cache entry; useWatchedKeys caches it.
   */
  queryKeyHashFn?: (key: QueryKey) => string;
}

export function useRpcQuery<K extends RpcName>(
  cmd: K,
  args: RpcArgs<K>,
  opts?: RpcQueryOptions,
): UseQueryResult<RpcResult<K>, RpcError> {
  const options: UseQueryOptions<RpcResult<K>, RpcError> = {
    queryKey: rpcKey(cmd, args),
    // The signal aborts a refetch that a newer invalidation or an unmount replaced.
    queryFn: async ({ signal }) => (await rpcRaw(cmd, args, { signal })) as RpcResult<K>,
  };
  // Only set what the caller gave: an explicit `undefined` would hide the per-command defaults.
  if (opts?.enabled !== undefined) options.enabled = opts.enabled;
  if (opts?.staleTime !== undefined) options.staleTime = opts.staleTime;
  if (opts?.gcTime !== undefined) options.gcTime = opts.gcTime;
  if (opts?.keepPrevious) options.placeholderData = keepPreviousData;
  if (opts?.queryKeyHashFn) options.queryKeyHashFn = opts.queryKeyHashFn;
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

function matchesAny(prefixes: ReadonlySet<string>): (q: { queryKey: QueryKey }) => boolean {
  return (q) => {
    const head = q.queryKey[0];
    if (typeof head !== 'string') return false;
    for (const p of prefixes) if (head.startsWith(p)) return true;
    return false;
  };
}

/**
 * How long an event burst collects invalidations before one refetch round. The core sends
 * related events back to back (`import.progress` done, then `sources.changed`); without this
 * each one cancelled and restarted the same refetches.
 */
export const EVENT_BURST_MS = 50;

interface Burst {
  prefixes: Set<string>;
  all: boolean;
  done: Promise<void>;
}

let burst: Burst | null = null;

/** The open burst, or a new one that flushes after {@link EVENT_BURST_MS}. */
function openBurst(): Burst {
  if (burst) return burst;
  let resolve!: () => void;
  const b: Burst = { prefixes: new Set(), all: false, done: new Promise<void>((r) => (resolve = r)) };
  burst = b;
  setTimeout(() => {
    burst = null;
    const run = b.all ? queryClient.invalidateQueries() : queryClient.invalidateQueries({ predicate: matchesAny(b.prefixes) });
    void run.then(resolve, resolve);
  }, EVENT_BURST_MS);
  return b;
}

/**
 * Invalidates queries whose key[0] starts with `prefix` (e.g. 'xtream.' or 'sources.list').
 * While an event burst is open (an event handler calling this), the prefix joins the burst's
 * single refetch round and the promise resolves when that round has refetched.
 */
export function invalidate(prefix: string): Promise<void> {
  if (burst) {
    burst.prefixes.add(prefix);
    return burst.done;
  }
  return queryClient.invalidateQueries({ predicate: matchesAny(new Set([prefix])) });
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
  // The list only: a progress tick cannot change downloads.dir, and the prefix refetched it on every burst.
  'downloads.update': ['downloads.list', 'myvideos.'],
  // Only without a payload: the event normally carries the full settings, written into the cache.
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
    const p = event.payload as { phase?: unknown; message?: unknown } | null | undefined;
    if (p?.phase !== 'done') return [];
    // The core kept the catalog (the playlist did not change): only the source's import time moved.
    if (p.message === 'unchanged') return ['sources.'];
  }
  if (event.type === 'sources.changed') {
    const reason = (event.payload as { reason?: unknown } | null | undefined)?.reason;
    // A new source has no catalog yet, and a status change (a failed or cancelled import, a
    // schedule backoff) leaves the catalog as it was: only the sources list moved, so the
    // catalog and the caller's extra prefixes are skipped. 'catalog', 'config', 'removed' and
    // an older core's '{}' keep the full set.
    if (reason === 'added' || reason === 'status') return ['sources.'];
  }
  // A refresh started or ended on a 304: only the url's status moved, so the guide windows and
  // now/next answers stay; refetching them here doubled every refresh's refetch rounds (EP-2).
  if (event.type === 'epg.changed' && (event.payload as { reason?: unknown } | null | undefined)?.reason === 'status') {
    return ['epg.sources'];
  }
  const defaults = event.type === 'settings.changed' && isSettingsPayload(event.payload) ? [] : (DEFAULT_EVENT_INVALIDATION[event.type] ?? []);
  return [...new Set([...defaults, ...(extra[event.type] ?? [])])];
}

/**
 * Like {@link invalidate}, but the refetch joins the open event burst, or opens one: a write's own
 * refresh and the change event the core sends for it, a moment before or after the reply, then
 * share one refetch round instead of asking twice (LV-8).
 */
export function invalidateWithEvents(prefix: string): Promise<void> {
  const b = openBurst();
  b.prefixes.add(prefix);
  return b.done;
}

/** `settings.changed` carries the settings `settings.get` returns (core `for_client`). */
function isSettingsPayload(payload: unknown): payload is Settings {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload);
}

/**
 * Wires event types to query prefixes, e.g. `{ 'sources.changed': ['favorites.'] }`, on top of
 * {@link DEFAULT_EVENT_INVALIDATION}. Returns an unsubscribe function. Call once from the app shell.
 */
export function bindEventInvalidation(map: Record<string, readonly string[]> = {}): () => void {
  return onAnyAppEvent((event) => {
    // Written before any refetch, so readers see the new settings in the same tick.
    if (event.type === 'settings.changed' && isSettingsPayload(event.payload)) {
      queryClient.setQueryData(rpcKey('settings.get'), event.payload);
    }
    if (INVALIDATE_ALL_EVENTS.has(event.type)) {
      openBurst().all = true;
      return;
    }
    const prefixes = invalidationPrefixes(event, map);
    if (prefixes.length === 0) return;
    const b = openBurst();
    for (const p of prefixes) b.prefixes.add(p);
  });
}
