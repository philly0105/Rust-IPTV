/**
 * Intent prefetch for links to pages: the rail's links, a source's links, the phone tab bar and
 * Live's group links. When the pointer rests on one for ROUTE_REST_MS, or it keeps focus that
 * long, the page's route chunk starts loading and so does its first data (`prefetchScreenData`,
 * under the keys the page reads), so the click lands on a page whose code and rows are on their
 * way or in. Links that scroll under a still pointer (Live's group list) are not intent: a scroll
 * or wheel cancels the pending rests, and only real pointer movement starts new ones, as for the
 * VOD posters (`src/features/vod/hooks/prefetch.ts`). Data Saver and touch screens skip it.
 *
 * Unlike a poster's detail, a page's data goes stale, so a link is not remembered: a second rest
 * asks again, and the query cache answers it while the data is fresh.
 */

import { useEffect, useMemo, useRef } from 'react';

import { prefetchScreenData } from '@/api/bootPrefetch';

/** How long the pointer (or focus) has to rest on a link before it counts as intent. */
export const ROUTE_REST_MS = 120;

/**
 * Loads a path's route chunks. Set by the route table (`src/routes.tsx`), which imports the shell:
 * the shell cannot import it back.
 */
let warmRoute: (path: string) => void = () => undefined;

export function setRouteWarmer(fn: (path: string) => void): void {
  warmRoute = fn;
}

/** False when the user asked to save data, or when the primary pointer is touch (hover means nothing there). */
function allowed(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return false;
  return !(typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
}

/** The page at `path`: its route chunks and its first data. */
export function prefetchRoute(path: string): void {
  if (!allowed()) return;
  warmRoute(path);
  prefetchScreenData(path);
}

interface Rest {
  to: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  kind: 'pointer' | 'focus' | undefined;
  /** For a focus rest: the link that took focus, which must still hold it when the rest ends. */
  focused: Element | null;
}

/** Pointer rests counting down; a scroll or wheel cancels them (the link moved, not the pointer). */
const pointerRests = new Set<Rest>();
/** Links under a pointer that has not moved since the content scrolled: they wait for real movement. */
const parked = new Set<Rest>();
/** The pending focus rest. Only one link has focus, so a new one replaces it. */
let focusRest: Rest | null = null;
/** From a scroll or wheel until the pointer really moves. */
let pointerStill = false;
let lastPointer: { x: number; y: number } | null = null;
let listening = false;

function cancel(r: Rest): void {
  if (r.timer !== undefined) clearTimeout(r.timer);
  r.timer = undefined;
  r.kind = undefined;
  r.focused = null;
  pointerRests.delete(r);
  if (focusRest === r) focusRest = null;
}

function start(r: Rest, kind: 'pointer' | 'focus', focused: Element | null = null): void {
  cancel(r);
  if (kind === 'pointer') pointerRests.add(r);
  else {
    if (focusRest) cancel(focusRest);
    focusRest = r;
    r.focused = focused;
  }
  r.kind = kind;
  r.timer = setTimeout(() => {
    const el = r.kind === 'focus' ? r.focused : null;
    const stillFocused = !el || el.contains(document.activeElement);
    cancel(r);
    if (stillFocused) prefetchRoute(r.to);
  }, ROUTE_REST_MS);
}

function onPointerMove(e: PointerEvent): void {
  const { clientX: x, clientY: y } = e;
  if (typeof x === 'number' && typeof y === 'number') {
    // The same spot again: a move synthesised after the content scrolled, not the user's hand.
    if (lastPointer && lastPointer.x === x && lastPointer.y === y) return;
    lastPointer = { x, y };
  }
  pointerStill = false;
  const waiting = [...parked];
  parked.clear();
  for (const r of waiting) start(r, 'pointer');
}

function onContentScroll(): void {
  pointerStill = true;
  for (const r of [...pointerRests]) {
    cancel(r);
    parked.add(r);
  }
}

function listen(): void {
  if (listening) return;
  listening = true;
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  window.addEventListener('pointermove', onPointerMove, opts);
  window.addEventListener('wheel', onContentScroll, opts);
  window.addEventListener('scroll', onContentScroll, opts);
}

/** Forgets every pending rest and the pointer's state. For tests. */
export function resetRouteIntentForTests(): void {
  for (const r of [...pointerRests]) cancel(r);
  if (focusRest) cancel(focusRest);
  parked.clear();
  pointerStill = false;
  lastPointer = null;
}

/** Handlers to spread onto a link to `to`. */
export interface RouteIntent {
  onPointerEnter(e: { pointerType?: string }): void;
  onPointerLeave(): void;
  onFocus(e: { currentTarget: EventTarget | null }): void;
  onBlur(): void;
}

/** Stable intent handlers for a link to `to` (path and query). */
export function useRouteIntent(to: string): RouteIntent {
  const rest = useRef<Rest>({ to, timer: undefined, kind: undefined, focused: null });
  rest.current.to = to;
  useEffect(() => {
    listen();
    const r = rest.current;
    return () => {
      cancel(r);
      parked.delete(r);
    };
  }, []);
  return useMemo(() => {
    const r = rest.current;
    return {
      onPointerEnter(e) {
        if (e.pointerType === 'touch') return;
        if (pointerStill) {
          // The link scrolled under a pointer that has not moved: not intent until the pointer moves.
          parked.add(r);
          return;
        }
        start(r, 'pointer');
      },
      onPointerLeave() {
        parked.delete(r);
        if (r.kind === 'pointer') cancel(r);
      },
      onFocus(e) {
        // A held arrow key passing through a list warms only the link where it stops.
        start(r, 'focus', e.currentTarget instanceof Element ? e.currentTarget : null);
      },
      onBlur() {
        if (r.kind === 'focus') cancel(r);
      },
    };
  }, []);
}
