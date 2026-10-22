/**
 * ESPN scoreboards through React Query: one query per league and Eastern day, keyed
 * ['sports.espn', league, etDate], so the day view and "Live now" share their requests. How often a
 * day refetches follows what it holds (`dayPolicy`). Intervals pause while the document is hidden
 * and stop when the page unmounts; a failed refetch is retried twice with backoff and the last good
 * games stay on screen. Offline, fetches fail rather than pause, and reconnecting refetches at once.
 */

import { queryOptions, useQueries, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { etDate, fetchScoreboard, shiftEtDate } from '../lib/espn';
import { LEAGUES, type Game, type League } from '../lib/types';

const MINUTE = 60_000;

/** Refetch interval while a game on the day is live or about to start. */
export const LIVE_POLL_MS = 30_000;
/** Refetch interval for today (and an unfinished past day) with nothing live. */
export const TODAY_POLL_MS = 5 * MINUTE;
/** Refetch interval for future days: kickoff times, TBD slots and TV picks change during the week. */
export const FUTURE_POLL_MS = 60 * MINUTE;
/** A scheduled game this close to its start polls like a live one, so the switch to live shows quickly. */
export const SOON_MS = 10 * MINUTE;
/** How long past its listed start a game ESPN still calls scheduled (a delayed first pitch) keeps that pace. */
const LATE_START_MS = 3 * 60 * MINUTE;

export const sportsKey = (league: League, etDate: string) => ['sports.espn', league, etDate] as const;

export interface DayPolicy {
  staleTime: number;
  refetchInterval: number | false;
}

/**
 * Freshness for one league's day. A day with a live game, or a timed game starting within
 * {@link SOON_MS}, polls every 30 s. A past day whose games are all over is settled and never refetches.
 * Today, and a past day not yet settled, refetch every 5 min; future days hourly. Before the first
 * answer (`games` undefined) the day counts by date alone.
 */
export function dayPolicy(day: string, games: readonly Game[] | undefined, now: number): DayPolicy {
  const today = etDate(now);
  if (games) {
    const hot = games.some(
      (g) => g.state === 'in' || (g.state === 'pre' && g.timeValid && g.startMs - now <= SOON_MS && now - g.startMs <= LATE_START_MS),
    );
    if (hot) return { staleTime: LIVE_POLL_MS, refetchInterval: LIVE_POLL_MS };
    if (day < today && games.every((g) => g.state === 'post')) return { staleTime: Infinity, refetchInterval: false };
  }
  if (day > today) return { staleTime: FUTURE_POLL_MS, refetchInterval: FUTURE_POLL_MS };
  return { staleTime: TODAY_POLL_MS, refetchInterval: TODAY_POLL_MS };
}

function dayQuery(league: League, day: string) {
  return queryOptions({
    queryKey: sportsKey(league, day),
    queryFn: ({ signal }) => fetchScoreboard(league, day, signal),
    // Functions, so the policy is re-read after every answer and on every render.
    staleTime: (q) => dayPolicy(day, q.state.data, Date.now()).staleTime,
    refetchInterval: (q) => dayPolicy(day, q.state.data, Date.now()).refetchInterval,
    refetchIntervalInBackground: false,
    // Catch up at once when the window shows again; settled days are never stale, so they stay put.
    refetchOnWindowFocus: true,
    // The app's default retries only retryable RPC errors; ESPN failures are plain errors. Backoff is
    // React Query's default (1 s, then 2 s).
    retry: 2,
    // Fetch even when the webview says it is offline, so the fetch fails and the page shows its error
    // instead of a skeleton that waits for the network. 'always' turns refetchOnReconnect off by default,
    // so it is set again to refetch the moment the network is back.
    networkMode: 'always',
    refetchOnReconnect: true,
  });
}

function leagueOrder(l: League): number {
  return LEAGUES.indexOf(l);
}

function byStart(a: Game, b: Game): number {
  return a.startMs - b.startMs || leagueOrder(a.league) - leagueOrder(b.league) || a.id.localeCompare(b.id);
}

function byLeague(a: Game, b: Game): number {
  return leagueOrder(a.league) - leagueOrder(b.league) || a.startMs - b.startMs || a.id.localeCompare(b.id);
}

// Module-level, so useQueries re-runs them only when a result changes.
function combineDay(results: UseQueryResult<Game[]>[]) {
  return {
    games: results.flatMap((r) => r.data ?? []).sort(byStart),
    loading: results.some((r) => r.isPending),
    error: (results.find((r) => r.error)?.error ?? null) as unknown,
    refetch: () => {
      for (const r of results) void r.refetch();
    },
  };
}

function combineLive(results: UseQueryResult<Game[]>[]) {
  return {
    games: results
      .flatMap((r) => r.data ?? [])
      .filter((g) => g.state === 'in')
      .sort(byLeague),
    loading: results.some((r) => r.isPending),
  };
}

/** Today's Eastern date, re-read every minute so the day keys roll over at midnight Eastern. */
export function useEtToday(): string {
  const [day, setDay] = useState(() => etDate(Date.now()));
  useEffect(() => {
    const id = setInterval(() => setDay(etDate(Date.now())), MINUTE);
    return () => clearInterval(id);
  }, []);
  return day;
}

/**
 * The games of one Eastern day for `leagues`, sorted by start. `loading` while any league has no answer
 * yet; `error` is the first league's failure (its last good games are still in `games`).
 */
export function useSportsDay(
  etDate: string,
  leagues: readonly League[],
): { games: Game[]; loading: boolean; error: unknown; refetch(): void } {
  return useQueries({ queries: leagues.map((l) => dayQuery(l, etDate)), combine: combineDay });
}

/**
 * Games in progress for `leagues`, by league and then start. Reads today's and yesterday's Eastern
 * days, since a late game runs past midnight in yesterday's bucket.
 */
export function useLiveGames(leagues: readonly League[]): { games: Game[]; loading: boolean } {
  const today = useEtToday();
  const days = [shiftEtDate(today, -1), today];
  return useQueries({ queries: leagues.flatMap((l) => days.map((d) => dayQuery(l, d))), combine: combineLive });
}
