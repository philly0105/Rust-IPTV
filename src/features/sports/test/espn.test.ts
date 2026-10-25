// ESPN scoreboard client: Eastern dates across DST, request URLs, game windows, and the normalizer
// against real scoreboard events (fixtures/*.json, trimmed copies of ESPN answers from October 2026).
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ET_ZONE,
  etDate,
  etDayStart,
  etDays,
  fetchScoreboard,
  gameWindow,
  normalizeScoreboard,
  scoreboardUrl,
  shiftEtDate,
  TYPICAL_LENGTH_MS,
} from '../lib/espn';
import type { Game, League } from '../lib/types';
import cfb from './fixtures/cfb.json';
import empty from './fixtures/empty.json';
import mlb from './fixtures/mlb.json';
import nba from './fixtures/nba.json';
import nfl from './fixtures/nfl.json';

const at = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;
const MIN = 60_000;

function games(league: League, json: unknown): Map<string, Game> {
  return new Map(normalizeScoreboard(league, json).map((g) => [g.id, g]));
}

function game(league: League, json: unknown, id: string): Game {
  const g = games(league, json).get(id);
  if (!g) throw new Error(`no game ${id}`);
  return g;
}

type Obj = Record<string, unknown>;

/** A fixture event, deep-copied so a test can edit it. */
function eventOf(json: { events: unknown[] }, id: string): Obj {
  const e = json.events.find((x) => (x as { id: string }).id === id);
  if (!e) throw new Error(`no event ${id}`);
  return structuredClone(e) as Obj;
}

const comp = (e: Obj) => (e.competitions as Obj[])[0]!;
const side = (e: Obj, i: number) => (comp(e).competitors as Obj[])[i]!;
const team = (e: Obj, i: number) => side(e, i).team as Obj;

const board = (...events: unknown[]) => ({ events });

