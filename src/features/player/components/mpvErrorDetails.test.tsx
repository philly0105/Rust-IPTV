/**
 * The embedded-mpv error strip says what happened and what to do first, and keeps mpv's own
 * reason behind a closed Details disclosure, as InlinePlayer's overlay does (L2-player-13).
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/api/transport', () => ({
  rpc: async (name: string) => (name === 'mpv.attach' ? { attached: true, loaded: false, paused: false, timePos: 0, volume: 100, muted: false, fullscreen: false, tracks: [] } : undefined),
  isDesktop: true,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
vi.mock('@/api/window', () => ({
  cursorInViewport: async () => ({ x: 10, y: 10 }),
  enterPipWindow: async () => true,
  exitPipWindow: async () => undefined,
  recoverPipWindow: async () => false,
  setPipWindowAspect: async () => true,
  PIP_DEFAULT_ASPECT: 16 / 9,
  QUIT_FLUSH_EVENT: 'tsrust:flush',
}));

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
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
    });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetPlayerForTests();
});

const fail = (error: string, compact = false): HTMLElement => {
  render(
    <div data-player-host="">
      <PlayerSurface compact={compact} channelPanelAvailable={false} />
    </div>,
  );
  act(() => usePlayerStore.setState({ status: 'error', error }));
  return screen.getByRole('alert');
};

describe('embedded mpv error strip', () => {
  it('leads with the plain headline and hint; the raw reason sits behind a closed Details', () => {
    const alert = fail('HTTP 404');
    expect(alert.textContent).toMatch(/^This stream no longer exists/);
    const raw = screen.getByTestId('mpv-error-detail');
    expect(raw.textContent).toBe('HTTP 404');
    const details = raw.closest('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Details');
    // The headline line no longer prints the raw reason itself.
    expect(alert.querySelector('.truncate')?.textContent).not.toContain('HTTP 404');
  });

  it('the compact strip keeps only the headline', () => {
    const alert = fail('HTTP 404', true);
    expect(alert.textContent).toContain('This stream no longer exists');
    expect(alert.querySelector('details')).toBeNull();
  });
});
