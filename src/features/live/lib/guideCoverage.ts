import type { EpgProgram } from '@/api/types';

import { MINUTE, ms } from './epgTime';

/** A small scheduling gap is common where two XMLTV programmes disagree by a minute. */
const GAP_TOLERANCE = 5 * MINUTE;

/** Whether XMLTV leaves any meaningful part of the visible timeline without a programme. */
export function hasGuideGap(programs: readonly EpgProgram[], from: number, to: number): boolean {
  if (to <= from) return false;
  let coveredUntil = from;
  for (const program of [...programs].sort((a, b) => ms(a.start) - ms(b.start))) {
    const start = ms(program.start);
    const end = ms(program.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end <= coveredUntil) continue;
    if (start > coveredUntil + GAP_TOLERANCE) return true;
    coveredUntil = Math.max(coveredUntil, end);
    if (coveredUntil >= to - GAP_TOLERANCE) return false;
  }
  return coveredUntil < to - GAP_TOLERANCE;
}
