/**
 * A wheel notch supplies a distance, not animation frames. Keep its destination across a burst
 * and let the browser animate the native scroll container. Adding each notch to scrollLeft
 * instead would lose the unfinished part of the preceding notch.
 */
export function createGuideWheelScroller() {
  let target: number | null = null;
  let direction = 0;
  return {
    move(root: HTMLElement, delta: number, max: number, rtl: boolean, smooth: boolean) {
      const nextDirection = Math.sign(delta);
      // Reversing should respond from the current position, without finishing the old direction.
      const from = smooth && target !== null && direction === nextDirection ? target : root.scrollLeft;
      const next = Math.max(rtl ? -max : 0, Math.min(rtl ? 0 : max, from + delta));
      target = smooth ? next : null;
      direction = nextDirection;
      root.scrollTo({ left: next, behavior: smooth ? 'smooth' : 'instant' });
    },
    cancel(root: HTMLElement) {
      if (target !== null) root.scrollTo({ left: root.scrollLeft, behavior: 'instant' });
      target = null;
      direction = 0;
    },
    settled(root: HTMLElement) {
      // A cancelled animation can also emit scrollend after another notch has arrived.
      if (target !== null && Math.abs(root.scrollLeft - target) < 1) target = null;
    },
  };
}

/** Small pixel deltas already describe precise movement; don't add easing to those frames. */
export function isWheelStep(delta: number, mode: number): boolean {
  return mode !== 0 || Math.abs(delta) >= 40;
}

export function guideWheelMotionAllowed(): boolean {
  return document.documentElement.dataset.reducedMotion !== 'true' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
