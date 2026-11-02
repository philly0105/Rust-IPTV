/**
 * When an Escape last closed a player menu. A leaf module (F1-1): the detail pages' Escape handler
 * (`vod/hooks/useWatchState.ts`) reads it, and importing it from `components/Controls.tsx` put the
 * controls chunk (77 kB) in front of every movie and series page's first render.
 */
let menuEscapeAt = Number.NEGATIVE_INFINITY;

/** Notes that Escape just closed a player menu (the options menu at its root view). */
export function notePlayerMenuEscape(): void {
  menuEscapeAt = Date.now();
}

/**
 * True right after Escape closed a player menu. A page-level Escape (close the player) lets such
 * a key go: a held or doubled Escape must not run on from closing the menu into stopping playback.
 */
export function playerMenuJustClosed(withinMs = 600): boolean {
  return Date.now() - menuEscapeAt < withinMs;
}
