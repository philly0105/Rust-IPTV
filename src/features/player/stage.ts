/** Where the dock should portal the player: the most recently mounted <PlayerStage />. */

import { useSyncExternalStore } from 'react';

const targets: HTMLElement[] = [];
const listeners = new Set<() => void>();
let lastStagePath: string | null = null;
let rehome: ((removed: HTMLElement, next: HTMLElement | null) => void) | null = null;

/**
 * The dock registers a synchronous mover. A stage's layout cleanup runs before React
 * removes its DOM, so the player node is moved out first and the media element never
 * leaves the document (which would pause it).
 */
export function setRehome(fn: typeof rehome): void {
  rehome = fn;
}

function emit(): void {
  for (const l of listeners) l();
}

export function pushStageTarget(el: HTMLElement): () => void {
  targets.push(el);
  if (typeof window !== 'undefined') lastStagePath = window.location.pathname + window.location.search;
  emit();
  return () => {
    const i = targets.lastIndexOf(el);
    if (i >= 0) targets.splice(i, 1);
    rehome?.(el, current());
    emit();
  };
}

function current(): HTMLElement | null {
  return targets[targets.length - 1] ?? null;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStageTarget(): HTMLElement | null {
  return useSyncExternalStore(subscribe, current, () => null);
}

/** The route that last showed a stage; the mini player's expand button returns there. */
export function getLastStagePath(): string | null {
  return lastStagePath;
}
