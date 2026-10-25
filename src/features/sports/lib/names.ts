/**
 * Names on both sides of a match: ESPN's teams and broadcasters, and the user's channel names and guide
 * text. Everything is compared as tokens (`textTokens`): folded, lower case, split at anything that is not
 * a letter or digit, with quality, codec and backup markers dropped, so "US| ESPN ᴴᴰ" reads as "espn".
 * Matches are whole tokens, never substrings: "ESPN" is not "ESPNews", "BOS" is not "BOSS".
 */

import { stripCountryPrefix } from '@/features/live/lib/channelName';

import type { Game, GameTeam, League } from './types';

// ---------------------------------------------------------------------------
// Tokens

/**
 * Quality, codec and frame-rate markers (the core's matcher drops the same, live/matcher.rs), except "HQ",
 * which is part of channel names here ("CBS Sports HQ").
 */
const NOISE = new Set([
  'lq', '480p', '576p', '576i', '480i', 'hd', '720p', '720', 'fhd', 'fullhd', '1080p', '1080i', '1080',
  'uhd', '4k', '8k', '2160p', '4320p', 'uhd4k', 'ʜᴅ', 'ꜰʜᴅ', 'ᴜʜᴅ', 'hevc', 'h265', 'h264', 'x264', 'x265',
  'avc', 'hdr', 'sdr', 'fps', '25fps', '30fps', '50fps', '60fps', 'raw',
]);
const BACKUP = /^(?:backup|bkp|bk|alt|reserve|mirror)\d*$/;
const APOSTROPHES = /['’‘ʻʼ`´]/g;
/** "A&M" and "A & M" are one word, so a school reads the same however the provider spaces it. */
const LETTER_AMP = /(?<![\p{L}\p{N}])(\p{L})\s*&\s*(\p{L})(?![\p{L}\p{N}])/gu;
/** A spaced dash between two names ("Boise State - San José State") or before a feed's region ("ESPN - East"). */
const SPACED_DASH = /\s[-–—]\s/;
/** The token a spaced dash reads as; no word is one, since words are letters and digits. */
const DASH = '-';

/**
 * The words of any text: NFKD-folded (accents, superscript "ᴴᴰ", full-width letters), lower case, split at
 * anything that is not a letter or digit, as the core's search splits. Apostrophes join ("Hawai'i" is
 * "hawaii"), `+` is the word "plus" ("ESPN+" and "ESPN Plus" read alike), `@` is "at", a spaced dash is the
 * token "-" (team keys need to see where one name ends), and quality, codec and backup markers are dropped.
 * "SD" goes only at the end, since it is also San Diego's abbreviation.
 */
export function textTokens(text: string): string[] {
  const parts = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(LETTER_AMP, '$1$2')
    .split(SPACED_DASH);
  const words: string[] = [];
  let afterBackup = false;
  parts.forEach((part, i) => {
    if (i > 0) {
      words.push(DASH);
      afterBackup = false;
    }
    for (const w of part.replace(/@/g, ' at ').replace(/\+/g, ' plus ').split(/[^\p{L}\p{N}]+/u)) {
      if (!w) continue;
      // "Backup 2" goes whole: a bare 2 left behind would make "ESPN Backup 2" read as ESPN 2.
      const skip = NOISE.has(w) || BACKUP.test(w) || (afterBackup && /^\d+$/.test(w));
      afterBackup = BACKUP.test(w);
      if (!skip) words.push(w);
    }
  });
  if (words[words.length - 1] === 'sd') words.pop();
  return words;
}

/**
 * True for a backup feed or an SD copy ("ESPN (Backup)", "ESPN BKP", "BIG TEN NETWORK ALT", "CELTICS SD"):
 * `textTokens` drops those markers, so the copy reads as the main feed, and the match lists it after.
 */
export function isBackupFeed(name: string): boolean {
  const words = name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.some((w) => BACKUP.test(w) || w === 'lq') || words[words.length - 1] === 'sd';
}

/**
 * A channel name's tag and words. `stripCountryPrefix` cuts at the first pipe whatever comes before it, so a
 * "tag" of more than two words is part of the name ("NBA 04: Hornets x Nets | 7:30PM ET"): then the whole
 * name is read and there is no tag.
 */
function splitName(name: string): { tag: string[] | null; tokens: string[] } {
  const trimmed = name.trim();
  const rest = stripCountryPrefix(trimmed);
  if (rest !== trimmed && trimmed.endsWith(rest)) {
    const tag = textTokens(trimmed.slice(0, trimmed.length - rest.length));
    if (tag.length <= 2) return { tag, tokens: textTokens(rest) };
  }
  return { tag: null, tokens: textTokens(trimmed) };
}

/** A channel name's words, after the country or group tag ("US| ", "UK: ") is cut. */
export function nameTokens(name: string): string[] {
  return splitName(name).tokens;
}

/** Words that sit between the two teams of a matchup ("@" reads as "at"). */
const MATCHUP_WORDS = new Set(['vs', 'v', 'versus', 'at', 'x']);
/** Those and a spaced dash, which also ends a team's name ("Boise State - San José State"). */
const MATCHUP = new Set([...MATCHUP_WORDS, DASH]);

function separated(tokens: readonly string[], from: number, separators: ReadonlySet<string>): boolean {
  for (let i = Math.max(from, 1); i < tokens.length - 1; i++) if (separators.has(tokens[i]!)) return true;
  return false;
}

/** True when the words hold a matchup: a separator (a spaced dash too) with a word on each side ("Knicks @ Celtics"). */
export function hasMatchup(tokens: readonly string[], from = 0): boolean {
  return separated(tokens, from, MATCHUP);
}

/** Country tags of feeds from outside North America ("BR| ", "AU: ", "LATAM | "); two-letter codes count only as a tag. */
const FOREIGN_CODES = (
  'uk gb ie fr de at ch it es pt nl be lu dk se no fi is pl cz sk hu ro bg gr tr ru ua rs hr ba si mk al il ae sa qa kw eg ' +
  'ma dz tn ar br mx co cl pe ve ec uy py cr pa do au nz in pk bd lk jp kr cn hk tw th vn ph my sg id za ng ke gh ir iq lb jo lat'
).split(' ');
/** Country words, which also count when a name or group opens with them untagged ("UK ESPN", "Brasil Esportes"). */
const FOREIGN_WORDS = new Set(
  (
    // Not "latino" or "latin": such groups hold the US Spanish-language networks (ESPN Deportes, Univision).
    'uk latam exyu afr africa arab arabic asia eu euro brasil brazil mexico argentina australia espana spain ' +
    'portugal france germany deutschland italia italy nederland netherlands holland turkey turkiye india japan'
  ).split(' '),
);
const FOREIGN_TAGS = new Set([...FOREIGN_CODES, ...FOREIGN_WORDS]);
const HOME_TAGS = new Set(['us', 'usa', 'ca', 'can', 'en', 'na', 'am']);

function region(name: string): 'home' | 'foreign' | null {
  const { tag, tokens } = splitName(name);
  for (const w of tag ?? tokens.slice(0, 1)) {
    if (HOME_TAGS.has(w)) return 'home';
    if ((tag ? FOREIGN_TAGS : FOREIGN_WORDS).has(w)) return 'foreign';
  }
  return null;
}

/**
 * True for a feed from outside North America: its name's tag says so ("BR: ESPN", "AU| FOX FOOTY"), or, when
 * the name has no country tag, its group's does ("ESPN" in "LATAM| DEPORTES"). Such a feed shares a US
 * network's name but not its programming.
 */
export function foreignFeed(name: string, groupName?: string | null): boolean {
  return (region(name) ?? (groupName ? region(groupName) : null)) === 'foreign';
}

const tokenSets = new WeakMap<readonly string[], Set<string>>();

/** The tokens as a set, kept per array: one index row is tested against every game of the day. */
function tokenSet(tokens: readonly string[]): Set<string> {
  let set = tokenSets.get(tokens);
  if (!set) {
    set = new Set(tokens);
    tokenSets.set(tokens, set);
  }
  return set;
}

/** Index of the first place `phrase` runs whole in `tokens` from `from` on, where `ok` accepts it; -1 when none. */
function findPhrase(
  tokens: readonly string[],
  phrase: readonly string[],
  ok?: (tokens: readonly string[], start: number, end: number) => boolean,
  from = 0,
): number {
  outer: for (let i = from; i + phrase.length <= tokens.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (tokens[i + j] !== phrase[j]) continue outer;
    if (!ok || ok(tokens, i, i + phrase.length)) return i;
  }
  return -1;
}

function startsWith(tokens: readonly string[], phrase: readonly string[], at: number): boolean {
  if (at + phrase.length > tokens.length) return false;
  for (let j = 0; j < phrase.length; j++) if (tokens[at + j] !== phrase[j]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Teams

export interface TeamKeys {
  /** Whole-token phrases, longest first. */
  phrases: string[][];
  /** One-token abbreviations; trusted in channel names and guide titles, not in descriptions. */
  abbrs: string[];
  /**
   * Abbreviations that are also another club's city or a common word ("LA" for the Rams, "A's"): they count
   * only before the end, a separator, a number or the team's own nickname ("LA @ KC", "LA Rams", not "LA Chargers").
   */
  guarded?: string[];
  /** The nickname's first word, for `guarded`. */
  nickname?: string;
  /** Pros: nicknames that are college mascots too, which never count after a school's word ("Pittsburgh Panthers"). */
  shared?: string[][];
  /** College: a phrase or abbreviation must not run into another school's name ("Texas" in "Texas Tech" or "North Texas"). */
  school?: boolean;
  /** College mascots, which count only on their own ("Tigers vs Bulldogs", not the "Tigers" of "Auburn Tigers"). */
  mascots?: string[][];
  /** The team's full names of two words or more, as `teamChannelName` gives a team channel's ("boston celtics", "boston celtics bos"). */
  channelNames: string[];
  /** Pros: the nickname and its spellings ("celtics", "sixers"), which make a team channel only beside the league's word. */
  channelNicknames: string[];
}

/** Provider spellings of ESPN's abbreviations, by `${league}:${ESPN abbreviation}`. */
const ABBR_ALIASES: Record<string, readonly string[]> = {
  'nba:NY': ['NYK'],
  'nba:GS': ['GSW'],
  'nba:SA': ['SAS'],
  'nba:NO': ['NOP', 'NOR'],
  'nba:UTAH': ['UTA'],
  'nba:WSH': ['WAS'],
  'nba:PHX': ['PHO'],
  'nba:BKN': ['BRK'],
  'nba:CHA': ['CHO'],
  'nfl:WSH': ['WAS'],
  'nfl:JAX': ['JAC'],
  'nfl:LAR': ['LA'],
  'nfl:LV': ['LVR', 'OAK'],
  'nfl:NE': ['NWE'],
  'nfl:NO': ['NOR'],
  'nfl:GB': ['GNB'],
  'nfl:SF': ['SFO'],
  'nfl:TB': ['TAM'],
  'nfl:KC': ['KAN'],
  'nfl:ARI': ['ARZ'],
  'mlb:CHW': ['CWS'],
  'mlb:WSH': ['WAS', 'WSN'],
  'mlb:KC': ['KCR'],
  'mlb:SD': ['SDP'],
  'mlb:SF': ['SFG'],
  'mlb:TB': ['TBR'],
  'mlb:ARI': ['AZ'],
  'mlb:ATH': ['OAK', "A's"],
  'mlb:LAD': ['LA'],
};

/** Aliases that are another club's city ("LA Chargers") or a common word ("as"): see `TeamKeys.guarded`. */
const GUARDED_ABBRS = new Set(['la', 'as']);

/** Other names providers write a team under, by `${league}:${ESPN abbreviation}`. */
const NAME_ALIASES: Record<string, readonly string[]> = {
  'nba:POR': ['Blazers'],
  'nba:PHI': ['Sixers'],
  'nba:GS': ['Golden St Warriors'],
  'nba:LAC': ['Los Angeles Clippers'],
  'nfl:SF': ['Niners'],
  'mlb:TOR': ['Jays'],
  'mlb:ARI': ['D-backs', 'Dbacks'],
  'mlb:ATH': ['Oakland Athletics'],
  'cfb:M-OH': ['Miami Ohio'],
  'cfb:APP': ['Appalachian State'],
  'cfb:UL': ['Louisiana Lafayette', 'UL Lafayette'],
  'cfb:ULM': ['Louisiana Monroe'],
  'cfb:CONN': ['Connecticut'],
  'cfb:UCF': ['Central Florida'],
  'cfb:SMU': ['Southern Methodist'],
  'cfb:TCU': ['Texas Christian'],
  'cfb:BYU': ['Brigham Young'],
  'cfb:LSU': ['Louisiana State'],
  'cfb:USM': ['Southern Mississippi'],
  'cfb:NCSU': ['North Carolina State'],
  'cfb:UTSA': ['UT San Antonio', 'Texas San Antonio'],
  'cfb:UTEP': ['Texas El Paso'],
  'cfb:MISS': ['Mississippi'],
  'cfb:KSU': ['K-State'],
  'cfb:MSST': ['Miss State'],
  'cfb:VT': ['Va Tech'],
  'cfb:LT': ['La Tech'],
  'cfb:MSU': ['Mich State'],
  'cfb:ARST': ['Ark State'],
  'cfb:OKST': ['Okla State', 'OK State'],
  'cfb:GT': ['Ga Tech'],
};

/** Pro nicknames that are also FBS mascots (Pitt and FIU Panthers, Boston College Eagles, LSU Tigers, ...). */
const SHARED_NICKNAMES = new Set([
  'panthers', 'eagles', 'cardinals', 'cowboys', 'broncos', 'bears', 'lions', 'falcons', 'rams', 'jaguars', 'raiders', '49ers',
  'bulls', 'rockets', 'warriors', 'cavaliers', 'blazers', 'tigers', 'pirates',
]);
/**
 * Words of the schools behind those mascots, which make a shared nickname theirs ("Boise State Broncos", "Texas
 * Tech Red Raiders"). A pro's own location is no problem: "Carolina Panthers" matches as a longer phrase first.
 */
const MASCOT_SCHOOL_WORDS = new Set([
  'state', 'st', 'college', 'tech', 'southern', 'golden', 'red', 'nittany', 'rainbow', 'force', 'green', 'international',
  'pittsburgh', 'pitt', 'fiu', 'michigan', 'louisville', 'wyoming', 'baylor', 'alabama', 'charlotte', 'florida', 'usf',
  'buffalo', 'toledo', 'hawaii', 'virginia', 'uab', 'lsu', 'auburn', 'memphis', 'missouri', 'mizzou', 'clemson', 'ecu', 'carolina',
]);

/** Abbreviations that are also country tags or common words, never taken as a team ("USA" is South Alabama's). */
const ABBR_STOP = new Set(['usa', 'us', 'uk', 'tv', 'am', 'pm', 'et', 'at', 'vs']);

/** Words that turn a school into another school when they follow it ("Texas" + "Tech"). */
const SCHOOL_AFTER = new Set([
  'state', 'st', 'tech', 'am', 'southern', 'christian', 'international', 'atlantic', 'oh', 'ohio', 'monroe',
  'el', 'san', 'valley', 'baptist', 'methodist', 'commerce', 'corpus', 'rio', 'arlington', 'martin', 'poly',
]);
/** Words that turn a school into another school when they come before it ("North" + "Texas"). */
const SCHOOL_BEFORE = new Set([
  'north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western', 'central', 'middle',
  'n', 's', 'e', 'w', 'c', 'ne', 'nw', 'se', 'sw', 'sam', 'ut', 'ul',
]);
/** Words a lone mascot may follow: a separator, or the league or service tag of an event channel. */
const MASCOT_CONTEXT = new Set([...MATCHUP, 'and', 'ncaa', 'ncaaf', 'cfb', 'college', 'football', 'plus']);

function schoolBounds(tokens: readonly string[], start: number, end: number): boolean {
  const before = tokens[start - 1];
  const after = tokens[end];
  return !(before !== undefined && SCHOOL_BEFORE.has(before)) && !(after !== undefined && SCHOOL_AFTER.has(after));
}

function standsAlone(tokens: readonly string[], start: number): boolean {
  const before = tokens[start - 1];
  return before === undefined || /^\d+$/.test(before) || MASCOT_CONTEXT.has(before);
}

function notSchoolMascot(tokens: readonly string[], start: number): boolean {
  const before = tokens[start - 1];
  return before === undefined || !MASCOT_SCHOOL_WORDS.has(before);
}

/** `TeamKeys.guarded`: the word after is missing, a separator, a number or the team's own nickname. */
function guardedBound(nickname: string | undefined): Bound {
  return (tokens, _start, end) => {
    const after = tokens[end];
    return after === undefined || MATCHUP.has(after) || /^\d+$/.test(after) || after === nickname;
  };
}

type Bound = (tokens: readonly string[], start: number, end: number) => boolean;

/** "Florida St" for "Florida State" and back, "Saint" for a leading "St". */
function stateVariants(phrase: string[]): string[][] {
  const swap = phrase.map((t, i) => {
    if (t === 'state') return 'st';
    if (t === 'st') return i === 0 ? 'saint' : 'state';
    return t === 'saint' && i === 0 ? 'st' : t;
  });
  return swap.some((t, i) => t !== phrase[i]) ? [phrase, swap] : [phrase];
}

function addPhrases(into: Map<string, string[]>, names: readonly string[], variants: boolean): void {
  for (const name of names) {
    const tokens = textTokens(name);
    if (tokens.length === 0) continue;
    for (const p of variants ? stateVariants(tokens) : [tokens]) into.set(p.join(' '), p);
  }
}

function buildKeys(team: GameTeam, league: League): TeamKeys {
  const abbr = team.abbreviation;
  const phrases = new Map<string, string[]>();
  const abbrs = new Set<string>();
  const guarded = new Set<string>();
  for (const a of [abbr, ...(ABBR_ALIASES[`${league}:${abbr}`] ?? [])]) {
    const tokens = textTokens(a);
    if (tokens.length === 1 && GUARDED_ABBRS.has(tokens[0]!)) guarded.add(tokens[0]!);
    else if (tokens.length === 1 && !ABBR_STOP.has(tokens[0]!)) abbrs.add(tokens[0]!);
    else if (tokens.length > 1) phrases.set(tokens.join(' '), tokens);
  }
  const aliases = NAME_ALIASES[`${league}:${abbr}`] ?? [];
  const full = new Map<string, string[]>();
  addPhrases(full, [team.displayName, `${team.location} ${team.name}`], league === 'cfb');
  // A one-word full name ("Athletics") is no surer than a nickname.
  const channelNames = [...full].filter(([, p]) => p.length > 1).map(([key]) => key);
  // The team's abbreviation may close a team channel's name ("NBA: NEW YORK KNICKS (NYK)").
  const withAbbrs = (names: string[]) => names.flatMap((n) => [n, ...[...abbrs].map((a) => `${n} ${a}`)]);
  if (league === 'cfb') {
    addPhrases(phrases, [team.displayName, team.location, team.shortDisplayName, ...aliases], true);
    const mascot = textTokens(team.name);
    return {
      phrases: longestFirst(phrases),
      abbrs: [...abbrs],
      school: true,
      mascots: mascot.length ? [mascot] : [],
      channelNames: withAbbrs(channelNames),
      // A school alone or a mascot alone names no team channel: schools share words, and many share a mascot.
      channelNicknames: [],
    };
  }
  addPhrases(phrases, [team.displayName, `${team.location} ${team.name}`, team.shortDisplayName, team.name, ...aliases], false);
  const nicknames = new Map<string, string[]>();
  addPhrases(nicknames, [team.name, team.shortDisplayName, ...aliases], false);
  const channelNicknames = [...new Set([...full.keys(), ...nicknames.keys()])].filter((key) => !channelNames.includes(key));
  const shared: string[][] = [];
  for (const [key, p] of phrases) {
    if (p.length === 1 && SHARED_NICKNAMES.has(p[0]!)) {
      shared.push(p);
      phrases.delete(key);
    }
  }
  const keys: TeamKeys = {
    phrases: longestFirst(phrases),
    abbrs: [...abbrs],
    channelNames: withAbbrs(channelNames),
    channelNicknames: withAbbrs(channelNicknames),
  };
  if (guarded.size > 0) {
    keys.guarded = [...guarded];
    keys.nickname = textTokens(team.name)[0];
  }
  if (shared.length > 0) keys.shared = shared;
  return keys;
}

function longestFirst(phrases: Map<string, string[]>): string[][] {
  return [...phrases.values()].sort((a, b) => b.length - a.length);
}

const keyCache = new WeakMap<GameTeam, Map<League, TeamKeys>>();

/**
 * What names a team in channel names and guide text. Pros: the nickname ("Celtics"), location and nickname,
 * the short name, and the abbreviation plus provider spellings (NY/NYK, GS/GSW). College: the school by its
 * location, short and display names (with St/State variants), longest first and bounded so "Texas" never
 * takes "Texas A&M", "Texas Tech" or "North Texas" and "Miami" never takes "Miami (OH)"; the mascot only on
 * its own. Also the names a team channel goes by: the full names, and for pros the nicknames. Kept per team
 * object, since one game is tested against every indexed channel.
 */
export function teamKeys(team: GameTeam, league: League): TeamKeys {
  let byLeague = keyCache.get(team);
  if (!byLeague) {
    byLeague = new Map();
    keyCache.set(team, byLeague);
  }
  let keys = byLeague.get(league);
  if (!keys) {
    keys = buildKeys(team, league);
    byLeague.set(league, keys);
  }
  return keys;
}

interface Matcher {
  phrase: readonly string[];
  bound: Bound | undefined;
  /** An abbreviation: not trusted in prose. */
  abbr: boolean;
}

const matcherCache = new WeakMap<TeamKeys, Matcher[]>();

/** Every way `keys` can name the team, each with the bounds it must keep; made once per keys object. */
function matchers(keys: TeamKeys): Matcher[] {
  let list = matcherCache.get(keys);
  if (!list) {
    const school = keys.school ? schoolBounds : undefined;
    const guard = guardedBound(keys.nickname);
    list = [
      ...keys.abbrs.map((a) => ({ phrase: [a], bound: school, abbr: true })),
      ...(keys.guarded ?? []).map((a) => ({ phrase: [a], bound: guard, abbr: true })),
      ...keys.phrases.map((p) => ({ phrase: p, bound: school, abbr: false })),
      ...(keys.shared ?? []).map((p) => ({ phrase: p, bound: notSchoolMascot, abbr: false })),
      ...(keys.mascots ?? []).map((p) => ({ phrase: p, bound: standsAlone, abbr: false })),
    ];
    matcherCache.set(keys, list);
  }
  return list;
}

/**
 * True when `tokens` name the team: an abbreviation as a whole token (unless `abbrs` is false, for prose
 * such as guide descriptions), or a phrase as a contiguous run.
 */
export function mentionsTeam(tokens: readonly string[], keys: TeamKeys, opts?: { abbrs?: boolean }): boolean {
  if (tokens.length === 0) return false;
  const present = tokenSet(tokens);
  const abbrs = opts?.abbrs !== false;
  for (const m of matchers(keys)) {
    if ((abbrs || !m.abbr) && present.has(m.phrase[0]!) && findPhrase(tokens, m.phrase, m.bound) >= 0) return true;
  }
  return false;
}

/**
 * The first word of every way `keys` names the team. Text that holds none of them never names it:
 * `mentionsTeam` and `teamAt` look for a phrase only where its first word is.
 */
export function teamFirstWords(keys: TeamKeys): string[] {
  return [...new Set(matchers(keys).map((m) => m.phrase[0]!))];
}

/** Where `tokens` first name the team (as `mentionsTeam` reads a channel name); -1 when they do not. */
export function teamAt(tokens: readonly string[], keys: TeamKeys): number {
  if (tokens.length === 0) return -1;
  const present = tokenSet(tokens);
  let first = -1;
  for (const m of matchers(keys)) {
    if (!present.has(m.phrase[0]!)) continue;
    const at = findPhrase(tokens, m.phrase, m.bound);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  return first;
}

/** Both teams of the game are named, and nothing marks the text as another league's (see `otherLeague`). */
export function mentionsBoth(tokens: readonly string[], game: Game): boolean {
  return (
    mentionsTeam(tokens, teamKeys(game.home, game.league)) &&
    mentionsTeam(tokens, teamKeys(game.away, game.league)) &&
    !otherLeague(tokens, game.league)
  );
}

/** League and sport words. A league word outranks a sport word: "NFL Football" is not college. */
const LEAGUE_WORDS = new Map<string, readonly League[]>([
  ['nfl', ['nfl']],
  ['ncaaf', ['cfb']],
  ['cfb', ['cfb']],
  ['nba', ['nba']],
  ['mlb', ['mlb']],
  ...['nhl', 'mls', 'wnba', 'ncaab', 'ncaam', 'ncaaw', 'nwsl', 'cfl', 'ufl', 'xfl', 'milb', 'epl', 'ufc', 'wwe', 'nascar'].map(
    (w) => [w, []] as [string, readonly League[]],
  ),
]);
const SPORT_WORDS = new Map<string, readonly League[]>([
  ['football', ['nfl', 'cfb']],
  ['basketball', ['nba']],
  ['baseball', ['mlb']],
  ...['hockey', 'soccer', 'softball', 'volleyball', 'lacrosse', 'rugby', 'cricket', 'golf', 'tennis', 'boxing'].map(
    (w) => [w, []] as [string, readonly League[]],
  ),
]);

function marked(tokens: readonly string[], words: Map<string, readonly League[]>, league: League): boolean | null {
  let seen = false;
  for (const t of tokens) {
    const leagues = words.get(t);
    if (!leagues) continue;
    if (leagues.includes(league)) return false;
    seen = true;
  }
  return seen ? true : null;
}

/**
 * True when the text names another league or sport and not this one ("MLB 07: Giants x Cardinals" is not
 * the NFL's Giants at Cardinals). "College" without a league word is never a pro game ("Pittsburgh Panthers
 * vs Boston College Eagles"), whatever the sport. Shared nicknames otherwise pass, since both teams must match.
 */
export function otherLeague(tokens: readonly string[], league: League): boolean {
  const mark = marked(tokens, LEAGUE_WORDS, league);
  if (mark !== null) return mark;
  if (league !== 'cfb' && tokens.includes('college')) return true;
  return marked(tokens, SPORT_WORDS, league) ?? false;
}

/** True when the text holds one of the league's own words ("NBA", "NCAAF"); a sport word is not enough. */
export function hasLeagueWord(tokens: readonly string[], league: League): boolean {
  return tokens.some((t) => LEAGUE_WORDS.get(t)?.includes(league));
}

// ---------------------------------------------------------------------------
// Networks

/**
 * linear: a 24/7 channel ESPN's broadcast name maps to. package: a service of per-game feeds (ESPN+, League
 * Pass, Peacock, ...): its channels are found by team names and the guide, never by the network alone.
 * rsn: a regional sports network. local: an over-the-air station, recognised by its call sign anywhere in
 * the name.
 */
export type NetworkKind = 'linear' | 'package' | 'rsn' | 'local';

export interface NetworkAlias {
  id: string;
  /** What `catalog.search` is asked (every word must match, as a word prefix); several aliases share one. */
  search: string;
  /** Whole-token phrases a channel name starts with (after a country tag); ESPN's own spellings included. */
  phrases: string[][];
  /** Names that start with a phrase but are another channel ("Fox News"). */
  avoid?: string[][];
  kind: NetworkKind;
}

function net(id: string, kind: NetworkKind, search: string, names: readonly string[], avoid?: readonly string[]): NetworkAlias {
  const alias: NetworkAlias = { id, search, phrases: names.map(textTokens), kind };
  if (avoid) alias.avoid = avoid.map(textTokens);
  return alias;
}

/**
 * FanDuel Sports Network regions (the former Bally Sports and Fox Sports regionals), each with the other
 * spellings and the old feeds providers still name its channel by ("FOX SPORTS SOUTH EAST", "BALLY SPORTS
 * PRIME TICKET", "BALLY SPORTS CINCINNATI", "FOX SPORTS TENNESSEE").
 */
const FDSN_REGIONS: Record<string, readonly string[]> = {
  Arizona: [], Detroit: [], Florida: [], 'Great Lakes': ['SportsTime Ohio'], Indiana: [], 'Kansas City': [], Midwest: ['Mid West'],
  'New Orleans': [], North: [], Ohio: ['Cincinnati'], Oklahoma: [], 'San Diego': [], SoCal: ['Prime Ticket'], South: ['Tennessee'],
  Southeast: ['South East'], Southwest: ['South West'], Sun: [], West: [], Wisconsin: [],
};
const FDSN_BRANDS = ['FanDuel Sports Network', 'FanDuel Sports', 'FanDuel SN', 'FDSN', 'Bally Sports', 'Fox Sports'];
/** Old names no brand above builds; "FOX SPORTSTIME OHIO" would otherwise read as FOX. */
const FDSN_OLD_NAMES: Record<string, readonly string[]> = { 'Great Lakes': ['SportsTime Ohio', 'Fox SportsTime Ohio'] };

/** Editions of a US brand abroad, with or without a country tag ("ESPN Brasil", "ESPN 2 Sur"). */
const abroad = (brands: readonly string[], editions: readonly string[]) => brands.flatMap((b) => editions.map((e) => `${b} ${e}`));
const ESPN_ABROAD = [
  'Brasil', 'Brazil', 'Sur', 'Norte', 'Caribe', 'Caribbean', 'Mexico', 'Argentina', 'Chile', 'Colombia', 'Andina', 'Africa',
  'Extra', 'Latino', 'Latin America', 'NL', 'Australia', 'Asia', 'India',
];

/**
 * ESPN's broadcasters and the channel names they go by. Seeded from the broadcast names ESPN used in a
 * 72-request sample (Oct 2026). The ESPN family needs no avoid list against itself: "ESPN 2", "ESPNews" and
 * "ESPN+" match their own longer or different phrases first. The avoid lists also hold the brands' editions
 * abroad that carry no country tag ("ESPN Brasil", "FOX Footy"); tagged feeds are `foreignFeed`'s.
 */
export const NETWORKS: readonly NetworkAlias[] = [
  net('espn', 'linear', 'ESPN', ['ESPN'], [
    'ESPN Classic', 'ESPN Bet', 'ESPN College Extra', 'ESPN Goal Line', 'ESPN Radio', ...abroad(['ESPN'], ESPN_ABROAD),
    // ESPN 3 to 7 are Dutch and South American channels (and the old ESPN3 stream), never the US network.
    'ESPN 3', 'ESPN 4', 'ESPN 5', 'ESPN 6', 'ESPN 7',
  ]),
  net('espn2', 'linear', 'ESPN', ['ESPN2', 'ESPN 2'], abroad(['ESPN2', 'ESPN 2'], ESPN_ABROAD)),
  net('espnu', 'linear', 'ESPN', ['ESPNU', 'ESPN U']),
  net('espnews', 'linear', 'ESPN', ['ESPNews', 'ESPN News']),
  net('espn-deportes', 'linear', 'ESPN', ['ESPN Deportes']),
  net('espn-plus', 'package', 'ESPN', ['ESPN+', 'ESPN Unlimited', 'ESPN Unlmtd']),
  net('abc', 'linear', 'ABC', ['ABC'], [
    'ABC News', 'ABC Kids', 'ABC Me', 'ABC Family', 'ABC Comedy', 'ABC Australia', 'ABC TV+', 'ABC Spark', 'ABC Entertains',
  ]),
  net('cbs', 'linear', 'CBS', ['CBS', 'CBS2'], ['CBS News', 'CBS Reality', 'CBS Drama', 'CBS Justice', 'CBS Europa', 'CBS Action']),
  net('cbssn', 'linear', 'CBS', ['CBS Sports Network', 'CBS Sports Net', 'CBSSN', 'CBS Sports'], ['CBS Sports HQ', 'CBS Sports Golazo']),
  // "NBC USA Network" is USA Network under its owner's name.
  net('nbc', 'linear', 'NBC', ['NBC'], ['NBC News', 'NBC Universo', 'NBC Sports', 'NBC USA']),
  net('nbcsn', 'linear', 'NBC', ['NBCSN', 'NBC Sports Network']),
  net('fox', 'linear', 'FOX', ['FOX'], [
    'FOX News', 'FOX Business', 'FOX Sports', 'FOX Soccer', 'FOX Weather', 'FOX Nation', 'FOX Life', 'FOX Crime', 'FOX Movies',
    'FOX Comedy', 'FOX Kids', 'FOX Family', 'FOX Soul',
    // Foxtel's channels in Australia.
    'FOX Footy', 'FOX Cricket', 'FOX League', 'FOX Showcase', 'FOX Classics', 'FOX Arena', 'FOX Sleuth', 'FOX Funny',
  ]),
  // FOX's streaming service; its channels are per-game feeds ("FOX One 01: Indiana vs Michigan").
  net('fox-one', 'package', 'FOX', ['FOX One']),
  net('fox-deportes', 'linear', 'FOX', ['FOX Deportes']),
  net('fs1', 'linear', 'FS1', ['FS1', 'Fox Sports 1', 'Fox Sports One']),
  net('fs2', 'linear', 'FS2', ['FS2', 'Fox Sports 2']),
  net('tnt', 'linear', 'TNT', ['TNT'], [
    'TNT Sports', 'TNT Series', 'TNT Serie', 'TNT Comedy', 'TNT Film', 'TNT Novelas', 'TNT Brasil', 'TNT Brazil', 'TNT Latino',
  ]),
  net('tbs', 'linear', 'TBS', ['TBS'], ['TBS News', 'TBS Channel']),
  net('trutv', 'linear', 'truTV', ['truTV', 'tru TV']),
  // Never bare "USA": it is the commonest country tag.
  net('usa', 'linear', 'USA Network', ['USA Network', 'USA Net']),
  net('nfl-network', 'linear', 'NFL', ['NFL Network', 'NFL Net', 'NFLN']),
  net('nfl-redzone', 'linear', 'NFL', ['NFL RedZone', 'NFL Red Zone', 'RedZone', 'Red Zone']),
  net('nfl-plus', 'package', 'NFL', ['NFL+']),
  net('nfl-sunday-ticket', 'package', 'Sunday Ticket', ['NFL Sunday Ticket', 'Sunday Ticket']),
  net('nba-tv', 'linear', 'NBA', ['NBA TV', 'NBATV']),
  net('nba-league-pass', 'package', 'League Pass', ['NBA League Pass', 'League Pass', 'NBA LP']),
  net('mlb-network', 'linear', 'MLB', ['MLB Network', 'MLB Net', 'MLBN'], ['MLB Network Strike Zone']),
  net('mlb-tv', 'package', 'MLB', ['MLB.TV', 'MLB Extra Innings', 'MLB EI']),
  net('btn', 'linear', 'Big Ten', ['Big Ten Network', 'Big Ten', 'BTN', 'B1G Network'], ['Big Ten+', 'BTN+']),
  net('sec-network', 'linear', 'SEC', ['SEC Network', 'SECN']),
  net('sec-network-plus', 'package', 'SEC', ['SEC Network+', 'SECN+', 'SEC+']),
  net('acc-network', 'linear', 'ACC', ['ACC Network', 'ACCN']),
  net('accnx', 'package', 'ACC', ['ACCNX', 'ACC Network Extra', 'ACC Extra']),
  net('pac-12', 'linear', 'Pac', ['Pac-12 Network', 'Pac-12', 'Pac12']),
  net('cw', 'linear', 'CW', ['CW', 'The CW'], ['CW Seed']),
  net('peacock', 'package', 'Peacock', ['Peacock']),
  net('prime-video', 'package', 'Prime', ['Prime Video', 'Amazon Prime Video', 'Amazon Prime', 'Prime', 'Thursday Night Football', 'TNF']),
  net('netflix', 'package', 'Netflix', ['Netflix']),
  net('apple-tv', 'package', 'Apple TV', ['Apple TV']),
  net('paramount-plus', 'package', 'Paramount', ['Paramount+', 'Paramount'], ['Paramount Network']),
  net('disney-plus', 'package', 'Disney', ['Disney+']),
  // Regional sports networks.
  net('nesn', 'rsn', 'NESN', ['NESN', 'New England Sports Network']),
  // Israel's "yes" packages share the name.
  net('yes', 'rsn', 'YES', ['YES Network', 'YES', 'DAZN (YES)'], [
    'Yes TV', 'yes Action', 'yes Drama', 'yes Comedy', 'yes Kids', 'yes Docu', 'yes Movies',
  ]),
  net('msg', 'rsn', 'MSG', ['MSG', 'MSG Network', 'MSGSN']),
  net('sny', 'rsn', 'SNY', ['SNY', 'SportsNet New York']),
  net('marquee', 'rsn', 'Marquee', ['Marquee Sports Network', 'Marquee Sports Net', 'Marquee']),
  net('spectrum-sportsnet', 'rsn', 'Spectrum', ['Spectrum SportsNet', 'Spectrum Sports Net', 'Spectrum Sports Network']),
  net('spectrum-sportsnet-la', 'rsn', 'Sportsnet', ['Spectrum SportsNet LA', 'Spectrum Sports Net LA', 'SportsNet LA', 'SNLA']),
  net('space-city', 'rsn', 'Space City', ['Space City Home Network', 'Space City', 'SCHN', 'AT&T SportsNet Southwest']),
  net('root-sports', 'rsn', 'Root Sports', ['Root Sports']),
  net('masn', 'rsn', 'MASN', ['MASN', 'MASN2', 'Mid-Atlantic Sports Network']),
  net('monumental', 'rsn', 'Monumental', ['Monumental Sports Network', 'Monumental', 'MNMT', 'NBC Sports Washington']),
  net('chsn', 'rsn', 'CHSN', ['Chicago Sports Network', 'CHSN', 'NBC Sports Chicago']),
  net('rangers-sn', 'rsn', 'Rangers Sports', ['Rangers Sports Network']),
  net('sportsnet', 'rsn', 'Sportsnet', ['Sportsnet']),
  net('sportsnet-one', 'rsn', 'Sportsnet', ['Sportsnet One', 'Sportsnet 1', 'SN1']),
  net('sportsnet-pittsburgh', 'rsn', 'Sportsnet', ['SportsNet Pittsburgh', 'AT&T SportsNet Pittsburgh']),
  // Canada's TSN, which ESPN lists for the Raptors and Blue Jays: one game goes out on some of its five feeds.
  net('tsn', 'rsn', 'TSN', ['TSN', 'TSN1', 'TSN2', 'TSN3', 'TSN4', 'TSN5']),
  net('tva-sports', 'rsn', 'TVA Sports', ['TVA Sports', 'TVA']),
  net('gcsen', 'rsn', 'GCSEN', ['GCSEN', 'Gulf Coast Sports']),
  net('altitude', 'rsn', 'Altitude', ['Altitude Sports', 'Altitude']),
  net('nbcs-bay-area', 'rsn', 'NBC Sports', ['NBC Sports Bay Area', 'NBCS Bay Area', 'NBCSBA', 'NBC Sports BA']),
  net('nbcs-california', 'rsn', 'NBC Sports', ['NBC Sports California', 'NBCS California', 'NBCSCA', 'NBC Sports CA']),
  net('nbcs-philadelphia', 'rsn', 'NBC Sports', [
    'NBC Sports Philadelphia', 'NBCS Philadelphia', 'NBCSP', 'NBC Sports Phil', 'NBC Sports Philly', 'NBC Sports Philadelphia+',
    'NBC Sports Phil +',
  ]),
  net('nbcs-boston', 'rsn', 'NBC Sports', ['NBC Sports Boston', 'NBCS Boston']),
  ...Object.entries(FDSN_REGIONS).map(([r, spellings]) =>
    net(`fdsn-${textTokens(r).join('-')}`, 'rsn', 'FanDuel', [
      ...[r, ...spellings].flatMap((s) => FDSN_BRANDS.map((b) => `${b} ${s}`)),
      ...(FDSN_OLD_NAMES[r] ?? []),
    ]),
  ),
  // Local stations that carry team games (ESPN market home/away).
  net('kfaa', 'local', 'KFAA', ['KFAA']),
  net('kjzz', 'local', 'KJZZ', ['KJZZ']),
  net('ksbi', 'local', 'KSBI', ['KSBI']),
  net('kunp', 'local', 'KUNP', ['KUNP']),
  net('ktla', 'local', 'KTLA', ['KTLA']),
  net('kmsp', 'local', 'KMSP', ['KMSP']),
  net('kntv', 'local', 'KNTV', ['KNTV']),
  net('wciu', 'local', 'WCIU', ['WCIU']),
  net('kdaf', 'local', 'KDAF', ['KDAF', 'CW33']),
  net('wttg', 'local', 'WTTG', ['WTTG', 'Fox 5 WTTG']),
  net('wxin', 'local', 'WXIN', ['WXIN', 'FOX59']),
  net('ktrk', 'local', 'KTRK', ['KTRK']),
  net('ktvk', 'local', 'KTVK', ['KTVK', "Arizona's Family 3TV", '3TV']),
  net('kpho', 'local', 'KPHO', ['KPHO', "Arizona's Family CBS5", 'CBS5']),
];

const NETWORK_BY_ID = new Map(NETWORKS.map((n) => [n.id, n]));
const LOCALS = NETWORKS.filter((n) => n.kind === 'local');
/** Every alias phrase by its first token, so a name is checked only against phrases it can start. */
const BY_FIRST = new Map<string, { alias: NetworkAlias; phrase: string[] }[]>();
for (const alias of NETWORKS) {
  for (const phrase of alias.phrases) {
    const list = BY_FIRST.get(phrase[0]!) ?? [];
    list.push({ alias, phrase });
    BY_FIRST.set(phrase[0]!, list);
  }
}

/** The alias with this id. */
export function networkAlias(id: string): NetworkAlias | undefined {
  return NETWORK_BY_ID.get(id);
}

/** Country tags a name may still start with after `stripCountryPrefix` ("USA ESPN", "US FOX 5"). */
const LEAD_TAGS = new Set(['us', 'usa', 'ca', 'can', 'uk', 'en']);
/** League words a slot channel opens with, before its number and the network it carries ("NCAAF 02: ESPN2"). */
const SLOT_LEAGUES = new Set(['nfl', 'ncaaf', 'cfb', 'ncaa', 'nba', 'mlb']);
/** Live TV services a provider names a channel's lineup after ("US: SLING MLB NETWORK"): not the channel. */
const SERVICE_TAGS = new Set(['sling', 'tubi', 'hulu', 'philo', 'directv', 'fubo', 'roku', 'pluto', 'xfinity', 'vidgo', 'frndly']);

/**
 * The network a name opens with at `at`: a package service's name followed at once by a network's is that
 * network on the service's lineup ("PRIME: ABC CINCINNATI (WCPO)", "US: PRIME MLB NETWORK"), not the service.
 */
function leadingNetwork(tokens: readonly string[], at: number): { alias: NetworkAlias; end: number } | null | undefined {
  const hit = networkAt(tokens, at);
  if (!hit || hit.alias.kind !== 'package') return hit;
  const next = networkAt(tokens, hit.end);
  return next && next.alias.kind !== 'package' ? next : hit;
}
const NUMBER = /^\d+$/;

/**
 * The network whose longest phrase starts at `at`, with where the phrase ends; null when the best one is
 * avoided there, undefined when none starts there.
 */
function networkAt(tokens: readonly string[], at: number): { alias: NetworkAlias; end: number } | null | undefined {
  let best: NetworkAlias | undefined;
  let bestLength = 0;
  for (const { alias, phrase } of BY_FIRST.get(tokens[at]!) ?? []) {
    if (phrase.length > bestLength && startsWith(tokens, phrase, at)) {
      best = alias;
      bestLength = phrase.length;
    }
  }
  if (!best) return undefined;
  return best.avoid?.some((a) => startsWith(tokens, a, at)) ? null : { alias: best, end: at + bestLength };
}

/**
 * The network a channel name is, from its tokens: the alias whose longest phrase opens the name (after any
 * leftover country tags, or a slot's league word, number and dash: "NCAAF 02: ESPN2", "NFL | 02 - ESPN"),
 * unless that alias's avoid list matches there too ("Fox News"). Event channels that merely mention a network
 * later in the name are not that network, and neither is a network name followed by a matchup ("ESPN | Knicks
 * @ Celtics", "ABC: LSU vs Auburn"): that is one game's channel. Package services keep their id there, since
 * their channels are all per-game feeds. Failing that, a local station's call sign anywhere in a name without
 * a matchup. Only a separator word makes a matchup here: a spaced dash after a network sets off its feed,
 * region or station ("ESPN - East", "FOX 5 - WTTG Washington", "SNY - Mets").
 */
export function networkIdForChannel(tokens: readonly string[]): string | null {
  let slot = false;
  for (let at = 0; at < tokens.length; at++) {
    const hit = leadingNetwork(tokens, at);
    if (hit === null) return null;
    if (hit) return hit.alias.kind !== 'package' && separated(tokens, hit.end, MATCHUP_WORDS) ? null : hit.alias.id;
    const t = tokens[at]!;
    if (SLOT_LEAGUES.has(t)) slot = true;
    else if (!LEAD_TAGS.has(t) && !SERVICE_TAGS.has(t) && !(slot && (NUMBER.test(t) || t === DASH))) break;
  }
  if (separated(tokens, 0, MATCHUP_WORDS)) return null;
  for (const n of LOCALS) if (n.phrases.some((p) => findPhrase(tokens, p) >= 0)) return n.id;
  return null;
}

/** Broadcast networks whose channels are mostly local stations ("FOX 5 (WNYW) New York", "CBS 2 Chicago"). */
const AFFILIATED = new Set(['abc', 'cbs', 'nbc', 'fox', 'cw']);
/**
 * Words after a network's name that pick its national feed or say nothing of a place: time zones, feed and
 * tier names ("FOX ⱽᴵᴾ" reads "vip"), languages and the weekly game slots ("NBC SNF").
 */
const FEED_WORDS = new Set([
  'east', 'eastern', 'west', 'western', 'pacific', 'mountain', 'central', 'atlantic', 'feed', 'national', 'network', 'net',
  'tv', 'channel', 'live', 'us', 'usa', 'main', 'dt', 'hdtv', 'plus', 'pl', 'et', 'est', 'pst', 'vip',
  'premium', 'gold', 'extra', 'multi', 'audio', 'dolby', 'atmos', 'en', 'english', 'spanish', 'snf', 'tnf',
  'mnf', 'nfl', 'sports', 'sport', 'event', 'events', 'ppv', 'ott', 'stream', 'direct', 'link',
]);

/**
 * The words that place a broadcast network's channel in a local market: what follows the network's name,
 * less numbers and feed words ("US: FOX 5 (WNYW) NEW YORK HD" gives wnyw, new, york; "FOX NET [WAUSAU]"
 * gives wausau). Empty for the network's own feed ("US| FOX HD", "NBC East"); null for a channel of any
 * other network, or of none. A provider with a broadcast network's group lists a station for nearly
 * every market (about 150 FOX stations on one real account), and only the teams' markets carry a
 * regional game.
 */
export function affiliateMarket(tokens: readonly string[]): string[] | null {
  let slot = false;
  for (let at = 0; at < tokens.length; at++) {
    const hit = leadingNetwork(tokens, at);
    if (!hit) {
      if (hit === null) return null;
      const t = tokens[at]!;
      if (SLOT_LEAGUES.has(t)) slot = true;
      else if (!LEAD_TAGS.has(t) && !SERVICE_TAGS.has(t) && !(slot && (NUMBER.test(t) || t === DASH))) return null;
      continue;
    }
    if (!AFFILIATED.has(hit.alias.id)) return null;
    // Single letters are feed marks too ("NBC 5 (KING) SEATTLE (A)", "NBC (E)").
    return tokens.slice(hit.end).filter((t) => t !== DASH && t.length > 1 && !NUMBER.test(t) && !FEED_WORDS.has(t));
  }
  return null;
}

/** Cities a team's location stands for where its market's stations name another ("New England" is Boston). */
const MARKET_ALIASES: Record<string, readonly string[]> = {
  'new england': ['boston'],
  carolina: ['charlotte'],
  arizona: ['phoenix'],
  tennessee: ['nashville'],
  minnesota: ['minneapolis'],
  'tampa bay': ['tampa'],
  'green bay': ['milwaukee'],
  'golden state': ['san francisco', 'oakland'],
  utah: ['salt lake'],
  indiana: ['indianapolis'],
  brooklyn: ['new york'],
  la: ['los angeles'],
  texas: ['dallas', 'fort worth'],
  colorado: ['denver'],
  washington: ['washington'],
};

/** The words of the markets a team's games air in: its location, and the cities above. */
export function teamMarkets(team: Pick<GameTeam, 'location'>): string[][] {
  const location = textTokens(team.location);
  if (location.length === 0) return [];
  return [location, ...(MARKET_ALIASES[location.join(' ')] ?? []).map(textTokens)];
}

/** The network of an ESPN broadcast name ("ESPN2", "FanDuel SN West", "KFAA-TV"); null for team apps and the like. */
export function networkIdForBroadcast(name: string): string | null {
  return networkIdForChannel(textTokens(name));
}

// ---------------------------------------------------------------------------
// Team channels

/** Words around a team channel's team: league words, country tags, slot or feed numbers and dashes. */
function teamFiller(t: string): boolean {
  return LEAGUE_WORDS.has(t) || LEAD_TAGS.has(t) || t === DASH || NUMBER.test(t);
}

/** The most words a team channel's team has: a full name ("Georgia Tech Yellow Jackets") and its abbreviation. */
const TEAM_NAME_WORDS = 5;

/**
 * What a team channel's name is once the words around its team are cut from both ends ("NBA: BOSTON CELTICS
 * ᴴᴰ" and "US: MLB NEW YORK YANKEES ᴿᴬᵂ" give "boston celtics" and "new york yankees"), joined by spaces;
 * null when nothing is left or more words than a team's name has. The channel is a team's when this is one of
 * its `channelNames`, or one of its `channelNicknames` beside the league's own word ("NBA: CELTICS"), so a
 * name that also names a second team ("Celtics vs Knicks") or anything else ("NBA: LEAGUE PASS 1", "US: MLB
 * NETWORK") never is.
 */
export function teamChannelName(tokens: readonly string[]): string | null {
  let from = 0;
  let to = tokens.length;
  while (from < to && teamFiller(tokens[from]!)) from++;
  while (to > from && teamFiller(tokens[to - 1]!)) to--;
  return to > from && to - from <= TEAM_NAME_WORDS ? tokens.slice(from, to).join(' ') : null;
}

// ---------------------------------------------------------------------------
// Groups

const GROUP_WORDS = new Set([
  'sport', 'sports', 'deportes', 'deporte', 'nfl', 'ncaa', 'ncaaf', 'cfb', 'college', 'nba', 'mlb', 'football',
  'basketball', 'baseball', 'rsn', 'rsns', 'regional', 'ppv', 'event', 'events', 'fubo', 'peacock', 'paramount',
  'prime', 'dazn', 'fanduel', 'bally', 'espn', 'redzone', 'btn', 'secn', 'accn',
  // Conference services ESPN lists for college games (SECN+, ACCNX, B1G+, MW+, Pac-12).
  'sec', 'acc', 'accnx', 'b1g', 'pac', 'mw',
]);
const GROUP_PHRASES = ['league pass', 'sunday ticket', 'game pass', 'red zone', 'big ten', 'big 12', 'mountain west'].map(textTokens);

/** The four leagues and their packages: a group naming one may carry their games, wherever it is from. */
const LEAGUE_GROUP_PHRASES = [
  'nfl', 'ncaaf', 'cfb', 'nba', 'mlb', 'college football', 'league pass', 'sunday ticket', 'redzone', 'red zone', 'extra innings',
].map(textTokens);

/** Other sports' leagues, events and services, besides `LEAGUE_WORDS` and `SPORT_WORDS` ("US| FLO PPV", "CA| WHL PPV"). */
const OTHER_SPORT_WORDS = new Set([
  'f1', 'formula', 'indycar', 'motogp', 'racing', 'supercross', 'motocross', 'pga', 'atp', 'wta', 'mma', 'aew', 'fifa', 'uefa',
  'liga', 'futbol', 'ahl', 'echl', 'ohl', 'whl', 'qmjhl', 'khl', 'nfhs', 'flo', 'flosports', 'darts', 'snooker', 'cycling', 'olympics',
]);

const otherSportWord = (t: string) => LEAGUE_WORDS.get(t)?.length === 0 || SPORT_WORDS.get(t)?.length === 0 || OTHER_SPORT_WORDS.has(t);
const ourSportWord = (t: string) => (SPORT_WORDS.get(t)?.length ?? 0) > 0;

/**
 * True for a live group that may hold games of the four leagues: sports, a league, a sports service or
 * package, regional networks, PPV or events, or a network that carries them ("US| FOX", which holds FS1 and
 * the FOX stations; not a streaming service's, "US| NETFLIX ON AIR"). Two kinds are skipped unless they name
 * one of the four leagues or their packages: a group tagged for another country ("UK| SKY SPORT+ PPV", "DE|
 * DAZN PPV"), whose feeds share no US network's programming, and a group that names only other sports ("US|
 * SOCCER PPV", "US| NHL PPV", "US| NCAAB PPV", "US| FLO PPV"). Generous otherwise ("US| PPV EVENT", "US| ESPN+
 * PPV", "8K| SPORT ON AIR"): an extra group costs a page read and its guide, a missed one loses games.
 */
export function isSportsGroup(groupName: string): boolean {
  const tokens = textTokens(groupName);
  if (!LEAGUE_GROUP_PHRASES.some((p) => findPhrase(tokens, p) >= 0)) {
    if (region(groupName) === 'foreign') return false;
    if (tokens.some(otherSportWord) && !tokens.some(ourSportWord)) return false;
  }
  if (tokens.some((t) => GROUP_WORDS.has(t)) || GROUP_PHRASES.some((p) => findPhrase(tokens, p) >= 0)) return true;
  // Not a service's group ("US| NETFLIX ON AIR"): its game feeds sit in its PPV or event groups.
  const network = networkIdForChannel(nameTokens(groupName));
  return network !== null && networkAlias(network)!.kind !== 'package';
}
