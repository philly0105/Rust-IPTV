/**
 * Adapter to the player's media engines (read only, `src/features/player/engines.ts`): the
 * same hls.js / shaka / mpegts.js / native element code the main player uses, attached to
 * each tile's own <video>. The player's index does not export these, hence the deep import
 * in one place.
 */

export {
  createEngine,
  fetchFailureReason,
  looksLikeMpegTs,
  mseSupported,
  withReason,
  worthSniffingAsMpegTs,
} from '@/features/player/engines';
export type { Engine, EngineError } from '@/features/player/engines';
