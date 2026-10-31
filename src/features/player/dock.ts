/**
 * What the shell loads to show the player: the dock and the external-playback footer, with the
 * store calls it makes once they are in. Kept out of the `@/features/player` barrel, which pages
 * import for the stage and the store: the dock's graph (the controls, the engines, the sleep
 * timer, failover and their module-level store subscriptions) would otherwise run before every
 * such page's first render.
 */
export { PlayerDock } from './components/PlayerDock';
export { ExternalPlaybackFooter } from './components/ExternalPlaybackFooter';
export { restorePlayback, usePlayerStore } from './store';
