/**
 * The streams of each game on screen: the channel index, the guide over the games' window, and `matchGame`
 * per game. A game that is live or starts within 3 hours and still has no stream gets one more try: a
 * `catalog.search` per team name (which also finds event channels outside the sports groups), each hit
 * verified like an event channel before it counts.
 */

import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import type { CatalogSearchResult } from '@/api/rpc';
import { rpcKey } from '@/api/query';
import type { Channel, ContentType, EpgProgram, ItemKey, Source } from '@/api/types';
import { useNow } from '@/features/parental/time';
import { useVisibleSources } from '@/shell/useVisibleSources';

import { isCurrentGame, isEventChannel, matchGame, prepareMatch, sharedNetworks, type StreamMatch } from '../lib/match';
import type { Game, GameTeam, League } from '../lib/types';
import { sportsRead } from './sportsRead';
import { toIndexed, useChannelIndex, type IndexedChannel } from './useChannelIndex';
import { useGuideWindow } from './useGuideWindow';
import { unionWindow, type GuideSpan } from './useGrowingWindow';

const MINUTE = 60_000;
/** Games starting within this long (or live) get the search fallback. */
export const FALLBACK_AHEAD_MS = 3 * 60 * MINUTE;
/** Hits asked of each fallback search. */
export const FALLBACK_LIMIT = 30;
/** Fallback searches in flight at once, across every game. */
export const FALLBACK_CONCURRENCY = 2;
const FALLBACK_STALE_MS = 5 * MINUTE;

const LIVE: ContentType[] = ['live'];
const NO_CHANNELS: readonly IndexedChannel[] = [];
const NO_PROGRAMS: ReadonlyMap<ItemKey, EpgProgram[]> = new Map();

let running = 0;
const waiting: (() => void)[] = [];

/** Runs `task` once fewer than {@link FALLBACK_CONCURRENCY} fallback searches are running; a finished one hands its slot on. */
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running < FALLBACK_CONCURRENCY) running++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/** Words that never single out a team. */
const WEAK_WORDS = new Set(['state', 'st', 'the', 'of', 'university']);

/**
 * The one word to search for a team. `catalog.search` needs every word as a word prefix, so "Boston
 * Celtics" would miss "Celtics vs Knicks": the longest word of the nickname for pros ("Blazers", "76ers"),
 * of the school for college ("Texas" for Texas A&M, "José" for San José State), since college event channels
 * name schools rather than mascots. Words are split where the core splits them ("Hawai'i" gives "Hawai").
 */
export function fallbackQuery(team: GameTeam, league: League): string | null {
  const words = (name: string) => name.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !WEAK_WORDS.has(w.toLowerCase()));
  const pool = league === 'cfb' ? words(team.location) : [];
  const list = pool.length > 0 ? pool : words(team.name);
  let best: string | null = null;
  for (const w of list) if (!best || w.length >= best.length) best = w;
  return best;
}

function wantsFallback(game: Game, now: number): boolean {
  if (game.phase === 'postponed' || game.phase === 'canceled' || game.phase === 'final') return false;
  return game.state === 'in' || (game.state === 'pre' && game.startMs - now <= FALLBACK_AHEAD_MS);
}

function fallbackQueries(game: Game): string[] {
  const out = [fallbackQuery(game.away, game.league), fallbackQuery(game.home, game.league)];
  return [...new Set(out.filter((q): q is string => q !== null))];
}

interface SearchAnswers {
  hits: (Channel[] | undefined)[];
  pending: boolean;
}

// Module-level, so useQueries re-runs it only when an answer changes.
function combineSearches(results: UseQueryResult<CatalogSearchResult>[]): SearchAnswers {
  return { hits: results.map((r) => r.data?.live), pending: results.some((r) => r.isPending) };
}

/** Verified fallback hits of a game, as event matches in the sources' order. */
function fallbackMatches(game: Game, hits: readonly Channel[], sources: readonly Source[], now: number): StreamMatch[] {
  const rows: IndexedChannel[] = [];
  for (const source of sources) {
    for (const ch of hits) {
      if (ch.ref.sourceId !== source.id || ch.isRadio) continue;
      const row = toIndexed(ch, source, false);
      if (isEventChannel(row, game, now)) rows.push(row);
    }
  }
  return matchGame(game, rows, NO_PROGRAMS, now);
}

interface Cached {
  /** `isCurrentGame` when matched: the only thing `matchGame` reads `now` for. */
  current: boolean;
  /** The networks the game shared with another game when matched (`sharedNetworks`), joined. */
  shared: string;
  list: StreamMatch[];
}

const NO_NETWORKS: ReadonlySet<string> = new Set();

interface Prepared {
  channels: readonly IndexedChannel[];
  programs: ReadonlyMap<ItemKey, EpgProgram[]>;
  /** Whether the index and the guide had both answered in full, for the games' window [`from`, `to`). */
  complete: boolean;
  from: number;
  to: number;
}

