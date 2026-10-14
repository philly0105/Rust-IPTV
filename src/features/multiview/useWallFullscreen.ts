/**
 * Full screen for the whole wall (not one tile). The element goes full screen through the
 * Fullscreen API; on the desktop the shell mirrors `document.fullscreenElement` to the
 * window (`bindWindowFullscreen`), so the window fills the screen too.
 * Leaving the page leaves full screen.
 */

import { useCallback, useEffect, useState, type RefObject } from 'react';

export interface WallFullscreen {
  active: boolean;
  /** The browser allows it (an iframe without `allowfullscreen` does not). */
  supported: boolean;
  toggle(): void;
  exit(): Promise<void>;
}

export function useWallFullscreen(ref: RefObject<HTMLElement | null>): WallFullscreen {
  const [active, setActive] = useState(false);
  const supported = typeof document !== 'undefined' && document.fullscreenEnabled !== false && typeof Element.prototype.requestFullscreen === 'function';

  useEffect(() => {
    let held: HTMLElement | null = null;
    const sync = (): void => {
      const el = ref.current;
      const on = !!el && document.fullscreenElement === el;
      held = on ? el : null;
      setActive(on);
    };
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      if (held && document.fullscreenElement === held) void document.exitFullscreen().catch(() => undefined);
    };
  }, [ref]);

  const exit = useCallback(async () => {
    const el = ref.current;
    if (el && document.fullscreenElement === el) await document.exitFullscreen().catch(() => undefined);
  }, [ref]);

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    // Another element (the main player) may hold full screen; the wall takes over.
    void el.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => undefined);
  }, [ref]);

  return { active, supported, toggle, exit };
}
