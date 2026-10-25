// Sports name matching: the tokenizer, team keys for pros and college (schools that share words, St/State,
// accents and apostrophes, mascots), league marks, the network alias table and its avoid lists, ESPN's
// broadcast names, and which live groups the index reads (with a real provider's groups).
import { describe, expect, it } from 'vitest';

import {
  NETWORKS,
  foreignFeed,
  hasMatchup,
  isSportsGroup,
  mentionsBoth,
  mentionsTeam,
  nameTokens,
  networkIdForBroadcast,
  networkIdForChannel,
  otherLeague,
  teamAt,
  teamKeys,
  textTokens,
} from '../lib/names';
import type { Game, GameTeam, League } from '../lib/types';

/** An ESPN team; names as ESPN writes them (see /tmp/sports-map raw scoreboards). */
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

function game(league: League, away: GameTeam, home: GameTeam): Game {
  return {
    key: `${league}:1`,
    id: '1',
    league,
    etDate: '2026-10-24',
    startMs: Date.parse('2026-10-24T19:30Z'),
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
  };
}

const CELTICS = team('BOS', 'Boston', 'Celtics');
const KNICKS = team('NY', 'New York', 'Knicks');
const TEXAS = team('TEX', 'Texas', 'Longhorns', 'Texas');
const TAMU = team('TA&M', 'Texas A&M', 'Aggies', 'Texas A&M');
const TTU = team('TTU', 'Texas Tech', 'Red Raiders', 'Texas Tech');
const TXST = team('TXST', 'Texas State', 'Bobcats', 'Texas St');
const UNT = team('UNT', 'North Texas', 'Mean Green', 'North Texas');
const MIAMI = team('MIA', 'Miami', 'Hurricanes', 'Miami');
const MIAMI_OH = team('M-OH', 'Miami (OH)', 'RedHawks', 'Miami OH');
const FSU = team('FSU', 'Florida State', 'Seminoles', 'Florida St');
const FLORIDA = team('FLA', 'Florida', 'Gators', 'Florida');
const HAWAII = team('HAW', "Hawai'i", 'Rainbow Warriors', "Hawai'i");
const SJSU = team('SJSU', 'San José State', 'Spartans', 'San José St');
const AUBURN = team('AUB', 'Auburn', 'Tigers', 'Auburn');
const GEORGIA = team('UGA', 'Georgia', 'Bulldogs', 'Georgia');
const LSU = team('LSU', 'LSU', 'Tigers', 'LSU');
const MSST = team('MSST', 'Mississippi State', 'Bulldogs', 'Mississippi St');

const names = (t: GameTeam, league: League, name: string) => mentionsTeam(nameTokens(name), teamKeys(t, league));

describe('nameTokens', () => {
  it('cuts the country tag, folds and drops quality, codec and backup markers', () => {
    expect(nameTokens('US| ESPN ᴴᴰ')).toEqual(['espn']);
    expect(nameTokens('UK: Sky Sports Main Event FHD')).toEqual(['sky', 'sports', 'main', 'event']);
    expect(nameTokens('ESPN 4K HEVC 60fps (Backup 2)')).toEqual(['espn']);
    expect(nameTokens('ESPN 1080p [BK1]')).toEqual(['espn']);
    expect(nameTokens('ＥＳＰＮ ＨＤ')).toEqual(['espn']);
  });

  it('reads + as plus, @ as at, apostrophes and A&M as one word, accents folded', () => {
    expect(nameTokens('ESPN+')).toEqual(['espn', 'plus']);
    expect(nameTokens('ESPN Plus')).toEqual(['espn', 'plus']);
    expect(nameTokens('BOS@NYK')).toEqual(['bos', 'at', 'nyk']);
    expect(nameTokens('Texas A&M')).toEqual(['texas', 'am']);
    expect(nameTokens('Texas A & M')).toEqual(['texas', 'am']);
    expect(nameTokens("Hawai'i")).toEqual(['hawaii']);
    expect(nameTokens('Hawaiʻi')).toEqual(['hawaii']);
    expect(nameTokens('San José State')).toEqual(['san', 'jose', 'state']);
  });

  it('reads a spaced dash as a separator of its own, an unspaced one as a split', () => {
    expect(textTokens('Boise State - San José State')).toEqual(['boise', 'state', '-', 'san', 'jose', 'state']);
    expect(nameTokens('US: ESPN – East')).toEqual(['espn', '-', 'east']);
    expect(textTokens('Miami-OH vs K-State')).toEqual(['miami', 'oh', 'vs', 'k', 'state']);
    // A spaced dash still ends a team's name.
    expect(hasMatchup(textTokens('Boise State - San José State'))).toBe(true);
  });

  it('keeps SD inside a name (San Diego) and drops it only as a trailing quality tag', () => {
    expect(nameTokens('MLB 07: SD @ LAD')).toEqual(['mlb', '07', 'sd', 'at', 'lad']);
    expect(nameTokens('FOX SD')).toEqual(['fox']);
  });

  it('keeps tags inside the name when stripping would cut a real word', () => {
    expect(textTokens('NBA League Pass 05: Boston Celtics vs New York Knicks')).toEqual([
      'nba', 'league', 'pass', '05', 'boston', 'celtics', 'vs', 'new', 'york', 'knicks',
    ]);
  });

  it('reads the whole name when what comes before a pipe is longer than a tag', () => {
    expect(nameTokens('NBA 04: Hornets x Nets | 7:30PM ET')).toEqual(['nba', '04', 'hornets', 'x', 'nets', '7', '30pm', 'et']);
    expect(nameTokens('Cavaliers vs 76ers || 7:00 PM ET')).toEqual(['cavaliers', 'vs', '76ers', '7', '00', 'pm', 'et']);
    expect(nameTokens('ESPN+ 12 | Texas vs Georgia')).toEqual(['espn', 'plus', '12', 'texas', 'vs', 'georgia']);
    // Short tags still go.
    expect(nameTokens('USA SPORTS | ESPN HD')).toEqual(['espn']);
    expect(nameTokens('|DE| ARD')).toEqual(['ard']);
    expect(nameTokens('ESPN+ | Texas vs Georgia')).toEqual(['texas', 'vs', 'georgia']);
  });
});

