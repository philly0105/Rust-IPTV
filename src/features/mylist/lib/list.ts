/**
 * Pure model for My List: filtering, sorting, searching and reordering the
 * `watchlist.list` entries. Nothing here touches the network or the cache.
 */

import { itemKey, sameRef, type ItemRef, type ItemSnapshot, type WatchlistEntry } from '@/api/types';
import { intlLocale, relativeTimeFormat } from '@/lib/intl';

/** The page's type filter (`?type=`). */
export type MyListFilter = 'all' | 'movie' | 'series';
/** The page's sort (`?sort=`): the user's own order, newest add first, or by title. */
export type MyListSort = 'order' | 'added' | 'title';

export const FILTERS: readonly MyListFilter[] = ['all', 'movie', 'series'];
export const SORTS: readonly MyListSort[] = ['order', 'added', 'title'];

export function parseFilter(raw: string | null | undefined): MyListFilter {
  return raw === 'movie' || raw === 'series' ? raw : 'all';
}

export function parseSort(raw: string | null | undefined): MyListSort {
  return raw === 'added' || raw === 'title' ? raw : 'order';
}

/** The content types My List holds; live and radio are rejected by the core. */
export function canSave(ref: Pick<ItemRef, 'contentType'>): boolean {
  return ref.contentType === 'movie' || ref.contentType === 'series';
}

/** `${sourceId}|${contentType}|${itemId}`, the `useInMyList` key. */
export function entryKey(e: Pick<WatchlistEntry, 'ref'>): string {
  return itemKey(e.ref);
}

const keyCache = new WeakMap<readonly WatchlistEntry[], ReadonlySet<string>>();

/** The keys of every entry, computed once per list instance. */
export function keysOf(list: readonly WatchlistEntry[] | undefined): ReadonlySet<string> {
  if (!list) return EMPTY;
  let keys = keyCache.get(list);
  if (!keys) {
    keys = new Set(list.map(entryKey));
    keyCache.set(list, keys);
  }
  return keys;
}
const EMPTY: ReadonlySet<string> = new Set();

/** Lowercased, accent-free text for search ("Amélie" matches "amelie"). */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

/** Folded title and subtitle per entry: entries keep their identity across keystrokes, so each is folded once. */
const hayCache = new WeakMap<WatchlistEntry, string>();

function hayOf(e: WatchlistEntry): string {
  let hay = hayCache.get(e);
  if (hay === undefined) {
    hay = fold(`${e.snapshot.title} ${e.snapshot.subtitle ?? ''}`);
    hayCache.set(e, hay);
  }
  return hay;
}

