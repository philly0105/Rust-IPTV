import type { ItemRef } from '@/api/types';
// The gate module itself, not the parental barrel: the barrel pulls the settings section and the
// PIN dialogs into the player's (main) chunk.
import { ensureUnlocked } from '@/features/parental/gate';

/** What the player is about to start: the catalog item, its category and title when the caller knows them. */
export interface PlaybackGateItem {
  ref: ItemRef;
  categoryId?: string;
  /** Names the item in the PIN prompt; never sent to the core. */
  title?: string;
}

/**
 * The parental gate's hook point in the player's play path (C2/C5). Resolves true when the
 * item may start, false when it may not (the PIN prompt was cancelled, or the lock check
 * failed: the gate fails closed); the player then leaves whatever was playing untouched.
 *
 * The player calls it from `playItem`, `playSource` and `restorePlayback` before anything
 * about the item shows, and from `play` when a queue, Up next or failover switches to a
 * different item than the one last allowed. With controls off, in Hide mode (the core never
 * lists locked items) or while unlocked, it resolves true without asking.
 */
export function ensurePlaybackAllowed(item: PlaybackGateItem): Promise<boolean> {
  return ensureUnlocked([item]);
}
