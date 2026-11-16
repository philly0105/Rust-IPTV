/** Where the dock should portal the player: the most recently mounted <PlayerStage />. */

import { useSyncExternalStore } from 'react';

import type { PlayerSource } from '@/api/types';
import { archivePath } from '@/features/live/lib/archive';

import { usePlayerStore, type ZapContext } from './store';

const targets: HTMLElement[] = [];
const listeners = new Set<() => void>();
/** The page that last showed the player in a stage, and the stream it showed there. */
let lastStage: { path: string; url: string } | null = null;
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

/** What a stage offers once its item has finished, beside Replay (a detail page: back to its hero). */
export interface StageEndedAction {
  label: string;
  onClick(): void;
}

const endedActions = new WeakMap<HTMLElement, StageEndedAction>();

/** Set before the stage is pushed, so the dock's first render there already finds it. */
export function setStageEndedAction(el: HTMLElement, action: StageEndedAction | undefined): void {
  if (action) endedActions.set(el, action);
  else endedActions.delete(el);
}

/** The ended action of the stage the player is in, if it has one. */
export function useStageEndedAction(): StageEndedAction | undefined {
  const target = useStageTarget();
  const inStage = usePlayerStore((s) => s.dock === 'stage');
  return inStage && target ? endedActions.get(target) : undefined;
}

/**
 * The dock showed `url` in a stage: the player moved into one, or a new stream started in one. A
 * stream with no page of its own goes back to the first page that showed it on Expand, and only
 * that stream, since the next one has another URL. A stage it moved into later (the guide's
 * preview band, which shows whatever plays) does not take its place.
 */
export function noteStageShown(url: string): void {
  if (typeof window === 'undefined' || lastStage?.url === url) return;
  lastStage = { path: window.location.pathname + window.location.search, url };
}

/** The page that first showed `source` in a stage, if one did. */
function stagePathOf(source: PlayerSource): string | null {
  return lastStage?.url === source.url ? lastStage.path : null;
}

/**
 * Where the mini player's Expand goes: the playing item's own page, which shows it in its stage,
 * not whichever page showed a stage last (that was often another title's, or the guide's preview
 * band). A live channel or station opens its source's Live TV (or Radio) in the group or Recently
 * watched view it was played from, so its row is marked and the ribbon describes it (LG-05); a
 * list play opens the list, a favorites play the source's Favorites view. A movie or an episode
 * (a download too, by its catalog ref) opens its detail page, catch-up its channel's archive. A
 * stream with no ref (a recording file) goes back to the page that first showed it in a stage, if
 * one did; otherwise null, and Expand goes fullscreen.
 */
export function expandPath(source: PlayerSource | undefined, ctx: ZapContext | undefined): string | null {
  if (!source) return null;
  const ref = source.ref;
  if (!ref) return stagePathOf(source);
  const base = `/s/${encodeURIComponent(ref.sourceId)}`;
  if (ref.contentType === 'movie' || ref.contentType === 'series') return `${base}/${ref.contentType}/${encodeURIComponent(ref.itemId)}`;
  // Catch-up plays its channel's ref as a recording.
  if (!source.isLive) return ref.contentType === 'live' ? archivePath(ref) : stagePathOf(source);
  if (ctx?.listId) return `/lists/${encodeURIComponent(ctx.listId)}`;
  // The context's group belongs to its own source: a channel of another source opens its source's top.
  const own = ctx?.sourceId === ref.sourceId;
  const group = ctx?.favorites ? '@favorites' : own && ctx.view === 'recent' ? '@recent' : own ? ctx.categoryId : undefined;
  if (ref.contentType === 'radio') return `${base}/radio${group ? `?category=${encodeURIComponent(group)}` : ''}`;
  return `${base}/live${group ? `/${encodeURIComponent(group)}` : ''}`;
}
