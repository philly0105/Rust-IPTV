/**
 * What the shell loads of the player (F1-1): the dock with its surfaces and controls, the external
 * playback footer, and the store the shell reads (F11, resume). Kept out of the `@/features/player`
 * barrel, which pages import for the stage, the store and `playItem`: with the dock exported there,
 * Live's and the guide's static imports reached the controls chunk and the dock's whole graph, and
 * moving it here took about 120 kB off what each loads before its first render. ShellLayout
 * imports this module with `import()` only; a static import would put the store in the entry.
 */
export { PlayerDock } from './components/PlayerDock';
export { ExternalPlaybackFooter } from './components/ExternalPlaybackFooter';
export { restorePlayback, usePlayerStore } from './store';
