import { describe, expect, it } from 'vitest';

import i18n, { i18nextLng, LANGUAGES, loadLanguage, NAMESPACES, resources } from '@/i18n';

describe('i18n language keys', () => {
  it('maps folders to BCP 47 tags and bundles only English eagerly', () => {
    expect(i18nextLng('by')).toBe('be');
    expect(i18nextLng('zhtw')).toBe('zh-TW');
    expect(i18nextLng('zh')).toBe('zh-CN');
    expect(i18nextLng('ary')).toBe('ary');
    expect(Object.keys(resources)).toEqual(['en']);
    for (const ns of NAMESPACES) expect(resources['en']?.[ns]).toBeDefined();
  });

  it('loads every folder under its BCP 47 tag', async () => {
    for (const { code, bcp47 } of LANGUAGES) {
      await loadLanguage(code);
      expect(i18n.hasResourceBundle(bcp47, 'common'), `${code} -> ${bcp47}`).toBe(true);
    }
    // Folder names that differ from their tag never become i18next keys.
    for (const folder of ['by', 'zh', 'zhtw']) {
      expect(i18n.hasResourceBundle(folder, 'common')).toBe(false);
    }
  });

  it('caches a language load', () => {
    expect(loadLanguage('de')).toBe(loadLanguage('de'));
  });

  it('uses Belarusian plural rules for the `by` folder', async () => {
    await loadLanguage('by');
    const resolver = i18n.services.pluralResolver as unknown as { getSuffix(lng: string, count: number): string };
    expect(resolver.getSuffix('be', 2)).toBe('_few');
    expect(resolver.getSuffix('be', 5)).toBe('_many');

    const library = i18n.getResourceBundle('be', 'library') as Record<string, string> | undefined;
    const few = library?.['recentCount_few'];
    const many = library?.['recentCount_many'];
    expect(few).toBeTruthy();
    expect(many).toBeTruthy();
    expect(few).not.toBe(many);

    const t = i18n.getFixedT('be', 'library');
    expect(t('recentCount', { count: 2 })).toBe(few!.replace('{{count}}', '2'));
    expect(t('recentCount', { count: 5 })).toBe(many!.replace('{{count}}', '5'));
  });

  it('pins Moroccan Arabic to Arabic plural rules whatever the runtime resolves `ary` to', async () => {
    await loadLanguage('ary');
    const resolver = i18n.services.pluralResolver as unknown as { getSuffix(lng: string, count: number): string };
    expect([0, 1, 2, 5, 11, 100].map((n) => resolver.getSuffix('ary', n))).toEqual([
      '_zero',
      '_one',
      '_two',
      '_few',
      '_many',
      '_other',
    ]);

    const lists = i18n.getResourceBundle('ary', 'lists') as Record<string, string>;
    const t = i18n.getFixedT('ary', 'lists');
    expect(t('channelCount', { count: 2, formatted: '2' })).toBe(lists['channelCount_two']!.replace('{{formatted}}', '2'));
    expect(t('channelCount', { count: 11, formatted: '11' })).toBe(lists['channelCount_many']!.replace('{{formatted}}', '11'));
  });

  it.each([
    ['zhtw', 'zh-TW'],
    ['zh', 'zh-CN'],
  ])('loads the `%s` folder as %s', async (code, bcp47) => {
    await loadLanguage(code);
    expect(i18n.hasResourceBundle(bcp47, 'library')).toBe(true);
    const library = i18n.getResourceBundle(bcp47, 'library') as Record<string, string>;
    const other = library['recentCount_other'];
    expect(other).toBeTruthy();

    const t = i18n.getFixedT(bcp47, 'library');
    expect(t('recentCount', { count: 3 })).toBe(other!.replace('{{count}}', '3'));
    // Not the English fallback.
    expect(t('recentCount', { count: 3 })).not.toBe(i18n.getFixedT('en', 'library')('recentCount', { count: 3 }));
  });
});
