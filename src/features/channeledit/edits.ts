/**
 * Reading channel edits (contract C2) and keeping the caches in step after a
 * write. Two shared queries per source: every edit (menus and the rename
 * dialog need to know whether a channel is renamed) and the hidden ones (the
 * count beside "Manage categories" and the hidden-channels dialog).
 */

import { useCallback } from 'react';

import { invalidate, queryClient, rpcKey, useRpcQuery } from '@/api/query';
import { sameRef, type ChannelEdit, type ItemRef } from '@/api/types';
import { displayChannelName } from '@/features/live/lib/channelName';
import { useSettings } from '@/shell/useSettings';

const EDITS_STALE_MS = 30_000;

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

/** Refreshes everything a channel edit changes. */
export function afterEditChange(): Promise<void> {
  return Promise.all(EDIT_INVALIDATES.map((p) => invalidate(p))).then(() => undefined);
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
