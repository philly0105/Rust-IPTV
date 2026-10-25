/**
 * ESPN's public scoreboard API (unofficial, no key, CORS `*`): one plain GET per league and US Eastern day,
 * normalized into `Game`s. `dates=YYYYMMDD` returns exactly one Eastern calendar day (an 8:20 PM ET kickoff
 * dated 00:20Z the next UTC day comes back under the Eastern date), so days here are Eastern too: `etDate`,
 * `etDays` and `etDayStart` work in America/New_York whatever the machine's zone is. Date ranges answer 400
 * and month queries cap at 100 events, so the client never asks for more than a day.
 */

import { dateTimeFormat } from '@/lib/intl';

import type { Game, GameBroadcast, GamePhase, GameTeam, League } from './types';

export const ET_ZONE = 'America/New_York';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const ET_DAY: Intl.DateTimeFormatOptions = { timeZone: ET_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' };
const ET_TIME: Intl.DateTimeFormatOptions = { ...ET_DAY, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };

/** Eastern wall-clock fields of `ms` ('2026', '10', '22', ...). Parts rather than a formatted string: no locale's pattern to trust. */
function etParts(ms: number, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of dateTimeFormat('en-US', opts).formatToParts(ms)) out[p.type] = p.value;
  return out;
}

/** The US Eastern date of `ms` as 'YYYY-MM-DD'. */
export function etDate(ms: number): string {
  const p = etParts(ms, ET_DAY);
  return `${p.year}-${p.month}-${p.day}`;
}

function ymd(day: string): [number, number, number] {
  const [y = NaN, m = NaN, d = NaN] = day.split('-').map(Number);
  return [y, m, d];
}

