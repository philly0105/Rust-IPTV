/**
 * Every namespace of this language. vite.config.ts puts this module in the language's
 * `locale-<lang>` chunk with its JSON files, so `loadLanguage` (../index.ts) loads it in one
 * request through `../lazyLocales.ts`.
 */
export const modules = import.meta.glob('./*.json', { eager: true, import: 'default' });
