import { MINUTE } from '../lib/epgTime';

export type GuideRenderWindow = readonly [start: number, end: number];

// Data stays prefetched for hours; only nearby programme buttons occupy the DOM.
const STEP = 30 * MINUTE;
const LEAD = 45 * MINUTE;
const GUARD = 15 * MINUTE;

/** Recenter only after the viewport enters the guard band, avoiding renders per scroll event. */
export function nextGuideRenderWindow(
  visibleStart: number,
  visibleEnd: number,
  current?: GuideRenderWindow,
): GuideRenderWindow {
  if (current && visibleStart >= current[0] + GUARD && visibleEnd <= current[1] - GUARD) return current;
  return [Math.floor(visibleStart / STEP) * STEP - LEAD, Math.ceil(visibleEnd / STEP) * STEP + LEAD];
}
