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
 * With `from` (epoch ms), the portal also returns the archived programmes since then, and with
 * `to` as well only those starting before it, from the day tables up to it. Answers are cached per
 * source by channel, `limit`, `from` and `to`, so a guide window moved back to where it was reuses
 * them; the backoff is per source too, so a new window or page keeps waiting out a silent portal
 * instead of asking it again at once.
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
  /** With `from`, a window wholly over: its end (epoch ms). */
  to?: number,
): StalkerPreviews {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const bumpRef = useRef(bump);
  bumpRef.current = bump;
  // Answers that land in one frame re-render the list once, not once each (LV-3, as useShortEpg).
  const frame = useRef(0);

  // `to` only goes with `from`, as the core reads it.
  const until = from === undefined ? undefined : to;
  const queue = useMemo(
    () => {
      const archive = from === undefined ? {} : { from: new Date(from).toISOString(), ...(until === undefined ? {} : { to: new Date(until).toISOString() }) };
      return new StalkerPreviewQueue(
        (ref) => rpc('stalker.epg', { ref, limit, ...archive }),
        () => {
          if (frame.current) return;
          frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            bumpRef.current();
          });
        },
        // An open-ended window keeps its `limit|from` key.
        { sourceId, scope: `${limit}|${from ?? ''}${until === undefined ? '' : `|${until}`}` },
      );
    },
    // One queue per source, size and window; backoff and answers live with the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceId, limit, from, until],
  );
  // reset, not destroy: StrictMode re-runs effects on the same memoized queue.
  useEffect(
    () => () => {
      queue.reset();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [queue],
  );

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
