/**
 * Country / group tag stripping for channel names (`settings.stripCountryPrefix`), ported from
 * the old app's `strip-country-prefix.util.ts` plus `[XX] ` bracket tags.
 *
 * Pipes always separate a tag ("US | CNN", "FR|TF1", "|DE| ARD"). Dashes and colons only count
 * when the prefix looks like a short tag, since they appear inside real names ("Sky - Sports F1",
 * "NCIS: LA", "DUNE - Part Two"): a 2-3 char code ("UK", "4K") or a compound ("4K-DE", "AR-SUBS")
 * before a dash, a 2-3 char code before a colon. Every tag needs a letter, so "1917 - ..." stays.
 * When stripping would leave nothing, the trimmed name is returned.
 */
const DASH_SEPARATORS = [' - ', '- ', ' -'];
const COLON_SEPARATOR = ': ';
const TAG_SEPARATORS = [...DASH_SEPARATORS, COLON_SEPARATOR];
const TAG_PREFIX_PATTERN =
  /^(?:(?=[0-9+]*[A-Z])[A-Z0-9+]{2,5}(?:-(?=[0-9+]*[A-Z])[A-Z0-9+]{2,6}){1,2}|(?=[0-9+]*[A-Z])[A-Z0-9+]{2,3})$/;
const COLON_TAG_PATTERN = /^(?=[0-9+]*[A-Z])[A-Z0-9+]{2,3}$/;
const BRACKET_TAG_PATTERN = /^\[(?=[0-9+]*[A-Z])[A-Z0-9+-]{2,8}\]\s*/;

function findTagSeparator(name: string): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  const pipe = name.indexOf('|');
  if (pipe !== -1) best = { index: pipe, length: 1 };
  for (const sep of TAG_SEPARATORS) {
    const index = name.indexOf(sep);
    if (index === -1 || (best && best.index <= index)) continue;
    const pattern = sep === COLON_SEPARATOR ? COLON_TAG_PATTERN : TAG_PREFIX_PATTERN;
    if (!pattern.test(name.slice(0, index).trim())) continue;
    best = { index, length: sep.length };
  }
  return best;
}

/**
 * A channel or group name split into the provider's leading tag and the name after it, by the
 * rules above: "US| ESPN HD" is `{ tag: 'US', name: 'ESPN HD' }`, "[FR] TF1" is `{ tag: 'FR',
 * name: 'TF1' }`, and a name without a tag ("NCIS: LA", "Sky - Sports F1") comes back trimmed
 * with no `tag`. The strip setting drops the tag; ChannelName draws a place's tag after the name
 * (`splitPlaceTag`).
 */
export function splitCountryTag(name: string): { name: string; tag?: string } {
  const trimmed = name.trim();
  if (!trimmed) return { name: trimmed };

  const bracket = BRACKET_TAG_PATTERN.exec(trimmed);
  if (bracket) {
    const rest = trimmed.slice(bracket[0].length).trim();
    return rest ? { name: rest, tag: bracket[0].trim().slice(1, -1) } : { name: trimmed };
  }

  const match = findTagSeparator(trimmed);
  if (!match) return { name: trimmed };
  const prefix = trimmed.slice(0, match.index).trim();
  const rest = trimmed.slice(match.index + match.length).trim();
  if (!rest) return { name: trimmed };
  // A leading separator ("|DE| ARD") strips nothing by itself: retry on the remainder.
  return prefix ? { name: rest, tag: prefix } : splitCountryTag(rest);
}

/**
 * Words a playlist files names under in capitals that are kinds of content or quality, an event's
 * state or a service, not places ("NBA: Lakers vs Celtics", "PPV| UFC 300", "MOVIES | ACTION",
 * "NEXT | HAWKS VS ARSENAL", "PRIME: PBS HD"). The groups' region picker offers no region for them,
 * and a channel's name keeps them in front.
 */
export const CATEGORY_TAGS: ReadonlySet<string> = new Set([
  'MOVIES', 'MOVIE', 'FILMS', 'FILM', 'VOD', 'SERIES', 'SHOWS', 'TV', 'SPORT', 'SPORTS', 'NEWS', 'KIDS', 'MUSIC', 'DOCU',
  'DOCS', 'ADULT', 'XXX', 'PPV', 'EVENT', 'EVENTS', 'RADIO', 'LIVE', 'LOCAL', 'NFL', 'NBA', 'MLB', 'NHL', 'NCAA', 'NCAAF',
  'UFC', 'WWE', '24/7', 'HD', 'FHD', 'UHD', 'SD', 'VIP', 'RAW', 'NEXT', 'ENDED', 'REPLAY', 'PRIME', 'SLING', 'TUBI',
  'PLUTO', 'PEACOCK',
]);

/**
 * Place words longer than a code that playlists lead names with ("LATAM| FOX SPORTS", "EXYU: ZEE
 * TV"). A longer capital word is otherwise taken for part of the name: moving "NEXT" or "ENDED" after
 * an event's name hid the one word that says whether it is on.
 */
