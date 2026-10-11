/**
 * i18n (SPEC C9). Keys are flat camelCase per namespace. English is bundled
 * eagerly as the fallback; every other `./<lang>/<ns>.json` is a lazy chunk
 * loaded on demand (`loadLanguage`) before i18next switches to it, so the
 * main bundle carries one locale instead of nineteen.
 *
 * Importing this module initializes i18next once and starts loading the
 * language remembered in localStorage. `initI18n()` resolves once that
 * language is active; main.tsx awaits it before the first render, so there
 * is no English flash. The shell applies `settings.language` at runtime via
 * `applyLanguage`, which also loads first.
 */

import i18next, { type Resource } from 'i18next';
import { initReactI18next } from 'react-i18next';

export const NAMESPACES = ['common', 'shell', 'sources', 'settings', 'live', 'vod', 'player', 'library'] as const;
export type Namespace = (typeof NAMESPACES)[number];

export interface LanguageInfo {
  /** Folder name and settings.language value. */
  code: string;
  /** Native name for pickers. */
  name: string;
  /** BCP 47 tag for <html lang> and Intl. */
  bcp47: string;
  rtl?: boolean;
}

export const LANGUAGES: readonly LanguageInfo[] = [
  { code: 'en', name: 'English', bcp47: 'en' },
  { code: 'ar', name: 'العربية', bcp47: 'ar', rtl: true },
  { code: 'ary', name: 'الدارجة المغربية', bcp47: 'ary', rtl: true },
  { code: 'by', name: 'Беларуская', bcp47: 'be' },
  { code: 'de', name: 'Deutsch', bcp47: 'de' },
  { code: 'el', name: 'Ελληνικά', bcp47: 'el' },
  { code: 'es', name: 'Español', bcp47: 'es' },
  { code: 'fr', name: 'Français', bcp47: 'fr' },
  { code: 'hu', name: 'Magyar', bcp47: 'hu' },
  { code: 'it', name: 'Italiano', bcp47: 'it' },
  { code: 'ja', name: '日本語', bcp47: 'ja' },
  { code: 'ko', name: '한국어', bcp47: 'ko' },
  { code: 'nl', name: 'Nederlands', bcp47: 'nl' },
  { code: 'pl', name: 'Polski', bcp47: 'pl' },
  { code: 'pt', name: 'Português', bcp47: 'pt' },
  { code: 'ru', name: 'Русский', bcp47: 'ru' },
  { code: 'tr', name: 'Türkçe', bcp47: 'tr' },
  { code: 'zh', name: '简体中文', bcp47: 'zh-CN' },
  { code: 'zhtw', name: '繁體中文', bcp47: 'zh-TW' },
];

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

/** Lazy loaders for every non-English `./<folder>/<ns>.json`, one chunk each. */
const lazyModules = import.meta.glob(['./*/*.json', '!./en/*.json']) as Record<string, () => Promise<unknown>>;

const loading = new Map<string, Promise<void>>();

/**
 * Loads every namespace of a language folder into i18next (under its BCP 47
 * key). Cached per folder; a failed load is forgotten so a later call retries.
 * English and unknown codes resolve immediately.
 */
export function loadLanguage(code: string): Promise<void> {
  if (code === DEFAULT_LANGUAGE) return Promise.resolve();
  const cached = loading.get(code);
  if (cached) return cached;
  const prefix = `./${code}/`;
  const entries = Object.entries(lazyModules).filter(([path]) => path.startsWith(prefix));
  const job = Promise.all(entries.map(async ([path, load]) => [path, await load()] as const)).then((mods) => {
    const res = buildResources(Object.fromEntries(mods));
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

function storedLanguage(): string {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (v && LANGUAGES.some((l) => l.code === v)) return v;
  } catch {
    // storage blocked
  }
  return DEFAULT_LANGUAGE;
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
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
    react: { useSuspense: false },
  });
  syncDocument(DEFAULT_LANGUAGE);
  ready = activate(storedLanguage());
}

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
}

export const i18n = i18next;
export default i18next;
