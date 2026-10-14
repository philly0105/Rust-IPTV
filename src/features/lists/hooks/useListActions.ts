/**
 * Every lists write: create, rename, Home rail, delete (with Undo), reorder
 * lists, add/remove a channel, remove entries (with Undo) and reorder a list's
 * channels. Each one patches the shared cache first, rolls back with a toast
 * the user can act on when the core refuses, and refetches `lists.` after.
 */

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { queryClient, rpcKey } from '@/api/query';
import { rpc } from '@/api/transport';
import { itemKey, sameRef, type Channel, type CustomList, type CustomListEntry, type ItemRef } from '@/api/types';

import { useToast } from '../deps';
import {
  entrySnapshot,
  errorText,
  patchItems,
  patchLists,
  readItems,
  readLists,
  refreshLists,
  reinsert,
  rollbackItems,
  rollbackLists,
  withSnapshot,
} from '../lib/cache';

/** Writes that must reach the core in press order (a burst of Alt+Arrow presses). */
function createQueue() {
  const q = { chain: Promise.resolve(), queued: 0 };
  return (fn: () => Promise<void>, onError: (err: unknown) => void) => {
    q.queued += 1;
    q.chain = q.chain
      .then(fn)
      .catch(onError)
      .finally(() => {
        q.queued -= 1;
        // Refetching while later moves wait would flash an older order.
        if (q.queued === 0) void refreshLists();
      });
  };
}
const listOrderQueue = createQueue();
const itemOrderQueue = createQueue();

const containingKey = (ref: ItemRef) => rpcKey('lists.containing', { ref });

/** Brings back a deleted list: same name, channels, Home rail and place. Returns the new list. */
export async function restoreList(list: CustomList, entries: readonly CustomListEntry[], index: number): Promise<CustomList> {
  const created = await rpc('lists.create', { name: list.name, items: entries.map(entrySnapshot) });
  let out = created;
  if (list.onDashboard && !created.onDashboard) out = await rpc('lists.update', { id: created.id, onDashboard: true });
  const current = await rpc('lists.list');
  const ids = current.map((l) => l.id);
  const wanted = reinsert(ids, created.id, index, (x, y) => x === y);
  if (wanted.some((id, i) => id !== ids[i])) await rpc('lists.reorder', { ids: wanted });
  return out;
}

export interface ListActions {
  create(name: string, channel?: Channel): Promise<CustomList>;
  rename(list: CustomList, name: string): Promise<boolean>;
  setOnDashboard(list: CustomList, on: boolean): void;
  remove(list: CustomList, onRestored?: (restored: CustomList) => void): void;
  /** Saves `next`, every list in its new order. */
  reorder(next: readonly CustomList[]): void;
  /** Adds or removes `channel` from `list` (picker check box). */
  setMember(list: CustomList, channel: Channel, member: boolean): Promise<boolean>;
  /** Removes entries from a list with one Undo for all of them. */
  removeEntries(list: Pick<CustomList, 'id' | 'name'>, entries: readonly CustomListEntry[], label: string): void;
  /** Saves `next`, the whole list's entries in their new order. */
  reorderEntries(listId: string, next: readonly CustomListEntry[]): void;
}

