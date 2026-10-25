import { LEAGUES, type League } from './lib/types';

/** Where the sports page lives (a child of the shell layout route `/`). */
export const SPORTS_PATH = '/sports';

/** `?league=nba` in the URL; anything else (or nothing) is every league, read as null. */
export function readLeague(value: string | null): League | null {
  return LEAGUES.find((l) => l === value) ?? null;
}

/** Days picked on the strip since the app started. */
const pickedDays = new Set<string>();

/** Notes a day picked on the strip, so its `?day=` holds for the rest of this run of the app. */
export function pickDay(day: string): void {
  pickedDays.add(day);
}

/**
 * `?day=YYYY-MM-DD` when it is one of `days` (the strip's Eastern dates) and was picked in this run
 * of the app; anything else is `today`. lastRoute saves the query and startup restores it, so a day
 * picked in an earlier run, or one that has slid out of the window, opens today, not an old date.
 */
export function readDay(value: string | null, days: readonly string[], today: string): string {
  return value !== null && days.includes(value) && pickedDays.has(value) ? value : today;
}

/** Whether "With streams" hides the games no channel was found for: a UI preference, kept in localStorage. */
const STREAMS_ONLY_KEY = 'tsrust.sportsStreamsOnly';

export function readStreamsOnly(): boolean {
  try {
    return localStorage.getItem(STREAMS_ONLY_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeStreamsOnly(on: boolean): void {
  try {
    localStorage.setItem(STREAMS_ONLY_KEY, on ? '1' : '0');
  } catch {
    // storage blocked: the filter still applies, until the page opens again
  }
}
