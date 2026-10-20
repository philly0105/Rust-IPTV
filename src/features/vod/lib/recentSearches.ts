/**
 * Recent searches (the search page's zero state): the last few queries the user acted on, newest
 * first, kept in localStorage per app (a UI preference, like the scroll memory). A query counts
 * once it was submitted or a result was opened from it, so half-typed words never land here.
 *
 * While parental controls are set (a PIN), nothing is remembered and nothing remembered before is
 * offered: the core filters what Hide mode hides from every list, but these chips are the UI's
 * own, and a parent's query for a locked title would wait there for the next person on the device
 * once the unlock ran out (docs/architecture/parental.md). Turning the pause on clears the list.
 *
 * Other tabs of the app share the stored list: their writes (a clear above all) reach this one
 * through the `storage` event, and every change here starts from what is stored now, so a tab
 * never writes back queries another one cleared.
 */

import { useSyncExternalStore } from 'react';

export const RECENT_SEARCHES_KEY = 'vod.recentSearches';
/** How many queries the zero state offers. */
export const RECENT_SEARCHES_MAX = 8;

const listeners = new Set<() => void>();
let cache: readonly string[] | null = null;
let paused = false;
const NONE: readonly string[] = [];

/** The list as stored now. */
function load(): string[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RECENT_SEARCHES_KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) return parsed.filter((q): q is string => typeof q === 'string' && q.trim() !== '').slice(0, RECENT_SEARCHES_MAX);
  } catch {
    // Unreadable: none.
  }
  return [];
}

function read(): readonly string[] {
  if (paused) return NONE;
  cache ??= load();
  return cache;
}

// Another tab wrote the list, or cleared the whole storage (`key` null): read it again.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== RECENT_SEARCHES_KEY) return;
    cache = null;
    listeners.forEach((l) => l());
  });
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
  if (!q || paused) return;
  // From what is stored now: another tab may have changed it since this one read it.
  const list = load();
  if (list[0] !== undefined && same(list[0], q)) {
    write(list);
    return;
  }
  write([q, ...list.filter((x) => !same(x, q))].slice(0, RECENT_SEARCHES_MAX));
}

/** The recent searches now, newest first (none while paused). */
export function recentSearchList(): readonly string[] {
  return read();
}

export function forgetSearch(query: string): void {
  if (paused) return;
  write(load().filter((x) => !same(x, query)));
}

export function clearSearches(): void {
  write([]);
}

/**
 * Parental controls set (`on`) or not, from the parental status. On, the stored list is cleared
 * and the zero state offers nothing until controls are off again; nothing is remembered meanwhile.
 */
export function setRecentSearchesPaused(on: boolean): void {
  if (on === paused) return;
  if (on) write([]);
  paused = on;
  listeners.forEach((l) => l());
}

/** Drops the in-memory copy and the pause (tests, or another tab's write read again). */
export function resetRecentSearchCache(): void {
  cache = null;
  paused = false;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The recent searches, newest first; re-renders when they change. */
export function useRecentSearches(): readonly string[] {
  return useSyncExternalStore(subscribe, read, read);
}
