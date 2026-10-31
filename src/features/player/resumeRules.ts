/**
 * When a saved position is a resume point: the player's rules, on their own so the VOD pages can
 * label titles with them (`vod/lib/format.ts`) without loading the player store.
 */

import type { PlaybackPosition } from '@/api/types';

/** Saved positions this close to the start are not worth a resume (and no "Resumed at 0:03"). */
export const MIN_RESUME_SECONDS = 5;

/** Share of the duration from which an item counts as finished (the core marks it watched there). */
const FINISHED_RATIO = 0.95;

export function isPastEnd(seconds: number, duration: number | undefined): boolean {
  return !!duration && seconds >= duration * FINISHED_RATIO;
}

/** Share of the duration a watched movie's replay must reach before it is a resume point again. */
const REPLAY_RESUME_RATIO = 0.05;

/**
 * A watched movie replayed part-way (Run 2): the core keeps its watched flag on a partial save of
 * an item-level row and stores the replay position. That position is a resume point when the
 * duration is known and it lies between 5 % and 95 % of it; the watched tick stays. Episodes
 * lose the flag on a partial save instead, so a watched episode row is always finished.
 */
export function isWatchedReplay(
  pos: Pick<PlaybackPosition, 'positionSeconds' | 'durationSeconds'> & Partial<Pick<PlaybackPosition, 'watched' | 'episodeId' | 'ref'>>,
): boolean {
  if (pos.watched !== true || pos.episodeId || pos.ref?.contentType === 'series') return false;
  const d = pos.durationSeconds;
  return !!d && d > 0 && pos.positionSeconds >= d * REPLAY_RESUME_RATIO && !isPastEnd(pos.positionSeconds, d);
}
