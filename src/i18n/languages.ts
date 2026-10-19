/**
 * The language table (SPEC C9), kept apart from `index.ts` so modules that only
 * need it (the `Intl` locale helper) don't initialize i18next on import.
 */

export interface LanguageInfo {
  /** Folder name and settings.language value. */
  code: string;
  /** Native name for pickers. */
  name: string;
  /** BCP 47 tag for <html lang> and i18next. `Intl` goes through `intlLocale` (`@/lib/intl`). */
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
