/**
 * Which of the user's channels carry a game. Four routes, strongest first:
 * - guide: a programme on the channel covering the game names both teams (title or description), and is
 *   not a pregame or postgame show;
 * - event: the channel's own name names both teams (providers rename per-game channels), with any time or
 *   date in the name agreeing with the game, and a name without a date meaning a game of the last 36 hours or
 *   the next 24;
 * - team: the channel's name is one team's and nothing else ("NBA: BOSTON CELTICS"), a feed of that team's games;
 * - network: the channel is a network ESPN lists for the game. Package services (ESPN+, League Pass,
 *   Peacock, ...) never count by network alone: their channels are per-game feeds, found by the other routes.
 * Pure: the hooks feed it the channel index and the guide window. A game is checked only against the
 * channels that can match it, found in a map of words, networks and team names built once per index and guide.
 */

import { itemKey, type Channel, type EpgProgram, type ItemKey, type SourceKind } from '@/api/types';
import { ms } from '@/features/live/lib/epgTime';
import { dateTimeFormat } from '@/lib/intl';

import type { IndexedChannel } from '../hooks/useChannelIndex';
import { ET_ZONE, TYPICAL_LENGTH_MS, gameWindow } from './espn';
import {
  hasLeagueWord,
  mentionsBoth,
  mentionsTeam,
  networkAlias,
  networkIdForBroadcast,
  otherLeague,
  teamAt,
  teamFirstWords,
  teamKeys,
  teamMarkets,
  textTokens,
} from './names';
import type { Game } from './types';

export type MatchReason = 'guide' | 'event' | 'team' | 'network';

