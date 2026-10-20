/**
 * Recent searches (the search page's zero state): the last few queries the user acted on, newest
 * first, kept in localStorage per app (a UI preference, like the scroll memory). A query counts
 * once it was submitted or a result was opened from it, so half-typed words never land here.
 */

import { useSyncExternalStore } from 'react';

export const RECENT_SEARCHES_KEY = 'vod.recentSearches';
/** How many queries the zero state offers. */
export const RECENT_SEARCHES_MAX = 8;

const listeners = new Set<() => void>();
let cache: readonly string[] | null = null;

function read(): readonly string[] {
  if (cache) return cache;
  let out: string[] = [];
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RECENT_SEARCHES_KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) out = parsed.filter((q): q is string => typeof q === 'string' && q.trim() !== '').slice(0, RECENT_SEARCHES_MAX);
  } catch {
    out = [];
  }
  cache = out;
  return out;
}

function write(list: readonly string[]): void {
  cache = list;
  try {
    if (list.length === 0) localStorage.removeItem(RECENT_SEARCHES_KEY);
    else localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked: the list still holds for this session.
  }
  listeners.forEach((l) => l());
}

/** Same words, any case or spacing: one entry. */
const same = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLocaleLowerCase() === b.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

export function rememberSearch(query: string): void {
  const q = query.trim().replace(/\s+/g, ' ');
  if (!q) return;
  const list = read();
  if (list[0] !== undefined && same(list[0], q)) return;
  write([q, ...list.filter((x) => !same(x, q))].slice(0, RECENT_SEARCHES_MAX));
}

export function forgetSearch(query: string): void {
  write(read().filter((x) => !same(x, query)));
}

export function clearSearches(): void {
  write([]);
}

/** Drops the in-memory copy (tests, or another tab's write read again). */
export function resetRecentSearchCache(): void {
  cache = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The recent searches, newest first; re-renders when they change. */
export function useRecentSearches(): readonly string[] {
  return useSyncExternalStore(subscribe, read, read);
}