/**
 * Matched streams per `game.key` for `games`, which should be the games on screen: the fallback searches run
 * for them. `loading` while the index, the guide window or a fallback search is still on its first answer,
 * or while the latest index and guide are being prepared for matching, unless they only refresh the last ones.
 * The guide is read over `opts.window` (the page's window, useGrowingWindow.ts), by default the union of the
 * games' windows.
 */
export function useGameStreams(
  games: readonly Game[],
  enabled = true,
  opts: { window?: GuideSpan } = {},
): { streams: ReadonlyMap<string, StreamMatch[]>; loading: boolean } {
  const on = enabled && games.length > 0;
  const index = useChannelIndex(on);
  const sources = useVisibleSources().data;
  const own = useMemo(() => unionWindow(games), [games]);
  const { from, to } = opts.window ?? own;
  // The whole index first: refs arriving source by source would ask the guide again for each.
  const guide = useGuideWindow(index.channels, from, to, on && !index.loading);
  const now = useNow(MINUTE);

  // Matching waits for prepareMatch, which tokenizes the guide text of the whole index in slices with
  // yields between them rather than in one long task. Until it is done, the last prepared index and guide
  // stay matched.
  const { channels } = index;
  const { programs } = guide;
  const complete = !index.loading && !guide.loading;
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  useEffect(() => {
    if (!on) return;
    const ctrl = new AbortController();
    void prepareMatch(channels, programs, ctrl.signal).then((done) => {
      if (done && !ctrl.signal.aborted) setPrepared({ channels, programs, complete, from, to });
    });
    return () => ctrl.abort();
  }, [on, channels, programs, complete, from, to]);
  const ready = prepared?.channels === channels && prepared.programs === programs;
  // While a guide refresh or an index edit is prepared, the last pair stays current if it held complete
  // answers for the same games' window: the matches, their fallback hits and `loading` stay as they were.
  // Partial answers (the index before its guide) or another window (another day) never stand in, or the
  // fallback would search for games the new guide matches.
  const current = ready || (prepared !== null && prepared.complete && prepared.from === from && prepared.to === to);

  // A new cache whenever the prepared index or guide changes; between those, a game object a poll left as it
  // was keeps its matches, and the minute tick re-matches only a game that stopped or started being current,
  // or whose networks another game's move started or stopped sharing.
  const preparedChannels = prepared?.channels ?? NO_CHANNELS;
  const preparedPrograms = prepared?.programs ?? NO_PROGRAMS;
  const inputs = useMemo(
    () => ({ channels: preparedChannels, programs: preparedPrograms, byGame: new WeakMap<Game, Cached>() }),
    [preparedChannels, preparedPrograms],
  );
  const shared = useMemo(() => sharedNetworks(games), [games]);
  const matched = useMemo(() => {
    const out = new Map<string, StreamMatch[]>();
    for (const g of games) {
      const current = isCurrentGame(g, now);
      const networks = shared.get(g.key) ?? NO_NETWORKS;
      const sharedKey = [...networks].sort().join(' ');
      let cached = inputs.byGame.get(g);
      if (!cached || cached.current !== current || cached.shared !== sharedKey) {
        cached = { current, shared: sharedKey, list: matchGame(g, inputs.channels, inputs.programs, now, networks) };
        inputs.byGame.set(g, cached);
      }
      out.set(g.key, cached.list);
    }
    return out;
  }, [games, inputs, now, shared]);

  const settled = on && complete && current;
  const wanted = useMemo(
    () => (settled ? games.filter((g) => wantsFallback(g, now) && (matched.get(g.key)?.length ?? 0) === 0) : []),
    [settled, games, matched, now],
  );
  const queries = useMemo(() => [...new Set(wanted.flatMap(fallbackQueries))], [wanted]);
  const searches = useQueries({
    queries: queries.map((query) => {
      const args = { query, contentTypes: LIVE, limit: FALLBACK_LIMIT };
      return {
        queryKey: rpcKey('catalog.search', args),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          limited(async () => (await sportsRead('catalog.search', args, signal)) as CatalogSearchResult),
        staleTime: FALLBACK_STALE_MS,
      };
    }),
    combine: combineSearches,
  });

  const streams = useMemo(() => {
    if (wanted.length === 0) return matched;
    const byQuery = new Map(queries.map((q, i) => [q, searches.hits[i]]));
    const out = new Map(matched);
    for (const g of wanted) {
      const hits = fallbackQueries(g).flatMap((q) => byQuery.get(q) ?? []);
      if (hits.length > 0) out.set(g.key, fallbackMatches(g, hits, sources ?? [], now));
    }
    return out;
  }, [wanted, matched, queries, searches.hits, sources, now]);

  return { streams, loading: on && (!complete || !current || searches.pending) };
}
