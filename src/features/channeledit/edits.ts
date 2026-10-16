/**
 * Reading channel edits (contract C2) and keeping the caches in step after a
 * write. Two shared queries per source: every edit (menus and the rename
 * dialog need to know whether a channel is renamed) and the hidden ones (the
 * count beside "Manage categories" and the hidden-channels dialog).
 */

import type { QueryKey } from '@tanstack/react-query';
import { useCallback } from 'react';

import { getConnectionState, onAppEvent } from '@/api/events';
import { invalidate, queryClient, rpcKey, useRpcQuery } from '@/api/query';
import { sameRef, type Channel, type ChannelEdit, type ItemRef, type Page } from '@/api/types';
import { displayChannelName } from '@/features/live/lib/channelName';
import { useSettings } from '@/shell/useSettings';

const EDITS_STALE_MS = 30_000;

/**
 * How long a `catalog.item` answer for a hidden channel stays fresh: the
 * hidden-channels rows read it for the logo and to tell whether the provider
 * still lists the channel, and the unhide toasts reuse those answers.
 */
export const ITEM_STALE_MS = 5 * 60_000;

/**
 * Query prefixes a channel edit changes: the same list `channels.changed`
 * invalidates (C10). Writes from this window refresh them at once instead of
 * waiting for the event to come back.
 */
export const EDIT_INVALIDATES: readonly string[] = ['catalog.', 'channels.', 'lists.', 'favorites.', 'recent.', 'epg.search'];

/** True for the content types the core can hide and rename (live and radio). */
export function isEditable(ref: ItemRef | undefined): boolean {
  return ref?.contentType === 'live' || ref?.contentType === 'radio';
}

/** Every edit of a source (newest first); idle without a source. */
export function useSourceEdits(sourceId: string | undefined) {
  return useRpcQuery('channels.edits', { sourceId: sourceId ?? '' }, { enabled: !!sourceId, staleTime: EDITS_STALE_MS });
}

/** The hidden channels of a source (newest first); idle without a source. */
export function useHiddenEdits(sourceId: string | undefined, enabled = true) {
  return useRpcQuery(
    'channels.edits',
    { sourceId: sourceId ?? '', hiddenOnly: true },
    { enabled: enabled && !!sourceId, staleTime: EDITS_STALE_MS },
  );
}

/**
 * How many channels of a source are hidden, for a "Hidden channels (n)"
 * entry. Undefined while unknown: no source, still loading, or the core
 * could not say.
 */
export function useHiddenChannelCount(sourceId: string | undefined): number | undefined {
  const q = useHiddenEdits(sourceId);
  return sourceId ? q.data?.length : undefined;
}

/** The edit of one channel in a source's edit list, if any. */
export function findEdit(edits: readonly ChannelEdit[] | undefined, ref: ItemRef | undefined): ChannelEdit | undefined {
  return ref ? edits?.find((e) => sameRef(e.ref, ref)) : undefined;
}

/** Refreshes everything a channel edit changes, now. */
export function afterEditChange(): Promise<void> {
  return Promise.all(EDIT_INVALIDATES.map((p) => invalidate(p))).then(() => undefined);
}

/** How long a write waits for its `channels.changed` event before refreshing on its own. */
export const EDIT_EVENT_WAIT_MS = 400;

/**
 * The event connection is open. Stand-ins for `@/api/events` that leave
 * `getConnectionState` out (several test files) throw on the call: no
 * connection, refresh here.
 */
function eventsOpen(): boolean {
  try {
    return getConnectionState() === 'open';
  } catch {
    return false;
  }
}

/** The refresh of one write: {@link EditRefresh.settle} once it landed, {@link EditRefresh.cancel} when it failed. */
export interface EditRefresh {
  settle(): Promise<void>;
  cancel(): void;
}

/**
 * One refresh per write. The core emits `channels.changed` after every channel
 * write and the app's event binding (`src/api/query.ts`) invalidates the same
 * prefixes as {@link afterEditChange}, so refreshing here as well fetched
 * every query twice. With the event connection open, a write leaves the
 * refresh to its event and refreshes on its own only when the event has not
 * come within {@link EDIT_EVENT_WAIT_MS}; with the connection down it
 * refreshes at once. Start it before the write: an event that beats the RPC
 * answer still counts.
 */
export function editRefresh(): EditRefresh {
  let seen = false;
  let wake: (() => void) | undefined;
  let off: (() => void) | null =
    eventsOpen()
      ? onAppEvent('channels.changed', () => {
          seen = true;
          wake?.();
        })
      : null;
  const stop = () => {
    off?.();
    off = null;
  };
  return {
    cancel: stop,
    settle() {
      if (!off) return afterEditChange();
      if (seen) {
        stop();
        return Promise.resolve();
      }
      if (!eventsOpen()) {
        stop();
        return afterEditChange();
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          stop();
          void afterEditChange().then(resolve);
        }, EDIT_EVENT_WAIT_MS);
        wake = () => {
          clearTimeout(timer);
          stop();
          resolve();
        };
      });
    },
  };
}

