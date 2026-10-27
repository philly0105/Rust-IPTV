// matchGame: event channel names in several provider styles (a real provider's among them), the time and
// date agreement rule, team channels, network matches with their avoid lists and package services, regional
// flags (NFL Sunday CBS/FOX, RSNs, local stations), guide matches by title and by description, the order and
// dedup of the result, and the candidate filter, which must find what a scan over every channel finds.
import { describe, expect, it } from 'vitest';

import { itemKey, type Channel, type EpgProgram, type ItemKey } from '@/api/types';

import { toIndexed, type IndexedChannel } from '../hooks/useChannelIndex';
import {
  PREPARE_SLICE,
  isEventChannel,
  isTeamChannel,
  matchGame,
  matchGameScanForTests,
  nameTimeAgrees,
  prepareMatch,
  type StreamMatch,
} from '../lib/match';
import type { Game, GameBroadcast, GameTeam, League } from '../lib/types';

function team(abbreviation: string, location: string, name: string, shortDisplayName = name, displayName = `${location} ${name}`): GameTeam {
  return {
    id: abbreviation,
    abbreviation,
    displayName,
    shortDisplayName,
    name,
    location,
    logo: null,
    color: null,
    score: null,
    winner: null,
    record: null,
    rank: null,
  };
}

const CELTICS = team('BOS', 'Boston', 'Celtics');
const KNICKS = team('NY', 'New York', 'Knicks');
const TEXAS = team('TEX', 'Texas', 'Longhorns', 'Texas');
const GEORGIA = team('UGA', 'Georgia', 'Bulldogs', 'Georgia');
const YANKEES = team('NYY', 'New York', 'Yankees');
const RED_SOX = team('BOS', 'Boston', 'Red Sox');
const STEELERS = team('PIT', 'Pittsburgh', 'Steelers');
const BUCS = team('TB', 'Tampa Bay', 'Buccaneers');

const national = (...names: string[]): GameBroadcast[] => names.map((name) => ({ name, market: 'national', kind: 'tv' }));

function game(league: League, away: GameTeam, home: GameTeam, start: string, over: Partial<Game> = {}): Game {
  const startMs = Date.parse(start);
  return {
    key: `${league}:${away.abbreviation}-${home.abbreviation}`,
    id: '1',
    league,
    etDate: new Date(startMs - 4 * 3_600_000).toISOString().slice(0, 10),
    startMs,
    timeValid: true,
    timeNote: null,
    state: 'pre',
    phase: 'scheduled',
    detail: '',
    shortDetail: '',
    period: 0,
    displayClock: '0:00',
    seasonType: 2,
    week: null,
    home,
    away,
    neutralSite: false,
    venue: null,
    note: null,
    seriesSummary: null,
    broadcasts: [],
    gamecastUrl: null,
    ...over,
  };
}

// Thu 2026-10-22 7:05 PM EDT.
const MLB_GAME = game('mlb', YANKEES, RED_SOX, '2026-10-22T23:05Z');
// Fri 2026-10-23 7:00 PM EDT.
const NBA_GAME = game('nba', KNICKS, CELTICS, '2026-10-23T23:00Z', { broadcasts: [{ name: 'Prime Video', market: 'national', kind: 'streaming' }] });
// Sat 2026-10-24 noon EDT.
const CFB_GAME = game('cfb', GEORGIA, TEXAS, '2026-10-24T16:00Z', { broadcasts: [{ name: 'ESPN+', market: 'national', kind: 'streaming' }] });
// Sun 2026-10-18 1:00 PM EDT, CBS only: a regional window game.
const NFL_SUNDAY = game('nfl', STEELERS, BUCS, '2026-10-18T17:00Z', { broadcasts: national('CBS') });

let nextId = 0;
function channel(name: string, sourceId = 's1', over: Partial<Channel> = {}): Channel {
  nextId += 1;
  return { ref: { sourceId, contentType: 'live', itemId: String(nextId) }, name, categoryId: 'c1', categoryName: 'Sports', isRadio: false, ...over };
}

function indexed(name: string, sourceId = 's1'): IndexedChannel {
  return toIndexed(channel(name, sourceId), { id: sourceId, kind: 'xtream', name: sourceId.toUpperCase() }, true);
}

function programme(title: string, start: string, end: string, description?: string, category?: string): EpgProgram {
  return { channelId: 'x', title, start, end, ...(description ? { description } : {}), ...(category ? { category } : {}) };
}

function guide(entries: [IndexedChannel, EpgProgram[]][]): Map<ItemKey, EpgProgram[]> {
  return new Map(entries.map(([ch, list]) => [itemKey(ch.channel.ref), list]));
}

const NONE = new Map<ItemKey, EpgProgram[]>();
const names = (matches: StreamMatch[]) => matches.map((m) => m.channel.name);
const brief = (matches: StreamMatch[]) => matches.map((m) => [m.channel.name, m.reason, m.regional]);

