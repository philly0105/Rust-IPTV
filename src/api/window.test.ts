import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A fake Tauri window that records every call in order. */
const fake = vi.hoisted(() => {
  type Area = { position: { x: number; y: number }; size: { width: number; height: number } };
  const monitor = (x: number, y: number, width: number, height: number, scaleFactor = 1) => ({
    scaleFactor,
    workArea: { position: { x, y }, size: { width, height: height - 40 } } as Area,
  });
  const state = {
    fullscreen: false,
    maximized: false,
    pos: { x: 100, y: 50 },
    inner: { width: 1280, height: 800 },
    outer: { width: 1296, height: 839 },
    monitors: [monitor(0, 0, 1920, 1080)],
    current: monitor(0, 0, 1920, 1080) as ReturnType<typeof monitor> | null,
    failOn: '' as string,
    saved: null as unknown,
  };
  const calls: [string, unknown?][] = [];
  const rec = (name: string) =>
    async (arg?: unknown) => {
      calls.push([name, arg]);
      if (state.failOn === name) throw new Error(`${name} broke`);
    };
  const win = {
    isFullscreen: async () => state.fullscreen,
    isMaximized: async () => state.maximized,
    outerPosition: async () => ({ ...state.pos }),
    innerSize: async () => ({ ...state.inner }),
    outerSize: async () => ({ ...state.outer }),
    scaleFactor: async () => 1,
    setFullscreen: async (on: boolean) => {
      await rec('setFullscreen')(on);
      state.fullscreen = on;
    },
    unmaximize: async () => {
      await rec('unmaximize')();
      state.maximized = false;
    },
    maximize: rec('maximize'),
    setMinSize: rec('setMinSize'),
    setDecorations: rec('setDecorations'),
    setAlwaysOnTop: rec('setAlwaysOnTop'),
    setSize: rec('setSize'),
    setPosition: rec('setPosition'),
  };
  const invoke = vi.fn(async (cmd: string, args?: unknown) => {
    calls.push([`invoke:${cmd}`, args]);
    if (cmd === 'pip_window_saved') return state.saved;
    return null;
  });
  return { state, calls, win, invoke, monitor };
});

vi.mock('./transport', () => ({ isDesktop: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fake.invoke }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => fake.win,
  currentMonitor: async () => fake.state.current,
  availableMonitors: async () => fake.state.monitors,
  LogicalSize: class {
    constructor(public width: number, public height: number) {}
  },
  PhysicalSize: class {
    constructor(public width: number, public height: number) {}
  },
  PhysicalPosition: class {
    constructor(public x: number, public y: number) {}
  },
}));

const { enterPipWindow, exitPipWindow, recoverPipWindow, placeOnScreen } = await import('./window');

const named = (name: string) => fake.calls.filter(([n]) => n === name).map(([, a]) => a);
const last = (name: string) => named(name).at(-1);

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  fake.state.failOn = '';
  await exitPipWindow(); // forget any saved geometry
  Object.assign(fake.state, {
    fullscreen: false,
    maximized: false,
    pos: { x: 100, y: 50 },
    inner: { width: 1280, height: 800 },
    monitors: [fake.monitor(0, 0, 1920, 1080)],
    current: fake.monitor(0, 0, 1920, 1080),
    saved: null,
  });
  fake.calls.length = 0;
  vi.restoreAllMocks();
});

