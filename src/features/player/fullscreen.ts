/**
 * Fullscreen where the player host cannot go fullscreen itself (PL-IOS-FULLSCREEN). iPhone
 * Safari has no `Element.requestFullscreen`: the host's request did nothing, the store still said
 * fullscreen, the button turned to "Exit fullscreen" and the phone's mini player burst into the
 * full bar. There, the `<video>` goes fullscreen in the system player (`webkitEnterFullscreen`)
 * and the store's flag stays off; where neither works, the button is not offered.
 */

type IosVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitSupportsFullscreen?: boolean };

/** The player's video element, when one is mounted. */
function playerVideo(): IosVideo | null {
  return typeof document === 'undefined' ? null : document.querySelector<IosVideo>('video[data-player-video]');
}

/** True when an element can be asked to go fullscreen in this browser. */
export function elementFullscreen(): boolean {
  return typeof document !== 'undefined' && typeof document.documentElement.requestFullscreen === 'function' && document.fullscreenEnabled !== false;
}

/** True when the video can only go fullscreen in the system player (iPhone). */
function videoOnlyFullscreen(): boolean {
  return !elementFullscreen() && typeof playerVideo()?.webkitEnterFullscreen === 'function';
}

/**
 * Whether to offer a fullscreen control. False only when the browser says outright that it has
 * no fullscreen (`document.fullscreenEnabled === false`) and the video has no system fullscreen
 * either; an engine that says nothing (jsdom, old ones) keeps the control.
 */
export function canEnterFullscreen(): boolean {
  if (typeof document === 'undefined') return true;
  if (elementFullscreen() || videoOnlyFullscreen()) return true;
  return document.fullscreenEnabled !== false;
}

/**
 * Enters fullscreen the iPhone way when that is the only way: the system player takes the video.
 * True when it handled the request (the store's flag must stay off), false when the host's own
 * fullscreen should be used.
 */
export function enterVideoFullscreen(): boolean {
  if (!videoOnlyFullscreen()) return false;
  try {
    playerVideo()?.webkitEnterFullscreen?.();
  } catch {
    // Refused (no user gesture): nothing changes.
  }
  return true;
}
