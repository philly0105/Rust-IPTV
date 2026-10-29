/**
 * Window picture-in-picture for the embedded mpv player. The native video window cannot
 * use the browser's PiP, so the whole app window becomes a small borderless always-on-top
 * player instead (`enterPipWindow`), and the dock puts the player host in a full-window
 * layer while it lasts.
 *
 * Requests are serialized: pressing the button again while the window is still changing
 * queues the latest wish (on or off) instead of being dropped, and the window ends up in
 * whatever state was asked for last.
 */

import i18next from 'i18next';
import { create } from 'zustand';

import { enterPipWindow, exitPipWindow, PIP_DEFAULT_ASPECT, recoverPipWindow, setPipWindowAspect } from '@/api/window';
import { shortcutRegistry } from '@/shell/shortcuts';
import { usePlayerStore } from './store';

export const usePipStore = create<{ active: boolean }>(() => ({ active: false }));

/** The latest state asked for while a change is running, or null when idle. */
let target: boolean | null = null;
let running: Promise<void> | null = null;
/** The player was fullscreen when PiP started; leaving PiP goes back to fullscreen. */
let wasFullscreen = false;
let wasWindowFilled = false;
let releaseEscape: (() => void) | null = null;

/** Reads the playing video's aspect (width / height); set by the surface that owns the video. */
type AspectSource = () => Promise<number | undefined>;
let aspectSource: AspectSource | null = null;
/** The aspect the PiP window is shaped and locked to while PiP lasts. */
let lockedAspect = PIP_DEFAULT_ASPECT;
/** Aspects closer than this count as the same shape (rounding in mpv's `dw`/`dh`). */
const SAME_ASPECT = 0.01;

/**
 * Lets the mounted video surface tell PiP the video's shape, so the window matches it.
 * Returns an unregister function (a newer surface's registration is left alone).
 */
export function setPipAspectSource(source: AspectSource): () => void {
  aspectSource = source;
  return () => {
    if (aspectSource === source) aspectSource = null;
  };
}

/**
 * The display aspect from mpv's `video-params` (`dw`/`dh`, already corrected for the pixel
 * aspect), swapped for a 90/270 degree rotation, clamped to 1:4..4:1 (a very wide or tall
 * video gets the nearest usable PiP shape). Undefined when unknown, so PiP falls back to 16:9.
 */
export function aspectFromVideoParams(params: unknown): number | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const p: { dw?: unknown; dh?: unknown; rotate?: unknown } = params;
  const { dw, dh } = p;
  if (typeof dw !== 'number' || typeof dh !== 'number' || !(dw > 0) || !(dh > 0)) return undefined;
  const turned = typeof p.rotate === 'number' && p.rotate % 180 === 90;
  const aspect = turned ? dh / dw : dw / dh;
  return Number.isFinite(aspect) ? Math.min(4, Math.max(0.25, aspect)) : undefined;
}

async function videoAspect(): Promise<number | undefined> {
  try {
    return (await aspectSource?.()) ?? undefined;
  } catch {
    return undefined;
  }
}

async function turnOn(): Promise<void> {
  const player = usePlayerStore.getState();
  wasFullscreen = player.isFullscreen || document.fullscreenElement != null;
  wasWindowFilled = player.isWindowFilled;
  if (player.isFullscreen) player.toggleFullscreen();
  if (player.isWindowFilled) player.toggleWindowFill();
  const aspect = aspectSource ? await videoAspect() : undefined;
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  if (!(await enterPipWindow(aspect))) {
    // Nothing changed after all: put the player back in fullscreen if it was.
    const now = usePlayerStore.getState();
    if (player.isFullscreen && now.source && !now.isFullscreen) now.toggleFullscreen();
    if (wasWindowFilled && now.source && !now.isWindowFilled) now.toggleWindowFill();
    wasFullscreen = false;
    wasWindowFilled = false;
    return;
  }
  lockedAspect = aspect ?? PIP_DEFAULT_ASPECT;
  usePipStore.setState({ active: true });
  // Newest registration wins, so this beats the shell's Escape (which only blurs) while
  // PiP lasts. Menus and dialogs inside the PiP player claim Escape before it gets here.
  releaseEscape?.();
  releaseEscape = shortcutRegistry.register('escape', () => void exitPip(), {
    description: i18next.t('player:exitPip'),
    area: 'Playback',
    allowInInput: true,
  });
}

async function turnOff(): Promise<void> {
  releaseEscape?.();
  releaseEscape = null;
  usePipStore.setState({ active: false });
  await exitPipWindow();
  const backToFullscreen = wasFullscreen;
  const backToWindowFill = wasWindowFilled;
  wasFullscreen = false;
  wasWindowFilled = false;
  // Only when something is still playing: the PiP close button stops playback first.
  const player = usePlayerStore.getState();
  if (backToFullscreen && player.source && !player.isFullscreen) player.toggleFullscreen();
  if (backToWindowFill && player.source && !player.isWindowFilled) player.toggleWindowFill();
}

async function drain(): Promise<void> {
  try {
    while (target !== null && target !== usePipStore.getState().active) {
      const on = target;
      await (on ? turnOn() : turnOff());
      // The window could not change; asking again would only fail again.
      if (on && !usePipStore.getState().active) break;
    }
  } finally {
    // Cleared here, in the same tick the loop ends, so a request arriving after the last
    // check always starts a new drain instead of joining one that is already done.
    target = null;
    running = null;
  }
}

function request(on: boolean): Promise<void> {
  if (running) {
    target = on;
    return running;
  }
  if (on === usePipStore.getState().active) return Promise.resolve();
  target = on;
  // turnOn/turnOff always await, so drain's `finally` runs after this assignment.
  running = drain();
  return running;
}

export function enterPip(): Promise<void> {
  return request(true);
}

export function exitPip(): Promise<void> {
  return request(false);
}

/** Flips the latest requested state, so a double press while the window changes cancels out. */
export function togglePip(): Promise<void> {
  return request(!(target ?? usePipStore.getState().active));
}

/**
 * While PiP lasts, follows the video's shape: the surface calls this when a new item's video
 * is up (a zap from a 16:9 channel to a 4:3 one), and the window is reshaped and re-locked
 * when the aspect changed. No-op outside PiP, while the window is changing, or when the
 * aspect is unknown.
 */
export async function refreshPipAspect(): Promise<void> {
  if (running || !usePipStore.getState().active || !aspectSource) return;
  const aspect = await videoAspect();
  if (aspect === undefined || running || !usePipStore.getState().active) return;
  if (Math.abs(aspect - lockedAspect) < SAME_ASPECT) return;
  if (await setPipWindowAspect(aspect)) lockedAspect = aspect;
}

/** For tests: forget queued requests and the Escape binding. */
export function __resetPipForTests(): void {
  target = null;
  running = null;
  wasFullscreen = false;
  wasWindowFilled = false;
  releaseEscape?.();
  releaseEscape = null;
  aspectSource = null;
  lockedAspect = PIP_DEFAULT_ASPECT;
  usePipStore.setState({ active: false });
}

// A webview reload while in PiP leaves the OS window small and borderless; put it back.
void recoverPipWindow().catch(() => undefined);
