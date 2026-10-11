import { afterEach, describe, expect, it } from 'vitest';

import i18n, { applyLanguage, initI18n, loadLanguage, resources } from '@/i18n';

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