describe('event channels', () => {
  it('matches per-game channel names in many provider styles', () => {
    expect(names(matchGame(NBA_GAME, [indexed('NBA League Pass 05: Boston Celtics vs New York Knicks')], NONE))).toHaveLength(1);
    expect(names(matchGame(NBA_GAME, [indexed('US| NBA 05 : NYK @ BOS 7:30PM ET')], NONE))).toHaveLength(1);
    expect(names(matchGame(CFB_GAME, [indexed('ESPN+ 12 | Texas vs Georgia')], NONE))).toHaveLength(1);
    expect(names(matchGame(MLB_GAME, [indexed('USA | MLB 07: Yankees x Red Sox (10/22 7:05 PM ET)')], NONE))).toHaveLength(1);
    const [m] = matchGame(NBA_GAME, [indexed('NBA League Pass 05: Boston Celtics vs New York Knicks')], NONE);
    expect(m).toMatchObject({ reason: 'event', regional: false, program: null, sourceId: 's1', sourceKind: 'xtream', sourceName: 'S1' });
  });

  it('needs both teams, of this league', () => {
    expect(matchGame(NBA_GAME, [indexed('NBA League Pass 05: Boston Celtics vs Miami Heat')], NONE)).toEqual([]);
    expect(matchGame(NBA_GAME, [indexed('Boston Celtics Pregame')], NONE)).toEqual([]);
    // A short colon tag is cut from the tokens, but the mark is read from the whole name.
    const giants = team('NYG', 'New York', 'Giants');
    const cards = team('ARI', 'Arizona', 'Cardinals');
    const nfl = game('nfl', giants, cards, '2026-10-25T20:25Z');
    expect(isEventChannel(indexed('MLB: Giants x Cardinals'), nfl)).toBe(false);
    expect(isEventChannel(indexed('NFL: Giants x Cardinals'), nfl)).toBe(true);
  });

  it('finds a slot channel without teams (NFL Sunday Ticket 3) only through the guide', () => {
    const slot = indexed('NFL Sunday Ticket 3');
    expect(matchGame(NFL_SUNDAY, [slot], NONE)).toEqual([]);
    const programs = guide([[slot, [programme('NFL Football', '2026-10-18T17:00Z', '2026-10-18T20:15Z', 'Pittsburgh Steelers at Tampa Bay Buccaneers.')]]]);
    expect(brief(matchGame(NFL_SUNDAY, [slot], programs))).toEqual([['NFL Sunday Ticket 3', 'guide', false]]);
  });

  it('turns down a name whose time or date is another game', () => {
    expect(matchGame(NBA_GAME, [indexed('US| NBA 05 : NYK @ BOS 11:30PM ET')], NONE)).toEqual([]);
    expect(matchGame(MLB_GAME, [indexed('USA | MLB 07: Yankees x Red Sox (10/21 7:05 PM ET)')], NONE)).toEqual([]);
    // The same name a day later is a different game of the series.
    const nextDay = game('mlb', YANKEES, RED_SOX, '2026-10-23T23:05Z');
    expect(matchGame(nextDay, [indexed('USA | MLB 07: Yankees x Red Sox (10/22 7:05 PM ET)')], NONE)).toEqual([]);
  });

  describe('a name without a date is the current game only', () => {
    const rays = team('TB', 'Tampa Bay', 'Rays');
    const brewers = team('MIL', 'Milwaukee', 'Brewers');
    // World Series: 8:00 PM ET on 10/23 and 10/24 in Milwaukee, then 10/26 in Tampa Bay.
    const g1 = game('mlb', rays, brewers, '2026-10-24T00:00Z');
    const g2 = game('mlb', rays, brewers, '2026-10-25T00:00Z');
    const g3 = game('mlb', brewers, rays, '2026-10-27T00:00Z');
    const afternoon = Date.parse('2026-10-23T18:00Z'); // 2 PM ET on 10/23
    const event = (name: string, g: Game, now?: number) => isEventChannel(indexed(name), g, now);

    it('matches tonight’s game and not the rest of the series', () => {
      for (const name of ['MLB 04: Rays @ Brewers 08:00 PM ET', 'MLB EXTRA INNINGS 02 : Rays vs Brewers']) {
        expect([g1, g2, g3].map((g) => event(name, g, afternoon)), name).toEqual([true, false, false]);
      }
      // Without `now` (the pure rule alone), only the date, time and direction decide.
      expect(event('MLB 04: Rays @ Brewers 08:00 PM ET', g2)).toBe(true);
    });

    it('keeps a live game, and a final for 36 hours after its start (the Yesterday tab’s replay)', () => {
      const name = 'MLB EXTRA INNINGS 02 : Rays vs Brewers';
      // A rain delay keeps it live past its window.
      const live = { ...g1, state: 'in' as const, phase: 'live' as const };
      expect(event(name, live, Date.parse('2026-10-27T08:00Z'))).toBe(true);
      const final = { ...g1, state: 'post' as const, phase: 'final' as const };
      expect(event(name, final, Date.parse('2026-10-24T04:30Z'))).toBe(true);
      // 10 AM ET the next morning, and 35 hours after the start; not 37.
      expect(event(name, final, Date.parse('2026-10-24T14:00Z'))).toBe(true);
      expect(event(name, final, Date.parse('2026-10-25T11:00Z'))).toBe(true);
      expect(event(name, final, Date.parse('2026-10-25T13:00Z'))).toBe(false);
      expect(matchGame(final, [indexed(name)], NONE, Date.parse('2026-10-24T14:00Z'))).toHaveLength(1);
    });

    it('takes a game up to 24 hours ahead, so last night’s and tonight’s games of a series may share a name', () => {
      const name = 'MLB EXTRA INNINGS 02 : Rays vs Brewers';
      // Midnight ET on 10/23 is 20 hours before game 1; noon ET on 10/22 is 32 hours before.
      expect(event(name, g1, Date.parse('2026-10-23T04:00Z'))).toBe(true);
      expect(event(name, g1, Date.parse('2026-10-22T16:00Z'))).toBe(false);
      // 10 AM ET on 10/24: game 1 was last night, game 2 is tonight, game 3 is two days off.
      expect([g1, g2, g3].map((g) => event(name, g, Date.parse('2026-10-24T14:00Z')))).toEqual([true, true, false]);
      // A time in the name still has to agree.
      expect(event('MLB 04: Rays @ Brewers 08:00 PM ET', g2, Date.parse('2026-10-24T14:00Z'))).toBe(true);
      expect(event('MLB 04: Rays @ Brewers 01:00 PM ET', g2, Date.parse('2026-10-24T14:00Z'))).toBe(false);
    });

    it('lets a date in the name reach any day', () => {
      expect(event('MLB 04: Rays @ Brewers (10/24 8:00 PM ET)', g2, afternoon)).toBe(true);
      expect(event('MLB 04: Rays @ Brewers (10/24 8:00 PM ET)', g1, afternoon)).toBe(false);
    });

    it('passes `now` through matchGame', () => {
      const ch = indexed('MLB 04: Rays @ Brewers');
      expect(matchGame(g1, [ch], NONE, afternoon)).toHaveLength(1);
      expect(matchGame(g2, [ch], NONE, afternoon)).toEqual([]);
    });
  });

  it('reads "@" as away at home, unless the game is at a neutral site', () => {
    const clippers = team('LAC', 'LA', 'Clippers');
    const lakers = team('LAL', 'Los Angeles', 'Lakers');
    const name = 'NBA LEAGUE PASS 03 : LA Clippers @ Los Angeles Lakers 10:00 PM ET';
    expect(isEventChannel(indexed(name), game('nba', clippers, lakers, '2026-10-24T02:00Z'))).toBe(true);
    expect(isEventChannel(indexed(name), game('nba', lakers, clippers, '2026-10-29T02:00Z'))).toBe(false);
    expect(isEventChannel(indexed(name), game('nba', lakers, clippers, '2026-10-29T02:00Z', { neutralSite: true }))).toBe(true);
    // "vs" goes either way.
    expect(isEventChannel(indexed('NBA 03: Lakers vs Clippers 10:00 PM ET'), game('nba', clippers, lakers, '2026-10-24T02:00Z'))).toBe(true);
    expect(isEventChannel(indexed('Celtics at Knicks'), NBA_GAME)).toBe(false);
    expect(isEventChannel(indexed('Knicks at Celtics'), NBA_GAME)).toBe(true);
  });

  it('is not the network a name opens with', () => {
    const espnGame = game('nfl', STEELERS, BUCS, '2026-10-27T00:15Z', { broadcasts: national('ESPN') });
    expect(matchGame(espnGame, [indexed('ESPN | Knicks @ Celtics')], NONE)).toEqual([]);
    expect(brief(matchGame(NBA_GAME, [indexed('ESPN | Knicks @ Celtics')], NONE))).toEqual([['ESPN | Knicks @ Celtics', 'event', false]]);
    const lsu = team('LSU', 'LSU', 'Tigers', 'LSU');
    const auburn = team('AUB', 'Auburn', 'Tigers', 'Auburn');
    const abcGame = game('cfb', team('TA&M', 'Texas A&M', 'Aggies', 'Texas A&M'), team('ALA', 'Alabama', 'Crimson Tide', 'Alabama'), '2026-10-24T19:30Z', {
      broadcasts: national('ABC'),
    });
    expect(matchGame(abcGame, [indexed('ABC: LSU vs Auburn')], NONE)).toEqual([]);
    expect(matchGame(game('cfb', auburn, lsu, '2026-10-24T23:30Z', { broadcasts: national('ABC') }), [indexed('ABC: LSU vs Auburn')], NONE)).toHaveLength(1);
    const foxGame = game('cfb', team('BYU', 'BYU', 'Cougars', 'BYU'), team('UCF', 'UCF', 'Knights', 'UCF'), '2026-10-24T19:30Z', { broadcasts: national('FOX') });
    expect(matchGame(foxGame, [indexed('US| FOX ONE 01: Indiana vs Michigan')], NONE)).toEqual([]);
  });

  it('reads the teams before a pipe', () => {
    const hornets = team('CHA', 'Charlotte', 'Hornets');
    const nets = team('BKN', 'Brooklyn', 'Nets');
    expect(isEventChannel(indexed('NBA 04: Hornets x Nets | 7:30PM ET'), game('nba', hornets, nets, '2026-10-21T23:30Z'))).toBe(true);
    const cavs = team('CLE', 'Cleveland', 'Cavaliers');
    const sixers = team('PHI', 'Philadelphia', '76ers');
    expect(isEventChannel(indexed('Cavaliers vs 76ers || 7:00 PM ET'), game('nba', cavs, sixers, '2026-10-22T23:00Z'))).toBe(true);
    const denOkc = game('nba', team('DEN', 'Denver', 'Nuggets'), team('OKC', 'Oklahoma City', 'Thunder'), '2026-10-23T00:30Z');
    expect(isEventChannel(indexed('Nuggets vs Thunder | ESPN'), denOkc)).toBe(true);
    // Not an ESPN channel for another ESPN game.
    expect(matchGame(game('nba', cavs, sixers, '2026-10-22T23:00Z', { broadcasts: national('ESPN') }), [indexed('Nuggets vs Thunder | ESPN')], NONE)).toEqual([]);
  });
});

