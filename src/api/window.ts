/**
 * Desktop window helpers. Element fullscreen inside WebView2 only fills the
 * webview, so on desktop the OS window follows `document.fullscreenElement`.
 * Every function is a no-op on the web build.
 */

import i18next from 'i18next';

import { onAppEvent } from './events';
import { isDesktop } from './transport';

/** The latest fullscreen state asked for while a change runs, or null when none is pending. */
let fullscreenWish: boolean | null = null;
let fullscreenRun: Promise<void> | null = null;

async function applyFullscreen(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    while (fullscreenWish !== null) {
      const want = fullscreenWish;
      fullscreenWish = null;
      try {
        if ((await win.isFullscreen()) !== want) await win.setFullscreen(want);
      } catch (err) {
        console.warn('[window] setFullscreen failed', err);
      }
    }
  } catch (err) {
    fullscreenWish = null;
    console.warn('[window] setFullscreen failed', err);
  } finally {
    // Same tick as the last check, so a later request always starts a new run.
    fullscreenRun = null;
  }
}

/**
 * Puts the desktop window in or out of OS fullscreen. No-op on the web. Calls are serialized
 * and the window ends in the state asked for last: a quick enter-then-leave can never leave
 * it stuck fullscreen behind a page that is not.
 */
export function setWindowFullscreen(on: boolean): Promise<void> {
  if (!isDesktop) return Promise.resolve();
  fullscreenWish = on;
  fullscreenRun ??= applyFullscreen();
  return fullscreenRun;
}

async function windowIsFullscreen(): Promise<boolean> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return await getCurrentWindow().isFullscreen();
  } catch {
    return false;
  }
}

/** The page was fullscreen at the last `fullscreenchange` (`bindWindowFullscreen`). */
let pageFullscreen = false;
/**
 * The window was already fullscreen when the page went fullscreen: it opened so
 * (`settings.windowStart`, Rust `reveal_main`). Leaving the page's fullscreen keeps the window's.
 */
let windowWasFullscreen = false;

/**
 * Leaves an OS fullscreen that no page fullscreen stands behind (the window opened fullscreen,
 * `settings.windowStart`), so F11 takes it out rather than entering one. True when it did;
 * false on the web, while the page is fullscreen, or when the window is not.
 */
export async function leaveBareWindowFullscreen(): Promise<boolean> {
  if (!isDesktop || typeof document === 'undefined' || document.fullscreenElement) return false;
  if (!(await windowIsFullscreen())) return false;
  windowWasFullscreen = false;
  await setWindowFullscreen(false);
  return true;
}

/**
 * Mirrors element fullscreen (player `requestFullscreen`) onto the desktop
 * window. Call once at startup; returns an unsubscribe function. It also repairs the window
 * after a webview reload right away, without waiting for the player code to load: a reload
 * while fullscreen gives a page that is not, and the window follows it out; a reload in PiP
 * puts the normal window back (`recoverPipWindow`). A window that opened fullscreen stays so
 * when the page leaves a fullscreen entered over it.
 */
export function bindWindowFullscreen(): () => void {
  if (!isDesktop || typeof document === 'undefined') return () => {};
  const sync = () => {
    const on = document.fullscreenElement != null;
    const entering = on && !pageFullscreen;
    pageFullscreen = on;
    if (!on) {
      const keep = windowWasFullscreen;
      windowWasFullscreen = false;
      if (!keep) void setWindowFullscreen(false);
      return;
    }
    // With no change in flight, a fullscreen window at entry is one the page did not make.
    if (entering && fullscreenRun === null) {
      void windowIsFullscreen().then((already) => {
        if (already && document.fullscreenElement != null) windowWasFullscreen = true;
        return setWindowFullscreen(true);
      });
      return;
    }
    void setWindowFullscreen(true);
  };
  document.addEventListener('fullscreenchange', sync);
  sync();
  void recoverPipWindow().catch(() => undefined);
  const unTray = bindTrayLabels();
  const unFlush = onAppEvent('app.flush', () => void flushBeforeQuit());
  return () => {
    document.removeEventListener('fullscreenchange', sync);
    unTray();
    unFlush();
  };
}

/**
 * DOM event raised on `window` before the app quits from the tray, where the webview gets no
 * `pagehide`. Listeners hand their save to `detail.waitUntil`.
 */
export const QUIT_FLUSH_EVENT = 'tsrust:flush';
export interface QuitFlushDetail {
  waitUntil(work: Promise<unknown>): void;
}
/**
 * How long the saves may take before Rust is told to go on (Rust itself waits 3 s at most).
 * Removing a large source takes about 0.8 s in a debug build. With nothing to save the ack goes
 * out at once.
 */
