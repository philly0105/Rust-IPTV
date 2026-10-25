/**
 * What the Sports page shows of a day: the games of the picked league that match the team search,
 * split into Live now, Upcoming and Final. Pure, so the page and its tests share one reading.
 */

import type { Game, League } from './types';

/** Words of a name or a query: folded (accents, "ᴴᴰ"), lower case, split at anything not a letter or digit. */
function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const haystacks = new WeakMap<Game, string[]>();

/** Every word the team search looks at: both teams' names, abbreviations and schools, and the networks. */
function gameWords(game: Game): string[] {
  let list = haystacks.get(game);
  if (!list) {
    const parts: string[] = [];
    for (const team of [game.away, game.home]) parts.push(team.displayName, team.shortDisplayName, team.name, team.location, team.abbreviation);
    for (const b of game.broadcasts) parts.push(b.name);
    list = [...new Set(parts.flatMap(words))];
    haystacks.set(game, list);
  }
  return list;
}

/**
 * True when every word of `query` starts a word of the game's teams or networks, as the app's own
 * search reads words: "bos cel" finds Boston Celtics, "espn" every game ESPN carries. An empty
 * query matches every game.
 */
export function gameMatchesQuery(game: Game, query: string): boolean {
  const want = words(query);
  if (want.length === 0) return true;
  const have = gameWords(game);
  return want.every((w) => have.some((h) => h.startsWith(w)));
}

/** The games of `league` (every league when null) that match `query`, in the order given. */
export function filterGames(games: readonly Game[], league: League | null, query: string): Game[] {
  return games.filter((g) => (league === null || g.league === league) && gameMatchesQuery(g, query));
}

export interface GameSections {
  /** In progress, from the live list and the day alike, by league and then start. */
  live: Game[];
  /** Not started yet, by start. */
  upcoming: Game[];
  /** Over: finals by start, then postponed, canceled and suspended games. */
  final: Game[];
}

const LEAGUE_ORDER: readonly League[] = ['nfl', 'cfb', 'nba', 'mlb'];

function byLeagueThenStart(a: Game, b: Game): number {
  return LEAGUE_ORDER.indexOf(a.league) - LEAGUE_ORDER.indexOf(b.league) || a.startMs - b.startMs || a.id.localeCompare(b.id);
}

function byStart(a: Game, b: Game): number {
  return a.startMs - b.startMs || LEAGUE_ORDER.indexOf(a.league) - LEAGUE_ORDER.indexOf(b.league) || a.id.localeCompare(b.id);
}

/**
 * The page's three sections. `live` holds the games in progress from today and yesterday (a late game
 * runs past midnight in yesterday's list), whatever day is picked; the picked day's own live games join
 * them, so a game never shows twice. A postponed, canceled or suspended game is over for the page: it
 * goes after the finals.
 */
export function sectionGames(live: readonly Game[], day: readonly Game[]): GameSections {
  const seen = new Set<string>();
  const inProgress: Game[] = [];
  for (const g of [...live, ...day.filter((d) => d.phase === 'live')]) {
    if (seen.has(g.key)) continue;
    seen.add(g.key);
    inProgress.push(g);
  }
  const rest = day.filter((g) => !seen.has(g.key));
  const finals = rest.filter((g) => g.phase === 'final').sort(byStart);
  const off = rest.filter((g) => g.phase === 'postponed' || g.phase === 'canceled' || g.phase === 'suspended').sort(byStart);
  return {
    live: inProgress.sort(byLeagueThenStart),
    upcoming: rest.filter((g) => g.phase === 'scheduled').sort(byStart),
    final: [...finals, ...off],
  };
}

/** Games per league, for the league tabs' counts. */
export function leagueCounts(games: readonly Game[]): Record<League, number> {
  const counts: Record<League, number> = { nfl: 0, cfb: 0, nba: 0, mlb: 0 };
  for (const g of games) counts[g.league]++;
  return counts;
}
