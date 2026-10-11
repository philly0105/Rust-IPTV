import { describe, expect, it } from 'vitest';

import { cn } from '../cn';

describe('cn', () => {
  it('drops falsy values like clsx', () => {
    expect(cn('a', false, null, undefined, 0, '', { b: true, c: false }, ['d'])).toBe('a b d');
  });

  it('lets later caller classes override primitive defaults', () => {
    expect(cn('px-3 py-2', 'px-6')).toBe('py-2 px-6');
    expect(cn('h-9 w-9', 'h-12')).toBe('w-9 h-12');
    expect(cn('rounded-md', 'rounded-full')).toBe('rounded-full');
    expect(cn('text-sm', 'text-base')).toBe('text-base');
  });

  it('understands the C10 token colors', () => {
    expect(cn('bg-surface', 'bg-accent')).toBe('bg-accent');
    expect(cn('bg-surface-2 text-fg-muted', 'text-fg')).toBe('bg-surface-2 text-fg');
    expect(cn('border border-border', 'border-danger')).toBe('border border-danger');
  });

  it('keeps size and color in the same family apart', () => {
    expect(cn('text-sm text-fg-muted', 'text-accent')).toBe('text-sm text-accent');
    expect(cn('text-fg', 'text-lg')).toBe('text-fg text-lg');
  });

  it('treats the custom shadow scale as sizes', () => {
    expect(cn('shadow-1', 'shadow-2')).toBe('shadow-2');
    expect(cn('shadow-2', 'shadow-none')).toBe('shadow-none');
  });

  it('merges variants independently', () => {
    expect(cn('hover:bg-surface-2 bg-surface', 'hover:bg-surface-3')).toBe('bg-surface hover:bg-surface-3');
    expect(cn('motion-safe:animate-fade-in', 'motion-safe:animate-pop-in')).toBe('motion-safe:animate-pop-in');
  });

  it('leaves custom utilities alone', () => {
    expect(cn('tuning-tick skeleton-surface', 'scrollbar-none')).toBe('tuning-tick skeleton-surface scrollbar-none');
  });
});
