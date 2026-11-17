/**
 * Regions of a provider's groups, read from the tag before their names ("US| Sports", "UK: News",
 * "[DE] Sport"). Big international playlists file hundreds of groups under a few dozen country tags,
 * and the group list's region picker narrows them to one.
 */

import { CATEGORY_TAGS, stripCountryPrefix } from './channelName';

/**
 * The group's tag ("US" for "US| SPORT ᴴᴰ", "CANADA" for "CANADA | NEWS"), or null when its name has
 * none. A tag is written in capitals and is no kind of content, so a playlist that files "Movies | Action"
 * or "MOVIES | ACTION" and "SPORTS | NBA" gets no region picker. An emoji or flag before it is
 * decoration: "⚽ GR| SPORTS" is in GR, not a region of its own.
 */
export function groupRegion(name: string): string | null {
  const trimmed = name.trim();
  const rest = stripCountryPrefix(trimmed);
  if (rest === trimmed || !trimmed.endsWith(rest)) return null;
  const tag = trimmed
    .slice(0, trimmed.length - rest.length)
    .replace(/^[\s|[\p{Extended_Pictographic}\p{S}\p{M}\u200D]+|[\s|:\-\]]+$/gu, '')
    .normalize('NFKC');
  if (tag !== tag.toUpperCase() || CATEGORY_TAGS.has(tag)) return null;
  return tag.length >= 2 && tag.length <= 8 ? tag : null;
}

export interface GroupRegion {
  tag: string;
  /** Groups under the tag. */
  groups: number;
}

/**
 * The regions worth a picker, most groups first: tags held by at least two groups. None unless there
 * are at least two such tags and tagged groups make up half the list or more, so a playlist that
 * only tags a few groups keeps a plain list.
 */
export function groupRegions(names: readonly string[]): GroupRegion[] {
  const counts = new Map<string, number>();
  let tagged = 0;
  for (const name of names) {
    const tag = groupRegion(name);
    if (!tag) continue;
    tagged++;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const list = [...counts]
    .filter(([, groups]) => groups >= 2)
    .map(([tag, groups]) => ({ tag, groups }))
    .sort((a, b) => b.groups - a.groups || a.tag.localeCompare(b.tag));
  return list.length >= 2 && tagged * 2 >= names.length ? list : [];
}

/**
 * Two-letter codes playlists use for something other than the country ISO gives them: AR for
 * Arabic (not Argentina), AF for Africa (not Afghanistan), LA for Latin America (not Laos).
 */
const NOT_ISO = new Set(['AR', 'AF', 'LA']);
const regionNames = new Map<string, Intl.DisplayNames | null>();

/**
 * A region's tag with the country's name in the UI language when the tag is a country's code ("GR ·
 * Greece", "UK · United Kingdom"), so the picker's 30-odd codes need no guessing; other tags ("LAT",
 * "CARIB", "EX-YU", "AR") as they are.
 */
export function regionLabel(tag: string, language: string): string {
  if (!/^[A-Z]{2}$/.test(tag) || NOT_ISO.has(tag)) return tag;
  let names = regionNames.get(language);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([language], { type: 'region', fallback: 'none' });
    } catch {
      names = null;
    }
    regionNames.set(language, names);
  }
  const country = names?.of(tag);
  return country ? `${tag} · ${country}` : tag;
}

/** The region picked for a source's groups (`scope`), kept in localStorage: a UI preference. */
export function readRegion(scope: string | undefined): string | null {
  if (!scope) return null;
  try {
    return localStorage.getItem(`tsrust.liveRegion:${scope}`) || null;
  } catch {
    return null;
  }
}

export function writeRegion(scope: string | undefined, tag: string | null): void {
  if (!scope) return;
  try {
    if (tag) localStorage.setItem(`tsrust.liveRegion:${scope}`, tag);
    else localStorage.removeItem(`tsrust.liveRegion:${scope}`);
  } catch {
    // storage blocked: the pick holds until the page closes
  }
}
