import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import type { Bounds, MpvState } from '@/api/types';

const rpcMock = vi.fn(async (name: string, _args?: unknown): Promise<unknown> => {
  if (name === 'mpv.attach') return mpvState;
  return undefined;
});
let mpvState: MpvState;

vi.mock('@/api/transport', () => ({
  rpc: (name: string, args?: unknown) => rpcMock(name, args),
  isDesktop: true,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
const { useMediaStore } = await import('../media');
const { boundsClear, rectOf } = await import('../mpvBounds');
const { HIDDEN_BOUNDS } = await import('./MpvSurface');
const { PlayerSurface } = await import('./PlayerSurface');

/**
 * A deliberately hostile layout: the surface element claims the full 800x500 box, so the
 * control bar (bottom 60 px) and the notice strip (40 px above it) overlap it on screen.
 * The bounds sent to mpv must still exclude both.
 */
const RECTS: [string, { left: number; top: number; width: number; height: number }][] = [
  ['[data-mpv-surface]', { left: 0, top: 0, width: 800, height: 500 }],
  ['[data-player-controls]', { left: 0, top: 440, width: 800, height: 60 }],
  ['[data-mpv-reserved]', { left: 0, top: 400, width: 800, height: 40 }],
];
const BOX = { left: 0, top: 0, width: 800, height: 500 };
const reservedRects = RECTS.slice(1).map(([, r]) => rectOf(r));

function domRect(r: { left: number; top: number; width: number; height: number }): DOMRect {
  return {
    ...r,
    x: r.left,
    y: r.top,
    right: r.left + r.width,
    bottom: r.top + r.height,
    toJSON: () => r,
  } as DOMRect;
}

const sent = (): Bounds[] =>
  rpcMock.mock.calls
    .filter((c) => c[0] === 'mpv.attach' || c[0] === 'mpv.setBounds')
    .map((c) => (c[1] as { bounds: Bounds }).bounds);

const tick = async (ms = 50): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

beforeEach(() => {
  __resetPlayerForTests();
  rpcMock.mockClear();
  mpvState = { attached: true, loaded: false, paused: false, timePos: 0, volume: 100, muted: false, fullscreen: false, tracks: [] };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const hit = RECTS.find(([sel]) => this.matches(sel));
    return domRect(hit ? hit[1] : BOX);
  });
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    const list = [this.getBoundingClientRect()];
    return Object.assign(list, { item: (i: number) => list[i] ?? null }) as unknown as DOMRectList;
  });
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
  document.querySelectorAll('[aria-modal]').forEach((n) => n.remove());
  vi.unstubAllGlobals();
  __resetPlayerForTests();
  useMediaStore.setState({ mpv: undefined, upNext: undefined });
});

describe('MpvSurface bounds', () => {
  it('never sends a rectangle that overlaps the control bar or the notice strip', async () => {
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    await tick();

    const attach = rpcMock.mock.calls.find((c) => c[0] === 'mpv.attach');
    // At attach time only the control bar exists below the surface.
    expect((attach?.[1] as { bounds: Bounds }).bounds).toEqual({ x: 0, y: 0, width: 800, height: 440 });

    // Attached but not loaded: the "Starting MPV" notice strip is laid out in flow, outside the surface.
    expect(screen.getByText('Starting MPV').closest('[data-mpv-reserved]')).toBeTruthy();
    await tick(100);
    expect(sent().at(-1)).toEqual({ x: 0, y: 0, width: 800, height: 400 });

    // The control bar is excluded from every rectangle; the strip from every one sent after it appeared.
    for (const b of sent()) expect(boundsClear(b, reservedRects.slice(0, 1))).toBe(true);
    expect(boundsClear(sent().at(-1)!, reservedRects)).toBe(true);
  });

  it('moves the native window off screen while a modal dialog is open', async () => {
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    await tick();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    await tick(100);
    expect(sent().at(-1)).toEqual(HIDDEN_BOUNDS);
  });

  it('shows ended state and errors in the reserved strip, not over the surface', async () => {
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    await tick();
    act(() => {
      usePlayerStore.setState({ status: 'paused', positionSeconds: 100, durationSeconds: 100 });
    });
    const replayButtons = screen.getAllByRole('button', { name: 'Replay' });
    expect(replayButtons.length).toBeGreaterThan(0);
    const surface = document.querySelector('[data-mpv-surface]')!;
    for (const b of replayButtons) expect(surface.contains(b)).toBe(false);

    act(() => {
      usePlayerStore.setState({ status: 'error', error: 'mpv stopped unexpectedly' });
    });
    const alert = screen.getByRole('alert');
    expect(alert.hasAttribute('data-mpv-reserved')).toBe(true);
    expect(surface.contains(alert)).toBe(false);
  });
});
