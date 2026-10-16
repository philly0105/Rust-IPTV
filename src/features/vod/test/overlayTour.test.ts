/**
 * data-perf r1 F1: the ? overlay lists the first-run tour's keys and where to replay it.
 * It belongs beside src/shell/test/overlayAccuracy.test.ts; it sits here because that
 * file was outside this fixer's paths during the Run 3 fix stage.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DOCUMENTED_SHORTCUTS, SHORTCUT_AREA_KEYS, shortcutReference } from '@/shell/ShortcutOverlay';

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('shortcut overlay: first-run tour', () => {
  it('documents the tour keys and the palette command that replays it', () => {
    const rows = DOCUMENTED_SHORTCUTS.filter((d) => d.area === 'Tour');
    expect(rows.map((d) => [d.combo, d.descKey])).toEqual([
      ['escape', 'scTourSkip'],
      ['arrowleft', 'scTourStep'],
      ['arrowright', 'scTourStep'],
      ['mod+k', 'scTourReplay'],
    ]);
    expect(SHORTCUT_AREA_KEYS.Tour).toBe('shell:areaTour');
    // The keys the tour itself handles, and the palette command the replay row points to.
    const tour = read('src/features/onboarding/tour/Tour.tsx');
    for (const key of ["e.key === 'Escape'", "e.key === 'ArrowRight'", "e.key === 'ArrowLeft'"]) expect(tour, key).toContain(key);
    expect(read('src/shell/CommandPalette.tsx')).toMatch(/id: 'help\.tour', title: t\('takeTour'\)/);
  });

  it('shows the Tour group last, under its translated label', () => {
    const groups = shortcutReference([], (k) => `<${k}>`);
    expect(groups.at(-1)![0]).toBe('<shell:areaTour>');
    expect(groups.at(-1)![1].map((s) => s.description)).toEqual(['<scTourSkip>', '<scTourStep>', '<scTourStep>', '<scTourReplay>']);
  });

  it('names the palette command by the title the palette shows, in every locale', () => {
    const dir = join(ROOT, 'src', 'i18n');
    const locales = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(locales).toHaveLength(19);
    for (const l of locales) {
      const json = JSON.parse(read(`src/i18n/${l.name}/shell.json`)) as Record<string, string>;
      for (const key of ['areaTour', 'scTourSkip', 'scTourStep', 'scTourReplay']) expect(json[key], `${l.name}.${key}`).toBeTruthy();
      expect(json.scTourReplay, l.name).toContain(json.takeTour);
    }
  });
});
