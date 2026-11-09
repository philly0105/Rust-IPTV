/**
 * The command palette and the shortcut overlay mount on their first open, not with the shell, and
 * stay mounted after they close; their chunks load ahead on the player's schedule or at a press.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/player', () => ({}));

const { OnFirstOpen, PLAYER_PREFETCH_DELAY_MS } = await import('../ShellLayout');
const { useShellStore } = await import('../store');

const isPaletteOpen = (s: { paletteOpen: boolean }) => s.paletteOpen;

let renders = 0;
function Palette() {
  renders++;
  return <p>palette body</p>;
}

beforeEach(() => {
  renders = 0;
  useShellStore.setState({ paletteOpen: false, helpOpen: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('OnFirstOpen', () => {
  it('renders nothing until the first open, then stays mounted when closed', () => {
    const preload = vi.fn(() => Promise.resolve());
    render(
      <OnFirstOpen isOpen={isPaletteOpen} preload={preload}>
        <Palette />
      </OnFirstOpen>,
    );
    expect(screen.queryByText('palette body')).toBeNull();
    expect(renders).toBe(0);
    act(() => useShellStore.getState().setPaletteOpen(true));
    expect(screen.getByText('palette body')).toBeTruthy();
    act(() => useShellStore.getState().setPaletteOpen(false));
    expect(screen.getByText('palette body')).toBeTruthy();
  });

  it('loads the chunk ahead at the first press, and only once', () => {
    const preload = vi.fn(() => Promise.resolve());
    render(
      <OnFirstOpen isOpen={isPaletteOpen} preload={preload}>
        <Palette />
      </OnFirstOpen>,
    );
    expect(preload).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    });
    expect(preload).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    expect(preload).toHaveBeenCalledTimes(1);
    expect(renders).toBe(0);
  });

  it('loads the chunk ahead once the first route has had the delay to itself', () => {
    vi.useFakeTimers();
    const preload = vi.fn(() => Promise.resolve());
    render(
      <OnFirstOpen isOpen={isPaletteOpen} preload={preload}>
        <Palette />
      </OnFirstOpen>,
    );
    act(() => {
      vi.advanceTimersByTime(PLAYER_PREFETCH_DELAY_MS - 1);
    });
    expect(preload).not.toHaveBeenCalled();
    act(() => {
      // Past the delay, then the idle wait (at most PLAYER_IDLE_TIMEOUT_MS) and its quiet check.
      vi.advanceTimersByTime(10_000);
    });
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('mounts at once when the store is already open', () => {
    useShellStore.setState({ paletteOpen: true });
    const preload = vi.fn(() => Promise.resolve());
    render(
      <OnFirstOpen isOpen={isPaletteOpen} preload={preload}>
        <Palette />
      </OnFirstOpen>,
    );
    expect(screen.getByText('palette body')).toBeTruthy();
    expect(preload).not.toHaveBeenCalled();
  });
});
