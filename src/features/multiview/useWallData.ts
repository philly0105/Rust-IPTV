/**
 * What the wall reads from the core besides the streams: source names, each account's
 * connection limit, the programme on air per tile, and parental locks.
 */

import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { onAppEvent } from '@/api/events';
import { invalidate, rpcKey, useRpcQuery } from '@/api/query';
import { rpcRaw, type RpcResult } from '@/api/transport';
import { itemKey, type EpgNowNext, type ItemKey, type ParentalMode, type Source } from '@/api/types';

import { accountStatusQuery } from './accountStatus';
import { gateItem } from './addChannel';
import { usePlayerStore } from './deps';
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
  /** Tiles of this source on the wall that open a stream (see `useStreamingTiles`). */
  tiles: number;
  /** This app's other streams from the account: recordings running and the main player. */
  own: number;
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
 * The tiles that open a stream: their source still exists and no parental lock holds them
 * (a locked tile, and one whose lock check failed, stay dark). A tile whose lock is still
 * being checked does not count yet. Reads the same `parental.check` entries as the tiles.
 */
export function useStreamingTiles(
  tiles: readonly MultiviewTile[],
  sources: Map<string, Source>,
  parentalActive: boolean | undefined,
): readonly MultiviewTile[] {
  const checks = useQueries({ queries: tiles.map((t) => lockCheckQuery(t, parentalActive)) });
  const open = tiles.filter((t, i) => sources.has(t.ref.sourceId) && lockGateOf(parentalActive, checks[i]) === 'open');
  const signature = open.map((t) => t.key).join('\n');
  // A new array only when the set of streaming tiles changes, not on every query tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => open, [tiles, signature]);
}

/**
 * Streams this app holds outside the wall, per source: recordings writing now and the main
 * player (an external player too). The provider counts them against the same limit as the
 * tiles, like the player's `connectionLimit.ts` does for its own errors. The page stops the
 * in-app player when it opens (`useMainPlayerHandoff`), so it only counts here when the user
 * started it again on purpose; never twice.
 */
export function useOwnStreams(): ReadonlyMap<string, number> {
  const recordings = useRpcQuery('recordings.list', undefined, { staleTime: 30_000 });
  const mainSource = usePlayerStore((s) => (s.source && s.status !== 'idle' && s.status !== 'error' ? s.source.ref?.sourceId : undefined));
  return useMemo(() => {
    const m = new Map<string, number>();
    const bump = (id: string): void => void m.set(id, (m.get(id) ?? 0) + 1);
    for (const r of recordings.data ?? []) if (r.status === 'recording') bump(r.ref.sourceId);
    if (mainSource) bump(mainSource);
    return m;
  }, [recordings.data, mainSource]);
}

/**
 * Connections in use per account against its limit (`account.status`, cached by the core):
 * the tiles that open a stream plus this app's own streams. Only Xtream panels report a
 * limit (the player's `connectionLimit.ts` asks the same way), so only Xtream sources are
 * asked: every one with a tile on the wall, without waiting for the tiles' parental checks,
 * so the banner is ready as soon as the checks are (it does not push the wall down later).
 */
export function useSourceLoads(tiles: readonly MultiviewTile[], sources: Map<string, Source>, parentalActive: boolean | undefined): SourceLoad[] {
  const streaming = useStreamingTiles(tiles, sources, parentalActive);
  const own = useOwnStreams();
  const counts = useMemo(() => tileCounts(streaming), [streaming]);
  const asked = tileCounts(tiles).filter(([id]) => sources.get(id)?.kind === 'xtream');
  const statuses = useQueries({ queries: asked.map(([sourceId]) => accountStatusQuery(sourceId)) });
  const maxBySource = new Map<string, number>();
  asked.forEach(([sourceId], i) => {
    const max = statuses[i]?.data?.maxConnections ?? 0;
    if (max > 0) maxBySource.set(sourceId, max);
  });
  return counts.map(([sourceId, n]) => ({
    sourceId,
    name: sources.get(sourceId)?.name ?? '',
    tiles: n,
    own: own.get(sourceId) ?? 0,
    max: maxBySource.get(sourceId) ?? 0,
  }));
}

/** Connections an account has in use: its streaming tiles plus this app's own streams. */
export function inUse(l: SourceLoad): number {
  return l.tiles + l.own;
}

/** Sources whose streams in use outnumber the account's connections. */
export function overLimit(loads: readonly SourceLoad[]): SourceLoad[] {
  return loads.filter((l) => l.max > 0 && inUse(l) > l.max);
}

/** The programme on air per tile (guide data), refreshed every minute. */
export function useNowPlaying(tiles: readonly MultiviewTile[]): Map<ItemKey, string> {
  const refs = useMemo(() => tiles.map((t) => t.ref), [tiles]);
  const args = { refs };
  const q = useQuery({
    queryKey: rpcKey('epg.nowNext', args),
    queryFn: async ({ signal }) => (await rpcRaw('epg.nowNext', args, { signal })) as Record<ItemKey, EpgNowNext>,
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

type LockCheck = { isPending: boolean; isError: boolean; data?: RpcResult<'parental.check'> | undefined };

/** One tile's `parental.check` query; the tile and the wall's connection count share it. */
function lockCheckQuery(tile: MultiviewTile, parentalActive: boolean | undefined) {
  const args = { items: [gateItem(tile)] };
  return {
    queryKey: rpcKey('parental.check', args),
    queryFn: async ({ signal }: { signal: AbortSignal }) => (await rpcRaw('parental.check', args, { signal })) as RpcResult<'parental.check'>,
    enabled: parentalActive === true,
    staleTime: 30_000,
  };
}

/** A tile's gate from the parental state and its check. Fails closed: a failed check is `error`. */
export function lockGateOf(parentalActive: boolean | undefined, check: LockCheck | undefined): LockGate {
  if (parentalActive === undefined) return 'pending';
  if (!parentalActive) return 'open';
  if (!check || check.isPending) return 'pending';
  if (check.isError) return 'error';
  return (check.data?.length ?? 0) > 0 ? 'locked' : 'open';
}

/**
 * One tile's lock: asked per tile, so a new tile never holds up the ones already playing.
 * Fails closed like the gate: a check that failed keeps the tile dark until a retry answers.
 */
export function useTileLock(tile: MultiviewTile, parentalActive: boolean | undefined): { gate: LockGate; recheck(): void } {
  const check = useQuery(lockCheckQuery(tile, parentalActive));
  const recheck = (): void => void check.refetch();
  return { gate: lockGateOf(parentalActive, check), recheck };
}
