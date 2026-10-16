import { useEffect, useState } from 'react';

/**
 * Below this width (CSS px) a player surface is phone-sized: the control row keeps its core
 * buttons and moves the rest into the options menu, and the zap banner becomes a one-line chip.
 */
export const NARROW_PLAYER_PX = 480;

/**
 * Whether `el` is laid out narrower than `below`, following it as it resizes. False until it is
 * measured, and where it cannot be (no layout).
 *
 * The width is read in the ResizeObserver's callback, which runs after layout: a read while the
 * player mounts would force a layout in the frame of the click that opened it.
 */
export function useNarrow(el: HTMLElement | null, below = NARROW_PLAYER_PX): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!el) return;
    const check = (): void => {
      const w = el.offsetWidth;
      setNarrow(w > 0 && w < below);
    };
    // Without an observer (tests, old engines) there is nothing to wait for.
    if (typeof ResizeObserver === 'undefined') {
      check();
      return;
    }
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, below]);
  return narrow;
}
