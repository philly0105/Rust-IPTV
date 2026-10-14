/**
 * Lock lookups the player makes besides the gate itself (`parentalHook`), and the signal for
 * a Hide-mode refusal. Kept apart from `parentalHook` so tests that stub the hook point
 * (`ensurePlaybackAllowed`) still get these.
 */

import { RpcError } from '@/api/transport';
import type { ItemRef } from '@/api/types';
// The gate modules themselves, not the parental barrel: the barrel pulls the settings section and
// the PIN dialogs into the player's (main) chunk.
import { lockedRefs } from '@/features/parental/gate';
import { currentStatus, hidesContent } from '@/features/parental/status';

/** An item the player is about to start or is playing: its ref, and its category when known. */
export interface LockCheckItem {
  ref: ItemRef;
  categoryId?: string;
  title?: string;
}

function checkArgs(item: LockCheckItem): { ref: ItemRef; categoryId?: string } {
  return item.categoryId ? { ref: item.ref, categoryId: item.categoryId } : { ref: item.ref };
}

/**
 * True when Hide mode keeps `item` out of reach right now. The catalog never lists such items,
 * but the player also starts things it kept from before the lock came back (the B history,
 * the session's resume record, a remote `play`), and the resume record replays a stored URL
 * without asking the core. A failed check answers false: the core refuses hidden items on its
 * own stream-URL paths, so failing open here only costs the resume record that one replay.
 */
export async function hiddenNow(item: LockCheckItem): Promise<boolean> {
  try {
    if (!hidesContent(await currentStatus())) return false;
    return (await lockedRefs([checkArgs(item)])).size > 0;
  } catch (err) {
    if (RpcError.from(err).code !== 'unsupported') console.warn('[parental] hide-mode check failed', err);
    return false;
  }
}

/**
 * True when `item` is locked right now (controls on, no unlock running), in either mode,
 * without asking for the PIN. A zap that was refused uses it to step past the next locked
 * channels instead of prompting for each. A failed check counts as locked.
 */
export async function lockedNow(item: LockCheckItem): Promise<boolean> {
  try {
    const s = await currentStatus();
    if (!s.enabled || s.unlocked) return false;
    return (await lockedRefs([checkArgs(item)])).size > 0;
  } catch (err) {
    return RpcError.from(err).code !== 'unsupported';
  }
}

/**
 * Told when Hide mode refused to start an item the player still held on to: the channel
 * history drops it, the resume record forgets it, and the player says why.
 */
const hiddenListeners = new Set<(item: LockCheckItem) => void>();

export function onPlaybackHidden(fn: (item: LockCheckItem) => void): () => void {
  hiddenListeners.add(fn);
  return () => {
    hiddenListeners.delete(fn);
  };
}

export function notifyPlaybackHidden(item: LockCheckItem): void {
  for (const fn of hiddenListeners) fn(item);
}
