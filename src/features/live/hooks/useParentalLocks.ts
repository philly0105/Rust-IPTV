import { useMemo } from 'react';

import { useRpcQuery } from '@/api/query';
import type { Channel, ContentType, ParentalLock, ParentalStatus } from '@/api/types';
import { useParentalStatus } from '@/features/parental/status';

const LOCKS_STALE_MS = 30_000;

export interface ParentalLocks {
  /** The channel asks for the PIN before it plays: its own lock, its group's, or an adult group. */
  channelLocked(channel: Channel | undefined): boolean;
  /** The group asks for the PIN (locked by hand, or an adult group while that rule is on). */
  categoryLocked(categoryId: string | undefined): boolean;
}

const NONE: ParentalLocks = { channelLocked: () => false, categoryLocked: () => false };

/** Ask mode with no session unlock: locked things play only after the PIN, so lists mark them. */
export function locksShown(s: ParentalStatus | undefined): boolean {
  return !!s && s.enabled && s.mode === 'ask' && !s.unlocked;
}

/** Builds the lookup from the lock list and the adult groups, by the rule `parental.check` applies. */
export function buildLocks(locks: readonly ParentalLock[], adult: readonly string[], sourceId: string, contentType: ContentType): ParentalLocks {
  const items = new Set<string>();
  const groups = new Set<string>(adult);
  for (const l of locks) {
    if (l.sourceId !== sourceId || l.contentType !== contentType) continue;
    (l.kind === 'category' ? groups : items).add(l.targetId);
  }
  if (items.size === 0 && groups.size === 0) return NONE;
  return {
    channelLocked: (ch) =>
      !!ch && ch.ref.sourceId === sourceId && ch.ref.contentType === contentType && (items.has(ch.ref.itemId) || groups.has(ch.categoryId)),
    categoryLocked: (id) => id !== undefined && groups.has(id),
  };
}

/**
 * What the parental gate will ask the PIN for in one source's live or radio list (C2), so rows,
 * groups and the guide ribbon can mark it and keep its programme titles back before the prompt.
 * It reads the same lock list as the lock menu (`parental.locks`, refreshed on every lock change
 * and `parental.changed`) plus the adult groups. Nothing is marked outside Ask mode: Hide mode
 * leaves locked things out of the lists altogether, and a session unlock lets everything play.
 */
export function useParentalLocks(sourceId: string | undefined, contentType: ContentType): ParentalLocks {
  const status = useParentalStatus().data;
  const on = !!sourceId && locksShown(status);
  const locks = useRpcQuery('parental.locks', { sourceId: sourceId ?? '' }, { enabled: on, staleTime: LOCKS_STALE_MS });
  const adult = useRpcQuery(
    'parental.adultCategories',
    { sourceId: sourceId ?? '', contentType },
    { enabled: on && status?.autoAdult === true, staleTime: LOCKS_STALE_MS },
  );
  const adultIds = on && status?.autoAdult ? adult.data : undefined;
  return useMemo(
    () => (on && sourceId ? buildLocks(locks.data ?? [], adultIds ?? [], sourceId, contentType) : NONE),
    [on, sourceId, contentType, locks.data, adultIds],
  );
}
