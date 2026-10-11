/**
 * Paging arguments for the VOD poster grids.
 *
 * m3u and xtream catalogs live in SQLite and page through `catalog.movies` /
 * `catalog.series`. Stalker VOD is never synced into SQLite (only its
 * categories are), so it pages live from the portal through `stalker.movies` /
 * `stalker.series`; the portal serves 14 items per page, so Stalker page sizes
 * are a multiple of 14 to keep one grid page aligned with whole portal pages.
 *
 * The grid holds pages sparsely: each visible cell subscribes to the page that
 * contains it, so only pages near the viewport stay in memory.
 */

import type { PageQuery, SortDir, SortKey, SourceKind } from '@/api/types';

export type VodKind = 'movie' | 'series';
export type VodSortKey = Extract<SortKey, 'name' | 'added' | 'rating' | 'year'>;

export const VOD_SORT_KEYS: readonly VodSortKey[] = ['added', 'name', 'rating', 'year'];

/** Catalog page size for SQLite-backed sources. */
export const CATALOG_PAGE_SIZE = 60;
/** Stalker portals serve 14 items per page; three portal pages per grid page. */
export const STALKER_PAGE_SIZE = 42;
/** Category id used in routes for "every category". */
export const ALL_CATEGORIES = 'all';

export type VodPageCommand = 'catalog.movies' | 'catalog.series' | 'stalker.movies' | 'stalker.series';

export interface VodPageArgs {
  sourceId: string;
  categoryId?: string;
  query: PageQuery;
  /** `catalog.*` only: SQLite keeps titles rated at least this, and `total` counts them. */
  minRating?: number;
}

export interface GridQueryInput {
  sourceKind: SourceKind;
  kind: VodKind;
  sourceId: string;
  /** Route category id; `all` or empty means no category filter. */
  categoryId?: string;
  sort: VodSortKey;
  dir: SortDir;
  search?: string;
  /** Minimum rating (0 = off). Applied in SQLite for m3u/xtream; Stalker portals cannot filter, see {@link ratingFilterInCore}. */
  minRating?: number;
}

export function pageSizeFor(sourceKind: SourceKind): number {
  return sourceKind === 'stalker' ? STALKER_PAGE_SIZE : CATALOG_PAGE_SIZE;
}

export function pageCommand(sourceKind: SourceKind, kind: VodKind): VodPageCommand {
  if (sourceKind === 'stalker') return kind === 'movie' ? 'stalker.movies' : 'stalker.series';
  return kind === 'movie' ? 'catalog.movies' : 'catalog.series';
}

/** True when the core filters by rating (SQLite-backed sources); Stalker grids filter loaded pages instead. */
export function ratingFilterInCore(sourceKind: SourceKind): boolean {
  return sourceKind !== 'stalker';
}

/** Default direction when the user picks a sort key: newest/best/latest first, names A..Z. */
export function defaultDir(sort: VodSortKey): SortDir {
  return sort === 'name' ? 'asc' : 'desc';
}

/** Builds the rpc command and args for page `pageIndex` (0-based). */
export function buildPageRequest(
  input: GridQueryInput,
  pageIndex: number,
): { cmd: VodPageCommand; args: VodPageArgs } {
  const limit = pageSizeFor(input.sourceKind);
  const search = input.search?.trim();
  const query: PageQuery = { offset: Math.max(0, pageIndex) * limit, limit, sort: input.sort, dir: input.dir };
  if (search) query.search = search;
  const args: VodPageArgs = { sourceId: input.sourceId, query };
  if (input.categoryId && input.categoryId !== ALL_CATEGORIES) args.categoryId = input.categoryId;
  if (input.minRating && input.minRating > 0 && ratingFilterInCore(input.sourceKind)) args.minRating = input.minRating;
  return { cmd: pageCommand(input.sourceKind, input.kind), args };
}

/** Page index containing the item at `index`. */
export function pageOf(index: number, pageSize: number): number {
  return Math.floor(Math.max(0, index) / pageSize);
}

/** Parses grid state from URL search params, falling back to defaults on junk. */
export function readGridParams(params: URLSearchParams): { sort: VodSortKey; dir: SortDir; search: string } {
  const rawSort = params.get('sort');
  const sort: VodSortKey = (VOD_SORT_KEYS as readonly string[]).includes(rawSort ?? '')
    ? (rawSort as VodSortKey)
    : 'added';
  const rawDir = params.get('dir');
  const dir: SortDir = rawDir === 'asc' || rawDir === 'desc' ? rawDir : defaultDir(sort);
  return { sort, dir, search: params.get('q') ?? '' };
}

/** Search param that switches the minimum-rating filter off for one grid. */
export const ALL_RATINGS_PARAM = 'ratings';

/**
 * Items rated at least `min` (0..10). Unrated items are hidden while a
 * minimum is set, as in the old app; `min <= 0` keeps everything.
 */
export function filterByRating<T extends { rating?: number }>(items: readonly T[], min: number): T[] {
  if (!(min > 0)) return [...items];
  return items.filter((i) => typeof i.rating === 'number' && Number.isFinite(i.rating) && i.rating >= min);
}

/** The effective minimum rating for a grid: the setting, unless the URL asks for all ratings. */
export function effectiveMinRating(setting: number | undefined, params: URLSearchParams): number {
  const min = typeof setting === 'number' && Number.isFinite(setting) ? Math.min(10, Math.max(0, setting)) : 0;
  return params.get(ALL_RATINGS_PARAM) === 'all' ? 0 : min;
}
