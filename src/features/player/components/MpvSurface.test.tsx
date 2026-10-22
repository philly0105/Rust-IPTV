import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import '@/i18n';

import type { Bounds, MpvState, Settings } from '@/api/types';

/** When set, `mpv.attach` waits for the test to resolve it. */
let attachGate: Promise<void> | null = null;
/** When set, `mpv.attach` rejects with it. */
let attachError: Error | null = null;
/** When set, `mpv.load` resolves or rejects through it. */
let loadImpl: ((args: unknown) => Promise<unknown>) | null = null;
/** When set, `downloads.playback` answers once it resolves. */
let reportGate: Promise<void> | null = null;
const rpcMock = vi.fn(async (name: string, _args?: unknown): Promise<unknown> => {
  if (name === 'downloads.playback' && reportGate) return reportGate;
  if (name === 'mpv.attach') {
    if (attachGate) await attachGate;
    if (attachError) throw attachError;
    return mpvState;
  }
  if (name === 'mpv.load' && loadImpl) return loadImpl(_args);
  if (name === 'mpv.record') return recordReply;
  if (name === 'mpv.command' && (_args as { cmd: unknown[] }).cmd[0] === 'get_property') return videoParams;
  return undefined;
});
let mpvState: MpvState;
/** What `get_property video-params` returns. */
let videoParams: unknown = { dw: 1920, dh: 1080 };
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
const doubleListeners = new Set<() => void>();
/** Listeners for app events that carry a payload (`mpv.wheel`, `mpv.contextmenu`). */
const payloadListeners = new Map<string, Set<(p: unknown) => void>>();
const emitApp = (type: string, payload: unknown): void => {
  for (const l of payloadListeners.get(type) ?? []) l(payload);
};
vi.mock('@/api/events', () => ({
  onAppEvent: (type: string, l: (st: MpvState) => void) => {
    if (type === 'mpv.click' || type === 'mpv.dblclick') {
      const set = type === 'mpv.click' ? clickListeners : doubleListeners;
      const c = l as unknown as () => void;
      set.add(c);
      return () => set.delete(c);
    }
    if (type === 'mpv.wheel' || type === 'mpv.contextmenu') {
      const set = payloadListeners.get(type) ?? new Set();
      payloadListeners.set(type, set);
      const c = l as unknown as (p: unknown) => void;
      set.add(c);
      return () => set.delete(c);
    }
    if (type !== 'mpv.state') return () => undefined;
    stateListeners.add(l);
    return () => stateListeners.delete(l);
  },
}));

/** Where the desktop cursor is, in viewport CSS px (the root measures as BOX). */
let cursor = { x: 10, y: 10 };
vi.mock('@/api/window', () => ({
  cursorInViewport: async () => cursor,
  enterPipWindow: async () => true,
  exitPipWindow: async () => undefined,
  recoverPipWindow: async () => false,
  setPipWindowAspect: async () => true,
  PIP_DEFAULT_ASPECT: 16 / 9,
  QUIT_FLUSH_EVENT: 'tsrust:flush',
}));

const { usePlayerStore, __resetPlayerForTests, DOUBLE_CLICK_MS, setSettingsCache } = await import('../store');
const { useMediaStore } = await import('../media');
const { boundsClear, rectOf } = await import('../mpvBounds');
const { HIDDEN_BOUNDS, MPV_FALLBACK_TOAST } = await import('./MpvSurface');
const { clearMpvUnavailable } = await import('../mpvExtras');
const { PlayerSurface } = await import('./PlayerSurface');
const reconnect = await import('../reconnect');
const { useAlternatesStore } = await import('../failover');

/**
 * A deliberately hostile layout: the surface element claims the full 800x500 box, so the
 * control bar (bottom 60 px) and the notice strip (40 px above it) overlap it on screen.
 * The bounds sent to mpv must still exclude both.
 */