describe('foreignFeed', () => {
  it('reads a country tag from the name, else from the group', () => {
    for (const n of ['BR: ESPN', 'NL| ESPN 1', 'AU| FOX FOOTY', 'LATAM| ESPN Norte', 'MX: ESPN 2 HD', '|DE| Sky Sport', 'UK ESPN', '[UK] TNT Sports 1']) {
      expect(foreignFeed(n), n).toBe(true);
    }
    for (const n of ['US: ESPN HD', 'ESPN HD', 'USA | ESPN FHD', 'CA| Sportsnet One', 'ESPN+ 12 | Texas vs Georgia', 'My 9 New York', 'AT&T SportsNet Pittsburgh']) {
      expect(foreignFeed(n), n).toBe(false);
    }
    expect(foreignFeed('ESPN', 'LATAM| DEPORTES')).toBe(true);
    expect(foreignFeed('ESPN', 'BRASIL ESPORTES')).toBe(true);
    expect(foreignFeed('US| ESPN', 'BR| SPORTS')).toBe(false);
    expect(foreignFeed('ESPN', 'USA SPORTS')).toBe(false);
    expect(foreignFeed('ESPN', 'In Demand PPV')).toBe(false);
  });

  it('reads a LATINO group as home: it holds the US Spanish-language networks', () => {
    expect(foreignFeed('ESPN Deportes', 'LATINO')).toBe(false);
    expect(foreignFeed('FOX Deportes', 'LATINO | SPORTS')).toBe(false);
    expect(foreignFeed('LATINO| ESPN Deportes')).toBe(false);
    for (const n of ['TUDN', 'Univision', 'Telemundo', 'UniMás']) expect(foreignFeed(n, 'LATIN'), n).toBe(false);
    // LATAM and the countries' tags still mark Latin American feeds.
    expect(foreignFeed('ESPN Deportes', 'LATAM| DEPORTES')).toBe(true);
    expect(foreignFeed('MX: ESPN Deportes')).toBe(true);
  });
});

