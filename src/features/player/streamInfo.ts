/**
 * Stream info overlay: what is playing and how well (codecs, resolution, bitrates, drops, buffer).
 *
 * The active surface registers a stats provider: embedded mpv asks the core (`mpv.stats`), the
 * built-in engines read hls.js / shaka / mpegts.js and the media element. The panel polls the
 * provider about once a second while it is open; with the panel closed nothing is read.
 * The stream URL is never shown, only its host (URLs can carry credentials).
 */

import type { TFunction } from 'i18next';
import { create } from 'zustand';

import type { MpvStats } from '@/api/types';
import { intlLocale } from '@/lib/intl';

import { formatBitrate } from './engines';
import { usePlayerStore } from './store';

export type EngineName = 'mpv' | 'hls' | 'dash' | 'mpegts' | 'native';

/** One snapshot; anything unknown is left out. Same fields as `mpv.stats`, plus the engine. */
export interface StreamStats extends Partial<MpvStats> {
  engine: EngineName;
}

export type StatsProvider = () => StreamStats | Promise<StreamStats>;

interface StreamInfoState {
  open: boolean;
}

export const useStreamInfoStore = create<StreamInfoState>()(() => ({ open: false }));

export function toggleStreamInfo(): boolean {
  const open = !useStreamInfoStore.getState().open;
  useStreamInfoStore.setState({ open });
  return open;
}

// Stopping, or radio (which has no panel), closes it: it must not pop up on the next video.
usePlayerStore.subscribe((s) => {
  if (useStreamInfoStore.getState().open && (!s.source || s.mode === 'radio')) useStreamInfoStore.setState({ open: false });
});

let provider: StatsProvider | null = null;

/** Registers the active surface's provider; the returned function removes it (if still current). */
export function setStatsProvider(p: StatsProvider): () => void {
  provider = p;
  return () => {
    if (provider === p) provider = null;
  };
}

