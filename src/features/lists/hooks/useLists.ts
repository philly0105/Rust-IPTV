/** The shared lists queries: every part of the slice reads these keys, so a change anywhere shows everywhere. */

import { useMemo } from 'react';

import { useRpcQuery } from '@/api/query';
import type { ItemRef } from '@/api/types';

import { useDeletingLists } from '../store';

/** Every list, by position, without the ones whose delete waits on its Undo toast. */
export function useLists() {
  const query = useRpcQuery('lists.list', undefined, { staleTime: 60_000 });
  const deleting = useDeletingLists((s) => s.ids);
  const data = useMemo(
    () => (query.data && deleting.size > 0 ? query.data.filter((l) => !deleting.has(l.id)) : query.data),
    [query.data, deleting],
  );
  return data === query.data ? query : ({ ...query, data } as typeof query);
}

/** One list's channels in the user's order (`available: false` for dropped ones). */
export function useListItems(id: string | undefined, enabled = true) {
  return useRpcQuery('lists.items', { id: id ?? '' }, { enabled: enabled && !!id, staleTime: 60_000 });
}

/** Ids of the lists holding `ref` (picker check marks). */
export function useListsContaining(ref: ItemRef | undefined) {
  return useRpcQuery('lists.containing', { ref: ref ?? { sourceId: '', contentType: 'live', itemId: '' } }, { enabled: !!ref, staleTime: 0 });
}
