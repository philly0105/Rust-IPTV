import type { PlaybackPosition } from '@/api/types';
import { isWatchedReplay, MIN_RESUME_SECONDS } from '@/features/player/store';
import { formatDurationParts, resetDurationFormatCache, type DurationFormatOptions } from '@/lib/duration';
import { intlLocale } from '@/lib/intl';

type ProgressInput = Pick<PlaybackPosition, 'positionSeconds' | 'durationSeconds'> &
  Partial<Pick<PlaybackPosition, 'watched' | 'episodeId' | 'ref'>>;

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

/**
 * A saved position worth offering "Resume" for: past the player's own resume
 * threshold (`MIN_RESUME_SECONDS`, so the label matches what playback does)
 * and before 95 %. A watched row is not, except a watched movie replayed
 * part-way to between 5 % and 95 % (`isWatchedReplay`, the player's rule):
 * it resumes there and keeps its watched tick.
 */
export function isResumable(pos: ProgressInput | undefined | null): boolean {
  if (!pos || !(pos.positionSeconds > MIN_RESUME_SECONDS)) return false;
  if (isWatched(pos)) return isWatchedReplay(pos);
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
      f = new Intl.NumberFormat(intlLocale(locale), opts);
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

// One shared pattern pair instead of three RegExps compiled per episode (L2-vod-10): a series'
// first render cleans every season's titles, about 40 ms per 1000 episodes before.
/** Any episode code; groups: 1 season and 2 episode of `S01E02`, 3 the season digit run and 4 the episode of `1x02`. */
const ANY_CODE = String.raw`(?:S0*(\d+)\s*[.\-_ ]?\s*E0*(\d+)|(\d+)x0*(\d+))(?![0-9])`;
const LEADING_CODE = new RegExp(`^${ANY_CODE}${SEP}`, 'i');
const TRAILING_CODE = new RegExp(`${SEP}${ANY_CODE}$`, 'i');

/** The last series-name prefix pattern: a season page cleans many titles of one series in a row. */
let seriesPrefix: { series: string; re: RegExp } | undefined;

/** The per-episode patterns, for numbers the shared ones do not cover (negative or fractional). */
function cleanCodeSlow(t: string, season: number, episode: number): string {
  const code = String.raw`(?:S0*${season}\s*[.\-_ ]?\s*E0*${episode}|0*${season}x0*${episode})(?![0-9])`;
  return t.replace(new RegExp(`^${code}${SEP}`, 'i'), '').replace(new RegExp(`${SEP}${code}$`, 'i'), '');
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
    if (seriesPrefix?.series !== series) seriesPrefix = { series, re: new RegExp(`^${escapeRegExp(series)}${PREFIX_SEP}`, 'i') };
    t = t.replace(seriesPrefix.re, '');
  }
  if (!Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 0) return cleanCodeSlow(t, season, episode).trim();
  const lead = LEADING_CODE.exec(t);
  if (lead) {
    const [s, e] = lead[1] !== undefined ? [lead[1], lead[2]] : [lead[3], lead[4]];
    if (Number(s) === season && Number(e) === episode) t = t.slice(lead[0].length);
  }
  const trail = TRAILING_CODE.exec(t);
  if (trail) {
    if (trail[1] !== undefined) {
      if (Number(trail[1]) === season && Number(trail[2]) === episode) t = t.slice(0, trail.index);
    } else if (Number(trail[4]) === episode) {
      // A trailing `1x02` may start inside a longer digit run ("102x05" holds season 2's "02x05").
      const run = trail[3] ?? '';
      const s = String(season);
      if (run.endsWith(s)) {
        let start = run.length - s.length;
        while (start > 0 && run[start - 1] === '0') start--;
        // Separators hold no digits, so the run starts at the match's first digit.
        const runAt = trail.index + trail[0].search(/\d/);
        // The whole run is the code: the separators before it go too. Otherwise the code starts mid-run.
        t = start === 0 ? t.slice(0, trail.index) : t.slice(0, runAt + start);
      }
    }
  }
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
