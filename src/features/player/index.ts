/**
 * Public surface of the player feature (SPEC C8). The dock and the external playback footer are in
 * `./dock`, which only the shell loads: pages import this barrel for the stage, the store and
 * `playItem`, and with the dock here their static imports reached the controls chunk (F1-1).
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
export { RadioPlayer } from './components/RadioPlayer';
export { stopExternalPlayback } from './external';

import { requestPlayerDock } from './dockRequest';
import { usePlayerStore } from './store';

// The first source asks the shell for the dock at once (dockRequest.ts): a press already starts it,
// a play with none (the phone remote, autoplay) would otherwise wait for the shell's idle load.
if (typeof window !== 'undefined') {
  const stop = usePlayerStore.subscribe((s) => {
    if (!s.source) return;
    stop();
    requestPlayerDock();
  });
}
