import { rpc } from '@/api/transport';
import type { ItemRef, PlaybackPosition } from '@/api/types';
import { invalidateWatched } from '@/features/vod/lib/watchedQueries';

import { restorePositions } from './recent';

/** What Mark watched / unwatched changes: a movie, or some episodes of a series. */
export type WatchedTarget = { ref: ItemRef; episodeIds?: readonly string[] };

/** The position rows Mark watched / unwatched is about to rewrite or delete. */
export async function captureWatched({ ref, episodeIds }: WatchedTarget): Promise<PlaybackPosition[]> {
  if (!episodeIds) {
    const row = await rpc('positions.get', { ref });
    return row ? [row] : [];
  }
  const ids = new Set(episodeIds);
  return (await rpc('positions.forSeries', { ref })).filter((p) => p.episodeId !== undefined && ids.has(p.episodeId));
}

/**
 * Undo for Mark watched / unwatched. `userstate.setWatched` stamps rows with
 * now, or deletes them, so the rows it left are removed and the captured ones
 * go back with their original time and watched flag (C14). The resume point,
 * the watched marks and the Continue Watching order all return. Resolves to
 * false when a row could not be restored.
 */
export async function undoWatched({ ref, episodeIds }: WatchedTarget, before: readonly PlaybackPosition[]): Promise<boolean> {
  const keys = episodeIds ?? [undefined];
  await Promise.all(keys.map((episodeId) => rpc('positions.remove', episodeId === undefined ? { ref } : { ref, episodeId })));
  const restored = await restorePositions(before, (args) => rpc('positions.set', args));
  return restored === before.length;
}

/**
 * The Undo action for the Mark watched / unwatched toast (`before` from
 * {@link captureWatched}). Refreshes what a watched change touches afterwards
 * (positions, My List's ticks, "Hide watched" grid pages); `onFailed` reports
 * rows that did not come back.
 */
export function watchedUndoAction(
  target: WatchedTarget,
  before: readonly PlaybackPosition[],
  { label, onFailed }: { label: string; onFailed: () => void },
): { label: string; onClick: () => void } {
  return {
    label,
    onClick: () => {
      void undoWatched(target, before)
        .then((ok) => {
          if (!ok) onFailed();
        }, onFailed)
        .finally(() => invalidateWatched());
    },
  };
}
