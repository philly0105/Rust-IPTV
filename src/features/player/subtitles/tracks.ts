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
let target: InlineSubtitleTarget | null = null;

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
  for (const t of files.get(el) ?? []) if (t !== pick) t.mode = 'disabled';
  engine?.setText(isFile ? null : id);
  if (pick) pick.mode = 'showing';
}

/** The engine's tracks plus the loaded files; while a file shows, no engine track is selected. */
export function withExternal(el: HTMLMediaElement, tracks: EngineTracks): EngineTracks {
  const list = files.get(el);
  if (!list?.length) return tracks;
  const fileOn = list.some((t) => t.mode === 'showing');
  return {
    ...tracks,
    text: [
      ...(fileOn ? tracks.text.map((x) => (x.selected ? { ...x, selected: false } : x)) : tracks.text),
      ...list.map((t, i) => ({ id: `${EXT_PREFIX}${i}`, label: t.label, selected: t.mode === 'showing' })),
    ],
  };
}

/** A new item: the files of the last one lose their cues and go dark. */
export function clearExternal(el: HTMLMediaElement): void {
  for (const t of files.get(el) ?? []) {
    // A disabled track hides its cue list, so it is hidden while the cues go.
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
