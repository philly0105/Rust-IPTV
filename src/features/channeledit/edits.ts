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
import { rpc } from '@/api/transport';
import { itemKey, sameRef, type Channel, type ChannelEdit, type ItemRef, type Page } from '@/api/types';
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

/**
 * Starts the source's edit list while the rename dialog is still on its way,
 * so the dialog's own query joins it instead of asking after mount.
 */
export function prefetchSourceEdits(sourceId: string): void {
  const args = { sourceId };
  void queryClient.prefetchQuery({ queryKey: rpcKey('channels.edits', args), queryFn: () => rpc('channels.edits', args), staleTime: EDITS_STALE_MS });
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

/** The cached `catalog.channels` pages of a source, by list. */
function cachedLists(sourceId: string): Map<string, [QueryKey, Page<Channel>][]> {
  const byList = new Map<string, [QueryKey, Page<Channel>][]>();
  for (const entry of cachedPages(sourceId)) {
    const list = listOf(entry[0]);
    byList.set(list, [...(byList.get(list) ?? []), entry]);
  }
  return byList;
}

/** The row at list index `i`, when a cached page holds it. */
function rowAt(pages: readonly [QueryKey, Page<Channel>][], i: number): Channel | undefined {
  for (const [, page] of pages) {
    const j = i - page.offset;
    if (j >= 0 && j < page.items.length) return page.items[j];
  }
  return undefined;
}

/** Where a channel this window hid stood, per list: the rows just above and below it. */
interface HiddenPlace {
  channel: Channel;
  lists: Map<string, { above?: ItemRef; below?: ItemRef }>;
}
const hiddenPlaces = new Map<string, HiddenPlace>();
const HIDDEN_PLACES_LIMIT = 100;

function rememberPlace(channel: Channel, list: string, above: ItemRef | undefined, below: ItemRef | undefined): void {
  const key = itemKey(channel.ref);
  const place = hiddenPlaces.get(key) ?? { channel, lists: new Map() };
  place.channel = channel;
  place.lists.set(list, { above, below });
  hiddenPlaces.delete(key);
  hiddenPlaces.set(key, place);
  if (hiddenPlaces.size > HIDDEN_PLACES_LIMIT) hiddenPlaces.delete(hiddenPlaces.keys().next().value!);
}

/** Tests: forget where hidden channels stood. */
export function __resetHiddenPlaces(): void {
  hiddenPlaces.clear();
}

/** True when `channel` is a row of the list these args page (playlist order, no search). */
function belongsTo(args: unknown, channel: Channel): boolean {
  const a = (args ?? {}) as { categoryId?: string; radio?: boolean; query?: { search?: string; sort?: string } };
  if (a.query?.search || a.query?.sort) return false;
  if (a.categoryId !== undefined && a.categoryId !== channel.categoryId) return false;
  return channel.ref.contentType === (a.radio ? 'radio' : 'live');
}

/**
 * Where `channel` goes back in a list's cached pages, or -1 when they cannot
 * tell. Beside the rows that flanked it when this window hid it, else by
 * channel number between two loaded neighbours (rows run in playlist order,
 * which providers number upwards).
 */
function placeIn(pages: readonly [QueryKey, Page<Channel>][], channel: Channel, list: string): number {
  const indexOf = (ref: ItemRef | undefined): number => {
    if (!ref) return -1;
    for (const [, page] of pages) {
      const i = page.items.findIndex((c) => sameRef(c.ref, ref));
      if (i >= 0) return page.offset + i;
    }
    return -1;
  };
  const was = hiddenPlaces.get(itemKey(channel.ref))?.lists.get(list);
  if (was) {
    const above = indexOf(was.above);
    if (above >= 0) return above + 1;
    const below = indexOf(was.below);
    if (below >= 0) return below;
  }
  const n = channel.number;
  if (n === undefined) return -1;
  const total = pages[0]?.[1].total ?? 0;
  for (const [, page] of pages) {
    for (let j = 0; j < page.items.length; j++) {
      const i = page.offset + j;
      const here = page.items[j]!.number;
      if (here === undefined || here <= n) continue;
      if (i === 0) return 0;
      const prev = rowAt(pages, i - 1)?.number;
      if (prev !== undefined && prev <= n) return i;
    }
  }
  const last = rowAt(pages, total - 1)?.number;
  return last !== undefined && last <= n ? total : -1;
}

/**
 * Puts an unhidden channel back into the cached `catalog.channels` pages at
 * once, the inverse of {@link hideInCache}: its row returns where it stood,
 * the list's `total` grows by one and later pages move down a place. The
 * channel comes from where this window hid it or from its cached
 * `catalog.item` answer (the hidden-channels rows ask it); without either,
 * or in a list whose cached rows cannot place it (a search, another sort),
 * the refresh brings it. Returns what it changed, for {@link restoreCache}.
 */
export function unhideInCache(ref: ItemRef): CacheSnapshot {
  const item = queryClient.getQueryData<Channel>(rpcKey('catalog.item', { ref }));
  const channel = hiddenPlaces.get(itemKey(ref))?.channel ?? (item && typeof item.categoryId === 'string' ? item : undefined);
  const saved: CacheSnapshot = [];
  if (!channel) return saved;
  for (const [list, pages] of cachedLists(ref.sourceId)) {
    if (!belongsTo(pages[0]?.[0][1], channel)) continue;
    if (pages.some(([, page]) => page.items.some((c) => sameRef(c.ref, ref)))) continue;
    const at = placeIn(pages, channel, list);
    if (at < 0) continue;
    const host =
      pages.find(([, p]) => at >= p.offset && at < p.offset + p.items.length) ?? pages.find(([, p]) => at === p.offset + p.items.length);
    for (const [key, page] of pages) {
      saved.push([key, page]);
      const items = page === host?.[1] ? [...page.items.slice(0, at - page.offset), channel, ...page.items.slice(at - page.offset)] : page.items;
      queryClient.setQueryData<Page<Channel>>(key, {
        ...page,
        items,
        total: page.total + 1,
        offset: page !== host?.[1] && page.offset >= at ? page.offset + 1 : page.offset,
      });
    }
  }
  return saved;
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
  for (const [list, pages] of cachedLists(ref.sourceId)) {
    let at = -1;
    for (const [, page] of pages) {
      const i = page.items.findIndex((c) => sameRef(c.ref, ref));
      if (i >= 0) at = page.offset + i;
    }
    if (at < 0) continue;
    const channel = rowAt(pages, at);
    if (channel) rememberPlace(channel, list, rowAt(pages, at - 1)?.ref, rowAt(pages, at + 1)?.ref);
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
