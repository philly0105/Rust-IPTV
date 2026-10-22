// matchGame: event channel names in several provider styles, the time and date agreement rule, network
// matches with their avoid lists and package services, regional flags (NFL Sunday CBS/FOX, RSNs, local
// stations), guide matches by title and by description, and the order and dedup of the result.
import { describe, expect, it } from 'vitest';

import { itemKey, type Channel, type EpgProgram, type ItemKey } from '@/api/types';

import { toIndexed, type IndexedChannel } from '../hooks/useChannelIndex';
import { isEventChannel, matchGame, nameTimeAgrees, type StreamMatch } from '../lib/match';
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
      ['ABC 7 New York', 'network', false],
      ['US: ESPN HD', 'network', false],
    ]);
  });

  it('takes FOX, not FS1, Fox News or Fox Business', () => {
    const ws = game('mlb', team('TB', 'Tampa Bay', 'Rays'), team('MIL', 'Milwaukee', 'Brewers'), '2026-10-24T00:00Z', { broadcasts: national('Fox') });
    const index = ['FS1', 'Fox Sports 1', 'Fox News', 'FOX Business', 'FOX 5 New York', 'US| FOX HD'].map((n) => indexed(n));
    expect(names(matchGame(ws, index, NONE))).toEqual(['FOX 5 New York', 'US| FOX HD']);
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
    expect(names(matchGame(pitt, [...espn, latam], NONE))).toEqual(['ESPN HD', 'US: ESPN FHD']);
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
    const ny = indexed('CBS 2 New York');
    const miami = indexed('CBS 4 Miami');
    const programs = guide([[miami, [programme('NFL Football', '2026-10-18T17:00Z', '2026-10-18T20:15Z', 'The Steelers visit the Buccaneers.')]]]);
    expect(brief(matchGame(NFL_SUNDAY, [ny, miami], programs))).toEqual([
      ['CBS 4 Miami', 'guide', false],
      ['CBS 2 New York', 'network', true],
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
      ['NBC Sports Bay Area', 'network', true],
      ['NBC Sports Philadelphia HD', 'network', true],
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

  it('lists a channel once, with its strongest route', () => {
    const espn = indexed('ESPN: Knicks vs Celtics');
    const g = game('nba', KNICKS, CELTICS, '2026-10-23T23:00Z', { broadcasts: national('ESPN') });
    // Network and event at once: the event wins. The same row twice in the index: listed once.
    expect(brief(matchGame(g, [espn, espn], NONE))).toEqual([['ESPN: Knicks vs Celtics', 'event', false]]);
  });
});