describe('team keys: pros', () => {
  it('takes the nickname, location and nickname, and the abbreviation as a whole token', () => {
    expect(names(CELTICS, 'nba', 'Celtics vs Knicks')).toBe(true);
    expect(names(CELTICS, 'nba', 'Boston Celtics')).toBe(true);
    expect(names(CELTICS, 'nba', 'NBA 05 : BOS @ NYK')).toBe(true);
    // The city alone is several teams, and an abbreviation is never a prefix.
    expect(names(CELTICS, 'nba', 'Boston 25 News')).toBe(false);
    expect(names(CELTICS, 'nba', 'BOSS TV')).toBe(false);
  });

  it('knows provider spellings of ESPN abbreviations', () => {
    expect(names(KNICKS, 'nba', 'BOS @ NY')).toBe(true);
    expect(names(KNICKS, 'nba', 'BOS @ NYK')).toBe(true);
    const cases: [GameTeam, string][] = [
      [team('GS', 'Golden State', 'Warriors'), 'GSW'],
      [team('SA', 'San Antonio', 'Spurs'), 'SAS'],
      [team('NO', 'New Orleans', 'Pelicans'), 'NOP'],
      [team('UTAH', 'Utah', 'Jazz'), 'UTA'],
      [team('WSH', 'Washington', 'Wizards'), 'WAS'],
    ];
    for (const [t, alias] of cases) {
      expect(names(t, 'nba', `NBA 03: ${alias} @ LAL`)).toBe(true);
      expect(names(t, 'nba', `NBA 03: ${t.abbreviation} @ LAL`)).toBe(true);
    }
    // League-specific: the NFL's Saints are NO too, the NBA alias is not theirs.
    expect(names(team('NO', 'New Orleans', 'Saints'), 'nfl', 'NOP @ ATL')).toBe(false);
  });

  it('takes nickname aliases (Blazers, Sixers)', () => {
    expect(names(team('POR', 'Portland', 'Trail Blazers'), 'nba', 'Blazers at Lakers')).toBe(true);
    expect(names(team('PHI', 'Philadelphia', '76ers'), 'nba', 'Sixers at Lakers')).toBe(true);
    expect(names(team('PHI', 'Philadelphia', '76ers'), 'nba', '76ers at Lakers')).toBe(true);
  });

  it('takes LA for the Rams and Dodgers only where it is not another club’s city', () => {
    const rams = team('LAR', 'Los Angeles', 'Rams');
    expect(names(rams, 'nfl', 'NFL 03: LA @ KC')).toBe(true);
    expect(names(rams, 'nfl', 'KC vs LA')).toBe(true);
    expect(names(rams, 'nfl', 'NFL 03: LA - KC')).toBe(true);
    expect(names(rams, 'nfl', 'LA Rams at Chiefs')).toBe(true);
    expect(names(rams, 'nfl', 'NFL 03: LA Chargers @ KC Chiefs')).toBe(false);
    const dodgers = team('LAD', 'Los Angeles', 'Dodgers');
    expect(names(dodgers, 'mlb', 'SD @ LA')).toBe(true);
    expect(names(dodgers, 'mlb', 'MLB 05: SD Padres @ LA Angels')).toBe(false);
  });

  it("takes the A's, but not the word 'as'", () => {
    const as = team('ATH', 'Athletics', 'Athletics', 'Athletics', 'Athletics');
    expect(names(as, 'mlb', "MLB 10: Royals @ A's")).toBe(true);
    expect(names(as, 'mlb', "A's vs Royals 7:05 PM")).toBe(true);
    expect(names(as, 'mlb', 'Same as yesterday')).toBe(false);
    expect(mentionsTeam(textTokens("Royals host the A's"), teamKeys(as, 'mlb'), { abbrs: false })).toBe(false);
  });

  it('keeps a nickname college mascots share from taking the school’s team', () => {
    const panthers = team('CAR', 'Carolina', 'Panthers');
    const eagles = team('PHI', 'Philadelphia', 'Eagles');
    const nfl = game('nfl', panthers, eagles);
    expect(mentionsBoth(nameTokens('ESPN+ 12 | Pittsburgh Panthers vs Boston College Eagles'), nfl)).toBe(false);
    expect(mentionsBoth(nameTokens('Pitt Panthers vs Georgia Southern Eagles'), nfl)).toBe(false);
    expect(mentionsBoth(nameTokens('NFL 05: Panthers @ Eagles'), nfl)).toBe(true);
    expect(mentionsBoth(nameTokens('Carolina Panthers at Philadelphia Eagles'), nfl)).toBe(true);
    expect(mentionsBoth(nameTokens('Philly Eagles vs Panthers'), nfl)).toBe(true);
    const broncos = game('nfl', team('DEN', 'Denver', 'Broncos'), team('ATL', 'Atlanta', 'Falcons'));
    expect(mentionsBoth(nameTokens('Boise State Broncos vs Air Force Falcons'), broncos)).toBe(false);
    expect(mentionsBoth(nameTokens('Broncos @ Falcons'), broncos)).toBe(true);
    const lions = game('nfl', team('DET', 'Detroit', 'Lions'), team('CHI', 'Chicago', 'Bears'));
    expect(mentionsBoth(nameTokens('Penn State Nittany Lions vs Baylor Bears'), lions)).toBe(false);
    const warriors = team('GS', 'Golden State', 'Warriors');
    expect(names(warriors, 'nba', 'Golden State Warriors at Lakers')).toBe(true);
    expect(names(warriors, 'nba', 'Golden St Warriors at Lakers')).toBe(true);
    expect(names(warriors, 'nba', "Hawai'i Rainbow Warriors vs UNLV")).toBe(false);
  });

  it('finds where a team is first named', () => {
    const tokens = nameTokens('NBA 03: Knicks @ Celtics');
    expect(teamAt(tokens, teamKeys(KNICKS, 'nba'))).toBe(2);
    expect(teamAt(tokens, teamKeys(CELTICS, 'nba'))).toBe(4);
    expect(teamAt(nameTokens('BOS @ Boston Celtics'), teamKeys(CELTICS, 'nba'))).toBe(0);
    expect(teamAt(tokens, teamKeys(team('MIA', 'Miami', 'Heat'), 'nba'))).toBe(-1);
  });
});

