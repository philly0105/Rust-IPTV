/**
 * Screenshots of the playing video (Run 3 C6, docs/architecture/screenshot.md).
 *
 * Loaded on demand by the camera button, the video context menu and the `s` shortcut, so none
 * of this is in the entry chunk.
 *
 * - Embedded mpv: the core asks mpv for the frame (`screenshot.mpv`), subtitles included.
 * - Built-in player: the current frame of the `<video data-player-video>` is drawn on a canvas
 *   at the stream's own size and encoded as PNG. Desktop hands it to `screenshot.save`; server
 *   mode downloads it as a file.
 * - External players and radio have no frame here: the caller shows why instead.
 *
 * Every outcome is a toast. Toasts portal into the fullscreen element (ui/portal.ts), so they
 * show in player full screen too; the player's OSD repeats a result only in picture-in-picture,
 * where the player covers the window and its toasts.
 */

import i18next from 'i18next';

import { isDesktop, rpc } from '@/api/transport';
import type { PlayerSource, ScreenshotResult } from '@/api/types';
import { toast } from '@/ui/Toast';

import { showOsd } from './media';
import { usePipStore } from './pip';
import { errorMessage, usePlayerStore, type PlayerMode } from './store';

/** The core's limit on one picture (`screenshot::MAX_SCREENSHOT_BYTES`). */
export const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
/** Longest title kept in a file name, in characters (the core cuts at the same length). */
const MAX_TITLE_CHARS = 80;
/** JPEG quality for a frame whose PNG is over the limit. */
const JPEG_QUALITY = 0.92;

/** Why no screenshot can be taken now; null when one can. */
export type ScreenshotBlock = 'idle' | 'external' | 'radio';

export function screenshotBlock(s: { source?: PlayerSource | null; mode: PlayerMode }): ScreenshotBlock | null {
  if (!s.source) return 'idle';
  if (s.mode === 'external') return 'external';
  if (s.mode === 'radio' || s.source.isRadio) return 'radio';
  return null;
}

/** The player.json key that explains a block to the user. */
export function blockReasonKey(block: ScreenshotBlock): 'screenshotExternal' | 'screenshotNoVideo' {
  return block === 'external' ? 'screenshotExternal' : 'screenshotNoVideo';
}

/** What the picture shows, for its file name: the channel or title, then the programme or episode. */
export function screenshotTitle(source: Pick<PlayerSource, 'title' | 'subtitle'>): string {
  const title = source.title.trim();
  const sub = source.subtitle?.trim();
  return sub && sub !== title ? `${title} - ${sub}` : title;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * `<title> <YYYY-MM-DD HH-MM-SS>.<ext>` in local time, the name the core gives a saved
 * screenshot, for the file server mode downloads. Characters Windows refuses become `_`.
 */
export function screenshotFileName(title: string, at: Date, ext: 'png' | 'jpg'): string {
  const clean = title
    .replace(/[<>:"/\\|?*]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
    .trim();
  const stem = Array.from(clean).slice(0, MAX_TITLE_CHARS).join('').replace(/[. ]+$/, '') || 'Screenshot';
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
  return `${stem} ${day} ${time}.${ext}`;
}

/** A capture that could not happen, with the player.json key that says why. */
export class ScreenshotError extends Error {
  constructor(readonly key: 'screenshotCors' | 'screenshotNotReady' | 'screenshotFailed') {
    super(key);
    this.name = 'ScreenshotError';
  }
}

/** The built-in player's video element (InlinePlayer marks it). */
export function findPlayerVideo(root: ParentNode = document): HTMLVideoElement | null {
  return root.querySelector<HTMLVideoElement>('video[data-player-video]');
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new ScreenshotError('screenshotFailed'))), type, quality);
    } catch (err) {
      reject(err);
    }
  });
}

const isSecurityError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'SecurityError';

/**
 * The current frame of `video` at its own resolution: PNG, or JPEG when the PNG is over the
 * core's limit. A frame from another origin without CORS taints the canvas, and encoding it
 * throws a SecurityError: that becomes `screenshotCors`.
 */
