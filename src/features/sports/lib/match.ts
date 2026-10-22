/**
 * Which of the user's channels carry a game. Three routes, strongest first:
 * - guide: a programme on the channel covering the game names both teams (title or description), and is
 *   not a pregame or postgame show;
 * - event: the channel's own name names both teams (providers rename per-game channels), with any time or
 *   date in the name agreeing with the game, and a name without a date meaning a game of the last 36 hours or
 *   the next 24;
 * - network: the channel is a network ESPN lists for the game. Package services (ESPN+, League Pass,
 *   Peacock, ...) never count by network alone: their channels are per-game feeds, found by the other two.
 * Pure: the hooks feed it the channel index and the guide window.
 */

import { itemKey, type Channel, type EpgProgram, type ItemKey, type SourceKind } from '@/api/types';
import { ms } from '@/features/live/lib/epgTime';
import { dateTimeFormat } from '@/lib/intl';

import type { IndexedChannel } from '../hooks/useChannelIndex';
import { ET_ZONE, TYPICAL_LENGTH_MS, gameWindow } from './espn';
import { mentionsBoth, mentionsTeam, networkAlias, networkIdForBroadcast, otherLeague, teamAt, teamKeys, textTokens } from './names';
import type { Game } from './types';

export type MatchReason = 'guide' | 'event' | 'network';

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
 * date must also be the current game (`isCurrentGame`); without it, a name with neither agrees.
 */
export function nameTimeAgrees(name: string, game: Game, now?: number): boolean {
  const s = name.normalize('NFKD').toLowerCase();
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

interface ProgrammeWords {
  title: string[];
  description: string[];
  /** Title and category: where a guide says which league a programme is. */
  label: string[];
}

interface ProgrammeText {
  start: number;
  end: number;
  /** Tokenized on first use: only programmes overlapping some game need it. */
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

/** Whether a channel is one of the game's networks, and regional; undefined when it is none of them. */
function networkMatch(ch: IndexedChannel, networks: Map<string, boolean>, locals: readonly string[][]): boolean | undefined {
  if (ch.network !== null) {
    const regional = networks.get(ch.network);
    if (regional !== undefined) return regional;
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
}

const indexMetas = new WeakMap<readonly IndexedChannel[], IndexMeta>();

/** Item keys and the sources' order, worked out once per index rather than once per game. */
function indexMeta(index: readonly IndexedChannel[]): IndexMeta {
  let meta = indexMetas.get(index);
  if (!meta) {
    const sourceRank = new Map<string, number>();
    for (const ch of index) if (!sourceRank.has(ch.sourceId)) sourceRank.set(ch.sourceId, sourceRank.size);
    meta = { keys: index.map((ch) => itemKey(ch.channel.ref)), sourceRank };
    indexMetas.set(index, meta);
  }
  return meta;
}

const REASON_RANK: Record<MatchReason, number> = { guide: 0, event: 1, network: 2 };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The channels that carry `game`, one entry per channel with its strongest route (a guide match on a
 * network channel is a guide match and not regional). Ordered by route, then non-regional first, then feeds
 * from abroad last, then the sources' order, then channel name. `now` is read only by `isCurrentGame` (for
 * event names without a date), so a result stays good for as long as that answer does.
 */
export function matchGame(
  game: Game,
  index: readonly IndexedChannel[],
  programs: ReadonlyMap<ItemKey, EpgProgram[]>,
  now?: number,
): StreamMatch[] {
  const window = gameWindow(game);
  const networks = gameNetworks(game);
  const locals = [...networks.keys()].flatMap((id) => (networkAlias(id)?.kind === 'local' ? networkAlias(id)!.phrases : []));
  const meta = indexMeta(index);
  const found = new Map<ItemKey, { match: StreamMatch; rank: number; foreign: boolean }>();
  index.forEach((ch, i) => {
    const key = meta.keys[i]!;
    const list = programs.get(key);
    const program = list ? guideProgramme(list, game, window) : null;
    let reason: MatchReason;
    let regional = false;
    if (program) reason = 'guide';
    else if (isEventChannel(ch, game, now)) reason = 'event';
    else {
      const r = networkMatch(ch, networks, locals);
      if (r === undefined) return;
      reason = 'network';
      regional = r;
    }
    const rank = REASON_RANK[reason] * 2 + Number(regional);
    const prev = found.get(key);
    if (prev && prev.rank <= rank) return;
    const { channel, sourceId, sourceKind, sourceName } = ch;
    found.set(key, { match: { channel, sourceId, sourceKind, sourceName, reason, regional, program }, rank, foreign: ch.foreign });
  });
  return [...found.values()]
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(a.foreign) - Number(b.foreign) ||
        (meta.sourceRank.get(a.match.sourceId) ?? 0) - (meta.sourceRank.get(b.match.sourceId) ?? 0) ||
        collator.compare(a.match.channel.name, b.match.channel.name),
    )
    .map((f) => f.match);
}
