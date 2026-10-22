/**
 * account: after a playback failure that a full account could explain, asks the core for the
 * source's account status once (`account.status` with `refresh: true`, rate limited in the
 * core) so the error can say "Connection limit reached (2 of 2 in use)". Only Xtream panels
 * report connection counts, so M3U and Stalker sources are never asked.
 *
 * The counts are evidence only when the check itself succeeded just now: a failed check keeps
 * the last good counts in the core's cache, and an old one says nothing about this failure.
 * The provider also counts this app's own connections: the stream that just dropped (panels
 * keep a closed connection counted for a while, so it also covers a channel zapped away
 * from), any recording running on the same source and any download running from it. They go in
 * `own` and `errors.ts` subtracts them; see `connectionsFull` and `connectionsMaybeFull` there.
 */

import { useEffect, useState } from 'react';

import type { AccountStatus } from '@/api/rpc';
import { rpc } from '@/api/transport';

import { classifyStreamError, type StreamErrorInput } from './errors';
import { knownSourceKind, usePlayerStore } from './store';

export type ConnectionCounts = NonNullable<StreamErrorInput['connections']>;

/** Classes a full account shows up as when the provider says nothing more specific. */
const CHECK_FOR: ReadonlySet<string> = new Set(['auth', 'server', 'network', 'timeout', 'generic']);

/** A check older than this when the failure was handled says nothing about it (the core reuses checks up to 20 s old). */
export const FRESH_CHECK_MS = 30_000;
/** How long after this app last played from a source the provider may still count that stream. */
export const OWN_STREAM_WINDOW_MS = 120_000;

/** When each source last had a stream playing in this app. */
const lastPlayingAt = new Map<string, number>();

usePlayerStore.subscribe((s) => {
  const id = s.source?.ref?.sourceId;
  if (id && s.status === 'playing') lastPlayingAt.set(id, Date.now());
});

/** Test seam: forget what played. */
export function resetOwnStreams(): void {
  lastPlayingAt.clear();
}

/** This app played from `sourceId` recently enough that the provider may still count it. */
export function ownStreamRecently(sourceId: string, now: number = Date.now()): boolean {
  const at = lastPlayingAt.get(sourceId);
  return at !== undefined && now - at <= OWN_STREAM_WINDOW_MS;
}

/** The failure is worth an account check: it has a source and a class a full account could hide behind. */
export function shouldCheckConnections(input: StreamErrorInput, sourceId: string | undefined): sourceId is string {
  if (!sourceId || !input.message) return false;
  const kind = knownSourceKind(sourceId);
  if (kind === 'm3u' || kind === 'stalker') return false;
  return CHECK_FOR.has(classifyStreamError({ ...input, connections: null }));
}

/**
 * Counts from a forced check, or null when they are no evidence: no account, no limit, a
 * failed check (its counts are the last good ones) or a check older than the request.
 */
export function countsFromStatus(s: AccountStatus | null | undefined, requestedAt: number, own: number): ConnectionCounts | null {
  if (!s || s.error) return null;
  const max = s.maxConnections ?? 0;
  if (max <= 0) return null;
  const checkedAt = Date.parse(s.checkedAt);
  if (Number.isNaN(checkedAt) || checkedAt < requestedAt - FRESH_CHECK_MS) return null;
  return { active: Math.max(0, s.activeCons ?? 0), max, own };
}

/** Recordings this app is writing from `sourceId` right now; 0 when the list is unavailable. */
async function ownRecordings(sourceId: string): Promise<number> {
  try {
    const list = await rpc('recordings.list');
    return list.filter((r) => r.status === 'recording' && r.ref.sourceId === sourceId).length;
  } catch {
    return 0;
  }
}

/** Connections this app's downloads hold on `sourceId` right now; 0 when the list is unavailable. */
async function ownDownloads(sourceId: string): Promise<number> {
  try {
    const list = await rpc('downloads.list');
    return list.filter((d) => d.status === 'downloading' && d.ref.sourceId === sourceId).reduce((n, d) => n + (d.connections ?? 1), 0);
  } catch {
    return 0;
  }
}

/** Recordings and downloads this app runs from `sourceId`. */
async function ownTransfers(sourceId: string): Promise<number> {
  const [recording, downloading] = await Promise.all([ownRecordings(sourceId), ownDownloads(sourceId)]);
  return recording + downloading;
}

// failover: the same check outside React, for smart reconnect (`reconnect.ts`).
/** Counts for a failure on `sourceId` handled now, as `useConnectionCounts` gets them; null when they are no evidence. */
export async function fetchConnectionCounts(sourceId: string): Promise<ConnectionCounts | null> {
  const requestedAt = Date.now();
  const ownStream = ownStreamRecently(sourceId, requestedAt) ? 1 : 0;
  try {
    const [s, transfers] = await Promise.all([rpc('account.status', { sourceId, refresh: true }), ownTransfers(sourceId)]);
    return countsFromStatus(s, requestedAt, ownStream + transfers);
  } catch {
    return null;
  }
}

/**
 * Connection counts for the current error, or null while unknown, unlimited or not asked.
 * One check per distinct (error, source); a failed check counts as unknown.
 */
export function useConnectionCounts(input: StreamErrorInput, sourceId: string | undefined): ConnectionCounts | null {
  const check = shouldCheckConnections(input, sourceId);
  const key = check ? `${sourceId}\n${input.message ?? ''}` : null;
  const [result, setResult] = useState<{ key: string; counts: ConnectionCounts | null } | null>(null);

  useEffect(() => {
    if (!key || !sourceId) return;
    let live = true;
    const requestedAt = Date.now();
    const ownStream = ownStreamRecently(sourceId, requestedAt) ? 1 : 0;
    Promise.all([rpc('account.status', { sourceId, refresh: true }), ownTransfers(sourceId)])
      .then(([s, transfers]) => {
        if (live) setResult({ key, counts: countsFromStatus(s, requestedAt, ownStream + transfers) });
      })
      .catch(() => {
        if (live) setResult({ key, counts: null });
      });
    return () => {
      live = false;
    };
  }, [key, sourceId]);

  return result && result.key === key ? result.counts : null;
}
