import type { ItemRef } from '@/api/types';
// The gate module itself, not the parental barrel: the barrel pulls the settings section and the
// PIN dialogs into the player's (main) chunk.
import { ensureUnlocked } from '@/features/parental/gate';

import { hiddenNow, notifyPlaybackHidden } from './parentalLocks';

/** What the player is about to start: the catalog item, its category and title when the caller knows them. */
export interface PlaybackGateItem {
  ref: ItemRef;
  categoryId?: string;
  /** Names the item in the PIN prompt; never sent to the core. */
  title?: string;
}

/**
 * The parental gate's hook point in the player's play path (C2/C5). Resolves true when the
 * item may start, false when it may not; the player then leaves whatever was playing untouched.
 *
 * - Controls off, or an unlock running: true without asking.
 * - Ask mode: a locked item asks for the PIN; cancelling (or a failed lock check) is false.
 * - Hide mode: an item it hides is false without a prompt, and `notifyPlaybackHidden` tells
 *   the player (the catalog never lists such items, but the B history, the session's resume
 *   record or a remote `play` may still hold one from before the lock came back).
 *
 * The player calls it from `playItem`, `playSource` and `restorePlayback` before anything
 * about the item shows, and from `play` when a queue, Up next or failover switches to a
 * different item than the one last allowed.
 */
export async function ensurePlaybackAllowed(item: PlaybackGateItem): Promise<boolean> {
  if (await hiddenNow(item)) {
    notifyPlaybackHidden(item);
    return false;
  }
  return ensureUnlocked([item]);
}
