/** Where the dock should portal the player: the most recently mounted <PlayerStage />. */

import { useSyncExternalStore } from 'react';

import type { PlayerSource } from '@/api/types';

import type { ZapContext } from './store';

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

/** The route that last showed a stage. */
export function getLastStagePath(): string | null {
  return lastStagePath;
}

/**
 * Where the mini player's Expand goes (LG-05): a live channel's or station's own page, so its row
 * is marked and the ribbon describes it, whichever page showed the stage last. A list play opens
 * the list, a favorites play the source's Favorites view, otherwise the source's Live TV (or
 * Radio) in the group or Recently watched view it was played from. Anything else (a movie, an
 * episode, catch-up, a stream without a ref) goes back to the page that last showed the stage.
 */
export function expandPath(source: PlayerSource | undefined, ctx: ZapContext | undefined): string | null {
  const ref = source?.ref;
  if (!source?.isLive || !ref || (ref.contentType !== 'live' && ref.contentType !== 'radio')) return lastStagePath;
  if (ctx?.listId) return `/lists/${encodeURIComponent(ctx.listId)}`;
  // The context's group belongs to its own source: a channel of another source opens its source's top.
  const own = ctx?.sourceId === ref.sourceId;
  const group = ctx?.favorites ? '@favorites' : own && ctx.view === 'recent' ? '@recent' : own ? ctx.categoryId : undefined;
  const base = `/s/${encodeURIComponent(ref.sourceId)}`;
  if (ref.contentType === 'radio') return `${base}/radio${group ? `?category=${encodeURIComponent(group)}` : ''}`;
  return `${base}/live${group ? `/${encodeURIComponent(group)}` : ''}`;
}
