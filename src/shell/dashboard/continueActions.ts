/**
 * The actions of a Continue watching card's menu (CB-CONTINUE-MENU): Mark watched and Remove
 * from continue watching, each with an Undo, as Recently watched and the detail pages do them.
 * The rows they rewrite are captured first, so Undo puts back the resume point and the card's
 * place in the rail (C14). Light modules only: Home's chunk must not pull in the VOD pages.
 */

import type { TFunction } from 'i18next';

import { invalidate } from '@/api/query';
import { rpc } from '@/api/transport';
import type { PlaybackPosition } from '@/api/types';
import { removeContinueCard, restorePositions, type PositionCalls } from '@/features/library/lib/recent';
import { captureWatched, watchedUndoAction, type WatchedTarget } from '@/features/library/lib/watchedUndo';
import { invalidateWatched } from '@/features/vod/lib/watchedQueries';
import { errorDescription, toast } from '@/ui';

const positionCalls: PositionCalls = {
  forSeries: (a) => rpc('positions.forSeries', a),
  remove: (a) => rpc('positions.remove', a),
  set: (a) => rpc('positions.set', a),
};

/** What Mark watched marks for a card: the movie, or the series episode the card resumes. */
export function watchedTargetOf(p: PlaybackPosition): WatchedTarget {
  return p.ref.contentType === 'series' && p.episodeId ? { ref: p.ref, episodeIds: [p.episodeId] } : { ref: p.ref };
}

/** Marks the card's title (or its episode) watched; the toast's Undo restores the rows. */
export async function markContinueWatched(p: PlaybackPosition, title: string, t: TFunction): Promise<void> {
  const target = watchedTargetOf(p);
  // Without the rows Undo has nothing to put back, so the toast then goes without it.
  const before = await captureWatched(target).catch(() => undefined);
  try {
    if (target.episodeIds) await Promise.all(target.episodeIds.map((episodeId) => rpc('userstate.setWatched', { ref: p.ref, episodeId, watched: true })));
    else await rpc('userstate.setWatched', { ref: p.ref, watched: true });
    toast({
      title: t('vod:namedMarkedWatched', { name: title }),
      variant: 'success',
      ...(before
        ? {
            action: watchedUndoAction(target, before, {
              label: t('library:undo'),
              onFailed: () => toast({ title: t('library:undoFailed'), variant: 'error' }),
            }),
          }
        : {}),
    });
  } catch (err) {
    toast({ title: t('vod:watchedFailed'), description: errorDescription(err), variant: 'error' });
  } finally {
    invalidateWatched();
  }
}

/** Removes the card (a series card: every unfinished episode row); the toast's Undo puts them back. */
export async function removeFromContinue(p: PlaybackPosition, title: string, t: TFunction): Promise<void> {
  try {
    const removed = await removeContinueCard(p, positionCalls);
    toast({
      title: t('library:continueRemoved', { title }),
      variant: 'info',
      action: {
        label: t('library:undo'),
        onClick: () => {
          void restorePositions(removed, positionCalls.set)
            .then((n) => {
              if (n < removed.length) toast({ title: t('library:undoFailed'), variant: 'error' });
            })
            .finally(() => invalidate('positions.'));
        },
      },
    });
  } catch (err) {
    toast({ title: t('library:removeFailed'), description: errorDescription(err), variant: 'error' });
  } finally {
    await invalidate('positions.');
  }
}
