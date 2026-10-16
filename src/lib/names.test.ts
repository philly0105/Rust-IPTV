// The core's name rules (channeledit::normalize_name / lists::clean_name),
// mirrored for the rename and list dialogs.
import { describe, expect, it } from 'vitest';

import { hasLineBreak, isBlankName, trimName } from './names';

describe('trimName', () => {
  it("strips Unicode white space at both ends, like Rust's str::trim", () => {
    expect(trimName('  News \t')).toBe('News');
    expect(trimName('\u{3000}\u{A0}News\u{2028}\u0085')).toBe('News');
    expect(trimName('\nBBC\nOne\n')).toBe('BBC\nOne');
    // U+FEFF is not White_Space: Rust keeps it (JS trim would not).
    expect(trimName('\u{FEFF}News')).toBe('\u{FEFF}News');
  });
});

describe('isBlankName', () => {
  it('is true for a name with no visible character', () => {
    for (const name of [
      '',
      ' \t',
      '\u{200B}\u{200C}\u{200D}',
      '\u{AD}\u{34F}\u{61C}\u{115F}\u{1160}\u{17B4}\u{17B5}',
      '\u{180B}\u{180F}\u{200E}\u{200F}\u{202A}\u{202E}\u{2060}\u{206F}',
      '\u{2800}\u{3164}\u{FE00}\u{FE0F}\u{FEFF}\u{FFA0}\u{FFF0}\u{FFF8}',
      '\u{1BCA0}\u{1BCA3}\u{1D173}\u{1D17A}\u{E0000}\u{E0FFF}',
    ]) {
      expect(isBlankName(name), JSON.stringify(name)).toBe(true);
    }
  });

  it('is false as soon as one character shows', () => {
    for (const name of ['a', '\u{200B}x', '📺', '\u{1F468}\u{200D}\u{1F469}', 'ب', '\u{3165}', '\u{2801}', '\u{FFF9}']) {
      expect(isBlankName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe('hasLineBreak', () => {
  it('finds control characters and line or paragraph separators', () => {
    for (const name of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u001Fb', 'a\u007Fb', 'a\u0085b', 'a\u009Fb', 'a\u{2028}b', 'a\u{2029}b']) {
      expect(hasLineBreak(name), JSON.stringify(name)).toBe(true);
    }
  });

  it('leaves format characters and ordinary spaces alone', () => {
    for (const name of ['a b', 'a\u{A0}b', 'a\u{200D}b', 'a\u{200F}b', 'a\u{FEFF}b']) {
      expect(hasLineBreak(name), JSON.stringify(name)).toBe(false);
    }
  });
});
