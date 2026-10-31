import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { rpc } from '@/api/transport';
import { itemKey, type EpgProgram, type ItemRef } from '@/api/types';

import { DAY } from '../lib/epgTime';
import { releaseStalkerPreviewAnswers, StalkerPreviewQueue } from '../lib/stalkerPreviewQueue';

/**
 * Answers the grid keeps per source: about ten screens of gap rows, as many tables as the core's
 * own archive cache holds (catchup/mod.rs), which answers a later ask without a provider call.
 */
export const XTREAM_GRID_CACHED = 200;

/**
 * The span of the panel's archive table the grid asks for, in the guide's own time: whole UTC days
 * from the day before the data window's first day to the day after its last (F3-1). It covers the
 * window with a day to spare either way and changes once per day of horizontal scrolling, not on
 * every six-hour data step, so one answer serves a day of moves. About 30-70 programmes a day,
 * where the whole table was up to 5,000 with descriptions (a few thousand for a two-week archive).
 */
export function xtreamGridRange(dataStart: number, dataEnd: number, offsetMs: number): { from: number; to: number } {
  const from = Math.floor((dataStart - offsetMs) / DAY) * DAY - DAY;
  return { from, to: from + (Math.ceil((dataEnd - dataStart) / DAY) + 2) * DAY };
}

export interface XtreamGridPrograms {
  /**
   * The row's programmes from the panel's archive table: the answer for the range asked, else,
   * while that loads, the answer for the range asked before, so provider cells do not blink when a
   * horizontal move crosses into the next range (epg.md). undefined while nothing is known.
   */
  get(ref: ItemRef): EpgProgram[] | undefined;
  /** True once the row's answer for the range asked is in. */
  has(ref: ItemRef): boolean;
}

/**
 * Xtream's archive table (`catchup.programs`) for the rows in `refs` over `range` (raw guide time,
 * see {@link xtreamGridRange}), throttled through the preview queue: two requests at a time, at
 * most 24 per sync. Answers are kept per source and range, at most XTREAM_GRID_CACHED, and are
 * released when the guide unmounts; the core caches the provider's table 20 minutes.
 */
export function useXtreamGridPrograms(
  sourceId: string,
  enabled: boolean,
  refs: readonly ItemRef[],
  now: number,
  range: { from: number; to: number },
): XtreamGridPrograms {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const bumpRef = useRef(bump);
  bumpRef.current = bump;
  const frame = useRef(0);
  const { from, to } = range;
  const queue = useMemo(
    () => {
      const args = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
      return new StalkerPreviewQueue(
        (ref) => rpc('catchup.programs', { ref, ...args }),
        () => {
          if (frame.current) return;
          frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            bumpRef.current();
          });
        },
        {
          sourceId: `xtream-grid:${sourceId}`,
          scope: `${from}|${to}`,
          maxCached: XTREAM_GRID_CACHED,
          ttlMs: 20 * 60_000,
          emptyTtlMs: 20 * 60_000,
          expireAtProgramBoundary: false,
          staleWhileRevalidate: true,
          maxPerSync: 24,
        },
      );
    },
    [sourceId, from, to],
  );
  // The queue of the range asked before, for the rows the new range has no answer for yet.
  const shown = useRef({ queue, previous: null as StalkerPreviewQueue | null, sourceId });
  if (shown.current.queue !== queue) {
    shown.current = { queue, previous: shown.current.sourceId === sourceId ? shown.current.queue : null, sourceId };
  }
  const previous = shown.current.previous;
  // reset, not destroy: StrictMode re-runs effects on the same memoized queue.
  useEffect(() => () => {
    queue.reset();
    cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, [queue]);
  // Leaving the guide (or its source) lets the source's answers go; they were kept for the life of
  // the app before, up to 2,000 whole tables (F3-1). After the queue's reset above, so it runs once
  // no queue of the source is syncing.
  useEffect(() => () => releaseStalkerPreviewAnswers(`xtream-grid:${sourceId}`), [sourceId]);

  const refsRef = useRef(refs);
  refsRef.current = refs;
  const refsKey = refs.map(itemKey).join('\n');
  // Refill after each batch: a very tall viewport can contain more than maxPerSync rows.
  useEffect(() => queue.sync(enabled ? refsRef.current : []), [queue, enabled, refsKey, now, version]);

  const get = useCallback(
    (ref: ItemRef): EpgProgram[] | undefined => (enabled ? (queue.get(ref) ?? previous?.get(ref)) : undefined),
    // A stored answer triggers a new getter and a guide render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, previous, enabled, version],
  );
  const has = useCallback(
    (ref: ItemRef): boolean => enabled && queue.get(ref) !== undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, enabled, version],
  );
  return useMemo(() => ({ get, has }), [get, has]);
}
