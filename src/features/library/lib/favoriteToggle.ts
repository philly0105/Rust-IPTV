/**
 * The one favourite toggle behind every heart outside the Favorites page (Live rows and menu, the
 * guide, lists, the player's menu, title pages): it names what changed in the toast, and a removal
 * carries an Undo that puts the favourite back in its old place, as the Favorites page's does. A
 * toggle alone would add it at the end of a hand-ordered list.
 */

import i18next from 'i18next';

import { invalidate } from '@/api/query';
import { rpc } from '@/api/transport';
import { sameRef, type ItemRef, type ItemSnapshot } from '@/api/types';
import { errorDescription } from '@/ui/States';
import { toast } from '@/ui/Toast';

import { reinsertFavorite, reorderArgs, sortFavorites } from './favorites';

/**
 * Toggles `ref` and says so. `wasFavorite` is what the screen showed: when it was on, the old
 * place is read first so Undo can restore it. Resolves to the new state, or undefined when the
 * call failed (the error toast is already up).
 */
export async function toggleFavoriteWithUndo(ref: ItemRef, snapshot: ItemSnapshot, name: string, wasFavorite: boolean): Promise<boolean | undefined> {
  const t = i18next.t;
  try {
    const index = wasFavorite ? await oldIndex(ref) : -1;
    const res = await rpc('favorites.toggle', { ref, snapshot });
    if (res.isFavorite) {
      toast({ title: t('live:favoriteAdded', { name }), variant: 'success' });
    } else {
      toast({
        title: t('live:favoriteRemoved', { name }),
        variant: 'info',
        action: {
          label: t('library:undo'),
          onClick: () => {
            void restore(ref, snapshot, index)
              .catch((err: unknown) => toast({ title: t('library:undoFailed'), description: errorDescription(err), variant: 'error' }))
              .finally(() => invalidate('favorites.'));
          },
        },
      });
    }
    return res.isFavorite;
  } catch (err) {
    toast({ title: t(wasFavorite ? 'live:favoriteRemoveFailed' : 'live:favoriteAddFailed'), description: errorDescription(err), variant: 'error' });
    return undefined;
  } finally {
    await invalidate('favorites.');
  }
}

/** The favourite's place in the stored order, or -1 when it is not there or the list did not load. */
async function oldIndex(ref: ItemRef): Promise<number> {
  try {
    return sortFavorites(await rpc('favorites.list', {})).findIndex((e) => sameRef(e.ref, ref));
  } catch {
    return -1;
  }
}

/** Adds the favourite back (unless it was re-added meanwhile) at `index` of the stored order. */
async function restore(ref: ItemRef, snapshot: ItemSnapshot, index: number): Promise<void> {
  const present = await rpc('favorites.contains', { refs: [ref] });
  if (!present.some((r) => sameRef(r, ref))) await rpc('favorites.toggle', { ref, snapshot });
  if (index < 0) return;
  const current = await rpc('favorites.list', {});
  const entry = current.find((e) => sameRef(e.ref, ref));
  if (entry) await rpc('favorites.reorder', reorderArgs(reinsertFavorite(current, entry, index)));
}