/** A snapshot from the current provider, or null when nothing plays or it failed. */
export async function readStats(): Promise<StreamStats | null> {
  const p = provider;
  if (!p) return null;
  try {
    return await p();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const CODEC_NAMES: readonly [RegExp, string][] = [
  [/^(avc1|avc3|h264)/i, 'H.264'],
  [/^(hvc1|hev1|hevc|h265)/i, 'HEVC'],
  [/^(vp09|vp9)/i, 'VP9'],
  [/^(vp08|vp8)/i, 'VP8'],
  [/^(av01|av1)/i, 'AV1'],
  [/^(mpeg2video|mp2v)/i, 'MPEG-2'],
  [/^mp4a\.40\.(5|29)/i, 'HE-AAC'],
  [/^(mp4a|aac)/i, 'AAC'],
  [/^(ec-3|eac3)/i, 'E-AC-3'],
  [/^(ac-3|ac3)/i, 'AC-3'],
  [/^(mp3|mp4a\.6b|mp4a\.69)/i, 'MP3'],
  [/^mp2$/i, 'MP2'],
  [/^opus/i, 'Opus'],
  [/^(flac|fLaC)/i, 'FLAC'],
];

/** Readable codec name from an RFC 6381 string (`avc1.64001f`) or an FFmpeg name (`h264`). */
export function codecLabel(codec: string | undefined): string | undefined {
  const c = codec?.trim();
  if (!c) return undefined;
  // `video/mp4; codecs="avc1.4d401f, mp4a.40.2"` style lists: the first one.
  const first = c.split(',')[0]?.trim() ?? c;
  for (const [re, name] of CODEC_NAMES) if (re.test(first)) return name;
  return first;
}

export function resolutionLabel(width: number | undefined, height: number | undefined): string | undefined {
  if (!width || !height) return undefined;
  return `${width}×${height}`;
}

export function fpsLabel(fps: number | undefined): string | undefined {
  if (!fps || !Number.isFinite(fps) || fps <= 0) return undefined;
  const rounded = Math.round(fps * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)} fps`;
}

export function bitrateLabel(bps: number | undefined): string | undefined {
  return bps && Number.isFinite(bps) && bps > 0 ? formatBitrate(bps) : undefined;
}

export function channelsLabel(count: number | undefined, t: TFunction<'player'>): string | undefined {
  if (!count || count <= 0) return undefined;
  if (count === 1) return t('infoMono');
  if (count === 2) return t('infoStereo');
  if (count === 6) return '5.1';
  if (count === 8) return '7.1';
  return String(count);
}

/** "12.5 s" in the UI language. */
export function secondsLabel(seconds: number | undefined, locale?: string): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const value = Math.round(seconds * 10) / 10;
  try {
    return new Intl.NumberFormat(intlLocale(locale), { style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: 1 }).format(value);
  } catch {
    return `${value} s`;
  }
}

/**
 * Host (and port) of the stream URL, never its path, query or credentials.
 * Local files and the app's own media routes say so instead.
 */
export function streamHost(url: string, t: TFunction<'player'>): string | undefined {
  if (!url) return undefined;
  if (/^(file:|[a-z]:[\\/]|\\\\|\/(?!\/))/i.test(url)) return t('infoLocalFile');
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return t('infoLocalFile');
    return u.host || undefined;
  } catch {
    return undefined;
  }
}

/** Container from mpv, else the URL's extension (built-in engines), else the engine's format. */
export function containerLabel(stats: StreamStats, url: string): string | undefined {
  if (stats.container) return stats.container;
  if (stats.engine === 'hls') return 'HLS';
  if (stats.engine === 'dash') return 'DASH';
  if (stats.engine === 'mpegts') return 'MPEG-TS';
  const ext = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url.split('?')[0] ?? url)?.[1]?.toLowerCase();
  return ext && ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'ts', 'mp3', 'aac', 'ogg', 'flac'].includes(ext) ? ext.toUpperCase() : undefined;
}

export function engineLabel(engine: EngineName, t: TFunction<'player'>): string {
  switch (engine) {
    case 'mpv':
      return 'MPV';
    case 'hls':
      return 'hls.js';
    case 'dash':
      return 'Shaka Player';
    case 'mpegts':
      return 'mpegts.js';
    default:
      return t('infoEngineBrowser');
  }
}

export function hwdecLabel(stats: StreamStats, t: TFunction<'player'>): string {
  if (stats.hwdec) return stats.hwdec;
  if (stats.hwdecKnown) return t('infoHwdecOff');
  return stats.engine === 'mpv' ? '–' : t('infoHwdecBrowser');
}

/** Rows of the panel, in order: [label, value]. Unknown values print as an en dash. */
export function statsRows(stats: StreamStats, url: string, t: TFunction<'player'>, locale?: string): [string, string][] {
  const dash = '–';
  const v = (x: string | number | undefined): string => (x === undefined || x === '' ? dash : String(x));
  return [
    [t('infoEngine'), engineLabel(stats.engine, t)],
    [t('infoVideoCodec'), v(codecLabel(stats.videoCodec))],
    [t('infoResolution'), v(resolutionLabel(stats.width, stats.height))],
    [t('infoFrameRate'), v(fpsLabel(stats.fps))],
    [t('infoVideoBitrate'), v(bitrateLabel(stats.videoBitrate))],
    [t('infoAudioCodec'), v(codecLabel(stats.audioCodec))],
    [t('infoChannels'), v(channelsLabel(stats.audioChannels, t))],
    [t('infoAudioBitrate'), v(bitrateLabel(stats.audioBitrate))],
    [t('infoHwdec'), hwdecLabel(stats, t)],
    [t('infoDroppedFrames'), v(stats.droppedFrames === undefined ? undefined : new Intl.NumberFormat(intlLocale(locale)).format(stats.droppedFrames))],
    [t('infoBuffer'), v(secondsLabel(stats.cacheSeconds, locale))],
    [t('infoContainer'), v(containerLabel(stats, url))],
    [t('infoHost'), v(streamHost(url, t))],
  ];
}

/** Seconds buffered ahead of `time` in `ranges` (0 when `time` is outside every range). */
export function bufferAhead(ranges: TimeRanges, time: number): number {
  for (let i = 0; i < ranges.length; i++) {
    if (time >= ranges.start(i) - 0.25 && time <= ranges.end(i)) return Math.max(0, ranges.end(i) - time);
  }
  return 0;
}

/** What the media element itself knows, for every built-in engine. */
export function elementStats(el: HTMLVideoElement | HTMLAudioElement): Partial<MpvStats> {
  const out: Partial<MpvStats> = {};
  if ('videoWidth' in el && el.videoWidth > 0) {
    out.width = el.videoWidth;
    out.height = el.videoHeight;
  }
  const q = 'getVideoPlaybackQuality' in el && typeof el.getVideoPlaybackQuality === 'function' ? el.getVideoPlaybackQuality() : undefined;
  if (q) out.droppedFrames = q.droppedVideoFrames;
  if (el.readyState > 0) out.cacheSeconds = bufferAhead(el.buffered, el.currentTime);
  return out;
}
