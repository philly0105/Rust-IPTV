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
