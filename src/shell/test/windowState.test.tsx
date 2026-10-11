import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { rpcMock } from './harness';

const win = vi.hoisted(() => {
  const listeners: (() => void)[] = [];
  return {
    listeners,
    state: { maximized: false, minimized: false, fullscreen: false, x: 40, y: 60, width: 1400, height: 900 },
    setSize: vi.fn(async () => {}),
    setPosition: vi.fn(async () => {}),
    maximize: vi.fn(async () => {}),
  };
});

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: true,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => win.state.maximized,
    isMinimized: async () => win.state.minimized,
    isFullscreen: async () => win.state.fullscreen,
    outerPosition: async () => ({ x: win.state.x, y: win.state.y }),
    innerSize: async () => ({ width: win.state.width, height: win.state.height }),
    setSize: win.setSize,
    setPosition: win.setPosition,
    maximize: win.maximize,
    onResized: async (cb: () => void) => {
      win.listeners.push(cb);
      return () => {};
    },
    onMoved: async (cb: () => void) => {
      win.listeners.push(cb);
      return () => {};
    },
  }),
}));

const { useWindowStatePersistence, WINDOW_SAVE_DEBOUNCE_MS } = await import('../effects');

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  cleanup();
  rpcMock.reset();
  win.listeners.length = 0;
  win.state = { maximized: false, minimized: false, fullscreen: false, x: 40, y: 60, width: 1400, height: 900 };
  vi.useRealTimers();
});

describe('desktop window state', () => {
  it('leaves the OS window restore to tauri-plugin-window-state', async () => {
    vi.useFakeTimers();
    rpcMock.handlers['window.getState'] = () => ({ x: 1, y: 2, width: 1000, height: 700, maximized: true });
    rpcMock.handlers['window.setState'] = () => undefined;
    renderHook(() => useWindowStatePersistence());
    await flush(WINDOW_SAVE_DEBOUNCE_MS + 10);
    expect(win.setSize).not.toHaveBeenCalled();
    expect(win.setPosition).not.toHaveBeenCalled();
    expect(win.maximize).not.toHaveBeenCalled();
  });

  it('mirrors geometry to window.setState, debounced', async () => {
    vi.useFakeTimers();
    rpcMock.handlers['window.getState'] = () => null;
    rpcMock.handlers['window.setState'] = () => undefined;
    renderHook(() => useWindowStatePersistence());
    await flush(WINDOW_SAVE_DEBOUNCE_MS + 10);
    rpcMock.calls.length = 0;

    win.state = { ...win.state, x: 100, y: 120, width: 1600, height: 1000 };
    for (const l of win.listeners) l();
    for (const l of win.listeners) l();
    await flush(WINDOW_SAVE_DEBOUNCE_MS + 10);
    const saves = rpcMock.calls.filter((c) => c.cmd === 'window.setState');
    expect(saves).toEqual([
      { cmd: 'window.setState', args: { state: { x: 100, y: 120, width: 1600, height: 1000, maximized: false } } },
    ]);
  });

  it('keeps the last normal geometry while maximized', async () => {
    vi.useFakeTimers();
    win.state = { ...win.state, maximized: true, width: 2560, height: 1400 };
    rpcMock.handlers['window.getState'] = () => ({ x: 5, y: 6, width: 1280, height: 800, maximized: false });
    rpcMock.handlers['window.setState'] = () => undefined;
    renderHook(() => useWindowStatePersistence());
    await flush(WINDOW_SAVE_DEBOUNCE_MS + 10);
    const save = rpcMock.calls.find((c) => c.cmd === 'window.setState');
    expect(save?.args).toEqual({ state: { x: 5, y: 6, width: 1280, height: 800, maximized: true } });
  });
});
