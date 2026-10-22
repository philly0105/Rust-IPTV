/**
 * downloads: the wall's `downloads.playback` report, the multi-view counterpart of the main
 * player's (`src/features/player/playbackReport.ts`, which reports one source and stops when the
 * wall opens). Every tile that is not locked holds a connection to its source, or is about to, so
 * the wall reports one entry per tile (two tiles on one source count two): downloads from that
 * source leave the wall the connections its account allows, and yield when a tile needs one. The
 * report goes out when the tiles change (once for tiles that start together), is renewed while
 * any tile plays (the core lets a report lapse after 90 s) and is cleared when the last tile stops.
 *
 * The core answers a report once the downloads it stopped have let go. A tile that loads from the
 * provider directly (the browser without the media proxy) waits for that answer before it asks
 * for the stream (`wallReportAnswered`); the proxy makes room on its own.
 */

import { rpc } from '@/api/transport';

/** How often the report is renewed, as the main player's (the core keeps one for 90 s). */
export const WALL_RENEW_MS = 30_000;
/** Longest wait for the core's answer before a tile connects anyway, as the main player's. */
export const WALL_REPORT_WAIT_MS = 3_000;

/** The wall's own player id: the core keeps one report per player. */
const clientId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `wall-${crypto.randomUUID()}`
    : `wall-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** Source of every tile that plays, by tile. */
const playing = new Map<string, string>();
let renew: ReturnType<typeof setInterval> | null = null;
/** What the last report said, sorted (a rebuilt tile does not send the same report again). */
let sent = '';
/** The report about to go out (sent once the current task's tile changes are in). */
let next: { answered: Promise<void>; settle: () => void } | null = null;
/** The last report sent, until the core has answered it. */
let unanswered: { sourceIds: readonly string[]; answered: Promise<void> } | null = null;

function send(): Promise<void> {
  const sourceIds = [...playing.values()];
  sent = [...sourceIds].sort().join('\n');
  const answered = rpc('downloads.playback', { clientId, sourceIds }).then(
    () => undefined,
    () => undefined,
  );
  const entry = { sourceIds, answered };
  unanswered = sourceIds.length > 0 ? entry : null;
  void answered.then(() => {
    if (unanswered === entry) unanswered = null;
  });
  return answered;
}

function schedule(): void {
  if (next) return;
  let settle: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => (settle = resolve));
  next = { answered, settle };
  queueMicrotask(() => {
    const pending = next;
    next = null;
    const same = [...playing.values()].sort().join('\n') === sent;
    if (renew) clearInterval(renew);
    renew = playing.size > 0 ? setInterval(() => void send(), WALL_RENEW_MS) : null;
    if (same) {
      pending?.settle();
      return;
    }
    void send().then(() => pending?.settle());
  });
}

/** The tile `key` plays (or is about to) from `sourceId`. */
export function tilePlaying(key: string, sourceId: string): void {
  if (playing.get(key) === sourceId) return;
  playing.set(key, sourceId);
  schedule();
}

/** The tile `key` holds no connection any more (closed, failed, locked). */
export function tileStopped(key: string): void {
  if (!playing.delete(key)) return;
  schedule();
}

/**
 * Resolves once the core has answered the report naming `sourceId`, or after
 * `WALL_REPORT_WAIT_MS`; null when no such report waits for its answer, so the tile goes on at once.
 */
export function wallReportAnswered(sourceId: string): Promise<void> | null {
  const pending = next?.answered ?? (unanswered?.sourceIds.includes(sourceId) ? unanswered.answered : null);
  if (!pending || ![...playing.values()].includes(sourceId)) return null;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, WALL_REPORT_WAIT_MS);
    void pending.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
