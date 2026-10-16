/**
 * Year and decade filtering for the VOD poster grids (Run 2 C4).
 *
 * The URL carries the range as `yf` (from) and `yt` (to), both inclusive, so
 * a filtered grid can be linked, reloaded and restored by Back. A decade chip
 * is the range `1990..1999`; any other range is a custom one (the From/To
 * selects). SQLite-backed sources filter in the core (`yearFrom`/`yearTo` on
 * `catalog.movies` / `catalog.series`) and draw their chips from
 * `catalog.yearFacets`. Stalker portals page VOD live and cannot filter, so
 * they get fixed chips ({@link STALKER_DECADES}) and the grid filters the
 * pages it has loaded ({@link filterByYear}).
 */

import type { YearFacet } from '@/api/types';

/** Search params of the year range. */
export const YEAR_FROM_PARAM = 'yf';
export const YEAR_TO_PARAM = 'yt';

/** The years the core accepts (`catalog.movies` answers invalid outside it). */
export const MIN_YEAR = 1900;
export const MAX_YEAR = 2100;

/** Fixed chips for Stalker portals, newest first: the 2020s back to the 1950s. */
export const STALKER_DECADES: readonly number[] = [2020, 2010, 2000, 1990, 1980, 1970, 1960, 1950];

export interface YearRange {
  from?: number;
  to?: number;
}

/** One decade chip: its first year and, when known, how many titles it holds. */
export interface DecadeChip {
  decade: number;
  count?: number;
}

function parseYear(raw: string | null): number | undefined {
  if (raw === null || !/^\d{4}$/.test(raw.trim())) return undefined;
  const y = Number(raw.trim());
  return y >= MIN_YEAR && y <= MAX_YEAR ? y : undefined;
}

/**
 * The year range in the URL. Junk and out-of-range years are ignored, and a
 * reversed pair is swapped, so a hand-edited link never reaches the core as
 * an invalid request.
 */
export function readYearRange(params: URLSearchParams): YearRange {
  let from = parseYear(params.get(YEAR_FROM_PARAM));
  let to = parseYear(params.get(YEAR_TO_PARAM));
  if (from !== undefined && to !== undefined && from > to) [from, to] = [to, from];
  const out: YearRange = {};
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;
  return out;
}

/** A copy of `params` holding `range` (an empty range removes both params). */
export function writeYearRange(params: URLSearchParams, range: YearRange): URLSearchParams {
  const next = new URLSearchParams(params);
  if (range.from !== undefined) next.set(YEAR_FROM_PARAM, String(range.from));
  else next.delete(YEAR_FROM_PARAM);
  if (range.to !== undefined) next.set(YEAR_TO_PARAM, String(range.to));
  else next.delete(YEAR_TO_PARAM);
  return next;
}

export function hasYearRange(range: YearRange): boolean {
  return range.from !== undefined || range.to !== undefined;
}

export function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10;
}

/**
 * A decade chip's range. The last decade the core accepts is cut at
 * {@link MAX_YEAR} (the 2100s are `2100..2100`): a bound past it would be
 * dropped when the URL is read back, and the chip could never show as
 * pressed or be cleared by a second click.
 */
export function decadeRange(decade: number): Required<YearRange> {
  return { from: decade, to: Math.min(decade + 9, MAX_YEAR) };
}

/** The decade a range covers exactly (`1990..1999` -> 1990, `2100..2100` -> 2100), else undefined. */
export function rangeDecade(range: YearRange): number | undefined {
  const { from, to } = range;
  if (from === undefined || to === undefined) return undefined;
  return from % 10 === 0 && to === decadeRange(from).to ? from : undefined;
}

/** Decade chips from `catalog.yearFacets` (newest year first), newest decade first. */
export function decadesFromFacets(facets: readonly YearFacet[]): DecadeChip[] {
  const counts = new Map<number, number>();
  for (const f of facets) {
    if (!Number.isInteger(f.year) || f.year < MIN_YEAR || f.year > MAX_YEAR || !(f.count > 0)) continue;
    const d = decadeOf(f.year);
    counts.set(d, (counts.get(d) ?? 0) + f.count);
  }
  return [...counts.entries()].sort((a, b) => b[0] - a[0]).map(([decade, count]) => ({ decade, count }));
}

/** The chips a grid shows: facet decades for SQLite-backed sources, the fixed set for Stalker. */
export function decadeChips(stalker: boolean, facets: readonly YearFacet[] | undefined): DecadeChip[] {
  if (stalker) return STALKER_DECADES.map((decade) => ({ decade }));
  return decadesFromFacets(facets ?? []);
}

/**
 * Years for the From/To selects, newest first: the facet years when the
 * catalog is local, else every year from this one back to 1950.
 */
export function yearOptions(stalker: boolean, facets: readonly YearFacet[] | undefined, now = new Date()): number[] {
  if (!stalker && facets && facets.length > 0) {
    return [...new Set(facets.map((f) => f.year).filter((y) => y >= MIN_YEAR && y <= MAX_YEAR))].sort((a, b) => b - a);
  }
  const top = Math.min(MAX_YEAR, now.getFullYear());
  const last = STALKER_DECADES[STALKER_DECADES.length - 1] ?? 1950;
  return Array.from({ length: top - last + 1 }, (_, i) => top - i);
}

/**
 * Items inside `range` (Stalker grids). Like the core, titles without a year,
 * or with one outside 1900..2100, drop out as soon as either bound is set; an
 * empty range keeps everything.
 */
export function filterByYear<T extends { year?: number | undefined }>(items: readonly T[], range: YearRange): T[] {
  if (!hasYearRange(range)) return [...items];
  return items.filter((i) => {
    const y = i.year;
    if (typeof y !== 'number' || !Number.isFinite(y) || y < MIN_YEAR || y > MAX_YEAR) return false;
    if (range.from !== undefined && y < range.from) return false;
    if (range.to !== undefined && y > range.to) return false;
    return true;
  });
}

/** Key part for the grid's remount key and empty-state choice: `1990-1999`, `-1999`, `1990-` or ``. */
export function yearRangeKey(range: YearRange): string {
  return hasYearRange(range) ? `${range.from ?? ''}-${range.to ?? ''}` : '';
}
