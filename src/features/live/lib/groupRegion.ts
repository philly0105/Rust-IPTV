/**
 * Regions of a provider's groups, read from the tag before their names ("US| Sports", "UK: News",
 * "[DE] Sport"). Big international playlists file hundreds of groups under a few dozen country tags,
 * and the group list's region picker narrows them to one.
 */

import { stripCountryPrefix } from './channelName';

/** The group's tag in upper case ("US" for "US| SPORT ᴴᴰ"), or null when its name has none. */
export function groupRegion(name: string): string | null {
  const trimmed = name.trim();
  const rest = stripCountryPrefix(trimmed);
  if (rest === trimmed || !trimmed.endsWith(rest)) return null;
  const tag = trimmed
    .slice(0, trimmed.length - rest.length)
    .replace(/^[\s|[]+|[\s|:\-\]]+$/g, '')
    .normalize('NFKC')
    .toUpperCase();
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
