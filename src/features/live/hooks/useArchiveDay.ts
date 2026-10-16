import { useQuery } from '@tanstack/react-query';

import { rpc } from '@/api/transport';
import type { EpgProgram, ItemRef, SourceKind } from '@/api/types';

import { programsInDay } from '../lib/archive';
import { MINUTE, shiftPrograms } from '../lib/epgTime';
import { markFromProvider, SHORT_EPG_LIMIT } from '../lib/shortEpg';

/** `stalker.epg` caps its answer at 50 programmes. */
const STALKER_LIMIT = 50;

export interface ArchiveDayArgs {
  ref: ItemRef | undefined;
  kind: SourceKind | undefined;
  /** Display-time `[start, end)` of the day. */
  start: number;
  end: number;
  /** `settings.epgOffsetMinutes`: programmes show this much later than the guide says. */
  offsetMinutes: number;
  /** Today: the provider's short EPG may fill a day the archive table leaves empty. */
  isToday: boolean;
  shortEpg: boolean;
}

/**
 * One day of a channel's programmes, in display time: the XMLTV guide first; when it has
 * nothing for the day, the provider's own guide (Xtream archive table, then the short EPG for
 * today; Stalker's `stalker.epg` from the day's start). Provider programmes carry `fromProvider`.
 */
export async function loadArchiveDay(a: ArchiveDayArgs & { ref: ItemRef }): Promise<EpgProgram[]> {
  const offsetMs = a.offsetMinutes * MINUTE;
  const from = new Date(a.start - offsetMs).toISOString();
  const to = new Date(a.end - offsetMs).toISOString();
  const day = (list: readonly EpgProgram[]) => programsInDay(shiftPrograms([...list], a.offsetMinutes), a.start, a.end);

  const xmltv = day(await rpc('epg.programs', { ref: a.ref, from, to }));
  if (xmltv.length > 0) return xmltv;

  if (a.kind === 'xtream') {
    const table = day(await rpc('catchup.programs', { ref: a.ref, from, to }));
    if (table.length > 0) return markFromProvider(table);
    if (a.isToday && a.shortEpg) return markFromProvider(day(await rpc('epg.shortEpg', { ref: a.ref, limit: SHORT_EPG_LIMIT })));
    return [];
  }
  if (a.kind === 'stalker') {
    return markFromProvider(day(await rpc('stalker.epg', { ref: a.ref, limit: STALKER_LIMIT, from })));
  }
  return [];
}

export function useArchiveDay(a: ArchiveDayArgs) {
  const { ref } = a;
  return useQuery({
    queryKey: ['archive-day', ref?.sourceId, ref?.itemId, a.kind, a.start, a.end, a.offsetMinutes, a.isToday, a.shortEpg],
    queryFn: () => (ref ? loadArchiveDay({ ...a, ref }) : Promise.resolve([])),
    enabled: !!ref && !!a.kind,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
