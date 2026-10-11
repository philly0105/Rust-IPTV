import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { rpc } from '@/api/transport';
import { itemKey, type EpgProgram, type ItemRef } from '@/api/types';

import { PREVIEW_FETCH_SIZE, StalkerPreviewQueue } from '../lib/stalkerPreviewQueue';

export interface StalkerPreviews {
  /** Cached programmes of `ref`; a new function whenever an answer arrives. */
  get(ref: ItemRef): EpgProgram[] | undefined;
  /** The portal's guide timed out or the network failed; the queue is backing off. */
  unavailable: boolean;
  /** Ask the portal again now instead of waiting out the backoff. */
  retry(): void;
}

/**
 * Row previews from a Stalker portal's own guide (`stalker.epg`) for the channels in `refs`
 * (the visible window, in display order). `get` re-renders as answers arrive; a silent portal
 * (timeout / network error) sets `unavailable` and pauses the source with a growing backoff.
 * With `from` (epoch ms), the portal also returns the archived programmes since then; a new `from`
 * starts a fresh cache, so moving a guide window back refetches the visible rows.
 */
export function useStalkerPreviews(
  sourceId: string,
  enabled: boolean,
  refs: readonly ItemRef[],
  now: number,
  /** Programmes per channel: a row preview needs 3, a guide-grid row more. */
  limit = PREVIEW_FETCH_SIZE,
  /** Archive channels only: the start of the time window shown (epoch ms). */
  from?: number,
): StalkerPreviews {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const bumpRef = useRef(bump);
  bumpRef.current = bump;

  const queue = useMemo(
    () =>
      new StalkerPreviewQueue(
        (ref) => rpc('stalker.epg', from === undefined ? { ref, limit } : { ref, limit, from: new Date(from).toISOString() }),
        () => bumpRef.current(),
      ),
    // One queue (and cache) per source, size and window start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceId, limit, from],
  );
  // reset, not destroy: StrictMode re-runs effects on the same memoized queue.
  useEffect(() => () => queue.reset(), [queue]);

  const refsRef = useRef(refs);
  refsRef.current = refs;
  const refsKey = refs.map(itemKey).join('\n');
  useEffect(() => {
    if (enabled) queue.sync(refsRef.current);
  }, [queue, enabled, refsKey, now]);

  const get = useCallback(
    (ref: ItemRef): EpgProgram[] | undefined => (enabled ? queue.get(ref) : undefined),
    // `version` changes whenever the queue stores an answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, enabled, version],
  );
  const unavailable = enabled && queue.unavailable;
  const retry = useCallback(() => queue.retry(), [queue]);
  // `version` also changes when the queue starts backing off.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ get, unavailable, retry }), [get, unavailable, retry, version]);
}
