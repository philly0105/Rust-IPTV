/**
 * Pure model for /favorites and /s/:sourceId/favorites: grouping into
 * live / movies / series, and reorder math that produces the exact
 * `favorites.reorder` arguments.
 */

import { sameRef, type ContentType, type FavoriteEntry, type ItemRef } from '@/api/types';

export type FavoriteGroup = 'live' | 'movies' | 'series';

export const FAVORITE_GROUPS: readonly FavoriteGroup[] = ['live', 'movies', 'series'];

export function groupOf(contentType: ContentType): FavoriteGroup {
  if (contentType === 'movie') return 'movies';
  if (contentType === 'series') return 'series';
  return 'live'; // live and radio
}

/** Stored order: position ascending, then oldest first. */
export function sortFavorites(entries: readonly FavoriteEntry[]): FavoriteEntry[] {
  return [...entries].sort((a, b) => a.position - b.position || a.addedAt.localeCompare(b.addedAt));
}

export function groupFavorites(entries: readonly FavoriteEntry[]): Record<FavoriteGroup, FavoriteEntry[]> {
  const out: Record<FavoriteGroup, FavoriteEntry[]> = { live: [], movies: [], series: [] };
  for (const e of sortFavorites(entries)) out[groupOf(e.ref.contentType)].push(e);
  return out;
}

/**
 * Moves one entry inside its group and returns the whole list in its new
 * order. Entries of other groups keep their slots, so the stored positions of
 * the other groups do not change meaning.
 */
export function moveWithinGroup(entries: readonly FavoriteEntry[], ref: ItemRef, toIndexInGroup: number): FavoriteEntry[] {
  const sorted = sortFavorites(entries);
  const group = groupOf(ref.contentType);
  const slots: number[] = [];
  const members: FavoriteEntry[] = [];
  sorted.forEach((e, i) => {
    if (groupOf(e.ref.contentType) === group) {
      slots.push(i);
      members.push(e);
    }
  });
  const from = members.findIndex((e) => sameRef(e.ref, ref));
  if (from < 0) return sorted;
  const to = Math.max(0, Math.min(members.length - 1, toIndexInGroup));
  if (from === to) return sorted;
  const [moved] = members.splice(from, 1);
  members.splice(to, 0, moved as FavoriteEntry);
  const next = [...sorted];
  slots.forEach((slot, i) => {
    next[slot] = members[i] as FavoriteEntry;
  });
  return next;
}

/** Arguments for `favorites.reorder`. `sourceId` is omitted on the global page. */
export function reorderArgs(ordered: readonly FavoriteEntry[], sourceId?: string): { sourceId?: string; refs: ItemRef[] } {
  const refs = ordered.map((e) => e.ref);
  return sourceId ? { sourceId, refs } : { refs };
}

/** Rewrites `position` to match the array order (optimistic cache update). */
export function withPositions(ordered: readonly FavoriteEntry[]): FavoriteEntry[] {
  return ordered.map((e, i) => (e.position === i ? e : { ...e, position: i }));
}

export type FavoriteRow =
  | { kind: 'header'; group: FavoriteGroup; count: number; key: string }
  | { kind: 'item'; group: FavoriteGroup; entry: FavoriteEntry; indexInGroup: number; groupSize: number; key: string };

/** Flattens the groups into one virtualizable list with group headers. */
export function buildFavoriteRows(entries: readonly FavoriteEntry[], search = ''): FavoriteRow[] {
  const q = search.trim().toLocaleLowerCase();
  const grouped = groupFavorites(entries);
  const rows: FavoriteRow[] = [];
  for (const group of FAVORITE_GROUPS) {
    const all = grouped[group];
    const list = q ? all.filter((e) => matches(e, q)) : all;
    if (list.length === 0) continue;
    rows.push({ kind: 'header', group, count: list.length, key: `h-${group}` });
    for (const entry of list) {
      rows.push({
        kind: 'item',
        group,
        entry,
        indexInGroup: all.indexOf(entry),
        groupSize: all.length,
        key: `f-${entry.ref.sourceId}|${entry.ref.contentType}|${entry.ref.itemId}`,
      });
    }
  }
  return rows;
}

function matches(e: FavoriteEntry, q: string): boolean {
  return e.snapshot.title.toLocaleLowerCase().includes(q) || (e.snapshot.subtitle?.toLocaleLowerCase().includes(q) ?? false);
}
