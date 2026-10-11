/**
 * Localized durations shared by the VOD runtimes and the library ETAs.
 * `Intl.DurationFormat` first; where the engine lacks it (or the locale, such as
 * `ary`), the `vod` runtime keys (`{{h}}` / `{{m}}`), then the English compact form.
 */

export interface DurationParts {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

/** i18n keys for hours/minutes, `vod` namespace; values use `{{h}}` / `{{m}}`. */
export type RuntimeKey = 'runtimeHours' | 'runtimeMinutes' | 'runtimeHoursMinutes';
export type RuntimeTranslate = (key: RuntimeKey, vars: { h?: number; m?: number }) => string;

export interface DurationFormatOptions {
  /** BCP 47 tag (i18next `i18n.language`). Enables `Intl.DurationFormat` where the engine supports the locale. */
  locale?: string;
  /** Translation fallback when `Intl.DurationFormat` is missing or lacks the locale. */
  t?: RuntimeTranslate;
}

interface DurationFormatLike {
  format(d: DurationParts): string;
}
interface DurationFormatCtor {
  new (locale: string, opts: { style: 'narrow' | 'short' }): DurationFormatLike;
  supportedLocalesOf(locales: string | string[]): string[];
}

const durationFormats = new Map<string, DurationFormatLike | null>();

/**
 * Cached `Intl.DurationFormat` for the locale, or null when unavailable or
 * unsupported. English keeps the compact narrow form (`1h 33m`); other
 * locales use short, because CLDR narrow leaves several of them on Latin
 * letters (ja `1h33m`, de `1h, 33 Min.`) while short is native (`1 時間 33 分`).
 */
function durationFormat(locale: string): DurationFormatLike | null {
  const cached = durationFormats.get(locale);
  if (cached !== undefined) return cached;
  let fmt: DurationFormatLike | null = null;
  const Ctor = (Intl as unknown as { DurationFormat?: DurationFormatCtor }).DurationFormat;
  try {
    // supportedLocalesOf guards codes like `ary` that would otherwise resolve to the runtime default locale.
    if (Ctor && Ctor.supportedLocalesOf(locale).length > 0) {
      fmt = new Ctor(locale, { style: /^en(-|$)/i.test(locale) ? 'narrow' : 'short' });
    }
  } catch {
    fmt = null;
  }
  durationFormats.set(locale, fmt);
  return fmt;
}

/** Test hook: forget cached `Intl.DurationFormat` instances. */
export function resetDurationFormatCache(): void {
  durationFormats.clear();
}

const UNITS = ['days', 'hours', 'minutes', 'seconds'] as const;
const COMPACT: Record<(typeof UNITS)[number], string> = { days: 'd', hours: 'h', minutes: 'm', seconds: 's' };

/** Drops zero units, keeping the smallest given one when all are zero, so `{ hours: 2, minutes: 0 }` reads `2h`. */
function nonZero(parts: DurationParts): DurationParts {
  const out: DurationParts = {};
  for (const k of UNITS) if (parts[k]) out[k] = parts[k];
  if (Object.keys(out).length === 0) {
    const smallest = [...UNITS].reverse().find((k) => parts[k] !== undefined) ?? 'seconds';
    out[smallest] = 0;
  }
  return out;
}

/** Formats duration parts (zero units omitted) for the locale. */
export function formatDurationParts(parts: DurationParts, opts: DurationFormatOptions = {}): string {
  const p = nonZero(parts);
  const fmt = opts.locale ? durationFormat(opts.locale) : null;
  if (fmt) {
    try {
      return fmt.format(p);
    } catch {
      // fall through to the translated form
    }
  }
  if (opts.t && p.days === undefined && p.seconds === undefined) {
    const { hours: h, minutes: m } = p;
    if (h === undefined) return opts.t('runtimeMinutes', { m: m ?? 0 });
    return m === undefined ? opts.t('runtimeHours', { h }) : opts.t('runtimeHoursMinutes', { h, m });
  }
  return UNITS.filter((k) => p[k] !== undefined)
    .map((k) => `${p[k]}${COMPACT[k]}`)
    .join(' ');
}
