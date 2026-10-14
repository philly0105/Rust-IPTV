/** Where the stats page lives (a child of the shell layout route `/`). */
export const STATS_PATH = '/stats';

/** The two ranges the page offers, in days (`stats.summary` accepts exactly these). */
export const STATS_RANGES = [7, 30] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

/** `?range=30` in the URL; anything else is the default 7. */
export function readRange(value: string | null): StatsRange {
  return value === '30' ? 30 : 7;
}
