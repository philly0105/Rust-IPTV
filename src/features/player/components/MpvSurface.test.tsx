import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import type { Bounds, MpvState } from '@/api/types';

/** When set, `mpv.attach` waits for the test to resolve it. */
let attachGate: Promise<void> | null = null;
const rpcMock = vi.fn(async (name: string, _args?: unknown): Promise<unknown> => {
  if (name === 'mpv.attach') {
    if (attachGate) await attachGate;
    return mpvState;
  }
  if (name === 'mpv.record') return recordReply;
  return undefined;
});
let mpvState: MpvState;
let recordReply: { recording: boolean; path: string | null } = { recording: true, path: null };
const stateListeners = new Set<(st: MpvState) => void>();
const emitState = (st: MpvState): void => {
  for (const l of stateListeners) l(st);
};

vi.mock('@/api/transport', () => ({
  rpc: (name: string, args?: unknown) => rpcMock(name, args),
  isDesktop: true,
  proxiedUrl: (s: { url: string }) => s.url,
}));
const clickListeners = new Set<() => void>();
vi.mock('@/api/events', () => ({
  onAppEvent: (type: string, l: (st: MpvState) => void) => {
    if (type === 'mpv.click') {
      const c = l as unknown as () => void;
      clickListeners.add(c);
      return () => clickListeners.delete(c);
    }
    if (type !== 'mpv.state') return () => undefined;
    stateListeners.add(l);
    return () => stateListeners.delete(l);
  },
}));

/** Where the desktop cursor is, in viewport CSS px (the root measures as BOX). */
let cursor = { x: 10, y: 10 };
vi.mock('@/api/window', () => ({ cursorInViewport: async () => cursor }));

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
  attachGate = null;
  stateListeners.clear();
  mpvState = {
    attached: true,
    loaded: false,
    paused: false,
    timePos: 0,
    volume: 100,
    muted: false,
    fullscreen: false,
    tracks: [],
    recording: false,
    recordPath: null,
  };
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

    // Attached but not loaded: the "opening" notice strip is laid out in flow, outside the surface.
    expect(screen.getByText('Opening the stream in MPV').closest('[data-mpv-reserved]')).toBeTruthy();
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

const surfaceTree = (
  <div data-player-host="">
    <PlayerSurface compact={false} channelPanelAvailable={false} />
  </div>
);

const calls = (name: string): unknown[][] => rpcMock.mock.calls.filter((c) => c[0] === name);

