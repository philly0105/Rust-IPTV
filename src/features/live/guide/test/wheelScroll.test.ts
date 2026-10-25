import { describe, expect, it, vi } from 'vitest';

import { createGuideWheelScroller, isWheelStep } from '../wheelScroll';

function scroller(left = 500) {
  const root = document.createElement('div');
  root.scrollLeft = left;
  // A smooth scroll does not reach its destination synchronously.
  const scrollTo = vi.fn();
  root.scrollTo = scrollTo;
  return { root, scrollTo, wheel: createGuideWheelScroller() };
}

describe('native guide wheel animation', () => {
  it('accumulates notches against the destination instead of losing unfinished movement', () => {
    const { root, scrollTo, wheel } = scroller();
    wheel.move(root, -120, 1000, false, true);
    root.scrollLeft = 470;
    wheel.move(root, -120, 1000, false, true);
    expect(scrollTo.mock.calls).toEqual([
      [{ left: 380, behavior: 'smooth' }],
      [{ left: 260, behavior: 'smooth' }],
    ]);
  });

  it('reverses from the visible position immediately, discarding the old direction', () => {
    const { root, scrollTo, wheel } = scroller();
    wheel.move(root, -300, 1000, false, true);
    root.scrollLeft = 460;
    wheel.move(root, 60, 1000, false, true);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 520, behavior: 'smooth' });
  });

  it.each([false, true])('clamps each target so wheel input cannot accumulate beyond an edge (RTL %s)', (rtl) => {
    const { root, scrollTo, wheel } = scroller(rtl ? -500 : 500);
    const sign = rtl ? -1 : 1;
    wheel.move(root, sign * 900, 1000, rtl, true);
    wheel.move(root, sign * 900, 1000, rtl, true);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: sign * 1000, behavior: 'smooth' });
    root.scrollLeft = sign * 1000;
    wheel.move(root, -sign * 60, 1000, rtl, true);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: sign * 940, behavior: 'smooth' });
  });

  it('cancels animation for a pointer, keyboard, zoom or native trackpad takeover', () => {
    const { root, scrollTo, wheel } = scroller();
    wheel.move(root, -120, 1000, false, true);
    root.scrollLeft = 450;
    wheel.cancel(root);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 450, behavior: 'instant' });
    root.scrollLeft = 600;
    wheel.move(root, -60, 1000, false, true);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 540, behavior: 'smooth' });
  });

  it('does not reset a new target on a cancelled animation’s late scrollend', () => {
    const { root, scrollTo, wheel } = scroller();
    wheel.move(root, -120, 1000, false, true);
    root.scrollLeft = 380;
    wheel.move(root, -120, 1000, false, true);
    wheel.settled(root);
    wheel.move(root, -120, 1000, false, true);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 140, behavior: 'smooth' });
  });

  it('uses the current position without easing for precise input or reduced motion', () => {
    const { root, scrollTo, wheel } = scroller();
    wheel.move(root, -120, 1000, false, true);
    root.scrollLeft = 450;
    wheel.move(root, -8, 1000, false, false);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 442, behavior: 'instant' });
    expect(isWheelStep(-8, 0)).toBe(false);
    expect(isWheelStep(-60, 0)).toBe(true);
    expect(isWheelStep(-3, 1)).toBe(true);
    expect(isWheelStep(-1, 2)).toBe(true);
  });
});
