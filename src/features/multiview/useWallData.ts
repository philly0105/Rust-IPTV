/**
 * What the wall reads from the core besides the streams: source names, each account's
 * connection limit, the programme on air per tile, and parental locks.
 */

import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { onAppEvent } from '@/api/events';
import { invalidate, rpcKey, useRpcQuery } from '@/api/query';
import type { AccountStatus } from '@/api/rpc';
import { rpcRaw } from '@/api/transport';
import { itemKey, type EpgNowNext, type ItemKey, type ParentalMode, type Source } from '@/api/types';

import { gateItem } from './addChannel';
import type { MultiviewTile } from './types';

/** Sources by id, plus whether the list has arrived (a tile of an unknown source is stale only then). */
export function useSources(enabled = true): { byId: Map<string, Source>; loaded: boolean; error: unknown; refetch(): void } {
  const sources = useRpcQuery('sources.list', undefined, { enabled });
  const byId = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s])), [sources.data]);
  return { byId, loaded: sources.isSuccess, error: sources.error, refetch: () => void sources.refetch() };
}

export interface SourceLoad {
  sourceId: string;
  name: string;
  /** Tiles of this source on the wall. */
  tiles: number;
  /** The account's connection limit; 0 = none reported (unlimited or unknown). */
  max: number;
}

/** Tiles per source, in wall order. */
export function tileCounts(tiles: readonly Pick<MultiviewTile, 'ref'>[]): [sourceId: string, tiles: number][] {
  const m = new Map<string, number>();
  for (const t of tiles) m.set(t.ref.sourceId, (m.get(t.ref.sourceId) ?? 0) + 1);
  return [...m.entries()];
}

/**
 * Tiles per source against each account's limit (`account.status`, cached by the core).
 * Only Xtream panels report a limit (the player's `connectionLimit.ts` asks the same way),
 * so only Xtream sources with tiles are asked.
 */
export function useSourceLoads(tiles: readonly Pick<MultiviewTile, 'ref'>[], sources: Map<string, Source>): SourceLoad[] {
  const counts = useMemo(() => tileCounts(tiles), [tiles]);
  const asked = counts.filter(([id]) => sources.get(id)?.kind === 'xtream');
  const statuses = useQueries({
    queries: asked.map(([sourceId]) => ({
      queryKey: rpcKey('account.status', { sourceId }),
      queryFn: async () => (await rpcRaw('account.status', { sourceId })) as AccountStatus | null,
      staleTime: 60_000,
    })),
  });
  const maxBySource = new Map<string, number>();
  asked.forEach(([sourceId], i) => {
    const max = statuses[i]?.data?.maxConnections ?? 0;
    if (max > 0) maxBySource.set(sourceId, max);
  });
  return counts.map(([sourceId, n]) => ({
    sourceId,
    name: sources.get(sourceId)?.name ?? '',
    tiles: n,
    max: maxBySource.get(sourceId) ?? 0,
  }));
}

/** Sources whose tiles outnumber the account's connections. */
export function overLimit(loads: readonly SourceLoad[]): SourceLoad[] {
  return loads.filter((l) => l.max > 0 && l.tiles > l.max);
}

/** The programme on air per tile (guide data), refreshed every minute. */
export function useNowPlaying(tiles: readonly MultiviewTile[]): Map<ItemKey, string> {
  const refs = useMemo(() => tiles.map((t) => t.ref), [tiles]);
  const args = { refs };
  const q = useQuery({
    queryKey: rpcKey('epg.nowNext', args),
    queryFn: async () => (await rpcRaw('epg.nowNext', args)) as Record<ItemKey, EpgNowNext>,
    enabled: refs.length > 0,
    staleTime: 60_000,
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
  return useMemo(() => {
    const out = new Map<ItemKey, string>();
    const data = q.data ?? {};
    for (const ref of refs) {
      const title = data[itemKey(ref)]?.now?.title;
      if (title) out.set(itemKey(ref), title);
    }
    return out;
  }, [q.data, refs]);
}

/** `error`: the lock check failed; the tile stays closed until a retry answers. */
export type LockGate = 'pending' | 'locked' | 'open' | 'error';

export interface ParentalState {
  /** Controls on and not unlocked: tiles ask `parental.check` first. Undefined while unknown. */
  active: boolean | undefined;
  /** How a locked tile unlocks: the gate's dialog (ask) or a plain PIN prompt (hide). */
  mode: ParentalMode;
}

/** The parental state the wall needs; follows `parental.changed`. */
export function useParentalState(): ParentalState {
  const status = useRpcQuery('parental.status', undefined, { staleTime: 30_000 });
  // Any parental change (PIN, mode, locks, unlock, expiry) asks status and every tile again.
  useEffect(() => onAppEvent('parental.changed', () => void invalidate('parental.')), []);
  const mode = status.data?.mode ?? 'hide';
  if (status.isPending) return { active: undefined, mode };
  // No answer (older core, failed call): nothing to enforce here; adding still asks the gate.
  if (status.isError || !status.data) return { active: false, mode };
  return { active: status.data.enabled && !status.data.unlocked, mode };
}

/**
 * One tile's lock: asked per tile, so a new tile never holds up the ones already playing.
 * Fails closed like the gate: a check that failed keeps the tile dark until a retry answers.
 */
export function useTileLock(tile: MultiviewTile, parentalActive: boolean | undefined): { gate: LockGate; recheck(): void } {
  const args = { items: [gateItem(tile)] };
  const check = useRpcQuery('parental.check', args, { enabled: parentalActive === true, staleTime: 30_000 });
  const recheck = (): void => void check.refetch();
  if (parentalActive === undefined) return { gate: 'pending', recheck };
  if (!parentalActive) return { gate: 'open', recheck };
  if (check.isPending) return { gate: 'pending', recheck };
  if (check.isError) return { gate: 'error', recheck };
  return { gate: check.data.length > 0 ? 'locked' : 'open', recheck };
}