describe('team keys: college', () => {
  it('keeps Texas apart from Texas A&M, Texas Tech, Texas State and North Texas', () => {
    expect(names(TEXAS, 'cfb', 'Texas vs Georgia')).toBe(true);
    expect(names(TEXAS, 'cfb', 'Texas Longhorns at Georgia Bulldogs')).toBe(true);
    for (const other of ['Texas A&M vs LSU', 'Texas A & M vs LSU', 'Texas Tech vs Baylor', 'Texas State vs UTSA', 'Texas St. vs UTSA', 'North Texas vs Army']) {
      expect(names(TEXAS, 'cfb', other)).toBe(false);
    }
    // Both in one name: each finds its own.
    expect(names(TEXAS, 'cfb', 'Texas A&M vs Texas')).toBe(true);
    expect(names(TAMU, 'cfb', 'Texas A&M vs Texas')).toBe(true);
    expect(names(TAMU, 'cfb', 'Texas A & M Aggies vs LSU')).toBe(true);
    expect(names(TTU, 'cfb', 'Texas Tech vs Baylor')).toBe(true);
    expect(names(TXST, 'cfb', 'Texas St. vs UTSA')).toBe(true);
    expect(names(TXST, 'cfb', 'Texas State vs UTSA')).toBe(true);
    expect(names(UNT, 'cfb', 'North Texas vs Army')).toBe(true);
  });

  it('keeps Miami apart from Miami (OH)', () => {
    expect(names(MIAMI, 'cfb', 'Miami vs Florida State')).toBe(true);
    expect(names(MIAMI, 'cfb', 'Miami (FL) Hurricanes vs Pitt')).toBe(true);
    for (const other of ['Miami (OH) vs Ohio', 'Miami OH RedHawks vs Ohio', 'Miami Ohio vs Ohio', 'Miami-OH vs Ohio']) {
      expect(names(MIAMI, 'cfb', other)).toBe(false);
      expect(names(MIAMI_OH, 'cfb', other)).toBe(true);
    }
  });

  it('reads St. as State and the other way round', () => {
    expect(names(FSU, 'cfb', 'Florida St. at Miami')).toBe(true);
    expect(names(FSU, 'cfb', 'Florida State Seminoles at Miami')).toBe(true);
    expect(names(FLORIDA, 'cfb', 'Florida State at Miami')).toBe(false);
    expect(names(FLORIDA, 'cfb', 'Florida Atlantic at Rice')).toBe(false);
    expect(names(FLORIDA, 'cfb', 'South Florida at Rice')).toBe(false);
    expect(names(FLORIDA, 'cfb', 'Florida at Georgia')).toBe(true);
  });

  it("matches Hawai'i and San José however they are spelled", () => {
    for (const n of ["Hawai'i vs UNLV", 'Hawaii vs UNLV', 'Hawaiʻi Rainbow Warriors vs UNLV', 'HAWAII VS UNLV']) {
      expect(names(HAWAII, 'cfb', n)).toBe(true);
    }
    for (const n of ['San Jose State vs Fresno State', 'San José St vs Fresno St', 'SAN JOSE ST. Spartans']) {
      expect(names(SJSU, 'cfb', n)).toBe(true);
    }
  });

  it('counts a mascot only on its own, never the mascot of another school', () => {
    const g = game('cfb', MSST, LSU);
    expect(mentionsBoth(nameTokens('Auburn Tigers vs Georgia Bulldogs'), g)).toBe(false);
    expect(mentionsBoth(nameTokens('Auburn Tigers vs Georgia Bulldogs'), game('cfb', AUBURN, GEORGIA))).toBe(true);
    expect(mentionsBoth(nameTokens('NCAAF: Bulldogs vs Tigers'), g)).toBe(true);
    expect(mentionsBoth(nameTokens('NCAAF: Bulldogs - Tigers'), g)).toBe(true);
  });

  it('bounds abbreviations like names, so UL is not UL Monroe and OHIO not Ohio State', () => {
    const ul = team('UL', 'Louisiana', "Ragin' Cajuns", 'Louisiana');
    expect(names(ul, 'cfb', 'NCAAF 09: UL Monroe @ Troy')).toBe(false);
    expect(names(ul, 'cfb', 'Southern Miss vs UL Monroe')).toBe(false);
    expect(names(ul, 'cfb', 'NCAAF 09: Troy @ UL')).toBe(true);
    expect(names(ul, 'cfb', 'UL Lafayette vs Troy')).toBe(true);
    const ohio = team('OHIO', 'Ohio', 'Bobcats', 'Ohio');
    expect(names(ohio, 'cfb', 'Ohio State vs Penn State')).toBe(false);
    expect(names(ohio, 'cfb', 'OHIO vs Kent State')).toBe(true);
    const oleMiss = team('MISS', 'Ole Miss', 'Rebels', 'Ole Miss');
    expect(names(oleMiss, 'cfb', 'NCAAF 16: Miss State vs Oklahoma')).toBe(false);
    expect(names(oleMiss, 'cfb', 'Southern Miss vs Troy')).toBe(false);
    expect(names(oleMiss, 'cfb', 'MISS @ LSU')).toBe(true);
    expect(names(team('IOWA', 'Iowa', 'Hawkeyes', 'Iowa'), 'cfb', 'Iowa State vs Kansas')).toBe(false);
  });

  it('knows provider spellings of schools', () => {
    const cases: [GameTeam, string][] = [
      [team('KSU', 'Kansas State', 'Wildcats', 'Kansas St'), 'K-State vs Baylor'],
      [MSST, 'NCAAF 16: Miss State vs Oklahoma'],
      [MSST, 'Miss St @ Arkansas'],
      [team('VT', 'Virginia Tech', 'Hokies', 'Virginia Tech'), 'NCAAF 18: Va Tech @ Clemson'],
      [team('LT', 'Louisiana Tech', 'Bulldogs', 'Louisiana Tech'), 'NCAAF 30: Old Dominion @ La Tech'],
      [team('MSU', 'Michigan State', 'Spartans', 'Michigan St'), 'Mich St vs Iowa'],
      [team('ARST', 'Arkansas State', 'Red Wolves', 'Arkansas St'), 'Ark State vs Troy'],
      [team('OKST', 'Oklahoma State', 'Cowboys', 'Oklahoma St'), 'Okla State vs Baylor'],
      [team('OKST', 'Oklahoma State', 'Cowboys', 'Oklahoma St'), 'OK State vs Baylor'],
      [team('GT', 'Georgia Tech', 'Yellow Jackets', 'Georgia Tech'), 'Ga Tech vs Duke'],
    ];
    for (const [t, n] of cases) expect(names(t, 'cfb', n), n).toBe(true);
    // Georgia is not Ga Tech's.
    expect(names(GEORGIA, 'cfb', 'Ga Tech vs Duke')).toBe(false);
  });
});

