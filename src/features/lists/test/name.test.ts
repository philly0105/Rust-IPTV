// List names are checked as lists::clean_name does before lists.create and
// lists.update: something visible, no control character or line break, at
// most 60 characters, and not another list's name.
import { describe, expect, it } from 'vitest';

import type { CustomList } from '@/api/types';

import { MAX_NAME, nameProblem } from '../lib/cache';

const list = (id: string, name: string): CustomList => ({
  id,
  name,
  position: 0,
  onDashboard: true,
  itemCount: 0,
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
});

describe('nameProblem', () => {
  it('takes a trimmed, visible name', () => {
    expect(nameProblem('  Sport  ', [])).toBeNull();
    expect(nameProblem('Kids \u{1F476}\u{200D}', [])).toBeNull();
  });

  it('calls a name of only white space or invisible characters empty', () => {
    for (const name of ['', '   ', '\u{200B}', '\u{200E}\u{200F}', '\u{3164}', '\u{2800}', '\u{FEFF}', ' \u{AD}\u{2060} ', '\u{E0020}']) {
      expect(nameProblem(name, []), JSON.stringify(name)).toBe('errorNameEmpty');
    }
  });

  it('refuses control characters and line or paragraph separators inside the name', () => {
    for (const name of ['News\nSport', 'News\tSport', 'News\u0085Sport', 'News\u{2028}Sport', 'News\u{2029}Sport']) {
      expect(nameProblem(name, []), JSON.stringify(name)).toBe('errorNameControl');
    }
    // At the ends they are white space and trimmed.
    expect(nameProblem('\nNews\u{2029}', [])).toBeNull();
  });

  it('checks in the core order: empty, control, too long, duplicate', () => {
    expect(nameProblem('\u{200B}'.repeat(MAX_NAME + 5), [])).toBe('errorNameEmpty');
    expect(nameProblem(`${'x'.repeat(MAX_NAME)}\ty`, [])).toBe('errorNameControl');
    expect(nameProblem('x'.repeat(MAX_NAME + 1), [])).toBe('errorNameLong');
    expect(nameProblem(' sport ', [list('a', 'Sport')])).toBe('errorDuplicate');
    expect(nameProblem('Sport', [list('a', 'Sport')], 'a')).toBeNull();
  });
});
