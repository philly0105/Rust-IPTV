/**
 * "Load subtitle file..." (C6). The built-in player reads the file in the page (a hidden file
 * input, `readFileText`, then parse.ts) and adds it as a text track; embedded mpv gets a path
 * from the native dialog and opens the file itself (`mpv.addSubtitle`). Loaded with the menu.
 */

import type { TFunction } from 'i18next';

import { isDesktop, rpc } from '@/api/transport';
import { baseName, pickPathDesktop, readFileText } from '@/features/sources/lib/files';
import { toast } from '@/ui/Toast';

import { useMediaStore } from '../media';
import { peekSettings, usePlayerStore } from '../store';
import { detectFormat, MAX_SUBTITLE_BYTES, parseSubtitles, SUBTITLE_EXTENSIONS, SubtitleParseError, type SubtitleCue } from './parse';
import { cueLine } from './style';
import { addExternalTrack, inlineSubtitleTarget, selectText, type InlineSubtitleTarget } from './tracks';

/** What went wrong reading a file, for the error toast. */
export type SubtitleLoadProblem = 'tooLarge' | 'unreadable' | 'unknownFormat' | 'noCues';

export class SubtitleLoadError extends Error {
  constructor(
    readonly problem: SubtitleLoadProblem,
    message: string,
  ) {
    super(message);
    this.name = 'SubtitleLoadError';
  }
}

/** Reads and parses a picked file. Throws `SubtitleLoadError`. */
export async function readSubtitleFile(file: File): Promise<SubtitleCue[]> {
  if (file.size > MAX_SUBTITLE_BYTES) throw new SubtitleLoadError('tooLarge', `${file.name} is larger than 5 MB`);
  let text: string;
  try {
    text = await readFileText(file);
  } catch (err) {
    throw new SubtitleLoadError('unreadable', err instanceof Error ? err.message : String(err));
  }
  const format = detectFormat(file.name, text);
  if (!format) throw new SubtitleLoadError('unknownFormat', `${file.name} is not an SRT, WebVTT or ASS file`);
  try {
    return parseSubtitles(text, format);
  } catch (err) {
    if (err instanceof SubtitleParseError) throw new SubtitleLoadError('noCues', err.message);
    throw err;
  }
}

/** Cue text is WebVTT markup: plain text has its `&`, `<` and `>` escaped. */
export function cueMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Adds `cues` to the player as a new track named `label` and shows it; returns its `ext:<n>` id. */
export function showCues(target: InlineSubtitleTarget, label: string, cues: readonly SubtitleCue[]): string {
  const { id, track } = addExternalTrack(target.el, label);
  // Cues can only be added while the track is not disabled.
  track.mode = 'hidden';
  const line = cueLine(peekSettings()?.subtitlePosition ?? 0);
  for (const c of cues) {
    const cue = new VTTCue(c.start, c.end, cueMarkup(c.text));
    cue.snapToLines = false;
    cue.line = line;
    cue.lineAlign = 'end';
    track.addCue(cue);
  }
  selectText(target.el, target.engine(), id);
  target.publish();
  useMediaStore.setState({ captionsOn: true });
  return id;
}

/** Opens the browser's file chooser for one subtitle file; null when the user cancels. */
export function chooseSubtitleFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = SUBTITLE_EXTENSIONS.map((e) => `.${e}`).join(',');
    input.hidden = true;
    input.dataset['testid'] = 'subtitle-file-input';
    let settled = false;
    const done = (file: File | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    document.body.append(input);
    input.click();
  });
}

/**
 * The size of a file over the limit, in the limit's unit (MB of 1024 KB, as "5 MB" in the
 * message). Rounded up to hundredths, so a file just over 5 MB never reads "5 MB".
 */
export function oversizeText(bytes: number, lang: string): string {
  // Hundredths of a MB, rounded up (the tiny slack keeps float noise from adding one).
  const mb = Math.ceil((Math.max(0, bytes) * 100) / (1024 * 1024) - 1e-6) / 100;
  let text: string;
  try {
    text = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }).format(mb);
  } catch {
    text = String(mb);
  }
  return `${text} MB`;
}

function problemText(t: TFunction<'player'>, err: unknown, file?: File): string {
  if (!(err instanceof SubtitleLoadError)) return err instanceof Error ? err.message : String(err);
  switch (err.problem) {
    case 'tooLarge':
      return t('subtitleTooLarge', { size: oversizeText(file?.size ?? 0, document.documentElement.lang || 'en') });
    case 'unknownFormat':
      return t('subtitleUnknownFormat');
    case 'noCues':
      return t('subtitleNoCues');
    default:
      return t('subtitleUnreadable');
  }
}

/** Loads a picked file into the built-in player. Resolves true when a track was added. */
export async function loadIntoInline(target: InlineSubtitleTarget, file: File, t: TFunction<'player'>): Promise<boolean> {
  try {
    const cues = await readSubtitleFile(file);
    // The item may have changed while the file was read.
    if (inlineSubtitleTarget() !== target) return false;
    showCues(target, file.name, cues);
    toast({ title: t('subtitleLoaded', { name: file.name }), variant: 'success' });
    return true;
  } catch (err) {
    toast({ title: t('subtitleLoadFailed', { name: file.name }), description: problemText(t, err, file), variant: 'error' });
    return false;
  }
}

/**
 * The menu's "Load subtitle file..." for whichever player is showing. Resolves true when a
 * track was added, false when the user cancelled or it failed (an error toast says why).
 */
export async function loadSubtitleFile(t: TFunction<'player'>): Promise<boolean> {
  if (usePlayerStore.getState().mode === 'embedded-mpv' && isDesktop) {
    const path = await pickPathDesktop({ title: t('subtitleLoad'), extensions: [...SUBTITLE_EXTENSIONS], filterName: t('subtitleFiles') }).catch(
      () => null,
    );
    if (!path) return false;
    const name = baseName(path);
    try {
      await rpc('mpv.addSubtitle', { path });
      toast({ title: t('subtitleLoaded', { name }), variant: 'success' });
      return true;
    } catch (err) {
      toast({ title: t('subtitleLoadFailed', { name }), description: err instanceof Error ? err.message : String(err), variant: 'error' });
      return false;
    }
  }
  const target = inlineSubtitleTarget();
  if (!target) {
    toast({ title: t('subtitleLoadFailedGeneric'), description: t('subtitleNeedsVideo'), variant: 'error' });
    return false;
  }
  const file = await chooseSubtitleFile();
  if (!file) return false;
  return loadIntoInline(target, file, t);
}