describe('a real provider’s event channels', () => {
  // ESPN's teams as its scoreboard names them; each name is checked on the day of its game.
  const NINERS = team('SF', 'San Francisco', '49ers');
  const FALCONS = team('ATL', 'Atlanta', 'Falcons');
  const CHIEFS = team('KC', 'Kansas City', 'Chiefs');
  const SEAHAWKS = team('SEA', 'Seattle', 'Seahawks');
  const COWBOYS = team('DAL', 'Dallas', 'Cowboys');
  const EAGLES = team('PHI', 'Philadelphia', 'Eagles');
  const PATRIOTS = team('NE', 'New England', 'Patriots');
  const BEARS = team('CHI', 'Chicago', 'Bears');
  const HORNETS = team('CHA', 'Charlotte', 'Hornets');
  const HEAT = team('MIA', 'Miami', 'Heat');
  const CAVS = team('CLE', 'Cleveland', 'Cavaliers');
  const NETS = team('BKN', 'Brooklyn', 'Nets');
  const JAZZ = team('UTAH', 'Utah', 'Jazz');
  const LAKERS = team('LAL', 'Los Angeles', 'Lakers');
  const WOLVES = team('MIN', 'Minnesota', 'Timberwolves');
  const RAYS = team('TB', 'Tampa Bay', 'Rays');
  const BREWERS = team('MIL', 'Milwaukee', 'Brewers');
  const NCSU = team('NCSU', 'NC State', 'Wolfpack', 'NC State');
  const WAKE = team('WAKE', 'Wake Forest', 'Demon Deacons', 'Wake Forest');
  const event = (name: string, g: Game) => isEventChannel(indexed(name), g, g.startMs - 6 * 3_600_000);

  it('reads NFL slots with a kickoff time and window', () => {
    // Sunday 10/25: 1:00 PM and 8:20 PM EDT; Monday night 8:15 PM EDT.
    expect(event('NFL  | 03 - 1pm 49ers at Falcons', game('nfl', NINERS, FALCONS, '2026-10-25T17:00Z'))).toBe(true);
    expect(event('NFL   | 4k - SNF 8:20pm Chiefs at Seahawks', game('nfl', CHIEFS, SEAHAWKS, '2026-10-26T00:20Z'))).toBe(true);
    expect(event('NFL  | 14 - MNF 8:15pm Cowboys at Eagles', game('nfl', COWBOYS, EAGLES, '2026-10-27T00:15Z'))).toBe(true);
    // The kickoff and the "at" still decide.
    expect(event('NFL  | 03 - 1pm 49ers at Falcons', game('nfl', NINERS, FALCONS, '2026-10-25T20:25Z'))).toBe(false);
    expect(event('NFL  | 03 - 1pm 49ers at Falcons', game('nfl', FALCONS, NINERS, '2026-10-25T17:00Z'))).toBe(false);
  });

  it('reads NBA listings with either team first', () => {
    // Heat at Hornets, Sat 10/24 6:00 PM EDT; one listing says 17:00, the other 6:00 PM.
    const heatAtHornets = game('nba', HEAT, HORNETS, '2026-10-24T22:00Z');
    for (const n of [
      'ENDED | CHA - HORNETS VS MIA - HEAT | Sat 24 Oct 17:00 EDT (US) | 8K EXCLUSIVE | US: NBA PASS PPV 1',
      'Charlotte Hornets vs Miami Heat  @ Oct 24 6:00 PM :NBA  01',
    ]) {
      expect(event(n, heatAtHornets), n).toBe(true);
      expect(event(n, { ...heatAtHornets, home: HEAT, away: HORNETS }), n).toBe(true);
    }
    // Lakers at Jazz, Sun 10/25 4:00 PM EDT, and not their meeting of another day.
    const next = 'NEXT | UTA - JAZZ VS LAL - LAKERS | Sun 25 Oct 16:00 EDT (US) | 8K EXCLUSIVE | US: NBA PASS PPV 9';
    expect(event(next, game('nba', LAKERS, JAZZ, '2026-10-25T20:00Z'))).toBe(true);
    expect(event(next, game('nba', LAKERS, JAZZ, '2026-11-25T20:00Z'))).toBe(false);
    expect(event('Cleveland Cavaliers vs Brooklyn Nets :NBA  02', game('nba', NETS, CAVS, '2026-10-24T22:30Z'))).toBe(true);
  });

  it('reads a start: stamp in UTC', () => {
    // World Series: Rays at Brewers at 8:00 PM EDT on 10/23 and 10/24 (00:00Z the next day).
    const g1 = game('mlb', RAYS, BREWERS, '2026-10-24T00:00Z');
    const g2 = game('mlb', RAYS, BREWERS, '2026-10-25T00:00Z');
    const stamped = 'MLB 01 |  Rays x Brewers start:2026-10-25 01:00:00 stop:2026-10-25 07:13:20';
    expect(event(stamped, g2)).toBe(true);
    expect(event(stamped, g1)).toBe(false);
    // Knicks at Timberwolves, 7:30 PM EST on 1/17/2025.
    const old = 'NBA 02: Knicks (NYK) x Timberwolves (MIN) start:2025-01-18 00:20:00 stop:2025-01-18 04:20:00';
    expect(event(old, game('nba', KNICKS, WOLVES, '2025-01-18T00:30Z'))).toBe(true);
    expect(event(old, game('nba', KNICKS, WOLVES, '2026-10-24T00:30Z'))).toBe(false);
    // While the start is TBD, the stamp's Eastern day.
    const tbd = (day: string, startMs: number) => ({ ...g2, timeValid: false, etDate: day, startMs });
    expect(nameTimeAgrees(stamped, tbd('2026-10-24', Date.parse('2026-10-24T04:00Z')))).toBe(true);
    expect(nameTimeAgrees(stamped, tbd('2026-10-25', Date.parse('2026-10-25T04:00Z')))).toBe(false);
  });

  it('reads an ESPN+ listing in Eastern time, and a college slot with a kickoff', () => {
    const espnPlus = 'US (ESPN+ 005) | Football: Patriots vs. Bears (Patriots vs. Bears) (2026-10-24 06:00:00)';
    expect(event(espnPlus, game('nfl', PATRIOTS, BEARS, '2026-10-24T10:00Z'))).toBe(true);
    // 06:00 UTC would be 2 AM Eastern.
    expect(event(espnPlus, game('nfl', PATRIOTS, BEARS, '2026-10-24T06:00Z'))).toBe(false);
    const ncaaf = 'NCAAF 01: NC State at Wake Forest 7:30pm';
    expect(event(ncaaf, game('cfb', NCSU, WAKE, '2026-10-24T23:30Z'))).toBe(true);
    expect(event(ncaaf, game('cfb', WAKE, NCSU, '2026-10-24T23:30Z'))).toBe(false);
  });

  it('matches its network and slot channels', () => {
    const index = ['US: FOX SPORTS 1 4K', 'US: FOX NEWS HD', 'US: FOX SPORTS DETROIT HD', 'NCAAF 02: ESPN2', 'NCAAF 17:', 'NFL  | 01 -', 'CA EN: TSN 1'].map((n) =>
      indexed(n),
    );
    const on = (...names: string[]) => game('cfb', NCSU, WAKE, '2026-10-24T23:30Z', { broadcasts: national(...names) });
    expect(brief(matchGame(on('FS1'), index, NONE))).toEqual([['US: FOX SPORTS 1 4K', 'network', false]]);
    expect(brief(matchGame(on('ESPN2'), index, NONE))).toEqual([['NCAAF 02: ESPN2', 'network', false]]);
    expect(matchGame(on('FOX'), index, NONE)).toEqual([]);
    const tigers = game('mlb', team('DET', 'Detroit', 'Tigers'), team('CLE', 'Cleveland', 'Guardians'), '2026-09-12T23:10Z', {
      broadcasts: [{ name: 'FanDuel SN Detroit', market: 'away', kind: 'tv' }],
    });
    expect(brief(matchGame(tigers, index, NONE))).toEqual([['US: FOX SPORTS DETROIT HD', 'network', true]]);
    const raptors = game('nba', team('TOR', 'Toronto', 'Raptors'), WOLVES, '2026-10-25T22:00Z', { broadcasts: [{ name: 'TSN', market: 'away', kind: 'tv' }] });
    expect(brief(matchGame(raptors, index, NONE))).toEqual([['CA EN: TSN 1', 'network', true]]);
    // A slot tagged by its league reads its network from the whole name.
    expect(indexed('NFL | 02 - ESPN').network).toBe('espn');
  });
});

