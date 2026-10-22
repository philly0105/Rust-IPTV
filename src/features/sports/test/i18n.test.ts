/**
 * sports.json in all 19 locales: each stream button's accessible name holds its visible text
 * (WCAG 2.5.3 Label in Name). The aria-label replaces the button's text (StreamList), so a label
 * that rewords it leaves a voice-control user who says what the button shows with no match.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { i18nextLng, LANGUAGES } from '@/i18n';

const DIR = path.join(__dirname, '..', '..', '..', 'i18n');

const read = (folder: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(DIR, folder, 'sports.json'), 'utf8')) as Record<string, string>;

describe('sports.json stream buttons', () => {
  it.each(LANGUAGES.map((l) => l.code))('%s: Watch, Replay and Record labels contain the visible text', (folder) => {
    const strings = read(folder);
    // The language's own case folding: Turkish 'İzle' is 'izle'.
    const fold = (s: string) => s.toLocaleLowerCase(i18nextLng(folder));
    for (const key of ['watch', 'replay', 'record']) {
      expect(fold(strings[`${key}Label`] ?? ''), `${folder}/sports: ${key}Label`).toContain(fold(strings[key] ?? '\u0000'));
    }
  });
});
