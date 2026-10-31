/**
 * The command palette's and the `?` overlay's chunks (F1-3). The shell mounts each overlay the
 * first time it opens, not at boot: the closed palette loaded about 85 kB (its own chunk, cmdk with
 * an unused Radix dialog stack, programme search, onboarding strings) right after the shell's first
 * render on every launch, and then re-rendered with every navigation. `warmOverlays` fetches both
 * once the browser is idle after the player's idle load, and the header's palette buttons and the
 * rail's shortcuts button start theirs on hover or focus, so a click or Ctrl+K rarely waits. A
 * failed load is forgotten, so the next try fetches again.
 */

type PaletteModule = typeof import('./CommandPalette');
type OverlayModule = typeof import('./ShortcutOverlay');

let palette: Promise<PaletteModule> | null = null;
let overlay: Promise<OverlayModule> | null = null;

export function loadCommandPalette(): Promise<PaletteModule> {
  if (!palette) {
    const load = import('./CommandPalette');
    palette = load;
    load.catch(() => {
      if (palette === load) palette = null;
    });
  }
  return palette;
}

export function loadShortcutOverlay(): Promise<OverlayModule> {
  if (!overlay) {
    const load = import('./ShortcutOverlay');
    overlay = load;
    load.catch(() => {
      if (overlay === load) overlay = null;
    });
  }
  return overlay;
}

/** Hover and focus handlers that start the palette's chunk (the header's palette buttons). */
export const paletteWarmers = {
  onPointerEnter: () => void loadCommandPalette().catch(() => undefined),
  onFocus: () => void loadCommandPalette().catch(() => undefined),
};

/** Hover and focus handlers that start the `?` overlay's chunk (the rail's shortcuts button). */
export const overlayWarmers = {
  onPointerEnter: () => void loadShortcutOverlay().catch(() => undefined),
  onFocus: () => void loadShortcutOverlay().catch(() => undefined),
};

/** At most this long before an idle warm-up runs anyway (as the player's idle load waits). */
export const OVERLAY_IDLE_TIMEOUT_MS = 2000;

/**
 * Fetches both overlays' chunks on the browser's next idle moment (at most
 * OVERLAY_IDLE_TIMEOUT_MS; a macrotask where requestIdleCallback is missing). Returns the cancel
 * function.
 */
export function warmOverlays(win: Window = window): () => void {
  const run = () => {
    void loadCommandPalette().catch(() => undefined);
    void loadShortcutOverlay().catch(() => undefined);
  };
  if (typeof win.requestIdleCallback === 'function') {
    const id = win.requestIdleCallback(run, { timeout: OVERLAY_IDLE_TIMEOUT_MS });
    return () => win.cancelIdleCallback?.(id);
  }
  const timer = setTimeout(run, 0);
  return () => clearTimeout(timer);
}