describe('team channels', () => {
  it('match their team’s games, home or away, after the event channels, and after a national network as regional', () => {
    const g = game('nba', KNICKS, CELTICS, '2026-10-23T23:00Z', { broadcasts: national('ESPN') });
    const index = ['NBA: BOSTON CELTICS SD', 'US: ESPN HD', 'NBA: BOSTON CELTICS ᴴᴰ', 'NBA: NEW YORK KNICKS ᴴᴰ', 'NBA 05: Knicks @ Celtics', 'NBA: MIAMI HEAT ᴴᴰ'].map(
      (n) => indexed(n),
    );
    // ESPN carries it nationally, so the teams' own feeds may be blacked out. ESPN's name says HD, the event
    // channel's no quality.
    expect(brief(matchGame(g, index, NONE))).toEqual([
      ['US: ESPN HD', 'network', false],
      ['NBA 05: Knicks @ Celtics', 'event', false],
      ['NBA: BOSTON CELTICS ᴴᴰ', 'team', true],
      ['NBA: NEW YORK KNICKS ᴴᴰ', 'team', true],
      ['NBA: BOSTON CELTICS SD', 'team', true],
    ]);
    const mlb = ['US: MLB NEW YORK YANKEES ᴿᴬᵂ', 'US: MLB BOSTON RED SOX ᴿᴬᵂ', 'US: MLB NETWORK', 'US: PRIME MLB ᴴᴰ', 'US: SLING MLB NETWORK ᴴᴰ'].map((n) => indexed(n));
    expect(brief(matchGame(MLB_GAME, mlb, NONE))).toEqual([
      ['US: MLB BOSTON RED SOX ᴿᴬᵂ', 'team', false],
      ['US: MLB NEW YORK YANKEES ᴿᴬᵂ', 'team', false],
    ]);
  });

  it('need the full name, or a nickname beside the league, and no other league', () => {
    const stl = game('mlb', team('MIL', 'Milwaukee', 'Brewers'), team('STL', 'St. Louis', 'Cardinals'), '2026-09-12T23:15Z');
    const ari = game('nfl', team('SEA', 'Seattle', 'Seahawks'), team('ARI', 'Arizona', 'Cardinals'), '2026-09-13T20:05Z');
    const of = (name: string, g: Game) => isTeamChannel(indexed(name), g);
    expect(of('US: MLB ST. LOUIS CARDINALS ᴿᴬᵂ', stl)).toBe(true);
    expect(of('ST. LOUIS CARDINALS', stl)).toBe(true);
    expect(of('MLB: CARDINALS', stl)).toBe(true);
    expect(of('CARDINALS', stl)).toBe(false);
    expect(of('NFL: CARDINALS', stl)).toBe(false);
    expect(of('LOUISVILLE CARDINALS', stl)).toBe(false);
    expect(of('US: MLB ST. LOUIS CARDINALS ᴿᴬᵂ', ari)).toBe(false);
    expect(of('MLB: CARDINALS', ari)).toBe(false);
    expect(of('NFL: CARDINALS', ari)).toBe(true);
    expect(of('ARIZONA CARDINALS', ari)).toBe(true);
    // Provider spellings of the team.
    const clippers = game('nba', team('LAC', 'LA', 'Clippers'), team('LAL', 'Los Angeles', 'Lakers'), '2026-10-24T02:00Z');
    expect(of('NBA: LA CLIPPERS ᴴᴰ', clippers)).toBe(true);
    expect(of('NBA: LOS ANGELES CLIPPERS ᴴᴰ', clippers)).toBe(true);
    expect(of('NBA: NEW YORK KNICKS (NYK) ᴴᴰ', NBA_GAME)).toBe(true);
    const athletics = game('mlb', team('ATH', 'Athletics', 'Athletics', 'Athletics', 'Athletics'), team('SEA', 'Seattle', 'Mariners'), '2026-09-12T02:10Z');
    expect(of('US: MLB OAKLAND ATHLETICS ᴿᴬᵂ', athletics)).toBe(true);
    // College: the full name only.
    expect(of('NCAAF: TEXAS LONGHORNS', CFB_GAME)).toBe(true);
    expect(of('NCAAF: TEXAS', CFB_GAME)).toBe(false);
    expect(of('NCAAF: LONGHORNS', CFB_GAME)).toBe(false);
  });

  it('are never a name with anything else in it', () => {
    for (const n of ['NBA: LEAGUE PASS 1', 'NBA: BOSTON CELTICS / MIAMI HEAT', 'NBA: CELTICS PREGAME', 'BOSTON CELTICS TV', 'NBA TV', 'NBA 13 :']) {
      expect(isTeamChannel(indexed(n), NBA_GAME), n).toBe(false);
    }
  });

  it('may be blacked out for a game a streaming service holds alone, unlike one MLB.TV or League Pass also carries', () => {
    const prime = indexed('US: PRIME VIDEO 1');
    const programs = guide([[prime, [programme('NBA on Prime', '2026-10-23T23:00Z', '2026-10-24T01:30Z', 'The New York Knicks visit the Boston Celtics.')]]]);
    const index = [indexed('NBA: BOSTON CELTICS ᴴᴰ'), indexed('NBA: NEW YORK KNICKS ᴴᴰ'), prime, indexed('NBA 05: Knicks @ Celtics')];
    // NBA_GAME is on Prime Video only: the teams' feeds come after the streams sure to show it, whatever their names say.
    expect(brief(matchGame(NBA_GAME, index, programs))).toEqual([
      ['US: PRIME VIDEO 1', 'guide', false],
      ['NBA 05: Knicks @ Celtics', 'event', false],
      ['NBA: BOSTON CELTICS ᴴᴰ', 'team', true],
      ['NBA: NEW YORK KNICKS ᴴᴰ', 'team', true],
    ]);
    const mlbTv = { ...MLB_GAME, broadcasts: [{ name: 'MLB.TV', market: 'national', kind: 'streaming' }] } satisfies Game;
    expect(brief(matchGame(mlbTv, [indexed('US: MLB BOSTON RED SOX ᴿᴬᵂ')], NONE))).toEqual([['US: MLB BOSTON RED SOX ᴿᴬᵂ', 'team', false]]);
  });

  it('give way to a guide match', () => {
    const celtics = indexed('NBA: BOSTON CELTICS ᴴᴰ');
    const programs = guide([[celtics, [programme('Knicks at Celtics', '2026-10-23T23:00Z', '2026-10-24T01:30Z')]]]);
    expect(brief(matchGame(NBA_GAME, [celtics], programs))).toEqual([['NBA: BOSTON CELTICS ᴴᴰ', 'guide', false]]);
  });
});

describe('nameTimeAgrees', () => {
  it('agrees when the name has neither time nor date', () => {
    expect(nameTimeAgrees('NBA League Pass 05: Celtics vs Knicks', NBA_GAME)).toBe(true);
    expect(nameTimeAgrees('ESPN+ 12 | Texas vs Georgia', CFB_GAME)).toBe(true);
    expect(nameTimeAgrees('NFL Sunday Ticket 3', NFL_SUNDAY)).toBe(true);
  });

  it('needs a date on the game’s Eastern day', () => {
    for (const d of ['(10/22)', 'Oct 22', '22 Oct', 'October 22nd', '2026-10-22', '22.10.2026', '22/10']) {
      expect(nameTimeAgrees(`Yankees x Red Sox ${d}`, MLB_GAME), d).toBe(true);
    }
    for (const d of ['(10/23)', 'Oct 21', '2026-10-23', '2025-10-22']) {
      expect(nameTimeAgrees(`Yankees x Red Sox ${d}`, MLB_GAME), d).toBe(false);
    }
  });

  it('needs a time within 3 hours, read in the zone the name gives (Eastern when none)', () => {
    expect(nameTimeAgrees('BOS @ NYK 7:30PM ET', NBA_GAME)).toBe(true);
    expect(nameTimeAgrees('BOS @ NYK 9:45 pm', NBA_GAME)).toBe(true);
    expect(nameTimeAgrees('BOS @ NYK 10:30PM ET', NBA_GAME)).toBe(false);
    expect(nameTimeAgrees('BOS @ NYK 4:00 PM PT', NBA_GAME)).toBe(true);
    expect(nameTimeAgrees('BOS @ NYK 19:00', NBA_GAME)).toBe(true);
    expect(nameTimeAgrees('BOS @ NYK 7 pm', NBA_GAME)).toBe(true);
    expect(nameTimeAgrees('BOS @ NYK 7 am', NBA_GAME)).toBe(false);
    // 23:00Z is midnight in London (BST): the name's own zone and day.
    expect(nameTimeAgrees('Knicks v Celtics (24/10 00:00 UK)', NBA_GAME)).toBe(true);
    expect(nameTimeAgrees('Knicks v Celtics 00:00 UK', NBA_GAME)).toBe(true);
  });

  it('reads a 12-hour time without am/pm either way, and a bare "p" or "a"', () => {
    // Bills at Raiders, 4:25 PM ET.
    const late = game('nfl', team('BUF', 'Buffalo', 'Bills'), team('LV', 'Las Vegas', 'Raiders'), '2026-10-25T20:25Z');
    for (const n of ['NFL 05: Bills @ Raiders 4:25 ET', 'Bills @ Raiders (4:25 ET)', '4:25p ET', '4:25p', '1:25 PT', '16:25', '4:25 PM ET']) {
      expect(nameTimeAgrees(n, late), n).toBe(true);
    }
    for (const n of ['4:25 AM ET', '4:25a ET', '8:25 ET', '9:25 PT']) expect(nameTimeAgrees(n, late), n).toBe(false);
    expect(nameTimeAgrees('NBA 01: Knicks @ Celtics 7:00 ET', NBA_GAME)).toBe(true);
    expect(nameTimeAgrees('Clippers @ Lakers 10:00 ET', game('nba', KNICKS, CELTICS, '2026-10-24T02:00Z'))).toBe(true);
    expect(nameTimeAgrees('Clippers @ Lakers 7:00 PT', game('nba', KNICKS, CELTICS, '2026-10-24T02:00Z'))).toBe(true);
    // A slot number before a team that starts with "A" is no time.
    expect(nameTimeAgrees("MLB 05 A's vs Royals", MLB_GAME)).toBe(true);
  });

  it('reads a day before the month followed by a time ("22 Oct 20:15")', () => {
    // Patriots at Bears, Thu 10/22 8:15 PM ET.
    const tnf = game('nfl', team('NE', 'New England', 'Patriots'), team('CHI', 'Chicago', 'Bears'), '2026-10-23T00:15Z');
    for (const n of [
      'NFL 19: Patriots @ Bears - 22 Oct 20:15 ET', '22nd October 8:15pm ET', '22 Oct 8.15pm', '23 Oct 01:15 UK', 'Oct 22 @ 8:15 PM ET',
      '10/22 8:15PM', 'Thu 22 Oct 8:15p',
    ]) {
      expect(nameTimeAgrees(n, tnf), n).toBe(true);
    }
    expect(nameTimeAgrees('Tue 21 Oct 7:30pm', tnf)).toBe(false);
    expect(nameTimeAgrees('Tue 21 Oct 7:30pm', game('nfl', STEELERS, BUCS, '2026-10-21T23:30Z'))).toBe(true);
    expect(isEventChannel(indexed('NFL 19: Patriots @ Bears - 22 Oct 20:15 ET'), tnf)).toBe(true);
    expect(nameTimeAgrees('NBA 01: Knicks @ Celtics 23 Oct 7:00 PM', NBA_GAME)).toBe(true);
    expect(nameTimeAgrees('Mon 26 Oct 1pm', game('nfl', STEELERS, BUCS, '2026-10-26T17:00Z'))).toBe(true);
  });

  it('reads a time across midnight', () => {
    const late = game('nba', KNICKS, CELTICS, '2026-10-24T03:40Z'); // 11:40 PM EDT
    expect(nameTimeAgrees('BOS @ NYK 12:10 AM ET', late)).toBe(true);
    expect(nameTimeAgrees('BOS @ NYK 10/23 11:40 PM ET', late)).toBe(true);
  });

  it('does not take a slot number for a time', () => {
    expect(nameTimeAgrees('NBA League Pass 05: Celtics vs Knicks', NBA_GAME)).toBe(true);
    expect(nameTimeAgrees('MLB 07: Yankees x Red Sox', MLB_GAME)).toBe(true);
  });

  it('checks only the date while the start is TBD or a flex window', () => {
    const tbd = game('cfb', GEORGIA, TEXAS, '2026-10-31T04:00Z', { timeValid: false, etDate: '2026-10-31' });
    expect(nameTimeAgrees('Texas vs Georgia 3:30 PM ET', tbd)).toBe(true);
    expect(nameTimeAgrees('Texas vs Georgia 10/31 3:30 PM ET', tbd)).toBe(true);
    expect(nameTimeAgrees('Texas vs Georgia 11/01', tbd)).toBe(false);
    const flex = game('cfb', GEORGIA, TEXAS, '2026-10-24T16:45Z', { timeNote: 'FLEX: 12:45 OR 4:15 PM ET' });
    expect(nameTimeAgrees('Texas vs Georgia 7:30 PM ET', flex)).toBe(true);
  });
});