describe('league marks', () => {
  const giants = team('NYG', 'New York', 'Giants');
  const cards = team('ARI', 'Arizona', 'Cardinals');
  const mlbGiants = team('SF', 'San Francisco', 'Giants');
  const mlbCards = team('STL', 'St. Louis', 'Cardinals');

  it('rejects a name marked for another league', () => {
    expect(mentionsBoth(nameTokens('MLB 07: Giants x Cardinals'), game('nfl', giants, cards))).toBe(false);
    expect(mentionsBoth(nameTokens('MLB 07: Giants x Cardinals'), game('mlb', mlbGiants, mlbCards))).toBe(true);
    expect(mentionsBoth(nameTokens('NFL 05: Giants @ Cardinals'), game('nfl', giants, cards))).toBe(true);
    // nameTokens cuts a short colon tag ("NHL: "), so the whole name is read for the mark (match.ts does too).
    expect(mentionsBoth(textTokens('NHL: Panthers vs Jets'), game('nfl', team('CAR', 'Carolina', 'Panthers'), team('NYJ', 'New York', 'Jets')))).toBe(false);
  });

  it('lets a league word outrank a sport word', () => {
    expect(otherLeague(textTokens('NFL Football'), 'cfb')).toBe(true);
    expect(otherLeague(textTokens('College Football'), 'cfb')).toBe(false);
    expect(otherLeague(textTokens('College Football'), 'nba')).toBe(true);
    expect(otherLeague(textTokens('Celtics at Knicks'), 'nba')).toBe(false);
  });

  it('never reads "college" as a pro game, whatever the sport', () => {
    expect(otherLeague(textTokens('Pittsburgh Panthers vs Boston College Eagles'), 'nfl')).toBe(true);
    expect(otherLeague(textTokens('Pittsburgh Panthers vs Boston College Eagles'), 'cfb')).toBe(false);
    expect(otherLeague(textTokens('College Basketball: Duke vs UNC'), 'nba')).toBe(true);
    expect(otherLeague(textTokens('College Basketball: Duke vs UNC'), 'cfb')).toBe(true);
    // A league word still decides.
    expect(otherLeague(textTokens('NFL Network: College Prospects'), 'nfl')).toBe(false);
  });
});

