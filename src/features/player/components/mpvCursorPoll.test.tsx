/**
 * macOS: the native video view lets pointer moves reach the webview, so fullscreen embedded mpv
 * polls no desktop cursor (F2-3); the player root's own pointer handler brings the chrome back.
 * Windows' poll (one call a tick) is in MpvSurface.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

// Read once, when MpvSurface loads (MAC_DOM_VIDEO_EVENTS).
Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });

vi.mock('@/api/transport', () => ({
  rpc: async (name: string) =>
    name === 'mpv.attach' ? { attached: true, loaded: true, paused: false, timePos: 0, duration: 600, volume: 100, muted: false, fullscreen: false, tracks: [] } : undefined,
  isDesktop: true,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
const cursorReads = vi.fn(async () => ({ x: 10, y: 10 }));
vi.mock('@/api/window', () => ({
  cursorPosition: () => cursorReads(),
  screenToViewport: async (p: { x: number; y: number }) => p,
  enterPipWindow: async () => true,
  exitPipWindow: async () => undefined,
  recoverPipWindow: async () => false,
  setPipWindowAspect: async () => true,
  PIP_DEFAULT_ASPECT: 16 / 9,
  QUIT_FLUSH_EVENT: 'tsrust:flush',
}));

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
const { MAC_DOM_VIDEO_EVENTS } = await import('./MpvSurface');
const { PlayerSurface } = await import('./PlayerSurface');

beforeEach(() => {
  __resetPlayerForTests();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  act(() => {
    usePlayerStore.setState({
      source: { url: 'http://h/movie/1.mkv', kind: 'direct', title: 'Movie', isLive: false, isRadio: false },
      mode: 'embedded-mpv',
      status: 'loading',
      dock: 'stage',
      isFullscreen: true,
    });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetPlayerForTests();
});

describe('fullscreen embedded mpv on macOS', () => {
  it('asks for no cursor position; a pointer move over the video brings the chrome back', async () => {
    expect(MAC_DOM_VIDEO_EVENTS).toBe(true);
    vi.useFakeTimers();
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    const advance = async (ms: number): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    await advance(100);
    act(() => usePlayerStore.setState({ status: 'playing' }));
    await advance(3000);
    expect(screen.queryByTestId('mpv-overlay-chrome')).toBeNull();
    // Before, 15 calls a second for as long as the video filled the screen.
    expect(cursorReads).not.toHaveBeenCalled();
    fireEvent.pointerMove(document.querySelector('[data-mpv-surface]')!);
    expect(screen.getByTestId('mpv-overlay-chrome')).toBeTruthy();
  });
});