const REGION_WORDS: ReadonlySet<string> = new Set([
  'LATAM', 'LATINO', 'EXYU', 'CARIB', 'ARAB', 'ARABIC', 'MENA', 'NORDIC', 'AFRICA', 'ASIA', 'EUROPE', 'INTL', 'CANADA',
]);
/** A 2-3 character code ("US", "LAT", "4K"), or short codes joined by dashes ("EX-YU", "4K-DE"). */
const PLACE_CODE = /^(?=[\d+]*\p{Lu})[\p{Lu}\d+]{2,3}$|^(?=.*\p{Lu})[\p{Lu}\d+]{2,3}(?:-[\p{Lu}\d+]{2,3}){1,2}$/u;
/** A country and its language before a colon ("CA EN: SKY SPORTS F1"), or a place word ("CARIB: GLOBO"). */
const PLACE_COLON = /^(\p{Lu}{2} \p{Lu}{2}|\p{Lu}{4,8}):\s+(?=\S)/u;

/** Whether a provider's tag (from `splitCountryTag`) names a place. */
function isPlaceTag(tag: string): boolean {
  const code = tag.normalize('NFKC');
  if (CATEGORY_TAGS.has(code)) return false;
  if (REGION_WORDS.has(code)) return true;
  const pair = /^(\p{Lu}{2}) (\p{Lu}{2})$/u.exec(code);
  if (pair) return !CATEGORY_TAGS.has(pair[1]!) && !CATEGORY_TAGS.has(pair[2]!);
  return code.length <= 8 && PLACE_CODE.test(code);
}

/**
 * `splitCountryTag` for drawing the tag after the name (ChannelName), which every user sees, so it
 * moves only a tag that names a place: a 2-3 character code in capitals ("US", "LAT"), short codes
 * joined by dashes ("EX-YU", "4K-DE"), a country and its language ("CA EN: SKY SPORTS F1"), or a
 * known place word ("LATAM", "CARIB"), and no kind of content. Anything else is part of the name
 * and stays where the provider put it: "Sky Sports | Main Event", "ESPN HD | Backup", "NBA: Lakers
 * vs Celtics" and "NEXT | HAWKS VS ARSENAL" come back whole, with no `tag`. The strip setting keeps
 * its own wider rule.
 */
export function splitPlaceTag(name: string): { name: string; tag?: string } {
  const trimmed = name.trim();
  const colon = PLACE_COLON.exec(trimmed);
  if (colon && isPlaceTag(colon[1]!)) return { name: trimmed.slice(colon[0].length).trim(), tag: colon[1]! };
  const split = splitCountryTag(trimmed);
  return split.tag && isPlaceTag(split.tag) ? split : { name: trimmed };
}

export function stripCountryPrefix(name: string): string {
  return splitCountryTag(name).name;
}

/**
 * A channel's name for plain text (a toast, a dialog's title), as ChannelName draws it: a place's
 * tag after the name in brackets, "ABC (Backup) (US)" for "US| ABC (Backup)", and the bare name
 * with the strip setting on. Text has no quiet style for the tag, and in front it is what a reader
 * meets first while the rows beside the message lead with the name.
 */
export function plainChannelName(name: string | null | undefined, strip: boolean | undefined): string {
  const raw = name ?? '';
  if (strip) return stripCountryPrefix(raw);
  const split = splitPlaceTag(raw);
  return split.tag ? `${split.name} (${split.tag})` : raw;
}

/** A feed's quality or copy word ("HD", "ᴿᴬᵂ", "⁶⁰ᶠᵖˢ", "(BACKUP"), compatibility-folded and unbracketed. */
const VARIANT_WORD = /^(?:SD|HD|FHD|UHD|QHD|4K|8K|HEVC|H\.?26[45]|HDR|RAW|VIP|BACKUP|BKP|\d{2,3}FPS|\d{3,4}[PI])$/i;
/** Words a feed's number follows ("BACKUP 2", "FEED 3"). */
const NUMBERED_VARIANT = /^(?:BACKUP|BKP|FEED|ALT)$/i;

function variantWord(token: string): string {
  return token.normalize('NFKC').replace(/^[([]+|[)\]]+$/g, '');
}

function isVariantToken(token: string): boolean {
  const word = variantWord(token);
  return word !== '' && word.split('/').every((part) => VARIANT_WORD.test(part));
}

/**
 * Where a name's trailing run of quality and copy words starts ("HD (BACKUP 2)", "ᴿᴬᵂ ⁶⁰ᶠᵖˢ"), or
 * -1. Providers list one station as several feeds that differ only there, so it is what a narrow
 * column must not cut. The first word always stays with the name.
 */
function variantStart(name: string): number {
  const tokens = [...name.matchAll(/\S+/g)];
  let i = tokens.length - 1;
  let start = -1;
  while (i > 0) {
    const token = tokens[i]![0];
    if (isVariantToken(token)) {
      start = tokens[i]!.index;
      i--;
    } else if (/^\d{1,2}\)?$/.test(token) && i > 1 && NUMBERED_VARIANT.test(variantWord(tokens[i - 1]![0]))) {
      start = tokens[i - 1]!.index;
      i -= 2;
    } else break;
  }
  return start;
}

