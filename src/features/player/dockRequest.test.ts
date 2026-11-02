/**
 * F1-1: pages import the player barrel without the dock, which the shell loads itself. The first
 * source in the store asks the shell for the dock at once (PLAYER_DOCK_EVENT), so a play with no
 * press (the phone remote, autoplay) does not wait for the shell's idle load.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PLAYER_DOCK_EVENT } from './dockRequest';

const { usePlayerStore } = await import('@/features/player');

afterEach(() => {
  usePlayerStore.setState({ source: undefined });
});

describe('dock request', () => {
  it('the barrel leaves the dock and the external footer to the shell', async () => {
    const barrel = await import('@/features/player');
    expect('PlayerDock' in barrel).toBe(false);
    expect('ExternalPlaybackFooter' in barrel).toBe(false);
    const dock = await import('./dock');
    expect(typeof dock.PlayerDock).toBe('object'); // memo()
    expect(dock.ExternalPlaybackFooter).toBeTruthy();
    expect(dock.usePlayerStore).toBe(usePlayerStore);
  });

  it('asks for the dock once, when the first source arrives', () => {
    const heard = vi.fn();
    window.addEventListener(PLAYER_DOCK_EVENT, heard);
    try {
      usePlayerStore.setState({ volume: 0.5 });
      expect(heard).not.toHaveBeenCalled();
      usePlayerStore.setState({ source: { url: 'http://x/a.m3u8', title: 'A', kind: 'live' } as never });
      expect(heard).toHaveBeenCalledTimes(1);
      usePlayerStore.setState({ source: { url: 'http://x/b.m3u8', title: 'B', kind: 'live' } as never });
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(PLAYER_DOCK_EVENT, heard);
    }
  });
});
