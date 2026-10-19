/**
 * The shared `lists.list` and `lists.items` queries, and the helpers every
 * write uses to keep them current.
 *
 * Writes patch the cache first (the UI answers at once), roll back when the
 * core refuses, and refetch every `lists.` query once the core has answered.
 * `lists.changed` (and `channels.changed`, since renames and hidden channels
 * change what `lists.items` returns) then refresh other windows.
 */

import { invalidateWithEvents, queryClient, rpcKey } from '@/api/query';
import { RpcError } from '@/api/transport';
import type { Channel, CustomList, CustomListEntry, ItemRef, ItemSnapshot } from '@/api/types';
import type { RefWithSnapshot } from '@/api/rpc';
import { hasLineBreak, isBlankName, trimName } from '@/lib/names';

/** The contract's limits (crates/iptv-core/src/lists). */
export const MAX_LISTS = 50;
export const MAX_ITEMS = 2000;
export const MAX_NAME = 60;

export const LISTS_KEY = rpcKey('lists.list', undefined);
export const itemsKey = (id: string) => rpcKey('lists.items', { id });

export function readLists(): CustomList[] | undefined {
  return queryClient.getQueryData<CustomList[]>(LISTS_KEY);
}

/**
 * Rewrites the cached lists with `fn` and returns the previous value for a
 * rollback. A refetch in flight is cancelled first: it was sent before this
 * change and would put the old value back when it lands.
 */
export function patchLists(fn: (lists: CustomList[]) => CustomList[]): CustomList[] | undefined {
  const previous = readLists();
  if (previous) {
    void queryClient.cancelQueries({ queryKey: LISTS_KEY });
    queryClient.setQueryData<CustomList[]>(LISTS_KEY, fn(previous));
  }
  return previous;
}

export function rollbackLists(previous: CustomList[] | undefined): void {
  if (previous) queryClient.setQueryData<CustomList[]>(LISTS_KEY, previous);
}

export function readItems(id: string): CustomListEntry[] | undefined {
  return queryClient.getQueryData<CustomListEntry[]>(itemsKey(id));
}

export function patchItems(id: string, fn: (items: CustomListEntry[]) => CustomListEntry[]): CustomListEntry[] | undefined {
  const previous = readItems(id);
  if (previous) {
    void queryClient.cancelQueries({ queryKey: itemsKey(id) });
    queryClient.setQueryData<CustomListEntry[]>(itemsKey(id), fn(previous));
  }
  return previous;
}

export function rollbackItems(id: string, previous: CustomListEntry[] | undefined): void {
  if (previous) queryClient.setQueryData<CustomListEntry[]>(itemsKey(id), previous);
}

/**
 * Refetches every `lists.*` query, in one round with the `lists.changed` the write emits (LV-8:
 * each write used to refetch them twice).
 */
export function refreshLists(): Promise<void> {
  return invalidateWithEvents('lists.');
}

/** What the core stores next to a channel: its title and logo stay readable after the provider drops it. */
export function snapshotOf(channel: Channel): ItemSnapshot {
  return {
    title: channel.name,
    ...(channel.categoryName ? { subtitle: channel.categoryName } : {}),
    ...(channel.logoUrl ? { posterUrl: channel.logoUrl } : {}),
    contentType: channel.ref.contentType,
  };
}

export function withSnapshot(channel: Channel): RefWithSnapshot {
  return { ref: channel.ref, snapshot: snapshotOf(channel) };
}

/** The entry's own ref and snapshot, for Undo of a removal. */
export function entrySnapshot(entry: CustomListEntry): RefWithSnapshot {
  return { ref: entry.ref, snapshot: entry.snapshot };
}

/** Only live channels and radio stations go in a list. */
export function canList(ref: ItemRef | undefined): boolean {
  return !!ref && (ref.contentType === 'live' || ref.contentType === 'radio');
}

/** Moves the element at `from` to `to` (both clamped), returning a new array. */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item!);
  return out;
}

/** Puts `item` back at `index` (clamped) in `list`, unless an equal item is already there. */
export function reinsert<T>(list: readonly T[], item: T, index: number, same: (a: T, b: T) => boolean): T[] {
  const out = list.filter((x) => !same(x, item));
  out.splice(Math.max(0, Math.min(out.length, index)), 0, item);
  return out;
}

/** Whether two list names are the same to the core (trimmed, without regard to case). */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

/**
 * Trims and checks a list name the way the core does (`lists::clean_name`):
 * something visible (a name of only zero-width or other invisible characters
 * is empty), no control character or line break, at most {@link MAX_NAME}
 * characters, in that order. Returns an i18n key for the problem, or null.
 */
export function nameProblem(raw: string, lists: readonly CustomList[] | undefined, exceptId?: string): string | null {
  const name = trimName(raw);
  if (isBlankName(name)) return 'errorNameEmpty';
  if (hasLineBreak(name)) return 'errorNameControl';
  if ([...name].length > MAX_NAME) return 'errorNameLong';
  if (lists?.some((l) => l.id !== exceptId && sameName(l.name, name))) return 'errorDuplicate';
  return null;
}

/**
 * The core's `invalid` messages that have wording of their own
 * (crates/iptv-core/src/lists/mod.rs), matched exactly so that one problem is
 * never reported as another.
 */
const INVALID_MESSAGES: { pattern: RegExp; key: string; opts?: Record<string, unknown> }[] = [
  { pattern: /^name is required/, key: 'errorNameEmpty' },
  { pattern: /^name must not contain control characters/, key: 'errorNameControl' },
  { pattern: /^name must be at most \d+ characters/, key: 'errorNameLong', opts: { max: MAX_NAME } },
  { pattern: /^there can be at most \d+ lists/, key: 'errorTooMany', opts: { max: MAX_LISTS } },
  { pattern: /^a list holds at most \d+ channels|^items must hold at most \d+ entries/, key: 'errorListFull', opts: { max: MAX_ITEMS } },
];

/**
 * A message the user can act on. The core answers `conflict` for a taken name,
 * `not_found` for a list deleted elsewhere and `invalid` for the limits and a
 * bad name; each of those gets its own wording, anything else shows the
 * core's message.
 */
export function errorText(err: unknown, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const e = RpcError.from(err);
  if (e.code === 'conflict') return t('errorDuplicate');
  // `not_found` also covers a source removed meanwhile; only a missing list has its own wording.
  if (e.code === 'not_found' && /^list /.test(e.message)) return t('errorGone');
  if (e.code === 'invalid') {
    const known = INVALID_MESSAGES.find((x) => x.pattern.test(e.message));
    if (known) return t(known.key, known.opts);
  }
  return e.message;
}
