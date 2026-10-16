// Rename rules (C2): trimmed, 1 to 120 characters as the core counts them,
// empty or the provider's name resets, an unchanged name sends nothing.
import { describe, expect, it } from 'vitest';

import { NAME_MAX, nameLength, planRename } from '../name';

const plain = { current: 'BBC One', provider: 'BBC One', renamed: false };
const renamed = { current: 'My News', provider: 'BBC One', renamed: true };

describe('planRename', () => {
  it('renames to the trimmed name', () => {
    expect(planRename('  BBC One HD  ', plain)).toEqual({ kind: 'rename', name: 'BBC One HD' });
  });

  it('sends nothing when the name did not change', () => {
    expect(planRename('BBC One', plain)).toEqual({ kind: 'unchanged' });
    expect(planRename(' My News ', renamed)).toEqual({ kind: 'unchanged' });
  });

  it('refuses an empty name unless there is a custom name to remove', () => {
    expect(planRename('', plain)).toEqual({ kind: 'invalid', reason: 'empty' });
    expect(planRename('   ', plain)).toEqual({ kind: 'invalid', reason: 'empty' });
    expect(planRename('', renamed)).toEqual({ kind: 'reset' });
    expect(planRename(' \t ', renamed)).toEqual({ kind: 'reset' });
  });

  it("resets when the provider's name is typed back", () => {
    expect(planRename('BBC One', renamed)).toEqual({ kind: 'reset' });
    expect(planRename(' BBC One ', renamed)).toEqual({ kind: 'reset' });
  });

  it('takes 120 characters and refuses 121', () => {
    expect(planRename('x'.repeat(NAME_MAX), plain)).toEqual({ kind: 'rename', name: 'x'.repeat(120) });
    expect(planRename('x'.repeat(NAME_MAX + 1), plain)).toEqual({ kind: 'invalid', reason: 'tooLong' });
    // Surrounding spaces do not count.
    expect(planRename(`  ${'x'.repeat(NAME_MAX)}  `, plain).kind).toBe('rename');
  });

  it('counts characters, not UTF-16 units, as the core does', () => {
    expect(nameLength('📺')).toBe(1);
    expect(nameLength('Ελληνικά')).toBe(8);
    const emoji = '📺'.repeat(NAME_MAX);
    expect(emoji.length).toBe(240);
    expect(planRename(emoji, plain)).toEqual({ kind: 'rename', name: emoji });
    expect(planRename(`${emoji}📺`, plain)).toEqual({ kind: 'invalid', reason: 'tooLong' });
  });

  it('reports too long before unchanged', () => {
    const long = 'y'.repeat(130);
    expect(planRename(long, { current: long, provider: long, renamed: false })).toEqual({ kind: 'invalid', reason: 'tooLong' });
  });

  it('refuses a name with no visible character as empty, as the core does', () => {
    const blanks = [
      '\u{200B}',
      '\u{AD}\u{34F}\u{61C}',
      '\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180B}\u{180F}',
      '\u{200C}\u{200D}\u{200E}\u{200F}\u{202A}\u{202E}\u{2060}\u{206F}',
      '\u{2800}\u{3164}\u{FE00}\u{FE0F}\u{FEFF}\u{FFA0}\u{FFF0}\u{FFF8}',
      '\u{1BCA0}\u{1BCA3}\u{1D173}\u{1D17A}\u{E0000}\u{E0FFF}',
      ' \u{3000}\u{200B}\u{A0} ',
    ];
    for (const name of blanks) {
      expect(planRename(name, plain), JSON.stringify(name)).toEqual({ kind: 'invalid', reason: 'empty' });
      // Only a really empty field goes back to the provider's name.
      expect(planRename(name, renamed), JSON.stringify(name)).toEqual({ kind: 'invalid', reason: 'empty' });
    }
    // 130 invisible characters are empty first, like normalize_name.
    expect(planRename('\u{200B}'.repeat(130), plain)).toEqual({ kind: 'invalid', reason: 'empty' });
    // Inside a visible name they are kept: U+200D and U+FE0F build emoji.
    expect(planRename('BBC \u{1F468}\u{200D}\u{1F469}\u{FE0F}', plain)).toEqual({ kind: 'rename', name: 'BBC \u{1F468}\u{200D}\u{1F469}\u{FE0F}' });
  });

  it('refuses control characters and line or paragraph separators', () => {
    for (const name of ['BBC\nOne', 'BBC\tOne', 'BBC\u0000One', 'BBC\u007FOne', 'BBC\u0085One', 'BBC\u{2028}One', 'BBC\u{2029}One']) {
      expect(planRename(name, plain), JSON.stringify(name)).toEqual({ kind: 'invalid', reason: 'control' });
    }
    // At either end they are white space, and trimmed like Rust's str::trim does.
    expect(planRename('\nBBC One HD\u{2028}', plain)).toEqual({ kind: 'rename', name: 'BBC One HD' });
    // Too long is reported before a control character, in the core's order.
    expect(planRename(`${'x'.repeat(NAME_MAX)}\ty`, plain)).toEqual({ kind: 'invalid', reason: 'tooLong' });
  });
});
