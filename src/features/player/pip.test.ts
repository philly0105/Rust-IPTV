import { afterEach, describe, expect, it, vi } from 'vitest';

const enterPipWindow = vi.fn(async () => true);
const exitPipWindow = vi.fn(async () => undefined);
vi.mock('@/api/window', () => ({ enterPipWindow, exitPipWindow }));
vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: true,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const { usePipStore, enterPip, exitPip, togglePip } = await import('./pip');
const { usePlayerStore, __resetPlayerForTests } = await import('./store');

afterEach(() => {
  usePipStore.setState({ active: false });
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
    usePlayerStore.setState({
      source: { url: 'http://v/movie.mp4', kind: 'direct', title: 'Movie', isLive: false, isRadio: false },
      isFullscreen: true,
    });
    await enterPip();
    expect(usePlayerStore.getState().isFullscreen).toBe(false);
    expect(usePipStore.getState().active).toBe(true);
  });

  it('stays off when the window cannot change, and exit is a no-op when off', async () => {
    enterPipWindow.mockResolvedValueOnce(false);
    await enterPip();
    expect(usePipStore.getState().active).toBe(false);
    await exitPip();
    expect(exitPipWindow).not.toHaveBeenCalled();
  });
});
