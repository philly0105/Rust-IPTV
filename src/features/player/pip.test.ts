import { afterEach, describe, expect, it, vi } from 'vitest';

const enterPipWindow = vi.fn(async (_aspect?: number) => true);
const exitPipWindow = vi.fn(async () => undefined);
const recoverPipWindow = vi.fn(async () => false);
const setPipWindowAspect = vi.fn(async (_aspect: number) => true);
vi.mock('@/api/window', () => ({
  enterPipWindow,
  exitPipWindow,
  recoverPipWindow,
  setPipWindowAspect,
  PIP_DEFAULT_ASPECT: 16 / 9,
  QUIT_FLUSH_EVENT: 'tsrust:flush',
}));
vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: true,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const { usePipStore, enterPip, exitPip, togglePip, __resetPipForTests, setPipAspectSource, aspectFromVideoParams, refreshPipAspect } =
  await import('./pip');
const { usePlayerStore, __resetPlayerForTests } = await import('./store');
const { shortcutRegistry } = await import('@/shell/shortcuts');

const movie = { url: 'http://v/movie.mp4', kind: 'direct', title: 'Movie', isLive: false, isRadio: false } as const;

function pressEscape(): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
}

afterEach(() => {
  __resetPipForTests();
  __resetPlayerForTests();
  vi.clearAllMocks();
});

describe('window picture-in-picture', () => {
  it('toggles the small window on and off', async () => {
    await togglePip();
    expect(enterPipWindow).toHaveBeenCalledTimes(1);
    expect(usePipStore.getState().active).toBe(true);
    await togglePip();
    expect(exitPipWindow).toHaveBeenCalledTimes(1);
    expect(usePipStore.getState().active).toBe(false);
  });

  it('leaves fullscreen first', async () => {
    usePlayerStore.setState({ source: movie, isFullscreen: true });
    await enterPip();
    expect(usePlayerStore.getState().isFullscreen).toBe(false);
    expect(usePipStore.getState().active).toBe(true);
  });

  it('goes back to fullscreen on exit when PiP started from fullscreen', async () => {
    usePlayerStore.setState({ source: movie, isFullscreen: true });
    await enterPip();
    await exitPip();
    expect(usePlayerStore.getState().isFullscreen).toBe(true);
  });

  it('stays windowed on exit when playback stopped (PiP close button)', async () => {
    usePlayerStore.setState({ source: movie, isFullscreen: true });
    await enterPip();
    usePlayerStore.setState({ source: undefined });
    await exitPip();
    expect(usePlayerStore.getState().isFullscreen).toBe(false);
  });

  it('goes back to fullscreen when PiP could not start from fullscreen', async () => {
    usePlayerStore.setState({ source: movie, isFullscreen: true });
    enterPipWindow.mockResolvedValueOnce(false);
    await enterPip();
    expect(usePipStore.getState().active).toBe(false);
    expect(usePlayerStore.getState().isFullscreen).toBe(true);
    // wasFullscreen was cleared: a later normal PiP round trip stays windowed.
    usePlayerStore.setState({ isFullscreen: false });
    await enterPip();
    await exitPip();
    expect(usePlayerStore.getState().isFullscreen).toBe(false);
  });

  it('stays off when the window cannot change, and exit is a no-op when off', async () => {
    enterPipWindow.mockResolvedValueOnce(false);
    await enterPip();
    expect(usePipStore.getState().active).toBe(false);
    await exitPip();
    expect(exitPipWindow).not.toHaveBeenCalled();
  });

  it('a double press while the window is changing ends where it started', async () => {
    let finishEnter!: (ok: boolean) => void;
    enterPipWindow.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finishEnter = resolve)));
    const first = togglePip();
    const second = togglePip();
    await Promise.resolve();
    finishEnter(true);
    await Promise.all([first, second]);
    expect(enterPipWindow).toHaveBeenCalledTimes(1);
    expect(exitPipWindow).toHaveBeenCalledTimes(1);
    expect(usePipStore.getState().active).toBe(false);
  });

  it('an exit pressed while entering is not lost', async () => {
    let finishEnter!: (ok: boolean) => void;
    enterPipWindow.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finishEnter = resolve)));
    const entering = enterPip();
    const exiting = exitPip();
    await Promise.resolve();
    finishEnter(true);
    await Promise.all([entering, exiting]);
    expect(usePipStore.getState().active).toBe(false);
    expect(exitPipWindow).toHaveBeenCalledTimes(1);
  });

  it('repeated enters change the window once', async () => {
    await Promise.all([enterPip(), enterPip(), enterPip()]);
    await enterPip();
    expect(enterPipWindow).toHaveBeenCalledTimes(1);
    expect(usePipStore.getState().active).toBe(true);
  });

  it('a request after the queue drained starts a new change', async () => {
    await enterPip();
    await exitPip();
    await enterPip();
    expect(enterPipWindow).toHaveBeenCalledTimes(2);
    expect(usePipStore.getState().active).toBe(true);
  });

  it('Escape leaves PiP, and is released afterwards', async () => {
    await enterPip();
    expect(shortcutRegistry.list().some((s) => s.combo === 'escape' && s.area === 'Playback')).toBe(true);
    const e = pressEscape();
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(usePipStore.getState().active).toBe(false));
    expect(exitPipWindow).toHaveBeenCalledTimes(1);
    expect(shortcutRegistry.list().some((s) => s.combo === 'escape' && s.area === 'Playback')).toBe(false);
  });

  it('Escape claimed by a menu inside PiP does not leave PiP', async () => {
    await enterPip();
    const menu = document.createElement('div');
    document.body.append(menu);
    menu.addEventListener('keydown', (ev) => ev.preventDefault());
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(usePipStore.getState().active).toBe(true);
    menu.remove();
  });
});

