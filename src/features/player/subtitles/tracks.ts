/**
 * Subtitle files in the built-in player (C6). A file becomes an `addTextTrack` track on the
 * media element and is listed as `ext:<n>` next to the engine's own tracks. Such tracks cannot
 * be removed from an element, so a new item empties and disables them instead.
 *
 * No runtime imports: engines.ts reads `isExternalTrack`, and the media store imports engines.ts.
 */

import type { Engine, EngineTracks } from '../engines';

/** Id prefix of a loaded file in the Subtitles menu. */
export const EXT_PREFIX = 'ext:';

/** The built-in player that is showing now, for the file loader (set by InlinePlayer). */
export interface InlineSubtitleTarget {
  el: HTMLMediaElement;
  engine(): Engine | null;
  /** Re-publishes the track list (engine tracks plus files) to the media store. */
  publish(): void;
}

const marked = new WeakSet<TextTrack>();
const files = new WeakMap<HTMLMediaElement, TextTrack[]>();
/**
 * Tracks the player draws itself (subtitles/inline.ts). The browser's own cue rendering cannot be
 * styled where the Windows caption theme applies (Edge, WebView2), so a track turned on is set to
 * `hidden` and its cues are drawn in the player's overlay instead. A `hidden` track in this set is
 * on; any other `hidden` track is an engine's off-screen track. While the video is in the
 * browser's picture-in-picture window, the tracks in this set are `showing` (the browser draws
 * them there).
 */
const drawn = new WeakSet<TextTrack>();
let target: InlineSubtitleTarget | null = null;

/** True while `track` is on screen: showing natively, or hidden and drawn by the player. */
export function isShownTrack(track: TextTrack): boolean {
  return track.mode === 'showing' || (track.mode === 'hidden' && drawn.has(track));
}

/** True for a track the overlay draws now. */
export function isDrawnTrack(track: TextTrack): boolean {
  return track.mode === 'hidden' && drawn.has(track);
}

/**
 * The overlay takes a showing track over: the browser stops drawing it, the player draws it.
 * `native` (picture-in-picture) leaves it showing, for the browser to draw in its window.
 */
export function drawTrack(track: TextTrack, native = false): void {
  drawn.add(track);
  if (!native && track.mode !== 'hidden') track.mode = 'hidden';
}

/** Picture-in-picture: the tracks the overlay draws turn `showing`, so the browser draws them. */
export function showDrawnTracks(el: HTMLMediaElement): void {
  for (let i = 0; i < el.textTracks.length; i++) {
    const t = el.textTracks[i];
    if (t && isDrawnTrack(t)) t.mode = 'showing';
  }
}

/** A track that went dark is no longer drawn. */
export function releaseTrack(track: TextTrack): void {
  drawn.delete(track);
}

/** Turns every drawn track of `el` off (an engine whose Off only hides its track). */
export function hideDrawnTracks(el: HTMLMediaElement): void {
  for (let i = 0; i < el.textTracks.length; i++) {
    const t = el.textTracks[i];
    if (t && drawn.has(t)) {
      drawn.delete(t);
      t.mode = 'disabled';
    }
  }
}

/** True for a track made from a loaded file (engines leave these out of their own lists). */
export function isExternalTrack(track: TextTrack): boolean {
  return marked.has(track);
}

/** The files loaded for the current item, in `ext:<n>` order. */
export function externalTracks(el: HTMLMediaElement): readonly TextTrack[] {
  return files.get(el) ?? [];
}

/** A new, empty file track on `el`; returns it with its menu id. */
export function addExternalTrack(el: HTMLMediaElement, label: string): { id: string; track: TextTrack } {
  const track = el.addTextTrack('subtitles', label);
  marked.add(track);
  const list = files.get(el) ?? [];
  list.push(track);
  files.set(el, list);
  return { id: `${EXT_PREFIX}${list.length - 1}`, track };
}

/**
 * Shows the track `id` (an engine id, an `ext:<n>` file, or null for Off). A file first turns
 * the engine's subtitles off, so only one track is ever on screen.
 */
export function selectText(el: HTMLMediaElement, engine: Engine | null, id: string | null): void {
  const isFile = !!id?.startsWith(EXT_PREFIX);
  const pick = isFile ? files.get(el)?.[Number(id!.slice(EXT_PREFIX.length))] : undefined;
  for (const t of files.get(el) ?? []) {
    if (t === pick) continue;
    drawn.delete(t);
    t.mode = 'disabled';
  }
  engine?.setText(isFile ? null : id);
  if (pick) pick.mode = 'showing';
}

/** The engine's tracks plus the loaded files; while a file shows, no engine track is selected. */
export function withExternal(el: HTMLMediaElement, tracks: EngineTracks): EngineTracks {
  const list = files.get(el);
  if (!list?.length) return tracks;
  const fileOn = list.some(isShownTrack);
  return {
    ...tracks,
    text: [
      ...(fileOn ? tracks.text.map((x) => (x.selected ? { ...x, selected: false } : x)) : tracks.text),
      ...list.map((t, i) => ({ id: `${EXT_PREFIX}${i}`, label: t.label, selected: isShownTrack(t) })),
    ],
  };
}

/** A new item: the files of the last one lose their cues and go dark. */
export function clearExternal(el: HTMLMediaElement): void {
  for (const t of files.get(el) ?? []) {
    // A disabled track hides its cue list, so it is hidden while the cues go.
    drawn.delete(t);
    t.mode = 'hidden';
    for (const cue of Array.from(t.cues ?? [])) t.removeCue(cue);
    t.mode = 'disabled';
  }
  files.delete(el);
}

/** Registers the showing built-in player; returns the unregister function. */
export function setInlineSubtitleTarget(next: InlineSubtitleTarget): () => void {
  target = next;
  return () => {
    if (target === next) target = null;
  };
}

/** The built-in player a file should go to, or null (embedded mpv, radio, nothing playing). */
export function inlineSubtitleTarget(): InlineSubtitleTarget | null {
  return target;
}
