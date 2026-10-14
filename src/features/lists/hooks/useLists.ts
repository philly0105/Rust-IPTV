/** The shared lists queries: every part of the slice reads these keys, so a change anywhere shows everywhere. */

import { useRpcQuery } from '@/api/query';
import type { ItemRef } from '@/api/types';

/** Every list, by position. */
export function useLists() {
  return useRpcQuery('lists.list', undefined, { staleTime: 60_000 });
}

/** One list's channels in the user's order (`available: false` for dropped ones). */
export function useListItems(id: string | undefined, enabled = true) {
  return useRpcQuery('lists.items', { id: id ?? '' }, { enabled: enabled && !!id, staleTime: 60_000 });
}

/** Ids of the lists holding `ref` (picker check marks). */
export function useListsContaining(ref: ItemRef | undefined) {
  return useRpcQuery('lists.containing', { ref: ref ?? { sourceId: '', contentType: 'live', itemId: '' } }, { enabled: !!ref, staleTime: 0 });
}
