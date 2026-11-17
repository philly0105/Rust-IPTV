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
