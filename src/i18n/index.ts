/**
 * i18n (SPEC C9). Keys are flat camelCase per namespace. English is bundled
 * eagerly as the fallback; every other language is one lazy chunk
 * (`locale-<lang>`, all its namespaces) loaded on demand (`loadLanguage`) before i18next switches to it, so the
 * main bundle carries one locale instead of nineteen.
 *
 * Importing this module initializes i18next once and starts loading the
 * language remembered in localStorage. `initI18n()` resolves once that
 * language is active; main.tsx awaits it before the first render, so there
 * is no English flash. The shell applies `settings.language` at runtime via
 * `applyLanguage`, which also loads first.
 *
 * A fresh profile has nothing in localStorage, so the language is unknown
 * until `settings.get` answers. `languageUnresolved()` reports that window;
 * the shell shows a text-free skeleton until the first `applyLanguage`
 * resolves, so a German user never sees an English first frame either.
 */

import i18next, { type Resource } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { intlLocale } from '@/lib/intl';

import { languageLoaders } from './lazyLocales';
import { LANGUAGES, type LanguageInfo } from './languages';

export const NAMESPACES = [
  'common',
  'shell',
  'sources',
  'settings',
  'live',
  'vod',
  'player',
  'library',
  'multiview',
  'parental',
  'mylist',
  // Run 2: custom lists, channel editing, guide search, watch stats.
  'lists',
  'channels',
  'guide',
  'stats',
  // Run 3: first-run tour and What's new.
  'onboarding',
  // NFL, college football, NBA and MLB games with the channels that carry them.
  'sports',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

export { LANGUAGES, type LanguageInfo } from './languages';

export const DEFAULT_LANGUAGE = 'en';
const STORAGE_KEY = 'tsrust.language';

/**
 * i18next language key for a folder / settings code: its BCP 47 tag, so
 * i18next picks the right plural rules (`by` -> `be` gets Belarusian
 * `_few`/`_many`, `zhtw` -> `zh-TW`). Unknown folders keep their name.
 */
export function i18nextLng(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.bcp47 ?? code;
}

/**
 * Language keys whose tag has no CLDR plural rules of its own, mapped to the
 * locale whose rules they use. `Intl.PluralRules('ary')` resolves to the
 * machine's default locale, so without this pin Moroccan Arabic would pick
 * English forms on one machine and Arabic forms on another. Its files carry
 * all six Arabic forms (`_zero/_one/_two/_few/_many/_other`).
 */
const PLURAL_RULE_LOCALES: Readonly<Record<string, string>> = { ary: 'ar' };

/** The locale whose plural rules an i18next language key uses (`ary` -> `ar`, else itself). */
export function pluralLocale(lng: string): string {
  return PLURAL_RULE_LOCALES[lng] ?? lng;
}

type RuleGetter = (code: string, options?: { ordinal?: boolean }) => Intl.PluralRules | undefined;
const pinnedResolvers = new WeakSet<object>();

/**
 * Routes i18next's plural rule lookup through `pluralLocale`, so every
 * plural suffix (`getSuffix`, `getSuffixes`, `needsPlural`) of `ary` follows
 * Arabic rules on every machine. Idempotent per resolver instance.
 */
function pinPluralRules(): void {
  const resolver = i18next.services.pluralResolver as { getRule?: RuleGetter } | undefined;
  if (!resolver || typeof resolver.getRule !== 'function' || pinnedResolvers.has(resolver)) return;
  const getRule = resolver.getRule.bind(resolver);
  resolver.getRule = (code, options) => getRule(pluralLocale(code), options);
  pinnedResolvers.add(resolver);
}

type FormatFn = (value: unknown, lng: string | undefined, options: unknown) => string;
const pinnedFormatters = new WeakSet<object>();

/**
 * Routes i18next's built-in `Intl` formats (`{{count, number}}`, `datetime`,
 * `list` and friends) through `intlLocale`, so an `ary` string formats its
 * numbers as Arabic on every machine instead of in the machine's locale.
 * Idempotent per formatter instance.
 */
function pinIntlFormats(): void {
  const formatter = i18next.services.formatter as { formats?: Record<string, FormatFn>; add?: (name: string, fc: FormatFn) => void } | undefined;
  if (!formatter?.formats || typeof formatter.add !== 'function' || pinnedFormatters.has(formatter)) return;
  for (const name of ['number', 'currency', 'datetime', 'relativetime', 'list']) {
    const builtIn = formatter.formats[name];
    if (builtIn) formatter.add(name, (value, lng, options) => builtIn(value, intlLocale(lng), options));
  }
  pinnedFormatters.add(formatter);
}

/** Builds `{ [bcp47]: { [ns]: json } }` from glob results keyed `./<folder>/<ns>.json`. */
export function buildResources(modules: Record<string, unknown>): Resource {
  const out: Resource = {};
  for (const [path, mod] of Object.entries(modules)) {
    const m = /^\.\/([^/]+)\/([^/]+)\.json$/.exec(path);
    if (!m) continue;
    const [, folder, ns] = m as unknown as [string, string, string];
    const data = (mod as { default?: unknown }).default ?? mod;
    if (typeof data !== 'object' || data === null) continue;
    (out[i18nextLng(folder)] ??= {})[ns] = data as Record<string, string>;
  }
  return out;
}

/** Eager resources: English only (the fallback). Other locales arrive through `loadLanguage`. */
export const resources: Resource = buildResources(
  import.meta.glob('./en/*.json', { eager: true }) as Record<string, unknown>,
);

const loading = new Map<string, Promise<void>>();

/**
 * Loads every namespace of a language folder into i18next (under its BCP 47
 * key). Cached per folder; a failed load is forgotten so a later call retries.
 * English resolves immediately; unknown codes load nothing. The loader map
 * (`lazyLocales.ts`, one wrapper per language) is in the entry, so the
 * language's chunk is the only request.
 */
export function loadLanguage(code: string): Promise<void> {
  if (code === DEFAULT_LANGUAGE) return Promise.resolve();
  const cached = loading.get(code);
  if (cached) return cached;
  const load = languageLoaders[`./${code}/index.ts`];
  const job = (load ? load() : Promise.resolve({ modules: {} }))
    .then(({ modules }) => {
      // `./common.json` in the folder's module is `./<code>/common.json` here.
      const res = buildResources(Object.fromEntries(Object.entries(modules).map(([path, mod]) => [`./${code}/${path.slice(2)}`, mod])));
      for (const [lng, bundles] of Object.entries(res)) {
        for (const [ns, data] of Object.entries(bundles)) i18next.addResourceBundle(lng, ns, data, true, true);
      }
    });
  loading.set(code, job);
  job.catch(() => loading.delete(code));
  return job;
}

export function languageInfo(code: string): LanguageInfo {
  return LANGUAGES.find((l) => l.code === code || l.bcp47 === code) ?? LANGUAGES[0]!;
}

/** The remembered language code, or null when none (or an unknown one) is stored. */
function rememberedLanguage(): string | null {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (v && LANGUAGES.some((l) => l.code === v)) return v;
  } catch {
    // storage blocked
  }
  return null;
}

