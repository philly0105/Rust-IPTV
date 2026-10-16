/**
 * Subtitle delay and stream info for the built-in player (hls.js, shaka, mpegts.js, the element).
 * Bound by InlinePlayer for as long as its media element exists.
 */

import type { Engine } from './engines';
import { elementStats, setStatsProvider } from './streamInfo';
import { useSyncStore } from './sync';
import { bindCueDelay } from './textDelay';

export function bindInlineExtras(el: HTMLVideoElement | HTMLAudioElement, getEngine: () => Engine | null): () => void {
  const cues = bindCueDelay(el, () => useSyncStore.getState().subMs / 1000);
  cues.update();
  const unSync = useSyncStore.subscribe((s, prev) => {
    if (s.subMs !== prev.subMs) cues.update();
  });
  // The element's own numbers (decoded size, drops, buffer) win over the library's manifest values.
  const unStats = setStatsProvider(() => {
    const engine = getEngine();
    return { engine: engine?.kind ?? 'native', ...engine?.stats?.(), ...elementStats(el) };
  });
  return () => {
    unSync();
    unStats();
    cues.stop();
  };
}
