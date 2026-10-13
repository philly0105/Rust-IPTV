import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import { itemKey, type EpgProgram, type ItemRef, type SourceKind } from '@/api/types';

import { markFromProvider, SHORT_EPG_LIMIT, SHORT_EPG_SCOPE, shortEpgEnabled } from '../lib/shortEpg';
import { StalkerPreviewQueue } from '../lib/stalkerPreviewQueue';

/** True when the Xtream short-EPG fallback applies to a source of `kind`. */
export function useShortEpgEnabled(kind: SourceKind | undefined): boolean {
  const settings = useRpcQuery('settings.get', undefined, { staleTime: 60_000, enabled: kind === 'xtream' });
  return shortEpgEnabled(kind, settings.data);
}

const fetchShortEpg = async (ref: ItemRef): Promise<EpgProgram[]> =>
  markFromProvider(await rpc('epg.shortEpg', { ref, limit: SHORT_EPG_LIMIT }));

/**
 * The panel's short EPG for the channels in `refs` (visible rows without XMLTV, in display
 * order). Throttled through the same per-source queue as the Stalker previews: two requests at
 * a time, at most 30 per sync, answers reused for 10 minutes or until their programme ends.
 * Core caches and deduplicates again, so a remount never reaches the panel twice.
 */
export function useShortEpgPreviews(
  sourceId: string,
  enabled: boolean,
  refs: readonly ItemRef[],
  now: number,
): (ref: ItemRef) => EpgProgram[] | undefined {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const bumpRef = useRef(bump);
  bumpRef.current = bump;
  const queue = useMemo(
    () => new StalkerPreviewQueue(fetchShortEpg, () => bumpRef.current(), { sourceId, scope: SHORT_EPG_SCOPE, ttlMs: 10 * 60_000 }),
    [sourceId],
  );
  useEffect(() => () => queue.reset(), [queue]);

  const refsRef = useRef(refs);
  refsRef.current = refs;
  const refsKey = refs.map(itemKey).join('\n');
  useEffect(() => {
    if (enabled) queue.sync(refsRef.current);
  }, [queue, enabled, refsKey, now]);

  return useCallback(
    (ref: ItemRef) => (enabled ? queue.get(ref) : undefined),
    // `version` changes whenever the queue stores an answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, enabled, version],
  );
}

/** One channel's short EPG (ribbon, playing channel), tagged as the provider's. */
export function useShortEpg(ref: ItemRef | undefined, enabled: boolean): EpgProgram[] | undefined {
  const q = useRpcQuery(
    'epg.shortEpg',
    { ref: ref ?? { sourceId: '', contentType: 'live', itemId: '' }, limit: SHORT_EPG_LIMIT },
    { enabled: enabled && !!ref, staleTime: 5 * 60_000 },
  );
  return useMemo(() => (q.data ? markFromProvider(q.data) : undefined), [q.data]);
}
