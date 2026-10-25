// What the page shows of a day (lib/filter.ts): the team search, the league filter, the Live now,
// Upcoming and Final sections, and the league counts.
import { describe, expect, it } from 'vitest';

import { filterGames, gameMatchesQuery, leagueCounts, sectionGames } from '../lib/filter';
import * as h from './harness';

const HOUR = h.HOUR;

describe('the team search', () => {
  const celtics = h.game('1', { broadcasts: [{ name: 'ESPN', market: 'national', kind: 'tv' }] });
  const aggies = h.game('2', {
    league: 'cfb',
    home: h.team('TA&M', 'Texas A&M Aggies', { location: 'Texas A&M', name: 'Aggies', shortDisplayName: 'Texas A&M' }),
    away: h.team('UGA', 'Georgia Bulldogs', { location: 'Georgia', name: 'Bulldogs', shortDisplayName: 'Georgia' }),
  });

  it('finds a game by the start of any word of its teams, abbreviations or networks', () => {
    expect(gameMatchesQuery(celtics, 'celt')).toBe(true);
    expect(gameMatchesQuery(celtics, 'bos cel')).toBe(true);
    expect(gameMatchesQuery(celtics, 'Knicks')).toBe(true);
    expect(gameMatchesQuery(celtics, 'espn')).toBe(true);
    // Every word must match.
    expect(gameMatchesQuery(celtics, 'boston lakers')).toBe(false);
    // Words, not substrings.
    expect(gameMatchesQuery(celtics, 'eltics')).toBe(false);
  });

  it('folds case, accents and punctuation, and an empty query matches everything', () => {
    expect(gameMatchesQuery(aggies, 'TEXAS a&m')).toBe(true);
    expect(gameMatchesQuery(aggies, 'géorgia')).toBe(true);
    expect(gameMatchesQuery(aggies, '   ')).toBe(true);
    expect(gameMatchesQuery(aggies, '')).toBe(true);
  });

  it('filters by league and query together, keeping the order given', () => {
    const games = [aggies, celtics];
    expect(filterGames(games, null, '').map((g) => g.key)).toEqual(['cfb:2', 'nba:1']);
    expect(filterGames(games, 'nba', '').map((g) => g.key)).toEqual(['nba:1']);
    expect(filterGames(games, null, 'georgia').map((g) => g.key)).toEqual(['cfb:2']);
    expect(filterGames(games, 'nba', 'georgia')).toEqual([]);
  });
});

describe('the sections', () => {
  const now = Date.now();
  const live = h.liveGame('1');
  const liveNfl = h.liveGame('2', { league: 'nfl', startMs: now - 2 * HOUR });
  const lateYesterday = h.liveGame('3', { startMs: now - 3 * HOUR });
  const soon = h.game('4', { startMs: now + HOUR });
  const sooner = h.game('5', { league: 'mlb', startMs: now + 30 * 60_000 });
  const final = h.finalGame('6', { startMs: now - 5 * HOUR });
  const earlier = h.finalGame('7', { league: 'nfl', startMs: now - 9 * HOUR });
  const postponed = h.game('8', { state: 'post', phase: 'postponed', startMs: now - 10 * HOUR });

  it('puts every game in progress first once, then the day by start, finals before postponements', () => {
    const s = sectionGames([live, lateYesterday], [postponed, final, soon, liveNfl, live, earlier, sooner]);
    // From the live list and the day alike, without repeats: by league, then start.
    expect(s.live.map((g) => g.key)).toEqual(['nfl:2', 'nba:3', 'nba:1']);
    expect(s.upcoming.map((g) => g.key)).toEqual(['mlb:5', 'nba:4']);
    expect(s.final.map((g) => g.key)).toEqual(['nfl:7', 'nba:6', 'nba:8']);
  });

  it('counts the games of each league', () => {
    expect(leagueCounts([live, liveNfl, soon, sooner])).toEqual({ nfl: 1, cfb: 0, nba: 2, mlb: 1 });
    expect(leagueCounts([])).toEqual({ nfl: 0, cfb: 0, nba: 0, mlb: 0 });
  });
});
