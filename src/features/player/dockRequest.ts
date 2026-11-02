/**
 * Asks the shell to load the player dock now (F1-1). The shell loads `./dock` with `import()` at
 * idle after the first route, or on the first pointer or key press. Pages no longer bring the dock
 * in with the `@/features/player` barrel, so a play that starts with no press (the phone remote, a
 * queued next episode, an autoplay) would wait for that idle load; the barrel raises this event as
 * soon as the store has a source. A leaf, so the shell's entry chunk can read the name.
 */
export const PLAYER_DOCK_EVENT = 'tsrust:player-dock';

export function requestPlayerDock(win: Window = window): void {
  win.dispatchEvent(new Event(PLAYER_DOCK_EVENT));
}
