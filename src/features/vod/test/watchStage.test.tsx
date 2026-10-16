/** WatchStage title bar (XB2-5, L2-visual-7). */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/features/player', () => ({ PlayerStage: () => <div data-testid="player-stage" /> }));

const { WatchStage } = await import('../components/detail/WatchStage');

afterEach(() => cleanup());

describe('WatchStage title bar', () => {
  it('lets a Latin title in an RTL UI truncate at its own end and keep to the start edge', () => {
    render(<WatchStage title="The Black Harbor (2026)" subtitle="S1 E2 · Pilot" onClose={() => {}} />);
    const h1 = screen.getByRole('heading', { level: 1, name: 'The Black Harbor (2026)' });
    expect(h1.getAttribute('dir')).toBe('auto');
    expect(h1.className.split(/\s+/)).toEqual(expect.arrayContaining(['truncate', 'text-match-parent']));
    const sub = screen.getByText('S1 E2 · Pilot');
    expect(sub.getAttribute('dir')).toBe('auto');
    expect(sub.className.split(/\s+/)).toEqual(expect.arrayContaining(['truncate', 'text-match-parent']));
  });
});
