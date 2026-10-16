/**
 * Keeps a series' watched mark and its episodes' marks in step (L1-vod-1).
 * The series-level row (no episode id) stays the core's rule for the poster
 * tick and "Hide watched"; the episode rows follow it through the same
 * `userstate.setWatched` calls:
 * - Mark series watched also marks every known episode not yet watched;
 *   Mark series unwatched also clears every watched one (an episode that is
 *   only part-way through keeps its resume point).
 * - Marking episodes so that none of the known ones is left unwatched also
 *   marks the series; unmarking any episode clears the series mark.
 */

import { itemKey, type ItemRef, type PlaybackPosition } from '@/api/types';
import { undoWatched, type WatchedTarget } from '@/features/library/lib/watchedUndo';

import { isWatched } from './format';
import { invalidateWatched } from './watchedQueries';

/** The writes behind one watched mark on a series. */
export interface SeriesWatchedWrite {
  watched: boolean;
  /** Episodes to set to `watched`. */
  episodeIds: string[];
  /** Also set the series-level row to `watched`. */
  series: boolean;
}

/**
 * The writes for marking the series as a whole (no `episodeIds`) or some of
 * its episodes, given every episode the provider lists and the series' saved
 * rows (`positions.forSeries`).
 */
export function seriesWatchedWrite(
  allEpisodeIds: readonly string[],
  positions: readonly PlaybackPosition[],
  change: { episodeIds?: readonly string[]; watched: boolean },
): SeriesWatchedWrite {
  const { watched } = change;
  const watchedEpisodes = new Set(positions.filter((p) => p.episodeId && isWatched(p)).map((p) => p.episodeId!));
  if (!change.episodeIds) {
    return { watched, episodeIds: allEpisodeIds.filter((id) => watchedEpisodes.has(id) !== watched), series: true };
  }
  const episodeIds = [...change.episodeIds];
  const seriesRow = positions.some((p) => !p.episodeId && isWatched(p));
  if (!watched) return { watched, episodeIds, series: seriesRow };
  const after = new Set([...watchedEpisodes, ...episodeIds]);
  return { watched, episodeIds, series: !seriesRow && allEpisodeIds.length > 0 && allEpisodeIds.every((id) => after.has(id)) };
}

/** The rows a {@link SeriesWatchedWrite} on `ref` rewrites, as Undo targets. */
export function seriesWatchedTargets(ref: ItemRef, write: Pick<SeriesWatchedWrite, 'episodeIds' | 'series'>): WatchedTarget[] {
  const targets: WatchedTarget[] = [];
  if (write.episodeIds.length > 0) targets.push({ ref, episodeIds: write.episodeIds });
  if (write.series) targets.push({ ref });
  return targets;
}

/**
 * Undo for a mark that rewrote several targets (`before[i]` captured for
 * `targets[i]` with `captureWatched`): every one goes back, then what a
 * watched change touches refetches.
 */
export function watchedUndoAll(
  targets: readonly WatchedTarget[],
  before: readonly (readonly PlaybackPosition[])[],
  { label, onFailed }: { label: string; onFailed: () => void },
): { label: string; onClick: () => void } {
  return {
    label,
    onClick: () => {
      void Promise.all(targets.map((t, i) => undoWatched(t, before[i] ?? [])))
        .then((ok) => {
          if (!ok.every(Boolean)) onFailed();
        }, onFailed)
        .finally(() => invalidateWatched());
    },
  };
}

/** One toast per title for watched marks, so marking season after season replaces it instead of stacking (L1-vod-14). */
export function watchedToastId(ref: ItemRef): string {
  return `vod-watched:${itemKey(ref)}`;
}
