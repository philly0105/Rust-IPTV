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
    pipAspect: true,
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
    if (cmd === 'pip_aspect') return state.pipAspect;
    return null;
  });
  return { state, calls, win, invoke, monitor };
});

vi.mock('./transport', () => ({ isDesktop: true }));
const appEvents = vi.hoisted(() => new Map<string, Set<(payload: unknown) => void>>());
vi.mock('./events', () => ({
  onAppEvent: (type: string, handler: (payload: unknown) => void) => {
    const set = appEvents.get(type) ?? new Set();
    appEvents.set(type, set);
    set.add(handler);
    return () => set.delete(handler);
  },
}));
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

const { i18n, applyLanguage } = await import('@/i18n');
const {
  enterPipWindow,
  exitPipWindow,
  recoverPipWindow,
  placeOnScreen,
  fitsOnScreen,
  setWindowFullscreen,
  bindWindowFullscreen,
  bindTrayLabels,
  sizeForAspect,
  setPipWindowAspect,
  flushBeforeQuit,
  QUIT_FLUSH_EVENT,
  QUIT_FLUSH_BUDGET_MS,
} = await import('./window');

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
    outer: { width: 1296, height: 839 },
    monitors: [fake.monitor(0, 0, 1920, 1080)],
    current: fake.monitor(0, 0, 1920, 1080),
    saved: null,
    pipAspect: true,
  });
  fake.calls.length = 0;
  localStorage.clear();
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
    // Position before size: a move across a DPI boundary rescales the window (WM_DPICHANGED).
    expect(order.indexOf('setPosition')).toBeLessThan(order.indexOf('setSize'));
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
    expect(order.indexOf('maximize')).toBeGreaterThan(order.indexOf('setSize'));
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
    // The whole outer window (inner 1280 plus a 16 px frame) lands on the remaining monitor.
    expect(last('setPosition')).toMatchObject({ x: 1920 - 1296, y: 100 });
    expect(last('setSize')).toMatchObject({ width: 1280, height: 800 });
  });

  it('fits the frame, not just the inner size, when shrinking onto a smaller monitor', async () => {
    fake.state.monitors = [fake.monitor(0, 0, 1920, 1080), fake.monitor(1920, 0, 3840, 2160)];
    fake.state.pos = { x: 2000, y: 0 };
    fake.state.inner = { width: 3000, height: 2000 };
    fake.state.outer = { width: 3016, height: 2039 };
    await enterPipWindow();
    fake.state.monitors = [fake.monitor(0, 0, 1920, 1080)];
    fake.calls.length = 0;
    await exitPipWindow();
    expect(last('setPosition')).toMatchObject({ x: 0, y: 0 });
    expect(last('setSize')).toMatchObject({ width: 1920 - 16, height: 1040 - 39 });
  });

  it('opens the next PiP where the last one was, when it still fits', async () => {
    await enterPipWindow();
    // The user dragged and resized the PiP window to the top-left.
    fake.state.pos = { x: 40, y: 30 };
    fake.state.inner = { width: 640, height: 360 };
    await exitPipWindow();
    fake.state.pos = { x: 100, y: 50 };
    fake.state.inner = { width: 1280, height: 800 };
    fake.calls.length = 0;
    await enterPipWindow();
    expect(last('setSize')).toMatchObject({ width: 640, height: 360 });
    expect(last('setPosition')).toMatchObject({ x: 40, y: 30 });
  });

  it('ignores a remembered PiP rect that is off screen, too small, or corrupt', async () => {
    const corner = { x: 1920 - 480 - 24, y: 1040 - 270 - 24 };
    for (const stored of [
      JSON.stringify({ x: 2500, y: 30, width: 640, height: 360 }),
      JSON.stringify({ x: 0, y: 0, width: 100, height: 50 }),
      JSON.stringify({ x: 'a', y: 0, width: 640, height: 360 }),
      '{not json',
    ]) {
      localStorage.setItem('tsrust.pipWindow', stored);
      fake.calls.length = 0;
      await enterPipWindow();
      expect(last('setPosition')).toMatchObject(corner);
      expect(last('setSize')).toMatchObject({ width: 480, height: 270 });
      await exitPipWindow();
      localStorage.clear();
    }
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

describe('PiP in the video aspect', () => {
  it('sizeForAspect keeps the area and falls back to 16:9 for unknown shapes, clamping extreme ones', () => {
    expect(sizeForAspect({ width: 480, height: 270 })).toEqual({ width: 480, height: 270 });
    expect(sizeForAspect({ width: 480, height: 270 }, 4 / 3)).toEqual({ width: 416, height: 312 });
    expect(sizeForAspect({ width: 480, height: 270 }, 9 / 16)).toEqual({ width: 270, height: 480 });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(sizeForAspect({ width: 480, height: 270 }, bad)).toEqual({ width: 480, height: 270 });
    }
    expect(sizeForAspect({ width: 480, height: 270 }, 40)).toEqual({ width: 720, height: 180 });
    expect(sizeForAspect({ width: 480, height: 270 }, 0.01)).toEqual({ width: 180, height: 720 });
  });

  it('opens a 4:3 video in a 4:3 corner window, minimum and native lock included', async () => {
    expect(await enterPipWindow(4 / 3)).toBe(true);
    expect(last('setSize')).toMatchObject({ width: 416, height: 312 });
    expect(last('setPosition')).toMatchObject({ x: 1920 - 416 - 24, y: 1040 - 312 - 24 });
    expect(last('setMinSize')).toMatchObject({ width: 208, height: 156 });
    expect(last('invoke:pip_window')).toMatchObject({ on: true, aspect: 4 / 3 });
    const order = fake.calls.map(([n]) => n);
    expect(order.lastIndexOf('setPosition')).toBeLessThan(order.lastIndexOf('setSize'));
  });

  it('reshapes the remembered PiP rect to the new video, keeping its place and area', async () => {
    localStorage.setItem('tsrust.pipWindow', JSON.stringify({ x: 40, y: 30, width: 640, height: 360 }));
    await enterPipWindow(9 / 16);
    expect(last('setSize')).toMatchObject({ width: 360, height: 640 });
    expect(last('setPosition')).toMatchObject({ x: 40, y: 30 });
  });

  it('sends no aspect when the video has none, and none on exit', async () => {
    await enterPipWindow(Number.NaN);
    expect(last('invoke:pip_window')).not.toHaveProperty('aspect');
    await exitPipWindow();
    expect(last('invoke:pip_window')).toEqual({ on: false, restore: null });
  });
});

describe('tray labels', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('sends the labels at startup and again on every language change', async () => {
    const unbind = bindTrayLabels();
    await vi.waitFor(() => expect(last('invoke:tray_labels')).toEqual({ show: 'Show Tsrust IPTV', quit: 'Quit', tooltip: 'Tsrust IPTV' }));
    i18n.addResourceBundle('xx', 'shell', { trayShow: 'Montrer Tsrust IPTV', trayQuit: 'Quitter', appName: 'Tsrust IPTV' }, true, true);
    await i18n.changeLanguage('xx');
    await vi.waitFor(() => expect(last('invoke:tray_labels')).toEqual({ show: 'Montrer Tsrust IPTV', quit: 'Quitter', tooltip: 'Tsrust IPTV' }));
    // A real locale uses its own keys; a blank translation falls back to English.
    await applyLanguage('fr');
    await vi.waitFor(() => expect(last('invoke:tray_labels')).toMatchObject({ show: 'Afficher Tsrust IPTV', quit: 'Quitter' }));
    i18n.addResourceBundle('xx', 'shell', { trayShow: '  ', trayQuit: '' }, true, true);
    await i18n.changeLanguage('xx');
    await vi.waitFor(() => expect(last('invoke:tray_labels')).toMatchObject({ show: 'Show Tsrust IPTV', quit: 'Quit' }));
    unbind();
    const sent = named('invoke:tray_labels').length;
    await i18n.changeLanguage('en');
    await new Promise((r) => setTimeout(r, 0));
    expect(named('invoke:tray_labels')).toHaveLength(sent);
  });

  it('a failed tray update is only logged', async () => {
    fake.invoke.mockImplementationOnce(async () => {
      throw new Error('no tray');
    });
    const unbind = bindTrayLabels();
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith('[window] tray_labels failed', expect.any(Error)));
    unbind();
  });
});

