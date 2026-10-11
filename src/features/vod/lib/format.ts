import type { PlaybackPosition } from '@/api/types';
import { formatDurationParts, resetDurationFormatCache, type DurationFormatOptions } from '@/lib/duration';

type ProgressInput = Pick<PlaybackPosition, 'positionSeconds' | 'durationSeconds'> & Partial<Pick<PlaybackPosition, 'watched'>>;

/** True when the row was marked watched (`userstate.setWatched`). */
export function isWatched(pos: Partial<Pick<PlaybackPosition, 'watched'>> | undefined | null): boolean {
  return pos?.watched === true;
}

/** `1:02:03` / `4:05`. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

export type { RuntimeKey, RuntimeTranslate } from '@/lib/duration';
export type RuntimeFormatOptions = DurationFormatOptions;

/** Test hook: forget cached `Intl.DurationFormat` instances. */
export const resetRuntimeFormatCache = resetDurationFormatCache;

/**
 * Localized runtime, `1h 52m` / `48m` in English. Undefined for missing or
 * zero durations. Order of preference: `Intl.DurationFormat` for `locale`,
 * then the `t` keys, then the English short form (see `@/lib/duration`).
 */
export function formatRuntime(totalSeconds: number | undefined, opts: RuntimeFormatOptions = {}): string | undefined {
  if (!totalSeconds || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return undefined;
  const mins = Math.max(1, Math.round(totalSeconds / 60));
  return formatDurationParts({ hours: Math.floor(mins / 60), minutes: mins % 60 }, opts);
}

/** 0..1 watched fraction, or 0 when the duration is unknown. */
export function progressFraction(pos: ProgressInput | undefined | null): number {
  if (isWatched(pos)) return 1;
  if (!pos || !pos.durationSeconds || pos.durationSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, pos.positionSeconds / pos.durationSeconds));
}

/** A saved position worth offering "Resume" for (past 10 s, before 95 %). */
export function isResumable(pos: ProgressInput | undefined | null): boolean {
  if (!pos || isWatched(pos) || pos.positionSeconds < 10) return false;
  if (!pos.durationSeconds) return true;
  return pos.positionSeconds < pos.durationSeconds * 0.95;
}

const ratingFormats = new Map<string, Intl.NumberFormat>();

function ratingFormat(locale: string | undefined): Intl.NumberFormat {
  const key = locale ?? '';
  let f = ratingFormats.get(key);
  if (!f) {
    const opts = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
    try {
      f = new Intl.NumberFormat(locale, opts);
    } catch {
      f = new Intl.NumberFormat('en', opts);
    }
    ratingFormats.set(key, f);
  }
  return f;
}

/** Rating to one decimal in the UI language ("8.2", de "8,2"); providers report 0..10. */
export function formatRating(r: number | undefined, locale?: string): string | undefined {
  if (r === undefined || !Number.isFinite(r) || r <= 0) return undefined;
  return ratingFormat(locale).format(Math.round(r * 10) / 10);
}

/** Season/episode code, `S01E04`. */
export function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

/** Separators around an episode code ("S01E02 - ", ": S01E02"). */
const SEP = String.raw`[\s\-–—:·|.,_]*`;
/** A series-name prefix needs a real separator, so "Lost Souls" keeps its first word in series "Lost". */
const PREFIX_SEP = String.raw`\s*[\-–—:·|]\s*`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Episode title without the noise Xtream panels wrap around it:
 * `Captain Kindling - S01E02 - Last Call` -> `Last Call`. Strips a leading
 * series name and a leading or trailing episode code (`S01E02`, `1x02`) for
 * this season/episode. Returns '' when nothing else is left.
 */
export function cleanEpisodeTitle(title: string | undefined, seriesTitle: string | undefined, season: number, episode: number): string {
  let t = (title ?? '').trim();
  const series = seriesTitle?.trim();
  if (series) {
    if (t.toLowerCase() === series.toLowerCase()) return '';
    t = t.replace(new RegExp(`^${escapeRegExp(series)}${PREFIX_SEP}`, 'i'), '');
  }
  const code = String.raw`(?:S0*${season}\s*[.\-_ ]?\s*E0*${episode}|0*${season}x0*${episode})(?![0-9])`;
  t = t.replace(new RegExp(`^${code}${SEP}`, 'i'), '').replace(new RegExp(`${SEP}${code}$`, 'i'), '');
  return t.trim();
}

/**
 * Episode line shared by downloads, playback, and positions: `S01E02 · Title`.
 * The library (My Videos) groups episode downloads by `title` = series name
 * and parses this code back out of `subtitle`, so it is not translated.
 * The title is cleaned of a repeated series name and code; generic provider
 * names ("Episode 2") are kept; an empty title gives the code alone.
 */
export function episodeSubtitle(season: number, episode: number, title: string | undefined, seriesTitle?: string): string {
  const code = episodeCode(season, episode);
  const name = cleanEpisodeTitle(title, seriesTitle, season, episode);
  return name ? `${code} · ${name}` : code;
}

/** Download file name (hint for `downloads.start`): `Series - S01E02 - Title.ext` or `Movie.ext`. */
export function downloadFileName(title: string, subtitle: string | undefined, extension: string | undefined): string {
  const ext = (extension || 'mp4').trim().replace(/^\.+/, '') || 'mp4';
  const sub = subtitle?.replace(/\s*·\s*/g, ' - ').trim();
  return `${title.trim()}${sub ? ` - ${sub}` : ''}.${ext}`;
}
