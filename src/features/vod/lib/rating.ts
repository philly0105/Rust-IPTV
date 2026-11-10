/**
 * Rating formatting with no other imports than the Intl locale helper, so Home's route chunk can
 * use it without the player store that `format.ts` imports (performance audit SH-2).
 */

import { intlLocale } from '@/lib/intl';

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

/**
 * `value` to exactly one decimal as English `Intl.NumberFormat` writes it (`minimumFractionDigits`
 * and `maximumFractionDigits` 1, half away from zero on the shortest decimal form, as ICU rounds:
 * 1.15 is "1.2"), or undefined for what this does not cover (negative, 1,000 and up, exponent
 * forms). Home's first commit formats a rating or two (the hero, new arrivals), and the first
 * `Intl.NumberFormat` of a page load costs about 40 ms of a 4x-slowed cold Home: V8 builds the
 * locale data then (`Intl.NumberFormat.supportedLocalesOf` in `intlLocale` pays it as well). In
 * English, the default, that is now spent on the first screen that formats a number some other
 * way. Exported for tests.
 */
export function englishTenths(value: number): string | undefined {
  const m = /^(\d{1,3})(?:\.(\d)(\d*))?$/.exec(String(value));
  if (!m) return undefined;
  let whole = Number(m[1]);
  let tenth = Number(m[2] ?? 0);
  // ICU rounds the shortest decimal form half away from zero: any digit after the tenth from 5 up.
  if (m[3] && m[3].charCodeAt(0) >= 53) {
    tenth += 1;
    if (tenth === 10) {
      tenth = 0;
      whole += 1;
    }
  }
  return whole >= 1000 ? undefined : `${whole}.${tenth}`;
}

/** English (`en`, the default and the fallback) takes {@link englishTenths}; the rest `Intl`. */
function isEnglish(locale: string | undefined): boolean {
  return locale === undefined || locale === 'en';
}

/**
 * `value` with one decimal in the UI language, as `Intl.NumberFormat` with one fraction digit
 * (the hero's rating), without building a formatter in English.
 */
export function formatTenths(value: number, locale?: string): string {
  return (isEnglish(locale) ? englishTenths(value) : undefined) ?? ratingFormat(locale).format(value);
}

/** Rating to one decimal in the UI language ("8.2", de "8,2"); providers report 0..10. */
export function formatRating(r: number | undefined, locale?: string): string | undefined {
  if (r === undefined || !Number.isFinite(r) || r <= 0) return undefined;
  return formatTenths(Math.round(r * 10) / 10, locale);
}
