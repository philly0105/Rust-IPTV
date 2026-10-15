/**
 * The shared `watchlist.list {}` query and the writes that keep it current.
 *
 * MyListButton, MyListRail, useInMyList and the /my-list page all read this
 * one cached list, so a toggle anywhere shows everywhere at once. Writes
 * patch the cache first (optimistic), roll back on failure, and invalidate
 * every `watchlist.` query once the core has answered; `watchlist.changed`
 * then refreshes other windows and the remote.
 */

import { invalidate, queryClient, rpcKey } from '@/api/query';
import { RpcError, rpc } from '@/api/transport';
import { sameRef, type WatchlistEntry } from '@/api/types';

import { invalidateWatched } from '../deps';
import { reinsertRef } from './list';

/** Arguments of the shared query: the whole list, every source and type. */
export const LIST_ARGS: { sourceId?: string; contentType?: 'movie' | 'series' } = {};
export const LIST_KEY = rpcKey('watchlist.list', LIST_ARGS);

export function readList(): WatchlistEntry[] | undefined {
  return queryClient.getQueryData<WatchlistEntry[]>(LIST_KEY);
}

/**
 * Rewrites the cached list with `fn` and returns the previous value for a
 * rollback. Does nothing (and returns undefined) before the list has loaded.
 * A refetch already in flight is cancelled first: it was sent before this
 * change and would overwrite it with the old list when it lands.
 */
export function patchList(fn: (list: WatchlistEntry[]) => WatchlistEntry[]): WatchlistEntry[] | undefined {
  const previous = readList();
  if (previous) {
    void queryClient.cancelQueries({ queryKey: LIST_KEY });
    queryClient.setQueryData<WatchlistEntry[]>(LIST_KEY, fn(previous));
  }
  return previous;
}

/** Puts back a list saved by {@link patchList}. */
export function rollbackList(previous: WatchlistEntry[] | undefined): void {
  if (previous) queryClient.setQueryData<WatchlistEntry[]>(LIST_KEY, previous);
}

/** Refetches every `watchlist.*` query. */
export function refreshMyList(): Promise<void> {
  return invalidate('watchlist.');
}

/**
 * Refetches what a watched change touches: positions, user state, My List's
 * watched ticks, and the VOD grid pages and year counts "Hide watched" filters.
 */
export function refreshWatched(): Promise<void> {
  return invalidateWatched();
}

/**
 * Undo of a removal: adds `entry` back and moves it to `index`, its place in
 * the full list before it was removed. Adding twice would remove it again, so
 * an entry re-added in the meantime is only moved. The core stamps a fresh
 * `addedAt` (the contract has no way to restore the original date).
 */
export async function restoreEntry(entry: WatchlistEntry, index: number): Promise<void> {
  const present = await rpc('watchlist.contains', { refs: [entry.ref] });
  if (!present.some((r) => sameRef(r, entry.ref))) {
    await rpc('watchlist.toggle', { ref: entry.ref, snapshot: entry.snapshot });
  }
  // A re-add lands on top, which is index 0 already.
  if (index <= 0) return;
  const current = await rpc('watchlist.list', LIST_ARGS);
  await rpc('watchlist.reorder', { refs: reinsertRef(current.map((e) => e.ref), entry.ref, index) });
}

/**
 * A message the user can act on. `conflict` is the full list and `not_found`
 * a removed source; both get their own wording, anything else shows the
 * core's message.
 */
export function errorText(err: unknown, t: (key: string) => string): string {
  const e = RpcError.from(err);
  if (e.code === 'conflict') return t('errorFull');
  if (e.code === 'not_found') return t('errorSourceGone');
  return e.message;
}