export const QUIT_FLUSH_BUDGET_MS = 2500;

/**
 * Answers Rust's `app.flush`: runs every `QUIT_FLUSH_EVENT` listener's save, waits for them
 * (up to `QUIT_FLUSH_BUDGET_MS`), then acks with `flush_done` so the app exits.
 */
export async function flushBeforeQuit(): Promise<void> {
  const work: Promise<unknown>[] = [];
  const detail: QuitFlushDetail = { waitUntil: (p) => void work.push(p) };
  try {
    window.dispatchEvent(new CustomEvent<QuitFlushDetail>(QUIT_FLUSH_EVENT, { detail }));
  } catch (err) {
    console.warn('[window] quit flush listener failed', err);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(work),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, QUIT_FLUSH_BUDGET_MS);
    }),
  ]);
  clearTimeout(timer);
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('flush_done');
  } catch (err) {
    console.warn('[window] flush_done failed', err);
  }
}

/** A translation, or `english` when it is blank. */
function label(key: string, english: string): string {
  return i18next.t(key).trim() || english;
}

/** The tray menu and tooltip in the current UI language (English only where a translation is blank). */
export function trayLabels(): { show: string; quit: string; tooltip: string } {
  return {
    show: label('shell:trayShow', 'Show Tsrust IPTV'),
    quit: label('shell:trayQuit', 'Quit'),
    tooltip: label('shell:appName', 'Tsrust IPTV'),
  };
}

/**
 * Keeps the tray menu in the UI language: sends the labels now (when i18next is ready) and
 * on every language change (Rust `tray_labels`). Returns an unsubscribe function.
 */
export function bindTrayLabels(): () => void {
  if (!isDesktop) return () => {};
  const send = (): void => {
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('tray_labels', trayLabels()))
      .catch((err: unknown) => console.warn('[window] tray_labels failed', err));
  };
  i18next.on('languageChanged', send);
  if (i18next.isInitialized) send();
  return () => i18next.off('languageChanged', send);
}

/**
 * Cursor position on the desktop, or null on the web. The embedded mpv window swallows
 * mouse moves over the video, so fullscreen controls poll this to notice the mouse.
 */
export async function cursorPosition(): Promise<{ x: number; y: number } | null> {
  if (!isDesktop) return null;
  try {
    const { cursorPosition: read } = await import('@tauri-apps/api/window');
    const p = await read();
    return { x: p.x, y: p.y };
  } catch {
    return null;
  }
}

/**
 * Cursor position in CSS px relative to the webview viewport (same space as
 * `getBoundingClientRect`), or null on the web. Lets the fullscreen chrome react only to
 * movement over the video, not anywhere on the screen.
 */
export async function cursorInViewport(): Promise<{ x: number; y: number } | null> {
  if (!isDesktop) return null;
  try {
    const { cursorPosition: read, getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const [p, origin, scale] = await Promise.all([read(), win.innerPosition(), win.scaleFactor()]);
    return { x: (p.x - origin.x) / scale, y: (p.y - origin.y) / scale };
  } catch {
    return null;
  }
}

/** Size (16:9; other aspects keep its area) and margin of the picture-in-picture window, in logical px. */
const PIP_SIZE = { width: 480, height: 270 };
const PIP_MARGIN = 24;
/** Smallest PiP window while resizing, in logical px (reshaped to the video like the window). */
const PIP_MIN_SIZE = { width: 240, height: 135 };
/** The PiP shape when the video's is unknown, and the range a real video aspect falls in (Rust clamps the same). */
export const PIP_DEFAULT_ASPECT = 16 / 9;
const MIN_ASPECT = 0.25;
const MAX_ASPECT = 4;

/** A real aspect clamped into 1:4..4:1 (an extreme video gets the nearest usable shape); undefined when unknown. */
function clampAspect(aspect: number | undefined): number | undefined {
  if (aspect === undefined || !Number.isFinite(aspect) || !(aspect > 0)) return undefined;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));
}

/**
 * `base` reshaped to `aspect` (width / height) with the same area, so a portrait or 4:3 PiP is
 * about as big as the 16:9 one. An unknown aspect gives 16:9; an extreme one is clamped to 1:4..4:1.
 */
