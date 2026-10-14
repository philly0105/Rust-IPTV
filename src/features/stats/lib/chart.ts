/** Scale and labels for the per-day bar chart. */

import type { WatchStatsDay } from '@/api/types';

/** Gridline steps the chart may use, in seconds: 15 min up to 12 h. */
const STEPS = [900, 1800, 3600, 7200, 10800, 14400, 21600, 43200];
/** Most gridlines above the baseline. */
const MAX_LINES = 4;

export interface ChartScale {
  /** Seconds at the top of the chart. */
  top: number;
  /** Gridline values above zero, ascending; the last equals `top`. */
  ticks: number[];
}

/** The smallest step that fits the busiest day in at most four gridlines; an empty range gets 0..1 h. */
export function chartScale(days: readonly WatchStatsDay[]): ChartScale {
  const max = days.reduce((m, d) => Math.max(m, d.seconds), 0);
  if (max <= 0) return { top: 3600, ticks: [1800, 3600] };
  const step = STEPS.find((s) => Math.ceil(max / s) <= MAX_LINES) ?? STEPS[STEPS.length - 1]!;
  const lines = Math.max(1, Math.ceil(max / step));
  const ticks = Array.from({ length: lines }, (_, i) => (i + 1) * step);
  return { top: lines * step, ticks };
}

/** Bar height in percent of the chart, at least 2 % for any non-zero value so a minute still shows. */
export function barPercent(seconds: number, top: number): number {
  if (seconds <= 0 || top <= 0) return 0;
  return Math.max(2, Math.min(100, (seconds / top) * 100));
}

/**
 * Which axis labels the 30-day chart prints: today and every 7th day back
 * from it, so the labels line up with this weekday and never crowd a phone.
 */
export function showDayLabel(index: number, count: number): boolean {
  if (count <= 7) return true;
  return (count - 1 - index) % 7 === 0;
}

/** Sums a range into live and VOD totals. */
export function rangeTotals(days: readonly WatchStatsDay[]): { live: number; vod: number } {
  return days.reduce((acc, d) => ({ live: acc.live + d.liveSeconds, vod: acc.vod + d.vodSeconds }), { live: 0, vod: 0 });
}
