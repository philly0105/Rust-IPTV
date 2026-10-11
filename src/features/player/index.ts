/** Public surface of the player feature (SPEC C8). */
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
export { PlayerDock } from './components/PlayerDock';
export { PlayerStage, type PlayerStageProps } from './components/PlayerStage';
export { RadioPlayer } from './components/RadioPlayer';
export { ExternalPlaybackFooter } from './components/ExternalPlaybackFooter';
export { stopExternalPlayback } from './external';
