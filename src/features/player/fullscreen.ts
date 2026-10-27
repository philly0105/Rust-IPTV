/**
 * Fullscreen where the player host cannot go fullscreen itself (PL-IOS-FULLSCREEN). iPhone
 * Safari has no `Element.requestFullscreen`: the host's request did nothing, the store still said
 * fullscreen, the button turned to "Exit fullscreen" and the phone's mini player burst into the
 * full bar. There, the `<video>` goes fullscreen in the system player (`webkitEnterFullscreen`)
 * and the store's flag stays off; where neither works, the button is not offered.
 */

import { PHONE_QUERY } from '@/shell/navigation';

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

/** `ScreenOrientation.lock` is missing from some DOM typings and from most engines. */
type LockableOrientation = ScreenOrientation & { lock?: (orientation: 'landscape') => Promise<void>; unlock?: () => void };

function screenOrientation(): LockableOrientation | null {
  return typeof screen === 'undefined' ? null : ((screen.orientation as LockableOrientation | undefined) ?? null);
}

/** A phone, or a tablet held in the hand: the screens that turn and that fullscreen fills. */
function handheld(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia(PHONE_QUERY).matches || matchMedia('(pointer: coarse)').matches;
}

/** This player asked for landscape, so leaving fullscreen hands the turn back. */
let locked = false;

/** The picture is taller than wide (a portrait clip), which landscape would shrink. */
function portraitPicture(): boolean {
  const v = playerVideo();
  return !!v && v.videoWidth > 0 && v.videoHeight > v.videoWidth;
}

/**
 * Fullscreen video on a phone held upright would fill a quarter of the screen, so once the host is
 * fullscreen the screen turns to landscape, as a phone's own video player does. Radio has no
 * picture to fill and keeps the screen as held. Engines that refuse (iOS Safari, desktop browsers,
 * a webview without the permission) reject the lock, and nothing changes.
 */
export function lockLandscapeForVideo(mode: string): void {
  if (mode === 'radio' || !handheld() || portraitPicture()) return;
  const lock = screenOrientation()?.lock;
  if (typeof lock !== 'function') return;
  try {
    void lock.call(screenOrientation(), 'landscape').then(
      () => {
        locked = true;
      },
      () => undefined,
    );
  } catch {
    // Some engines throw instead of rejecting.
  }
}

/** Lets the screen turn freely again once fullscreen ends. */
export function unlockOrientation(): void {
  if (!locked) return;
  locked = false;
  try {
    screenOrientation()?.unlock?.();
  } catch {
    // An engine that lost the lock with fullscreen may throw here.
  }
}
