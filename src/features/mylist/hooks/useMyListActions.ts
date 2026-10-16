/**
 * The /my-list page's writes: remove (with Undo), mark watched (with Undo)
 * and reorder. Each one patches the shared list first so the page answers at
 * once, rolls back with a toast the user can act on when the core refuses,
 * and refetches afterwards so the cache matches the core again.
 */

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { rpc } from '@/api/transport';
import { itemKey, sameRef, type WatchlistEntry } from '@/api/types';
import { snapshotTitle } from '@/lib/title';

import { captureWatched, undoWatched, useToast } from '../deps';
import { errorText, patchList, readList, refreshMyList, refreshWatched, restoreEntry, rollbackList } from '../lib/cache';

/** Tracks in-flight writes per entry key, so a second press cannot send twice. */
function usePendingKeys() {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const live = useRef(new Set<string>());
  const run = useCallback(async (key: string, fn: () => Promise<void>): Promise<void> => {
    if (live.current.has(key)) return;
    live.current.add(key);
    setPending(new Set(live.current));
    try {
      await fn();
    } finally {
      live.current.delete(key);
      setPending(new Set(live.current));
    }
  }, []);
  return { pending, run };
}

/** Reorders waiting for the core, shared by every mounted page. */
const reorderQueue: { chain: Promise<void>; queued: number } = { chain: Promise.resolve(), queued: 0 };

export interface MyListActions {
  /** Keys of entries with a write in flight. */
  pending: ReadonlySet<string>;
  remove(entry: WatchlistEntry): void;
  toggleWatched(entry: WatchlistEntry): void;
  /** Saves `next` (the whole list in its new order). */
  reorder(next: readonly WatchlistEntry[]): void;
}

export function useMyListActions(): MyListActions {
  const { t } = useTranslation('mylist');
  const { toast } = useToast();
  const { pending, run } = usePendingKeys();

  const remove = useCallback(
    (entry: WatchlistEntry) => {
      // The title as the row shows it ("Heat", not "EN - Heat (1995)").
      const title = snapshotTitle(entry.ref, entry.snapshot.title).title;
      void run(itemKey(entry.ref), async () => {
        // The place in the full list, so Undo can put it back there.
        const index = readList()?.findIndex((e) => sameRef(e.ref, entry.ref)) ?? -1;
        const previous = patchList((l) => l.filter((e) => !sameRef(e.ref, entry.ref)));
        try {
          await rpc('watchlist.remove', { ref: entry.ref });
          toast({
            title: t('removed', { title }),
            variant: 'info',
            action: {
              label: t('undo'),
              onClick: () => {
                void restoreEntry(entry, index)
                  .catch((err: unknown) => toast({ title: t('undoFailed', { title }), description: errorText(err, t), variant: 'error' }))
                  .finally(() => void refreshMyList());
              },
            },
          });
        } catch (err) {
          rollbackList(previous);
          toast({ title: t('removeFailed', { title }), description: errorText(err, t), variant: 'error' });
        } finally {
          void refreshMyList();
        }
      });
    },
    [run, t, toast],
  );

  const toggleWatched = useCallback(
    (entry: WatchlistEntry) => {
      // The title as the row shows it ("Heat", not "EN - Heat (1995)").
      const title = snapshotTitle(entry.ref, entry.snapshot.title).title;
      const next = !entry.watched;
      const target = { ref: entry.ref };
      void run(itemKey(entry.ref), async () => {
        // The rows about to change, so Undo can put them back; without them the toast has no Undo.
        const before = await captureWatched(target).catch(() => undefined);
        const previous = patchList((l) => l.map((e) => (sameRef(e.ref, entry.ref) ? { ...e, watched: next } : e)));
        try {
          await rpc('userstate.setWatched', { ref: entry.ref, watched: next });
          toast({
            title: next ? t('markedWatched', { title }) : t('markedUnwatched', { title }),
            variant: 'success',
            ...(before
              ? {
                  action: {
                    label: t('undo'),
                    onClick: () => {
                      void undoWatched(target, before)
                        .then(
                          (ok) => {
                            if (!ok) toast({ title: t('undoFailed', { title }), variant: 'error' });
                          },
                          (err: unknown) => toast({ title: t('undoFailed', { title }), description: errorText(err, t), variant: 'error' }),
                        )
                        .finally(() => void refreshWatched());
                    },
                  },
                }
              : {}),
          });
        } catch (err) {
          rollbackList(previous);
          toast({ title: t('watchedFailed', { title }), description: errorText(err, t), variant: 'error' });
        } finally {
          void refreshWatched();
        }
      });
    },
    [run, t, toast],
  );

  const reorder = useCallback(
    (next: readonly WatchlistEntry[]) => {
      const previous = patchList(() => [...next]);
      const refs = next.map((e) => e.ref);
      reorderQueue.queued += 1;
      // One reorder at a time, in press order: a burst of Alt+Arrow presses
      // must reach the core in the order the user made them.
      reorderQueue.chain = reorderQueue.chain
        .then(() => rpc('watchlist.reorder', { refs }))
        .catch((err: unknown) => {
          rollbackList(previous);
          toast({ title: t('reorderFailed'), description: errorText(err, t), variant: 'error' });
        })
        .finally(() => {
          reorderQueue.queued -= 1;
          // Refetching while later moves wait would show an older order for a moment.
          if (reorderQueue.queued === 0) void refreshMyList();
        });
    },
    [t, toast],
  );

  return { pending, remove, toggleWatched, reorder };
}