export async function captureFrame(video: HTMLVideoElement): Promise<{ blob: Blob; format: 'png' | 'jpeg' }> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (video.readyState < 2 || !width || !height) throw new ScreenshotError('screenshotNotReady');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ScreenshotError('screenshotFailed');
  try {
    ctx.drawImage(video, 0, 0, width, height);
    const png = await canvasBlob(canvas, 'image/png');
    if (png.size <= MAX_SCREENSHOT_BYTES) return { blob: png, format: 'png' };
    return { blob: await canvasBlob(canvas, 'image/jpeg', JPEG_QUALITY), format: 'jpeg' };
  } catch (err) {
    if (isSecurityError(err)) throw new ScreenshotError('screenshotCors');
    throw err;
  } finally {
    // Free the bitmap now rather than at the next collection: frames can be 4K.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Base64 of `blob` without a data-URL prefix (the `dataBase64` of `screenshot.save`). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new ScreenshotError('screenshotFailed'));
    reader.readAsDataURL(blob);
  });
}

/** Saves `blob` through the browser's downloads (server mode). */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // The download has its own copy once it starts; keep the URL a while for slow starts.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const t = (key: string, vars?: Record<string, unknown>): string => i18next.t(`player:${key}`, vars ?? {});

/** Opens a saved screenshot in the system's image viewer (the toast's Open action). */
export function openScreenshot(path: string): void {
  rpc('screenshot.open', { path }).catch((err: unknown) =>
    toast({ title: t('screenshotOpenFailed'), description: errorMessage(err), variant: 'error' }),
  );
}

/** The OSD copy of a result, only where its toast cannot be seen (picture-in-picture). */
function osdIfToastHidden(primary: string, secondary: string): void {
  if (usePipStore.getState().active) showOsd(primary, secondary);
}

function reportSaved(res: ScreenshotResult): void {
  osdIfToastHidden(t('screenshotSaved'), res.fileName);
  toast({
    title: t('screenshotSaved'),
    description: res.fileName,
    variant: 'success',
    action: { label: t('screenshotOpen'), onClick: () => openScreenshot(res.path) },
  });
}

function reportDownloaded(fileName: string): void {
  osdIfToastHidden(t('screenshotSaved'), fileName);
  toast({ title: t('screenshotDownloaded'), description: fileName, variant: 'success' });
}

function reportFailure(err: unknown): void {
  let detail: string;
  if (err instanceof ScreenshotError) {
    detail = t(err.key);
    // On the desktop, embedded mpv reads the stream itself, so it can capture what the browser may not.
    if (err.key === 'screenshotCors' && isDesktop) detail = `${detail} ${t('screenshotCorsMpv')}`;
  } else {
    detail = errorMessage(err);
  }
  osdIfToastHidden(t('screenshotFailed'), detail);
  toast({ title: t('screenshotFailed'), description: detail, variant: 'error' });
}

/**
 * Tells the user why there is nothing to capture (the button's and the shortcut's answer): a
 * toast, repeated on the OSD only in picture-in-picture like every other outcome.
 */
export function explainBlock(block: ScreenshotBlock): void {
  if (block === 'idle') return;
  const reason = t(blockReasonKey(block));
  osdIfToastHidden(t('screenshot'), reason);
  toast({ title: reason, variant: 'info' });
}

let busy = false;

/** True while a screenshot is being taken (a second press waits for it instead of stacking up). */
export function screenshotBusy(): boolean {
  return busy;
}

/**
 * Takes a screenshot of what plays now and reports the result. Never rejects: every failure
 * ends in a toast (and, in picture-in-picture, the OSD) that names the cause.
 */
export async function takeScreenshot(): Promise<void> {
  if (busy) return;
  const { source, mode } = usePlayerStore.getState();
  const block = screenshotBlock({ source, mode });
  if (block || !source) {
    if (block) explainBlock(block);
    return;
  }
  busy = true;
  try {
    const title = screenshotTitle(source);
    if (mode === 'embedded-mpv') {
      reportSaved(await rpc('screenshot.mpv', { title, withSubtitles: true }));
      return;
    }
    const video = findPlayerVideo();
    if (!video) throw new ScreenshotError('screenshotNotReady');
    const at = new Date();
    const { blob, format } = await captureFrame(video);
    if (isDesktop) {
      reportSaved(await rpc('screenshot.save', { dataBase64: await blobToBase64(blob), format, title }));
    } else {
      const fileName = screenshotFileName(title, at, format === 'png' ? 'png' : 'jpg');
      downloadBlob(blob, fileName);
      reportDownloaded(fileName);
    }
  } catch (err) {
    reportFailure(err);
  } finally {
    busy = false;
  }
}
