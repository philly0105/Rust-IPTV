/** WatchStage title bar (XB2-5, L2-visual-7). */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/features/player', () => ({ PlayerStage: () => <div data-testid="player-stage" data-player-focus="" tabIndex={-1} /> }));

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

describe('WatchStage focus (v-player-06)', () => {
  const frames = async (): Promise<void> => {
    await act(async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
  };

  it('gives the player focus when Play dropped it to the page', async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    render(<WatchStage title="Ember Protocol" onClose={() => {}} />);
    await frames();
    expect(document.activeElement).toBe(screen.getByTestId('player-stage'));
  });

  it('leaves focus where the user put it', async () => {
    render(
      <>
        <button type="button">Elsewhere</button>
        <WatchStage title="Ember Protocol" onClose={() => {}} />
      </>,
    );
    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    await frames();
    expect(document.activeElement?.textContent).toBe('Elsewhere');
  });
});
