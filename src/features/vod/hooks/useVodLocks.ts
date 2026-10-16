import { useMemo } from 'react';

import type { Channel, ItemRef } from '@/api/types';
import { useParentalLocks } from '@/features/live/hooks/useParentalLocks';

import type { VodKind } from '../lib/paging';

export interface VodLocks {
  /** The title asks for the PIN before it opens: its own lock, its category's, or an adult category. */
  itemLocked(item: { ref: ItemRef; categoryId?: string | undefined } | undefined): boolean;
  /** The category asks for the PIN (locked by hand, or an adult category while that rule is on). */
  categoryLocked(categoryId: string | undefined): boolean;
}

/**
 * What the parental gate will ask the PIN for among one source's movies or series (L2-settings-5),
 * so posters and category tiles carry the same lock mark as Live's groups. The rule and the data
 * are Live's (`useParentalLocks`: `parental.locks` plus the adult categories); nothing is marked
 * outside Ask mode or during a session unlock.
 */
export function useVodLocks(sourceId: string | undefined, kind: VodKind): VodLocks {
  const locks = useParentalLocks(sourceId, kind);
  return useMemo(
    () => ({
      // The rule reads only the ref and the category of what it judges.
      itemLocked: (item) => !!item && locks.channelLocked({ ref: item.ref, categoryId: item.categoryId ?? '' } as Channel),
      categoryLocked: (id) => locks.categoryLocked(id),
    }),
    [locks],
  );
}