describe('network aliases', () => {
  const id = (name: string) => networkIdForChannel(nameTokens(name));

  it('covers the networks ESPN lists', () => {
    const ids = new Set(NETWORKS.map((n) => n.id));
    for (const want of [
      'espn', 'espn2', 'espnu', 'espnews', 'espn-deportes', 'espn-plus', 'abc', 'cbs', 'nbc', 'fox', 'fs1', 'fs2', 'tnt', 'tbs',
      'trutv', 'usa', 'nfl-network', 'nfl-redzone', 'nba-tv', 'mlb-network', 'btn', 'sec-network', 'acc-network', 'cbssn', 'pac-12',
      'cw', 'peacock', 'prime-video', 'netflix', 'apple-tv', 'paramount-plus', 'disney-plus', 'nba-league-pass', 'mlb-tv',
      'nfl-sunday-ticket', 'nesn', 'yes', 'msg', 'sny', 'marquee', 'spectrum-sportsnet', 'space-city', 'root-sports', 'kfaa', 'kjzz',
      'monumental', 'fdsn-west', 'nbcs-bay-area',
    ]) {
      expect(ids.has(want), want).toBe(true);
    }
    expect(ids.size).toBe(NETWORKS.length);
    // An avoid entry equal to one of the alias's own phrases (a dropped noise word) would block the alias itself.
    for (const n of NETWORKS) {
      const own = new Set(n.phrases.map((p) => p.join(' ')));
      for (const a of n.avoid ?? []) expect(own.has(a.join(' ')), `${n.id}: ${a.join(' ')}`).toBe(false);
    }
  });

  it('keeps ESPN apart from ESPN2, ESPNU, ESPNews, ESPN+ and ESPN Deportes', () => {
    expect(id('ESPN')).toBe('espn');
    expect(id('US: ESPN HD')).toBe('espn');
    expect(id('USA | ESPN FHD')).toBe('espn');
    expect(id('USA ESPN (East)')).toBe('espn');
    expect(id('ESPN 4K Backup 2')).toBe('espn');
    expect(id('ESPN2')).toBe('espn2');
    expect(id('ESPN 2 HD')).toBe('espn2');
    expect(id('ESPNU')).toBe('espnu');
    expect(id('ESPNews')).toBe('espnews');
    expect(id('ESPN News')).toBe('espnews');
    expect(id('ESPN+')).toBe('espn-plus');
    expect(id('ESPN Plus 12')).toBe('espn-plus');
    expect(id('ESPN Deportes')).toBe('espn-deportes');
    expect(id('ESPN Classic')).toBeNull();
  });

  it('keeps FOX apart from FS1, FS2, Fox News and Fox Business', () => {
    expect(id('FOX')).toBe('fox');
    expect(id('FOX 5 New York')).toBe('fox');
    expect(id('FOX 5 Washington (WTTG)')).toBe('fox');
    expect(id('FS1')).toBe('fs1');
    expect(id('Fox Sports 1 HD')).toBe('fs1');
    expect(id('FS2')).toBe('fs2');
    expect(id('Fox Sports 2')).toBe('fs2');
    expect(id('Fox News')).toBeNull();
    expect(id('US | FOX NEWS HD')).toBeNull();
    expect(id('US: FOX NEWS HD')).toBeNull();
    expect(id('Fox Business')).toBeNull();
    // A regional network's old name, not FOX.
    expect(id('FOX Sports Detroit')).toBe('fdsn-detroit');
    expect(id('FOX Sports')).toBeNull();
    expect(id('FOX Deportes')).toBe('fox-deportes');
  });

  it("reads a real provider's FOX Sports, Bally Sports and TSN channels", () => {
    const want: Record<string, string | null> = {
      'US: FOX SPORTS 1 4K': 'fs1',
      'US: FOX SPORTS 2 HD': 'fs2',
      'US: FOX SPORTS DETROIT HD': 'fdsn-detroit',
      'US: FOX SPORTS SOUTH HD': 'fdsn-south',
      'US: FOX SPORTS SOUTH EAST HD': 'fdsn-southeast',
      'US: FOX SPORTS SOUTH WEST HD': 'fdsn-southwest',
      'US: FOX SPORTS MID WEST HD': 'fdsn-midwest',
      'US: FOX SPORTS PRIME TICKET HD': 'fdsn-socal',
      'US: FOX SPORTS COLLEGE ATLANTIC HD': null,
      'US: BALLY SPORTS SOUTHWEST PLUS (DALLAS) HD': 'fdsn-southwest',
      'US: BALLY SPORTS SUN (MIAMI) HD': 'fdsn-sun',
      'US: BALLY SPORTS PRIME TICKET HD': 'fdsn-socal',
      'CA EN: TSN 1': 'tsn',
      'CA EN: TSN 5': 'tsn',
      'CA EN: SPORTSNET ONTARIO': 'sportsnet',
    };
    for (const [name, expected] of Object.entries(want)) expect(id(name), name).toBe(expected);
    expect(networkIdForBroadcast('TSN')).toBe('tsn');
    expect(networkIdForBroadcast('FanDuel SN Detroit')).toBe('fdsn-detroit');
  });

  it('reads the network a slot channel carries after its league word and number', () => {
    const full = (name: string) => networkIdForChannel(textTokens(name));
    const want: Record<string, string> = {
      'NCAAF 02: ESPN2': 'espn2',
      'NCAAF 04: ABC': 'abc',
      'NCAAF 09: BIG TEN NETWORK': 'btn',
      'NCAAF 10: BIG TEN NETWORK ALT': 'btn',
      'NCAAF 12: CBSSN': 'cbssn',
      'NFL 02: ESPN': 'espn',
      'NFL | 02 - ESPN': 'espn',
    };
    for (const [name, expected] of Object.entries(want)) expect(full(name), name).toBe(expected);
    // Empty slots, and slots that carry one game.
    for (const n of ['NCAAF 17:', 'MLB 03 :', 'NFL  | 01 -', ':NBA  09', 'NFL  | 03 - 1pm 49ers at Falcons', 'NCAAF 01: NC State at Wake Forest 7:30pm']) {
      expect(full(n), n).toBeNull();
    }
    // The league's own networks still open with the league word.
    expect(full('NFL Network')).toBe('nfl-network');
    expect(full('MLB: MLB NETWORK')).toBe('mlb-network');
  });

  it('never takes a bare USA', () => {
    expect(id('USA')).toBeNull();
    expect(id('US| USA')).toBeNull();
    expect(id('USA Today')).toBeNull();
    expect(id('USA Network')).toBe('usa');
    expect(id('USA Network HD (East)')).toBe('usa');
  });

  it('reads the network only where the name starts, not an event channel mentioning it', () => {
    expect(id('NBA League Pass 05: Celtics vs Knicks (ESPN)')).toBe('nba-league-pass');
    expect(id('MLB 07: Yankees x Red Sox (FOX)')).toBeNull();
    expect(id('CBS 2 New York (WCBS)')).toBe('cbs');
    expect(id('CBS Sports Network')).toBe('cbssn');
    expect(id('CBS Sports HQ')).toBeNull();
    expect(id('CBS News')).toBeNull();
    expect(id('NBC Sports Boston')).toBe('nbcs-boston');
    expect(id('NBC Sports')).toBeNull();
    expect(id('TNT')).toBe('tnt');
    expect(id('TNT Sports 1')).toBeNull();
    expect(id('YES Network')).toBe('yes');
    expect(id('Yes TV')).toBeNull();
    expect(id('Paramount Network')).toBeNull();
    expect(id('FanDuel Sports Network West')).toBe('fdsn-west');
    expect(id('Bally Sports West')).toBe('fdsn-west');
    expect(id('FanDuel Sports Network Southwest')).toBe('fdsn-southwest');
    expect(id('Spectrum SportsNet LA')).toBe('spectrum-sportsnet-la');
    expect(id('Spectrum SportsNet')).toBe('spectrum-sportsnet');
  });

  it('finds a local station by its call sign anywhere in the name', () => {
    expect(id('Dallas KFAA 29')).toBe('kfaa');
    expect(id('KJZZ-TV Salt Lake City')).toBe('kjzz');
  });

  it('reads a network name followed by a matchup as one game’s channel, except for package services', () => {
    const full = (name: string) => networkIdForChannel(textTokens(name));
    expect(full('ESPN | Knicks @ Celtics')).toBeNull();
    expect(full('ABC: LSU vs Auburn')).toBeNull();
    expect(full('ESPN: Knicks vs Celtics')).toBeNull();
    expect(full('Dodgers vs Giants (KTLA)')).toBeNull();
    expect(id('Nuggets vs Thunder | ESPN')).toBeNull();
    expect(full('ESPN+ 12 | Texas vs Georgia')).toBe('espn-plus');
    expect(id('US| FOX ONE 01: Indiana vs Michigan')).toBe('fox-one');
    expect(id('SEC+ 05: Alabama vs Kentucky')).toBe('sec-network-plus');
    // A leading "at" is no matchup.
    expect(id('AT&T SportsNet Pittsburgh')).toBe('sportsnet-pittsburgh');
    expect(hasMatchup(textTokens('Knicks @ Celtics'))).toBe(true);
    expect(hasMatchup(textTokens('AT&T SportsNet'))).toBe(false);
  });

  it('keeps the network of a name that goes on after a spaced dash (a feed, a region, a station)', () => {
    const full = (name: string) => networkIdForChannel(textTokens(name));
    const want: Record<string, string> = {
      'US: ESPN - East': 'espn',
      'US| ESPN 2 - East': 'espn2',
      'US| TNT - West': 'tnt',
      'US| FOX 5 - WTTG Washington': 'fox',
      'US| ABC 7 - WABC New York': 'abc',
      'USA: NBC 4 - Los Angeles': 'nbc',
      'US| CBS 2 - New York': 'cbs',
      'US| FOX 5 (WNYW) - East': 'fox',
      'Sportsnet - Ontario': 'sportsnet',
      'US| MSG - Plus': 'msg',
      'US| SNY - Mets': 'sny',
    };
    for (const [name, expected] of Object.entries(want)) {
      expect(id(name), name).toBe(expected);
      expect(full(name), name).toBe(expected);
    }
    // And a local station's call sign after the dash.
    expect(id('Dallas - KFAA 29')).toBe('kfaa');
    expect(id('Salt Lake City – KJZZ')).toBe('kjzz');
    // A named separator still makes one game's channel, dash or not.
    for (const n of ['ESPN | Knicks @ Celtics', 'ABC: LSU vs Auburn', 'ESPN: Knicks vs Celtics', 'ESPN - Knicks vs Celtics', 'Celtics vs Knicks - KFAA']) {
      expect(id(n), n).toBeNull();
      expect(full(n), n).toBeNull();
    }
  });

  it('keeps the brands’ editions abroad apart from the US networks', () => {
    for (const n of [
      'ESPN Brasil HD', 'ESPN Caribbean', 'ESPN Norte', 'ESPN Extra', 'ESPN 3', 'ESPN 4', 'ESPN 2 Sur', 'ESPN2 Mexico', 'FOX Footy',
      'FOX Cricket', 'FOX League', 'FOX Soul', 'TNT Brasil', 'ABC Spark', 'yes Action', 'TBS Channel 1',
    ]) {
      expect(id(n), n).toBeNull();
    }
    expect(id('FOX 8 Cleveland')).toBe('fox');
    expect(id('ESPN 2 HD')).toBe('espn2');
  });

  it("maps ESPN's broadcast names", () => {
    const want: Record<string, string | null> = {
      ESPN: 'espn', ESPN2: 'espn2', ESPNU: 'espnu', ESPNEWS: 'espnews', 'ESPN+': 'espn-plus', 'ESPN Unlmtd': 'espn-plus',
      ABC: 'abc', CBS: 'cbs', CBS2: 'cbs', NBC: 'nbc', Fox: 'fox', FS1: 'fs1', TNT: 'tnt', TBS: 'tbs', truTV: 'trutv',
      'USA Net': 'usa', 'NFL Net': 'nfl-network', 'NBA TV': 'nba-tv', 'MLB Net': 'mlb-network', MLBN: 'mlb-network', BTN: 'btn',
      'SEC Network': 'sec-network', 'SECN+': 'sec-network-plus', 'ACC Network': 'acc-network', ACCNX: 'accnx', CBSSN: 'cbssn',
      CW: 'cw', NBCSN: 'nbcsn', Peacock: 'peacock', 'Prime Video': 'prime-video', Netflix: 'netflix', 'Apple TV': 'apple-tv',
      'Paramount+': 'paramount-plus', 'Disney+': 'disney-plus', 'NBA League Pass': 'nba-league-pass', 'MLB.TV': 'mlb-tv',
      NESN: 'nesn', YES: 'yes', 'DAZN (YES)': 'yes', SNY: 'sny', MASN: 'masn', MNMT: 'monumental', CHSN: 'chsn',
      'Marquee Sports Net': 'marquee', 'Spectrum Sports Net': 'spectrum-sportsnet', 'Spectrum Sports Net +': 'spectrum-sportsnet',
      'SportsNet LA': 'spectrum-sportsnet-la', 'Space City Home Network': 'space-city', 'Rangers Sports Network': 'rangers-sn',
      Sportsnet: 'sportsnet', 'Sportsnet One': 'sportsnet-one', TVA: 'tva-sports', GCSEN: 'gcsen',
      'NBC Sports BA': 'nbcs-bay-area', 'NBC Sports CA': 'nbcs-california', 'NBC Sports Phil': 'nbcs-philadelphia',
      'NBC Sports Phil +': 'nbcs-philadelphia', 'FanDuel SN West': 'fdsn-west', 'KFAA-TV': 'kfaa', 'KJZZ-TV': 'kjzz', KSBI: 'ksbi',
      'KUNP 16': 'kunp', KTLA: 'ktla', 'KMSP-TV': 'kmsp', KNTV: 'kntv', 'WCIU-TV': 'wciu', CW33: 'kdaf', 'Fox 5 WTTG': 'wttg',
      FOX59: 'wxin', 'KTRK (ABC)': 'ktrk', "Arizona's Family 3TV": 'ktvk', "Arizona's Family CBS5": 'kpho',
      // Team apps, team streams and unverified feeds have no channel.
      MyMi: null, 'Bucks App': null, 'Rays.TV': null, 'Jazz+': null, MavsTV: null, ClipperVision: null, 'DAZN MEM': null,
      'Bengals Preseason TV Network': null, 'Gotham Sports App': null, 'MW+': null, 'UConn+': null,
    };
    for (const [name, expected] of Object.entries(want)) expect(networkIdForBroadcast(name), name).toBe(expected);
  });
});