export function sizeForAspect(base: { width: number; height: number }, aspect?: number): { width: number; height: number } {
  const a = clampAspect(aspect) ?? PIP_DEFAULT_ASPECT;
  const width = Math.round(Math.sqrt(base.width * base.height * a));
  return { width, height: Math.round(width / a) };
}
/** The configured minimum size of the main window (tauri.conf.json), restored on exit. */
const MAIN_MIN_SIZE = { width: 800, height: 600 };
/** How much of the top edge (title bar) must be on screen to count as reachable, in physical px. */
const MIN_VISIBLE_WIDTH = 160;
const MIN_VISIBLE_HEIGHT = 32;

/** A rectangle in physical px. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The window before PiP, in physical px: outer position and inner size (the spaces
 * `setPosition`/`setSize` and tauri-plugin-window-state use). When `maximized` is set the
 * rectangle is the normal one under the maximized window. Mirrors Rust
 * `pip_state::NormalGeometry`.
 */
export interface NormalGeometry extends Rect {
  maximized: boolean;
}

let beforePip: NormalGeometry | null = null;
/** Frame thickness (outer minus inner size) of the normal window, measured on entering PiP. */
let beforePipFrame = { width: 0, height: 0 };

/** Where the last PiP window was (physical px), so the next one opens there. */
const PIP_RECT_KEY = 'tsrust.pipWindow';

function isRect(v: unknown): v is Rect {
  if (typeof v !== 'object' || v === null) return false;
  const r: Partial<Record<keyof Rect, unknown>> = v;
  return (['x', 'y', 'width', 'height'] as const).every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]));
}