describe('network channels', () => {
  const espnGame = game('nfl', team('DAL', 'Dallas', 'Cowboys'), team('PHI', 'Philadelphia', 'Eagles'), '2026-10-27T00:15Z', {
    broadcasts: [...national('ESPN', 'ABC'), { name: 'Disney+', market: 'national', kind: 'streaming' }],
  });

  it('takes ESPN, not ESPN2, ESPNU, ESPNews, ESPN+ or ESPN Deportes', () => {
    const index = ['ESPN 2', 'ESPN2 HD', 'ESPNU', 'ESPNews', 'ESPN+ 01', 'ESPN Deportes', 'US: ESPN HD', 'ABC 7 New York', 'Disney+ 3'].map((n) => indexed(n));
    expect(brief(matchGame(espnGame, index, NONE))).toEqual([
      ['US: ESPN HD', 'network', false],
      ['ABC 7 New York', 'network', false],
    ]);
  });

  it('takes FOX, not FS1, Fox News or Fox Business', () => {
    const ws = game('mlb', team('TB', 'Tampa Bay', 'Rays'), team('MIL', 'Milwaukee', 'Brewers'), '2026-10-24T00:00Z', { broadcasts: national('Fox') });
    const index = ['FS1', 'Fox Sports 1', 'Fox News', 'FOX Business', 'FOX 5 New York', 'US| FOX HD'].map((n) => indexed(n));
    // New York is neither team's market, and the network's own feed carries the game.
    expect(names(matchGame(ws, index, NONE))).toEqual(['US| FOX HD']);
  });

  it('does not take feeds from abroad that share the network’s name', () => {
    const ws = game('mlb', team('TB', 'Tampa Bay', 'Rays'), team('MIL', 'Milwaukee', 'Brewers'), '2026-10-24T00:00Z', { broadcasts: national('Fox') });
    const fox = ['AU| FOX CRICKET', 'AU| FOX FOOTY', 'AU| FOX LEAGUE', 'AU| FOX 8', 'US| FOX SOUL', 'US| FOX 5 New York'].map((n) => indexed(n));
    expect(names(matchGame(ws, fox, NONE))).toEqual(['US| FOX 5 New York']);
    const pitt = game('cfb', team('PITT', 'Pittsburgh', 'Panthers', 'Pitt'), team('MIA', 'Miami', 'Hurricanes', 'Miami'), '2026-10-24T19:30Z', {
      broadcasts: national('ESPN'),
    });
    const espn = ['BR: ESPN', 'NL: ESPN 1', 'LATAM| ESPN Norte', 'ESPN Brasil', 'MX: ESPN 2 HD', 'US: ESPN FHD', 'ESPN HD'].map((n) => indexed(n));
    // The group's tag counts when the name has none.
    const latam = toIndexed(channel('ESPN', 's1', { categoryName: 'LATAM| DEPORTES' }), { id: 's1', kind: 'xtream', name: 'S1' }, true);
    expect(names(matchGame(pitt, [...espn, latam], NONE))).toEqual(['US: ESPN FHD', 'ESPN HD']);
    const tnt = game('cfb', team('BAY', 'Baylor', 'Bears', 'Baylor'), team('KU', 'Kansas', 'Jayhawks', 'Kansas'), '2026-10-24T19:30Z', { broadcasts: national('TNT') });
    expect(names(matchGame(tnt, ['BR: TNT', 'TNT Brasil', 'US: TNT'].map((n) => indexed(n)), NONE))).toEqual(['US: TNT']);
    expect(names(matchGame(espnGame, ['AU: ABC', 'CA| ABC SPARK', 'ABC 7 New York'].map((n) => indexed(n)), NONE))).toEqual(['ABC 7 New York']);
  });

  it('takes a network channel whose name goes on after a spaced dash', () => {
    const index = ['US: ESPN - East', 'US| ESPN 2 - East', 'ESPN - Knicks vs Celtics'].map((n) => indexed(n));
    expect(brief(matchGame(espnGame, index, NONE))).toEqual([['US: ESPN - East', 'network', false]]);
    const wttg = game('nfl', STEELERS, BUCS, '2026-10-18T17:00Z', { broadcasts: [{ name: 'Fox 5 WTTG', market: 'home', kind: 'tv' }] });
    expect(brief(matchGame(wttg, [indexed('Washington DC - WTTG')], NONE))).toEqual([['Washington DC - WTTG', 'network', true]]);
  });

  it('takes the US Spanish-language networks from a LATINO group', () => {
    const g = game('mlb', team('TB', 'Tampa Bay', 'Rays'), team('MIL', 'Milwaukee', 'Brewers'), '2026-10-24T00:00Z', {
      broadcasts: national('ESPN Deportes', 'FOX Deportes'),
    });
    const source = { id: 's1', kind: 'xtream', name: 'S1' } as const;
    const row = (name: string, group: string) => toIndexed(channel(name, 's1', { categoryName: group }), source, true);
    const index = [row('ESPN Deportes', 'LATINO'), row('FOX Deportes', 'LATINO | SPORTS'), row('LATINO| ESPN Deportes', 'Sports')];
    expect(index.map((r) => [r.network, r.foreign])).toEqual([
      ['espn-deportes', false],
      ['fox-deportes', false],
      ['espn-deportes', false],
    ]);
    expect(names(matchGame(g, index, NONE))).toEqual(['ESPN Deportes', 'FOX Deportes', 'LATINO| ESPN Deportes']);
  });

  it('lists a feed from abroad after the others it ties with', () => {
    const programs = (chs: IndexedChannel[]) =>
      guide(
        chs.map((c): [IndexedChannel, EpgProgram[]] => [
          c,
          [programme('NFL Football', '2026-10-27T00:15Z', '2026-10-27T03:30Z', 'Dallas Cowboys at Philadelphia Eagles.')],
        ]),
      );
    const index = [indexed('BR: ESPN'), indexed('US: ESPN')];
    expect(brief(matchGame(espnGame, index, programs(index)))).toEqual([
      ['US: ESPN', 'guide', false],
      ['BR: ESPN', 'guide', false],
    ]);
  });

  it("leaves out a station's news stream and its copies on free streaming lineups", () => {
    const ws = game('mlb', team('MIL', 'Milwaukee', 'Brewers'), team('TB', 'Tampa Bay', 'Rays'), '2026-10-28T00:00Z', { broadcasts: national('Fox') });
    const index = ['PRIME: FOX 13 TAMPA BAY ᴿᴬᵂ', 'RK: FOX 6 MILWAUKEE ᴿᴬᵂ', 'PRIME: FOX GREEN BAY NEWS (WLUK) ᴿᴬᵂ', 'US: FOX 13 (WTVT) TAMPA HD'].map((n) => indexed(n));
    expect(index.map((r) => [r.network, r.spinOff])).toEqual([
      [null, true],
      [null, true],
      [null, true],
      ['fox', false],
    ]);
    expect(names(matchGame(ws, index, NONE))).toEqual(['US: FOX 13 (WTVT) TAMPA HD']);
    // Not by a call sign in its name either.
    const rockets = game('nba', team('OKC', 'Oklahoma City', 'Thunder'), team('HOU', 'Houston', 'Rockets'), '2026-10-16T00:30Z', {
      broadcasts: [{ name: 'KTRK (ABC)', market: 'home', kind: 'tv' }],
    });
    const ktrk = ['RK: KTRK ABC13 HOUSTON ᴿᴬᵂ', 'US: ABC 13 (KTRK) HOUSTON HD'].map((n) => indexed(n));
    expect(names(matchGame(rockets, ktrk, NONE))).toEqual(['US: ABC 13 (KTRK) HOUSTON HD']);
    // A news channel the avoid lists keep from its network is no station either.
    const suns = game('nba', team('PHX', 'Phoenix', 'Suns'), team('LAL', 'Los Angeles', 'Lakers'), '2026-10-16T02:00Z', {
      broadcasts: [{ name: "Arizona's Family CBS5", market: 'away', kind: 'tv' }],
    });
    const kpho = ['US: CBS NEWS PHOENIX (KPHO) ᴿᴬᵂ', 'US: CBS 5 (KPHO) PHOENIX HD'].map((n) => indexed(n));
    expect(names(matchGame(suns, kpho, NONE))).toEqual(['US: CBS 5 (KPHO) PHOENIX HD']);
    // Nor through its guide, which is its station's, mapped by name.
    const copy = indexed('PRIME: FOX 13 TAMPA BAY ᴿᴬᵂ');
    const programs = guide([[copy, [programme('2026 World Series', '2026-10-28T00:00Z', '2026-10-28T03:00Z', 'Milwaukee Brewers at Tampa Bay Rays.')]]]);
    expect(matchGame(ws, [copy], programs)).toEqual([]);
  });

  it("never takes another league's slot channel for the network it carries", () => {
    const ws = game('mlb', team('MIL', 'Milwaukee', 'Brewers'), team('TB', 'Tampa Bay', 'Rays'), '2026-10-28T00:00Z', { broadcasts: national('Fox') });
    const index = ['NCAAF 06: FOX', 'NFL | 02 - FOX', 'US| FOX HD'].map((n) => indexed(n));
    expect(names(matchGame(ws, index, NONE))).toEqual(['US| FOX HD']);
    const college = game('cfb', GEORGIA, TEXAS, '2026-10-24T16:00Z', { broadcasts: national('FOX') });
    expect(names(matchGame(college, index, NONE))).toEqual(['US| FOX HD', 'NCAAF 06: FOX']);
    // Nor is such a slot the network's own feed, which would keep its stations elsewhere out.
    const elsewhere = ['US: FOX 5 (WNYW) NEW YORK HD', 'US: FOX 11 (KTTV) LOS ANGELES HD', 'US: FOX 2 (WJBK) DETROIT HD'].map((n) => indexed(n));
    expect(names(matchGame(ws, [indexed('NCAAF 06: FOX'), indexed('US: FOX NFL ᴴᴰ'), ...elsewhere], NONE))).toHaveLength(3);
  });

  it("keeps three of a national game's out-of-market stations even when each one's guide names the game", () => {
    const stations = ['US: ABC 7 (KMGH) DENVER HD', 'US: ABC 7 (WLS) CHICAGO HD', 'US: ABC 7 LITTLE ROCK AR (KATV)', 'US: ABC 7 OMAHA NE (KETV) HD', 'US: ABC 8 (WFAA) DALLAS HD'].map(
      (n) => indexed(n),
    );
    const programs = guide(
      stations.map((c): [IndexedChannel, EpgProgram[]] => [c, [programme('Dallas Cowboys at Philadelphia Eagles', '2026-10-27T00:15Z', '2026-10-27T03:15Z')]]),
    );
    // Dallas is a team's market. Of the four stations elsewhere, the three whose names say HD stay, not Little
    // Rock's, though it comes before Omaha's in the index.
    expect(brief(matchGame(espnGame, stations, programs))).toEqual([
      ['US: ABC 7 (KMGH) DENVER HD', 'guide', false],
      ['US: ABC 7 (WLS) CHICAGO HD', 'guide', false],
      ['US: ABC 7 OMAHA NE (KETV) HD', 'guide', false],
      ['US: ABC 8 (WFAA) DALLAS HD', 'guide', false],
    ]);
  });

  it('never takes a bare USA for USA Network', () => {
    const g = game('cfb', GEORGIA, TEXAS, '2026-10-24T16:00Z', { broadcasts: national('USA Net') });
    expect(names(matchGame(g, ['USA', 'USA Today', 'USA Network HD'].map((n) => indexed(n)), NONE))).toEqual(['USA Network HD']);
  });

  it('never matches a package service by network alone', () => {
    const index = ['Prime Video', 'Amazon Prime 1', 'NBA League Pass 1'].map((n) => indexed(n));
    expect(matchGame(NBA_GAME, index, NONE)).toEqual([]);
    expect(matchGame(CFB_GAME, [indexed('ESPN+ 01')], NONE)).toEqual([]);
  });

  it('flags NFL Sunday games on CBS or FOX only as regional, and a guide confirmation clears it', () => {
    const cbs = indexed('US| CBS HD');
    const ny = indexed('CBS 2 New York');
    const miami = indexed('CBS 4 Miami');
    const pittsburgh = indexed('CBS 2 Pittsburgh (KDKA)');
    const programs = guide([[miami, [programme('NFL Football', '2026-10-18T17:00Z', '2026-10-18T20:15Z', 'The Steelers visit the Buccaneers.')]]]);
    // The network's own feed may show another market's game; a station in Pittsburgh shows this one, and one
    // in New York, neither team's market, is left out.
    expect(brief(matchGame(NFL_SUNDAY, [cbs, ny, miami, pittsburgh], programs))).toEqual([
      ['CBS 4 Miami', 'guide', false],
      ['CBS 2 Pittsburgh (KDKA)', 'network', false],
      ['US| CBS HD', 'network', true],
    ]);
    // Monday on ESPN, and Sunday night on NBC, reach every market.
    const monday = game('nfl', STEELERS, BUCS, '2026-10-20T00:15Z', { broadcasts: national('ESPN') });
    expect(brief(matchGame(monday, [indexed('ESPN')], NONE))).toEqual([['ESPN', 'network', false]]);
    const snf = game('nfl', STEELERS, BUCS, '2026-10-19T00:20Z', { broadcasts: national('NBC') });
    expect(brief(matchGame(snf, [indexed('NBC 4 New York')], NONE))).toEqual([['NBC 4 New York', 'network', false]]);
    // Preseason Sunday games are not the regional window.
    const pre = game('nfl', STEELERS, BUCS, '2026-08-16T17:00Z', { broadcasts: national('CBS'), seasonType: 1 });
    expect(brief(matchGame(pre, [ny], NONE))).toEqual([['CBS 2 New York', 'network', false]]);
  });

  it('puts a team channel after the national network that carries the game, as regional', () => {
    const celtics = indexed('NBA: BOSTON CELTICS ᴴᴰ');
    const espn = indexed('US| ESPN HD');
    // On ESPN nationally: the team's own feed may be blacked out.
    const onEspn = game('nba', KNICKS, CELTICS, '2026-10-23T23:00Z', { broadcasts: national('ESPN') });
    expect(brief(matchGame(onEspn, [celtics, espn], NONE))).toEqual([
      ['US| ESPN HD', 'network', false],
      ['NBA: BOSTON CELTICS ᴴᴰ', 'team', true],
    ]);
    // On the teams' regional networks only: the team's feed carries it, ahead of them.
    const local = game('nba', KNICKS, CELTICS, '2026-10-23T23:00Z', {
      broadcasts: [
        { name: 'NBC Sports Boston', market: 'home', kind: 'tv' },
        { name: 'MSG', market: 'away', kind: 'tv' },
      ],
    });
    expect(brief(matchGame(local, [celtics, indexed('MSG')], NONE))).toEqual([
      ['NBA: BOSTON CELTICS ᴴᴰ', 'team', false],
      ['MSG', 'network', true],
    ]);
    // On ESPN nationally and on a regional network in Boston: the Celtics' feed carries it, the Knicks' may not.
    const both = game('nba', KNICKS, CELTICS, '2026-10-23T23:00Z', { broadcasts: [...national('ESPN'), { name: 'NBC Sports Boston', market: 'home', kind: 'tv' }] });
    expect(brief(matchGame(both, [celtics, indexed('NBA: NEW YORK KNICKS ᴴᴰ'), espn], NONE))).toEqual([
      ['NBA: BOSTON CELTICS ᴴᴰ', 'team', false],
      ['US| ESPN HD', 'network', false],
      ['NBA: NEW YORK KNICKS ᴴᴰ', 'team', true],
    ]);
  });

  it("counts a broadcast network's local stations only in the teams' markets", () => {
    // Sun 2026-10-18 1:00 PM EDT on FOX only: a regional window game.
    const lions = team('DET', 'Detroit', 'Lions');
    const packers = team('GB', 'Green Bay', 'Packers');
    const regional = game('nfl', lions, packers, '2026-10-18T17:00Z', { broadcasts: national('FOX') });
    const own = indexed('US: FOX HD');
    const detroit = indexed('US: FOX 2 (WJBK) DETROIT HD');
    const greenBay = indexed('US: FOX (WLUK) GREEN BAY HD');
    const milwaukee = indexed('US: FOX 6 (WITI) MILWAUKEE HD');
    const newYork = indexed('US: FOX 5 (WNYW) NEW YORK HD');
    const wausau = indexed('US: FOX NET [WAUSAU]');
    const stations = [own, detroit, greenBay, milwaukee, newYork, wausau];
    const flags = (matches: StreamMatch[]) => Object.fromEntries(matches.map((m) => [m.channel.name, m.regional]));
    // The markets' stations carry the game; the network's own feed may show another; the rest are left out.
    expect(flags(matchGame(regional, stations, NONE))).toEqual({
      'US: FOX 2 (WJBK) DETROIT HD': false,
      'US: FOX (WLUK) GREEN BAY HD': false,
      // Green Bay's games air in Milwaukee too.
      'US: FOX 6 (WITI) MILWAUKEE HD': false,
      'US: FOX HD': true,
    });
    // Out-of-market stations stay out of a regional game even without the network's own feed.
    expect(names(matchGame(regional, [newYork, wausau], NONE))).toEqual([]);

    // Sunday night on NBC reaches every market: with the network's own feed the stations add nothing
    // outside the markets; without one, each of them carries the game.
    const sundayNight = game('nfl', lions, packers, '2026-10-19T00:20Z', { broadcasts: national('NBC') });
    const nbc = indexed('US| NBC HD');
    const nbcDetroit = indexed('US: NBC 4 (WDIV) DETROIT HD');
    const nbcBoston = indexed('US: NBC 10 (WBTS) BOSTON HD');
    expect(flags(matchGame(sundayNight, [nbc, nbcDetroit, nbcBoston], NONE))).toEqual({ 'US: NBC 4 (WDIV) DETROIT HD': false, 'US| NBC HD': false });
    expect(flags(matchGame(sundayNight, [nbcDetroit, nbcBoston], NONE))).toEqual({ 'US: NBC 4 (WDIV) DETROIT HD': false, 'US: NBC 10 (WBTS) BOSTON HD': false });
    // ...but only the first three of them, not one per market.
    const elsewhere = ['Atlanta (WXIA)', 'Chicago (WMAQ)', 'Dallas (KXAS)', 'Denver (KUSA)', 'Miami (WTVJ)'].map((c) => indexed(`US: NBC ${c} HD`));
    expect(names(matchGame(sundayNight, elsewhere, NONE))).toHaveLength(3);
    // "NBC USA Network" is USA Network, not a feed of NBC's own.
    expect(names(matchGame(sundayNight, [indexed('US: NBC USA NETWORK (EAST)'), nbcBoston], NONE))).toEqual(['US: NBC 10 (WBTS) BOSTON HD']);
  });

  it('flags regional sports networks and local stations as regional', () => {
    const phi = game('mlb', team('SF', 'San Francisco', 'Giants'), team('PHI', 'Philadelphia', 'Phillies'), '2026-04-29T22:10Z', {
      broadcasts: [
        { name: 'MLB.TV', market: 'national', kind: 'streaming' },
        { name: 'MLB Net', market: 'national', kind: 'tv' },
        { name: 'NBC Sports BA', market: 'away', kind: 'tv' },
        { name: 'NBC Sports Phil', market: 'home', kind: 'tv' },
      ],
    });
    const index = ['NBC Sports Philadelphia HD', 'NBC Sports Bay Area', 'MLB Network', 'MLB.TV 03', 'NBC Sports Boston'].map((n) => indexed(n));
    expect(brief(matchGame(phi, index, NONE))).toEqual([
      ['MLB Network', 'network', false],
      ['NBC Sports Philadelphia HD', 'network', true],
      ['NBC Sports Bay Area', 'network', true],
    ]);
    const okc = game('nba', team('OKC', 'Oklahoma City', 'Thunder'), team('HOU', 'Houston', 'Rockets'), '2026-10-16T00:30Z', {
      broadcasts: [...national('NBA TV'), { name: 'KSBI', market: 'away', kind: 'tv' }],
    });
    expect(brief(matchGame(okc, [indexed('MyNetwork KSBI 52 Oklahoma City'), indexed('NBA TV')], NONE))).toEqual([
      ['NBA TV', 'network', false],
      ['MyNetwork KSBI 52 Oklahoma City', 'network', true],
    ]);
  });
});

