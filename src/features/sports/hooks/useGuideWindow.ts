/**
 * Guide programmes of the indexed channels over a window, for matching games by title and description.
 * `epg.grid` rather than `epg.search`: search reads titles only and maps channels by exact name, while US
 * guides put the matchup in the description and the grid also maps channels by fuzzy name. Keys stay
 * `rpcKey('epg.grid', ...)`, so guide refreshes refetch them.
 */

import { hashKey, useQueries, type QueryKey, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import { rpcKey } from '@/api/query';
import type { EpgProgram, ItemKey, ItemRef, Settings } from '@/api/types';
import { DAY, MINUTE, shiftProgram } from '@/features/live/lib/epgTime';
import { useSettingsValue } from '@/shell/useSettings';

import { sportsRead } from './sportsRead';
import type { IndexedChannel } from './useChannelIndex';

/** Refs per `epg.grid` call (the core takes up to 2000; smaller answers parse without a long task). */
export const GRID_CHUNK = 500;
/** The window snaps outward to this step, so the query keys hold still while games move a few minutes. */
const WINDOW_STEP = 30 * MINUTE;
/** The core refuses a longer grid span. */
const MAX_SPAN = 31 * DAY;

type Grid = Record<ItemKey, EpgProgram[]>;

const selectOffset = (s: Settings) => s.epgOffsetMinutes;

interface GridAnswers {
  grids: (Grid | undefined)[];
  pending: boolean;
}

// Module-level, so useQueries re-runs it only when an answer changes.
function combineGrids(results: UseQueryResult<Grid>[]): GridAnswers {
  return { grids: results.map((r) => r.data), pending: results.some((r) => r.isPending) };
}

const hashes = new WeakMap<readonly ItemRef[], Map<string, string>>();

/**
 * TanStack's own hash (so other `epg.grid` readers share the entry), made once per refs chunk and window:
 * a key holds up to 500 refs, and every render would otherwise serialize all of them (as useWatched.ts).
 */
function gridKeyHash(key: QueryKey): string {
  const args = key[1] as { refs: readonly ItemRef[]; from: string; to: string };
  let byWindow = hashes.get(args.refs);
  if (!byWindow) {
    byWindow = new Map();
    hashes.set(args.refs, byWindow);
  }
  const window = `${args.from}|${args.to}`;
  let hash = byWindow.get(window);
  if (hash === undefined) {
    hash = hashKey(key);
    byWindow.set(window, hash);
  }
  return hash;
}

/**
 * The refs to ask, one per channel, in chunks. Copies of one channel (HD, FHD, backup) with the same guide
 * id are each asked too: the core resolves every ref with its own manual mapping and guide shift, and no
 * command lists those short of an `epg.resolve` per channel. The core reads each guide channel once per call.
 */
function gridChunks(channels: readonly IndexedChannel[]): ItemRef[][] {
  const chunks: ItemRef[][] = [];
  for (let i = 0; i < channels.length; i += GRID_CHUNK) chunks.push(channels.slice(i, i + GRID_CHUNK).map((c) => c.channel.ref));
  return chunks;
}

const NO_PROGRAMS = new Map<ItemKey, EpgProgram[]>();

const shiftedLists = new WeakMap<EpgProgram[], { offset: number; list: EpgProgram[] }>();
const shiftedOnes = new WeakMap<EpgProgram, { offset: number; program: EpgProgram }>();

/**
 * `shiftPrograms`, kept per answered list and per programme for the offset. Matching tokenizes each
 * programme once per object (match.ts), and after a guide refresh the queries' structural sharing keeps
 * the lists and programmes that did not change as they were, so only the new ones need it. A guide offset
 * made new objects on every recompute instead, so all of them were tokenized again (F5-1).
 */
function shiftedList(list: EpgProgram[], offset: number): EpgProgram[] {
  if (!offset) return list;
  const hit = shiftedLists.get(list);
  if (hit?.offset === offset) return hit.list;
  const out = list.map((p) => {
    const one = shiftedOnes.get(p);
    if (one?.offset === offset) return one.program;
    const program = shiftProgram(p, offset);
    shiftedOnes.set(p, { offset, program });
    return program;
  });
  shiftedLists.set(list, { offset, list: out });
  return out;
}

/**
 * Programmes per channel overlapping [`from`, `to`) in display time (`settings.epgOffsetMinutes` applied, as
 * the guide shows them). The request window is the display window moved back by the offset, as the guide
 * asks; channels without a guide are left out of the map. The map stays empty until every chunk has
 * answered, so the games are matched against the guide once rather than once per chunk. The chunks wait
 * their turn in the page's read limit (sportsRead.ts), first chunk first.
 */
export function useGuideWindow(
  channels: readonly IndexedChannel[],
  from: number,
  to: number,
  enabled: boolean,
): { programs: Map<ItemKey, EpgProgram[]>; loading: boolean } {
  const settings = useSettingsValue(selectOffset);
  const offset = settings.data ?? 0;
  const end = Math.ceil(to / WINDOW_STEP) * WINDOW_STEP;
  const start = Math.max(Math.floor(from / WINDOW_STEP) * WINDOW_STEP, end - MAX_SPAN);
  const rawFrom = new Date(start - offset * MINUTE).toISOString();
  const rawTo = new Date(end - offset * MINUTE).toISOString();
  const chunks = useMemo(() => gridChunks(channels), [channels]);
  // Wait for the offset: asking with 0 first would fetch every chunk twice.
  const on = enabled && !settings.isPending && end > start;
  const answers = useQueries({
    queries: chunks.map((refs) => {
      const args = { refs, from: rawFrom, to: rawTo, withDescription: true };
      return {
        queryKey: rpcKey('epg.grid', args),
        queryKeyHashFn: gridKeyHash,
        queryFn: async ({ signal }: { signal: AbortSignal }) => (await sportsRead('epg.grid', args, signal)) as Grid,
        enabled: on,
      };
    }),
    combine: combineGrids,
  });
  const programs = useMemo(() => {
    if (answers.pending) return NO_PROGRAMS;
    const map = new Map<ItemKey, EpgProgram[]>();
    for (const grid of answers.grids) {
      if (!grid) continue;
      for (const [key, list] of Object.entries(grid) as [ItemKey, EpgProgram[]][]) {
        if (list.length === 0) continue;
        map.set(key, shiftedList(list, offset));
      }
    }
    return map;
  }, [answers.grids, answers.pending, offset]);
  return { programs, loading: on && answers.pending };
}
