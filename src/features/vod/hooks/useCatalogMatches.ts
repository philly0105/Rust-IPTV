import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import type { CatalogTitleQuery } from '@/api/rpc';
import { rpcKey } from '@/api/query';
import { rpcRaw } from '@/api/transport';
import { itemKey, type SeriesItem, type TmdbBrief, type VodItem } from '@/api/types';

/** TMDB titles looked up per rail; TMDB sends about 20 similar titles. */
const MAX_LOOKUPS = 20;

const NONE: (VodItem | SeriesItem)[] = [];

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

/** `catalog.matchTitles` args for a rail's briefs: title, and the year and TMDB id when known. */
function matchTitlesArgs(briefs: readonly TmdbBrief[], sourceId: string, kind: 'movie' | 'series') {
  const titles = briefs.map((b): CatalogTitleQuery => {
    const t: CatalogTitleQuery = { title: b.title, tmdbId: b.tmdbId };
    if (b.year !== undefined) t.year = b.year;
    return t;
  });
  return { sourceId, contentType: kind, titles };
}

/**
 * TMDB titles ("More like this", "Known for") that this source has (VL-tmdb-deadend), as catalog
 * items, so each card opens the title's own detail page instead of a search that finds nothing.
 * One `catalog.matchTitles` call per rail: the core probes each title's base title through an
 * index and runs `catalog.search`'s word-prefix pass only for titles that need it, in one database
 * call, where one `catalog.search` per title queued 20 to 40 ranked searches (10-60 ms each) on the
 * core's pool. Each card is still picked here (`matchBrief`). Stalker portals keep VOD out of
 * SQLite, so nothing could match there: callers turn the lookup off for them (`enabled`), and
 * "More like this", below the fold, also until it nears the screen and the page is idle, so it does
 * not queue with the page's own reads.
 */
export function useCatalogMatches(
  briefs: readonly TmdbBrief[],
  sourceId: string | undefined,
  kind: 'movie' | 'series',
  enabled = true,
): { items: (VodItem | SeriesItem)[]; pending: boolean } {
  const wanted = useMemo(() => briefs.slice(0, MAX_LOOKUPS), [briefs]);
  const args = useMemo(() => matchTitlesArgs(wanted, sourceId ?? '', kind), [wanted, sourceId, kind]);
  const on = enabled && !!sourceId && wanted.length > 0;
  const lists = useQuery({
    queryKey: rpcKey('catalog.matchTitles', args),
    queryFn: async ({ signal }) => (await rpcRaw('catalog.matchTitles', args, { signal })) as (VodItem | SeriesItem)[][],
    enabled: on,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const items = useMemo(() => {
    const out: (VodItem | SeriesItem)[] = [];
    const seen = new Set<string>();
    wanted.forEach((b, i) => {
      const hit = matchBrief(b, lists.data?.[i] ?? NONE);
      if (!hit) return;
      const key = itemKey(hit.ref);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(hit);
    });
    return out;
  }, [wanted, lists.data]);
  // A query that is off stays pending in TanStack terms: neither cards nor a spinner then.
  return { items: on ? items : NONE, pending: on && lists.isPending };
}
