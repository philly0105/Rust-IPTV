// F1-2: `t(key)` with no options is answered from one cache shared by every fixed `t`, so a
// static label runs i18next's translate pipeline once per language, not on every render of every
// row. Calls with options pass through, and a language change or new strings empty the cache.
import { cleanup, render } from '@testing-library/react';
import { useTranslation } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import i18n, { applyLanguage, loadLanguage } from '@/i18n';

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  i18n.removeResourceBundle('en', 'cacheTest');
  await applyLanguage('en');
});

describe('fixed t cache', () => {
  it('translates a static key once for every fixed t of the language', () => {
    const translate = vi.spyOn(i18n, 't');
    const a = i18n.getFixedT(i18n.language, 'common');
    expect(a('close')).toBe('Close');
    expect(a('close')).toBe('Close');
    // react-i18next builds a new t per hook instance: it shares the cache.
    expect(i18n.getFixedT(i18n.language, 'common')('close')).toBe('Close');
    expect(translate).toHaveBeenCalledTimes(1);

    // Another namespace or key prefix is another entry.
    expect(i18n.getFixedT(i18n.language, 'library')('close')).toBe('Close');
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('passes calls with options and selector keys through', () => {
    const t = i18n.getFixedT('en', 'library');
    const translate = vi.spyOn(i18n, 't');
    expect(t('recentCount', { count: 1 })).toBe('1 item');
    expect(t('recentCount', { count: 3 })).toBe('3 items');
    expect(t('recentCount', { count: 3 })).toBe('3 items');
    expect(translate).toHaveBeenCalledTimes(3);
  });

  it('answers in the new language after a change', async () => {
    const t = i18n.getFixedT(null, 'common');
    expect(t('cancel')).toBe('Cancel');
    await loadLanguage('de');
    await applyLanguage('de');
    expect(t('cancel')).toBe('Abbrechen');
    expect(i18n.getFixedT(i18n.language, 'common')('cancel')).toBe('Abbrechen');
  });

  it('sees strings added and removed after a key was first drawn', () => {
    const t = i18n.getFixedT('en', 'cacheTest');
    expect(t('hello')).toBe('hello'); // missing: i18next answers the key, and so does the cache
    i18n.addResourceBundle('en', 'cacheTest', { hello: 'Hello there' });
    expect(t('hello')).toBe('Hello there');
    i18n.addResource('en', 'cacheTest', 'hello', 'Hi');
    expect(t('hello')).toBe('Hi');
    i18n.removeResourceBundle('en', 'cacheTest');
    expect(t('hello')).toBe('hello');
  });

  it('keeps the fixed t shape react-i18next and callers read', () => {
    const t = i18n.getFixedT('en', 'common', 'nested') as unknown as { lng: string; ns: string; keyPrefix: string };
    expect(t.lng).toBe('en');
    expect(t.ns).toBe('common');
    expect(t.keyPrefix).toBe('nested');
  });

  it('lets mounting rows reuse the labels their neighbours drew', () => {
    function Row() {
      const { t } = useTranslation('common');
      return (
        <li>
          {t('save')} {t('cancel')}
        </li>
      );
    }
    const translate = vi.spyOn(i18n, 't');
    render(
      <ul>
        {Array.from({ length: 20 }, (_, i) => (
          <Row key={i} />
        ))}
      </ul>,
    );
    // Each of the 20 rows has its own t; the two labels are translated once between them.
    expect(translate.mock.calls.filter(([key]) => key === 'save' || key === 'cancel')).toHaveLength(2);
  });
});