describe('PiP in the video aspect', () => {
  it('reads the display aspect from mpv video-params, rotation included', () => {
    expect(aspectFromVideoParams({ w: 720, h: 576, dw: 1024, dh: 576 })).toBeCloseTo(16 / 9);
    expect(aspectFromVideoParams({ dw: 1440, dh: 1080, rotate: 0 })).toBeCloseTo(4 / 3);
    expect(aspectFromVideoParams({ dw: 1920, dh: 1080, rotate: 90 })).toBeCloseTo(9 / 16);
    expect(aspectFromVideoParams({ dw: 1920, dh: 1080, rotate: 180 })).toBeCloseTo(16 / 9);
    for (const bad of [null, undefined, 'x', {}, { dw: 0, dh: 1080 }, { dw: 1920, dh: 'a' }]) {
      expect(aspectFromVideoParams(bad)).toBeUndefined();
    }
    // Extreme shapes get the nearest usable PiP shape instead of 16:9.
    expect(aspectFromVideoParams({ dw: 10000, dh: 10 })).toBe(4);
    expect(aspectFromVideoParams({ dw: 10, dh: 10000 })).toBe(0.25);
  });

  it('passes the playing video aspect to the window, and nothing when it is unknown or fails', async () => {
    const unregister = setPipAspectSource(async () => 4 / 3);
    await enterPip();
    expect(enterPipWindow).toHaveBeenLastCalledWith(4 / 3);
    await exitPip();
    unregister();

    await enterPip();
    expect(enterPipWindow).toHaveBeenLastCalledWith(undefined);
    await exitPip();

    setPipAspectSource(() => Promise.reject(new Error('not attached')));
    await enterPip();
    expect(enterPipWindow).toHaveBeenLastCalledWith(undefined);
    expect(usePipStore.getState().active).toBe(true);
  });

  it('a stale surface unregistering leaves the newer one in place', async () => {
    const offOld = setPipAspectSource(async () => 4 / 3);
    setPipAspectSource(async () => 9 / 16);
    offOld();
    await enterPip();
    expect(enterPipWindow).toHaveBeenLastCalledWith(9 / 16);
  });

  it('a zap in PiP to a video of another shape re-locks the window once', async () => {
    setPipWindowAspect.mockClear();
    let aspect: number | undefined = 16 / 9;
    setPipAspectSource(async () => aspect);
    // Outside PiP nothing happens.
    await refreshPipAspect();
    expect(setPipWindowAspect).not.toHaveBeenCalled();

    await enterPip();
    await refreshPipAspect(); // same shape as on entry
    expect(setPipWindowAspect).not.toHaveBeenCalled();

    aspect = 4 / 3;
    await refreshPipAspect();
    expect(setPipWindowAspect).toHaveBeenCalledTimes(1);
    expect(setPipWindowAspect).toHaveBeenLastCalledWith(4 / 3);
    await refreshPipAspect(); // already 4:3
    aspect = 1.3337; // within rounding
    await refreshPipAspect();
    aspect = undefined; // not known yet
    await refreshPipAspect();
    expect(setPipWindowAspect).toHaveBeenCalledTimes(1);

    // A failed reshape is retried by the next refresh.
    aspect = 9 / 16;
    setPipWindowAspect.mockResolvedValueOnce(false);
    await refreshPipAspect();
    await refreshPipAspect();
    expect(setPipWindowAspect).toHaveBeenCalledTimes(3);

    await exitPip();
    aspect = 16 / 9;
    await refreshPipAspect();
    expect(setPipWindowAspect).toHaveBeenCalledTimes(3);
  });

  it('an unknown aspect on entry counts as 16:9', async () => {
    setPipWindowAspect.mockClear();
    let aspect: number | undefined;
    setPipAspectSource(async () => aspect);
    await enterPip();
    aspect = 16 / 9;
    await refreshPipAspect();
    expect(setPipWindowAspect).not.toHaveBeenCalled();
    aspect = 4 / 3;
    await refreshPipAspect();
    expect(setPipWindowAspect).toHaveBeenLastCalledWith(4 / 3);
  });
});
