/**
 * A big account's Sports page, generated for the performance tests: a 60-game Saturday slate (42 college
 * football, 15 NBA and 3 MLB games) and 8,000 live channels in 40 sports groups (5% network channels, 1%
 * event channels, the rest other sports channels from around the world). Every channel has 12 guide
 * programmes of 80 minutes over 16 hours with 300-character descriptions; a network channel's programme is
 * the game when its network carries one. Seeded, so every run builds the same data.
 */

import { itemKey, type Category, type Channel, type EpgProgram, type ItemKey, type Source } from '@/api/types';

import { toIndexed, type IndexedChannel } from '../hooks/useChannelIndex';
import { TYPICAL_LENGTH_MS, etDate } from '../lib/espn';
import { networkIdForBroadcast, networkIdForChannel, nameTokens } from '../lib/names';
import type { Game, GameBroadcast, GameTeam, League } from '../lib/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Saturday 2026-10-24, 11:00 AM Eastern: an hour before the first kickoff. */
export const SATURDAY_NOW = Date.parse('2026-10-24T15:00:00Z');
const FIRST_KICKOFF = Date.parse('2026-10-24T16:00:00Z');
/** The guide's first slot; 12 slots of 80 minutes cover the slate's union window (15:30Z to 07:00Z). */
const GUIDE_START = Date.parse('2026-10-24T15:20:00Z');
const SLOT = 80 * MINUTE;
const SLOTS = 12;

export const SLATE_SOURCE: Pick<Source, 'id' | 'kind' | 'name'> = { id: 'src1', kind: 'xtream', name: 'Home portal' };

/** mulberry32 */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;

// ---------------------------------------------------------------------------
// Games

const CFB_TEAMS =
  'Alabama:Crimson Tide:ALA|Auburn:Tigers:AUB|Georgia:Bulldogs:UGA|Florida:Gators:FLA|LSU:Tigers:LSU|Texas:Longhorns:TEX|' +
  'Oklahoma:Sooners:OU|Texas A&M:Aggies:TA&M|Tennessee:Volunteers:TENN|Kentucky:Wildcats:UK|Ole Miss:Rebels:MISS|' +
  'Mississippi State:Bulldogs:MSST|Missouri:Tigers:MIZ|Arkansas:Razorbacks:ARK|South Carolina:Gamecocks:SC|' +
  'Vanderbilt:Commodores:VAN|Ohio State:Buckeyes:OSU|Michigan:Wolverines:MICH|Penn State:Nittany Lions:PSU|' +
  'Michigan State:Spartans:MSU|Wisconsin:Badgers:WIS|Iowa:Hawkeyes:IOWA|Minnesota:Golden Gophers:MINN|' +
  'Nebraska:Cornhuskers:NEB|Illinois:Fighting Illini:ILL|Northwestern:Wildcats:NU|Purdue:Boilermakers:PUR|' +
  'Indiana:Hoosiers:IU|Maryland:Terrapins:MD|Rutgers:Scarlet Knights:RUTG|Oregon:Ducks:ORE|Washington:Huskies:WASH|' +
  'USC:Trojans:USC|UCLA:Bruins:UCLA|Clemson:Tigers:CLEM|Florida State:Seminoles:FSU|Miami:Hurricanes:MIA|' +
  'North Carolina:Tar Heels:UNC|NC State:Wolfpack:NCSU|Duke:Blue Devils:DUKE|Virginia Tech:Hokies:VT|' +
  'Virginia:Cavaliers:UVA|Louisville:Cardinals:LOU|Pittsburgh:Panthers:PITT|Syracuse:Orange:SYR|Boston College:Eagles:BC|' +
  'Wake Forest:Demon Deacons:WAKE|Georgia Tech:Yellow Jackets:GT|SMU:Mustangs:SMU|Stanford:Cardinal:STAN|' +
  'California:Golden Bears:CAL|Notre Dame:Fighting Irish:ND|Utah:Utes:UTAH|BYU:Cougars:BYU|Kansas State:Wildcats:KSU|' +
  'Kansas:Jayhawks:KU|Iowa State:Cyclones:ISU|Oklahoma State:Cowboys:OKST|Baylor:Bears:BAY|TCU:Horned Frogs:TCU|' +
  'Texas Tech:Red Raiders:TTU|West Virginia:Mountaineers:WVU|Cincinnati:Bearcats:CIN|Houston:Cougars:HOU|UCF:Knights:UCF|' +
  'Arizona:Wildcats:ARIZ|Arizona State:Sun Devils:ASU|Colorado:Buffaloes:COLO|Boise State:Broncos:BSU|' +
  'San Diego State:Aztecs:SDSU|Fresno State:Bulldogs:FRES|Air Force:Falcons:AF|Army:Black Knights:ARMY|' +
  'Navy:Midshipmen:NAVY|Memphis:Tigers:MEM|Tulane:Green Wave:TULN|Appalachian State:Mountaineers:APP|' +
  'Coastal Carolina:Chanticleers:CCU|James Madison:Dukes:JMU|Liberty:Flames:LIB|Toledo:Rockets:TOL|' +
  'Miami (OH):RedHawks:M-OH|Washington State:Cougars:WSU|Oregon State:Beavers:ORST';
