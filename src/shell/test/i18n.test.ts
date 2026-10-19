import { afterEach, describe, expect, it } from 'vitest';

import i18n, { LANGUAGES, NAMESPACES, applyLanguage, initI18n, loadLanguage, resources } from '@/i18n';
import { languageLoaders } from '@/i18n/lazyLocales';

describe('i18n lazy locales', () => {
  afterEach(async () => {
    await applyLanguage('en');
  });

  it('bundles only English eagerly', async () => {
    await initI18n();
    expect(Object.keys(resources)).toEqual(['en']);
    expect(i18n.language).toBe('en');
  });

  it('loads a locale before switching, under its BCP 47 key, and sets lang/dir', async () => {
    expect(i18n.hasResourceBundle('ar', 'shell')).toBe(false);
    await applyLanguage('ar');
    expect(i18n.language).toBe('ar');
    expect(i18n.hasResourceBundle('ar', 'shell')).toBe(true);
    expect(i18n.t('shell:navDashboard')).not.toBe(i18n.getFixedT('en')('shell:navDashboard'));
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(localStorage.getItem('tsrust.language')).toBe('ar');

    await loadLanguage('by');
    expect(i18n.hasResourceBundle('be', 'library')).toBe(true);
    expect(i18n.hasResourceBundle('by', 'library')).toBe(false);
  });

  it('loads every namespace of a language through its one loader (SH-8)', async () => {
    // One wrapper per non-English language in the entry, not a lazy map of every file.
    expect(Object.keys(languageLoaders).sort()).toEqual(
      LANGUAGES.filter((l) => l.code !== 'en')
        .map((l) => `./${l.code}/index.ts`)
        .sort(),
    );
    await loadLanguage('ja');
    for (const ns of NAMESPACES) expect(i18n.hasResourceBundle('ja', ns), ns).toBe(true);
  });

  it('the newest request wins when switches overlap', async () => {
    const a = applyLanguage('fr');
    const b = applyLanguage('de');
    await Promise.all([a, b]);
    expect(i18n.language).toBe('de');
    expect(document.documentElement.lang).toBe('de');
  });

  it('unknown codes fall back to English', async () => {
    await applyLanguage('xx');
    expect(i18n.language).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });
});
