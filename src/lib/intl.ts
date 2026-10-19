/**
 * The `Intl` locale for the app's language (SPEC C9). Every `Intl` constructor
 * takes its locale from `intlLocale`, so dates, numbers, lists and language
 * names follow the language picked in Settings on every machine.
 *
 * App codes and i18next keys are not always tags `Intl` knows: Moroccan Arabic
 * (`ary`) has no CLDR data, so `Intl` would silently fall back to the
 * machine's locale and format it in English on one PC and French on another.
 *
 * The `numberFormat`, `dateTimeFormat` and `relativeTimeFormat` helpers cache
 * formatters. Building one costs far more than formatting with it, and list
 * rows format on every render, so each locale and option set is built once.
 * Pass the arguments the constructor would take (usually `intlLocale(lang)`).
 * An invalid locale throws like the constructor does, and nothing is cached.
 */

import { LANGUAGES } from '@/i18n/languages';

/** App codes (and i18next keys) whose `Intl` locale is not their own tag. */
const INTL_TAGS: Readonly<Record<string, string>> = { ary: 'ar', by: 'be', zhtw: 'zh-TW', zh: 'zh-CN' };

const resolved = new Map<string, string>();

function resolve(lang: string): string {
  const tag = INTL_TAGS[lang] ?? LANGUAGES.find((l) => l.code === lang)?.bcp47 ?? lang;
  for (const c of [tag, tag.split('-')[0]]) {
    if (!c) continue;
    try {
      if (Intl.NumberFormat.supportedLocalesOf(c).length > 0) return c;
    } catch {
      // An invalid tag throws; try the next one.
    }
  }
  return 'en';
}

/**
 * A BCP 47 tag `Intl` supports for an app language code or i18next language
 * (`ary` -> `ar`, `by` -> `be`, `zhtw` -> `zh-TW`, `zh` -> `zh-CN`, the rest
 * from the LANGUAGES table), falling back to English. Cached per input.
 */
export function intlLocale(language: string | null | undefined): string {
  const lang = language || 'en';
  let tag = resolved.get(lang);
  if (tag === undefined) {
    tag = resolve(lang);
    resolved.set(lang, tag);
  }
  return tag;
}

const listFormats = new Map<string, Intl.ListFormat>();

/**
 * Joins a list of names ("Action, Drama and Comedy") with the language's
 * separators and conjunction (`Intl.ListFormat`, `conjunction`): "、" in
 * Chinese and Japanese, "و" in Arabic. Empty parts are dropped.
 */
export function formatList(parts: readonly (string | false | null | undefined)[], language: string | null | undefined): string {
  const items = parts.filter((p): p is string => typeof p === 'string' && p !== '');
  const locale = intlLocale(language);
  let f = listFormats.get(locale);
  if (!f) {
    f = new Intl.ListFormat(locale, { type: 'conjunction', style: 'long' });
    listFormats.set(locale, f);
  }
  return f.format(items);
}

/**
 * The separator between short facts in a label ("Channel 5, BBC One, Playing").
 * Intl.ListFormat's `unit` lists are no use here: several locales join with a
 * bare space (en narrow, ru, ko, tr) or nothing (ja, zh), and ar adds "و"
 * (and). So the separator is fixed per script: "、" (ideographic comma) for
 * Japanese and Chinese, "، " (Arabic comma) for Arabic scripts, ", " otherwise.
 */
export function listSeparator(language: string | null | undefined): string {
  const base = (language || 'en').toLowerCase();
  if (base.startsWith('ja') || base.startsWith('zh')) return '、';
  if (base.startsWith('ar') || base === 'ary' || base.startsWith('fa') || base.startsWith('ur')) return '، ';
  return ', ';
}

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
