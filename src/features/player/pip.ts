/**
 * Window picture-in-picture for the embedded mpv player. The native video window cannot
 * use the browser's PiP, so the whole app window becomes a small borderless always-on-top
 * player instead (`enterPipWindow`), and the dock puts the player host in a full-window
 * layer while it lasts.
 */

import { create } from 'zustand';

import { enterPipWindow, exitPipWindow } from '@/api/window';
import { usePlayerStore } from './store';

export const usePipStore = create<{ active: boolean }>(() => ({ active: false }));

let busy = false;

export async function enterPip(): Promise<void> {
  if (busy || usePipStore.getState().active) return;
  busy = true;
  try {
    if (usePlayerStore.getState().isFullscreen) usePlayerStore.getState().toggleFullscreen();
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    if (await enterPipWindow()) usePipStore.setState({ active: true });
  } finally {
    busy = false;
  }
}

export async function exitPip(): Promise<void> {
  if (busy || !usePipStore.getState().active) return;
  busy = true;
  try {
    usePipStore.setState({ active: false });
    await exitPipWindow();
  } finally {
    busy = false;
  }
}

export function togglePip(): Promise<void> {
  return usePipStore.getState().active ? exitPip() : enterPip();
}