describe('isSportsGroup', () => {
  it('takes sports, leagues, services, regional networks, PPV and events', () => {
    for (const g of [
      'US| SPORTS', 'USA SPORTS HD', 'NBA League Pass', 'NFL SUNDAY TICKET', 'NCAAF', 'College Football', 'MLB', 'ESPN+',
      'ESPN Plus Events', 'PEACOCK', 'Paramount+', 'Prime Video', 'DAZN', 'FanDuel Sports', 'Bally Sports', 'RSN', 'US Regional',
      'PPV', 'Live Events', 'FUBO', 'NFL Game Pass', 'Deportes', 'US| SEC NETWORK+', 'US| SEC+', 'US| ACC NETWORK EXTRA',
      'US| ACCNX', 'US| B1G+', 'US| BIG 12', 'US| MOUNTAIN WEST', 'US| PAC-12', 'MW+',
    ]) {
      expect(isSportsGroup(g), g).toBe(true);
    }
  });

  it('skips the rest', () => {
    for (const g of ['US| ENTERTAINMENT', 'UK: News', 'Movies', 'Kids', 'USA Locals', 'US| FOX NEWS']) expect(isSportsGroup(g), g).toBe(false);
  });

  it('takes a group named after a network that carries the games', () => {
    for (const g of ['US| FOX ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ', 'US| CBS ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ', 'US| NBC', 'US| TNT', 'CA| TSN']) expect(isSportsGroup(g), g).toBe(true);
    // A streaming service's group is mostly shows; its games sit in its PPV group.
    for (const g of ['US| NETFLIX ON AIR ᴿᴬᵂ ⁶⁰ᶠᵖˢ', 'US| DISNEY+ NETWORK ᴿᴬᵂ ⁶⁰ᶠᵖˢ']) expect(isSportsGroup(g), g).toBe(false);
    expect(isSportsGroup('US| NETFLIX PPV')).toBe(true);
  });

  it('skips a group tagged for another country unless it names one of the four leagues', () => {
    for (const g of ['UK| SKY SPORT+ PPV ᴿᴬᵂ', 'UK| ESPN+ PPV', 'DE| DAZN PPV', 'BR| ESPN SPORT ᴴᴰ', 'FR| SOCCER PPV', 'UK SPORTS', '|AR| DEPORTES', 'UK| FOOTBALL']) {
      expect(isSportsGroup(g), g).toBe(false);
    }
    for (const g of ['BR| NBA PASS PPV', 'UK| NFL GAME PASS', 'MX| NFL', 'LATAM| MLB', 'CA| SPORTS EN', 'US| SPORTS']) expect(isSportsGroup(g), g).toBe(true);
  });

  it('skips a group that names only other sports', () => {
    for (const g of [
      'US| SOCCER PPV', 'US| NHL PPV', 'US| UFC PPV', 'US| WNBA PPV', 'US| MILB PPV', 'US| NCAAB PPV', 'US| FLO ⱽᴵᴾ PPV', 'US| TENNIS PPV',
      'US| GOLF PPV', 'US| FIFA+ PPV', 'US| UEFA PPV', 'US| APPLE TV F1 PPV', 'US| NFHS PPV', 'US| BOXING PPV', 'US| WWE PPV', 'US| NASCAR',
      'CA| WHL PPV', 'US| SUPERCROSS PPV',
    ]) {
      expect(isSportsGroup(g), g).toBe(false);
    }
    // One of the four leagues or their sports beside it keeps the group.
    for (const g of ['US| NHL & NBA PPV', 'US| SOCCER & FOOTBALL', 'US| MLB EXTRA INNINGS']) expect(isSportsGroup(g), g).toBe(true);
  });

  it('keeps ambiguous groups', () => {
    for (const g of ['US| SPORT ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ', 'US| PPV EVENT', 'US| ESPN+ PPV ⱽᴵᴾ', 'US| PEACOCK PPV ⱽᴵᴾ', '8K| SPORT ON AIR ⁸ᴷ', 'BEIN SPORTS', 'LATINO DEPORTES']) {
      expect(isSportsGroup(g), g).toBe(true);
    }
  });

  it("reads a real provider's groups", () => {
    // From a 56,990-channel Xtream account (Oct 2026): 917 live groups, of which these are the sports-like ones.
    const kept = [
      'US| NFL PPV', 'US| NFL REPLAY', 'US| NBA PPV', 'US| NBA TEAM PPV', 'US| NBA PASS PPV ⁸ᴷ', 'US| MLB PPV', 'US| MLB TEAM PPV',
      'US| NCAAF PPV', 'US| SPORT ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ', 'US| ESPN+ PPV ⱽᴵᴾ', 'US| ESPN+ PPV', 'US| PEACOCK PPV ⱽᴵᴾ', 'US| BTN+ PPV',
      'US| BALLY SPORTS PPV', 'US| PRIME ᴿᴬᵂ ⁶⁰ᶠᵖˢ', 'US| FOX ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ', 'US| CBS ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ', 'BR| NBA PASS PPV', 'CA| SPORTS EN',
      'CA| TSN SPORT ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ', 'CA| SPORTSNET PPV', '8K| SPORT ON AIR ⁸ᴷ',
    ];
    const skipped = [
      'US| NCAAB PPV', 'US| SOCCER PPV', 'US| NHL PPV', 'US| WNBA PPV', 'US| MILB PPV', 'US| UFC PPV', 'US| FLO ⱽᴵᴾ PPV', 'US| TENNIS PPV',
      'US| GOLF PPV', 'US| FIFA+ PPV', 'US| UEFA PPV', 'US| APPLE TV F1 PPV', 'US| NFHS PPV', 'UK| SKY SPORT+ PPV ᴿᴬᵂ',
      'UK| ESPN+ PPV', 'DE| DAZN PPV', 'FR| SOCCER PPV', 'BR| ESPN SPORT ᴴᴰ',
    ];
    expect(kept.filter((g) => !isSportsGroup(g))).toEqual([]);
    expect(skipped.filter((g) => isSportsGroup(g))).toEqual([]);
  });
});
