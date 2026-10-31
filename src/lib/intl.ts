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

// The process's first supportedLocalesOf takes about 8 ms (32 ms in a 4x-slowed profile), but that
// is V8 building NumberFormat's set of available locales, which the first `new Intl.NumberFormat`
// builds as well: in Node 24 a first NumberFormat took 37 ms on its own and 0.3 ms after the check.
// Every screen formats a number, so skipping the check for the LANGUAGES tags would move the cost,
// not save it (P2-BOOT-5).
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

/**
 * A letter or a digit in any script. Tried after the ASCII class (P2-HOME-6): the Unicode property
 * test was 3 ms of a cold Home at a 4x slowdown, for its two or three parts per card, and nearly
 * every part (a Latin title, a year, a count) has an ASCII letter or digit.
 */
const ASCII_WORD = /[A-Za-z0-9]/;
const ANY_WORD = /[\p{L}\p{N}]/u;

/** First-strong isolate (U+2068 ... U+2069): a part's own script sets its direction. */
export const isolate = (part: string) => (ASCII_WORD.test(part) || ANY_WORD.test(part) ? `\u2068${part}\u2069` : part);

/**
 * Joins short facts ("120 channels", "40 movies") with the locale's separator,
 * each fact bidi-isolated so a Latin name or a year keeps its place in an RTL
 * list and vice versa. Falsy and empty parts are dropped.
 *
 * Here, beside listSeparator, since F1-1: ten feature modules use it, and importing it from Home's
 * cards module (`shell/dashboard/cards.tsx`, which re-exports it) put that module and its imports
 * in front of the guide's, Search's and Scheduled's first render. A module of its own came out
 * under the 4 kB chunk floor and the merge moved it, and others with it, into unrelated chunks
 * (Settings' closure grew by 17 kB); this module is in the entry already.
 */
export function joinList(parts: readonly (string | number | false | null | undefined)[], language: string): string {
  return parts
    .filter((p): p is string | number => p !== false && p !== null && p !== undefined && p !== '')
    .map((p) => isolate(String(p)))
    .join(listSeparator(language));
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
