/**
 * Subtitle delay for the built-in engines: every cue of the element's text tracks is moved by
 * the delay. Engines keep adding cues as segments arrive, so while a delay is set the tracks
 * are re-checked every half second; each cue's original times are remembered, so changing or
 * clearing the delay never drifts.
 */

/** The parts of a cue and a text track this module touches (TextTrackCue, TextTrack). */
export interface CueLike {
  startTime: number;
  endTime: number;
  text?: string;
}
export interface TrackLike {
  mode: string;
  cues: ArrayLike<CueLike> | null;
  removeCue?(cue: CueLike): void;
}

const original = new WeakMap<CueLike, { start: number; end: number }>();
/** Per track: original-time keys of the cues seen, so a cue an engine adds again is dropped. */
const seenKeys = new WeakMap<TrackLike, Set<string>>();

const RECHECK_MS = 500;

function cueKey(start: number, end: number, cue: CueLike): string {
  return `${start}|${end}|${cue.text ?? ''}`;
}

/** Moves every cue of `tracks` to its original time plus `seconds`. Exported for tests. */
export function applyCueDelay(tracks: ArrayLike<TrackLike>, seconds: number): void {
  for (let t = 0; t < tracks.length; t++) {
    const track = tracks[t];
    if (!track?.cues || track.mode === 'disabled') continue;
    let keys = seenKeys.get(track);
    if (!keys) {
      keys = new Set();
      seenKeys.set(track, keys);
    }
    // Copy first: removing a cue shrinks the live list.
    const cues = Array.from(track.cues);
    for (const cue of cues) {
      let orig = original.get(cue);
      if (!orig) {
        orig = { start: cue.startTime, end: cue.endTime };
        const key = cueKey(orig.start, orig.end, cue);
        // hls.js re-adds a cue it no longer finds at its old time: keep one copy.
        if (keys.has(key) && seconds !== 0 && track.removeCue) {
          track.removeCue(cue);
          continue;
        }
        keys.add(key);
        original.set(cue, orig);
      }
      const start = Math.max(0, orig.start + seconds);
      const end = Math.max(start, orig.end + seconds);
      if (cue.startTime !== start) cue.startTime = start;
      if (cue.endTime !== end) cue.endTime = end;
    }
  }
}

/**
 * Keeps `el`'s cues shifted by `getSeconds()`. Call `update()` after the delay changed;
 * the returned `stop` puts the cues back and ends the re-checks.
 */
export function bindCueDelay(el: HTMLMediaElement, getSeconds: () => number): { update(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  const tracks = (): ArrayLike<TrackLike> => el.textTracks as unknown as ArrayLike<TrackLike>;
  const update = (): void => {
    const seconds = getSeconds();
    applyCueDelay(tracks(), seconds);
    if (seconds !== 0 && !timer) timer = setInterval(() => applyCueDelay(tracks(), getSeconds()), RECHECK_MS);
    if (seconds === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  return {
    update,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
      applyCueDelay(tracks(), 0);
    },
  };
}
