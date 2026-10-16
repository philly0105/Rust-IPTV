/**
 * The selected programme's description in the guide (L3-serve-ui-6): the grid asks epg.grid
 * without descriptions, so the detail asks epg.programs for the programme's own span when it
 * opens. A core that still sends descriptions with the grid needs no request.
 */

import type { QueryClient } from '@tanstack/react-query';

import { rpcKey, useRpcQuery } from '@/api/query';
import { rpcRaw } from '@/api/transport';
import type { EpgProgram, ItemRef } from '@/api/types';

import { ms } from '../lib/epgTime';

/** epg.programs args for `program` (display time, shown `offsetMs` later than the guide says). */
export function programDetailArgs(ref: ItemRef, program: EpgProgram, offsetMs: number) {
  return {
    ref,
    from: new Date(ms(program.start) - offsetMs).toISOString(),
    to: new Date(ms(program.end) - offsetMs).toISOString(),
  };
}

/** Whether the detail of `program` has to ask for its description. */
function needsFetch(program: EpgProgram): boolean {
  return program.description === undefined && !program.fromProvider;
}

/** Fetches the description ahead, from the press that is about to open the detail. */
export function prefetchProgramDescription(client: QueryClient, ref: ItemRef, program: EpgProgram, offsetMs: number): void {
  if (!needsFetch(program)) return;
  const args = programDetailArgs(ref, program, offsetMs);
  void client.prefetchQuery({ queryKey: rpcKey('epg.programs', args), queryFn: () => rpcRaw('epg.programs', args) });
}

/** `program`'s description, from the grid's answer or the guide; `pending` while it is asked for. */
export function useProgramDescription(ref: ItemRef, program: EpgProgram, offsetMs: number): { description: string | undefined; pending: boolean } {
  const fetch = needsFetch(program);
  const q = useRpcQuery('epg.programs', programDetailArgs(ref, program, offsetMs), { enabled: fetch });
  if (!fetch) return { description: program.description ?? undefined, pending: false };
  const at = ms(program.start) - offsetMs;
  const list = q.data ?? [];
  const match = list.find((p) => ms(p.start) === at && p.title === program.title) ?? list.find((p) => ms(p.start) === at);
  return { description: match?.description ?? undefined, pending: q.isPending };
}
