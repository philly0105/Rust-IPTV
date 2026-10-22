/**
 * downloads: tells the core which source this player plays from (`downloads.playback`), so
 * downloads from that source leave playback the connections its account allows and yield when it
 * needs one. Sent when the source changes, renewed while it plays (the core lets a report lapse
 * after 90 s, so a closed window never holds downloads back for long) and cleared on stop. A
 * zap's placeholder keeps reporting its source, so a download cannot take the connection between
 * two channels. A local file (My Videos) uses no provider connection and is not reported.
 *
 * The core answers a report once the downloads it stopped have let go of their connections. A
 * player that connects to the provider itself (embedded mpv, an external player, a stream the
 * browser loads directly) waits for that answer first (`reportAnswered`); a stream through the
 * media proxy does not need to, since the proxy makes room on its own.
 */

import { rpc } from '@/api/transport';
import type { PlayerSource } from '@/api/types';

import { usePlayerStore, type PlayerState } from './store';

/** How often a report is renewed while something plays (the core keeps one for 90 s). */
export const RENEW_MS = 30_000;
/** Longest wait for the core's answer before a player connects anyway (the core waits up to about 2.3 s). */
export const REPORT_WAIT_MS = 3_000;

/** This window's player: the core keeps one report per player. */
const clientId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** The last report that named a source, until the core has answered it. */
let unanswered: { sourceId: string; answered: Promise<void> } | null = null;

/** The provider source a player state holds a connection to, if any. */
export function playingSource(s: Pick<PlayerState, 'source' | 'status'>): string | undefined {
  if (s.status === 'idle' || s.status === 'error') return undefined;
  if (!s.source || s.source.kind === 'file') return undefined;
  return s.source.ref?.sourceId || undefined;
}

/**
 * Resolves once the core has answered the report naming `source`'s provider, or after
 * `REPORT_WAIT_MS`; null when no such report waits for its answer, so the caller goes on at once.
 */
export function reportAnswered(source: PlayerSource | undefined): Promise<void> | null {
  const sourceId = source && source.kind !== 'file' ? source.ref?.sourceId : undefined;
  const pending = unanswered;
  if (!sourceId || pending?.sourceId !== sourceId) return null;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, REPORT_WAIT_MS);
    void pending.answered.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Starts reporting; returns the unbind, which clears the report. */
export function bindPlaybackReport(): () => void {
  let sent: string | undefined;
  let renew: ReturnType<typeof setInterval> | null = null;
  const send = (sourceId: string | undefined): void => {
    const answered = rpc('downloads.playback', { clientId, sourceIds: sourceId ? [sourceId] : [] }).then(
      () => undefined,
      () => undefined,
    );
    if (!sourceId) return;
    const entry = { sourceId, answered };
    unanswered = entry;
    void answered.then(() => {
      if (unanswered === entry) unanswered = null;
    });
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
    unanswered = null;
  };
}