describe('Eastern dates', () => {
  it('buckets by the US Eastern day, not UTC', () => {
    expect(ET_ZONE).toBe('America/New_York');
    // Thursday Night Football, 8:15 PM EDT, is the next day in UTC.
    expect(etDate(at('2026-10-23T00:15Z'))).toBe('2026-10-22');
    expect(etDate(at('2026-10-22T03:59:59Z'))).toBe('2026-10-21');
    expect(etDate(at('2026-10-22T04:00Z'))).toBe('2026-10-22');
    // Winter: midnight is 05:00Z.
    expect(etDate(at('2026-12-02T04:59Z'))).toBe('2026-12-01');
    expect(etDate(at('2026-12-02T05:00Z'))).toBe('2026-12-02');
  });

  it('handles the DST changes (2026-03-08 and 2026-11-01)', () => {
    expect(etDate(at('2026-11-01T05:30Z'))).toBe('2026-11-01'); // 1:30 AM EDT
    expect(etDate(at('2026-11-01T06:30Z'))).toBe('2026-11-01'); // 1:30 AM EST, the repeated hour
    expect(etDate(at('2026-11-02T04:59Z'))).toBe('2026-11-01'); // 11:59 PM EST
    expect(etDate(at('2026-11-02T05:00Z'))).toBe('2026-11-02');
    expect(etDate(at('2026-03-08T04:59Z'))).toBe('2026-03-07');
    expect(etDate(at('2026-03-08T05:00Z'))).toBe('2026-03-08');
    expect(etDate(at('2026-03-09T03:59Z'))).toBe('2026-03-08'); // 11:59 PM EDT
    expect(etDate(at('2026-03-09T04:00Z'))).toBe('2026-03-09');
  });

  it('finds Eastern midnight, including the 23 h and 25 h days', () => {
    expect(etDayStart('2026-10-22')).toBe(at('2026-10-22T04:00Z'));
    expect(etDayStart('2026-12-25')).toBe(at('2026-12-25T05:00Z'));
    expect(etDayStart('2026-11-01')).toBe(at('2026-11-01T04:00Z'));
    expect(etDayStart('2026-11-02')).toBe(at('2026-11-02T05:00Z'));
    expect(etDayStart('2026-03-08')).toBe(at('2026-03-08T05:00Z'));
    expect(etDayStart('2026-03-09')).toBe(at('2026-03-09T04:00Z'));
    expect(etDayStart('2026-11-02') - etDayStart('2026-11-01')).toBe(25 * HOUR);
    expect(etDayStart('2026-03-09') - etDayStart('2026-03-08')).toBe(23 * HOUR);
  });

  it('shifts dates across month, year and DST boundaries', () => {
    expect(shiftEtDate('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftEtDate('2026-11-01', 1)).toBe('2026-11-02');
    expect(shiftEtDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftEtDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftEtDate('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftEtDate('2026-10-22', 0)).toBe('2026-10-22');
  });

  it('lists a week back and a week ahead, oldest first', () => {
    const days = etDays(at('2026-10-22T16:00Z'));
    expect(days).toHaveLength(15);
    expect(days[0]).toBe('2026-10-15');
    expect(days[7]).toBe('2026-10-22');
    expect(days[14]).toBe('2026-10-29');
    expect(etDays(at('2026-10-22T16:00Z'), 1, 2)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
  });

  it("takes today from the Eastern clock: 11:30 PM ET is still that day after UTC's midnight", () => {
    expect(etDays(at('2026-10-23T03:30Z'), 0, 0)).toEqual(['2026-10-22']);
    expect(etDays(at('2026-10-23T04:30Z'), 0, 0)).toEqual(['2026-10-23']);
  });

  it('keeps one entry per day across both DST changes', () => {
    for (const now of [at('2026-10-29T15:00Z'), at('2026-03-05T15:00Z'), at('2026-11-01T05:30Z'), at('2026-03-08T06:30Z')]) {
      const days = etDays(now);
      expect(new Set(days).size).toBe(15);
      for (let i = 1; i < days.length; i++) expect(days[i]).toBe(shiftEtDate(days[i - 1]!, 1));
    }
    expect(etDays(at('2026-10-29T15:00Z'))).toContain('2026-11-01');
    expect(etDays(at('2026-03-05T15:00Z'))).toContain('2026-03-08');
  });

  describe('on a machine in another zone', () => {
    const saved = process.env.TZ;
    afterEach(() => {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    });

    it('gives the same Eastern dates', () => {
      for (const tz of ['Pacific/Auckland', 'Pacific/Honolulu', 'UTC']) {
        process.env.TZ = tz;
        expect(etDate(at('2026-10-23T00:15Z'))).toBe('2026-10-22');
        expect(etDayStart('2026-11-02')).toBe(at('2026-11-02T05:00Z'));
        expect(etDays(at('2026-10-22T16:00Z'), 1, 1)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
      }
    });
  });
});

describe('scoreboardUrl', () => {
  it('asks for one Eastern day per league', () => {
    expect(scoreboardUrl('nfl', '2026-10-22')).toBe('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20261022&limit=300');
    expect(scoreboardUrl('nba', '2026-10-22')).toBe('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261022&limit=300');
    expect(scoreboardUrl('mlb', '2026-04-29')).toBe('https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20260429&limit=300');
  });

  it('limits college football to FBS', () => {
    expect(scoreboardUrl('cfb', '2026-10-24')).toBe(
      'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=20261024&limit=300&groups=80',
    );
  });
});

describe('gameWindow', () => {
  const timed = (league: League, startMs: number) => ({ ...game('nfl', nfl, '401873010'), league, startMs });

  it('runs from 30 min before the start to an hour past the typical length', () => {
    const start = at('2026-10-23T00:15Z');
    expect(gameWindow(timed('nfl', start))).toEqual({ from: start - 30 * MIN, to: start + 3 * HOUR + 15 * MIN + HOUR });
    expect(gameWindow(timed('cfb', start)).to).toBe(start + 3.5 * HOUR + HOUR);
    expect(gameWindow(timed('nba', start)).to).toBe(start + 2.5 * HOUR + HOUR);
    expect(gameWindow(timed('mlb', start)).to).toBe(start + 3 * HOUR + HOUR);
    expect(TYPICAL_LENGTH_MS).toEqual({ nfl: 195 * MIN, cfb: 210 * MIN, nba: 150 * MIN, mlb: 180 * MIN });
  });

  it('widens a TBD kickoff to the whole Eastern day plus 4 h', () => {
    const tbd = game('cfb', cfb, '401858505');
    expect(tbd.timeValid).toBe(false);
    // Saturday 10/31 is still EDT; the next midnight (11/1) too, before the 2 AM change.
    expect(gameWindow(tbd)).toEqual({ from: at('2026-10-31T04:00Z'), to: at('2026-11-01T08:00Z') });
  });

  it('widens a flex-window kickoff the same way, despite its placeholder time', () => {
    const flex = game('cfb', cfb, '401856736');
    expect(flex.timeValid).toBe(true);
    expect(flex.timeNote).toMatch(/^FLEX/);
    expect(gameWindow(flex)).toEqual({ from: at('2026-10-31T04:00Z'), to: at('2026-11-01T08:00Z') });
  });

  it('uses the winter offset after DST ends', () => {
    const g = { ...game('cfb', cfb, '401858505'), etDate: '2026-11-07', startMs: at('2026-11-07T05:00Z') };
    expect(gameWindow(g)).toEqual({ from: at('2026-11-07T05:00Z'), to: at('2026-11-08T09:00Z') });
  });
});

describe('normalizeScoreboard: NFL', () => {
  const byId = games('nfl', nfl);

  it('sorts by start time and keys games by league and id', () => {
    const list = normalizeScoreboard('nfl', nfl);
    expect(list.map((g) => g.id)).toEqual(['401873272', '401872996', '401873002', '401873010', '401873009']);
    expect(list.every((g) => g.key === `nfl:${g.id}` && g.league === 'nfl')).toBe(true);
  });

  it('maps a scheduled game whose UTC date is the next day', () => {
    expect(byId.get('401873010')).toEqual({
      key: 'nfl:401873010',
      id: '401873010',
      league: 'nfl',
      etDate: '2026-10-22',
      startMs: at('2026-10-23T00:15Z'),
      timeValid: true,
      timeNote: null,
      state: 'pre',
      phase: 'scheduled',
      detail: 'Thu, October 22nd at 8:15 PM EDT',
      shortDetail: '10/22 - 8:15 PM EDT',
      period: 0,
      displayClock: '0:00',
      seasonType: 2,
      week: 7,
      home: {
        id: '3',
        abbreviation: 'CHI',
        displayName: 'Chicago Bears',
        shortDisplayName: 'Bears',
        name: 'Bears',
        location: 'Chicago',
        logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/chi.png',
        color: '0b1c3a',
        score: null,
        winner: null,
        record: '4-2',
        rank: null,
      },
      away: {
        id: '17',
        abbreviation: 'NE',
        displayName: 'New England Patriots',
        shortDisplayName: 'Patriots',
        name: 'Patriots',
        location: 'New England',
        logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/ne.png',
        color: '002a5c',
        score: null,
        winner: null,
        record: '4-2',
        rank: null,
      },
      neutralSite: false,
      venue: 'Soldier Field',
      note: null,
      seriesSummary: null,
      broadcasts: [{ name: 'Prime Video', market: 'national', kind: 'streaming' }],
      gamecastUrl: 'https://www.espn.com/nfl/game/_/gameId/401873010/patriots-bears',
    });
  });

  it('maps a final at a neutral site with its note', () => {
    const g = byId.get('401872996')!;
    expect(g).toMatchObject({ state: 'post', phase: 'final', shortDetail: 'Final', neutralSite: true, venue: 'Wembley Stadium', note: 'NFL London Games' });
    expect(g.etDate).toBe('2026-10-18');
    expect(g.home).toMatchObject({ abbreviation: 'JAX', score: 31, winner: false, record: '4-2', rank: null });
    expect(g.away).toMatchObject({ abbreviation: 'HOU', score: 34, winner: true, record: '2-4' });
    // The same network in geoBroadcasts and broadcasts[] is listed once.
    expect(g.broadcasts).toEqual([{ name: 'NFL Net', market: 'national', kind: 'tv' }]);
  });

  it('keeps Final/OT and the overtime period', () => {
    expect(byId.get('401873002')).toMatchObject({ phase: 'final', shortDetail: 'Final/OT', period: 5 });
  });

  it('lists every national network of a simulcast in order', () => {
    expect(byId.get('401873009')!.broadcasts).toEqual([
      { name: 'ESPN', market: 'national', kind: 'tv' },
      { name: 'ABC', market: 'national', kind: 'tv' },
      { name: 'Disney+', market: 'national', kind: 'streaming' },
    ]);
  });

  it('marks preseason games and home-market local TV', () => {
    const g = byId.get('401873272')!;
    expect(g.seasonType).toBe(1);
    expect(g.broadcasts).toEqual([
      { name: 'Bengals Preseason TV Network', market: 'home', kind: 'tv' },
      { name: 'Lions TV Network', market: 'home', kind: 'tv' },
    ]);
  });
});

describe('normalizeScoreboard: college football', () => {
  const byId = games('cfb', cfb);

  it('sorts by start, not by rank as ESPN does', () => {
    const starts = normalizeScoreboard('cfb', cfb).map((g) => g.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('keeps poll ranks 1-25 and drops 99 (unranked)', () => {
    const g = byId.get('401856719')!;
    expect(g.home).toMatchObject({ abbreviation: 'UGA', rank: 1, score: 24, winner: false });
    expect(g.away).toMatchObject({ abbreviation: 'AUB', rank: null, score: 27, winner: true });
    expect(byId.get('401858505')!.away.rank).toBe(24);
  });

  it('keeps Final/2OT', () => {
    expect(byId.get('401858263')).toMatchObject({ phase: 'final', shortDetail: 'Final/2OT', period: 6, week: 7 });
  });

  it('drops the Radio geoBroadcast', () => {
    expect(byId.get('401858495')!.broadcasts).toEqual([{ name: 'BTN', market: 'national', kind: 'tv' }]);
    expect(byId.get('401769072')!.broadcasts).toEqual([{ name: 'ESPN', market: 'national', kind: 'tv' }]);
  });

  it('marks a streaming-only game', () => {
    expect(byId.get('401866446')!.broadcasts).toEqual([{ name: 'ESPN+', market: 'national', kind: 'streaming' }]);
  });

  it('flags a TBD kickoff dated midnight Eastern', () => {
    const g = byId.get('401858505')!;
    expect(g).toMatchObject({ timeValid: false, shortDetail: 'TBD', etDate: '2026-10-31', state: 'pre', phase: 'scheduled', broadcasts: [] });
    expect(g.startMs).toBe(at('2026-10-31T04:00Z'));
    expect(g.home.score).toBeNull();
  });

  it('reads a FLEX window note as the time note, not the game note', () => {
    const g = byId.get('401856736')!;
    expect(g.timeNote).toBe('FLEX: 3:30 - 4:30pm OR 6 - 8pm ET start');
    expect(g.note).toBeNull();
    expect(g.broadcasts).toEqual([{ name: 'SEC Network', market: 'national', kind: 'tv' }]);
  });

  it('marks a playoff game as postseason with its bowl note', () => {
    const g = byId.get('401769072')!;
    expect(g).toMatchObject({ seasonType: 3, week: 1, neutralSite: true, note: 'College Football Playoff Quarterfinal at the Rose Bowl Presented by Prudential' });
    expect(g.home).toMatchObject({ abbreviation: 'IU', rank: 1, record: '14-0' });
    expect(g.away).toMatchObject({ abbreviation: 'ALA', rank: 9 });
  });
});

describe('normalizeScoreboard: NBA', () => {
  const byId = games('nba', nba);

  it('adds NBA League Pass, which only broadcasts[] lists', () => {
    expect(byId.get('401909835')!.broadcasts).toEqual([
      { name: 'MNMT', market: 'home', kind: 'tv' },
      { name: 'MyMi', market: 'away', kind: 'tv' },
      { name: 'Bucks App', market: 'away', kind: 'streaming' },
      { name: 'NBA League Pass', market: 'away', kind: 'unknown' },
    ]);
    expect(byId.get('401909851')!.broadcasts).toEqual([
      { name: 'Spectrum Sports Net', market: 'home', kind: 'tv' },
      { name: 'Spectrum Sports Net +', market: 'home', kind: 'streaming' },
      { name: 'ClipperVision', market: 'away', kind: 'streaming' },
      { name: 'NBA League Pass', market: 'away', kind: 'unknown' },
    ]);
  });

  it('has no ranks or weeks', () => {
    for (const g of byId.values()) {
      expect(g.home.rank).toBeNull();
      expect(g.away.rank).toBeNull();
      expect(g.week).toBeNull();
    }
  });

  it('keeps the raw clock of a final', () => {
    expect(byId.get('401909091')).toMatchObject({ phase: 'final', displayClock: '12:00' });
  });

  it('marks preseason and play-in games', () => {
    expect(byId.get('401908622')!.seasonType).toBe(1);
    expect(byId.get('401866757')).toMatchObject({ seasonType: 5, note: 'NBA Play-In - East - 7th Place vs 8th Place', phase: 'final' });
  });

  it("files a 10 PM Eastern game under that day although it is the next day in UTC", () => {
    expect(byId.get('401909851')).toMatchObject({ etDate: '2026-10-23', startMs: at('2026-10-24T02:00Z') });
  });
});

describe('normalizeScoreboard: MLB', () => {
  const byId = games('mlb', mlb);

  it('carries the postseason series summary and game note', () => {
    const g = byId.get('401908025')!;
    expect(g).toMatchObject({ seasonType: 3, seriesSummary: 'CLE leads series 2-1', note: 'ALCS - Game 3', phase: 'final' });
    // The season record, not the series record ESPN also sends.
    expect(g.home.record).toBe('85-77');
    expect(g.broadcasts).toEqual([
      { name: 'TBS', market: 'national', kind: 'tv' },
      { name: 'truTV', market: 'national', kind: 'tv' },
    ]);
  });

  it("keeps an 'If Necessary' game", () => {
    expect(byId.get('401908046')).toMatchObject({ note: 'World Series - Game 5 If Necessary', seriesSummary: 'Series starts 10/23', phase: 'scheduled' });
  });

  it('keeps period 1 on a scheduled game', () => {
    expect(byId.get('401908042')).toMatchObject({ state: 'pre', period: 1 });
  });

  it('marks postponed games (state post, completed false) without a 0-0 score', () => {
    const g = byId.get('401815137')!;
    expect(g).toMatchObject({ state: 'post', phase: 'postponed', shortDetail: 'Postponed', note: 'Inclement Weather - Makeup date April 30' });
    expect(g.home.score).toBeNull();
    expect(g.away.score).toBeNull();
    expect(byId.get('401815136')).toMatchObject({ phase: 'postponed', note: 'Rain - Makeup date April 30' });
  });

  it('keeps extra innings', () => {
    expect(byId.get('401815141')).toMatchObject({ phase: 'final', shortDetail: 'Final/10', period: 10 });
  });

  it('lists regional networks by market', () => {
    expect(byId.get('401815137')!.broadcasts).toEqual([
      { name: 'MLB.TV', market: 'national', kind: 'streaming' },
      { name: 'MLB Net', market: 'national', kind: 'tv' },
      { name: 'NBC Sports BA', market: 'away', kind: 'tv' },
      { name: 'NBC Sports Phil +', market: 'home', kind: 'tv' },
      { name: 'NBC Sports Phil', market: 'home', kind: 'tv' },
    ]);
  });
});

describe('normalizeScoreboard: live and unusual statuses', () => {
  function withStatus(name: string, state: string, completed: boolean) {
    const e = eventOf(nba, '401909093');
    comp(e).status = {
      clock: 312,
      displayClock: '5:12',
      period: 3,
      type: { id: '2', name, state, completed, description: 'In Progress', detail: '5:12 - 3rd Quarter', shortDetail: '5:12 - 3rd' },
    };
    side(e, 0).score = '71';
    side(e, 1).score = '68';
    return normalizeScoreboard('nba', board(e))[0]!;
  }

  it('maps a game in progress with its clock and scores', () => {
    const g = withStatus('STATUS_IN_PROGRESS', 'in', false);
    expect(g).toMatchObject({ state: 'in', phase: 'live', period: 3, displayClock: '5:12', shortDetail: '5:12 - 3rd' });
    expect(g.home.score).toBe(71);
    expect(g.away.score).toBe(68);
  });

  it('treats any in-progress status name as live (halftime, delays)', () => {
    expect(withStatus('STATUS_HALFTIME', 'in', false).phase).toBe('live');
    expect(withStatus('STATUS_RAIN_DELAY', 'in', false).phase).toBe('live');
  });

  it('reads canceled and suspended from the status name', () => {
    const canceled = withStatus('STATUS_CANCELED', 'post', false);
    expect(canceled.phase).toBe('canceled');
    expect(canceled.home.score).toBeNull();
    const suspended = withStatus('STATUS_SUSPENDED', 'in', false);
    expect(suspended.phase).toBe('suspended');
    expect(suspended.home.score).toBe(71);
  });

  it('does not call an unknown post status that is not completed a final', () => {
    expect(withStatus('STATUS_SOMETHING_NEW', 'post', false).phase).toBe('postponed');
    expect(withStatus('STATUS_FORFEIT', 'post', true).phase).toBe('final');
  });
});

describe('normalizeScoreboard: missing and odd fields', () => {
  it('returns no games for an empty day or anything that is not a scoreboard', () => {
    expect(normalizeScoreboard('mlb', empty)).toEqual([]);
    for (const junk of [null, undefined, 42, 'x', [], {}, { events: 'x' }, { events: [null, 1, 'x'] }, { code: 400, message: 'Failed to get events endpoint.' }]) {
      expect(normalizeScoreboard('nfl', junk)).toEqual([]);
    }
  });

  it('skips events without both teams, an id or a start date', () => {
    const ok = eventOf(nfl, '401873010');
    const noAway = eventOf(nfl, '401873009');
    comp(noAway).competitors = [side(noAway, 0)];
    const noTeams = eventOf(nfl, '401873002');
    delete comp(noTeams).competitors;
    const noCompetition = eventOf(nfl, '401872996');
    noCompetition.competitions = [];
    const noTeamObject = eventOf(nfl, '401873272');
    delete side(noTeamObject, 0).team;
    const noId = eventOf(nfl, '401873009');
    delete noId.id;
    delete comp(noId).id;
    const badDate = eventOf(nfl, '401873009');
    badDate.date = 'soon';
    comp(badDate).date = 'soon';
    const list = normalizeScoreboard('nfl', board(noAway, ok, noTeams, noCompetition, noTeamObject, noId, badDate));
    expect(list.map((g) => g.id)).toEqual(['401873010']);
  });

  it('fills defaults for a bare event', () => {
    const bare = {
      id: '1',
      competitions: [
        {
          date: '2026-10-22T23:00Z',
          competitors: [
            { homeAway: 'home', team: { id: '10' } },
            { homeAway: 'away', team: { id: '20', location: 'Boston', name: 'Celtics' } },
          ],
        },
      ],
    };
    const [g] = normalizeScoreboard('nba', board(bare));
    expect(g).toMatchObject({
      key: 'nba:1',
      etDate: '2026-10-22',
      timeValid: true,
      timeNote: null,
      state: 'pre',
      phase: 'scheduled',
      detail: '',
      shortDetail: '',
      period: 0,
      displayClock: '',
      seasonType: 2,
      week: null,
      neutralSite: false,
      venue: null,
      note: null,
      seriesSummary: null,
      broadcasts: [],
      gamecastUrl: null,
    });
    expect(g!.home).toEqual({
      id: '10',
      abbreviation: '',
      displayName: '',
      shortDisplayName: '',
      name: '',
      location: '',
      logo: null,
      color: null,
      score: null,
      winner: null,
      record: null,
      rank: null,
    });
    expect(g!.away).toMatchObject({ displayName: 'Boston Celtics', shortDisplayName: 'Celtics' });
  });

  it('falls back to the event-level date and status', () => {
    const e = eventOf(nba, '401909835');
    const c = comp(e);
    e.status = c.status;
    delete c.status;
    delete c.date;
    const [g] = normalizeScoreboard('nba', board(e));
    expect(g).toMatchObject({ phase: 'final', startMs: at('2026-10-21T23:00Z') });
    expect(g!.home.score).toBe(128);
  });

  it("takes the game's live link for Gamecast while it is on, when ESPN lists no summary link", () => {
    const e = eventOf(nba, '401909093');
    const live = { rel: ['live', 'desktop', 'event'], href: 'https://www.espn.com/nba/game?gameId=401909093' };
    const boxscore = { rel: ['boxscore', 'desktop', 'event'], href: 'https://www.espn.com/nba/boxscore/_/gameId/401909093' };
    e.links = [live, boxscore];
    expect(normalizeScoreboard('nba', board(e))[0]!.gamecastUrl).toBe('https://www.espn.com/nba/game?gameId=401909093');
    // A summary link wins when both are there.
    e.links = [live, boxscore, { rel: ['summary', 'desktop', 'event'], href: 'https://www.espn.com/nba/game/_/gameId/401909093' }];
    expect(normalizeScoreboard('nba', board(e))[0]!.gamecastUrl).toBe('https://www.espn.com/nba/game/_/gameId/401909093');
  });

  it('rejects links and logos that are not http(s), and colours that are not hex', () => {
    const e = eventOf(nba, '401909093');
    e.links = [{ rel: ['summary'], href: 'javascript:alert(1)' }];
    team(e, 0).logo = 'data:image/png;base64,AAAA';
    team(e, 0).color = 'red;background:url(x)';
    const [g] = normalizeScoreboard('nba', board(e));
    expect(g!.gamecastUrl).toBeNull();
    expect(g!.home.logo).toBeNull();
    expect(g!.home.color).toBeNull();
    expect(g!.away.color).toBe('860038');
  });

  it('reads numeric scores and season objects, and ignores unparsable scores', () => {
    const e = eventOf(mlb, '401815143');
    side(e, 0).score = 7;
    side(e, 1).score = 'n/a';
    e.season = { year: 2026, type: { type: 3 } };
    const [g] = normalizeScoreboard('mlb', board(e));
    expect(g!.home.score).toBe(7);
    expect(g!.away.score).toBeNull();
    expect(g!.seasonType).toBe(3);
  });

  it('ranks only college teams', () => {
    const e = eventOf(cfb, '401856719');
    expect(normalizeScoreboard('nfl', board(e))[0]!.home.rank).toBeNull();
    expect(normalizeScoreboard('cfb', board(e))[0]!.home.rank).toBe(1);
  });

  it('ignores broadcasts without a name and treats an unknown market as national', () => {
    const e = eventOf(nfl, '401873010');
    comp(e).geoBroadcasts = [{ type: { shortName: 'TV' }, market: { type: 'Somewhere' }, media: { shortName: 'NFL Net' } }, { type: { shortName: 'TV' } }];
    comp(e).broadcasts = [{ market: 'national', names: ['', 'NFL Net', 3] }, { names: null }];
    expect(normalizeScoreboard('nfl', board(e))[0]!.broadcasts).toEqual([{ name: 'NFL Net', market: 'national', kind: 'tv' }]);
  });
});

describe('fetchScoreboard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends one plain GET and normalizes the answer', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => structuredClone(nba) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const ctl = new AbortController();
    const list = await fetchScoreboard('nba', '2026-10-22', ctl.signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261022&limit=300', {
      signal: ctl.signal,
    });
    expect(list.map((g) => g.id)).toEqual(normalizeScoreboard('nba', nba).map((g) => g.id));
  });

  it('rejects an error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ code: 400, message: 'Failed to get events endpoint.' }) }) as unknown as Response),
    );
    await expect(fetchScoreboard('nfl', '2026-10-22')).rejects.toThrow(/HTTP 400/);
  });

  it('passes network errors through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(fetchScoreboard('mlb', '2026-10-22')).rejects.toThrow('Failed to fetch');
  });

  it('returns an empty day as no games', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => empty }) as unknown as Response));
    await expect(fetchScoreboard('mlb', '2026-10-22')).resolves.toEqual([]);
  });
});
