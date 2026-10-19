/**
 * Programme hits outside the guide: the global search page and the command palette ask
 * `epg.search` of every source (it searches one source at a time), merge the answers by start
 * time, and open the guide at the programme a hit names.
 */

import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { rpcKey } from '@/api/query';
import { rpcRaw } from '@/api/transport';
import type { GuideSearchHit } from '@/api/types';

import { ms } from '../lib/epgTime';
import { displayHits, searchQuery, searchWindow } from './search';

/** What the guide page reads from the router state of a link made by {@link guideHitLink}. */
export interface GuideHitState {
  guideHit: GuideSearchHit;
}

/** True for router state a {@link guideHitLink} left. */
export function isGuideHitState(state: unknown): state is GuideHitState {
  const hit = (state as Partial<GuideHitState> | null)?.guideHit;
  return !!hit && typeof hit === 'object' && !!hit.ref && !!hit.program;
}

/**
 * The guide at a programme: its source, the window from the programme's start (`at`, floored to
 * the grid's slot by the page) and the hit in the router state, so the page finds the channel's
 * row and puts the cursor on the programme, as a hit of its own search panel does.
 * `hit` is in display time (the EPG offset applied).
 */
export function guideHitLink(hit: GuideSearchHit): { to: string; state: GuideHitState } {
  const to = `/epg?source=${encodeURIComponent(hit.ref.sourceId)}&at=${ms(hit.program.start)}`;
  return { to, state: { guideHit: hit } };
}

/** Merges per-source answers: start time, then the sources' order (each answer is already ordered). */
export function mergeProgrammeHits(answers: readonly (readonly GuideSearchHit[] | undefined)[], limit: number): GuideSearchHit[] {
  const all = answers.flatMap((a, i) => (a ?? []).map((hit, j) => ({ hit, i, j })));
  all.sort((a, b) => ms(a.hit.program.start) - ms(b.hit.program.start) || a.i - b.i || a.j - b.j);
  return all.slice(0, limit).map((x) => x.hit);
}

export interface ProgrammeSearch {
  /** Display-time hits, earliest first; empty while the query is too short. */
  hits: GuideSearchHit[];
  /** A source has not answered the current query yet. */
  pending: boolean;
}

/**
 * Programmes whose titles match `raw` in the next 14 days, across `sourceIds`, at most `limit`
 * (and `limit` per source). A source whose search fails is left out; the others still show.
 */
export function useProgrammeSearch(
  sourceIds: readonly string[],
  raw: string,
  opts: { enabled: boolean; limit: number; offsetMinutes: number },
): ProgrammeSearch {
  const query = searchQuery(raw);
  // Floored to 5 minutes, so the query keys hold still between renders.
  const { from, to } = searchWindow(Date.now(), opts.offsetMinutes);
  const on = opts.enabled && !!query;
  const results = useQueries({
    queries: sourceIds.map((sourceId) => {
      const args = { sourceId, query: query ?? '', from, to, limit: opts.limit };
      return {
        queryKey: rpcKey('epg.search', args),
        // The signal aborts a search that a newer query replaced.
        queryFn: async ({ signal }: { signal: AbortSignal }) => (await rpcRaw('epg.search', args, { signal })) as GuideSearchHit[],
        enabled: on,
        staleTime: 60_000,
        retry: false,
      };
    }),
  });
  const pending = on && results.some((r) => r.isPending);
  const stamp = results.map((r) => r.dataUpdatedAt).join(',');
  const hits = useMemo(
    () => (on ? displayHits(mergeProgrammeHits(results.map((r) => r.data), opts.limit), opts.offsetMinutes) : []),
    // The answers are read through `stamp`: useQueries hands out a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [on, stamp, opts.limit, opts.offsetMinutes, sourceIds.join(',')],
  );
  return { hits, pending };
}