describe('placeOnScreen', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1040 };
  const right = { x: 1920, y: 0, width: 2560, height: 1400 };

  it('keeps a window whose title bar is reachable', () => {
    const r = { x: 100, y: 50, width: 1280, height: 800 };
    expect(placeOnScreen(r, [screen])).toEqual(r);
    // Mostly off the right edge, but the title bar still shows 200 px: leave it.
    expect(placeOnScreen({ x: 1720, y: 50, width: 1280, height: 800 }, [screen])).toEqual({ x: 1720, y: 50, width: 1280, height: 800 });
  });

  it('pulls a window back from a monitor that is gone', () => {
    const onUnplugged = { x: 2100, y: 200, width: 1280, height: 800 };
    expect(placeOnScreen(onUnplugged, [screen], screen)).toEqual({ x: 640, y: 200, width: 1280, height: 800 });
  });

  it('moves a window whose title bar is above the screen down into it', () => {
    expect(placeOnScreen({ x: 100, y: -500, width: 1280, height: 800 }, [screen])).toEqual({ x: 100, y: 0, width: 1280, height: 800 });
  });

  it('shrinks a window larger than the work area it lands on', () => {
    expect(placeOnScreen({ x: 3000, y: 3000, width: 2560, height: 1400 }, [screen], screen)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });

  it('prefers the monitor the window overlaps most', () => {
    // Title bar hidden above both screens, body mostly on the right one.
    const r = { x: 1800, y: -100, width: 1280, height: 800 };
    expect(placeOnScreen(r, [screen, right])).toEqual({ x: 1920, y: 0, width: 1280, height: 800 });
  });

  it('leaves the rect alone when no monitor is known', () => {
    const r = { x: -9999, y: -9999, width: 10, height: 10 };
    expect(placeOnScreen(r, [])).toBe(r);
  });
});