const NBA_TEAMS =
  'Boston:Celtics:BOS|New York:Knicks:NY|Brooklyn:Nets:BKN|Philadelphia:76ers:PHI|Toronto:Raptors:TOR|Chicago:Bulls:CHI|' +
  'Cleveland:Cavaliers:CLE|Detroit:Pistons:DET|Indiana:Pacers:IND|Milwaukee:Bucks:MIL|Atlanta:Hawks:ATL|' +
  'Charlotte:Hornets:CHA|Miami:Heat:MIA|Orlando:Magic:ORL|Washington:Wizards:WSH|Denver:Nuggets:DEN|' +
  'Minnesota:Timberwolves:MIN|Oklahoma City:Thunder:OKC|Portland:Trail Blazers:POR|Utah:Jazz:UTAH|' +
  'Golden State:Warriors:GS|LA:Clippers:LAC|Los Angeles:Lakers:LAL|Phoenix:Suns:PHX|Sacramento:Kings:SAC|' +
  'Dallas:Mavericks:DAL|Houston:Rockets:HOU|Memphis:Grizzlies:MEM|New Orleans:Pelicans:NO|San Antonio:Spurs:SA';
const MLB_TEAMS =
  'Los Angeles:Dodgers:LAD|Toronto:Blue Jays:TOR|New York:Yankees:NYY|Seattle:Mariners:SEA|Milwaukee:Brewers:MIL|' +
  'Philadelphia:Phillies:PHI';

function teams(list: string, league: League): GameTeam[] {
  return list.split('|').map((entry) => {
    const [location, name, abbreviation] = entry.split(':') as [string, string, string];
    return {
      id: `${league}-${abbreviation}`,
      abbreviation,
      displayName: `${location} ${name}`,
      shortDisplayName: league === 'cfb' ? location : name,
      name,
      location,
      logo: null,
      color: null,
      score: null,
      winner: null,
      record: null,
      rank: null,
    };
  });
}

const national = (...names: string[]): GameBroadcast[] => names.map((name) => ({ name, market: 'national', kind: 'tv' }));

const CFB_TV = [
  'ABC', 'ESPN', 'FOX', 'CBS', 'ESPN2', 'FS1', 'SEC Network', 'ACC Network', 'Big Ten Network', 'ESPNU', 'CBS Sports Network',
  'NBC', 'The CW', 'ESPN+', 'Peacock', 'FS2', 'ESPNews',
];
const NBA_TV: GameBroadcast[][] = [
  national('NBA TV'),
  national('ESPN'),
  [{ name: 'NBC Sports Boston', market: 'home', kind: 'tv' }, { name: 'MSG', market: 'away', kind: 'tv' }],
  [{ name: 'FanDuel SN Ohio', market: 'home', kind: 'tv' }, { name: 'YES', market: 'away', kind: 'tv' }],
  [{ name: 'NBC Sports Phil', market: 'home', kind: 'tv' }, { name: 'NBA League Pass', market: 'national', kind: 'streaming' }],
  [{ name: 'Space City Home Network', market: 'home', kind: 'tv' }, { name: 'Altitude', market: 'away', kind: 'tv' }],
];
const MLB_TV = ['FOX', 'FS1', 'TBS'];

