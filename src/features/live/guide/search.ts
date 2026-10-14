/**
 * Pure helpers for the guide's search panel and jumps (Run 2 C5): the search
 * window, hits moved to display time and grouped by day, and finding a
 * channel's row in the grid's list.
 */

import { itemKey, type Channel, type GuideSearchHit, type ItemKey, type Page } from '@/api/types';

import { DAY, MINUTE, localDayStart, ms, shiftProgram } from '../lib/epgTime';

/** Characters a query needs before it is sent (the core refuses shorter ones). */
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 100;
/** Hits asked for per search; the panel says so when a search fills it. */
export const SEARCH_LIMIT = 100;
/** Days ahead a search covers (the core's default). */
export const SEARCH_DAYS = 14;
/** The search window's start moves in steps this long, so the query key holds still between keystrokes. */
const FROM_STEP = 5 * MINUTE;

/** The trimmed query to send, or null while it is too short. */
export function searchQuery(raw: string): string | null {
  const q = raw.trim();
  return q.length >= SEARCH_MIN_CHARS ? q.slice(0, SEARCH_MAX_CHARS) : null;
}

/**
 * `epg.search` window in raw guide time for display time `now`: from what airs now to
 * 14 days ahead. Guide times are shown `offsetMinutes` later, so the window moves back by it.
 */
export function searchWindow(now: number, offsetMinutes: number): { from: string; to: string } {
  const from = Math.floor(now / FROM_STEP) * FROM_STEP - offsetMinutes * MINUTE;
  return { from: new Date(from).toISOString(), to: new Date(from + SEARCH_DAYS * DAY).toISOString() };
}

/** Hits with their programme moved to display time (the EPG offset applied). */
export function displayHits(hits: readonly GuideSearchHit[], offsetMinutes: number): GuideSearchHit[] {
  return offsetMinutes ? hits.map((h) => ({ ...h, program: shiftProgram(h.program, offsetMinutes) })) : [...hits];
}

export interface HitDay {
  /** Start of the local day. */
  day: number;
  hits: GuideSearchHit[];
}

/** Display-time hits grouped by local day, keeping the core's order (start, then channel number). */
export function groupHitsByDay(hits: readonly GuideSearchHit[]): HitDay[] {
  const out: HitDay[] = [];
  for (const h of hits) {
    const day = localDayStart(ms(h.program.start));
    const last = out[out.length - 1];
    if (last && last.day === day) last.hits.push(h);
    else out.push({ day, hits: [h] });
  }
  return out;
}

/** Stable key of one hit (a channel can air the same title at many times). */
export function hitKey(h: GuideSearchHit): string {
  return `${itemKey(h.ref)}@${ms(h.program.start)}`;
}

/**
 * The grid's group for showing a hit: the current one when it holds the channel (or is "all
 * channels"), else all channels. A hit without a category cannot be placed in a group.
 */
export function groupForHit(current: string | undefined, hit: Pick<GuideSearchHit, 'categoryId'>): string | undefined {
  if (!current) return undefined;
  return hit.categoryId === current ? current : undefined;
}

/** Channels per request while looking for a row; the core's largest page. */
export const LOCATE_PAGE = 1000;
/** Pages looked through before giving up (60k channels). */
export const LOCATE_MAX_PAGES = 60;

/**
 * Index of the channel `key` in a paged channel list, reading pages in order until it turns up.
 * Null when it is not in the list (hidden, another group) or `isCancelled` says to stop.
 */
export async function findChannelIndex(
  fetchPage: (offset: number, limit: number) => Promise<Page<Channel>>,
  key: ItemKey,
  isCancelled: () => boolean = () => false,
): Promise<number | null> {
  for (let page = 0; page < LOCATE_MAX_PAGES; page++) {
    if (isCancelled()) return null;
    const res = await fetchPage(page * LOCATE_PAGE, LOCATE_PAGE);
    const i = res.items.findIndex((c) => itemKey(c.ref) === key);
    if (i >= 0) return res.offset + i;
    if (res.items.length === 0 || res.offset + res.items.length >= res.total) return null;
  }
  return null;
}
