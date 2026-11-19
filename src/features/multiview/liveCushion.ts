/**
 * Playback cushion for a live MPEG-TS tile. mpegts.js plays a live stream at its edge (no stash,
 * no latency chasing: `engines.ts`), so the only buffer is what the panel sent on connect, and the
 * element resumes the moment a few frames arrive. A delivery hiccup longer than that shows as a
 * freeze, often several in a row. Here the tile holds, paused, until LIVE_CUSHION_S is buffered
 * ahead, before its first motion and after every stall; mpegts.js keeps loading while it is
 * paused. The cushion then stays as a few seconds of delay behind the edge and absorbs the next
 * hiccup instead of showing it.
 *
 * Something else that plays the element during a hold (an engine restart, a sound change) is
 * paused again. A stream that never fills the cushion plays on with what it has after
 * LIVE_HOLD_MAX_MS; one with nothing at all stays held until the tile's own stall timeout fails it.
 */

/** Seconds buffered ahead before a held tile plays. */
export const LIVE_CUSHION_S = 3;
/** A hold plays on with less than the cushion after this long, as long as it has LIVE_HOLD_MIN_AHEAD_S. */
export const LIVE_HOLD_MAX_MS = 8_000;
export const LIVE_HOLD_MIN_AHEAD_S = 0.5;
export const CUSHION_POLL_MS = 250;
/** A buffered range that starts this close past the playhead still counts as under it. */
const RANGE_SLACK_S = 0.1;

/** Seconds buffered past the playhead in the range under it (0 when none is). */
export function bufferedAhead(el: HTMLMediaElement): number {
  const ranges = el.buffered;
  const t = el.currentTime;
  for (let i = 0; i < ranges.length; i++) {
    const start = ranges.start(i);
    const end = ranges.end(i);
    if (start <= t + RANGE_SLACK_S && end > t) return end - Math.max(t, start);
  }
  return 0;
}

export interface CushionStall {
  /** resumed: the cushion filled; timedOut: played on with less; abandoned: destroyed while held. */
  outcome: 'resumed' | 'timedOut' | 'abandoned';
  /** Before the cushion was ever full: the tile's start, not a stall mid-stream. */
  startup: boolean;
  durationMs: number;
  aheadAtStallMs: number;
  aheadAtResumeMs: number;
}

export interface LiveCushionOptions {
  /** Plays the element (the tile's own play, which handles blocked sound). */
  play(): void;
  /** A hold began or was renewed: the tile shows it is waiting and arms its stall timeout. */
  onHold(): void;
  /** A hold ended, however it ended. */
  onStall(stall: CushionStall): void;
}

export interface LiveCushion {
  /** A hold is under way: the element's pause (and its `timeupdate`) is the cushion's, not progress. */
  holding(): boolean;
  destroy(): void;
}

export function attachLiveCushion(el: HTMLMediaElement, opts: LiveCushionOptions): LiveCushion {
  let hold: { since: number; startup: boolean; aheadAtStall: number } | null = null;
  /** The cushion has been full once: holds after that are stalls. */
  let built = false;
  let poll: ReturnType<typeof setInterval> | undefined;

  const begin = (): void => {
    if (hold) return;
    hold = { since: Date.now(), startup: !built, aheadAtStall: bufferedAhead(el) };
    el.pause();
    opts.onHold();
    poll = setInterval(check, CUSHION_POLL_MS);
  };

  const end = (outcome: CushionStall['outcome']): void => {
    if (!hold) return;
    clearInterval(poll);
    const h = hold;
    hold = null;
    if (outcome !== 'abandoned') built = true;
    opts.onStall({
      outcome,
      startup: h.startup,
      durationMs: Math.round(Date.now() - h.since),
      aheadAtStallMs: Math.round(h.aheadAtStall * 1000),
      aheadAtResumeMs: Math.round(bufferedAhead(el) * 1000),
    });
  };

  const check = (): void => {
    if (!hold) return;
    const ahead = bufferedAhead(el);
    if (ahead >= LIVE_CUSHION_S) end('resumed');
    else if (Date.now() - hold.since >= LIVE_HOLD_MAX_MS && ahead >= LIVE_HOLD_MIN_AHEAD_S) end('timedOut');
    else return;
    opts.play();
  };

  const onWaiting = (): void => begin();
  const onPlaying = (): void => {
    if (!built && !hold && bufferedAhead(el) < LIVE_CUSHION_S) begin();
    else if (!hold) built = true;
  };
  const onPlay = (): void => {
    if (!hold) return;
    // Played by someone else before the cushion filled; its play() promise rejects with AbortError.
    el.pause();
    opts.onHold();
  };

  el.addEventListener('waiting', onWaiting);
  el.addEventListener('playing', onPlaying);
  el.addEventListener('play', onPlay);

  return {
    holding: () => hold !== null,
    destroy() {
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('play', onPlay);
      end('abandoned');
    },
  };
}