describe('enterPipWindow / exitPipWindow', () => {
  it('shrinks to a borderless always-on-top corner window and hands the normal geometry to Rust', async () => {
    expect(await enterPipWindow()).toBe(true);
    expect(last('setDecorations')).toBe(false);
    expect(last('setAlwaysOnTop')).toBe(true);
    expect(last('setSize')).toMatchObject({ width: 480, height: 270 });
    expect(last('setPosition')).toMatchObject({ x: 1920 - 480 - 24, y: 1040 - 270 - 24 });
    // The inner size, not the outer one: setSize sets the inner size.
    expect(last('invoke:pip_window')).toEqual({
      on: true,
      restore: { x: 100, y: 50, width: 1280, height: 800, maximized: false },
    });
  });

  it('restores the exact normal window on exit, so round trips do not grow it', async () => {
    await enterPipWindow();
    fake.calls.length = 0;
    await exitPipWindow();
    const order = fake.calls.map(([n]) => n);
    // The aspect lock goes first, so it cannot fight the window growing back.
    expect(order[0]).toBe('invoke:pip_window');
    expect(last('invoke:pip_window')).toEqual({ on: false, restore: null });
    expect(last('setAlwaysOnTop')).toBe(false);
    expect(last('setDecorations')).toBe(true);
    expect(last('setMinSize')).toMatchObject({ width: 800, height: 600 });
    expect(last('setSize')).toMatchObject({ width: 1280, height: 800 });
    expect(last('setPosition')).toMatchObject({ x: 100, y: 50 });
    expect(named('maximize')).toHaveLength(0);
    expect(order.indexOf('setDecorations')).toBeLessThan(order.indexOf('setSize'));
  });

  it('saves the normal rect under a maximized window and maximizes again on exit', async () => {
    fake.state.maximized = true;
    const restored = { x: 300, y: 120 };
    const original = fake.win.unmaximize;
    fake.win.unmaximize = async () => {
      fake.state.maximized = false;
      fake.state.pos = restored;
      fake.state.inner = { width: 1100, height: 700 };
    };
    await enterPipWindow();
    expect(last('invoke:pip_window')).toEqual({ on: true, restore: { x: 300, y: 120, width: 1100, height: 700, maximized: true } });
    fake.calls.length = 0;
    await exitPipWindow();
    expect(last('setSize')).toMatchObject({ width: 1100, height: 700 });
    expect(last('setPosition')).toMatchObject({ x: 300, y: 120 });
    const order = fake.calls.map(([n]) => n);
    expect(order.indexOf('maximize')).toBeGreaterThan(order.indexOf('setPosition'));
    fake.win.unmaximize = original;
  });

  it('leaves OS fullscreen before saving the geometry', async () => {
    fake.state.fullscreen = true;
    await enterPipWindow();
    expect(named('setFullscreen')).toEqual([false]);
  });

  it('brings the window back on screen when its monitor is gone', async () => {
    fake.state.monitors = [fake.monitor(0, 0, 1920, 1080), fake.monitor(1920, 0, 1920, 1080)];
    fake.state.pos = { x: 2200, y: 100 };
    await enterPipWindow();
    fake.state.monitors = [fake.monitor(0, 0, 1920, 1080)];
    fake.state.current = fake.monitor(0, 0, 1920, 1080);
    fake.calls.length = 0;
    await exitPipWindow();
    expect(last('setPosition')).toMatchObject({ x: 1920 - 1280, y: 100 });
    expect(last('setSize')).toMatchObject({ width: 1280, height: 800 });
  });

  it('rolls back when a step fails halfway', async () => {
    fake.state.failOn = 'setAlwaysOnTop';
    expect(await enterPipWindow()).toBe(false);
    fake.state.failOn = '';
    expect(last('setDecorations')).toBe(true);
    expect(last('setMinSize')).toMatchObject({ width: 800, height: 600 });
    expect(last('setSize')).toMatchObject({ width: 1280, height: 800 });
    expect(last('setPosition')).toMatchObject({ x: 100, y: 50 });
    expect(last('invoke:pip_window')).toEqual({ on: false, restore: null });
    // Nothing is left to restore afterwards.
    fake.calls.length = 0;
    await exitPipWindow();
    expect(named('setSize')).toHaveLength(0);
  });

  it('rolls back when the Rust pip_window command fails, so quit-in-PiP stays safe', async () => {
    fake.invoke.mockImplementationOnce(async (cmd: string, args?: unknown) => {
      fake.calls.push([`invoke:${cmd}`, args]);
      throw new Error('no such command');
    });
    expect(await enterPipWindow()).toBe(false);
    expect(last('invoke:pip_window')).toEqual({ on: false, restore: null });
    expect(last('setDecorations')).toBe(true);
    expect(last('setAlwaysOnTop')).toBe(false);
    expect(last('setSize')).toMatchObject({ width: 1280, height: 800 });
    expect(last('setPosition')).toMatchObject({ x: 100, y: 50 });
  });

  it('keeps restoring when one restore step fails', async () => {
    await enterPipWindow();
    fake.state.failOn = 'setDecorations';
    fake.calls.length = 0;
    await exitPipWindow();
    expect(last('setSize')).toMatchObject({ width: 1280, height: 800 });
    expect(last('setPosition')).toMatchObject({ x: 100, y: 50 });
  });

  it('a second enter while in PiP keeps the first saved geometry', async () => {
    await enterPipWindow();
    fake.state.pos = { x: 1416, y: 746 };
    fake.state.inner = { width: 480, height: 270 };
    await enterPipWindow();
    expect(last('invoke:pip_window')).toMatchObject({ restore: { width: 1280, height: 800 } });
    fake.calls.length = 0;
    await exitPipWindow();
    expect(last('setSize')).toMatchObject({ width: 1280, height: 800 });
  });

  it('exit when PiP is off only resets the frame', async () => {
    await exitPipWindow();
    expect(last('setDecorations')).toBe(true);
    expect(named('setSize')).toHaveLength(0);
  });
});

describe('recoverPipWindow', () => {
  it('puts the window back after a reload in PiP using the geometry Rust kept', async () => {
    fake.state.saved = { x: 40, y: 30, width: 1400, height: 900, maximized: false };
    expect(await recoverPipWindow()).toBe(true);
    expect(last('setDecorations')).toBe(true);
    expect(last('setSize')).toMatchObject({ width: 1400, height: 900 });
    expect(last('setPosition')).toMatchObject({ x: 40, y: 30 });
    expect(last('invoke:pip_window')).toEqual({ on: false, restore: null });
  });

  it('does nothing when the app was not in PiP', async () => {
    expect(await recoverPipWindow()).toBe(false);
    expect(named('setDecorations')).toHaveLength(0);
  });
});
