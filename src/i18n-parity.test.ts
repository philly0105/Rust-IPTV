/**
 * Key parity across the 19 locales (contract C6): every registered namespace
 * exists in every locale folder, and each locale file has exactly English's
 * key set, with plural keys expanded per locale.
 *
 * Plural rules (as i18next resolves them, see i18n-plurals.test.ts): a key is
 * plural when English has `<base>_other`. A locale must then carry
 * `<base>_<category>` for every CLDR cardinal category of its BCP 47 tag
 * (`Intl.PluralRules`), for example `_one/_few/_many/_other` for Belarusian
 * (`by` -> `be`) and only `_other` for Japanese. Other plural suffixes of the
 * same base are tolerated: i18next never reads them (ja/ko/zh keep an English
 * style `_one`).
 *
 * Values must be non-empty strings, and `{{placeholders}}` must match English
 * (a plural form may leave out `{{count}}`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { i18nextLng, LANGUAGES, NAMESPACES } from '@/i18n';

const I18N_DIR = path.join(__dirname, 'i18n');

/** The CLDR plural suffixes i18next uses for cardinal plurals. */
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
const PLURAL_RE = new RegExp(`_(${PLURAL_SUFFIXES.join('|')})$`);

/**
 * Problems that existed before this test, as `<locale>/<namespace>: <problem>`
 * strings exactly as the test reports them. Each entry is a debt to fix in
 * that locale file, then delete here; the last test fails once an entry no
 * longer occurs, so the list cannot go stale. Empty when this test was added
 * (wave 0, round two): every namespace was already in parity.
 */
const KNOWN_GAPS: readonly string[] = [];

type Strings = Record<string, unknown>;

function readNamespace(folder: string, ns: string): { data?: Strings; error?: string } {
  const file = path.join(I18N_DIR, folder, `${ns}.json`);
  if (!fs.existsSync(file)) return { error: 'missing file' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    return { error: `invalid JSON (${(err as Error).message})` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: 'not a JSON object' };
  return { data: parsed as Strings };
}

/** `{{name}}` and `{{name, format}}` placeholder names. */
function placeholders(value: string): Set<string> {
  return new Set([...value.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]!));
}

function pluralCategories(folder: string): string[] {
  return new Intl.PluralRules(i18nextLng(folder)).resolvedOptions().pluralCategories;
}

/** Every parity problem of one locale namespace against English. */
function compare(folder: string, ns: string, en: Strings, loc: Strings): string[] {
  const out: string[] = [];
  const pluralBases = new Set(
    Object.keys(en)
      .filter((k) => k.endsWith('_other'))
      .map((k) => k.slice(0, -'_other'.length)),
  );
  const baseOf = (key: string): string | null => {
    const base = key.replace(PLURAL_RE, '');
    return base !== key && pluralBases.has(base) ? base : null;
  };

  const required = new Set<string>();
  for (const key of Object.keys(en)) if (baseOf(key) === null) required.add(key);
  const categories = pluralCategories(folder);
  for (const base of pluralBases) for (const c of categories) required.add(`${base}_${c}`);

  for (const key of required) if (!(key in loc)) out.push(`missing ${key}`);
  for (const key of Object.keys(loc)) {
    if (!required.has(key) && baseOf(key) === null) out.push(`extra ${key}`);
  }

  for (const [key, value] of Object.entries(loc)) {
    if (typeof value !== 'string') {
      out.push(`not a string ${key}`);
      continue;
    }
    if (value.trim() === '') {
      out.push(`empty ${key}`);
      continue;
    }
    const base = baseOf(key);
    const reference = en[base === null ? key : `${base}_other`];
    if (typeof reference !== 'string') continue;
    const want = placeholders(reference);
    const have = placeholders(value);
    for (const p of want) {
      if (!have.has(p) && !(base !== null && p === 'count')) out.push(`placeholder {{${p}}} missing in ${key}`);
    }
    for (const p of have) if (!want.has(p)) out.push(`unknown placeholder {{${p}}} in ${key}`);
  }
  return out.map((p) => `${folder}/${ns}: ${p}`);
}

/** Every parity problem across all locales and namespaces, known gaps included. */
function allProblems(): string[] {
  const problems: string[] = [];
  for (const ns of NAMESPACES) {
    const en = readNamespace('en', ns);
    if (!en.data) {
      problems.push(`en/${ns}: ${en.error}`);
      continue;
    }
    for (const { code } of LANGUAGES) {
      const loc = code === 'en' ? en : readNamespace(code, ns);
      if (!loc.data) problems.push(`${code}/${ns}: ${loc.error}`);
      else problems.push(...compare(code, ns, en.data, loc.data));
    }
  }
  return problems;
}

describe('i18n key parity', () => {
  it('has one folder per UI language and only registered namespaces in each', () => {
    const folders = fs
      .readdirSync(I18N_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(folders).toEqual(LANGUAGES.map((l) => l.code).sort());
    const registered = [...NAMESPACES].sort();
    for (const folder of folders) {
      const files = fs
        .readdirSync(path.join(I18N_DIR, folder))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length))
        .sort();
      expect(files, `${folder}: namespace files vs NAMESPACES in src/i18n/index.ts`).toEqual(registered);
    }
  });

  it('registers the round-two namespaces', () => {
    expect(NAMESPACES).toEqual(expect.arrayContaining(['multiview', 'parental', 'mylist']));
  });

  it("gives every locale English's key set, plural forms and placeholders", () => {
    const known = new Set(KNOWN_GAPS);
    const problems = allProblems().filter((p) => !known.has(p));
    expect(problems, `${problems.length} i18n parity problem(s):\n${problems.join('\n')}`).toEqual([]);
  });

  it('keeps KNOWN_GAPS current (remove entries once fixed)', () => {
    const current = new Set(allProblems());
    expect(KNOWN_GAPS.filter((gap) => !current.has(gap))).toEqual([]);
  });

  it('checks plural categories per BCP 47 tag, not per folder name', () => {
    const sorted = (folder: string) => [...pluralCategories(folder)].sort();
    expect(sorted('by')).toEqual(['few', 'many', 'one', 'other']);
    expect(sorted('zhtw')).toEqual(['other']);
    expect(sorted('ar')).toEqual(['few', 'many', 'one', 'other', 'two', 'zero']);
    // A Belarusian file missing `_few` is reported; a Japanese `_one` is tolerated.
    const en = { items_one: '{{count}} item', items_other: '{{count}} items', title: 'Title {{name}}' };
    expect(compare('by', 'x', en, { items_one: 'a', items_many: 'b', items_other: 'c', title: '{{name}}' })).toEqual([
      'by/x: missing items_few',
    ]);
    expect(compare('ja', 'x', en, { items_one: '1', items_other: '{{count}}', title: '{{name}}' })).toEqual([]);
    expect(compare('de', 'x', en, { items_one: 'x', items_other: 'y', title: '{{nme}}', extra: 'z' })).toEqual([
      'de/x: extra extra',
      'de/x: placeholder {{name}} missing in title',
      'de/x: unknown placeholder {{nme}} in title',
    ]);
  });
});
