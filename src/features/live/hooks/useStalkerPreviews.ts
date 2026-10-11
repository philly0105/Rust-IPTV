import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { rpc } from '@/api/transport';
import { itemKey, type EpgProgram, type ItemRef } from '@/api/types';

import { PREVIEW_FETCH_SIZE, StalkerPreviewQueue } from '../lib/stalkerPreviewQueue';

/**
 * Row previews from a Stalker portal's own guide (`stalker.epg`) for the channels in `refs`
 * (the visible window, in display order). Returns a lookup that re-renders as answers arrive.
 */
export function useStalkerPreviews(
  sourceId: string,
  enabled: boolean,
  refs: readonly ItemRef[],
  now: number,
  /** Programmes per channel: a row preview needs 3, a guide-grid row more. */
  limit = PREVIEW_FETCH_SIZE,
) {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const bumpRef = useRef(bump);
  bumpRef.current = bump;

  const queue = useMemo(
    () =>
      new StalkerPreviewQueue(
        (ref) => rpc('stalker.epg', { ref, limit }),
        () => bumpRef.current(),
      ),
    // One queue (and cache) per source and size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceId, limit],
  );
  // reset, not destroy: StrictMode re-runs effects on the same memoized queue.
  useEffect(() => () => queue.reset(), [queue]);

  const refsRef = useRef(refs);
  refsRef.current = refs;
  const refsKey = refs.map(itemKey).join('\n');
  useEffect(() => {
    if (enabled) queue.sync(refsRef.current);
  }, [queue, enabled, refsKey, now]);

  return useCallback(
    (ref: ItemRef): EpgProgram[] | undefined => (enabled ? queue.get(ref) : undefined),
    // `version` changes whenever the queue stores an answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, enabled, version],
  );
}
