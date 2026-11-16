/**
 * Remove from favorites and Remove from history in the menus of Home's channel rails (Favorite
 * channels, Recently watched channels), each with an Undo, as the Favorites and Recently watched
 * pages do them: Undo puts a favorite back in its old place and a history entry back with its
 * date. Loaded on the click, like continueActions.ts.
 */

import type { TFunction } from 'i18next';

import { invalidate } from '@/api/query';
import { rpc } from '@/api/transport';
import { sameRef, type FavoriteEntry, type RecentEntry } from '@/api/types';
import { reinsertFavorite, reorderArgs, sortFavorites } from '@/features/library/lib/favorites';
import { restoreArgs } from '@/features/library/lib/recent';
import { errorDescription, toast } from '@/ui';

/** Removes a favourite; the toast's Undo adds it back at the place it had. */
export async function removeFavorite(entry: FavoriteEntry, title: string, t: TFunction): Promise<void> {
  try {
    const index = sortFavorites(await rpc('favorites.list', {})).findIndex((e) => sameRef(e.ref, entry.ref));
    await rpc('favorites.remove', { ref: entry.ref });
    // A toggle alone would add it at the end, or switch it off again if it was re-added meanwhile.
    const restore = async () => {
      const present = await rpc('favorites.contains', { refs: [entry.ref] });
      if (!present.some((r) => sameRef(r, entry.ref))) await rpc('favorites.toggle', { ref: entry.ref, snapshot: entry.snapshot });
      if (index < 0) return;
      await rpc('favorites.reorder', reorderArgs(reinsertFavorite(await rpc('favorites.list', {}), entry, index)));
    };
    toast({
      title: t('library:favoriteRemoved', { title }),
      variant: 'info',
      action: {
        label: t('library:undo'),
        onClick: () => {
          void restore()
            .catch((err: unknown) => toast({ title: t('library:undoFailed'), description: errorDescription(err), variant: 'error' }))
            .finally(() => invalidate('favorites.'));
        },
      },
    });
  } catch (err) {
    toast({ title: t('library:removeFailed'), description: errorDescription(err), variant: 'error' });
  } finally {
    await invalidate('favorites.');
  }
}

/** Removes a channel from the history; the toast's Undo puts it back with its own date. */
export async function removeRecent(entry: RecentEntry, title: string, t: TFunction): Promise<void> {
  try {
    await rpc('recent.remove', { ref: entry.ref });
    toast({
      title: t('library:recentRemoved', { title }),
      variant: 'info',
      action: {
        label: t('library:undo'),
        onClick: () => {
          void rpc('recent.add', restoreArgs(entry))
            .catch((err: unknown) => toast({ title: t('library:undoFailed'), description: errorDescription(err), variant: 'error' }))
            .finally(() => invalidate('recent.'));
        },
      },
    });
  } catch (err) {
    toast({ title: t('library:removeFailed'), description: errorDescription(err), variant: 'error' });
  } finally {
    await invalidate('recent.');
  }
}
