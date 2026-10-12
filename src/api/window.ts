/**
 * Desktop window helpers. Element fullscreen inside WebView2 only fills the
 * webview, so on desktop the OS window follows `document.fullscreenElement`.
 * Every function is a no-op on the web build.
 */

import { isDesktop } from './transport';

/** Puts the desktop window in or out of OS fullscreen. No-op on the web. */
export async function setWindowFullscreen(on: boolean): Promise<void> {
  if (!isDesktop) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if ((await win.isFullscreen()) !== on) await win.setFullscreen(on);
  } catch (err) {
    console.warn('[window] setFullscreen failed', err);
  }
}

/**
 * Mirrors element fullscreen (player `requestFullscreen`) onto the desktop
 * window. Call once at startup; returns an unsubscribe function.
 */
export function bindWindowFullscreen(): () => void {
  if (!isDesktop || typeof document === 'undefined') return () => {};
  const sync = () => void setWindowFullscreen(document.fullscreenElement != null);
  document.addEventListener('fullscreenchange', sync);
  return () => document.removeEventListener('fullscreenchange', sync);
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

/** Size and margin of the picture-in-picture window, in logical px. */
const PIP_WIDTH = 480;
const PIP_HEIGHT = 270;
const PIP_MARGIN = 24;
/** Smallest PiP window while resizing, in logical px (16:9 like the PiP window). */
const PIP_MIN_SIZE = { width: 240, height: 135 };
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

/** Puts the frame, size, position and maximized state of `prev` back, best effort. */
async function restoreWindow(api: TauriWindow, win: AppWindow, prev: NormalGeometry | null): Promise<void> {
  await step('always on top', () => win.setAlwaysOnTop(false));
  await step('decorations', () => win.setDecorations(true));
  await step('min size', () => win.setMinSize(new api.LogicalSize(MAIN_MIN_SIZE.width, MAIN_MIN_SIZE.height)));
  if (!prev) return;
  let target: Rect = prev;
  await step('monitors', async () => {
    const [monitors, current] = await Promise.all([api.availableMonitors(), api.currentMonitor()]);
    const toRect = (m: { workArea: { position: { x: number; y: number }; size: { width: number; height: number } } }): Rect => ({
      x: m.workArea.position.x,
      y: m.workArea.position.y,
      width: m.workArea.size.width,
      height: m.workArea.size.height,
    });
    target = placeOnScreen(prev, monitors.map(toRect), current ? toRect(current) : undefined);
  });
  await step('size', () => win.setSize(new api.PhysicalSize(target.width, target.height)));
  await step('position', () => win.setPosition(new api.PhysicalPosition(target.x, target.y)));
  if (prev.maximized) await step('maximize', () => win.maximize());
}

/**
 * Aspect-locked resizing with the video following the frame, and the geometry to restore if
 * the app quits in PiP (Rust `pip_window`, which also hands it to `pip_state`).
 */
async function setNativePip(on: boolean, restore?: NormalGeometry): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('pip_window', { on, restore: restore ?? null });
    return true;
  } catch (err) {
    console.warn('[window] pip_window failed', err);
    return false;
  }
}

/**
 * Turns the app window into a small borderless always-on-top video window in the
 * bottom-right corner of its monitor, remembering where it was. Returns false on the web or
 * when the window could not be changed; a failure halfway puts the window back.
 */
export async function enterPipWindow(): Promise<boolean> {
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
      const [pos, size] = await Promise.all([win.outerPosition(), win.innerSize()]);
      beforePip = { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized };
    }
    await win.setMinSize(new api.LogicalSize(PIP_MIN_SIZE.width, PIP_MIN_SIZE.height));
    await win.setDecorations(false);
    await win.setAlwaysOnTop(true);
    const monitor = await api.currentMonitor();
    const scale = monitor?.scaleFactor ?? (await win.scaleFactor());
    const w = Math.round(PIP_WIDTH * scale);
    const h = Math.round(PIP_HEIGHT * scale);
    await win.setSize(new api.PhysicalSize(w, h));
    if (monitor) {
      const area = monitor.workArea;
      const m = Math.round(PIP_MARGIN * scale);
      await win.setPosition(new api.PhysicalPosition(area.position.x + area.size.width - w - m, area.position.y + area.size.height - h - m));
    }
    // Without the Rust side, quitting in PiP would save the small window: roll back instead.
    if (!(await setNativePip(true, beforePip ?? undefined))) throw new Error('pip_window failed');
    return true;
  } catch (err) {
    console.warn('[window] enter picture-in-picture failed', err);
    const prev = beforePip;
    beforePip = null;
    await setNativePip(false);
    await restoreWindow(api, win, firstEnter ? prev : null);
    return false;
  }
}

/** Restores the window that `enterPipWindow` shrank. Safe to call when PiP is off. */
export async function exitPipWindow(): Promise<void> {
  if (!isDesktop) return;
  const prev = beforePip;
  beforePip = null;
  let api: TauriWindow;
  try {
    api = await import('@tauri-apps/api/window');
  } catch (err) {
    console.warn('[window] exit picture-in-picture failed', err);
    return;
  }
  // Unlock the aspect ratio before the window grows back.
  await setNativePip(false);
  await restoreWindow(api, api.getCurrentWindow(), prev);
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
