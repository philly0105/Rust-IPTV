import { afterEach, describe, expect, it, vi } from 'vitest';

const enterPipWindow = vi.fn(async () => true);
const exitPipWindow = vi.fn(async () => undefined);
const recoverPipWindow = vi.fn(async () => false);
vi.mock('@/api/window', () => ({ enterPipWindow, exitPipWindow, recoverPipWindow }));
vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: true,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const { usePipStore, enterPip, exitPip, togglePip, __resetPipForTests } = await import('./pip');
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
