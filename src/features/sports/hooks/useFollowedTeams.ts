/**
 * The teams the user follows on the Sports page, by `${league}:${ESPN team id}`. A UI preference, so
 * in localStorage like the page's filters, and one store for every card, so following a team in one
 * card marks it in all of them at once.
 */

import { useSyncExternalStore } from 'react';

import type { Game, GameTeam, League } from '../lib/types';

const KEY = 'tsrust.sportsTeams';

let followed: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function read(): ReadonlySet<string> {
  if (followed) return followed;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    followed = new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    followed = new Set();
  }
  return followed;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The key a followed team is stored under: ESPN's team ids are unique within a league. */
export function teamKey(league: League, team: GameTeam): string {
  return `${league}:${team.id}`;
}

export function setFollowed(key: string, on: boolean): void {
  const next = new Set(read());
  if (on) next.add(key);
  else next.delete(key);
  followed = next;
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {
    // storage blocked: the team stays followed until the app closes
  }
  for (const l of listeners) l();
}

/** True when either team of `game` is followed. */
export function followsGame(teams: ReadonlySet<string>, game: Game): boolean {
  return teams.has(teamKey(game.league, game.home)) || teams.has(teamKey(game.league, game.away));
}

export function useFollowedTeams(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, read, read);
}

/** Tests: read localStorage again on the next use. */
export function forgetFollowedTeamsForTests(): void {
  followed = null;
}
