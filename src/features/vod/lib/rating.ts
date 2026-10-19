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

/** Rating to one decimal in the UI language ("8.2", de "8,2"); providers report 0..10. */
export function formatRating(r: number | undefined, locale?: string): string | undefined {
  if (r === undefined || !Number.isFinite(r) || r <= 0) return undefined;
  return ratingFormat(locale).format(Math.round(r * 10) / 10);
}
