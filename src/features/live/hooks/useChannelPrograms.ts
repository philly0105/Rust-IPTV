import { useMemo } from 'react';

import { useRpcQuery } from '@/api/query';
import type { Channel, EpgProgram, ItemRef, SourceKind } from '@/api/types';

import { mergePrograms } from '../lib/epgMerge';
import { ms } from '../lib/epgTime';
import { usePortalEpg } from './usePortalEpg';
import { useShortEpg } from './useShortEpg';
import { hasAiring, markFromProvider } from '../lib/shortEpg';

const EMPTY_REF: ItemRef = { sourceId: '', contentType: 'live', itemId: '' };
/** `stalker.epg` caps its answer at 50 programmes. */
export const STALKER_RIBBON_LIMIT = 50;

export interface ChannelPrograms {
  /** Start-ordered programmes inside [from, to). */
  programs: EpgProgram[];
  isLoading: boolean;
  /** Set only when nothing could be shown. */
  error: unknown;
  refetch(): void;
}

/**
 * Programmes for one channel's guide ribbon.
 * - xtream / m3u: the XMLTV guide (`epg.programs`).
 * - stalker: the portal's own guide (`stalker.epg`: the airing programme onwards, plus the
 *   archived programmes since `from` for a channel with an archive), merged with the XMLTV guide
 *   when one resolves for the channel (a global EPG URL or a manual mapping). The portal wins
 *   where both cover the same time; XMLTV fills the rest.
 * - xtream with `shortEpg.enabled`: when XMLTV has nothing airing at `shortEpg.guideNow`, the
 *   provider's short guide (`epg.shortEpg`) fills the gaps; XMLTV keeps priority.
 */
export function useChannelPrograms(
  channel: Channel | undefined,
  kind: SourceKind | undefined,
  from: number,
  to: number,
  shortEpg?: { enabled: boolean; guideNow: number },
): ChannelPrograms {
  const ref = channel?.ref ?? EMPTY_REF;
  const isStalker = kind === 'stalker';
  const xmltv = useRpcQuery(
    'epg.programs',
    { ref, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    { enabled: !!channel, staleTime: 5 * 60_000 },
  );
  // `from` is the ribbon's floored window start, so the query key stays stable between renders.
  const past = channel?.archive?.enabled ? { from: new Date(from).toISOString() } : {};
  // Not retried on the client: a silent portal already took 20-40 s to time out. With XMLTV the
  // ribbon keeps showing that; without, it shows the error and its retry button.
  const portal = usePortalEpg({ ref, limit: STALKER_RIBBON_LIMIT, ...past }, { enabled: !!channel && isStalker, staleTime: 5 * 60_000 });

  // guide: Xtream short-EPG fallback, asked only once XMLTV answered without an airing programme.
  const wantShort = kind === 'xtream' && !!shortEpg?.enabled && !!xmltv.data && !hasAiring(xmltv.data, shortEpg.guideNow);
  const short = useShortEpg(channel?.ref, wantShort);

  const programs = useMemo(() => {
    const inWindow = (p: EpgProgram) => ms(p.end) > from && ms(p.start) < to;
    const base = (xmltv.data ?? []).filter(inWindow);
    const fallback = wantShort ? (short ?? []).filter(inWindow) : [];
    if (fallback.length > 0) return mergePrograms(base, fallback);
    if (!isStalker) return [...base].sort((a, b) => ms(a.start) - ms(b.start));
    // The portal's programmes are the provider's guide: series rules and guide search never see them.
    return mergePrograms(markFromProvider((portal.data ?? []).filter(inWindow)), base);
  }, [xmltv.data, portal.data, isStalker, from, to, wantShort, short]);

  if (!isStalker) {
    return {
      programs,
      isLoading: xmltv.isLoading,
      error: xmltv.error,
      refetch: () => void xmltv.refetch(),
    };
  }
  const pending = portal.isLoading || xmltv.isLoading;
  return {
    programs,
    // Show what one side has while the other is still answering.
    isLoading: programs.length === 0 && pending,
    error: programs.length === 0 && !pending ? (portal.error ?? xmltv.error) : null,
    refetch: () => {
      void portal.refetch();
      void xmltv.refetch();
    },
  };
}