describe('MpvSurface attach', () => {
  it('starts mpv at the saved volume and writes no properties before attach resolves', async () => {
    let open!: () => void;
    attachGate = new Promise((r) => (open = r));
    act(() => usePlayerStore.setState({ volume: 0.35, muted: true }));
    render(surfaceTree);
    await tick();

    expect(calls('mpv.attach')[0]?.[1]).toMatchObject({ volume: 35, muted: true });
    expect(calls('mpv.setProperty')).toHaveLength(0);
    // Connecting: a designed state in the surface, no "0:00 / 0:00" readout yet.
    expect(screen.getByTestId('mpv-connecting').textContent).toContain('Connecting to MPV');
    expect(screen.queryByText(/0:00/)).toBeNull();

    // A state event from before the session was configured must not reset the saved volume.
    act(() => emitState({ ...mpvState, volume: 100, muted: false }));
    expect(usePlayerStore.getState()).toMatchObject({ volume: 0.35, muted: true });

    // The reply itself may still say 100 %: the saved values win and are pushed to mpv.
    await act(async () => {
      open();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(usePlayerStore.getState()).toMatchObject({ volume: 0.35, muted: true });
    expect(calls('mpv.setProperty').map((c) => c[1])).toEqual(
      expect.arrayContaining([
        { name: 'volume', value: 35 },
        { name: 'mute', value: true },
      ]),
    );
    expect(screen.queryByTestId('mpv-connecting')).toBeNull();

    // After attach, state events flow (user changed volume in mpv).
    act(() => emitState({ ...mpvState, volume: 50, muted: false }));
    expect(usePlayerStore.getState()).toMatchObject({ volume: 0.5, muted: false });
  });

  it('a click on the video toggles play and pause once attached', async () => {
    render(surfaceTree);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const toggle = vi.spyOn(usePlayerStore.getState(), 'togglePlay');
    act(() => {
      for (const l of clickListeners) l();
    });
    expect(toggle).toHaveBeenCalledTimes(1);
    toggle.mockRestore();
  });

  it('a StrictMode double mount never detaches the live session', async () => {
    let open!: () => void;
    attachGate = new Promise((r) => (open = r));
    render(<StrictMode>{surfaceTree}</StrictMode>);
    await tick();
    expect(calls('mpv.attach')).toHaveLength(2);
    const detachesBefore = calls('mpv.detach').length; // the cleanup of mount 1
    expect(detachesBefore).toBe(1);

    await act(async () => {
      open();
      await new Promise((r) => setTimeout(r, 20));
    });
    // attach 1 resolving late must not send a second detach that would kill session 2.
    expect(calls('mpv.detach')).toHaveLength(detachesBefore);
    expect(screen.queryByTestId('mpv-connecting')).toBeNull();

    cleanup();
    expect(calls('mpv.detach')).toHaveLength(detachesBefore + 1);
  });
});

describe('MpvSurface recording', () => {
  it('records live embedded playback with a REC timer and reports the file on stop', async () => {
    act(() =>
      usePlayerStore.setState({
        source: { url: 'http://h/live/1.ts', kind: 'direct', title: 'News', isLive: true, isRadio: false },
        status: 'playing',
      }),
    );
    render(surfaceTree);
    await tick();
    act(() => emitState({ ...mpvState, loaded: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Record this stream' }));
    await tick();
    expect(calls('mpv.record')[0]?.[1]).toEqual({ start: true });
    expect(screen.getByTestId('rec-indicator').textContent).toMatch(/REC\s*0:00/);

    act(() => emitState({ ...mpvState, loaded: true, recording: true, recordPath: 'C:/rec/News-20261011-0630.ts' }));
    expect(screen.getByTestId('rec-indicator')).toBeTruthy();

    recordReply = { recording: false, path: 'C:/rec/News-20261011-0630.ts' };
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    await tick();
    expect(calls('mpv.record')[1]?.[1]).toEqual({ start: false });
    expect(screen.queryByTestId('rec-indicator')).toBeNull();
    const { useToastStore } = await import('@/ui/Toast');
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ title: 'Recording saved', description: 'C:/rec/News-20261011-0630.ts' });
    recordReply = { recording: true, path: null };
  });

  it('offers no record control for VOD', async () => {
    render(surfaceTree);
    await tick();
    expect(screen.queryByRole('button', { name: 'Record this stream' })).toBeNull();
  });
});

describe('fullscreen overlay chrome', () => {
  afterEach(() => vi.useRealTimers());

  it('hides when the mouse rests and returns only for movement over the player', async () => {
    vi.useFakeTimers();
    mpvState = { ...mpvState, loaded: true, duration: 600 };
    act(() => usePlayerStore.setState({ isFullscreen: true, status: 'playing' }));
    render(surfaceTree);
    const advance = async (ms: number): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    await advance(100);
    act(() => usePlayerStore.setState({ status: 'playing' }));
    const chrome = (): HTMLElement | null => screen.queryByTestId('mpv-overlay-chrome');
    expect(chrome()).toBeTruthy();

    await advance(3000);
    expect(chrome()).toBeNull();

    // Moving on another monitor (outside the player) does not bring it back.
    cursor = { x: 1900, y: 40 };
    await advance(400);
    expect(chrome()).toBeNull();

    // Moving over the video does.
    cursor = { x: 300, y: 200 };
    await advance(400);
    expect(chrome()).toBeTruthy();
  });
});