describe('guide matches', () => {
  const nbaTv = indexed('NBA TV');

  it('matches a programme by its title, abbreviations included', () => {
    for (const title of ['Celtics at Knicks', 'NBA: BOS @ NYK', 'New York Knicks vs. Boston Celtics']) {
      const programs = guide([[nbaTv, [programme(title, '2026-10-23T23:00Z', '2026-10-24T01:30Z')]]]);
      expect(brief(matchGame(NBA_GAME, [nbaTv], programs)), title).toEqual([['NBA TV', 'guide', false]]);
    }
  });

  it('matches by description, but not by abbreviations in prose', () => {
    const hit = guide([[nbaTv, [programme('NBA Basketball', '2026-10-23T23:00Z', '2026-10-24T01:30Z', 'The Boston Celtics host the New York Knicks.')]]]);
    const [m] = matchGame(NBA_GAME, [nbaTv], hit);
    expect(m).toMatchObject({ reason: 'guide', program: { title: 'NBA Basketball' } });
    const prose = guide([[nbaTv, [programme('NBA Basketball', '2026-10-23T23:00Z', '2026-10-24T01:30Z', 'BOS and NY meet; no Celtics news.')]]]);
    expect(matchGame(NBA_GAME, [nbaTv], prose)).toEqual([]);
  });

  it('needs the programme to overlap the game and to be of its league', () => {
    const early = guide([[nbaTv, [programme('Celtics at Knicks', '2026-10-23T12:00Z', '2026-10-23T14:00Z')]]]);
    expect(matchGame(NBA_GAME, [nbaTv], early)).toEqual([]);
    const giants = team('NYG', 'New York', 'Giants');
    const cards = team('ARI', 'Arizona', 'Cardinals');
    const nfl = game('nfl', giants, cards, '2026-10-25T20:25Z');
    const fox = indexed('FOX 10 Phoenix');
    const mlb = guide([[fox, [programme('MLB Baseball', '2026-10-25T20:00Z', '2026-10-25T23:00Z', 'Giants at Cardinals.')]]]);
    expect(matchGame(nfl, [fox], mlb)).toEqual([]);
    const football = guide([[fox, [programme('NFL Football', '2026-10-25T20:25Z', '2026-10-25T23:40Z', 'Giants at Cardinals.')]]]);
    expect(matchGame(nfl, [fox], football)).toHaveLength(1);
  });

  it('picks the game over the pregame show around it', () => {
    const pre = programme('Celtics Pregame Live', '2026-10-23T22:30Z', '2026-10-23T23:00Z', 'Previewing the Knicks at Celtics.');
    const main = programme('Knicks at Celtics', '2026-10-23T23:00Z', '2026-10-24T01:30Z');
    const [m] = matchGame(NBA_GAME, [nbaTv], guide([[nbaTv, [pre, main]]]));
    expect(m!.program).toBe(main);
  });

  it('never takes a team network’s pregame or postgame show for the game', () => {
    // Knicks at Celtics is on Prime Video only; NBC Sports Boston runs the shows around it.
    const rsn = indexed('US| NBC Sports Boston');
    const shows = [
      programme('Celtics Pregame Live', '2026-10-23T22:00Z', '2026-10-23T23:00Z', 'Previewing the Celtics against the Knicks.'),
      programme('Celtics Postgame Live', '2026-10-24T01:30Z', '2026-10-24T02:30Z', 'Reaction after the Celtics host the Knicks.'),
      // Runs 10 minutes into the game: not the game.
      programme('Celtics vs Knicks: The Rivalry', '2026-10-23T22:00Z', '2026-10-23T23:10Z'),
      programme('Knicks vs Celtics Preview', '2026-10-23T23:00Z', '2026-10-24T01:30Z'),
      programme('Celtics Post-Game', '2026-10-24T01:00Z', '2026-10-24T02:00Z', 'Knicks at Celtics wrap-up.'),
    ];
    for (const p of shows) expect(matchGame(NBA_GAME, [rsn], guide([[rsn, [p]]])), p.title).toEqual([]);
    // A start still TBD has no core to overlap: the title alone keeps the show out.
    const tbd = game('nba', KNICKS, CELTICS, '2026-10-23T04:00Z', { timeValid: false });
    expect(matchGame(tbd, [rsn], guide([[rsn, [shows[0]!]]]))).toEqual([]);
    // A short programme covering half of itself inside the game counts.
    const short = programme('Knicks at Celtics', '2026-10-24T01:10Z', '2026-10-24T01:50Z');
    expect(matchGame(NBA_GAME, [rsn], guide([[rsn, [short]]]))).toHaveLength(1);
  });
});

