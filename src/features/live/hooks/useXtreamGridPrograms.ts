import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { rpc } from '@/api/transport';
import { itemKey, type EpgProgram, type ItemRef } from '@/api/types';

import { StalkerPreviewQueue } from '../lib/stalkerPreviewQueue';

/**
 * Whole tables the guide keeps, as many as the core keeps of the provider's answers (a row beyond
 * them costs a provider request either way). A table holds the channel's whole archive with
 * descriptions, often 100 KB or more, and a guide scrolled down a long list asks for one per row
 * whose XMLTV leaves a gap near the view: the default of 2,000 per source held them all session.
 */
export const XTREAM_GRID_TABLES = 200;

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
      {
        sourceId: `xtream-grid:${sourceId}`,
        ttlMs: 20 * 60_000,
        emptyTtlMs: 20 * 60_000,
        expireAtProgramBoundary: false,
        staleWhileRevalidate: true,
        maxPerSync: 24,
        maxCached: XTREAM_GRID_TABLES,
      },
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
