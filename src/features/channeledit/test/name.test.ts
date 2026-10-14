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

  it('reports too long before empty or unchanged', () => {
    const long = 'y'.repeat(130);
    expect(planRename(long, { current: long, provider: long, renamed: false })).toEqual({ kind: 'invalid', reason: 'tooLong' });
  });
});