function queryWords(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/** True when every word of `query` appears in the title or subtitle. */
export function matchesQuery(e: WatchlistEntry, query: string): boolean {
  const words = queryWords(query);
  if (words.length === 0) return true;
  const hay = hayOf(e);
  return words.every((w) => hay.includes(w));
}

const collators = new Map<string, Intl.Collator>();
function collator(language: string): Intl.Collator {
  let c = collators.get(language);
  if (!c) {
    try {
      c = new Intl.Collator(intlLocale(language), { sensitivity: 'base', numeric: true });
    } catch {
      c = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
    }
    collators.set(language, c);
  }
  return c;
}

/**
 * Entries in the chosen order. `order` keeps the list as the core returns it
 * (the user's order); `added` is newest first; `title` follows the UI
 * language's collation. Ties keep the user's order.
 */
export function sortEntries(entries: readonly WatchlistEntry[], sort: MyListSort, language: string): WatchlistEntry[] {
  const out = [...entries];
  if (sort === 'added') {
    // Parsed once per entry, not twice per comparison.
    const at = new Map<WatchlistEntry, number>();
    for (const e of out) {
      const t = Date.parse(e.addedAt);
      at.set(e, Number.isFinite(t) ? t : 0);
    }
    out.sort((a, b) => at.get(b)! - at.get(a)!);
  } else if (sort === 'title') {
    const c = collator(language);
    out.sort((a, b) => c.compare(a.snapshot.title, b.snapshot.title));
  }
  return out;
}

export interface MyListView {
  /** Entries whose source is not waiting out its removal undo. */
  base: WatchlistEntry[];
  /** `base` narrowed to the type filter. */
  typed: WatchlistEntry[];
  /** `typed` without watched entries when Hide watched is on. */
  unwatched: WatchlistEntry[];
  /** What the page lists: `unwatched` matching the search, sorted. */
  rows: WatchlistEntry[];
  counts: Record<MyListFilter, number>;
  watchedCount: number;
}

export interface ViewOptions {
  filter: MyListFilter;
  sort: MyListSort;
  hideWatched: boolean;
  query: string;
  language: string;
  hiddenSources?: ReadonlySet<string>;
}

/** Every stage of the page's narrowing, so each empty state can say which step emptied it. */
export function buildView(entries: readonly WatchlistEntry[], o: ViewOptions): MyListView {
  const hidden = o.hiddenSources;
  const base = hidden && hidden.size > 0 ? entries.filter((e) => !hidden.has(e.ref.sourceId)) : [...entries];
  const counts: Record<MyListFilter, number> = { all: base.length, movie: 0, series: 0 };
  let watchedCount = 0;
  for (const e of base) {
    if (e.ref.contentType === 'movie') counts.movie += 1;
    else if (e.ref.contentType === 'series') counts.series += 1;
    if (e.watched) watchedCount += 1;
  }
  const typed = o.filter === 'all' ? base : base.filter((e) => e.ref.contentType === o.filter);
  const unwatched = o.hideWatched ? typed.filter((e) => !e.watched) : typed;
  // The query is folded once per view, not once per entry.
  const words = queryWords(o.query);
  const matches = (e: WatchlistEntry) => {
    const hay = hayOf(e);
    return words.every((w) => hay.includes(w));
  };
  const searched = words.length > 0 ? unwatched.filter(matches) : unwatched;
  return { base, typed, unwatched, rows: sortEntries(searched, o.sort, o.language), counts, watchedCount };
}

/**
 * Moves `ref` to `toIndex` within `subset` (the rows on screen, in the
 * user's order) and returns the whole list in its new order. Entries outside
 * the subset (another type, hidden watched ones) keep their slots: the
 * subset's entries are reshuffled among the places they already held.
 * Returns `all` unchanged when nothing moves.
 */
export function moveInSubset(
  all: readonly WatchlistEntry[],
  subset: readonly WatchlistEntry[],
  ref: ItemRef,
  toIndex: number,
): readonly WatchlistEntry[] {
  const from = subset.findIndex((e) => sameRef(e.ref, ref));
  if (from < 0) return all;
  const to = Math.max(0, Math.min(subset.length - 1, toIndex));
  if (to === from) return all;
  const moved = [...subset];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item!);
  const inSubset = new Set(subset.map(entryKey));
  let next = 0;
  return all.map((e) => (inSubset.has(entryKey(e)) ? moved[next++]! : e));
}

/** `refs` with `ref` placed at `index` (moved there when already present). */
export function reinsertRef(refs: readonly ItemRef[], ref: ItemRef, index: number): ItemRef[] {
  const out = refs.filter((r) => !sameRef(r, ref));
  out.splice(Math.max(0, Math.min(out.length, index)), 0, ref);
  return out;
}

/** The entry a fresh add shows until the core answers. */
export function draftEntry(ref: ItemRef, snapshot: ItemSnapshot, now = new Date()): WatchlistEntry {
  return { ref, snapshot: { ...snapshot, contentType: ref.contentType }, addedAt: now.toISOString(), watched: false };
}

/** "3 min ago", "yesterday", "2 weeks ago" in the UI language. Empty for an unreadable date. */
export function relativeTime(iso: string, language: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = relativeTimeFormat(intlLocale(language), { numeric: 'auto' });
  } catch {
    rtf = relativeTimeFormat(undefined, { numeric: 'auto' });
  }
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 7 * 86_400) return rtf.format(Math.round(diff / 86_400), 'day');
  if (abs < 30 * 86_400) return rtf.format(Math.round(diff / (7 * 86_400)), 'week');
  if (abs < 365 * 86_400) return rtf.format(Math.round(diff / (30 * 86_400)), 'month');
  return rtf.format(Math.round(diff / (365 * 86_400)), 'year');
}