describe('order and dedup', () => {
  it('orders guide, event, network, regional last, then sources, then channel name', () => {
    const g = game('nba', KNICKS, CELTICS, '2026-10-23T23:00Z', {
      broadcasts: [...national('ESPN'), { name: 'NESN', market: 'home', kind: 'tv' }],
    });
    const s2Espn = indexed('ESPN', 's2');
    const s1Espn = indexed('US: ESPN', 's1');
    const nesn = indexed('NESN', 's1');
    const lp10 = indexed('NBA League Pass 10: Knicks @ Celtics', 's1');
    const lp2 = indexed('NBA League Pass 2: Knicks @ Celtics', 's1');
    const tnt = indexed('TNT', 's2');
    const programs = guide([[tnt, [programme('Knicks at Celtics', '2026-10-23T23:00Z', '2026-10-24T01:30Z')]]]);
    const out = matchGame(g, [s1Espn, nesn, lp10, lp2, s2Espn, tnt], programs);
    expect(brief(out)).toEqual([
      ['TNT', 'guide', false],
      ['NBA League Pass 2: Knicks @ Celtics', 'event', false],
      ['NBA League Pass 10: Knicks @ Celtics', 'event', false],
      ['US: ESPN', 'network', false],
      ['ESPN', 'network', false],
      ['NESN', 'network', true],
    ]);
  });

  it('lists backup feeds and SD copies after the main feeds', () => {
    const g = game('nba', KNICKS, CELTICS, '2026-10-23T23:00Z', { broadcasts: national('ESPN') });
    const index = ['US| ESPN (Backup)', 'US| ESPN SD', 'US| ESPN HD', 'US| ESPN BKP 2', 'NBA 05: Knicks @ Celtics ALT', 'NBA 06: Knicks @ Celtics'].map((n) =>
      indexed(n),
    );
    expect(brief(matchGame(g, index, NONE))).toEqual([
      ['US| ESPN HD', 'network', false],
      ['NBA 06: Knicks @ Celtics', 'event', false],
      ['NBA 05: Knicks @ Celtics ALT', 'event', false],
      ['US| ESPN (Backup)', 'network', false],
      ['US| ESPN BKP 2', 'network', false],
      ['US| ESPN SD', 'network', false],
    ]);
  });

  it('puts the quality a name gives ahead of the route among the sure matches', () => {
    const mnf = game('nfl', team('DAL', 'Dallas', 'Cowboys'), team('PHI', 'Philadelphia', 'Eagles'), '2026-10-27T00:15Z', { broadcasts: national('ESPN', 'ABC') });
    const index = ['CA EN: TSN 1', 'US: ESPN HD', '4K: ESPN ᵁᴴᴰ ³⁸⁴⁰ᴾ', 'US: ESPN SD'].map((n) => indexed(n));
    const programs = guide(
      index.slice(0, 2).map((c): [IndexedChannel, EpgProgram[]] => [c, [programme('NFL Football', '2026-10-27T00:15Z', '2026-10-27T03:30Z', 'The Philadelphia Eagles host the Dallas Cowboys.')]]),
    );
    expect(brief(matchGame(mnf, index, programs))).toEqual([
      ['4K: ESPN ᵁᴴᴰ ³⁸⁴⁰ᴾ', 'network', false],
      ['US: ESPN HD', 'guide', false],
      ['CA EN: TSN 1', 'guide', false],
      ['US: ESPN SD', 'network', false],
    ]);
  });

  it('lists feeds from abroad after every home feed, the regional ones too', () => {
    const ws = game('mlb', team('MIL', 'Milwaukee', 'Brewers'), team('TB', 'Tampa Bay', 'Rays'), '2026-10-28T00:00Z', { broadcasts: national('Fox') });
    const abroad = indexed('BH: ARENA PREMIUM 2 ᴿᴬᵂ');
    const index = [abroad, indexed('US: MLB TAMPA BAY RAYS ᴿᴬᵂ'), indexed('US: FOX 13 (WTVT) TAMPA HD')];
    const programs = guide([[abroad, [programme('Uživo: Tampa Bay Rays - Milwaukee Brewers, finale G4', '2026-10-28T00:00Z', '2026-10-28T03:00Z')]]]);
    expect(brief(matchGame(ws, index, programs))).toEqual([
      ['US: FOX 13 (WTVT) TAMPA HD', 'network', false],
      // FOX carries it nationally: the Rays' own feed may be blacked out.
      ['US: MLB TAMPA BAY RAYS ᴿᴬᵂ', 'team', true],
      ['BH: ARENA PREMIUM 2 ᴿᴬᵂ', 'guide', false],
    ]);
  });

  it('lists a channel once, with its strongest route', () => {
    const espn = indexed('ESPN: Knicks vs Celtics');
    const g = game('nba', KNICKS, CELTICS, '2026-10-23T23:00Z', { broadcasts: national('ESPN') });
    // Network and event at once: the event wins. The same row twice in the index: listed once.
    expect(brief(matchGame(g, [espn, espn], NONE))).toEqual([['ESPN: Knicks vs Celtics', 'event', false]]);
  });
});