function makeGame(league: League, n: number, away: GameTeam, home: GameTeam, startMs: number, broadcasts: GameBroadcast[]): Game {
  return {
    key: `${league}:${n}`,
    id: String(n),
    league,
    etDate: etDate(startMs),
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
    broadcasts,
    gamecastUrl: null,
  };
}

/** Kickoffs in hours after noon Eastern. */
const CFB_STARTS = [0, 3.5, 4, 7, 7.5, 8, 10.5];
const NBA_STARTS = [7, 7.5, 8, 8.5, 9, 10, 10.5];
const MLB_STARTS = [0.15, 4.15, 8.15];

function slate(): Game[] {
  const out: Game[] = [];
  const cfb = teams(CFB_TEAMS, 'cfb');
  for (let i = 0; i < 42; i++) {
    const tv = [CFB_TV[i % CFB_TV.length]!, ...(i % 5 === 0 ? ['ESPN+'] : [])];
    out.push(makeGame('cfb', i, cfb[2 * i]!, cfb[2 * i + 1]!, FIRST_KICKOFF + CFB_STARTS[i % CFB_STARTS.length]! * HOUR, national(...tv)));
  }
  const nba = teams(NBA_TEAMS, 'nba');
  for (let i = 0; i < 15; i++) {
    out.push(makeGame('nba', 100 + i, nba[2 * i]!, nba[2 * i + 1]!, FIRST_KICKOFF + NBA_STARTS[i % NBA_STARTS.length]! * HOUR, NBA_TV[i % NBA_TV.length]!));
  }
  const mlb = teams(MLB_TEAMS, 'mlb');
  for (let i = 0; i < 3; i++) {
    out.push(makeGame('mlb', 200 + i, mlb[2 * i]!, mlb[2 * i + 1]!, FIRST_KICKOFF + MLB_STARTS[i]! * HOUR, national(MLB_TV[i]!)));
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

export const SLATE: readonly Game[] = slate();

// ---------------------------------------------------------------------------
// Channels

export const SLATE_CHANNELS = 8000;
export const SLATE_GROUPS = 40;

const NETWORK_NAMES = [
  'ESPN', 'ESPN 2', 'ESPNU', 'ESPNews', 'ESPN Deportes', 'ABC 7 New York', 'ABC 7 Chicago', 'ABC 6 Philadelphia', 'CBS 2 New York',
  'CBS 2 Los Angeles', 'CBS 4 Miami', 'FOX 5 New York', 'FOX 11 Los Angeles', 'FOX 32 Chicago', 'NBC 4 New York', 'NBC 5 Chicago',
  'FS1', 'FS2', 'SEC Network', 'ACC Network', 'Big Ten Network', 'CBS Sports Network', 'CW 11 New York', 'NBA TV', 'MLB Network',
  'TBS', 'TNT', 'truTV', 'NESN', 'YES Network', 'MSG', 'NBC Sports Boston', 'NBC Sports Philadelphia', 'FanDuel Sports Network Ohio',
  'FanDuel Sports Network Detroit', 'Space City Home Network', 'Altitude Sports', 'Marquee Sports Network', 'Spectrum SportsNet LA',
  'NFL Network',
];
const NETWORK_COPIES = ['', ' HD', ' FHD', ' 4K', ' (Backup)', ' HEVC', ' RAW', ' SD', ' 720p', ' East'];

const PREFIXES = ['UK', 'DE', 'FR', 'ES', 'IT', 'PT', 'NL', 'AR', 'TR', 'PL', 'US', 'CA', 'MX', 'BR', 'AU', 'IE', 'SE', 'GR'];
const BRANDS = [
  'SKY SPORTS', 'BEIN SPORTS', 'DAZN', 'EUROSPORT', 'SPORT TV', 'ELEVEN SPORTS', 'SPORT KLUB', 'ARENA SPORT', 'MATCH TV',
  'NOVA SPORT', 'SUPERSPORT', 'PREMIER SPORTS', 'TV2 SPORT', 'POLSAT SPORT', 'CANAL+ SPORT', 'MOVISTAR DEPORTES', 'ESPORTE',
  'SPORT 1', 'PPV EVENT', 'NHL',
];

/**
 * No group carries another country's tag: the page skips those (isSportsGroup), and the channels here are
 * spread over the groups at random, so every group holds some of the slate's networks and events.
 */
const GROUP_NAMES = [
  ...PREFIXES.map((p) => `SPORTS ${p}`),
  'USA SPORTS HD', 'NCAAF', 'NBA LEAGUE PASS', 'PPV EVENTS', 'ESPN+', 'PEACOCK', 'NFL SUNDAY TICKET', 'MLB EXTRA INNINGS',
  'US| REGIONAL SPORTS', 'DAZN', 'FUBO SPORTS', 'BEIN SPORTS', 'SUPERSPORT EVENTS', 'US| COLLEGE SPORTS', 'FOOTBALL',
  'EVENTS 24/7', 'SPORTS PPV', 'US| NBA', 'US| MLB', 'US| NFL', 'CA| SPORTS', 'LATINO DEPORTES',
];
/** Groups the page must leave alone. */
export const OTHER_GROUPS = ['US| NEWS', 'UK| ENTERTAINMENT', 'KIDS'];

function eventName(g: Game, n: number): string {
  const { away, home } = g;
  switch (g.league) {
    case 'cfb':
      return n % 2 === 0 ? `NCAAF ${n}: ${away.location} @ ${home.location}` : `ESPN+ ${n} | ${away.location} vs ${home.location}`;
    case 'nba':
      return n % 2 === 0 ? `NBA ${n}: ${away.name} @ ${home.name}` : `NBA League Pass ${n}: ${away.displayName} vs ${home.displayName}`;
    default:
      return `MLB ${n}: ${away.name} x ${home.name}`;
  }
}

const OTHER_EVENTS = ['NHL {n}: Rangers @ Bruins', 'EPL {n}: Arsenal vs Chelsea', 'UFC {n}: Main Card', 'LaLiga {n}: Sevilla vs Betis'];

function channelNames(): string[] {
  const names: string[] = [];
  for (const copy of NETWORK_COPIES) for (const n of NETWORK_NAMES) names.push(`US| ${n}${copy}`);
  SLATE.slice(0, 50).forEach((g, i) => names.push(eventName(g, i + 1)));
  for (let i = 0; i < 30; i++) names.push(OTHER_EVENTS[i % OTHER_EVENTS.length]!.replace('{n}', String(i + 1)));
  for (let i = 0; names.length < SLATE_CHANNELS; i++) {
    names.push(`${PREFIXES[i % PREFIXES.length]}| ${BRANDS[Math.floor(i / PREFIXES.length) % BRANDS.length]} ${Math.floor(i / 360) + 1}`);
  }
  // Spread networks and events over the groups, as providers do.
  const r = rng(7);
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [names[i], names[j]] = [names[j]!, names[i]!];
  }
  return names;
}

function buildChannels(): Channel[] {
  const perGroup = SLATE_CHANNELS / SLATE_GROUPS;
  return channelNames().map((name, i) => {
    const group = Math.floor(i / perGroup);
    return {
      ref: { sourceId: SLATE_SOURCE.id, contentType: 'live', itemId: `c${i}` },
      name,
      categoryId: `g${group}`,
      categoryName: GROUP_NAMES[group]!,
      isRadio: false,
    };
  });
}

/** Every channel of the sports groups, group by group. */
export const SLATE_CHANNEL_LIST: readonly Channel[] = buildChannels();

/** The live groups of the source: the 40 sports groups, then three others. */
export function slateCategories(): Category[] {
  const perGroup = SLATE_CHANNELS / SLATE_GROUPS;
  const cat = (id: string, name: string, itemCount: number, position: number): Category => ({
    id,
    sourceId: SLATE_SOURCE.id,
    contentType: 'live',
    name,
    hidden: false,
    itemCount,
    position,
  });
  return [
    ...GROUP_NAMES.map((name, i) => cat(`g${i}`, name, perGroup, i)),
    ...OTHER_GROUPS.map((name, i) => cat(`o${i}`, name, 100, GROUP_NAMES.length + i)),
  ];
}

// ---------------------------------------------------------------------------
// Guide

const TITLES = [
  'Premier League Football', 'LaLiga Highlights', 'Bundesliga Live', 'Serie A', 'NHL Hockey', 'SportsCenter', 'ATP Tennis',
  'Golf Central', 'Boxing Night', 'UFC Fight Night', 'Cricket: Test Match', 'Formula 1 Qualifying', 'Rugby Union', 'Darts',
  'Snooker', 'Cycling', 'Motor Racing', 'Sports News', 'Fishing Adventures', 'Poker Tour', 'College Football Live', 'NBA Today',
];
const WORDS = (
  'the of and a to in live coverage from match game season league cup final round team players coach analysis highlights ' +
  'interview stadium fans goal score win loss championship title week weekend night afternoon morning series race fight ' +
  'event preview review classic best top ten moments history legends rivals derby clash showdown battle action news update ' +
  'report studio panel experts discussion tactics transfer injury return debut record performance with for on at as by'
).split(' ');
/** Team words, which turn up now and then in any sports guide: the candidate lists are not trivially short. */
const TEAM_WORDS = [...new Set(SLATE.flatMap((g) => [g.home, g.away]).flatMap((t) => `${t.location} ${t.name}`.toLowerCase().split(' ')))];

function description(r: () => number): string {
  const words: string[] = [];
  let length = 0;
  while (length < 300) {
    const w = r() < 0.01 ? pick(r, TEAM_WORDS) : pick(r, WORDS);
    words.push(w);
    length += w.length + 1;
  }
  const text = words.join(' ');
  return `${text[0]!.toUpperCase()}${text.slice(1, 299)}.`;
}

const GAME_TITLES: Record<League, string> = { cfb: 'College Football', nba: 'NBA Basketball', mlb: 'MLB Baseball', nfl: 'NFL Football' };

/** The games each network channel carries, by channel position: the first game on the network at any time. */
function carried(): Map<number, Game[]> {
  const out = new Map<number, Game[]>();
  SLATE_CHANNEL_LIST.forEach((ch, i) => {
    const network = networkIdForChannel(nameTokens(ch.name));
    if (!network) return;
    const games: Game[] = [];
    for (const g of SLATE) {
      if (!g.broadcasts.some((b) => networkIdForBroadcast(b.name) === network)) continue;
      const end = g.startMs + TYPICAL_LENGTH_MS[g.league];
      if (games.some((o) => o.startMs < end && o.startMs + TYPICAL_LENGTH_MS[o.league] > g.startMs)) continue;
      games.push(g);
    }
    if (games.length > 0) out.set(i, games);
  });
  return out;
}

const CARRIED = carried();

/**
 * The guide of the channel at `position`, as fresh objects on every call (as a parsed answer is), the
 * same each time.
 */
export function programmesOf(position: number): EpgProgram[] {
  const r = rng(position + 1);
  const channelId = `guide.${position}`;
  const iso = (ms: number) => new Date(ms).toISOString();
  const games = CARRIED.get(position) ?? [];
  const out: EpgProgram[] = [];
  for (let s = 0; s < SLOTS; s++) {
    const start = GUIDE_START + s * SLOT;
    const title = pick(r, TITLES);
    const text = description(r);
    if (games.some((g) => g.startMs < start + SLOT && g.startMs + TYPICAL_LENGTH_MS[g.league] > start)) continue;
    out.push({ channelId, start: iso(start), end: iso(start + SLOT), title, description: text, category: 'Sports' });
  }
  for (const g of games) {
    out.push({
      channelId,
      start: iso(g.startMs),
      end: iso(g.startMs + TYPICAL_LENGTH_MS[g.league]),
      title: GAME_TITLES[g.league],
      description: `${g.away.displayName} at ${g.home.displayName}. ${description(r).slice(0, 240)}`,
      category: 'Sports',
    });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** The channel index the page builds from these groups (without network search hits). */
export function slateIndex(): IndexedChannel[] {
  return SLATE_CHANNEL_LIST.map((ch) => toIndexed(ch, SLATE_SOURCE, true));
}

/** Every channel's guide, as fresh programme objects. */
export function slateProgrammes(): Map<ItemKey, EpgProgram[]> {
  return new Map(SLATE_CHANNEL_LIST.map((ch, i) => [itemKey(ch.ref), programmesOf(i)]));
}

/** Channel position of an item id (`c123`). */
export const positionOf = (itemId: string): number => Number(itemId.slice(1));
