/**
 * downloads: tells the core which source this player plays from (`downloads.playback`), so
 * downloads from that source leave playback the connections its account allows and yield when it
 * needs one. Sent when the source changes, renewed while it plays (the core lets a report lapse
 * after 90 s, so a closed window never holds downloads back for long) and cleared on stop. A
 * zap's placeholder keeps reporting its source, so a download cannot take the connection between
 * two channels. A local file (My Videos) uses no provider connection and is not reported.
 */

import { rpc } from '@/api/transport';

import { usePlayerStore, type PlayerState } from './store';

/** How often a report is renewed while something plays (the core keeps one for 90 s). */
export const RENEW_MS = 30_000;

/** This window's player: the core keeps one report per player. */
const clientId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** The provider source a player state holds a connection to, if any. */
export function playingSource(s: Pick<PlayerState, 'source' | 'status'>): string | undefined {
  if (s.status === 'idle' || s.status === 'error') return undefined;
  if (!s.source || s.source.kind === 'file') return undefined;
  return s.source.ref?.sourceId || undefined;
}

/** Starts reporting; returns the unbind, which clears the report. */
export function bindPlaybackReport(): () => void {
  let sent: string | undefined;
  let renew: ReturnType<typeof setInterval> | null = null;
  const send = (sourceId: string | undefined): void => {
    rpc('downloads.playback', { clientId, sourceIds: sourceId ? [sourceId] : [] }).catch(() => undefined);
  };
  const sync = (s: Pick<PlayerState, 'source' | 'status'>): void => {
    const next = playingSource(s);
    if (next === sent) return;
    sent = next;
    send(next);
    if (renew) clearInterval(renew);
    renew = next ? setInterval(() => send(sent), RENEW_MS) : null;
  };
  sync(usePlayerStore.getState());
  const unsubscribe = usePlayerStore.subscribe(sync);
  return () => {
    unsubscribe();
    if (renew) clearInterval(renew);
    if (sent) send(undefined);
    sent = undefined;
  };
}
