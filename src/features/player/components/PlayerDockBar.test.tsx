/**
 * The mini player on a phone (below sm): a full-width bar docked above the tab bar instead of a
 * floating window, and the mini player's Expand opening the playing item's own page.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import type { PlayerSource } from '@/api/types';
import { PHONE_QUERY } from '@/shell/navigation';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('../parentalHook', () => ({ ensurePlaybackAllowed: async () => true }));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
// The DOM engine itself is not under test here: only the frame around it.
vi.mock('./InlinePlayer', () => ({ InlinePlayer: () => null }));
// Nor smart reconnect, which would retry a failed stream before the bar could show it.
vi.mock('../reconnect', async (orig) => ({ ...(await orig<typeof import('../reconnect')>()), bindRecovery: () => () => undefined }));

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
const { resetMedia } = await import('../media');
const { PlayerDock, PLAYER_BAR_HEIGHT } = await import('./PlayerDock');
const { PlayerStage } = await import('./PlayerStage');

const movie = (itemId: string): PlayerSource => ({
  url: `http://h/m${itemId}.mp4`,
  kind: 'direct',
  title: `Film ${itemId}`,
  isLive: false,
  isRadio: false,
  ref: { sourceId: 'A', contentType: 'movie', itemId },
});
const live: PlayerSource = {
  url: 'http://h/live.m3u8',
  kind: 'hls',
  title: 'Meridian News HD',
  subtitle: 'Midday Briefing',
  isLive: true,
  isRadio: false,
  ref: { sourceId: 'A', contentType: 'live', itemId: '1' },
};

let realMatchMedia: typeof window.matchMedia | undefined;
function phone(on: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: on && query === PHONE_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const region = (): HTMLElement => screen.getByRole('region', { name: 'Now playing' });
const playing = (source: PlayerSource, status: 'playing' | 'error' = 'playing') =>
  act(() => usePlayerStore.setState({ source, mode: 'inline', status, dock: 'mini' }));

beforeEach(() => {
  realMatchMedia = window.matchMedia;
  __resetPlayerForTests();
  resetMedia();
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
});

afterEach(() => {
  cleanup();
  if (realMatchMedia) window.matchMedia = realMatchMedia;
  else delete (window as { matchMedia?: unknown }).matchMedia;
  __resetPlayerForTests();
  resetMedia();
  window.history.replaceState(null, '', '/');
});

describe('player window fill', () => {
  it('moves the same player host into the window and restores its stage on Escape', () => {
    phone(false);
    playing(live);
    render(<><PlayerStage className="h-40 w-64" /><PlayerDock /></>);
    const stage = document.querySelector('[data-player-stage]')!;
    const layer = document.querySelector('[data-player-window-layer]')!;
    const host = stage.querySelector('[data-player-host]')!;

    fireEvent.click(screen.getByRole('button', { name: 'Fill window' }));
    expect(usePlayerStore.getState()).toMatchObject({ isWindowFilled: true, isFullscreen: false });
    expect(layer.contains(host)).toBe(true);
    expect(layer.hasAttribute('hidden')).toBe(false);
    expect(screen.getByRole('button', { name: 'Exit window fill' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(usePlayerStore.getState().isWindowFilled).toBe(false);
    expect(stage.contains(host)).toBe(true);
    expect(layer.hasAttribute('hidden')).toBe(true);
  });

  it('leaves window fill when entering native fullscreen or stopping playback', () => {
    phone(false);
    playing(live);
    render(<><PlayerStage className="h-40 w-64" /><PlayerDock /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Fill window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(usePlayerStore.getState()).toMatchObject({ isWindowFilled: false, isFullscreen: true });
    act(() => usePlayerStore.getState().stop());
    expect(usePlayerStore.getState()).toMatchObject({ isWindowFilled: false, isFullscreen: false });
  });
});

describe('the mini player on a phone', () => {
  it('is a bar over the tab bar: a picture-only thumbnail, the name and what airs, play and close; no drag handle', () => {
    phone(true);
    playing(live);
    render(<PlayerDock />);
    const bar = region();
    expect(bar.dataset['layout']).toBe('bar');
    expect(bar.style.bottom).toBe('var(--shell-bottom-inset, 0px)');
    expect(bar.textContent).toContain('Meridian News HD');
    expect(screen.getByTestId('mini-bar-status').textContent).toBe('Midday Briefing');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close player' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand player' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Drag to move the player' })).toBeNull();
    // The thumbnail carries no player chrome of its own: the bar is its control set.
    const host = bar.querySelector('[data-player-host]');
    expect(host).toBeTruthy();
    expect(host!.querySelector('[data-testid="overlay-chrome"]')).toBeNull();
    expect(host!.querySelector('[data-testid="player-titlebar"]')).toBeNull();
  });

  it("shows a station's art as the thumbnail, with the bar's controls and none of the radio strip's", () => {
    phone(true);
    const station: PlayerSource = { url: 'http://h/fm.mp3', kind: 'direct', title: 'Harbor FM', subtitle: 'Talk Back', isLive: true, isRadio: true, ref: { sourceId: 'B', contentType: 'radio', itemId: '9' } };
    act(() => usePlayerStore.setState({ source: station, mode: 'radio', status: 'playing', dock: 'mini' }));
    render(<PlayerDock />);
    expect(region().textContent).toContain('Harbor FM');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    const host = region().querySelector('[data-player-host]')!;
    expect(host.querySelector('[role="slider"], input[type="range"]')).toBeNull();
    expect(host.querySelector('button')).toBeNull();
  });

  it("keeps a Latin programme line on the name's side in a right-to-left layout", () => {
    // dir="auto" alone aligned 'Politics Tonight' to its own left, away from the name, in Arabic.
    phone(true);
    playing(live);
    render(<PlayerDock />);
    const line = screen.getByTestId('mini-bar-status');
    expect(line.getAttribute('dir')).toBe('auto');
    expect(line.className).toContain('text-match-parent');
  });

  it('keeps the floating window from sm up', () => {
    phone(false);
    playing(live);
    render(<PlayerDock />);
    expect(region().dataset['layout']).toBe('frame');
    expect(screen.getByRole('button', { name: 'Drag to move the player' })).toBeTruthy();
    expect(region().querySelector('[data-testid="overlay-chrome"]')).toBeTruthy();
  });

  it('tells the page how much of its bottom it covers, only while it shows', () => {
    phone(true);
    render(<PlayerDock />);
    const inset = () => document.documentElement.style.getPropertyValue('--player-bar-inset');
    expect(inset()).toBe('0px');
    playing(live);
    expect(inset()).toBe(PLAYER_BAR_HEIGHT);
    act(() => usePlayerStore.getState().stop());
    expect(inset()).toBe('0px');
  });

  it('plays and pauses from the bar, and offers Retry with the reason when the stream failed', () => {
    phone(true);
    playing(movie('31'));
    render(<PlayerDock />);
    const toggle = vi.spyOn(usePlayerStore.getState(), 'togglePlay');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    act(() => usePlayerStore.setState({ status: 'error', error: 'boom' }));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByTestId('mini-bar-status').textContent).toBe('This stream did not play');
  });

  it('closes on a swipe down, and springs back from a short one', () => {
    phone(true);
    playing(live);
    render(<PlayerDock />);
    const bar = region();
    const expand = screen.getByRole('button', { name: 'Expand player' });
    fireEvent.pointerDown(expand, { button: 0, pointerId: 1, pointerType: 'touch', clientY: 700 });
    fireEvent.pointerMove(expand, { pointerId: 1, pointerType: 'touch', clientY: 715 });
    expect(bar.style.transform).toBe('translateY(15px)');
    fireEvent.pointerUp(expand, { pointerId: 1, pointerType: 'touch', clientY: 715 });
    expect(bar.style.transform).toBe('');
    expect(usePlayerStore.getState().source).toBe(live);

    fireEvent.pointerDown(expand, { button: 0, pointerId: 2, pointerType: 'touch', clientY: 700 });
    fireEvent.pointerMove(expand, { pointerId: 2, pointerType: 'touch', clientY: 760 });
    fireEvent.pointerUp(expand, { pointerId: 2, pointerType: 'touch', clientY: 760 });
    expect(usePlayerStore.getState().source).toBeUndefined();
  });

  it("stays under what a page opens over itself (scrims at z-40, menus and sheets at z-50), in both layouts", () => {
    // Equal z-index and DOM order put a page's context menu and the guide's programme sheet under
    // the mini player, which came later in the document; a full-width bar would hide a sheet's last row.
    for (const on of [true, false]) {
      phone(on);
      playing(live);
      const { unmount } = render(<PlayerDock />);
      const z = Number(/(?:^|\s)z-\[?(\d+)\]?(?:\s|$)/.exec(region().className)?.[1]);
      expect(z).toBeGreaterThan(30);
      expect(z).toBeLessThan(40);
      unmount();
    }
  });

  it('a tap anywhere on the bar outside a router goes fullscreen', () => {
    phone(true);
    playing(live);
    render(<PlayerDock />);
    const fullscreen = vi.spyOn(usePlayerStore.getState(), 'toggleFullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' }));
    expect(fullscreen).toHaveBeenCalledTimes(1);
  });
});

describe("the mini player's Expand opens the playing item's page", () => {
  function app(initial: string) {
    window.history.replaceState(null, '', initial);
    const Shell = () => (
      <>
        <Outlet />
        <PlayerDock />
      </>
    );
    const Page = ({ stage }: { stage: boolean }) => <main data-testid={window.location.pathname}>{stage && <PlayerStage className="h-40 w-64" />}</main>;
    const router = createBrowserRouter([
      {
        element: <Shell />,
        children: [
          { path: '/dashboard', element: <Page stage={false} /> },
          { path: '/epg', element: <Page stage /> },
          { path: '/my-videos', element: <Page stage /> },
          { path: '/s/:sourceId/movie/:itemId', element: <Page stage /> },
        ],
      },
    ]);
    render(<RouterProvider router={router} />);
    return router;
  }

  it('opens the movie resumed from Home, not the page of the movie played before it', async () => {
    phone(false);
    act(() => usePlayerStore.setState({ source: movie('20000'), mode: 'inline', status: 'playing' }));
    const router = app('/s/A/movie/20000');
    await act(() => router.navigate('/epg'));
    await act(() => router.navigate('/dashboard'));
    // Harbor Nine resumed from Home's Continue watching: it plays in the mini player.
    playing(movie('31'));
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' }));
    await act(async () => undefined);
    expect(router.state.location.pathname).toBe('/s/A/movie/31');
  });

  it('brings a stream with no page of its own back to the page that showed it in a stage', async () => {
    phone(false);
    const file: PlayerSource = { url: 'file:///rec-1.ts', kind: 'file', title: 'Recording', isLive: false, isRadio: false };
    act(() => usePlayerStore.setState({ source: file, mode: 'inline', status: 'playing' }));
    const router = app('/my-videos');
    await act(() => router.navigate('/dashboard'));
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' }));
    await act(async () => undefined);
    expect(router.state.location.pathname).toBe('/my-videos');
  });
});
