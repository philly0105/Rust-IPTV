import { describe, expect, it, vi } from 'vitest';

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
    expect(t('recentCount', { count: 2 })).toBe(few!.replace('{{count, number}}', '2'));
    expect(t('recentCount', { count: 5 })).toBe(many!.replace('{{count, number}}', '5'));
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

  it('formats `{{count, number}}` through the Intl locale helper (`ary` as Arabic, not the machine locale)', async () => {
    await loadLanguage('ary');
    await loadLanguage('de');
    const arabic = new Intl.NumberFormat('ar').format(1000);
    const Original = Intl.NumberFormat;
    const asked: unknown[] = [];
    vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (locales?: string | string[], options?: Intl.NumberFormatOptions) {
      asked.push(locales);
      return new Original(locales, options);
    } as unknown as typeof Intl.NumberFormat);
    const library = i18n.getResourceBundle('ary', 'library') as Record<string, string>;
    // 1000: Arabic `_other` (1234 would be `_many`).
    expect(i18n.getFixedT('ary', 'library')('recentCount', { count: 1000 })).toBe(
      library['recentCount_other']!.replace('{{count, number}}', arabic),
    );
    // `Intl.NumberFormat('ary')` would silently take the machine's locale.
    expect(asked).not.toContain('ary');
    expect(asked).toContain('ar');
    expect(i18n.getFixedT('de', 'vod')('categoryCount', { count: 1234 })).toBe('1.234 Kategorien');
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
    expect(t('recentCount', { count: 3 })).toBe(other!.replace('{{count, number}}', '3'));
    // Not the English fallback.
    expect(t('recentCount', { count: 3 })).not.toBe(i18n.getFixedT('en', 'library')('recentCount', { count: 3 }));
  });

  // P2-BOOT-3: with the separator left implicit, every t() call ran a regex over its key to tell
  // a sentence from `ns:key`.
  it('reads `ns:key` without testing the key for natural language on each call', () => {
    const t = i18n.getFixedT('en', 'common');
    const test = vi.spyOn(RegExp.prototype, 'test');
    for (let i = 0; i < 5; i++) expect(t('shell:navDashboard')).toBe('Home');
    expect(test.mock.calls.filter(([s]) => s === 'shell:navDashboard')).toEqual([]);
  });
});
