import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { rpcKey, useRpcQuery } from '@/api/query';
import { rpcRaw } from '@/api/transport';
import type { Channel, ContentType } from '@/api/types';

import { buildLocks, locksShown, useParentalStatus, type ParentalLocks } from '../deps';

const LOCKS_STALE_MS = 30_000;
const NONE: ParentalLocks = { channelLocked: () => false, categoryLocked: () => false };

interface Scope {
  sourceId: string;
  contentType: ContentType;
}

const scopeKey = (sourceId: string, contentType: string) => `${sourceId}|${contentType}`;
const adultIds = (results: { data?: string[] }[]) => results.map((r) => r.data);

/**
 * What the parental gate will ask the PIN for among a custom list's channels (C2), so the rows
 * can mark it and keep its programme titles back, as Live's `useParentalLocks` does for one
 * source. A list mixes sources, and live with radio, so this reads the whole lock list once
 * (`parental.locks` without a source) and the adult groups per source and kind, then judges each
 * channel by its own source's rule. A list has no groups, so `categoryLocked` is always false.
 * Nothing is marked outside Ask mode.
 */
export function useListLocks(channels: readonly Channel[]): ParentalLocks {
  const status = useParentalStatus().data;
  const on = locksShown(status);
  const autoAdult = on && status?.autoAdult === true;
  const locks = useRpcQuery('parental.locks', {}, { enabled: on, staleTime: LOCKS_STALE_MS });
  const scopes = useMemo(() => {
    const seen = new Map<string, Scope>();
    for (const c of channels) seen.set(scopeKey(c.ref.sourceId, c.ref.contentType), { sourceId: c.ref.sourceId, contentType: c.ref.contentType });
    return [...seen.values()];
  }, [channels]);
  const adult = useQueries({
    queries: scopes.map((s) => ({
      queryKey: rpcKey('parental.adultCategories', s),
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await rpcRaw('parental.adultCategories', s, { signal })) as string[],
      enabled: autoAdult,
      staleTime: LOCKS_STALE_MS,
    })),
    combine: adultIds,
  });
  return useMemo(() => {
    if (!on) return NONE;
    const byScope = new Map<string, ParentalLocks>();
    scopes.forEach((s, i) =>
      byScope.set(scopeKey(s.sourceId, s.contentType), buildLocks(locks.data ?? [], (autoAdult && adult[i]) || [], s.sourceId, s.contentType)),
    );
    return {
      channelLocked: (ch) => !!ch && (byScope.get(scopeKey(ch.ref.sourceId, ch.ref.contentType))?.channelLocked(ch) ?? false),
      categoryLocked: () => false,
    };
  }, [on, autoAdult, scopes, locks.data, adult]);
}
