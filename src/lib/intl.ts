/**
 * Cached `Intl` formatters. Building one costs far more than formatting with it, and list rows
 * format on every render, so each locale and option set is built once (the pattern of
 * stats/lib/format.ts). Pass the arguments the constructor would take. An invalid locale throws
 * like the constructor does, and nothing is cached for it.
 */

const formatters = new Map<string, unknown>();

function cached<T>(kind: string, locale: string | undefined, opts: object | undefined, make: () => T): T {
  const key = `${kind}|${locale ?? ''}|${opts ? JSON.stringify(opts) : ''}`;
  let f = formatters.get(key) as T | undefined;
  if (f === undefined) {
    f = make();
    formatters.set(key, f);
  }
  return f;
}

export function numberFormat(locale: string | undefined, opts?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cached('n', locale, opts, () => new Intl.NumberFormat(locale, opts));
}

export function dateTimeFormat(locale: string | undefined, opts?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached('d', locale, opts, () => new Intl.DateTimeFormat(locale, opts));
}

export function relativeTimeFormat(locale: string | undefined, opts?: Intl.RelativeTimeFormatOptions): Intl.RelativeTimeFormat {
  return cached('r', locale, opts, () => new Intl.RelativeTimeFormat(locale, opts));
}