describe('fitsOnScreen', () => {
  it('needs the whole rect inside one work area', () => {
    const areas = [{ x: 0, y: 0, width: 1920, height: 1040 }];
    expect(fitsOnScreen({ x: 0, y: 0, width: 1920, height: 1040 }, areas)).toBe(true);
    expect(fitsOnScreen({ x: 1500, y: 0, width: 480, height: 270 }, areas)).toBe(false);
    expect(fitsOnScreen({ x: 0, y: 0, width: 10, height: 10 }, [])).toBe(false);
  });
});

describe('setWindowFullscreen', () => {
  it('ends in the state asked for last when calls overlap', async () => {
    let release!: () => void;
    const original = fake.win.setFullscreen;
    fake.win.setFullscreen = async (on: boolean) => {
      fake.calls.push(['setFullscreen', on]);
      await new Promise<void>((r) => (release = r));
      fake.state.fullscreen = on;
    };
    const entering = setWindowFullscreen(true);
    await vi.waitFor(() => expect(named('setFullscreen')).toEqual([true]));
    // Left fullscreen again before the window got there.
    const leaving = setWindowFullscreen(false);
    release();
    await vi.waitFor(() => expect(named('setFullscreen')).toEqual([true, false]));
    release();
    await Promise.all([entering, leaving]);
    expect(fake.state.fullscreen).toBe(false);
    fake.win.setFullscreen = original;
  });

  it('collapses a burst into the last wish', async () => {
    await Promise.all([setWindowFullscreen(true), setWindowFullscreen(false), setWindowFullscreen(true)]);
    expect(named('setFullscreen')).toEqual([true]);
    expect(fake.state.fullscreen).toBe(true);
    await setWindowFullscreen(true);
    expect(named('setFullscreen')).toEqual([true]);
  });

  it('a failed change does not block the next one', async () => {
    fake.state.failOn = 'setFullscreen';
    await setWindowFullscreen(true);
    fake.state.failOn = '';
    await setWindowFullscreen(true);
    expect(fake.state.fullscreen).toBe(true);
  });

  it('binding brings a window left fullscreen by a reload back out', async () => {
    fake.state.fullscreen = true;
    const unbind = bindWindowFullscreen();
    await vi.waitFor(() => expect(fake.state.fullscreen).toBe(false));
    unbind();
  });

  it('binding also puts the normal window back after a reload in PiP', async () => {
    fake.state.saved = { x: 40, y: 30, width: 1400, height: 900, maximized: false };
    const unbind = bindWindowFullscreen();
    await vi.waitFor(() => expect(last('setPosition')).toMatchObject({ x: 40, y: 30 }));
    expect(last('setDecorations')).toBe(true);
    unbind();
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

describe('PiP follows a new video shape', () => {
  it('re-locks in Rust first, then reshapes around the same center with the same area', async () => {
    fake.state.monitors = [fake.monitor(0, 0, 1920, 1080)];
    expect(await enterPipWindow()).toBe(true);
    // The fake window does not move by itself: put it where PiP opened, 480x270.
    Object.assign(fake.state, { pos: { x: 1000, y: 500 }, inner: { width: 480, height: 270 } });
    fake.calls.length = 0;
    expect(await setPipWindowAspect(4 / 3)).toBe(true);
    const order = fake.calls.map(([n]) => n);
    expect(order[0]).toBe('invoke:pip_aspect');
    expect(last('invoke:pip_aspect')).toEqual({ aspect: 4 / 3 });
    expect(last('setMinSize')).toMatchObject({ width: 208, height: 156 });
    expect(last('setSize')).toMatchObject({ width: 416, height: 312 });
    expect(last('setPosition')).toMatchObject({ x: 1000 + 32, y: 500 - 21 });
    expect(order.indexOf('setMinSize')).toBeGreaterThan(order.indexOf('invoke:pip_aspect'));
    expect(order.indexOf('setPosition')).toBeLessThan(order.indexOf('setSize'));
  });

  it('stays inside the work area near an edge, and clamps an extreme aspect', async () => {
    expect(await enterPipWindow()).toBe(true);
    Object.assign(fake.state, { pos: { x: 1440, y: 770 }, inner: { width: 480, height: 270 } });
    expect(await setPipWindowAspect(9 / 16)).toBe(true);
    expect(last('setSize')).toMatchObject({ width: 270, height: 480 });
    expect(last('setPosition')).toMatchObject({ x: 1545, y: 1040 - 480 });
    await setPipWindowAspect(40);
    expect(last('invoke:pip_aspect')).toEqual({ aspect: 4 });
  });

  it('does nothing outside PiP, or when Rust refuses', async () => {
    expect(await setPipWindowAspect(4 / 3)).toBe(false);
    expect(named('invoke:pip_aspect')).toHaveLength(0);
    expect(await enterPipWindow()).toBe(true);
    fake.calls.length = 0;
    fake.state.pipAspect = false;
    expect(await setPipWindowAspect(4 / 3)).toBe(false);
    expect(named('setSize')).toHaveLength(0);
    expect(await setPipWindowAspect(Number.NaN)).toBe(false);
  });
});

describe('save before tray Quit', () => {
  it('app.flush runs the savers, waits for them, then acks with flush_done', async () => {
    const unbind = bindWindowFullscreen();
    let release!: () => void;
    const saved = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saver = (e: Event): void => (e as CustomEvent<{ waitUntil(p: Promise<unknown>): void }>).detail.waitUntil(saved);
    window.addEventListener(QUIT_FLUSH_EVENT, saver);
    fake.calls.length = 0;
    for (const h of appEvents.get('app.flush') ?? []) h({});
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(named('invoke:flush_done')).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(named('invoke:flush_done')).toHaveLength(1));
    window.removeEventListener(QUIT_FLUSH_EVENT, saver);
    unbind();
    expect(appEvents.get('app.flush')?.size ?? 0).toBe(0);
  });

  it('gives a slow save (a large source removal, about 0.8 s in debug) time, and acks at once with nothing pending', async () => {
    expect(QUIT_FLUSH_BUDGET_MS).toBeGreaterThanOrEqual(2000);
    vi.useFakeTimers();
    fake.calls.length = 0;
    await flushBeforeQuit();
    expect(named('invoke:flush_done')).toHaveLength(1);

    const slow = (e: Event): void =>
      (e as CustomEvent<{ waitUntil(p: Promise<unknown>): void }>).detail.waitUntil(new Promise((r) => setTimeout(r, 1200)));
    window.addEventListener(QUIT_FLUSH_EVENT, slow);
    fake.calls.length = 0;
    let finished = false;
    const done = flushBeforeQuit().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(1199);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(named('invoke:flush_done')).toHaveLength(1);
    window.removeEventListener(QUIT_FLUSH_EVENT, slow);
    vi.useRealTimers();
  });

  it('a saver that never finishes only holds the ack for the budget', async () => {
    vi.useFakeTimers();
    const saver = (e: Event): void =>
      (e as CustomEvent<{ waitUntil(p: Promise<unknown>): void }>).detail.waitUntil(new Promise(() => undefined));
    window.addEventListener(QUIT_FLUSH_EVENT, saver);
    fake.calls.length = 0;
    const done = flushBeforeQuit();
    await vi.advanceTimersByTimeAsync(QUIT_FLUSH_BUDGET_MS - 1);
    expect(named('invoke:flush_done')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(named('invoke:flush_done')).toHaveLength(1);
    window.removeEventListener(QUIT_FLUSH_EVENT, saver);
    vi.useRealTimers();
  });
});
