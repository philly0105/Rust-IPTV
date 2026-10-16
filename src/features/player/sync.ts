/**
 * Audio and subtitle delay for the current stream (the "Sync" menu and the G/H keys).
 *
 * Values are in milliseconds; positive means later (the sound or the text comes after the
 * picture). Both reset to zero whenever a new stream starts. Embedded mpv applies them as its
 * `audio-delay` / `sub-delay` properties (`mpvExtras.ts`); the built-in engines shift text
 * track cues (`textDelay.ts`) and cannot delay audio.
 */

import { create } from 'zustand';

import { itemKey, type PlayerSource } from '@/api/types';

import { usePlayerStore } from './store';

/** One press of a delay key or a menu step. */
export const DELAY_STEP_MS = 100;
/** Largest delay either way. */
export const DELAY_LIMIT_MS = 10_000;

export type DelayKind = 'audio' | 'sub';

export interface SyncState {
  audioMs: number;
  subMs: number;
}

export const useSyncStore = create<SyncState>()(() => ({ audioMs: 0, subMs: 0 }));

/** `value` moved by `steps` steps, rounded to the step and kept within the limit. */
export function stepDelay(value: number, steps: number): number {
  const next = Math.round((value + steps * DELAY_STEP_MS) / DELAY_STEP_MS) * DELAY_STEP_MS;
  const clamped = Math.max(-DELAY_LIMIT_MS, Math.min(DELAY_LIMIT_MS, next));
  // No negative zero: it would print as "-0 ms".
  return clamped === 0 ? 0 : clamped;
}

/** "+300 ms", "-1,200 ms", "0 ms", in the UI language. */
export function formatDelay(ms: number, locale?: string): string {
  const value = ms === 0 ? 0 : ms;
  try {
    return new Intl.NumberFormat(locale, { style: 'unit', unit: 'millisecond', unitDisplay: 'short', signDisplay: 'exceptZero' }).format(value);
  } catch {
    return `${value > 0 ? '+' : ''}${value} ms`;
  }
}

/** Moves one delay by `steps` steps and returns the new value. */
export function adjustDelay(kind: DelayKind, steps: number): number {
  const key = kind === 'audio' ? 'audioMs' : 'subMs';
  const next = stepDelay(useSyncStore.getState()[key], steps);
  useSyncStore.setState({ [key]: next });
  return next;
}

export function resetDelay(kind: DelayKind): void {
  useSyncStore.setState(kind === 'audio' ? { audioMs: 0 } : { subMs: 0 });
}

/**
 * Identity of "one stream": a new item or episode (a failover copy is another item) starts with
 * no delay. Keyed by the item, not the URL: a reconnect may swap in a freshly resolved Stalker
 * link for the same item. Sources without a ref fall back to the URL.
 */
export function streamKey(s: Pick<PlayerSource, 'url' | 'ref' | 'episodeId'> | undefined): string {
  if (!s) return '';
  return `${s.ref ? itemKey(s.ref) : `url|${s.url}`}|${s.episodeId ?? ''}`;
}

let lastKey = streamKey(usePlayerStore.getState().source);
usePlayerStore.subscribe((s) => {
  const key = streamKey(s.source);
  if (key === lastKey) return;
  lastKey = key;
  const { audioMs, subMs } = useSyncStore.getState();
  if (audioMs !== 0 || subMs !== 0) useSyncStore.setState({ audioMs: 0, subMs: 0 });
});
