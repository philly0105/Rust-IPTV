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
 * Earlier ranges that answered, whose programmes a row still shows while the range asked has none
 * for it. Each spans three or four days, so three cover a fling of several days either way.
 */
const KEPT_RANGES = 3;

interface KeptRange {
  queue: StalkerPreviewQueue;
  scope: string;
}

/**
 * The span of the panel's archive table the grid asks for, in the guide's own time: whole UTC days
 * from the day before the data window's first day, as many days on as cover the window through its
 * end (F3-1). It always covers the window; the slack after its end runs from a day down to a few
 * hours (less with a time shift that is not whole hours). The range changes once per day of
 * horizontal scrolling, not on every six-hour data step, so one answer serves a day of moves.
 * About 30-70 programmes a day, where the whole table was up to 5,000 with descriptions (a few
 * thousand for a two-week archive).
 */
export function xtreamGridRange(dataStart: number, dataEnd: number, offsetMs: number): { from: number; to: number } {
  const from = Math.floor((dataStart - offsetMs) / DAY) * DAY - DAY;
  return { from, to: from + (Math.ceil((dataEnd - dataStart) / DAY) + 2) * DAY };
}

export interface XtreamGridPrograms {
  /**
   * The row's programmes from the panel's archive table: the answer for the range asked, else,
   * while that loads, the newest answer of the last few ranges that answered, so provider cells do
   * not blink when a horizontal move crosses into the next range (epg.md). undefined while nothing
   * is known.
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
  // The queues of the ranges answered before, newest first, for the rows the new range has no
  // answer for yet. A range left before any answer came is not kept: a fling across two days
  // passes a range it never asks (the guide asks nothing while its data window moves), and the
  // last range that answered still covers the view until the new one does.
  const scope = `${from}|${to}`;
  const shown = useRef({ queue, scope, sourceId, older: [] as readonly KeptRange[] });
  if (shown.current.queue !== queue) {
    const out = shown.current;
    let older: readonly KeptRange[] = [];
    if (out.sourceId === sourceId) {
      older = out.queue.holdsAnswers() ? [{ queue: out.queue, scope: out.scope }, ...out.older.filter((r) => r.scope !== out.scope)] : out.older;
      older = older.filter((r) => r.scope !== scope).slice(0, KEPT_RANGES);
    }
    shown.current = { queue, scope, sourceId, older };
  }
  const older = shown.current.older;
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
    (ref: ItemRef): EpgProgram[] | undefined => {
      if (!enabled) return undefined;
      let programs = queue.get(ref);
      for (let i = 0; programs === undefined && i < older.length; i++) programs = older[i]!.queue.get(ref);
      return programs;
    },
    // A stored answer triggers a new getter and a guide render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, older, enabled, version],
  );
  const has = useCallback(
    (ref: ItemRef): boolean => enabled && queue.get(ref) !== undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, enabled, version],
  );
  return useMemo(() => ({ get, has }), [get, has]);
}
