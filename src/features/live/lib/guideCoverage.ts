import type { EpgProgram } from '@/api/types';

import { MINUTE, ms } from './epgTime';

/** A small scheduling gap is common where two XMLTV programmes disagree by a minute. */
const GAP_TOLERANCE = 5 * MINUTE;
const sortedIntervals = new WeakMap<readonly EpgProgram[], readonly (readonly [number, number])[]>();

function intervalsFor(programs: readonly EpgProgram[]): readonly (readonly [number, number])[] {
  const cached = sortedIntervals.get(programs);
  if (cached) return cached;
  // Grid answers are immutable. A moving viewport probes the same channel list repeatedly, so
  // parse and sort it once rather than once per channel at every five-minute label change.
  const intervals = programs.map((p) => [ms(p.start), ms(p.end)] as const).sort((a, b) => a[0] - b[0]);
  sortedIntervals.set(programs, intervals);
  return intervals;
}

/** Whether XMLTV leaves any meaningful part of the visible timeline without a programme. */
export function hasGuideGap(programs: readonly EpgProgram[], from: number, to: number): boolean {
  if (to <= from) return false;
  let coveredUntil = from;
  for (const [start, end] of intervalsFor(programs)) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end <= coveredUntil) continue;
    if (start > coveredUntil + GAP_TOLERANCE) return true;
    coveredUntil = Math.max(coveredUntil, end);
    if (coveredUntil >= to - GAP_TOLERANCE) return false;
  }
  return coveredUntil < to - GAP_TOLERANCE;
}
