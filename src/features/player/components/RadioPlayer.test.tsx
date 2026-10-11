import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
const { RadioPlayer } = await import('./RadioPlayer');

beforeEach(() => __resetPlayerForTests());
afterEach(() => {
  cleanup();
  __resetPlayerForTests();
});

describe('RadioPlayer', () => {
  it('renders nothing while idle', () => {
    const { container } = render(<RadioPlayer />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the station and toggles play and mute', () => {
    act(() => {
      usePlayerStore.setState({
        source: { url: 'http://r/1.mp3', kind: 'direct', title: 'Jazz FM', isLive: true, isRadio: true },
        mode: 'radio',
        status: 'playing',
      });
    });
    render(<RadioPlayer variant="bar" />);
    expect(screen.getByText('Jazz FM')).toBeTruthy();
    // No ref: no station zapping.
    expect(screen.queryByRole('button', { name: /next station/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    expect(usePlayerStore.getState().status).toBe('paused');

    fireEvent.click(screen.getByRole('button', { name: /^mute$/i }));
    expect(usePlayerStore.getState().muted).toBe(true);
  });
});
