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

import { enterPipWindow, exitPipWindow, recoverPipWindow } from '@/api/window';
import { shortcutRegistry } from '@/shell/shortcuts';
import { usePlayerStore } from './store';

export const usePipStore = create<{ active: boolean }>(() => ({ active: false }));

/** The latest state asked for while a change is running, or null when idle. */
let target: boolean | null = null;
let running: Promise<void> | null = null;
/** The player was fullscreen when PiP started; leaving PiP goes back to fullscreen. */
let wasFullscreen = false;
let releaseEscape: (() => void) | null = null;

async function turnOn(): Promise<void> {
  const player = usePlayerStore.getState();
  wasFullscreen = player.isFullscreen || document.fullscreenElement != null;
  if (player.isFullscreen) player.toggleFullscreen();
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  if (!(await enterPipWindow())) {
    // Nothing changed after all: put the player back in fullscreen if it was.
    const now = usePlayerStore.getState();
    if (player.isFullscreen && now.source && !now.isFullscreen) now.toggleFullscreen();
    wasFullscreen = false;
    return;
  }
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
  wasFullscreen = false;
  // Only when something is still playing: the PiP close button stops playback first.
  const player = usePlayerStore.getState();
  if (backToFullscreen && player.source && !player.isFullscreen) player.toggleFullscreen();
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

/** For tests: forget queued requests and the Escape binding. */
export function __resetPipForTests(): void {
  target = null;
  running = null;
  wasFullscreen = false;
  releaseEscape?.();
  releaseEscape = null;
  usePipStore.setState({ active: false });
}

// A webview reload while in PiP leaves the OS window small and borderless; put it back.
void recoverPipWindow().catch(() => undefined);
