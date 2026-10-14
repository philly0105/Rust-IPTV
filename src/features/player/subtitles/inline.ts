/**
 * Subtitle placement in the built-in player (C6): every cue of a showing track sits at
 * `cueLine(settings.subtitlePosition)`. Engines add cues as segments arrive, so engine tracks
 * are placed on `cuechange`, and every showing track again when the setting changes.
 * Loaded after the player (InlinePlayer imports it lazily); colours and size are CSS (player.css).
 */

import { peekSettings, subscribeSettings } from '../store';
import { cueLine } from './style';

/** The parts of a VTTCue this module sets (TextTrackCue has none of them). */
interface PlaceableCue {
  snapToLines: boolean;
  line: number | 'auto' | null;
  lineAlign: string;
}

function isPlaceable(cue: unknown): cue is PlaceableCue {
  return typeof cue === 'object' && cue !== null && 'snapToLines' in cue && 'line' in cue;
}

/** Puts `cues` at `line`; cues already there are left alone, so no re-render is forced. */
export function placeCues(cues: ArrayLike<unknown> | null | undefined, line: number): void {
  if (!cues) return;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (!isPlaceable(cue) || (cue.snapToLines === false && cue.line === line)) continue;
    cue.snapToLines = false;
    cue.line = line;
    cue.lineAlign = 'end';
  }
}

function isSubtitleTrack(t: TextTrack): boolean {
  return t.kind === 'subtitles' || t.kind === 'captions';
}

/** Keeps the cues of `el`'s showing subtitle tracks at the user's position until the returned stop. */
export function bindCuePosition(el: HTMLMediaElement): () => void {
  const lineNow = (): number => cueLine(peekSettings()?.subtitlePosition ?? 0);
  let line = lineNow();
  const bound = new Set<TextTrack>();

  const onCueChange = (e: Event): void => {
    const track = e.target as TextTrack;
    if (track.mode === 'showing') placeCues(track.activeCues, line);
  };
  const bind = (t: TextTrack | null | undefined): void => {
    if (!t || bound.has(t) || !isSubtitleTrack(t)) return;
    bound.add(t);
    t.addEventListener('cuechange', onCueChange);
  };
  const placeShowing = (): void => {
    for (let i = 0; i < el.textTracks.length; i++) {
      const t = el.textTracks[i];
      if (!t || !isSubtitleTrack(t)) continue;
      bind(t);
      if (t.mode === 'showing') placeCues(t.cues, line);
    }
  };
  const onAdd = (e: TrackEvent): void => bind(e.track as TextTrack | null);

  placeShowing();
  el.textTracks.addEventListener('addtrack', onAdd);
  // A track turned on brings its cues already loaded.
  el.textTracks.addEventListener('change', placeShowing);
  const unSettings = subscribeSettings(() => {
    const next = lineNow();
    if (next === line) return;
    line = next;
    placeShowing();
  });
  return () => {
    unSettings();
    el.textTracks.removeEventListener('addtrack', onAdd);
    el.textTracks.removeEventListener('change', placeShowing);
    for (const t of bound) t.removeEventListener('cuechange', onCueChange);
    bound.clear();
  };
}