export interface StreamMatch {
  channel: Channel;
  sourceId: string;
  sourceKind: SourceKind;
  sourceName: string;
  reason: MatchReason;
  /** A network match that may carry another regional game (NFL Sunday CBS/FOX, regional networks, local stations). */
  regional: boolean;
  /** The matched guide programme, in display time. */
  program: EpgProgram | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How far a time in a channel name may sit from the start. */
const NAME_TIME_SLACK = 3 * HOUR;

// ---------------------------------------------------------------------------
// Times and dates in channel names

const ZONES = new Map([
  ...['et', 'est', 'edt'].map((z) => [z, ET_ZONE] as const),
  ...['ct', 'cst', 'cdt'].map((z) => [z, 'America/Chicago'] as const),
  ...['mt', 'mst', 'mdt'].map((z) => [z, 'America/Denver'] as const),
  ...['pt', 'pst', 'pdt'].map((z) => [z, 'America/Los_Angeles'] as const),
  ...['uk', 'bst'].map((z) => [z, 'Europe/London'] as const),
  ...['gmt', 'utc'].map((z) => [z, 'UTC'] as const),
  ...['cet', 'cest'].map((z) => [z, 'Europe/Paris'] as const),
]);

/**
 * "7:30PM", "4:25p", "19:05", "7 pm", "19h30"; a bare number ("NBA 05") is a slot, not a time. A lone "a" or
 * "p" counts only right after the digits, so "7:00 PT" and "05 A's" are no am/pm.
 */
const TIME_RE = /(?<![\d:/.-])(\d{1,2})(?:[:h](\d{2}))?(?!\d)(?:\s*([ap])\.?\s?m\.?(?![a-z])|([ap])(?![a-z]))?/g;
const ZONE_RE = /\s*\(?\s*([a-z]{2,4})(?![a-z])/y;
const ISO_DATE_RE = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/;
const NUM_DATE_RE = /(?<![\d:/.-])(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?(?![\d:/.-])(?!\s?[ap]\.?m)/;
const MONTH =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
/** "Oct 22"; not the hour of a time after the month ("22 Oct 20:15" is October 22, not 20). */
const MONTH_DAY_RE = new RegExp(
  `(?<![a-z])${MONTH}\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?!\\s*[:.h]\\d)(?!\\s*[ap]\\.?m)(?![ap](?![a-z]))`,
);
const DAY_MONTH_RE = new RegExp(`(?<![\\d:.])(\\d{1,2})(?:st|nd|rd|th)?\\s*${MONTH}(?![a-z])`);
/** "start:2026-10-25 01:00:00": a guide-style start some providers put in event channel names, in UTC. */
const START_STAMP_RE = /(?<![a-z])start:\s*(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

interface NameTime {
  /** One reading, or two for a 12-hour time without am/pm ("7:00 ET" is 7:00 or 19:00). */
  hours: number[];
  minute: number;
  zone: string;
}

interface NameDate {
  month: number;
  day: number;
  year?: number;
}

function readTime(s: string): NameTime | null {
  for (const m of s.matchAll(TIME_RE)) {
    const minutes = m[2];
    const ampm = m[3] ?? m[4];
    if (minutes === undefined && ampm === undefined) continue;
    const hour = Number(m[1]);
    const minute = minutes === undefined ? 0 : Number(minutes);
    if (minute > 59) continue;
    let hours: number[];
    if (ampm) {
      if (hour < 1 || hour > 12) continue;
      hours = [(hour % 12) + (ampm === 'p' ? 12 : 0)];
    } else if (hour > 23) continue;
    // US names often leave am/pm out ("Bills @ Raiders 4:25 ET"): an hour of 1 to 12 may be either half of the day.
    else hours = hour >= 1 && hour <= 12 ? [hour % 12, (hour % 12) + 12] : [hour];
    ZONE_RE.lastIndex = m.index + m[0].length;
    const zone = ZONES.get(ZONE_RE.exec(s)?.[1] ?? '');
    return { hours, minute, zone: zone ?? ET_ZONE };
  }
  return null;
}

const validDay = (month: number, day: number) => month >= 1 && month <= 12 && day >= 1 && day <= 31;

/** The dates a name may mean: "10/22" is October 22, "22/10" too; "5/6" could be either. */
function readDates(s: string): NameDate[] {
  const iso = ISO_DATE_RE.exec(s);
  if (iso) return [{ year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }];
  const named = MONTH_DAY_RE.exec(s);
  if (named) return [{ month: MONTHS.indexOf(named[1]!.slice(0, 3)) + 1, day: Number(named[2]) }];
  const named2 = DAY_MONTH_RE.exec(s);
  if (named2) return [{ month: MONTHS.indexOf(named2[2]!.slice(0, 3)) + 1, day: Number(named2[1]) }];
  const num = NUM_DATE_RE.exec(s);
  if (!num) return [];
  const a = Number(num[1]);
  const b = Number(num[2]);
  const y = num[3] === undefined ? undefined : Number(num[3]) + (num[3].length === 2 ? 2000 : 0);
  const out: NameDate[] = [];
  if (validDay(a, b)) out.push({ month: a, day: b, year: y });
  if (a !== b && validDay(b, a)) out.push({ month: b, day: a, year: y });
  return out;
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const WALL_OPTS = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' } as const;

/** Wall-clock fields of `t` in `zone`. */
function wallIn(zone: string, t: number): Wall {
  const p: Record<string, number> = {};
  for (const part of dateTimeFormat('en-US', { ...WALL_OPTS, timeZone: zone }).formatToParts(t)) p[part.type] = Number(part.value);
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute! };
}

/** How long before `now` a game may have started, and how far after `now` it may start, for a name without a date. */
const CURRENT_SINCE = 36 * HOUR;
const CURRENT_AHEAD = 24 * HOUR;

/**
 * True for a game a channel name without a date can mean: it is live, started within the last 36 hours or
 * starts within the next 24. Providers name event channels for the current slate and keep last night's up
 * with its archive the next day (a League Pass final's only replay on the Yesterday tab). The same two teams
 * often meet again the next day (an MLB series, an NBA home-and-home), so an undated "Rays @ Brewers" is not
 * every game of the series, though last night's and tonight's games can both match it.
 */
export function isCurrentGame(game: Game, now: number): boolean {
  if (game.state === 'in') return true;
  return game.startMs >= now - CURRENT_SINCE && game.startMs <= now + CURRENT_AHEAD;
}

/**
 * True unless a time or date in a channel name contradicts the game: a date must be the game's Eastern day,
 * and a time (read in the zone the name gives, Eastern when none) must be within 3 hours of the start.
 * Times are not checked for games whose start is still TBD or a flex window. With `now`, a name without a
 * date must also be the current game (`isCurrentGame`); without it, a name with neither agrees. A `start:`
 * stamp is read on its own (`stampAgrees`).
 */
export function nameTimeAgrees(name: string, game: Game, now?: number): boolean {
  const s = name.normalize('NFKD').toLowerCase();
  const stamp = START_STAMP_RE.exec(s);
  if (stamp) return stampAgrees(stamp, game);
  const dates = readDates(s);
  if (dates.length === 0 && now !== undefined && !isCurrentGame(game, now)) return false;
  const time = game.timeValid && !game.timeNote ? readTime(s) : null;
  if (!time) {
    if (dates.length === 0) return true;
    const g = wallIn(ET_ZONE, game.startMs);
    return dates.some((d) => d.month === g.month && d.day === g.day && (d.year === undefined || d.year === g.year));
  }
  const g = wallIn(time.zone, game.startMs);
  const gameWall = Date.UTC(g.year, g.month - 1, g.day, g.hour, g.minute);
  // No date: the time on the day before, of, or after the start, whichever is nearest.
  const days: NameDate[] = dates.length > 0 ? dates : [-1, 0, 1].map((n) => ({ month: g.month, day: g.day + n }));
  for (const d of days) {
    for (const year of d.year === undefined ? [g.year - 1, g.year, g.year + 1] : [d.year]) {
      for (const hour of time.hours) {
        if (Math.abs(Date.UTC(year, d.month - 1, d.day, hour, time.minute) - gameWall) <= NAME_TIME_SLACK) return true;
      }
    }
  }
  return false;
}

/**
 * A `start:` stamp names an instant in UTC ("MLB 01 | Rays x Brewers start:2026-10-25 01:00:00" is a 9 PM ET
 * game on the 24th), not a time in Eastern: it must be within 3 hours of the start, or on the game's Eastern
 * day while the start is TBD or a flex window.
 */
function stampAgrees(m: RegExpExecArray, game: Game): boolean {
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (game.timeValid && !game.timeNote) return Math.abs(at - game.startMs) <= NAME_TIME_SLACK;
  const a = wallIn(ET_ZONE, at);
  const g = wallIn(ET_ZONE, game.startMs);
  return a.year === g.year && a.month === g.month && a.day === g.day;
}

/**
 * False when the name puts the home team first with "@" or "at" between ("Celtics @ Knicks" is the Knicks'
 * home game). "vs" and "x" go either way, and so does a neutral site.
 */
function directionAgrees(tokens: readonly string[], game: Game): boolean {
  if (game.neutralSite) return true;
  const home = teamAt(tokens, teamKeys(game.home, game.league));
  const away = teamAt(tokens, teamKeys(game.away, game.league));
  if (home < 0 || away < 0 || home >= away) return true;
  for (let i = home + 1; i < away; i++) if (tokens[i] === 'at') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Routes

/**
 * An event channel of this game: its name names both teams, away before home when it says "@", no other
 * league, and no other time or day (see `nameTimeAgrees`, which `now` is passed to).
 */
export function isEventChannel(channel: Pick<IndexedChannel, 'channel' | 'tokens'>, game: Game, now?: number): boolean {
  const name = channel.channel.name;
  return (
    mentionsBoth(channel.tokens, game) &&
    !otherLeague(textTokens(name), game.league) &&
    directionAgrees(channel.tokens, game) &&
    nameTimeAgrees(name, game, now)
  );
}

/**
 * A team channel of this game: its name is one of the teams' and nothing else (`IndexedChannel.teamName`),
 * either a full name ("NBA: BOSTON CELTICS", "US: MLB ST. LOUIS CARDINALS") or a pro nickname beside the
 * league's own word ("NBA: CELTICS"), and no other league ("MLB: ST. LOUIS CARDINALS" is not the NFL's
 * Cardinals, and "CARDINALS" alone is no one's). It carries that team's games, whoever they play.
 */
export function isTeamChannel(channel: Pick<IndexedChannel, 'channel' | 'teamName'>, game: Game): boolean {
  const name = channel.teamName;
  if (name === null) return false;
  let full = false;
  let nickname = false;
  for (const team of [game.home, game.away]) {
    const keys = teamKeys(team, game.league);
    full ||= keys.channelNames.includes(name);
    nickname ||= keys.channelNicknames.includes(name);
  }
  if (!full && !nickname) return false;
  const all = textTokens(channel.channel.name);
  return !otherLeague(all, game.league) && (full || hasLeagueWord(all, game.league));
}

interface ProgrammeWords {
  title: string[];
  description: string[];
  /** Title and category: where a guide says which league a programme is. */
  label: string[];
}

interface ProgrammeText {
  start: number;
  end: number;
  /** Tokenized once, for every programme of the index, by the candidate map (`prepareMatch`); `guideProgramme` reuses it. */
  words?: ProgrammeWords;
}

const programmeTexts = new WeakMap<EpgProgram, ProgrammeText>();

function programmeText(p: EpgProgram): ProgrammeText {
  let t = programmeTexts.get(p);
  if (!t) {
    t = { start: ms(p.start), end: ms(p.end) };
    programmeTexts.set(p, t);
  }
  return t;
}

function programmeWords(p: EpgProgram, t: ProgrammeText): ProgrammeWords {
  if (!t.words) {
    const title = textTokens(p.title);
    const description = p.description ? textTokens(p.description) : [];
    t.words = { title, description, label: p.category ? [...title, ...textTokens(p.category)] : title };
  }
  return t.words;
}

/** Abbreviations count in titles ("NBA: BOS @ NYK"), not in descriptions, whose prose is full of short words. */
function programmeNames(t: ProgrammeWords, game: Game): boolean {
  for (const team of [game.home, game.away]) {
    const keys = teamKeys(team, game.league);
    if (!mentionsTeam(t.title, keys) && !mentionsTeam(t.description, keys, { abbrs: false })) return false;
  }
  return !otherLeague(t.label, game.league);
}

/** Title words of the shows around a game, which name both teams too ("Celtics Pregame Live", "Game Recap"). */
const SHOW_WORDS = new Set(['pregame', 'postgame', 'preview', 'recap', 'highlights', 'countdown', 'classics']);

function isShow(title: readonly string[]): boolean {
  for (let i = 0; i < title.length; i++) {
    const w = title[i]!;
    if (SHOW_WORDS.has(w) || ((w === 'pre' || w === 'post') && title[i + 1] === 'game')) return true;
  }
  return false;
}

/** The least a programme must overlap a timed game: this long, or half the programme when it is shorter. */
const MIN_GUIDE_OVERLAP = 30 * MINUTE;

/**
 * The programme of `list` that is this game: it names both teams, is not a pregame or postgame show, and
 * covers the game itself (for a timed game, at least 30 minutes or half the programme of [start, start +
 * typical length], so a show that only touches the window does not count); the most overlap wins.
 */
function guideProgramme(list: readonly EpgProgram[], game: Game, window: { from: number; to: number }): EpgProgram | null {
  const timed = game.timeValid && !game.timeNote;
  const core = timed ? { from: game.startMs, to: game.startMs + TYPICAL_LENGTH_MS[game.league] } : window;
  let best: EpgProgram | null = null;
  let bestOverlap = -Infinity;
  for (const p of list) {
    const t = programmeText(p);
    if (!(t.start < window.to && t.end > window.from)) continue;
    const overlap = Math.min(t.end, core.to) - Math.max(t.start, core.from);
    if (timed && overlap < Math.min(MIN_GUIDE_OVERLAP, (t.end - t.start) / 2)) continue;
    const words = programmeWords(p, t);
    if (isShow(words.title) || !programmeNames(words, game)) continue;
    if (overlap > bestOverlap) {
      best = p;
      bestOverlap = overlap;
    }
  }
  return best;
}

const REGIONAL_NFL = new Set(['cbs', 'fox']);

/** True for a Sunday date ('YYYY-MM-DD'). */
function isSunday(day: string): boolean {
  return new Date(`${day}T12:00:00Z`).getUTCDay() === 0;
}

/**
 * The game's networks that count for a network match, each with whether it is regional: a regional sports
 * network or local station, a home or away market listing, or an NFL regular-season Sunday game on CBS or
 * FOX only (ESPN lists those as national, but each market gets its own game).
 */
function gameNetworks(game: Game): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const b of game.broadcasts) {
    const id = networkIdForBroadcast(b.name);
    const alias = id ? networkAlias(id) : undefined;
    if (!id || !alias || alias.kind === 'package') continue;
    const regional = alias.kind === 'rsn' || alias.kind === 'local' || b.market !== 'national';
    out.set(id, (out.get(id) ?? true) && regional);
  }
  const sundayWindow = game.league === 'nfl' && game.seasonType === 2 && isSunday(game.etDate);
  if (sundayWindow && out.size > 0 && [...out.keys()].every((id) => REGIONAL_NFL.has(id))) {
    for (const id of out.keys()) out.set(id, true);
  }
  return out;
}

/** Stations outside the teams' markets that a national game lists when the network has no feed of its own. */
const SPARE_STATIONS = 3;

/**
 * Whether a channel is one of the game's networks, and regional; undefined when it is none of them. A local
 * station of a broadcast network (`IndexedChannel.affiliate`) counts in one of the teams' markets, where it
 * carries the game whatever else the network shows. Elsewhere it may show another game (a regional window)
 * or the same one as the network's own feed, so it counts only for a national game on an index that has no
 * feed of the network's own, as a 'spare': a big provider's network group lists a station for nearly every
 * market, and the first few of them are as good as all.
 */
function networkMatch(
  ch: IndexedChannel,
  networks: Map<string, boolean>,
  locals: readonly string[][],
  markets: readonly string[][],
  ownFeeds: ReadonlySet<string>,
): boolean | 'spare' | undefined {
  if (ch.network !== null) {
    const regional = networks.get(ch.network);
    const market = ch.affiliate;
    if (regional !== undefined && (!market || market.length === 0)) return regional;
    if (regional !== undefined && market) {
      if (markets.some((p) => hasRun(market, p))) return false;
      if (!regional && !ownFeeds.has(ch.network)) return 'spare';
    }
  }
  // A local station is recognised by its call sign anywhere ("FOX 5 Washington (WTTG)" is a FOX channel too).
  return locals.some((p) => hasRun(ch.tokens, p)) ? true : undefined;
}

function hasRun(tokens: readonly string[], phrase: readonly string[]): boolean {
  outer: for (let i = 0; i + phrase.length <= tokens.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (tokens[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

interface IndexMeta {
  keys: ItemKey[];
  sourceRank: Map<string, number>;
  /** Broadcast networks with a feed of their own in the index, not only local stations. */
  ownFeeds: Set<string>;
}

const indexMetas = new WeakMap<readonly IndexedChannel[], IndexMeta>();

/** Item keys and the sources' order, worked out once per index rather than once per game. */
function indexMeta(index: readonly IndexedChannel[]): IndexMeta {
  let meta = indexMetas.get(index);
  if (!meta) {
    const sourceRank = new Map<string, number>();
    const ownFeeds = new Set<string>();
    for (const ch of index) {
      if (!sourceRank.has(ch.sourceId)) sourceRank.set(ch.sourceId, sourceRank.size);
      if (ch.network !== null && ch.affiliate?.length === 0) ownFeeds.add(ch.network);
    }
    meta = { keys: index.map((ch) => itemKey(ch.channel.ref)), sourceRank, ownFeeds };
    indexMetas.set(index, meta);
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Candidates

/**
 * Where words, networks and teams sit in an index: the positions, ascending, of the channels whose name or
 * guide programmes (titles and descriptions) hold each word, of the channels of each network, and of the
 * channels by the team name a team channel's name would be (`IndexedChannel.teamName`).
 */
interface Candidates {
  byWord: Map<string, number[]>;
  byNetwork: Map<string, number[]>;
  byTeamName: Map<string, number[]>;
}

const NO_POSITIONS: readonly number[] = [];
const candidateMaps = new WeakMap<readonly IndexedChannel[], WeakMap<ReadonlyMap<ItemKey, EpgProgram[]>, Candidates>>();

function addPosition(map: Map<string, number[]>, key: string, i: number): void {
  const list = map.get(key);
  if (!list) map.set(key, [i]);
  else if (list[list.length - 1] !== i) list.push(i);
}

/** Adds the channels at [from, to) of the index. Their programmes are tokenized here, and matching reuses that. */
function addChannels(
  c: Candidates,
  index: readonly IndexedChannel[],
  programs: ReadonlyMap<ItemKey, EpgProgram[]>,
  keys: readonly ItemKey[],
  from: number,
  to: number,
): void {
  for (let i = from; i < to; i++) {
    const ch = index[i]!;
    for (const w of ch.tokens) addPosition(c.byWord, w, i);
    if (ch.network !== null) addPosition(c.byNetwork, ch.network, i);
    if (ch.teamName !== null) addPosition(c.byTeamName, ch.teamName, i);
    for (const p of programs.get(keys[i]!) ?? []) {
      const words = programmeWords(p, programmeText(p));
      for (const w of words.title) addPosition(c.byWord, w, i);
      for (const w of words.description) addPosition(c.byWord, w, i);
    }
  }
}

function storeCandidates(index: readonly IndexedChannel[], programs: ReadonlyMap<ItemKey, EpgProgram[]>, c: Candidates): void {
  let byPrograms = candidateMaps.get(index);
  if (!byPrograms) {
    byPrograms = new WeakMap();
    candidateMaps.set(index, byPrograms);
  }
  byPrograms.set(programs, c);
}

/** The candidate map of `index` and `programs`, built here at once unless `prepareMatch` built it already. */
function candidatesOf(index: readonly IndexedChannel[], programs: ReadonlyMap<ItemKey, EpgProgram[]>): Candidates {
  let c = candidateMaps.get(index)?.get(programs);
  if (!c) {
    c = { byWord: new Map(), byNetwork: new Map(), byTeamName: new Map() };
    addChannels(c, index, programs, indexMeta(index).keys, 0, index.length);
    storeCandidates(index, programs, c);
  }
  return c;
}

/** Channels `prepareMatch` adds between two yields to the page. */
export const PREPARE_SLICE = 250;

/** Hands the main thread back to the page (input, paint, timers) between two slices. */
function yieldToPage(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return scheduler?.yield ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Builds what `matchGame` needs for `index` and `programs` ahead, {@link PREPARE_SLICE} channels at a time
 * with a yield to the page between slices: tokenizing the guide text of a big index (8,000 channels with 12
 * programmes each) takes about a second, which in one go would freeze the window. Resolves false when
 * `signal` aborted first.
 */
export async function prepareMatch(
  index: readonly IndexedChannel[],
  programs: ReadonlyMap<ItemKey, EpgProgram[]>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (candidateMaps.get(index)?.get(programs)) return !signal?.aborted;
  const c: Candidates = { byWord: new Map(), byNetwork: new Map(), byTeamName: new Map() };
  const { keys } = indexMeta(index);
  for (let from = 0; from < index.length; from += PREPARE_SLICE) {
    if (from > 0) await yieldToPage();
    if (signal?.aborted) return false;
    addChannels(c, index, programs, keys, from, Math.min(from + PREPARE_SLICE, index.length));
  }
  storeCandidates(index, programs, c);
  return true;
}

/** A game's window and the networks that count for it, worked out once per match. */
interface GameRoutes {
  window: { from: number; to: number };
  networks: Map<string, boolean>;
  locals: string[][];
  /** The teams' markets, for broadcast network stations (`networkMatch`). */
  markets: string[][];
}

function routesOf(game: Game): GameRoutes {
  const networks = gameNetworks(game);
  const locals = [...networks.keys()].flatMap((id) => (networkAlias(id)?.kind === 'local' ? networkAlias(id)!.phrases : []));
  return { window: gameWindow(game), networks, locals, markets: [...teamMarkets(game.home), ...teamMarkets(game.away)] };
}

const HOME = 1;
const BOTH = 3;

/**
 * Positions, ascending, of the channels that can match `game`: those whose name or guide text holds a first
 * word of each team, those whose name is a team channel's of either team, those of the game's networks, and
 * those holding the first word of a local station's call sign. Every other channel fails all four routes:
 * guide and event matches need both teams named, which `mentionsTeam` only finds where a first word is, a team
 * match needs the channel's team name to be one of the teams' names, and a network match needs one of the
 * networks or a call sign in the name.
 */
function candidatePositions(c: Candidates, size: number, game: Game, routes: GameRoutes): number[] {
  const mark = new Uint8Array(size);
  for (const w of teamFirstWords(teamKeys(game.home, game.league))) for (const i of c.byWord.get(w) ?? NO_POSITIONS) mark[i] = HOME;
  for (const w of teamFirstWords(teamKeys(game.away, game.league))) {
    for (const i of c.byWord.get(w) ?? NO_POSITIONS) if (mark[i] === HOME) mark[i] = BOTH;
  }
  for (const team of [game.home, game.away]) {
    const keys = teamKeys(team, game.league);
    for (const name of [...keys.channelNames, ...keys.channelNicknames]) {
      for (const i of c.byTeamName.get(name) ?? NO_POSITIONS) mark[i] = BOTH;
    }
  }
  for (const id of routes.networks.keys()) for (const i of c.byNetwork.get(id) ?? NO_POSITIONS) mark[i] = BOTH;
  for (const p of routes.locals) for (const i of c.byWord.get(p[0]!) ?? NO_POSITIONS) mark[i] = BOTH;
  const out: number[] = [];
  for (let i = 0; i < size; i++) if (mark[i] === BOTH) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------
// Matching

const REASON_RANK: Record<MatchReason, number> = { guide: 0, event: 1, team: 2, network: 3 };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The channels that carry `game`, one entry per channel with its strongest route (a guide match on a
 * network channel is a guide match and not regional). Ordered by route, then non-regional first, then feeds
 * from abroad last, then backup feeds and SD copies after the main feeds, then the sources' order, then
 * channel name. `now` is read only by `isCurrentGame` (for event names without a date), so a result stays
 * good for as long as that answer does. Only the channels that can match are checked (`candidatePositions`),
 * from a map built once per index and programmes (`prepareMatch` builds it ahead, in slices).
 */
export function matchGame(
  game: Game,
  index: readonly IndexedChannel[],
  programs: ReadonlyMap<ItemKey, EpgProgram[]>,
  now?: number,
): StreamMatch[] {
  const routes = routesOf(game);
  return matchAt(game, routes, index, programs, now, candidatePositions(candidatesOf(index, programs), index.length, game, routes));
}

/** `matchGame` over every channel, without the candidate filter: what the filter must always agree with. */
export function matchGameScanForTests(
  game: Game,
  index: readonly IndexedChannel[],
  programs: ReadonlyMap<ItemKey, EpgProgram[]>,
  now?: number,
): StreamMatch[] {
  return matchAt(game, routesOf(game), index, programs, now, index.keys());
}

function matchAt(
  game: Game,
  { window, networks, locals, markets }: GameRoutes,
  index: readonly IndexedChannel[],
  programs: ReadonlyMap<ItemKey, EpgProgram[]>,
  now: number | undefined,
  positions: Iterable<number>,
): StreamMatch[] {
  const meta = indexMeta(index);
  const found = new Map<ItemKey, { match: StreamMatch; rank: number; foreign: boolean; backup: boolean }>();
  // Spare stations taken per network, in index order, which the candidate map and a full scan share.
  const spares = new Map<string, number>();
  for (const i of positions) {
    const ch = index[i]!;
    const key = meta.keys[i]!;
    const list = programs.get(key);
    const program = list ? guideProgramme(list, game, window) : null;
    let reason: MatchReason;
    let regional = false;
    if (program) reason = 'guide';
    else if (isEventChannel(ch, game, now)) reason = 'event';
    else if (isTeamChannel(ch, game)) reason = 'team';
    else {
      const r = networkMatch(ch, networks, locals, markets, meta.ownFeeds);
      if (r === undefined) continue;
      if (r === 'spare') {
        const taken = spares.get(ch.network!) ?? 0;
        if (taken >= SPARE_STATIONS) continue;
        spares.set(ch.network!, taken + 1);
      }
      reason = 'network';
      regional = r === true;
    }
    const rank = REASON_RANK[reason] * 2 + Number(regional);
    const prev = found.get(key);
    if (prev && prev.rank <= rank) continue;
    const { channel, sourceId, sourceKind, sourceName } = ch;
    const match = { channel, sourceId, sourceKind, sourceName, reason, regional, program };
    found.set(key, { match, rank, foreign: ch.foreign, backup: ch.backup });
  }
  return [...found.values()]
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(a.foreign) - Number(b.foreign) ||
        Number(a.backup) - Number(b.backup) ||
        (meta.sourceRank.get(a.match.sourceId) ?? 0) - (meta.sourceRank.get(b.match.sourceId) ?? 0) ||
        collator.compare(a.match.channel.name, b.match.channel.name),
    )
    .map((f) => f.match);
}
