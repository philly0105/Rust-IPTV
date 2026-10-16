/**
 * Plural forms in channels.json, all 19 locales: every plural key carries
 * each form its language's rules need, and all plural keys of a file share
 * one set of forms, so no count falls back to English or to a sibling form.
 *
 * Moroccan Arabic (`ary`) has no CLDR plural rules: `Intl.PluralRules('ary')`
 * resolves to the runtime's default locale, so src/i18n pins it to Arabic
 * rules (`pluralLocale`). Its keys carry all six Arabic forms.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { i18nextLng, LANGUAGES, pluralLocale } from '@/i18n';

const DIR = path.join(__dirname, '..', '..', '..', 'i18n');
const ARABIC = ['zero', 'one', 'two', 'few', 'many', 'other'];
const SUFFIX = /_(zero|one|two|few|many|other)$/;

const read = (folder: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(DIR, folder, 'channels.json'), 'utf8')) as Record<string, string>;

/** Plural keys, from English's `_other` keys. */
const bases = Object.keys(read('en'))
  .filter((k) => k.endsWith('_other'))
  .map((k) => k.slice(0, -'_other'.length));

/** Forms a folder's strings must cover: those of the rules i18next uses for it. */
function needed(folder: string): string[] {
  return [...new Intl.PluralRules(pluralLocale(i18nextLng(folder))).resolvedOptions().pluralCategories];
}

/** The forms present for one plural key, sorted. */
function formsOf(strings: Record<string, string>, base: string): string[] {
  return Object.keys(strings)
    .filter((k) => SUFFIX.test(k) && k.replace(SUFFIX, '') === base)
    .map((k) => SUFFIX.exec(k)![1]!)
    .sort();
}

describe('channels.json plural forms', () => {
  it.each(LANGUAGES.map((l) => l.code))('%s: every form its rules need, one set for every key', (folder) => {
    const strings = read(folder);
    const sets = bases.map((base) => [base, formsOf(strings, base)] as const);
    for (const [base, forms] of sets) {
      for (const form of needed(folder)) expect(forms, `${folder}/channels: ${base}_${form}`).toContain(form);
    }
    const distinct = [...new Set(sets.map(([, forms]) => forms.join(',')))];
    expect(distinct, `${folder}/channels: plural keys with different sets of forms`).toHaveLength(1);
  });

  it('gives Moroccan Arabic all six Arabic forms whatever the runtime resolves ary to', () => {
    const strings = read('ary');
    for (const base of bases) expect(formsOf(strings, base), base).toEqual([...ARABIC].sort());
  });
});
