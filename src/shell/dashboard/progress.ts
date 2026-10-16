import type { PlaybackPosition } from '@/api/types';

/** Fraction watched, or undefined when duration is unknown. */
export function watchedFraction(p: Pick<PlaybackPosition, 'positionSeconds' | 'durationSeconds'>): number | undefined {
  if (!p.durationSeconds || p.durationSeconds <= 0) return undefined;
  return Math.max(0, Math.min(1, p.positionSeconds / p.durationSeconds));
}

/** Whole minutes left (at least 1), or undefined. */
export function minutesLeft(p: Pick<PlaybackPosition, 'positionSeconds' | 'durationSeconds'>): number | undefined {
  if (!p.durationSeconds || p.durationSeconds <= 0) return undefined;
  return Math.max(1, Math.round((p.durationSeconds - p.positionSeconds) / 60));
}
