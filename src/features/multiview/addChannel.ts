/**
 * Putting channels on the wall from anywhere (menu item, picker): the store's checks first,
 * then the parental gate (C2), then the store again (the gate may have waited on a PIN while
 * something else changed the wall).
 */

import type { Channel, ItemRef } from '@/api/types';

import { prefetchAccountStatus } from './accountStatus';
import { MAX_TILES } from './layout';
import { ensureUnlocked } from './parentalGate';
import { useMultiviewStore } from './store';
import type { MultiviewAddResult, MultiviewChannelInput } from './types';

/** `cancelled`: the PIN prompt was dismissed. `gateFailed`: the lock check itself failed. */
export type AddOutcome = MultiviewAddResult | 'unsupported' | 'cancelled' | 'gateFailed';
export type ReplaceOutcome = 'replaced' | 'duplicate' | 'missing' | 'unsupported' | 'cancelled' | 'gateFailed';

function sameRef(a: ItemRef, b: ItemRef): boolean {
  return a.sourceId === b.sourceId && a.contentType === b.contentType && a.itemId === b.itemId;
}

/** The gate's item for a channel. */
export function gateItem(ch: MultiviewChannelInput): { ref: ItemRef; categoryId?: string } {
  return ch.categoryId ? { ref: ch.ref, categoryId: ch.categoryId } : { ref: ch.ref };
}

/** A catalog channel as wall input. */
export function channelInput(ch: Channel): MultiviewChannelInput {
  const out: MultiviewChannelInput = { ref: ch.ref, title: ch.name };
  if (ch.logoUrl) out.logo = ch.logoUrl;
  if (ch.number !== undefined) out.number = ch.number;
  if (ch.categoryId) out.categoryId = ch.categoryId;
  return out;
}

/** Only live TV goes on the wall (radio has no picture). */
export function wallAccepts(ch: Pick<MultiviewChannelInput, 'ref'> | null | undefined): boolean {
  return !!ch && ch.ref.contentType === 'live';
}

async function passGate(ch: MultiviewChannelInput): Promise<'ok' | 'cancelled' | 'gateFailed'> {
  try {
    // The title only names the channel in the PIN dialog; it never leaves the app.
    return (await ensureUnlocked([{ ...gateItem(ch), title: ch.title }])) ? 'ok' : 'cancelled';
  } catch {
    // Fail closed: a lock that cannot be checked is not opened.
    return 'gateFailed';
  }
}

export async function addToWall(ch: MultiviewChannelInput): Promise<AddOutcome> {
  if (!wallAccepts(ch)) return 'unsupported';
  const before = useMultiviewStore.getState();
  if (before.tiles.some((t) => sameRef(t.ref, ch.ref))) return 'duplicate';
  if (before.tiles.length >= MAX_TILES) return 'full';
  const gate = await passGate(ch);
  if (gate !== 'ok') return gate;
  const added = useMultiviewStore.getState().add(ch);
  if (added === 'added') prefetchAccountStatus(ch.ref.sourceId);
  return added;
}

export async function replaceOnWall(key: string, ch: MultiviewChannelInput): Promise<ReplaceOutcome> {
  if (!wallAccepts(ch)) return 'unsupported';
  const s = useMultiviewStore.getState();
  const current = s.tiles.find((t) => t.key === key);
  if (!current) return 'missing';
  if (sameRef(current.ref, ch.ref)) return 'replaced';
  if (s.tiles.some((t) => t.key !== key && sameRef(t.ref, ch.ref))) return 'duplicate';
  const gate = await passGate(ch);
  if (gate !== 'ok') return gate;
  const after = useMultiviewStore.getState();
  if (!after.tiles.some((t) => t.key === key)) return 'missing';
  if (after.tiles.some((t) => t.key !== key && sameRef(t.ref, ch.ref))) return 'duplicate';
  after.replace(key, ch);
  prefetchAccountStatus(ch.ref.sourceId);
  return 'replaced';
}
