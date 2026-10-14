/**
 * Durations and dates for the stats page, through `Intl` only (no date
 * library, contract C7). Watch time reads "3 hr 20 min" (`unitDisplay:
 * 'short'`) in running text and "3h" (`'narrow'`) on the chart axis. Units
 * come from `Intl.NumberFormat`, so every locale gets its own words and
 * digits, and the parts are joined in reading order (RTL-safe).
 */

/** Locales whose app code is not a tag `Intl` knows. */
const INTL_FALLBACK: Record<string, string> = { ary: 'ar', by: 'be', zhtw: 'zh-TW', zh: 'zh-CN' };

/** A BCP 47 tag `Intl` supports for the i18next language, falling back to English. */
export function intlLocale(language: string | undefined): string {
  const lang = language || 'en';
  const candidates = [lang, INTL_FALLBACK[lang], lang.split('-')[0]].filter((x): x is string => !!x);
  for (const c of candidates) {
    try {
      if (Intl.NumberFormat.supportedLocalesOf(c).length > 0) return c;
    } catch {
      // An invalid tag throws; try the next one.
    }
  }
  return 'en';
}

const unitFormats = new Map<string, Intl.NumberFormat>();

function unit(locale: string, u: 'hour' | 'minute' | 'second', display: 'short' | 'narrow' | 'long'): Intl.NumberFormat {
  const key = `${locale}|${u}|${display}`;
  let f = unitFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: display, maximumFractionDigits: 0 });
    unitFormats.set(key, f);
  }
  return f;
}

export interface WatchTimeOptions {
  /** `short` (default) for text, `narrow` for tight spots like axis labels, `long` for screen readers. */
  display?: 'short' | 'narrow' | 'long';
}

/**
 * Watch time for people: hours and minutes ("3 hr 20 min", "45 min"),
 * seconds only under a minute ("40 sec"). Zero parts are left out, so two
 * hours read "2 hr", and nothing reads "0 min" (zero is "0 min" only for 0).
 */
export function formatWatchTime(seconds: number, language: string | undefined, opts: WatchTimeOptions = {}): string {
  const locale = intlLocale(language);
  const display = opts.display ?? 'short';
  const s = Math.max(0, Math.round(seconds));
  if (s === 0) return unit(locale, 'minute', display).format(0);
  if (s < 60) return unit(locale, 'second', display).format(s);
  const totalMinutes = Math.round(s / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(unit(locale, 'hour', display).format(h));
  if (m > 0 || h === 0) parts.push(unit(locale, 'minute', display).format(m));
  return parts.join(' ');
}

/** Hours with one decimal at most, for axis ticks ("1.5h"). */
export function formatAxisHours(seconds: number, language: string | undefined): string {
  const locale = intlLocale(language);
  const key = `${locale}|axis`;
  let f = unitFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { style: 'unit', unit: 'hour', unitDisplay: 'narrow', maximumFractionDigits: 1 });
    unitFormats.set(key, f);
  }
  return f.format(seconds / 3600);
}

/** Minutes for axis ticks under an hour ("30m"). */
export function formatAxisMinutes(seconds: number, language: string | undefined): string {
  return unit(intlLocale(language), 'minute', 'narrow').format(Math.round(seconds / 60));
}

/** Parses `YYYY-MM-DD` as a local date at noon (noon keeps DST shifts from moving the day). */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12);
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

function dateFormat(locale: string, opts: Intl.DateTimeFormatOptions, tag: string): Intl.DateTimeFormat {
  const key = `${locale}|${tag}`;
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    dateFormats.set(key, f);
  }
  return f;
}

/** Short weekday ("Tue"), for the 7-day axis. */
export function weekdayLabel(day: string, language: string | undefined): string {
  return dateFormat(intlLocale(language), { weekday: 'short' }, 'wd').format(parseDay(day));
}

/**
 * Narrow weekday ("T"), for the 7-day axis when the short names do not fit
 * their columns (Arabic short names are whole words, "الأربعاء").
 */
export function narrowWeekdayLabel(day: string, language: string | undefined): string {
  return dateFormat(intlLocale(language), { weekday: 'narrow' }, 'wdn').format(parseDay(day));
}

/** Day of month ("13"), for the 30-day axis. */
export function dayOfMonthLabel(day: string, language: string | undefined): string {
  return dateFormat(intlLocale(language), { day: 'numeric' }, 'dm').format(parseDay(day));
}

/** Full date ("Tuesday, October 13"), for the readout and the table. */
export function longDayLabel(day: string, language: string | undefined): string {
  return dateFormat(intlLocale(language), { weekday: 'long', month: 'long', day: 'numeric' }, 'long').format(parseDay(day));
}

/** Short date ("Oct 13"), for range captions. */
export function shortDayLabel(day: string, language: string | undefined): string {
  return dateFormat(intlLocale(language), { month: 'short', day: 'numeric' }, 'short').format(parseDay(day));
}