/** Cached query entries as they were, for a rollback. */
export type CacheSnapshot = [QueryKey, unknown][];

/** Puts back entries saved by {@link renameInCache} or {@link hideInCache}. */
export function restoreCache(snapshot: CacheSnapshot): void {
  for (const [key, data] of snapshot) queryClient.setQueryData(key, data);
}

const isChannelPage = (data: unknown): data is Page<Channel> =>
  typeof data === 'object' && data !== null && Array.isArray((data as Page<Channel>).items) && typeof (data as Page<Channel>).offset === 'number';

/** The cached `catalog.channels` pages of a source. */
function cachedPages(sourceId: string): [QueryKey, Page<Channel>][] {
  return queryClient
    .getQueriesData<Page<Channel>>({
      predicate: (q) => q.queryKey[0] === 'catalog.channels' && (q.queryKey[1] as { sourceId?: unknown } | undefined)?.sourceId === sourceId,
    })
    .filter((e): e is [QueryKey, Page<Channel>] => isChannelPage(e[1]));
}

/**
 * Shows a new name at once: every cached `catalog.channels` row of the
 * channel and its cached `catalog.item` answer take `name` before the write
 * lands. Returns what it changed, for {@link restoreCache}.
 */
export function renameInCache(ref: ItemRef, name: string): CacheSnapshot {
  const saved: CacheSnapshot = [];
  for (const [key, page] of cachedPages(ref.sourceId)) {
    if (!page.items.some((c) => sameRef(c.ref, ref))) continue;
    saved.push([key, page]);
    queryClient.setQueryData<Page<Channel>>(key, { ...page, items: page.items.map((c) => (sameRef(c.ref, ref) ? { ...c, name } : c)) });
  }
  const entry = rpcKey('catalog.item', { ref });
  const item = queryClient.getQueryData<Channel>(entry);
  if (item && typeof item.name === 'string') {
    saved.push([entry, item]);
    queryClient.setQueryData<Channel>(entry, { ...item, name });
  }
  return saved;
}

/** A page's list without its paging: pages of one list share it. */
function listOf(key: QueryKey): string {
  const { query, ...rest } = (key[1] ?? {}) as { query?: Record<string, unknown> };
  const q = { ...query };
  delete q['offset'];
  delete q['limit'];
  return JSON.stringify([rest, q]);
}

/**
 * Takes a channel out of the cached `catalog.channels` pages at once: its row
 * goes, the list's `total` drops by one, and later pages of the same list
 * move up a place, so the rows below close the gap. Lists whose cached pages
 * do not hold the channel are left to the refresh. Returns what it changed,
 * for {@link restoreCache}.
 */
export function hideInCache(ref: ItemRef): CacheSnapshot {
  const saved: CacheSnapshot = [];
  const byList = new Map<string, [QueryKey, Page<Channel>][]>();
  for (const entry of cachedPages(ref.sourceId)) {
    const list = listOf(entry[0]);
    byList.set(list, [...(byList.get(list) ?? []), entry]);
  }
  for (const pages of byList.values()) {
    let at = -1;
    for (const [, page] of pages) {
      const i = page.items.findIndex((c) => sameRef(c.ref, ref));
      if (i >= 0) at = page.offset + i;
    }
    if (at < 0) continue;
    for (const [key, page] of pages) {
      const items = page.items.filter((c) => !sameRef(c.ref, ref));
      saved.push([key, page]);
      queryClient.setQueryData<Page<Channel>>(key, {
        ...page,
        items,
        total: Math.max(0, page.total - 1),
        offset: page.offset > at ? page.offset - 1 : page.offset,
      });
    }
  }
  return saved;
}

/**
 * Patches the cached hidden list of a source so the dialog and the count
 * answer before the refetch. Returns the list as it was, for a rollback.
 */
export function patchHidden(sourceId: string, fn: (list: ChannelEdit[]) => ChannelEdit[]): ChannelEdit[] | undefined {
  const key = rpcKey('channels.edits', { sourceId, hiddenOnly: true });
  const before = queryClient.getQueryData<ChannelEdit[]>(key);
  if (before) queryClient.setQueryData<ChannelEdit[]>(key, fn(before));
  return before;
}

/** Puts back a list saved by {@link patchHidden}. */
export function restoreHidden(sourceId: string, list: ChannelEdit[] | undefined): void {
  if (list) queryClient.setQueryData(rpcKey('channels.edits', { sourceId, hiddenOnly: true }), list);
}

/** A channel name as the app shows it, with the country tag stripped when Settings say so. */
export function useDisplayName(): (name: string) => string {
  const strip = useSettings().data?.stripCountryPrefix;
  return useCallback((name: string) => displayChannelName(name, strip), [strip]);
}