/** `day` moved by `n` calendar days ('2026-10-31', 1 -> '2026-11-01'). Calendar arithmetic, so DST cannot skip or repeat a day. */
export function shiftEtDate(day: string, n: number): string {
  const [y, m, d] = ymd(day);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Eastern wall clock minus UTC at `ms`: -4 h in summer, -5 h in winter. */
function etOffset(ms: number): number {
  const p = etParts(ms, ET_TIME);
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** UTC ms of midnight Eastern starting `day` (04:00Z in summer, 05:00Z in winter). */
export function etDayStart(day: string): number {
  const [y, m, d] = ymd(day);
  const wall = Date.UTC(y, m - 1, d);
  // The second pass corrects the guess on days whose offset changes (DST moves at 2 AM, after midnight).
  return wall - etOffset(wall - etOffset(wall));
}

/** Eastern dates from `back` days before today to `ahead` days after, oldest first. */
export function etDays(nowMs: number, back = 7, ahead = 7): string[] {
  const today = etDate(nowMs);
  return Array.from({ length: back + ahead + 1 }, (_, i) => shiftEtDate(today, i - back));
}

const SPORT_PATHS: Record<League, string> = {
  nfl: 'football/nfl',
  cfb: 'football/college-football',
  nba: 'basketball/nba',
  mlb: 'baseball/mlb',
};

/**
 * The one scoreboard request for a league and Eastern day. `limit=300` is above any real day (a busy CFB
 * Saturday is 68 events); `groups=80` keeps college football to FBS.
 */
export function scoreboardUrl(league: League, etDate: string): string {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${SPORT_PATHS[league]}/scoreboard?dates=${etDate.replaceAll('-', '')}&limit=300`;
  return league === 'cfb' ? `${base}&groups=80` : base;
}

/**
 * Fetches and normalizes one day. No custom headers, so the browser sends it as a simple CORS request
 * without a preflight. Throws on a non-2xx answer or a body that is not JSON.
 */
export async function fetchScoreboard(league: League, etDate: string, signal?: AbortSignal): Promise<Game[]> {
  const res = await fetch(scoreboardUrl(league, etDate), { signal });
  if (!res.ok) throw new Error(`ESPN ${league} scoreboard for ${etDate} answered HTTP ${res.status}`);
  return normalizeScoreboard(league, await res.json());
}

/** Rough game lengths, for guide windows and synthetic catch-up programmes. */
export const TYPICAL_LENGTH_MS: Record<League, number> = {
  nfl: 3 * HOUR + 15 * MINUTE,
  cfb: 3 * HOUR + 30 * MINUTE,
  nba: 2 * HOUR + 30 * MINUTE,
  mlb: 3 * HOUR,
};

/**
 * When a game is likely on air: 30 min before the start to an hour past its typical length. A TBD start
 * (`timeValid` false, dated midnight Eastern) or a flex window note has no real time, so it gets the whole
 * Eastern day plus 4 h for games that run past midnight.
 */
export function gameWindow(game: Game): { from: number; to: number } {
  if (!game.timeValid || game.timeNote) {
    return { from: etDayStart(game.etDate), to: etDayStart(shiftEtDate(game.etDate, 1)) + 4 * HOUR };
  }
  return { from: game.startMs - 30 * MINUTE, to: game.startMs + TYPICAL_LENGTH_MS[game.league] + HOUR };
}

// ---------------------------------------------------------------------------
// Normalizer. ESPN's JSON is undocumented, so every read is checked: a missing optional field becomes a
// default, and only an event without an id, a start date or both teams is skipped.

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** An http(s) URL, or null: logos and the Gamecast link end up in `src` and `href`. */
function httpUrl(v: unknown): string | null {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
}

/** First-note prefixes that announce a kickoff window rather than an event ("FLEX: 3:30 - 4:30pm OR 6 - 8pm ET start"). */
const TIME_NOTE = /^(EARLY|FLEX|NIGHT|LATE)\b/i;

function phaseOf(name: string | null, state: Game['state'], completed: unknown): GamePhase {
  if (name === 'STATUS_POSTPONED') return 'postponed';
  if (name === 'STATUS_CANCELED' || name === 'STATUS_CANCELLED') return 'canceled';
  if (name === 'STATUS_SUSPENDED') return 'suspended';
  if (state === 'in') return 'live';
  // Postponed games are 'post' with completed false; an unknown name in that shape is not a final either.
  if (state === 'post') return completed === false ? 'postponed' : 'final';
  return 'scheduled';
}

function stateOf(type: Json | null): Game['state'] {
  const s = type?.state;
  if (s === 'pre' || s === 'in' || s === 'post') return s;
  return type?.completed === true ? 'post' : 'pre';
}

function teamOf(c: Json, league: League, scored: boolean): GameTeam | null {
  const t = obj(c.team);
  const id = str(t?.id) ?? str(c.id);
  if (!t || !id) return null;
  const location = str(t.location) ?? '';
  const name = str(t.name) ?? '';
  const abbreviation = str(t.abbreviation) ?? '';
  const displayName = str(t.displayName) ?? (`${location} ${name}`.trim() || abbreviation);
  const color = str(t.color);
  const rank = league === 'cfb' ? num(obj(c.curatedRank)?.current) : null;
  const total = arr(c.records).map(obj).find((r) => r?.type === 'total');
  const rawScore = obj(c.score)?.value ?? c.score;
  return {
    id,
    abbreviation,
    displayName,
    shortDisplayName: str(t.shortDisplayName) ?? (name || displayName),
    name,
    location,
    logo: httpUrl(t.logo),
    color: color && /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color) ? color : null,
    score: scored ? num(rawScore) : null,
    winner: typeof c.winner === 'boolean' ? c.winner : null,
    record: str(total?.summary),
    // ESPN sends 99 for unranked teams.
    rank: rank !== null && rank >= 1 && rank <= 25 ? rank : null,
  };
}

const MARKETS = new Set<string>(['national', 'home', 'away']);

function marketOf(v: unknown): GameBroadcast['market'] {
  const m = typeof v === 'string' ? v.toLowerCase() : '';
  return MARKETS.has(m) ? (m as GameBroadcast['market']) : 'national';
}

/**
 * geoBroadcasts (typed TV or Streaming, Radio dropped) then the names only `broadcasts[]` has, such as
 * NBA League Pass, as kind 'unknown'. One entry per name and market.
 */
function broadcastsOf(comp: Json): GameBroadcast[] {
  const out: GameBroadcast[] = [];
  const seen = new Set<string>();
  const add = (name: string | null, market: GameBroadcast['market'], kind: GameBroadcast['kind']) => {
    if (!name) return;
    const id = `${market}|${name}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ name, market, kind });
  };
  for (const g of arr(comp.geoBroadcasts).map(obj)) {
    const type = obj(g?.type);
    const short = str(type?.shortName)?.toLowerCase();
    if (short === 'radio' || type?.id === '5') continue;
    const kind = short === 'tv' ? 'tv' : short === 'streaming' ? 'streaming' : 'unknown';
    add(str(obj(g?.media)?.shortName)?.trim() ?? null, marketOf(obj(g?.market)?.type), kind);
  }
  for (const b of arr(comp.broadcasts).map(obj)) {
    const market = marketOf(b?.market);
    for (const n of arr(b?.names)) add(str(n)?.trim() ?? null, market, 'unknown');
  }
  return out;
}