export function useListActions(): ListActions {
  const { t } = useTranslation('lists');
  const { toast } = useToast();

  const create = useCallback(
    async (name: string, channel?: Channel) => {
      const trimmed = name.trim();
      try {
        const list = await rpc('lists.create', { name: trimmed, ...(channel ? { items: [withSnapshot(channel)] } : {}) });
        patchLists((ls) => (ls.some((l) => l.id === list.id) ? ls : [...ls, list]));
        if (channel) {
          queryClient.setQueryData<string[]>(containingKey(channel.ref), (ids) => (ids ? [...new Set([...ids, list.id])] : ids));
        }
        return list;
      } finally {
        void refreshLists();
      }
    },
    [],
  );

  const rename = useCallback(
    async (list: CustomList, name: string) => {
      const trimmed = name.trim();
      if (trimmed === list.name) return true;
      const previous = patchLists((ls) => ls.map((l) => (l.id === list.id ? { ...l, name: trimmed } : l)));
      try {
        await rpc('lists.update', { id: list.id, name: trimmed });
        toast({ title: t('renamed', { list: trimmed }), variant: 'success' });
        return true;
      } catch (err) {
        rollbackLists(previous);
        toast({ title: t('renameFailed', { list: list.name }), description: errorText(err, t), variant: 'error' });
        return false;
      } finally {
        void refreshLists();
      }
    },
    [t, toast],
  );

  const setOnDashboard = useCallback(
    (list: CustomList, on: boolean) => {
      const previous = patchLists((ls) => ls.map((l) => (l.id === list.id ? { ...l, onDashboard: on } : l)));
      rpc('lists.update', { id: list.id, onDashboard: on })
        .catch((err: unknown) => {
          rollbackLists(previous);
          toast({ title: t('dashboardFailed', { list: list.name }), description: errorText(err, t), variant: 'error' });
        })
        .finally(() => void refreshLists());
    },
    [t, toast],
  );

  const remove = useCallback(
    (list: CustomList, onRestored?: (restored: CustomList) => void) => {
      void (async () => {
        const index = readLists()?.findIndex((l) => l.id === list.id) ?? -1;
        // The channels, captured before they go, so Undo can bring them back.
        const entries = await rpc('lists.items', { id: list.id }).catch(() => readItems(list.id));
        const previous = patchLists((ls) => ls.filter((l) => l.id !== list.id));
        try {
          await rpc('lists.remove', { id: list.id });
          toast({
            title: t('deleted', { list: list.name }),
            variant: 'info',
            ...(entries
              ? {
                  action: {
                    label: t('undo'),
                    onClick: () => {
                      restoreList(list, entries, Math.max(0, index))
                        .then((restored) => onRestored?.(restored))
                        .catch((err: unknown) =>
                          toast({ title: t('undoFailed', { list: list.name }), description: errorText(err, t), variant: 'error' }),
                        )
                        .finally(() => void refreshLists());
                    },
                  },
                }
              : {}),
          });
        } catch (err) {
          rollbackLists(previous);
          toast({ title: t('deleteFailed', { list: list.name }), description: errorText(err, t), variant: 'error' });
        } finally {
          void refreshLists();
        }
      })();
    },
    [t, toast],
  );

  const reorder = useCallback(
    (next: readonly CustomList[]) => {
      const previous = patchLists(() => next.map((l, position) => ({ ...l, position })));
      const ids = next.map((l) => l.id);
      listOrderQueue(
        () => rpc('lists.reorder', { ids }),
        (err) => {
          rollbackLists(previous);
          toast({ title: t('reorderFailed'), description: errorText(err, t), variant: 'error' });
        },
      );
    },
    [t, toast],
  );

  const setMember = useCallback(
    async (list: CustomList, channel: Channel, member: boolean) => {
      const key = containingKey(channel.ref);
      const before = queryClient.getQueryData<string[]>(key);
      void queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<string[]>(key, (ids = []) => (member ? [...new Set([...ids, list.id])] : ids.filter((id) => id !== list.id)));
      const previous = patchLists((ls) =>
        ls.map((l) => (l.id === list.id ? { ...l, itemCount: Math.max(0, l.itemCount + (member ? 1 : -1)) } : l)),
      );
      try {
        if (member) await rpc('lists.addItems', { id: list.id, items: [withSnapshot(channel)] });
        else await rpc('lists.removeItems', { id: list.id, refs: [channel.ref] });
        return true;
      } catch (err) {
        queryClient.setQueryData(key, before);
        rollbackLists(previous);
        toast({
          title: member ? t('addFailed', { list: list.name }) : t('removeFailed', { list: list.name }),
          description: errorText(err, t, 'items'),
          variant: 'error',
        });
        return false;
      } finally {
        void refreshLists();
      }
    },
    [t, toast],
  );

  const removeEntries = useCallback(
    (list: Pick<CustomList, 'id' | 'name'>, entries: readonly CustomListEntry[], label: string) => {
      if (entries.length === 0) return;
      const all = readItems(list.id);
      // Each entry's place in the full list, so Undo can put it back there.
      const places = entries.map((e) => ({ entry: e, index: all?.findIndex((x) => sameRef(x.ref, e.ref)) ?? -1 }));
      const gone = new Set(entries.map((e) => itemKey(e.ref)));
      const previous = patchItems(list.id, (items) => items.filter((e) => !gone.has(itemKey(e.ref))));
      const previousLists = patchLists((ls) =>
        ls.map((l) => (l.id === list.id ? { ...l, itemCount: Math.max(0, l.itemCount - entries.length) } : l)),
      );
      rpc('lists.removeItems', { id: list.id, refs: entries.map((e) => e.ref) })
        .then(() =>
          toast({
            title: t('removedFrom', { name: label, list: list.name }),
            variant: 'info',
            action: {
              label: t('undo'),
              onClick: () => {
                void (async () => {
                  await rpc('lists.addItems', { id: list.id, items: entries.map(entrySnapshot) });
                  const current = await rpc('lists.items', { id: list.id });
                  let refs = current.map((e) => e.ref);
                  for (const { entry, index } of [...places].sort((x, y) => x.index - y.index)) {
                    if (index >= 0) refs = reinsert(refs, entry.ref, index, sameRef);
                  }
                  if (refs.some((r, i) => !sameRef(r, current[i]!.ref))) await rpc('lists.reorderItems', { id: list.id, refs });
                })()
                  .catch((err: unknown) =>
                    toast({ title: t('undoRemoveFailed', { name: label }), description: errorText(err, t, 'items'), variant: 'error' }),
                  )
                  .finally(() => void refreshLists());
              },
            },
          }),
        )
        .catch((err: unknown) => {
          rollbackItems(list.id, previous);
          rollbackLists(previousLists);
          toast({ title: t('removeEntryFailed', { name: label }), description: errorText(err, t, 'items'), variant: 'error' });
        })
        .finally(() => void refreshLists());
    },
    [t, toast],
  );

  const reorderEntries = useCallback(
    (listId: string, next: readonly CustomListEntry[]) => {
      const previous = patchItems(listId, () => next.map((e, position) => ({ ...e, position })));
      const refs = next.map((e) => e.ref);
      itemOrderQueue(
        () => rpc('lists.reorderItems', { id: listId, refs }),
        (err) => {
          rollbackItems(listId, previous);
          toast({ title: t('reorderFailed'), description: errorText(err, t, 'items'), variant: 'error' });
        },
      );
    },
    [t, toast],
  );

  return useMemo(
    () => ({ create, rename, setOnDashboard, remove, reorder, setMember, removeEntries, reorderEntries }),
    [create, rename, setOnDashboard, remove, reorder, setMember, removeEntries, reorderEntries],
  );
}
