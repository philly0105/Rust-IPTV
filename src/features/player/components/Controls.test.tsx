import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
const { useMediaStore, resetMedia } = await import('../media');
const { Controls } = await import('./Controls');
const { usePipStore } = await import('../pip');

const commands = {
  setQuality: vi.fn(),
  setAudio: vi.fn(),
  setText: vi.fn(),
  setRate: vi.fn(),
  togglePip: vi.fn(),
  retry: vi.fn(),
};

beforeEach(() => {
  __resetPlayerForTests();
  resetMedia();
  vi.clearAllMocks();
  act(() => {
    usePlayerStore.setState({
      source: { url: 'http://v/movie.mp4', kind: 'direct', title: 'Movie', isLive: false, isRadio: false },
      status: 'playing',
      positionSeconds: 10,
      durationSeconds: 600,
    });
    useMediaStore.setState({ commands });
  });
});

afterEach(() => {
  cleanup();
  __resetPlayerForTests();
  resetMedia();
  useMediaStore.setState({ commands: null });
});

const openMenu = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Playback options' }));
};
const menu = (): HTMLElement | null => screen.queryByRole('menu');

describe('Controls options menu', () => {
  it('keeps the seek bar and control row in the dock while the menu is open', () => {
    render(<Controls variant="dock" visible />);
    openMenu();
    expect(menu()).toBeTruthy();
    expect(screen.getByRole('slider', { name: /seek/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /pause/i })).toBeTruthy();

    // The options button in the still-visible row toggles the menu closed.
    openMenu();
    expect(menu()).toBeNull();
  });

  it.each(['dock', 'overlay'] as const)('%s: choosing a speed sets the rate and closes the menu', (variant) => {
    render(<Controls variant={variant} visible />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /playback speed/i }));
    // Submenu navigation keeps the menu open.
    expect(menu()).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitemradio', { name: '1.5x' }));
    expect(commands.setRate).toHaveBeenCalledWith(1.5);
    expect(menu()).toBeNull();
  });

  it.each(['dock', 'overlay'] as const)('%s: the close button closes the menu from any view', (variant) => {
    render(<Controls variant={variant} visible />);
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(menu()).toBeNull();

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /playback speed/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(menu()).toBeNull();
    expect(commands.setRate).not.toHaveBeenCalled();
  });

  it('Back returns to the root view and Escape closes the menu', () => {
    render(<Controls variant="dock" visible />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /playback speed/i }));
    fireEvent.click(screen.getByRole('button', { name: /playback speed/i }));
    expect(screen.getByRole('menuitem', { name: /playback speed/i })).toBeTruthy();
    fireEvent.keyDown(menu()!, { key: 'Escape' });
    expect(menu()).toBeNull();
  });
});

describe('Controls picture-in-picture', () => {
  afterEach(() => usePipStore.setState({ active: false }));

  it('offers picture-in-picture in the mpv dock bar and hides fullscreen while in it', () => {
    act(() => useMediaStore.setState({ canPip: true }));
    const { rerender } = render(<Controls variant="dock" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    expect(commands.togglePip).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeTruthy();

    act(() => usePipStore.setState({ active: true }));
    rerender(<Controls variant="dock" visible />);
    expect(screen.getByRole('button', { name: 'Exit picture in picture' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull();
  });

  it('keeps the compact dock bar free of the picture-in-picture button', () => {
    act(() => useMediaStore.setState({ canPip: true }));
    render(<Controls variant="dock" visible compact />);
    expect(screen.queryByRole('button', { name: 'Picture in picture' })).toBeNull();
  });
});

describe('Controls live rewind', () => {
  const live = { url: 'http://v/live.ts', kind: 'direct' as const, title: 'News', isLive: true, isRadio: false };

  it('shows a seek bar over the cached window and jumps back to live', () => {
    act(() => {
      usePlayerStore.setState({ source: live, mode: 'embedded-mpv', durationSeconds: undefined, positionSeconds: 1000 });
      useMediaStore.setState({ seekable: { start: 900, end: 1090 } });
    });
    const seekTo = vi.spyOn(usePlayerStore.getState(), 'seekTo');
    render(<Controls variant="dock" visible />);
    expect(screen.getByRole('slider', { name: /seek/i })).toBeTruthy();
    expect(screen.getByTestId('behind-live').textContent).toBe('-1:30');
    fireEvent.click(screen.getByRole('button', { name: 'Jump to live' }));
    // A second short of the cache end, so mpv does not stall waiting for data.
    expect(seekTo).toHaveBeenCalledWith(1089);
    seekTo.mockRestore();
  });

  it('reads as live at the edge and hides the bar until 30 s are cached', () => {
    act(() => {
      usePlayerStore.setState({ source: live, mode: 'embedded-mpv', durationSeconds: undefined, positionSeconds: 1085 });
      useMediaStore.setState({ seekable: { start: 900, end: 1090 } });
    });
    const { rerender } = render(<Controls variant="dock" visible />);
    expect(screen.queryByTestId('behind-live')).toBeNull();
    expect((screen.getByRole('button', { name: 'Live' }) as HTMLButtonElement).disabled).toBe(true);

    act(() => useMediaStore.setState({ seekable: { start: 1070, end: 1090 } }));
    rerender(<Controls variant="dock" visible />);
    expect(screen.queryByRole('slider', { name: /seek/i })).toBeNull();
  });
});