function gameOf(league: League, e: Json): Game | null {
  const comp = obj(arr(e.competitions)[0]);
  if (!comp) return null;
  const id = str(e.id) ?? str(comp.id);
  const startMs = Date.parse(str(comp.date) ?? str(e.date) ?? '');
  if (!id || !Number.isFinite(startMs)) return null;

  const status = obj(comp.status) ?? obj(e.status);
  const type = obj(status?.type);
  const state = stateOf(type);
  const phase = phaseOf(str(type?.name), state, type?.completed);
  const scored = state !== 'pre' && phase !== 'postponed' && phase !== 'canceled';

  const competitors = arr(comp.competitors).map(obj);
  const side = (homeAway: string) => {
    const c = competitors.find((x) => x?.homeAway === homeAway);
    return c ? teamOf(c, league, scored) : null;
  };
  const home = side('home');
  const away = side('away');
  if (!home || !away) return null;

  const headlines = arr(comp.notes)
    .map((n) => str(obj(n)?.headline))
    .filter((h): h is string => h !== null);
  const season = obj(e.season);
  const seasonType = num(obj(season?.type)?.type ?? season?.type);
  // The game's page: its summary link, which ESPN swaps for a "live" one while the game is on.
  // A live football game's down and distance; other sports' situations (balls and strikes) are not read.
  const situation = state === 'in' ? str(obj(comp.situation)?.downDistanceText) : null;
  const links = arr(e.links).map(obj);
  const link =
    links.find((l) => arr(l?.rel).includes('summary')) ?? links.find((l) => arr(l?.rel).includes('live') && arr(l?.rel).includes('event'));

  return {
    key: `${league}:${id}`,
    id,
    league,
    etDate: etDate(startMs),
    startMs,
    timeValid: comp.timeValid !== false,
    timeNote: headlines.find((h) => TIME_NOTE.test(h)) ?? null,
    state,
    phase,
    detail: str(type?.detail) ?? '',
    shortDetail: str(type?.shortDetail) ?? '',
    period: num(status?.period) ?? 0,
    displayClock: str(status?.displayClock) ?? '',
    seasonType: seasonType ?? 2,
    week: num(obj(e.week)?.number),
    home,
    away,
    neutralSite: comp.neutralSite === true,
    venue: str(obj(comp.venue)?.fullName),
    note: headlines.find((h) => !TIME_NOTE.test(h)) ?? null,
    seriesSummary: str(obj(comp.series)?.summary),
    broadcasts: broadcastsOf(comp),
    gamecastUrl: httpUrl(link?.href),
    ...(situation ? { situation } : {}),
  };
}

/**
 * The games in one scoreboard response, sorted by start (ESPN orders past CFB days by rank). Anything
 * that is not a scoreboard gives an empty list rather than an error.
 */
export function normalizeScoreboard(league: League, json: unknown): Game[] {
  const games: Game[] = [];
  for (const e of arr(obj(json)?.events)) {
    const ev = obj(e);
    const game = ev ? gameOf(league, ev) : null;
    if (game) games.push(game);
  }
  return games.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
}