function storedLanguage(): string {
  return rememberedLanguage() ?? DEFAULT_LANGUAGE;
}

/** False until a language is known: remembered at startup, or applied from settings since. */
let languageKnown = rememberedLanguage() !== null;

/**
 * True while the UI language is still unknown: nothing was remembered in
 * localStorage at startup and `applyLanguage` has not completed yet.
 */
export function languageUnresolved(): boolean {
  return !languageKnown;
}

function syncDocument(code: string): void {
  if (typeof document === 'undefined') return;
  const info = languageInfo(code);
  document.documentElement.lang = info.bcp47;
  document.documentElement.dir = info.rtl ? 'rtl' : 'ltr';
}

function normalize(code: string | undefined | null): string {
  return code && LANGUAGES.some((l) => l.code === code) ? code : DEFAULT_LANGUAGE;
}

/** Latest requested language; an older, slower load never overrides a newer choice. */
let requested = DEFAULT_LANGUAGE;

/** The language `activate` last put on screen (strings and `<html lang/dir>`); English from init. */
let applied = DEFAULT_LANGUAGE;

async function activate(code: string): Promise<void> {
  requested = code;
  try {
    await loadLanguage(code);
  } catch (err) {
    console.warn(`[i18n] could not load "${code}", staying on ${DEFAULT_LANGUAGE}`, err);
    if (requested !== code) return;
    code = DEFAULT_LANGUAGE;
  }
  if (requested !== code && code !== DEFAULT_LANGUAGE) return;
  const lng = i18nextLng(code);
  if (i18next.language !== lng) await i18next.changeLanguage(lng);
  syncDocument(code);
  applied = code;
}

/**
 * True when `code` (settings.language) is already on screen, strings and `<html lang/dir>`, so
 * applying it changes nothing: on a fresh profile, English, which i18next starts in.
 */
export function languageActive(code: string): boolean {
  const next = normalize(code);
  return next === applied && i18next.language === i18nextLng(next);
}

let ready: Promise<void> = Promise.resolve();

if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    resources,
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    ns: [...NAMESPACES],
    defaultNS: 'common',
    fallbackNS: 'common',
    // P2-BOOT-3: i18next's default, named so it skips its natural-language test on every t()
    // call (whether a key with spaces or `?!,;` around the `:` is a sentence, not `ns:key`). The
    // keys here are identifiers, so the test only ever cost a regex run per string drawn.
    nsSeparator: ':',
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
    react: { useSuspense: false },
  });
  syncDocument(DEFAULT_LANGUAGE);
  ready = activate(storedLanguage());
}
// Also when another import initialised i18next first (tests, HMR).
pinPluralRules();
pinIntlFormats();

/**
 * Resolves when i18next is ready to render: the remembered language (or
 * `lang`, when given) is loaded and active. Never rejects; a failed locale
 * load falls back to English.
 */
export function initI18n(lang?: string): Promise<void> {
  return lang === undefined ? ready : applyLanguage(lang);
}

/**
 * Switches language (settings.language): loads its strings, then changes
 * i18next, remembers it for the next cold start, and sets <html lang/dir>.
 */
export async function applyLanguage(code: string | undefined | null): Promise<void> {
  const next = normalize(code);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // storage blocked
  }
  await activate(next);
  languageKnown = true;
}

export const i18n = i18next;
export default i18next;
