import { useRpcQuery } from '@/api/query';
import { itemKey, type Channel, type EpgNowNext, type ItemRef, type RecentEntry } from '@/api/types';

const EMPTY_REF: ItemRef = { sourceId: '', contentType: 'live', itemId: '' };
/** Enough history to find a channel among the films and episodes watched since. */
const RECENT_LIMIT = 30;

export interface LastChannel {
  entry: RecentEntry;
  /** The catalog row, once it is in; undefined when the channel is gone from the source. */
  channel?: Channel;
  nowNext?: EpgNowNext;
}

/**
 * The channel last watched here, for the idle stage's Resume (CB-AUTOPLAY-LAST): the newest
 * `recent.list` entry of the kind the page shows (a live channel or a radio station) that
 * `accept` takes (one of this source's, one in this list). The history is the core's, so it
 * survives a restart, which the player's own resume record (session storage) does not.
 * Asks nothing while `enabled` is false (something plays).
 */
export function useLastChannel(opts: {
  contentType: 'live' | 'radio';
  sourceId?: string;
  accept?: (ref: ItemRef) => boolean;
  enabled: boolean;
  epgOffsetMinutes?: number;
}): LastChannel | undefined {
  const { contentType, sourceId, accept, enabled } = opts;
  const recent = useRpcQuery('recent.list', sourceId ? { sourceId, limit: RECENT_LIMIT } : { limit: RECENT_LIMIT }, {
    enabled: enabled && sourceId !== '',
    staleTime: 60_000,
  });
  const entry = enabled ? recent.data?.find((e) => e.ref.contentType === contentType && (!accept || accept(e.ref))) : undefined;
  const ref = entry?.ref ?? EMPTY_REF;
  const item = useRpcQuery('catalog.item', { ref }, { enabled: !!entry, staleTime: 5 * 60_000 });
  const offset = opts.epgOffsetMinutes ?? 0;
  const nowNext = useRpcQuery('epg.nowNext', offset ? { refs: [ref], offsetMinutes: offset } : { refs: [ref] }, {
    enabled: !!entry && contentType === 'live',
    staleTime: 60_000,
  });
  if (!entry) return undefined;
  const channel = item.data && 'isRadio' in item.data ? (item.data as Channel) : undefined;
  return { entry, channel, nowNext: nowNext.data?.[itemKey(ref)] };
}