function loadPipRect(): Rect | null {
  try {
    const raw = globalThis.localStorage?.getItem(PIP_RECT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isRect(parsed) && parsed.width > 0 && parsed.height > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function savePipRect(rect: Rect): void {
  try {
    globalThis.localStorage?.setItem(PIP_RECT_KEY, JSON.stringify(rect));
  } catch {
    // Storage full or blocked: the next PiP opens in the corner, which is fine.
  }
}

/** Whether `rect` lies entirely inside one of `areas`. */
export function fitsOnScreen(rect: Rect, areas: readonly Rect[]): boolean {
  return areas.some((a) => rect.x >= a.x && rect.y >= a.y && rect.x + rect.width <= a.x + a.width && rect.y + rect.height <= a.y + a.height);
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

/**
 * Where to put a window so it can be reached: unchanged when enough of its top edge (where
 * the title bar is) lies on one of `areas`, otherwise moved, and shrunk if needed, into the
 * work area it overlaps most, or `fallback` when it overlaps none (a monitor was unplugged).
 */
export function placeOnScreen(rect: Rect, areas: readonly Rect[], fallback?: Rect): Rect {
  if (areas.length === 0) return rect;
  const titleBar: Rect = { x: rect.x, y: rect.y, width: rect.width, height: MIN_VISIBLE_HEIGHT };
  const reachable = areas.some((a) => {
    const o = overlap(titleBar, a);
    return o.height >= MIN_VISIBLE_HEIGHT && o.width >= Math.min(rect.width, MIN_VISIBLE_WIDTH);
  });
  if (reachable) return rect;
  let best: Rect | undefined;
  let bestArea = 0;
  for (const a of areas) {
    const o = overlap(rect, a);
    if (o.width * o.height > bestArea) {
      bestArea = o.width * o.height;
      best = a;
    }
  }
  const area = best ?? fallback ?? areas[0]!;
  const width = Math.min(rect.width, area.width);
  const height = Math.min(rect.height, area.height);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return {
    x: clamp(rect.x, area.x, area.x + area.width - width),
    y: clamp(rect.y, area.y, area.y + area.height - height),
    width,
    height,
  };
}

type TauriWindow = typeof import('@tauri-apps/api/window');
type AppWindow = ReturnType<TauriWindow['getCurrentWindow']>;

/** Runs one restore step; a failed step is logged and the rest still run. */
async function step(what: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.warn(`[window] picture-in-picture: ${what} failed`, err);
  }
}

type MonitorLike = { workArea: { position: { x: number; y: number }; size: { width: number; height: number } } };

function workArea(m: MonitorLike): Rect {
  return { x: m.workArea.position.x, y: m.workArea.position.y, width: m.workArea.size.width, height: m.workArea.size.height };
}

/**
 * Puts the frame, size, position and maximized state of `prev` back, best effort. `frame` is
 * the frame thickness, so the whole outer window (not just its inner size) is fitted on screen.
 */
async function restoreWindow(
  api: TauriWindow,
  win: AppWindow,
  prev: NormalGeometry | null,
  frame: { width: number; height: number } = { width: 0, height: 0 },
): Promise<void> {
  await step('always on top', () => win.setAlwaysOnTop(false));
  await step('decorations', () => win.setDecorations(true));
  await step('min size', () => win.setMinSize(new api.LogicalSize(MAIN_MIN_SIZE.width, MAIN_MIN_SIZE.height)));
  if (!prev) return;
  let target: Rect = prev;
  await step('monitors', async () => {
    const [monitors, current] = await Promise.all([api.availableMonitors(), api.currentMonitor()]);
    const outer: Rect = { x: prev.x, y: prev.y, width: prev.width + frame.width, height: prev.height + frame.height };
    const placed = placeOnScreen(outer, monitors.map(workArea), current ? workArea(current) : undefined);
    target = {
      x: placed.x,
      y: placed.y,
      width: Math.max(1, placed.width - frame.width),
      height: Math.max(1, placed.height - frame.height),
    };
  });
  // Position first: moving onto a monitor with another DPI makes tao rescale the window, which
  // would undo a size set before the move (Rust `fit_restored_window` does the same).
  await step('position', () => win.setPosition(new api.PhysicalPosition(target.x, target.y)));
  await step('size', () => win.setSize(new api.PhysicalSize(target.width, target.height)));
  if (prev.maximized) await step('maximize', () => win.maximize());
}

/**
 * Where the PiP window opens, shaped like the video: where the last one was (same position and
 * area) when that still fits on a monitor and is not below the minimum size, else the
 * bottom-right corner of the current monitor.
 */
async function pipRect(api: TauriWindow, win: AppWindow, aspect?: number): Promise<Rect | null> {
  const monitor = await api.currentMonitor();
  const scale = monitor?.scaleFactor ?? (await win.scaleFactor());
  const stored = loadPipRect();
  const min = sizeForAspect({ width: PIP_MIN_SIZE.width * scale, height: PIP_MIN_SIZE.height * scale }, aspect);
  const last = stored ? { x: stored.x, y: stored.y, ...sizeForAspect(stored, aspect) } : null;
  if (last && last.width >= min.width && last.height >= min.height) {
    const monitors = await api.availableMonitors().catch(() => []);
    if (fitsOnScreen(last, monitors.map(workArea))) return last;
  }
  const { width, height } = sizeForAspect({ width: PIP_SIZE.width * scale, height: PIP_SIZE.height * scale }, aspect);
  if (!monitor) return null;
  const area = workArea(monitor);
  const m = Math.round(PIP_MARGIN * scale);
  return { x: area.x + area.width - width - m, y: area.y + area.height - height - m, width, height };
}

/**
 * Aspect-locked resizing with the video following the frame, and the geometry to restore if
 * the app quits in PiP (Rust `pip_window`, which also hands it to `pip_state`).
 */
async function setNativePip(on: boolean, restore?: NormalGeometry, aspect?: number): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // Without an aspect Rust locks to the window's shape, which `pipRect` already gave the default.
    await invoke('pip_window', { on, restore: restore ?? null, ...(on && clampAspect(aspect) !== undefined ? { aspect: clampAspect(aspect) } : {}) });
    return true;
  } catch (err) {
    console.warn('[window] pip_window failed', err);
    return false;
  }
}

/**
 * While in PiP, reshapes the window to a new video `aspect` (width / height): the same area,
 * around the same center, kept inside its monitor's work area. Rust re-locks the ratio first
 * (`pip_aspect`), since the locked ratio reshapes any resize. False when not in PiP or on failure.
 */
export async function setPipWindowAspect(aspect: number): Promise<boolean> {
  const a = clampAspect(aspect);
  if (!isDesktop || a === undefined || beforePip === null) return false;
  try {
    const [api, { invoke }] = await Promise.all([import('@tauri-apps/api/window'), import('@tauri-apps/api/core')]);
    if (!(await invoke<boolean>('pip_aspect', { aspect: a }))) return false;
    const win = api.getCurrentWindow();
    const minSize = sizeForAspect(PIP_MIN_SIZE, a);
    await win.setMinSize(new api.LogicalSize(minSize.width, minSize.height));
    const [pos, size, monitor] = await Promise.all([win.outerPosition(), win.innerSize(), api.currentMonitor()]);
    const next = sizeForAspect(size, a);
    let x = Math.round(pos.x + (size.width - next.width) / 2);
    let y = Math.round(pos.y + (size.height - next.height) / 2);
    if (monitor) {
      const area = workArea(monitor);
      x = Math.max(area.x, Math.min(x, area.x + area.width - next.width));
      y = Math.max(area.y, Math.min(y, area.y + area.height - next.height));
    }
    await win.setPosition(new api.PhysicalPosition(x, y));
    await win.setSize(new api.PhysicalSize(next.width, next.height));
    return true;
  } catch (err) {
    console.warn('[window] picture-in-picture aspect change failed', err);
    return false;
  }
}

/**
 * Turns the app window into a small borderless always-on-top video window in the
 * bottom-right corner of its monitor, remembering where it was. `aspect` is the video's width /
 * height (16:9 when unknown); the window takes that shape and keeps it while resized. Returns
 * false on the web or when the window could not be changed; a failure halfway puts it back.
 */
export async function enterPipWindow(aspect?: number): Promise<boolean> {
  if (!isDesktop) return false;
  let api: TauriWindow;
  try {
    api = await import('@tauri-apps/api/window');
  } catch (err) {
    console.warn('[window] enter picture-in-picture failed', err);
    return false;
  }
  const win = api.getCurrentWindow();
  const firstEnter = beforePip === null;
  try {
    if (firstEnter) {
      // Leave fullscreen and maximized first, so the geometry saved is the normal window
      // (exit maximizes again on top of it, and un-maximizing later still has a sane size).
      if (await win.isFullscreen()) await win.setFullscreen(false);
      const maximized = await win.isMaximized();
      if (maximized) await win.unmaximize();
      const [pos, size, outer] = await Promise.all([win.outerPosition(), win.innerSize(), win.outerSize()]);
      beforePip = { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized };
      beforePipFrame = { width: Math.max(0, outer.width - size.width), height: Math.max(0, outer.height - size.height) };
    }
    const minSize = sizeForAspect(PIP_MIN_SIZE, aspect);
    await win.setMinSize(new api.LogicalSize(minSize.width, minSize.height));
    await win.setDecorations(false);
    await win.setAlwaysOnTop(true);
    const rect = await pipRect(api, win, aspect);
    if (rect) {
      // Position first, as above: a DPI change on the move would rescale an earlier size.
      await win.setPosition(new api.PhysicalPosition(rect.x, rect.y));
      await win.setSize(new api.PhysicalSize(rect.width, rect.height));
    } else {
      const scale = await win.scaleFactor();
      const size = sizeForAspect({ width: PIP_SIZE.width * scale, height: PIP_SIZE.height * scale }, aspect);
      await win.setSize(new api.PhysicalSize(size.width, size.height));
    }
    // Without the Rust side, quitting in PiP would save the small window: roll back instead.
    if (!(await setNativePip(true, beforePip ?? undefined, aspect))) throw new Error('pip_window failed');
    return true;
  } catch (err) {
    console.warn('[window] enter picture-in-picture failed', err);
    const prev = beforePip;
    beforePip = null;
    await setNativePip(false);
    await restoreWindow(api, win, firstEnter ? prev : null, beforePipFrame);
    return false;
  }
}

/**
 * Restores the window that `enterPipWindow` shrank, remembering where the PiP window was so
 * the next one opens there. Safe to call when PiP is off.
 */
export async function exitPipWindow(): Promise<void> {
  if (!isDesktop) return;
  const prev = beforePip;
  const frame = beforePipFrame;
  beforePip = null;
  beforePipFrame = { width: 0, height: 0 };
  let api: TauriWindow;
  try {
    api = await import('@tauri-apps/api/window');
  } catch (err) {
    console.warn('[window] exit picture-in-picture failed', err);
    return;
  }
  const win = api.getCurrentWindow();
  if (prev) {
    await step('remember PiP rect', async () => {
      const [pos, size] = await Promise.all([win.outerPosition(), win.innerSize()]);
      savePipRect({ x: pos.x, y: pos.y, width: size.width, height: size.height });
    });
  }
  // Unlock the aspect ratio before the window grows back.
  await setNativePip(false);
  await restoreWindow(api, win, prev, frame);
}

/**
 * After a webview reload in PiP the page has forgotten the window was shrunk, but the Rust
 * side still knows (`pip_window_saved`). Puts the normal window back; resolves true when it
 * had to. No-op on the web and when PiP was off.
 */
export async function recoverPipWindow(): Promise<boolean> {
  if (!isDesktop || beforePip) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const saved = await invoke<NormalGeometry | null>('pip_window_saved');
    if (!saved || beforePip) return false;
    beforePip = saved;
  } catch {
    return false;
  }
  await exitPipWindow();
  return true;
}