describe('candidates', () => {
  // Each route through a different word: a description, a title abbreviation, a call sign mid-name, a network,
  // an event name, team channels; and channels that hold one team only, or the other league's game.
  const okc = game('nba', team('OKC', 'Oklahoma City', 'Thunder'), team('HOU', 'Houston', 'Rockets'), '2026-10-16T00:30Z', {
    broadcasts: [...national('NBA TV'), { name: 'KSBI', market: 'away', kind: 'tv' }],
  });
  const espnGame = game('nba', KNICKS, CELTICS, '2026-10-23T23:00Z', { broadcasts: [...national('ESPN'), { name: 'NESN', market: 'home', kind: 'tv' }] });
  // FOX by name, WTTG by the call sign inside it.
  const wttg = game('nfl', STEELERS, BUCS, '2026-10-18T17:00Z', { broadcasts: [{ name: 'Fox 5 WTTG', market: 'home', kind: 'tv' }] });
  const games = [espnGame, okc, wttg, MLB_GAME, CFB_GAME, NFL_SUNDAY];
  const rows = [
    indexed('Sports 1'),
    indexed('Sports 2'),
    indexed('Sports 3'),
    indexed('MyNetwork KSBI 52 Oklahoma City'),
    indexed('NBA TV'),
    indexed('US: ESPN', 's2'),
    indexed('NESN'),
    indexed('NBA League Pass 07: Knicks @ Celtics'),
    indexed('Celtics Nation'),
    indexed('ESPN+ 12 | Texas vs Georgia'),
    indexed('MLB 07: Yankees x Red Sox'),
    indexed('CBS 2 New York'),
    indexed('NFL Sunday Ticket 3'),
    indexed('FOX 5 Washington (WTTG)'),
    indexed('NBA: BOSTON CELTICS ᴴᴰ'),
    indexed('NBA: CELTICS'),
    indexed('CELTICS'),
    indexed('NBA: NEW YORK KNICKS (NYK) SD'),
    indexed('US: MLB NEW YORK YANKEES ᴿᴬᵂ'),
    indexed('NCAAF: TEXAS LONGHORNS'),
  ];
  const index = [...rows, rows[0]!];
  const programs = guide([
    [rows[0]!, [programme('NBA Basketball', '2026-10-23T23:00Z', '2026-10-24T01:30Z', 'The Boston Celtics host the New York Knicks.')]],
    [rows[1]!, [programme('NBA: BOS @ NYK', '2026-10-23T23:00Z', '2026-10-24T01:30Z')]],
    // One team only, and another league's game of the same names.
    [rows[2]!, [programme('Celtics Postgame', '2026-10-24T01:30Z', '2026-10-24T02:30Z', 'Boston reacts.')]],
    [rows[8]!, [programme('MLB Baseball', '2026-10-22T23:00Z', '2026-10-23T02:00Z', 'Yankees at Red Sox.')]],
    [rows[12]!, [programme('NFL Football', '2026-10-18T17:00Z', '2026-10-18T20:15Z', 'Pittsburgh Steelers at Tampa Bay Buccaneers.')]],
  ]);

  it('finds what a scan over every channel finds, in the same order', () => {
    // The day of the NBA game, so its undated event channel is current.
    const now = Date.parse('2026-10-23T18:00Z');
    for (const g of games) {
      expect(matchGame(g, index, programs, now), g.key).toEqual(matchGameScanForTests(g, index, programs, now));
    }
    expect(brief(matchGame(espnGame, index, programs, now))).toEqual([
      // ESPN lists NESN in Boston: the Celtics' feeds carry the game; the one whose name says HD goes first.
      ['NBA: BOSTON CELTICS ᴴᴰ', 'team', false],
      ['Sports 1', 'guide', false],
      ['Sports 2', 'guide', false],
      ['NBA League Pass 07: Knicks @ Celtics', 'event', false],
      ['NBA: CELTICS', 'team', false],
      ['US: ESPN', 'network', false],
      ['NESN', 'network', true],
      // Nothing is listed in New York: the Knicks' feed may be blacked out.
      ['NBA: NEW YORK KNICKS (NYK) SD', 'team', true],
    ]);
    expect(names(matchGame(MLB_GAME, index, programs, now))).toContain('US: MLB NEW YORK YANKEES ᴿᴬᵂ');
    expect(names(matchGame(CFB_GAME, index, programs, now))).toContain('NCAAF: TEXAS LONGHORNS');
    expect(names(matchGame(okc, index, programs, now))).toEqual(['NBA TV', 'MyNetwork KSBI 52 Oklahoma City']);
    expect(brief(matchGame(wttg, index, programs, now))).toEqual([
      ['NFL Sunday Ticket 3', 'guide', false],
      ['FOX 5 Washington (WTTG)', 'network', true],
    ]);
  });

  it('prepares a big index in slices, yielding to the page between them, with the same result', async () => {
    const big = Array.from({ length: PREPARE_SLICE * 2 + 1 }, (_, i) => indexed(i === PREPARE_SLICE + 3 ? 'Knicks at Celtics' : `Sports ${i}`));
    const bigPrograms = guide([[big[7]!, [programme('Knicks at Celtics', '2026-10-23T23:00Z', '2026-10-24T01:30Z')]]]);
    let ticked = false;
    setTimeout(() => (ticked = true), 0);
    const prepared = prepareMatch(big, bigPrograms);
    expect(ticked).toBe(false);
    await expect(prepared).resolves.toBe(true);
    expect(ticked).toBe(true);
    expect(names(matchGame(NBA_GAME, big, bigPrograms))).toEqual(['Sports 7', 'Knicks at Celtics']);
    expect(matchGame(NBA_GAME, big, bigPrograms)).toEqual(matchGameScanForTests(NBA_GAME, big, bigPrograms));
  });

  it('stops preparing when its signal aborts', async () => {
    const big = Array.from({ length: PREPARE_SLICE * 2 }, (_, i) => indexed(`Sports ${i}`));
    const ctrl = new AbortController();
    const prepared = prepareMatch(big, NONE, ctrl.signal);
    ctrl.abort();
    await expect(prepared).resolves.toBe(false);
  });
});
