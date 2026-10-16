import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { applyThemeToDocument } from '../theme';

describe('theme switching', () => {
  it('suspends transitions for a moment while the theme flips, so colours swap in one frame', async () => {
    const html = document.documentElement;
    applyThemeToDocument('dark', false);
    await waitFor(() => expect(html.dataset['themeSwitching']).toBeUndefined());
    applyThemeToDocument('light', false);
    expect(html.dataset['theme']).toBe('light');
    expect(html.dataset['themeSwitching']).toBe('true');
    await waitFor(() => expect(html.dataset['themeSwitching']).toBeUndefined());
  });

  it('does not flag a switch when the theme stays the same', () => {
    const html = document.documentElement;
    applyThemeToDocument('light', true);
    applyThemeToDocument('light', true);
    expect(html.dataset['themeSwitching']).toBeUndefined();
    expect(html.dataset['reducedMotion']).toBe('true');
    applyThemeToDocument('light', false);
    expect(html.dataset['reducedMotion']).toBeUndefined();
  });
});
