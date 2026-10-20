import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import type { CatalogSearchResult } from '@/api/rpc';
import { rpcKey } from '@/api/query';
import { rpcRaw } from '@/api/transport';
import { itemKey, type SeriesItem, type TmdbBrief, type VodItem } from '@/api/types';

/** TMDB titles looked up per rail; TMDB sends about 20 similar titles. */
const MAX_LOOKUPS = 20;
/** Catalog hits read per title: enough for a remake or two sharing the name. */
const HITS_PER_TITLE = 8;

/** Lower case, no accents, letters and digits only: "Amélie (2001)" and "amelie 2001" compare equal. */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The catalog title a TMDB brief stands for, or undefined: the same TMDB id when the provider
 * sends one, else the same base title with years at most one apart (providers often list the
 * release year of another country). A title with no year on either side matches by name alone.
 */
export function matchBrief<T extends VodItem | SeriesItem>(brief: Pick<TmdbBrief, 'tmdbId' | 'title' | 'year'>, hits: readonly T[]): T | undefined {
  const byId = hits.find((h) => h.tmdbId !== undefined && h.tmdbId === brief.tmdbId);
  if (byId) return byId;
  const want = fold(brief.title);
  if (!want) return undefined;
  return hits.find((h) => {
    if (fold(h.titleBase || h.title) !== want) return false;
    if (brief.year === undefined || h.year === undefined) return true;
    return Math.abs(brief.year - h.year) <= 1;
  });
}

/**
 * TMDB titles ("More like this", "Known for") that this source has (VL-tmdb-deadend), as catalog
 * items, so each card opens the title's own detail page instead of a search that finds nothing.
 * One `catalog.search` per brief (local SQLite, a few ms each), cached like the search page's.
 * Stalker portals keep VOD out of SQLite, so nothing matches there and the rail stays hidden.
 */
export function useCatalogMatches(
  briefs: readonly TmdbBrief[],
  sourceId: string | undefined,
  kind: 'movie' | 'series',
  enabled = true,
): { items: (VodItem | SeriesItem)[]; pending: boolean } {
  const wanted = enabled && sourceId ? briefs.slice(0, MAX_LOOKUPS) : [];
  const results = useQueries({
    queries: wanted.map((b) => {
      const args = { query: b.title, sourceId: sourceId ?? '', contentTypes: [kind], limit: HITS_PER_TITLE };
      return {
        queryKey: rpcKey('catalog.search', args),
        queryFn: async ({ signal }: { signal: AbortSignal }) => (await rpcRaw('catalog.search', args, { signal })) as CatalogSearchResult,
        staleTime: 5 * 60_000,
        retry: false,
      };
    }),
  });
  const stamp = results.map((r) => r.dataUpdatedAt).join(',');
  const items = useMemo(() => {
    const out: (VodItem | SeriesItem)[] = [];
    const seen = new Set<string>();
    wanted.forEach((b, i) => {
      const data = results[i]?.data;
      const hits: (VodItem | SeriesItem)[] = (kind === 'movie' ? data?.movies : data?.series) ?? [];
      const hit = matchBrief(b, hits);
      if (!hit) return;
      const key = itemKey(hit.ref);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(hit);
    });
    return out;
    // `stamp` changes when any lookup answers; `wanted` is a slice of `briefs`.
  }, [stamp, briefs, sourceId, kind, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return { items, pending: results.some((r) => r.isPending) };
}
