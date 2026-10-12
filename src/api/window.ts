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
/** The configured minimum size of the main window (tauri.conf.json), restored on exit. */
const MAIN_MIN_SIZE = { width: 800, height: 600 };

let beforePip: { x: number; y: number; width: number; height: number; maximized: boolean } | null = null;

/**
 * Turns the app window into a small borderless always-on-top video window in the
 * bottom-right corner of its monitor, remembering where it was. Returns false on the web or
 * when the window could not be changed.
 */
export async function enterPipWindow(): Promise<boolean> {
  if (!isDesktop) return false;
  try {
    const { getCurrentWindow, currentMonitor, LogicalSize, PhysicalPosition, PhysicalSize } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (!beforePip) {
      const [pos, size, maximized] = await Promise.all([win.outerPosition(), win.outerSize(), win.isMaximized()]);
      beforePip = { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized };
    }
    if (await win.isFullscreen()) await win.setFullscreen(false);
    if (beforePip.maximized) await win.unmaximize();
    await win.setMinSize(new LogicalSize(240, 135));
    await win.setDecorations(false);
    await win.setAlwaysOnTop(true);
    const monitor = await currentMonitor();
    const scale = monitor?.scaleFactor ?? (await win.scaleFactor());
    const w = Math.round(PIP_WIDTH * scale);
    const h = Math.round(PIP_HEIGHT * scale);
    await win.setSize(new PhysicalSize(w, h));
    if (monitor) {
      const area = monitor.workArea;
      const m = Math.round(PIP_MARGIN * scale);
      await win.setPosition(new PhysicalPosition(area.position.x + area.size.width - w - m, area.position.y + area.size.height - h - m));
    }
    return true;
  } catch (err) {
    console.warn('[window] enter picture-in-picture failed', err);
    await exitPipWindow();
    return false;
  }
}

/** Restores the window that `enterPipWindow` shrank. */
export async function exitPipWindow(): Promise<void> {
  if (!isDesktop) return;
  try {
    const { getCurrentWindow, LogicalSize, PhysicalPosition, PhysicalSize } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.setAlwaysOnTop(false);
    await win.setDecorations(true);
    await win.setMinSize(new LogicalSize(MAIN_MIN_SIZE.width, MAIN_MIN_SIZE.height));
    const prev = beforePip;
    beforePip = null;
    if (prev) {
      await win.setSize(new PhysicalSize(prev.width, prev.height));
      await win.setPosition(new PhysicalPosition(prev.x, prev.y));
      if (prev.maximized) await win.maximize();
    }
  } catch (err) {
    console.warn('[window] exit picture-in-picture failed', err);
  }
}
