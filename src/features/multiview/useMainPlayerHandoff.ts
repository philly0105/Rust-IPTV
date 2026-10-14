/**
 * The wall and the main player do not play at once (C4: opening multi-view stops the main
 * player). When the wall has tiles, the in-app player is stopped through its public store
 * API; an external player (mpv or VLC in its own window) is left alone.
 *
 * The shell restores the last playback after a reload, which can land a moment after this
 * page mounts: for a short grace period any in-app playback that starts is stopped too.
 * After that, playback the user starts on purpose (remote, command palette) wins: it keeps
 * playing, the wall goes quiet (`mainPlaying`) and the page offers to stop it.
 */

import { useCallback, useEffect } from 'react';

import { usePlayerStore } from './deps';

export const RESTORE_GRACE_MS = 5_000;

function stopInAppPlayback(): void {
  const s = usePlayerStore.getState();
  if (s.source && s.mode !== 'external') s.stop();
}

export function useMainPlayerHandoff(active: boolean): { mainPlaying: boolean; stopMain: () => void } {
  const playing = usePlayerStore((s) => !!s.source && s.mode !== 'external');

  useEffect(() => {
    if (!active) return;
    stopInAppPlayback();
    const until = Date.now() + RESTORE_GRACE_MS;
    const unsubscribe = usePlayerStore.subscribe((s, prev) => {
      if (Date.now() > until) return;
      if (s.source && !prev.source && s.mode !== 'external') stopInAppPlayback();
    });
    const timer = setTimeout(unsubscribe, RESTORE_GRACE_MS);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [active]);

  const stopMain = useCallback(() => stopInAppPlayback(), []);
  return { mainPlaying: active && playing, stopMain };
}