/** A pipe-separated part of an event's name that says when it is on ("Tue 17 Nov 23:00 EDT (US)"). */
const WHEN_PART = /(?:^|\s)\d{1,2}[:.]\d{2}(?:\s|$)/;

/**
 * An event channel's name cut before the part that says when it is on: "NEXT | HAWKS VS ARSENAL"
 * and "| Tue 23:00 EDT". A narrow row cuts the teams, never the kick-off, and leaves out the
 * provider's words after it ("| 8K EXCLUSIVE | US: ESPN+ PPV 1"), the same on every row of the group
 * and still in the title and the spoken name. The time keeps its weekday and zone ("Tue 23:00 EDT"):
 * the date and the zone's place in brackets would leave the teams a few letters.
 */
function splitEventWhen(name: string): { name: string; when: string } | null {
  const parts = name.split(/\s*\|\s*/);
  const i = parts.findIndex((part, k) => k > 0 && WHEN_PART.test(part));
  if (i < 1) return null;
  const head = parts.slice(0, i).join(' | ').trim();
  if (!head) return null;
  const when = parts[i]!.replace(/\s*\([^)]*\)\s*$/, '').replace(/^(\p{L}{3,}\.?)\s+\d{1,2}\s+\p{L}{3,}\.?(?=\s)/u, '$1');
  return { name: head, when: `| ${when}` };
}

/** A name's leading word before a colon ("PRIME: PBS HD"); left out only when it is a `CATEGORY_TAGS` word. */
const LEAD_WORD = /^(\p{Lu}[\p{Lu}\d+]{2,9}):\s+(?=\S)/u;

/** How ChannelName draws a name: the station, its feed's quality words, and a place's tag. */
export interface ChannelNameParts {
  /** The station's name: what may be cut. */
  name: string;
  /** The trailing quality and copy words ("HD (BACKUP 2)"), or an event's time, kept whole after the name. */
  variant?: string;
  /** A place's tag, drawn quiet after the rest (`splitPlaceTag`). */
  tag?: string;
  /** The name as text under the setting (the provider's, or without its tag with `strip`). */
  full: string;
}

const partsCache = new Map<string, ChannelNameParts>();

/**
 * `name` cut into what ChannelName draws, cached by name: every channel row asks on every render.
 * With `group` (the group a list is open on), a leading service or kind of content ("PRIME: ",
 * "NBA: ", from `CATEGORY_TAGS`) is left out when the group's name has that word ("US| PRIME ᴿᴬᵂ"): the header already says it, and 1,001 rows repeating it
 * squeezed the station's name. Display only: search, matching and accessible names keep the
 * provider's name.
 */
export function channelNameParts(name: string | null | undefined, strip: boolean | undefined, group?: string): ChannelNameParts {
  const raw = name ?? '';
  const key = `${strip ? 1 : 0}${group ?? ''}\u0000${raw}`;
  let parts = partsCache.get(key);
  if (parts) return parts;
  const full = strip ? stripCountryPrefix(raw) : raw;
  const split = strip ? { name: full } : splitPlaceTag(raw);
  let rest = split.name;
  const lead = group ? LEAD_WORD.exec(rest) : null;
  if (lead && CATEGORY_TAGS.has(lead[1]!) && group!.normalize('NFKC').toUpperCase().split(/[^\p{L}\p{N}+]+/u).includes(lead[1]!)) rest = rest.slice(lead[0].length);
  const event = splitEventWhen(rest);
  const cut = event ? -1 : variantStart(rest);
  parts = event
    ? { name: event.name, variant: event.when, full }
    : cut > 0 ? { name: rest.slice(0, cut).trimEnd(), variant: rest.slice(cut).trim(), full } : { name: rest, full };
  if (split.tag) parts.tag = split.tag;
  if (partsCache.size >= 20000) partsCache.clear();
  partsCache.set(key, parts);
  return parts;
}

/** Display name for a channel under the current setting. */
export function displayChannelName(name: string | null | undefined, strip: boolean | undefined): string {
  const raw = name ?? '';
  return strip ? stripCountryPrefix(raw) : raw;
}

/**
 * A provider's heading row between groups of channels ("##### FOX ᴴᴰ/ᴿᴬᵂ #####", "===== NFL ====="): a
 * playlist entry with a name, but no channel, which would otherwise read as the network it names.
 */
export function isSeparatorName(name: string): boolean {
  return /^\s*[#=*~_]{3,}|[#=*~_]{3,}\s*$/.test(name);
}

/** A heading row's text without its runs of marks: "PRIME ᴿᴬᵂ" for "#### PRIME ᴿᴬᵂ ####". */
export function separatorLabel(name: string): string {
  return name.replace(/^[\s#=*~_]+|[\s#=*~_]+$/g, '');
}
