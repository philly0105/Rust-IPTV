import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { rpc } from '@/api/transport';
import { itemKey, type EpgProgram, type ItemRef } from '@/api/types';

import { StalkerPreviewQueue } from '../lib/stalkerPreviewQueue';

/** Xtream's complete per-channel table, shared across every horizontal guide window. */
export function useXtreamGridPrograms(sourceId: string, enabled: boolean, refs: readonly ItemRef[], now: number) {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const bumpRef = useRef(bump);
  bumpRef.current = bump;
  const frame = useRef(0);
  const queue = useMemo(
    () => new StalkerPreviewQueue(
      (ref) => rpc('catchup.table', { ref }),
      () => {
        if (frame.current) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = 0;
          bumpRef.current();
        });
      },
      // The result covers every time window; the core also caches the provider response.
      { sourceId: `xtream-grid:${sourceId}`, ttlMs: 20 * 60_000, emptyTtlMs: 20 * 60_000, expireAtProgramBoundary: false, staleWhileRevalidate: true, maxPerSync: 24 },
    ),
    [sourceId],
  );
  useEffect(() => () => {
    queue.reset();
    cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, [queue]);

  const refsRef = useRef(refs);
  refsRef.current = refs;
  const refsKey = refs.map(itemKey).join('\n');
  // Refill after each batch: a very tall viewport can contain more than maxPerSync rows.
  useEffect(() => queue.sync(enabled ? refsRef.current : []), [queue, enabled, refsKey, now, version]);

  return useCallback(
    (ref: ItemRef): EpgProgram[] | undefined => (enabled ? queue.get(ref) : undefined),
    // A stored answer triggers a new getter and a guide render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, enabled, version],
  );
}
