/**
 * Search result grouping for the global and per-source search pages.
 *
 * `catalog.search` returns `{live, movies, series}` across every source; the
 * per-source page for a Stalker portal adds `stalker.search` pages because
 * Stalker VOD is not synced into SQLite. This module flattens all of it into
 * three groups of display hits, de-duplicated by item ref, each tagged with the
 * owning source for its badge.
 */

import type { CatalogSearchResult } from '@/api/rpc';
import { itemKey, type Channel, type ItemRef, type SeriesItem, type Source, type SourceKind, type VodItem } from '@/api/types';

export const MIN_QUERY_LENGTH = 2;
export const SEARCH_LIMIT = 60;

export type SearchGroupKind = 'live' | 'movies' | 'series';
export const SEARCH_GROUP_ORDER: readonly SearchGroupKind[] = ['movies', 'series', 'live'];

export interface SearchHit {
  key: string;
  group: SearchGroupKind;
  ref: ItemRef;
  title: string;
  /** Year for VOD, channel number and category for live. */
  meta?: string;
  imageUrl?: string;
  sourceId: string;
  sourceName: string;
  sourceKind?: SourceKind;
  /** Detail route for movies and series; live hits play instead. */
  href?: string;
  item: Channel | VodItem | SeriesItem;
}

export interface SearchGroup {
  kind: SearchGroupKind;
  hits: SearchHit[];
}

export interface SourceFacet {
  sourceId: string;
  sourceName: string;
  count: number;
}

/** Trimmed query, or '' when it is too short to search. */
export function normalizeQuery(q: string | null | undefined): string {
  const t = (q ?? '').trim().replace(/\s+/g, ' ');
  return t.length >= MIN_QUERY_LENGTH ? t : '';
}

export function detailHref(ref: ItemRef): string | undefined {
  const sid = encodeURIComponent(ref.sourceId);
  const iid = encodeURIComponent(ref.itemId);
  if (ref.contentType === 'movie') return `/s/${sid}/movie/${iid}`;
  if (ref.contentType === 'series') return `/s/${sid}/series/${iid}`;
  return undefined;
}

function sourceLookup(sources: Source[]): (id: string) => { name: string; kind?: SourceKind } {
  const map = new Map(sources.map((s) => [s.id, s]));
  return (id) => {
    const s = map.get(id);
    return s ? { name: s.name, kind: s.kind } : { name: id };
  };
}

export interface GroupInput {
  result?: CatalogSearchResult;
  /** Extra provider-side results (Stalker portal search). */
  extraMovies?: VodItem[];
  extraSeries?: SeriesItem[];
  sources: Source[];
  /** Restrict to one source (facet filter). */
  sourceFilter?: string;
}

export function groupSearchResults(input: GroupInput): SearchGroup[] {
  const lookup = sourceLookup(input.sources);
  const seen = new Set<string>();
  const groups: Record<SearchGroupKind, SearchHit[]> = { live: [], movies: [], series: [] };

  const push = (group: SearchGroupKind, item: Channel | VodItem | SeriesItem, hit: Omit<SearchHit, 'key' | 'group' | 'sourceId' | 'sourceName' | 'sourceKind' | 'item' | 'ref'>) => {
    const ref = item.ref;
    if (input.sourceFilter && ref.sourceId !== input.sourceFilter) return;
    const key = itemKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    const src = lookup(ref.sourceId);
    const full: SearchHit = { key, group, ref, item, sourceId: ref.sourceId, sourceName: src.name, ...hit };
    if (src.kind) full.sourceKind = src.kind;
    groups[group].push(full);
  };

  for (const m of [...(input.result?.movies ?? []), ...(input.extraMovies ?? [])]) {
    push('movies', m, compact({ title: m.title, meta: m.year?.toString(), imageUrl: m.posterUrl, href: detailHref(m.ref) }));
  }
  for (const s of [...(input.result?.series ?? []), ...(input.extraSeries ?? [])]) {
    push('series', s, compact({ title: s.title, meta: s.year?.toString(), imageUrl: s.posterUrl, href: detailHref(s.ref) }));
  }
  for (const c of input.result?.live ?? []) {
    const meta = [c.number !== undefined ? String(c.number) : undefined, c.categoryName || undefined]
      .filter(Boolean)
      .join('  ');
    push('live', c, compact({ title: c.name, meta: meta || undefined, imageUrl: c.logoUrl }));
  }

  return SEARCH_GROUP_ORDER.map((kind) => ({ kind, hits: groups[kind] })).filter((g) => g.hits.length > 0);
}

/** Per-source hit counts across all groups, largest first, for the source filter chips. */
export function sourceFacets(groups: SearchGroup[]): SourceFacet[] {
  const map = new Map<string, SourceFacet>();
  for (const g of groups) {
    for (const h of g.hits) {
      const f = map.get(h.sourceId) ?? { sourceId: h.sourceId, sourceName: h.sourceName, count: 0 };
      f.count += 1;
      map.set(h.sourceId, f);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.sourceName.localeCompare(b.sourceName));
}

/** Splits a Stalker search page (VodItem | SeriesItem) by ref content type. */
export function splitStalkerResults(items: (VodItem | SeriesItem)[]): { movies: VodItem[]; series: SeriesItem[] } {
  const movies: VodItem[] = [];
  const series: SeriesItem[] = [];
  for (const it of items) {
    if (it.ref.contentType === 'series') series.push(it as SeriesItem);
    else movies.push(it as VodItem);
  }
  return { movies, series };
}

function compact<T extends object>(o: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

interface PageLike {
  items?: unknown;
}

function refsIn(data: unknown): ItemRef[] {
  const list = Array.isArray(data) ? data : Array.isArray((data as PageLike | undefined)?.items) ? ((data as PageLike).items as unknown[]) : [];
  const out: ItemRef[] = [];
  for (const it of list) {
    const ref = (it as { ref?: ItemRef } | null)?.ref;
    if (ref && typeof ref.itemId === 'string') out.push(ref);
  }
  return out;
}

/**
 * Stalker serves VOD-as-series rows (`is_series=1`) from `stalker.movies` with
 * `ref.contentType = 'series'`. Grids route those to the series page; this
 * catches a movie URL reached any other way (typed, stale link) by checking
 * the cached Stalker pages for a series row with the same id.
 */
export function isCachedStalkerSeries(cached: Iterable<unknown>, sourceId: string, itemId: string): boolean {
  for (const data of cached) {
    for (const ref of refsIn(data)) {
      if (ref.sourceId === sourceId && ref.itemId === itemId && ref.contentType === 'series') return true;
    }
  }
  return false;
}
