import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
const { useMediaStore } = await import('../media');
const { usePlaybackShortcuts } = await import('../usePlaybackShortcuts');
const { shortcutRegistry } = await import('@/shell/shortcuts');
const { ExternalPlaybackFooter } = await import('./ExternalPlaybackFooter');

function Shortcuts() {
  usePlaybackShortcuts({ channelPanelAvailable: false });
  return null;
}

const vodSource = { url: 'http://h/m.mp4', kind: 'direct' as const, title: 'Movie', isLive: false, isRadio: false };

beforeEach(() => __resetPlayerForTests());
afterEach(() => {
  cleanup();
  __resetPlayerForTests();
  useMediaStore.setState({ externalRuns: [] });
});

describe('playback shortcuts registration', () => {
  it('lists the C16 playback combos while something plays, and none when idle', () => {
    const { unmount } = render(<Shortcuts />);
    const playback = (): string[] => shortcutRegistry.list().filter((s) => s.area === 'Playback').map((s) => s.combo);
    expect(playback()).toEqual([]);

    act(() => {
      usePlayerStore.setState({ source: vodSource, mode: 'inline', status: 'playing' });
    });
    expect(playback()).toEqual(expect.arrayContaining(['space', 'k', 'f', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'm']));

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', bubbles: true }));
    });
    expect(usePlayerStore.getState().muted).toBe(true);

    unmount();
    expect(playback()).toEqual([]);
  });
});

describe('ExternalPlaybackFooter', () => {
  it('is hidden without an external run', () => {
    const { container } = render(<ExternalPlaybackFooter />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the launch from the store, then the started run', () => {
    act(() => {
      usePlayerStore.setState({ source: vodSource, mode: 'external', status: 'loading' });
    });
    render(<ExternalPlaybackFooter />);
    expect(screen.getByText('Playing in MPV')).toBeTruthy();
    expect(screen.getByText('Movie')).toBeTruthy();

    act(() => {
      useMediaStore.setState({ externalRuns: [{ player: 'vlc', title: 'Movie (VLC)', pid: 7, startedAt: 1 }] });
    });
    expect(screen.getByText('Playing in VLC')).toBeTruthy();
    act(() => {
      screen.getByRole('button', { name: 'Dismiss' }).click();
    });
    expect(screen.queryByText('Playing in VLC')).toBeNull();
  });
});
