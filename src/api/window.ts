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
  // The PiP geometry code is its own module (pipWindow.ts, F1-7), out of the entry chunk; the
  // recovery after a reload in PiP waits one local import.
  void import('./pipWindow').then((m) => m.recoverPipWindow()).catch(() => undefined);
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
 * A desktop cursor position (`cursorPosition`, physical px) in CSS px relative to the webview
 * viewport (same space as `getBoundingClientRect`), or null on the web. Lets the fullscreen
 * chrome react only to movement over the video, not anywhere on the screen. Reads the window's
 * origin and scale each time (two IPC calls), so a moved window or a new screen is never stale.
 */
export async function screenToViewport(p: { x: number; y: number }): Promise<{ x: number; y: number } | null> {
  if (!isDesktop) return null;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const [origin, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
    return { x: (p.x - origin.x) / scale, y: (p.y - origin.y) / scale };
  } catch {
    return null;
  }
}
