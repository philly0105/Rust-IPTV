/**
 * Saves the resume point of an offline video with `downloads.setPosition`.
 * Lives outside React so playback that continues in the mini dock after the
 * page unmounts still records its position. One video is tracked at a time.
 */

import { rpc } from '@/api/transport';
import type { PlayerSource } from '@/api/types';

/** Minimal slice of the player store this module needs (keeps it testable). */
export interface PositionStore {
  getState(): { source?: PlayerSource; positionSeconds: number; durationSeconds?: number };
  subscribe(listener: (state: { source?: PlayerSource; positionSeconds: number; durationSeconds?: number }) => void): () => void;
}

export const SAVE_EVERY_MS = 5_000;
/** At or past this fraction the video counts as watched and restarts next time. */
const FINISHED_FRACTION = 0.95;

type Save = (id: number, positionSeconds: number) => Promise<void>;

const defaultSave: Save = (id, positionSeconds) => rpc('downloads.setPosition', { id, positionSeconds });

let active: { stop: () => void } | null = null;

/** Value to persist for a position (0 when finished, whole seconds otherwise). */
export function positionToSave(positionSeconds: number, durationSeconds?: number): number {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return 0;
  if (durationSeconds && durationSeconds > 0 && positionSeconds >= durationSeconds * FINISHED_FRACTION) return 0;
  return Math.floor(positionSeconds);
}

/**
 * Starts tracking `downloadId` while the player plays `url`. Saves every 5 s
 * of change, and once more when the source changes or playback stops.
 */
export function trackDownloadPosition(
  store: PositionStore,
  downloadId: number,
  url: string,
  opts: { save?: Save; now?: () => number } = {},
): () => void {
  active?.stop();
  const save = opts.save ?? defaultSave;
  const now = opts.now ?? Date.now;
  let lastSavedAt = now();
  let lastSaved = -1;
  let latest: { pos: number; dur?: number } | undefined;
  let stopped = false;

  const flush = () => {
    if (!latest) return;
    const value = positionToSave(latest.pos, latest.dur);
    if (value === lastSaved) return;
    lastSaved = value;
    lastSavedAt = now();
    save(downloadId, value).catch(() => {
      // The next tick retries; a failed save must not break playback.
      lastSaved = -1;
    });
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    flush();
    unsubscribe();
    if (active?.stop === stop) active = null;
  };

  const unsubscribe = store.subscribe((s) => {
    if (s.source?.url !== url) {
      stop();
      return;
    }
    latest = s.durationSeconds !== undefined ? { pos: s.positionSeconds, dur: s.durationSeconds } : { pos: s.positionSeconds };
    if (now() - lastSavedAt >= SAVE_EVERY_MS) flush();
  });

  active = { stop };
  return stop;
}

/** Stops the current tracker, saving its last position. */
export function stopTrackingDownloadPosition(): void {
  active?.stop();
}
