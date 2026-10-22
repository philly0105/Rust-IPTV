/**
 * Seeking in MPEG-TS played by mpegts.js (players.md, Seeking in MPEG-TS). mpegts.js can't seek in
 * MPEG-TS: a seek past what it holds waited while it loaded everything before the target, and a
 * resume started at 0 and did the same. So the engine restarts its pipeline where a `TsSeeker` says
 * the target is:
 * - Xtream catch-up: the archive link, asked for again from the target minute.
 */

import { proxiedUrl, rpc } from '@/api/transport';
import type { ItemRef, PlayerSource } from '@/api/types';

/** Where a restarted pipeline starts. */
export interface TsStart {
  /** The URL to load: the same media from `at` on. */
  url: string;
  /** Item time, in seconds, of the new stream's first media. */
  at: number;
}

export interface TsSeeker {
  /** The item's length in seconds, once known: the stream itself never says. */
  duration(): number | undefined;
  /** False once it is known that this media can only start at its beginning. */
  usable(): boolean;
  /** Learns the length up front where that is cheap (a local file). Never throws. */
  prepare?(): Promise<void>;
  /**
   * Where to restart for `seconds`: at it or a little before. Null when this media can only start
   * at its beginning. Throws when asking failed and may work later (the archive link).
   */
  startAt(seconds: number, signal: AbortSignal): Promise<TsStart | null>;
}

/** The seeker for a non-live source loaded from `loadUrl`, or undefined when none can seek it. */
export function tsSeekerFor(source: PlayerSource, loadUrl: string): TsSeeker | undefined {
  if (source.isLive) return undefined;
  const { ref, catchup } = source;
  if (catchup && ref) return catchupSeeker(source, ref, catchup, loadUrl);
  return undefined;
}

// ---------------------------------------------------------------------------
// Xtream catch-up
// ---------------------------------------------------------------------------

function catchupSeeker(source: PlayerSource, ref: ItemRef, archive: NonNullable<PlayerSource['catchup']>, loadUrl: string): TsSeeker {
  const startMs = Date.parse(archive.start);
  return {
    duration: () => source.durationSeconds,
    usable: () => Number.isFinite(startMs),
    async startAt(seconds) {
      // The panel starts an archive link on a whole minute (`catchup_stamp`), and refuses one that
      // has not aired yet: a programme still on air restarts at its last aired minute.
      const aired = Math.floor((Date.now() - startMs) / 60_000) - 1;
      const minute = Math.max(0, Math.min(Math.floor(seconds / 60), aired, archive.durationMinutes - 1));
      if (!minute) return { url: loadUrl, at: 0 };
      const fresh = await rpc('xtream.catchupUrl', {
        ref,
        start: new Date(startMs + minute * 60_000).toISOString(),
        durationMinutes: archive.durationMinutes - minute,
      });
      return { url: proxiedUrl({ ...source, url: fresh.url, headers: fresh.headers ?? source.headers }), at: minute * 60 };
    },
  };
}
