/**
 * The system's media controls (L3-desktop-5): the keyboard's and a headset's play/pause, stop
 * and track buttons, and the media flyout, reach the player through the page's Media Session.
 * Chromium hands those buttons to the session while a media element of the page plays (the
 * built-in player); with none playing (embedded mpv) a focused window gets them as key presses,
 * which the playback shortcuts take (`mediaplaypause` and the rest). Windows' own media overlay
 * for embedded mpv (SMTC, outside the window's focus) is not wired up here.
 */

import { canZap, nextInQueue, prevInQueue, usePlayerStore, type PlayerState } from './store';

/** What the buttons do; next and previous only exist while they would do something. */
export interface MediaButtons {
  togglePlay(): void;
  stop(): void;
  next(): void;
  previous(): void;
}

type Action = 'play' | 'pause' | 'stop' | 'nexttrack' | 'previoustrack';
const ACTIONS: readonly Action[] = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'];

const running = (s: PlayerState): boolean => s.status === 'playing' || s.status === 'loading';

/**
 * Keeps `navigator.mediaSession` in step with the player while bound: what plays (the channel or
 * title, and the programme or episode under it), playing or paused, and the buttons that apply.
 * Returns the unbind, which clears all of it. Does nothing where the browser has no session.
 */
export function bindMediaSession(buttons: () => MediaButtons): () => void {
  const session = typeof navigator === 'undefined' ? undefined : navigator.mediaSession;
  if (!session) return () => undefined;
  const handle = (action: Action, fn: (() => void) | null): void => {
    try {
      session.setActionHandler(action, fn);
    } catch {
      // An action this browser does not know.
    }
  };
  let shown = '';
  const sync = (s: PlayerState): void => {
    const on = !!s.source && s.mode !== 'external';
    const zaps = on && canZap(s);
    const hasNext = zaps || (on && s.queue.length > 1 && !!nextInQueue());
    const hasPrev = zaps || (on && s.queue.length > 1 && !!prevInQueue());
    const title = on ? s.source!.title : '';
    const artist = on ? (s.source!.subtitle ?? '') : '';
    const state: MediaSessionPlaybackState = !on ? 'none' : running(s) ? 'playing' : s.status === 'paused' ? 'paused' : 'none';
    // Position updates come several times a second: touch the session only when this changes.
    const key = [on, hasNext, hasPrev, title, artist, state].join('|');
    if (key === shown) return;
    shown = key;
    session.playbackState = state;
    if (!on) {
      session.metadata = null;
      for (const a of ACTIONS) handle(a, null);
      return;
    }
    if (typeof MediaMetadata !== 'undefined') session.metadata = new MediaMetadata({ title, artist });
    handle('play', () => {
      if (!running(usePlayerStore.getState())) buttons().togglePlay();
    });
    handle('pause', () => {
      if (running(usePlayerStore.getState())) buttons().togglePlay();
    });
    handle('stop', () => buttons().stop());
    handle('nexttrack', hasNext ? () => buttons().next() : null);
    handle('previoustrack', hasPrev ? () => buttons().previous() : null);
  };
  sync(usePlayerStore.getState());
  const unsub = usePlayerStore.subscribe(sync);
  return () => {
    unsub();
    shown = '';
    session.metadata = null;
    session.playbackState = 'none';
    for (const a of ACTIONS) handle(a, null);
  };
}
