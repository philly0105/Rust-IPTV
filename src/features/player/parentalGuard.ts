/**
 * Keeps the player in step with parental controls (C2) after playback started.
 *
 * The gate asks before an item starts; this guard handles what happens later. When controls
 * lock again (Lock now, the timed unlock runs out, a lock is added to what is playing), the
 * gate's last pass is forgotten and the item playing now is checked again:
 * - Ask mode: playback pauses and the PIN prompt opens. The PIN resumes it; cancelling stops it.
 * - Hide mode: playback stops, since the item is no longer offered anywhere.
 * In Hide mode the live history also drops the channels it hides now, so B cannot reach them.
 * Multi-view does the same for its tiles (see features/multiview/useWallData.ts).
 */

import i18next from 'i18next';

import { onAppEvent } from '@/api/events';
import { itemKey, type ItemKey, type ItemRef, type ParentalStatus } from '@/api/types';
import { lockedRefs } from '@/features/parental/gate';
import { toast } from '@/ui/Toast';

import { dropHistoryEntries, useHistoryStore } from './history';
import { ensurePlaybackAllowed, type PlaybackGateItem } from './parentalHook';
import { onPlaybackHidden } from './parentalLocks';
import { forgetGatePass, setPaused, usePlayerStore } from './store';

const NOTICE_ID = 'player.parental';

function notice(descriptionKey: 'parentalHidden' | 'parentalStopped'): void {
  toast({ id: NOTICE_ID, title: i18next.t('player:parentalHiddenTitle'), description: i18next.t(`player:${descriptionKey}`), variant: 'info' });
}

const refKey = (r: ItemRef): string => `${r.sourceId}|${r.contentType}|${r.itemId}`;

/** Drops the history entries Hide mode hides now. A failed check keeps them (the gate still refuses them). */
async function pruneHistory(): Promise<void> {
  const entries = useHistoryStore.getState().entries;
  if (entries.length === 0) return;
  try {
    const locked = await lockedRefs(entries.map((e) => ({ ref: e.ref })));
    const keys = new Set<ItemKey>(entries.filter((e) => locked.has(refKey(e.ref))).map((e) => e.key));
    if (keys.size > 0) dropHistoryEntries(keys);
  } catch {
    // keep them
  }
}

/**
 * Whether the core counts `ref` as locked now. Asked directly rather than through the cached
 * status, which this event may not have reached yet. A failed check keeps what plays: the core
 * still refuses every new stream of a hidden item, and the gate asks again before the next start.
 */
async function lockedNow(ref: ItemRef): Promise<boolean> {
  try {
    return (await lockedRefs([{ ref }])).has(refKey(ref));
  } catch {
    return false;
  }
}

/** True while `ref` is still the item playing (the user did not move on during an await). */
function stillPlaying(key: string): boolean {
  const ref = usePlayerStore.getState().source?.ref;
  return !!ref && itemKey(ref) === key;
}

/** Checks the item playing now against the locked state `s`. */
async function recheck(s: ParentalStatus): Promise<void> {
  if (!s.enabled || s.unlocked) return;
  forgetGatePass();
  if (s.mode === 'hide') await pruneHistory();
  const { source, mode } = usePlayerStore.getState();
  // An external player is out of reach; a failed lookup has nothing playing.
  if (!source?.ref || !source.url || mode === 'external') return;
  const key = itemKey(source.ref);
  const item: PlaybackGateItem = { ref: source.ref, title: source.title };
  if (!(await lockedNow(source.ref)) || !stillPlaying(key)) return;
  if (s.mode === 'hide') {
    usePlayerStore.getState().stop();
    notice('parentalHidden');
    return;
  }
  const wasPlaying = usePlayerStore.getState().status === 'playing';
  // Nothing locked keeps playing behind the PIN prompt.
  setPaused(true);
  const ok = await ensurePlaybackAllowed(item);
  if (!stillPlaying(key)) return;
  if (ok) {
    if (wasPlaying) setPaused(false);
    return;
  }
  usePlayerStore.getState().stop();
  notice('parentalStopped');
}

/**
 * Binds the guard: `parental.changed` re-checks what plays, and a Hide-mode refusal of an item
 * the player held on to (history, resume record, remote) says why. Returns the unbind function.
 */
export function bindParentalGuard(): () => void {
  // One check at a time, in event order: a burst of changes never opens two prompts.
  let chain: Promise<void> = Promise.resolve();
  const offChanged = onAppEvent('parental.changed', (s) => {
    chain = chain.then(() => recheck(s)).catch(() => undefined);
  });
  const offHidden = onPlaybackHidden(() => notice('parentalHidden'));
  return () => {
    offChanged();
    offHidden();
  };
}