const RECTS: [string, { left: number; top: number; width: number; height: number }][] = [
  ['[data-mpv-surface]', { left: 0, top: 0, width: 800, height: 500 }],
  ['[data-player-controls]', { left: 0, top: 440, width: 800, height: 60 }],
  ['[data-mpv-reserved]', { left: 0, top: 400, width: 800, height: 40 }],
  // Overlays the tests add over the video.
  ['[data-test-rect="small"]', { left: 300, top: 100, width: 200, height: 150 }],
  ['[data-test-rect="menu"]', { left: 500, top: 200, width: 225, height: 283 }],
];
const BOX = { left: 0, top: 0, width: 800, height: 500 };
const reservedRects = RECTS.slice(1, 3).map(([, r]) => rectOf(r));

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
  clearMpvUnavailable();
  rpcMock.mockClear();
  attachGate = null;
  attachError = null;
  loadImpl = null;
  reportGate = null;
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
  useMediaStore.setState({ mpv: undefined, upNext: undefined, osd: undefined });
  vi.useRealTimers();
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

  const lastLayout = (): { bounds: Bounds; holes: Bounds[] } | undefined =>
    rpcMock.mock.calls.filter((c) => c[0] === 'mpv.setBounds').at(-1)?.[1] as { bounds: Bounds; holes: Bounds[] } | undefined;

  it('keeps the video around a small dialog and cuts the dialog out of it (L2-desktop-7)', async () => {
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    await tick(100);
    const before = sent().at(-1);
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true" data-test-rect="small"></div>');
    await tick(100);
    expect(lastLayout()).toEqual({ bounds: before, holes: [{ x: 300, y: 100, width: 200, height: 150 }] });
    // Closing it gives the whole video back.
    document.querySelector('[data-test-rect="small"]')!.remove();
    await tick(100);
    expect(lastLayout()).toEqual({ bounds: before, holes: [] });
  });

  it("dims the video under a dialog's backdrop like the scrim dims the page, and undims it on close (L3-desktop-10)", async () => {
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    await tick(100);
    const overlays = (): unknown[][] =>
      calls('mpv.command')
        .map((c) => (c[1] as { cmd: unknown[] }).cmd)
        .filter((cmd) => cmd[0] === 'osd-overlay');
    expect(overlays()).toEqual([]);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div data-dialog-layer="" id="palette"><div aria-hidden="true" class="fixed inset-0 bg-scrim" style="background-color: rgba(4, 8, 16, 0.72)"></div><div role="dialog" aria-modal="true" data-test-rect="small"></div></div>',
    );
    await tick(100);
    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]).toEqual(expect.arrayContaining(['osd-overlay', 63, 'ass-events']));
    expect(String(overlays()[0]?.[3])).toContain('\\1c&H100804&\\1a&H47&');
    // The panel is still a hole in the dimmed video.
    expect(lastLayout()?.holes).toEqual([{ x: 300, y: 100, width: 200, height: 150 }]);
    document.getElementById('palette')!.remove();
    await tick(100);
    expect(overlays()).toHaveLength(2);
    expect(overlays()[1]).toEqual(['osd-overlay', 63, 'none', '']);
  });

  it('cuts a menu portalled to the body out of the video instead of covering it (L2-desktop-3)', async () => {
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    await tick(100);
    document.body.insertAdjacentHTML('beforeend', '<div role="menu" data-test-rect="menu"></div>');
    await tick(100);
    const last = lastLayout()!;
    expect(last.bounds).toEqual({ x: 0, y: 0, width: 800, height: 400 });
    expect(last.holes).toEqual([{ x: 500, y: 200, width: 225, height: 200 }]);
    document.querySelector('[data-test-rect="menu"]')!.remove();
  });

  it('says a slow live start is still connecting over the native video and offers another source (X-desk-1)', async () => {
    const ref = { sourceId: 's1', contentType: 'live' as const, itemId: '7' };
    act(() => {
      usePlayerStore.setState({ source: { url: 'http://h/live/7.ts', kind: 'direct', title: 'News', isLive: true, isRadio: false, ref }, status: 'loading' });
      useAlternatesStore.setState({ forKey: 's1|live|7', status: 'ready', data: { alternates: [{}] } as never });
    });
    const swap = vi.spyOn(reconnect, 'tryAnotherSource').mockResolvedValue(true);
    onTestFinished(() => {
      swap.mockRestore();
      reconnect.__resetReconnect();
      useAlternatesStore.setState({ forKey: undefined, status: 'idle', data: undefined });
    });
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    await tick();
    expect(screen.queryByTestId('connecting-notice')).toBeNull();
    act(() => reconnect.useReconnectStore.setState({ phase: 'connecting' }));
    const notice = screen.getByTestId('connecting-notice');
    expect(notice.textContent).toContain('Still connecting');
    // A hole in the native window: outside the surface (whose own content is never cut out).
    expect(notice.hasAttribute('data-mpv-overlay')).toBe(true);
    expect(notice.closest('[data-mpv-surface]')).toBeNull();
    fireEvent.click(within(notice).getByRole('button', { name: 'Try another source' }));
    expect(swap).toHaveBeenCalledTimes(1);
  });

  it('cuts a player overlay (the zap chip) out of the video as soon as it mounts, not at the next poll (X-desk-2)', async () => {
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    await tick(100);
    const before = lastLayout()!.bounds;
    document.querySelector('[data-player-host]')!.insertAdjacentHTML('beforeend', '<div data-mpv-overlay="" data-test-rect="small"></div>');
    // Well under the 400 ms poll: the mount itself re-measures in the next frame.
    await tick(40);
    expect(lastLayout()).toEqual({ bounds: before, holes: [{ x: 300, y: 100, width: 200, height: 150 }] });
    document.querySelector('[data-test-rect="small"]')!.remove();
    await tick(40);
    expect(lastLayout()).toEqual({ bounds: before, holes: [] });
  });

  it('a live stream that mpv reports as dropped becomes a player error, so recovery can retry it (L2-desktop-2)', async () => {
    act(() => {
      usePlayerStore.setState({
        source: { url: 'http://h/live/1.ts', kind: 'direct', title: 'News', isLive: true, isRadio: false },
        status: 'loading',
      });
    });
    render(surfaceTree);
    await tick();
    act(() => emitState({ ...mpvState, loaded: true, timePos: 30 }));
    expect(usePlayerStore.getState().status).toBe('playing');
    // `end-file` eof on a live item (core `mpv_state::LIVE_ENDED`): not a pause.
    act(() => emitState({ ...mpvState, loaded: false, error: 'The live stream stopped: the provider closed the connection.' }));
    expect(usePlayerStore.getState()).toMatchObject({ status: 'error', error: 'The live stream stopped: the provider closed the connection.' });
    expect(screen.getByRole('alert').getAttribute('data-error-class')).toBe('generic');
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

  it('a double click restores the play state and toggles fullscreen', async () => {
    render(surfaceTree);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const wasFullscreen = usePlayerStore.getState().isFullscreen;
    const wasPaused = useMediaStore.getState().mpv?.paused ?? false;
    act(() => {
      for (const l of clickListeners) l();
      for (const l of doubleListeners) l();
    });
    expect(usePlayerStore.getState().isFullscreen).toBe(!wasFullscreen);
    expect(calls('mpv.setProperty').map((c) => c[1])).toContainEqual({ name: 'pause', value: wasPaused });
  });

  it.each([
    ['with Up next pending', true],
    ['with no Up next', false],
  ])('a double click on an ended item (%s) only toggles fullscreen; a single click replays after the double-click time', async (_n, pending) => {
    render(surfaceTree);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const ended = (): void => {
      act(() => {
        usePlayerStore.setState({
          source: { url: 'http://h/movie/1.mkv', kind: 'direct', title: 'Movie', isLive: false, isRadio: false },
          status: 'paused',
          positionSeconds: 600,
          durationSeconds: 600,
        });
        if (pending) {
          useMediaStore.setState({
            upNext: { source: { url: 'http://h/movie/2.mkv', kind: 'direct', title: 'Next', isLive: false, isRadio: false }, deadline: Date.now() + 60_000 },
          });
        }
      });
    };
    ended();
    const toggle = vi.spyOn(usePlayerStore.getState(), 'togglePlay');
    const wasFullscreen = usePlayerStore.getState().isFullscreen;
    const pauses = (): number => calls('mpv.setProperty').filter((c) => (c[1] as { name: string }).name === 'pause').length;
    const pausesBefore = pauses();
    vi.useFakeTimers();
    // A slow double click (Windows allows up to 900 ms between the clicks).
    act(() => {
      for (const l of clickListeners) l();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    act(() => {
      for (const l of doubleListeners) l();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOUBLE_CLICK_MS);
    });
    expect(toggle).not.toHaveBeenCalled();
    expect(usePlayerStore.getState()).toMatchObject({ positionSeconds: 600, status: 'paused', isFullscreen: !wasFullscreen });
    expect(!!useMediaStore.getState().upNext).toBe(pending);
    expect(pauses()).toBe(pausesBefore);

    // A single click replays, once the double-click time has passed.
    act(() => {
      for (const l of clickListeners) l();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOUBLE_CLICK_MS - 1);
    });
    expect(toggle).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(toggle).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
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

  const startFullscreen = async (): Promise<(ms: number) => Promise<void>> => {
    vi.useFakeTimers();
    cursor = { x: 10, y: 10 };
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
    return advance;
  };

  it('keyboard focus on a control keeps the chrome up', async () => {
    const advance = await startFullscreen();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    act(() => screen.getByRole('button', { name: 'Pause' }).focus());
    await advance(3000);
    expect(screen.queryByTestId('mpv-overlay-chrome')).toBeTruthy();
  });

  it('when the chrome hides under a clicked control, focus lands on the player, not the page', async () => {
    const advance = await startFullscreen();
    const pause = screen.getByRole('button', { name: 'Pause' });
    fireEvent.pointerDown(pause);
    act(() => pause.focus());
    await advance(3000);
    expect(screen.queryByTestId('mpv-overlay-chrome')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('mpv-player'));
  });

  it('leaving fullscreen puts focus back on the same control', async () => {
    const advance = await startFullscreen();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    act(() => screen.getByRole('button', { name: 'Exit fullscreen' }).focus());
    act(() => usePlayerStore.setState({ isFullscreen: false }));
    await advance(50);
    expect(document.activeElement?.getAttribute('data-ctl')).toBe('fullscreen');
  });
});

describe('embedded mpv readouts and errors', () => {
  it('shows volume and seek readouts inside the bar, then clears them', async () => {
    vi.useFakeTimers();
    render(surfaceTree);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const { showOsd } = await import('../media');
    act(() => showOsd('Volume 40%'));
    expect(screen.getByTestId('bar-readout').textContent).toBe('Volume 40%');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByTestId('bar-readout').textContent).toBe('');
    vi.useRealTimers();
  });

  it('a key that brings hidden fullscreen chrome back still shows its readout; a stale one does not', async () => {
    vi.useFakeTimers();
    cursor = { x: 10, y: 10 };
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
    const { showOsd } = await import('../media');
    act(() => showOsd('Old'));
    await advance(3000);
    expect(screen.queryByTestId('mpv-overlay-chrome')).toBeNull();

    // The same key press raises the readout and (via keydown) the chrome.
    act(() => {
      showOsd('Volume 55%');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    });
    expect(screen.getByTestId('bar-readout').textContent).toBe('Volume 55%');
    vi.useRealTimers();
  });

  it('in PiP the readout briefly replaces the title in the bar', async () => {
    vi.useFakeTimers();
    const { usePipStore } = await import('../pip');
    act(() => usePipStore.setState({ active: true }));
    render(surfaceTree);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const bar = screen.getByTestId('pip-bar');
    expect(bar.textContent).toContain('Movie');
    const { showOsd } = await import('../media');
    act(() => showOsd('Muted'));
    expect(bar.textContent).toContain('Muted');
    expect(bar.textContent).not.toContain('Movie');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(bar.textContent).toContain('Movie');
    act(() => usePipStore.setState({ active: false }));
    vi.useRealTimers();
  });

  it('shows a buffering strip when mpv stalls mid-stream, and clears it when data returns', async () => {
    mpvState = { ...mpvState, loaded: true, duration: 600 };
    render(surfaceTree);
    await tick();
    act(() => emitState({ ...mpvState, loaded: true, buffering: true }));
    expect(useMediaStore.getState().waiting).toBe(true);
    const label = screen.getByTestId('mpv-buffering');
    expect(label.textContent).toBe('Buffering');
    // Docked: an in-flow reserved strip, never over the native surface.
    expect(label.closest('[data-mpv-reserved]')).toBeTruthy();
    expect(screen.queryByTestId('bar-readout')?.contains(label)).toBe(false);

    act(() => emitState({ ...mpvState, loaded: true, buffering: false }));
    expect(screen.queryByTestId('mpv-buffering')).toBeNull();
    expect(useMediaStore.getState().waiting).toBe(false);
  });

  it('in fullscreen a stall shows in the bar readout and keeps the chrome up', async () => {
    vi.useFakeTimers();
    cursor = { x: 10, y: 10 };
    mpvState = { ...mpvState, loaded: true, duration: 600 };
    act(() => usePlayerStore.setState({ isFullscreen: true, status: 'playing' }));
    render(surfaceTree);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    act(() => emitState({ ...mpvState, loaded: true, buffering: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.queryByTestId('mpv-overlay-chrome')).toBeTruthy();
    expect(screen.getByTestId('bar-readout').textContent).toBe('Buffering');

    // Data is back: the readout clears and the idle chrome is free to hide again.
    act(() => emitState({ ...mpvState, loaded: true, buffering: false }));
    expect(screen.queryByTestId('mpv-buffering')).toBeNull();
    expect(screen.queryByTestId('mpv-overlay-chrome')).toBeNull();
  });

  it('in PiP a stall replaces the title in the bar', async () => {
    const { usePipStore } = await import('../pip');
    mpvState = { ...mpvState, loaded: true, duration: 600 };
    act(() => usePipStore.setState({ active: true }));
    render(surfaceTree);
    await tick();
    act(() => emitState({ ...mpvState, loaded: true, buffering: true }));
    expect(screen.getByTestId('pip-bar').textContent).toContain('Buffering');
    act(() => emitState({ ...mpvState, loaded: true, buffering: false }));
    expect(screen.getByTestId('pip-bar').textContent).toContain('Movie');
    act(() => usePipStore.setState({ active: false }));
  });

  it('focuses Retry when the stream fails and focus was lost', async () => {
    render(surfaceTree);
    await tick();
    act(() => usePlayerStore.setState({ status: 'error', error: 'HTTP 404' }));
    const retry = within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' });
    expect(document.activeElement).toBe(retry);
    // A headline says what happened (classified: a 404 is a removed stream); mpv's terse reason follows.
    expect(screen.getByRole('alert').textContent).toContain('This stream no longer exists');
    expect(screen.getByRole('alert').getAttribute('data-error-class')).toBe('notFound');
    expect(screen.getByTestId('mpv-error-detail').textContent).toBe('HTTP 404');

    // Retry reloads and says so, even though mpv still reports the old load.
    mpvState = { ...mpvState, loaded: true };
    fireEvent.click(retry);
    expect(rpcMock.mock.calls.some((c) => c[0] === 'mpv.load')).toBe(true);
    expect(screen.getByText('Opening the stream in MPV')).toBeTruthy();
  });

  it.each([
    [false, ['otherSources', 'nextChannel']],
    [true, ['nextChannel']],
  ] as const)('a channel the provider lacks, compact %s: Other sources only where the bar can open the menu that lists them', async (compact, actions) => {
    const ref = { sourceId: 's1', contentType: 'live' as const, itemId: '7' };
    act(() => {
      usePlayerStore.setState({ source: { url: 'http://h/live/7.ts', kind: 'direct', title: 'News', isLive: true, isRadio: false, ref }, status: 'loading' });
      useAlternatesStore.setState({ forKey: 's1|live|7', status: 'ready', data: { alternates: [{}] } as never });
    });
    onTestFinished(() => useAlternatesStore.setState({ forKey: undefined, status: 'idle', data: undefined }));
    render(
      <div data-player-host="">
        <PlayerSurface compact={compact} channelPanelAvailable={false} />
      </div>,
    );
    await tick();
    act(() => usePlayerStore.setState({ status: 'error', error: 'HTTP 404' }));
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-error-class')).toBe('notFound');
    // The mini player's strip has room for one button: never one that does nothing there.
    expect(Array.from(within(alert).getByTestId('error-actions').querySelectorAll('[data-action]')).map((b) => b.getAttribute('data-action'))).toEqual(actions);
  });
});

describe('embedded mpv recovery', () => {
  it('after mpv crashes, Retry starts a new session and loads the item again', async () => {
    render(surfaceTree);
    await tick();
    expect(calls('mpv.attach')).toHaveLength(1);
    const loadsBefore = calls('mpv.load').length;

    const crash = 'mpv stopped unexpectedly (exit code 3). Start playback again to restart it.';
    act(() => emitState({ ...mpvState, attached: false, error: crash }));
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-error-class')).toBe('crashed');
    expect(alert.textContent).toContain('MPV stopped unexpectedly');

    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    await tick();
    expect(calls('mpv.attach')).toHaveLength(2);
    expect(calls('mpv.load').length).toBe(loadsBefore + 1);
    expect(usePlayerStore.getState().status).not.toBe('error');
  });

  it('a failed restart stays in the player as an error with Retry', async () => {
    render(surfaceTree);
    await tick();
    act(() => emitState({ ...mpvState, attached: false, error: 'Lost the connection to mpv.' }));
    attachError = Object.assign(new Error('mpv exited during startup'), { code: 'internal' });
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    await tick();
    // Retry really started a second session; it failed, so the error stays.
    expect(calls('mpv.attach')).toHaveLength(2);
    expect(usePlayerStore.getState()).toMatchObject({ status: 'error', mode: 'embedded-mpv' });
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it.each([
    ['the engine_missing code', Object.assign(new Error('mpv could not start'), { code: 'engine_missing' })],
    ['the mpv.exe message the core sends today', Object.assign(new Error('mpv.exe was not found'), { code: 'not_found' })],
  ])('a restart that finds mpv gone falls back to the built-in player, never "stream no longer exists" (%s)', async (_name, err) => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    onTestFinished(() => {
      play.mockRestore();
      pause.mockRestore();
      load.mockRestore();
    });
    render(surfaceTree);
    await tick();
    act(() => emitState({ ...mpvState, attached: false, error: 'Lost the connection to mpv.' }));
    attachError = err;
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    await tick();
    expect(usePlayerStore.getState()).toMatchObject({ mode: 'inline', error: undefined });
    expect(screen.queryByText(/no longer exists/i)).toBeNull();
    const { useToastStore } = await import('@/ui/Toast');
    // Not found is not a failed start (L3-desktop-6): it says so and how to fix it.
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ title: "MPV wasn't found. Set its path under External players.", variant: 'info' });
  });

  it('a rejected load is reported with its class instead of loading forever', async () => {
    loadImpl = async () => {
      throw Object.assign(new Error('request timed out'), { code: 'timeout' });
    };
    render(surfaceTree);
    await tick();
    expect(usePlayerStore.getState().status).toBe('error');
    expect(screen.getByRole('alert').getAttribute('data-error-class')).toBe('timeout');
  });

  it('state from the previous file is not credited to the next item', async () => {
    mpvState = { ...mpvState, loaded: true, duration: 600 };
    let finishLoad!: () => void;
    render(surfaceTree);
    await tick();
    act(() => emitState({ ...mpvState, loaded: true, timePos: 120, duration: 600 }));
    expect(usePlayerStore.getState().positionSeconds).toBe(120);

    // Switch items; mpv has not accepted the new load yet.
    loadImpl = () => new Promise((r) => (finishLoad = () => r(undefined)));
    act(() =>
      usePlayerStore.setState({
        source: { url: 'http://h/movie/2.mkv', kind: 'direct', title: 'Next', isLive: false, isRadio: false },
        status: 'loading',
        positionSeconds: 0,
      }),
    );
    // The old file reaches its end (keep-open pauses there): no "ended" for the new item.
    act(() => emitState({ ...mpvState, loaded: true, timePos: 600, duration: 600, paused: true }));
    expect(usePlayerStore.getState().positionSeconds).toBe(0);
    expect(usePlayerStore.getState().status).toBe('loading');

    await act(async () => {
      finishLoad();
      await new Promise((r) => setTimeout(r, 10));
    });
    act(() => emitState({ ...mpvState, loaded: true, timePos: 3, duration: 900, paused: false }));
    expect(usePlayerStore.getState()).toMatchObject({ positionSeconds: 3, status: 'playing' });
  });

  it('a new play of the loaded item loads it again (Start over); an update that only renames it does not', async () => {
    render(surfaceTree);
    await tick();
    const loadsBefore = calls('mpv.load').length;
    act(() => usePlayerStore.setState({ source: { ...usePlayerStore.getState().source!, title: 'Renamed' } }));
    await tick();
    expect(calls('mpv.load').length).toBe(loadsBefore);
    await act(async () => {
      await usePlayerStore.getState().play({ ...usePlayerStore.getState().source! }, { mode: 'embedded-mpv' });
    });
    await tick();
    expect(calls('mpv.load').length).toBe(loadsBefore + 1);
    expect((calls('mpv.load').at(-1)![1] as { source: { url: string } }).source.url).toBe('http://h/movie/1.mkv');
  });

  it('loads a provider stream once the core has made room for it on the source (downloads)', async () => {
    const { bindPlaybackReport } = await import('../playbackReport');
    let answer: () => void = () => undefined;
    reportGate = new Promise<void>((resolve) => (answer = resolve));
    const unbind = bindPlaybackReport();
    onTestFinished(unbind);
    act(() =>
      usePlayerStore.setState({ source: { ...usePlayerStore.getState().source!, ref: { sourceId: 'xt', contentType: 'movie', itemId: '1' } } }),
    );
    render(surfaceTree);
    await tick();
    expect(calls('downloads.playback')).toHaveLength(1);
    // A download may still hold the account's connection: mpv must not ask for the stream yet.
    expect(calls('mpv.load')).toHaveLength(0);
    answer();
    await tick();
    expect(calls('mpv.load')).toHaveLength(1);
  });

  it('a placeholder without a stream URL pauses mpv instead of loading an empty URL', async () => {
    render(surfaceTree);
    await tick();
    const loadsBefore = calls('mpv.load').length;
    act(() =>
      usePlayerStore.setState({
        source: { url: '', kind: 'direct', title: 'Episode 2', isLive: false, isRadio: false },
        status: 'error',
        error: 'not found',
      }),
    );
    await tick();
    expect(calls('mpv.load').length).toBe(loadsBefore);
    expect(calls('mpv.setProperty').map((c) => c[1])).toContainEqual({ name: 'pause', value: true });
  });

  /** The built-in player takes over after a fallback; jsdom has no media playback. */
  const stubMedia = (): void => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    onTestFinished(() => {
      play.mockRestore();
      pause.mockRestore();
      load.mockRestore();
    });
  };

  it('when mpv is missing, falls back to the built-in player and points to the mpv path in Settings (L3-desktop-6)', async () => {
    attachError = Object.assign(new Error('mpv not found'), { code: 'not_found' });
    stubMedia();
    const { useToastStore } = await import('@/ui/Toast');
    useToastStore.setState({ toasts: [] });
    render(
      <MemoryRouter initialEntries={['/live']}>
        <Routes>
          <Route path="/settings/players" element={<p>players settings</p>} />
          <Route path="*" element={surfaceTree} />
        </Routes>
      </MemoryRouter>,
    );
    await tick();
    expect(usePlayerStore.getState().mode).toBe('inline');
    const last = useToastStore.getState().toasts.at(-1);
    expect(last).toMatchObject({ id: MPV_FALLBACK_TOAST, variant: 'info', title: "MPV wasn't found. Set its path under External players." });
    expect(last?.action?.label).toBe('Settings: External players');
    act(() => last?.action?.onClick());
    expect(await screen.findByText('players settings')).toBeTruthy();
  });

  it('any other start failure offers Try MPV again, which tries it on the next play', async () => {
    attachError = Object.assign(new Error('mpv exited during startup'), { code: 'internal' });
    stubMedia();
    const { useToastStore } = await import('@/ui/Toast');
    useToastStore.setState({ toasts: [] });
    render(surfaceTree);
    await tick();
    expect(usePlayerStore.getState().mode).toBe('inline');
    const last = useToastStore.getState().toasts.at(-1);
    expect(last).toMatchObject({ id: MPV_FALLBACK_TOAST, variant: 'error', title: 'Embedded MPV failed to start' });
    expect(last?.action?.label).toBe('Try MPV again');
    attachError = null;
    act(() => last?.action?.onClick());
    await tick();
    expect(usePlayerStore.getState().mode).toBe('embedded-mpv');
    expect(calls('mpv.attach')).toHaveLength(2);
  });

  it('after mpv was not found, the next zaps play in the built-in player without trying mpv again or stacking notices (L3-desktop-6)', async () => {
    attachError = Object.assign(new Error('mpv.exe was not found'), { code: 'engine_missing' });
    stubMedia();
    const { useToastStore } = await import('@/ui/Toast');
    useToastStore.setState({ toasts: [] });
    render(surfaceTree);
    await tick();
    expect(usePlayerStore.getState().mode).toBe('inline');
    // Two zaps: the store derives embedded mpv from the settings again for each play.
    for (const n of [2, 3]) {
      act(() =>
        usePlayerStore.setState({
          source: { url: `http://h/live/${n}.ts`, kind: 'direct', title: `Channel ${n}`, isLive: true, isRadio: false },
          mode: 'embedded-mpv',
          status: 'loading',
        }),
      );
      await tick();
      expect(usePlayerStore.getState().mode).toBe('inline');
    }
    expect(calls('mpv.attach')).toHaveLength(1);
    expect(screen.queryByTestId('mpv-connecting')).toBeNull();
    expect(useToastStore.getState().toasts.filter((x) => x.id === MPV_FALLBACK_TOAST)).toHaveLength(1);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});

describe('wheel and context menu over the native video', () => {
  const attached = async (): Promise<void> => {
    render(surfaceTree);
    await tick(20);
  };
  const menu = (): HTMLElement | null => screen.queryByTestId('video-context-menu');
  const openMenu = (x = 200, y = 120): void => act(() => emitApp('mpv.contextmenu', { x, y }));

  it('the wheel steps the volume like the arrow keys, with the same readout', async () => {
    usePlayerStore.setState({ volume: 0.5, muted: false });
    await attached();
    act(() => emitApp('mpv.wheel', { delta: 1 }));
    expect(usePlayerStore.getState().volume).toBeCloseTo(0.55);
    expect(useMediaStore.getState().osd?.primary).toBe('Volume 55%');
    act(() => emitApp('mpv.wheel', { delta: -2 }));
    expect(usePlayerStore.getState().volume).toBeCloseTo(0.45);
    // A flung wheel is capped; junk is ignored.
    act(() => emitApp('mpv.wheel', { delta: -40 }));
    expect(usePlayerStore.getState().volume).toBeCloseTo(0.25);
    act(() => emitApp('mpv.wheel', { delta: Number.NaN }));
    expect(usePlayerStore.getState().volume).toBeCloseTo(0.25);
  });

  it('a right click opens the menu at the pointer and cuts it out of the video instead of shrinking it', async () => {
    await attached();
    rpcMock.mockClear();
    openMenu();
    const m = menu();
    expect(m).not.toBeNull();
    expect(m!.style.left).toBe('200px');
    expect(m!.style.top).toBe('120px');
    const items = Array.from(m!.querySelectorAll('[role="menuitem"]')).map((n) => n.textContent);
    // The same rows as the built-in player's menu (PL-NATIVE-CONTEXT-MENU): Speed for VOD, Picture.
    expect(items).toEqual([
      'Pause',
      'Fullscreen',
      'Picture in picture',
      'SubtitlesOff',
      'Playback speedNormal',
      'Sync',
      'Picture',
      'Sleep timerOff',
      'Take screenshotS',
      'Copy stream link',
    ]);
    await tick(30);
    const last = calls('mpv.setBounds').at(-1)?.[1] as { bounds: Bounds; holes: Bounds[] } | undefined;
    expect(last?.holes.length).toBeGreaterThan(0);
  });

  it('portals the menu to the body so strips below the player never paint over it (L2-desktop-6)', async () => {
    await attached();
    openMenu(200, 380);
    const m = menu()!;
    expect(m.parentElement).toBe(document.body);
    expect(m.closest('[data-player-host]')).toBeNull();
    // It stays a player popover: a hole in the video, not chrome that shrinks it.
    expect(m.hasAttribute('data-mpv-overlay')).toBe(true);
  });

  it('sets the sleep timer from the menu like the options menu does (C5)', async () => {
    const { useSleepTimer, __resetSleepTimerForTests } = await import('../sleepTimer');
    onTestFinished(() => __resetSleepTimerForTests());
    await attached();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /^Sleep timer/ }));
    const choices = Array.from(menu()!.querySelectorAll('[role="menuitemradio"]')).map((n) => n.textContent ?? '');
    expect(choices[0]).toBe('Off');
    expect(choices.slice(1, 6).map((c) => c.split(/\d+:\d\d/)[0])).toEqual(['15 min', '30 min', '45 min', '60 min', '90 min']);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^45 min/ }));
    expect(useSleepTimer.getState().target).toEqual({ kind: 'minutes', minutes: 45 });
    expect(menu()).toBeNull();
  });

  it('a click on the video while the menu is open only closes it', async () => {
    await attached();
    openMenu();
    const toggle = vi.spyOn(usePlayerStore.getState(), 'togglePlay');
    const fullscreen = usePlayerStore.getState().isFullscreen;
    act(() => {
      for (const l of clickListeners) l();
      for (const l of doubleListeners) l();
    });
    expect(menu()).toBeNull();
    expect(toggle).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isFullscreen).toBe(fullscreen);
    toggle.mockRestore();
  });

  it('Escape, a pick, or a new item closes the menu', async () => {
    await attached();
    openMenu();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(menu()).toBeNull();

    openMenu();
    const toggle = vi.spyOn(usePlayerStore.getState(), 'togglePlay');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pause' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    toggle.mockRestore();

    openMenu();
    act(() => usePlayerStore.setState({ source: { url: 'http://h/movie/2.mkv', kind: 'direct', title: 'Other', isLive: false, isRadio: false } }));
    expect(menu()).toBeNull();
  });

  it('picks audio and subtitle tracks from submenus', async () => {
    await attached();
    act(() =>
      emitState({
        ...mpvState,
        loaded: true,
        tracks: [
          { id: 1, type: 'audio', lang: 'en', selected: true },
          { id: 2, type: 'audio', lang: 'fr', selected: false },
          { id: 5, type: 'sub', title: 'English', selected: false },
        ],
      } as MpvState),
    );
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Audio track/ }));
    fireEvent.click(screen.getAllByRole('menuitemradio')[1]!);
    expect(calls('mpv.setProperty').map((c) => c[1])).toContainEqual({ name: 'aid', value: 2 });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Subtitles/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'English' }));
    expect(calls('mpv.setProperty').map((c) => c[1])).toContainEqual({ name: 'sid', value: 5 });
  });

  it('keeps the tracks object while mpv state events repeat the same tracks (PB-4)', async () => {
    await attached();
    const st = {
      ...mpvState,
      loaded: true,
      tracks: [
        { id: 1, type: 'audio', lang: 'en', selected: true },
        { id: 2, type: 'audio', lang: 'fr', selected: false },
      ],
    } as MpvState;
    act(() => emitState(st));
    const first = useMediaStore.getState().tracks;
    expect(first.audio.map((a) => a.selected)).toEqual([true, false]);
    act(() => emitState({ ...st, timePos: 5, tracks: st.tracks.map((x) => ({ ...x })) }));
    expect(useMediaStore.getState().tracks).toBe(first);
    act(() => emitState({ ...st, tracks: st.tracks.map((x) => ({ ...x, selected: x.id === 2 })) }));
    expect(useMediaStore.getState().tracks).not.toBe(first);
    expect(useMediaStore.getState().tracks.audio.map((a) => a.selected)).toEqual([false, true]);
  });

  it('showCaptions turns the first subtitle track on once per item, unless mpv picked one', async () => {
    setSettingsCache({ showCaptions: true } as Settings);
    await attached();
    const sids = (): unknown[] => calls('mpv.setProperty').map((c) => c[1]).filter((a) => (a as { name: string }).name === 'sid');
    const tracks: MpvState['tracks'] = [
      { id: 1, type: 'audio', lang: 'en', selected: true },
      { id: 4, type: 'sub', title: 'English', selected: false },
      { id: 5, type: 'sub', title: 'French', selected: false },
    ];
    act(() => emitState({ ...mpvState, loaded: true, tracks }));
    expect(sids()).toEqual([{ name: 'sid', value: 4 }]);
    // Turned off later from the menu: the next state update leaves it off.
    act(() => emitState({ ...mpvState, loaded: true, tracks, timePos: 3 }));
    expect(sids()).toHaveLength(1);

    // A track mpv chose itself stays.
    act(() => usePlayerStore.setState({ source: { url: 'http://h/movie/2.mkv', kind: 'direct', title: 'Other', isLive: false, isRadio: false } }));
    await tick(20);
    act(() => emitState({ ...mpvState, loaded: true, tracks: tracks.map((x) => (x.id === 5 ? { ...x, selected: true } : x)) }));
    expect(sids()).toHaveLength(1);
  });

  it('without showCaptions no subtitle track is turned on', async () => {
    setSettingsCache({ showCaptions: false } as Settings);
    await attached();
    act(() => emitState({ ...mpvState, loaded: true, tracks: [{ id: 4, type: 'sub', title: 'English', selected: false }] }));
    expect(calls('mpv.setProperty').filter((c) => (c[1] as { name: string }).name === 'sid')).toEqual([]);
  });

  it('never offers to copy a link that carries a login', async () => {
    await attached();
    for (const url of [
      'http://xt.example.com:8080/movie/alice/s3cr3t/99.mkv',
      'http://portal.example.com/play/live.php?mac=00:1A:79:00:00:01&stream=5&play_token=abc',
      'https://bob:pw@cdn.example.com/a.m3u8',
      'http://h/hls/a.m3u8?token=x',
    ]) {
      act(() => usePlayerStore.setState({ source: { url, kind: 'hls', title: 'X', isLive: true, isRadio: false } }));
      openMenu();
      expect(screen.queryByRole('menuitem', { name: 'Copy stream link' })).toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });
    }
    // An Xtream item never shows it either, whatever its URL looks like.
    act(() =>
      usePlayerStore.setState({
        source: { url: 'http://cdn.example.com/a.m3u8', kind: 'hls', title: 'X', isLive: true, isRadio: false, ref: { sourceId: 'unknown', contentType: 'live', itemId: '1' } },
      }),
    );
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Copy stream link' })).toBeNull();
  });

  it('PiP asks mpv for the video shape', async () => {
    const pip = await import('../pip');
    const enter = vi.spyOn(await import('@/api/window'), 'enterPipWindow');
    videoParams = { dw: 1440, dh: 1080 };
    await attached();
    await act(async () => {
      await pip.enterPip();
    });
    expect(enter).toHaveBeenLastCalledWith(4 / 3);
    await act(async () => {
      await pip.exitPip();
    });
    videoParams = { dw: 1920, dh: 1080 };
  });

  it('a zap in PiP to a video of another shape reshapes the window once its first frame is up', async () => {
    const pip = await import('../pip');
    const reshape = vi.spyOn(await import('@/api/window'), 'setPipWindowAspect');
    await attached();
    act(() => emitState({ ...mpvState, loaded: true, timePos: 1 }));
    await act(async () => {
      await pip.enterPip(); // 16:9
    });

    videoParams = { dw: 1440, dh: 1080 };
    act(() =>
      usePlayerStore.setState({
        source: { url: 'http://h/live/2.ts', kind: 'direct', title: 'Old channel', isLive: true, isRadio: false },
        status: 'loading',
      }),
    );
    await tick();
    act(() => emitState({ ...mpvState, loaded: true, timePos: 0 }));
    await tick();
    expect(reshape).not.toHaveBeenCalled();
    await act(async () => {
      emitState({ ...mpvState, loaded: true, timePos: 0.5 });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(reshape).toHaveBeenCalledTimes(1);
    expect(reshape).toHaveBeenLastCalledWith(4 / 3);
    // Later state updates for the same item do not ask again.
    await act(async () => {
      emitState({ ...mpvState, loaded: true, timePos: 2 });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(reshape).toHaveBeenCalledTimes(1);
    await act(async () => {
      await pip.exitPip();
    });
    videoParams = { dw: 1920, dh: 1080 };
  });
});
