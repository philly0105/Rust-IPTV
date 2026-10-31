/**
 * Public surface of the player feature (SPEC C8). Pages import it for the stage and the store, so
 * it must not export anything that reaches the dock or the controls: the shell loads those from
 * `./dock`.
 */
export {
  usePlayerStore,
  playItem,
  playSource,
  restorePlayback,
  type PlayerMode,
  type PlayerState,
  type PlayerActions,
  type PlayItemArgs,
  type ZapContext,
} from './store';
export { useChannelZap } from './useChannelZap';
export { preloadEngines } from './enginePreload';
export { PlayerStage, type PlayerStageProps } from './components/PlayerStage';
export { stopExternalPlayback } from './external';
