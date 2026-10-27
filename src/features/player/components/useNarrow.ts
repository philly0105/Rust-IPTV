import { useEffect, useState } from 'react';

/**
 * Below this width (CSS px) a player surface is phone-sized: the control row keeps its core
 * buttons and moves the rest into the options menu.
 */
export const NARROW_PLAYER_PX = 480;

/**
 * Below this height a player is short: the zap banner becomes a one-line chip (the Live page's
 * stage beside the list, where the guide ribbon under it says what airs now and next). With the
 * width under `NARROW_PLAYER_PX` too, a player is small, and its bar also waits for the chip. A
 * narrow but tall player (a desktop dock beside the channel list, a phone held upright in
 * fullscreen) has room for the full banner.
 */
export const SHORT_PLAYER_PX = 360;

/**
 * Whether `el` is laid out narrower than `below` (and, when given, shorter than `shorterThan`),
 * following it as it resizes. False until it is measured, and where it cannot be (no layout).
 *
 * The size is read in the ResizeObserver's callback, which runs after layout: a read while the
 * player mounts would force a layout in the frame of the click that opened it.
 */
export function useNarrow(el: HTMLElement | null, below = NARROW_PLAYER_PX, shorterThan = Number.POSITIVE_INFINITY): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!el) return;
    const check = (): void => {
      const w = el.offsetWidth;
      setNarrow(w > 0 && w < below && (shorterThan === Number.POSITIVE_INFINITY || el.offsetHeight < shorterThan));
    };
    // Without an observer (tests, old engines) there is nothing to wait for.
    if (typeof ResizeObserver === 'undefined') {
      check();
      return;
    }
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, below, shorterThan]);
  return narrow;
}

/** A small player (narrow and short, see `SHORT_PLAYER_PX`): the zap chip's size. */
export function useSmallPlayer(el: HTMLElement | null): boolean {
  return useNarrow(el, NARROW_PLAYER_PX, SHORT_PLAYER_PX);
}
