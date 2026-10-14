/**
 * The add/remove action behind MyListButton and the My List menu item.
 *
 * The change shows at once (optimistic patch of the shared list) and rolls
 * back with an error toast the user can act on when the core refuses it.
 * Adding offers "Open My List"; removing offers Undo, which puts the title
 * back in its old place.
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { rpc } from '@/api/transport';
import { itemKey, sameRef, type ItemRef, type ItemSnapshot } from '@/api/types';

import { useToast } from '../deps';
import { errorText, patchList, readList, refreshMyList, restoreEntry, rollbackList } from '../lib/cache';
import { canSave, draftEntry } from '../lib/list';
import { MY_LIST_PATH } from '../paths';

/**
 * Titles with a toggle in flight, app-wide: a poster button and the detail
 * page button for the same title must not send two toggles that cancel out.
 */
const inFlight = new Set<string>();

/** True while a toggle of `ref` waits for the core. */
export function isToggling(ref: ItemRef): boolean {
  return inFlight.has(itemKey(ref));
}

/**
 * Returns `toggle(ref, snapshot)`, which resolves to the new state (`true` =
 * now in My List), or `undefined` when nothing was sent: a live or radio ref,
 * a toggle of the same title already in flight, or a failure (already shown
 * as a toast).
 */
export function useMyListToggle(): (itemRef: ItemRef, snapshot: ItemSnapshot) => Promise<boolean | undefined> {
  const { t } = useTranslation('mylist');
  const { toast } = useToast();
  const navigate = useNavigate();

  return useCallback(
    async (itemRef: ItemRef, snapshot: ItemSnapshot) => {
      const key = itemKey(itemRef);
      if (!canSave(itemRef) || inFlight.has(key)) return undefined;
      inFlight.add(key);
      const title = snapshot.title;
      const list = readList();
      const index = list?.findIndex((x) => sameRef(x.ref, itemRef)) ?? -1;
      const removed = index >= 0 ? list![index] : undefined;
      const previous = patchList((l) => (removed ? l.filter((x) => !sameRef(x.ref, itemRef)) : [draftEntry(itemRef, snapshot), ...l]));
      try {
        const { inList } = await rpc('watchlist.toggle', { ref: itemRef, snapshot });
        if (inList) {
          toast({
            title: t('added', { title }),
            variant: 'success',
            action: { label: t('openList'), onClick: () => void navigate(MY_LIST_PATH) },
          });
        } else {
          const entry = removed ?? draftEntry(itemRef, snapshot);
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
        }
        return inList;
      } catch (err) {
        rollbackList(previous);
        toast({ title: t('toggleFailed', { title }), description: errorText(err, t), variant: 'error' });
        return undefined;
      } finally {
        inFlight.delete(key);
        void refreshMyList();
      }
    },
    [navigate, t, toast],
  );
}
