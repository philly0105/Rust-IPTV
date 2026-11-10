/**
 * Home's first screen first. A cold Home's first commit drew every card of every rail, about 90
 * cards and 2,000 elements, although a 1440 x 900 window shows a dozen of them: the cards past a
 * rail's right edge only waited there for a scroll. Until Home has painted once, each rail draws
 * the cards that fit across the window and one more (`firstScreenCards`); the others mount right
 * after that frame, in one low-priority (transition) render, so input still comes first. A key or
 * a press anywhere mounts them at once, and `settleFirstScreen` lets a rail's own key handler do
 * it synchronously (End, or ArrowRight on the last card drawn, must find the whole row).
 *
 * Once per page load: a later visit to Home in the same session draws every card in its first
 * commit, as before (the scroll and focus memory of Back may need a card past the edge).
 *
 * Unit tests run without it (`import.meta.env.MODE === 'test'`), so the many tests that count a
 * rail's cards see the whole row at once; `setFirstScreenDeferral` turns it on for the tests of
 * this module and the rail.
 */

import { createContext, startTransition, useEffect, useState } from 'react';

let settled = import.meta.env.MODE === 'test';
const listeners = new Set<() => void>();
let scheduled = false;
let detach: (() => void) | null = null;

const INTENTS = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const;

/**
 * Mounts every deferred card. `sync`: in the caller's update (inside `flushSync`, a key handler),
 * not a transition; also when a press has already started that transition, which it then overtakes.
 */
export function settleFirstScreen(sync = false): void {
  if (settled && !sync) return;
  settled = true;
  detach?.();
  detach = null;
  const notify = () => {
    for (const l of listeners) l();
  };
  if (sync) notify();
  else startTransition(notify);
}

/** After the frame the current commit paints: a rAF runs before that frame, a task posted from it after. */
function afterNextPaint(fn: () => void): void {
  if (typeof requestAnimationFrame !== 'function' || typeof MessageChannel !== 'function') {
    setTimeout(fn, 0);
    return;
  }
  requestAnimationFrame(() => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => fn();
    ch.port2.postMessage(null);
  });
  // A hidden page paints no frame (and runs no rAF): a timer stands in.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') setTimeout(fn, 100);
}

function schedule(): void {
  if (scheduled || settled) return;
  scheduled = true;
  const onIntent = () => settleFirstScreen();
  for (const type of INTENTS) window.addEventListener(type, onIntent, { capture: true, passive: true });
  detach = () => {
    for (const type of INTENTS) window.removeEventListener(type, onIntent, true);
  };
  afterNextPaint(() => settleFirstScreen());
}

/**
 * False while Home's first screen is still on its way: the caller draws only what the window
 * shows. The first reader that draws something (`drawing`: a rail with cards, not one still on its
 * skeleton) schedules the rest for the frame after its commit paints.
 */
export function useFirstScreenSettled(drawing: boolean): boolean {
  const [done, setDone] = useState(settled);
  useEffect(() => {
    if (done || !drawing) return;
    // Settled between this render and its effect (another rail's key handler, a press).
    if (settled) {
      setDone(true);
      return;
    }
    const on = () => setDone(true);
    listeners.add(on);
    schedule();
    return () => {
      listeners.delete(on);
    };
  }, [done, drawing]);
  // A reader that first draws after the rest has mounted draws everything at once.
  return done || settled;
}

/**
 * How many cards of `width` px a rail draws before Home has painted: as many as fit across the
 * window (the track is never wider) plus one, which the rail's gap and the next card's peek need.
 */
export function firstScreenCards(width: number, windowWidth: number = typeof window === 'undefined' ? 0 : window.innerWidth): number {
  if (!(width > 0) || !(windowWidth > 0)) return Number.POSITIVE_INFINITY;
  return Math.ceil(windowWidth / width) + 1;
}

/**
 * True for a rail Home lays out below the window's foot: until Home has painted once it draws its
 * loading skeleton (as tall as its cards, so nothing moves when they come), and its cards mount
 * with the rest (DashboardRail). Home provides it per section (`sectionsBelowFold`).
 */
export const RailDeferContext = /* @__PURE__ */ createContext(false);

/** One of Home's sections in page order, with the least height it can have (0 when it draws nothing). */
export interface FoldSection {
  key: string;
  height: number;
}

/**
 * The sections whose top lies below `fold` even at the least height of everything above them:
 * `start` for what comes before the first section (the hero), `gap` between two sections that
 * draw something. Lower bounds only, so a section on screen is never taken for one below it; a
 * section near the fold may be drawn at once that could have waited.
 */
export function sectionsBelowFold(sections: readonly FoldSection[], start: number, gap: number, fold: number): Set<string> {
  const below = new Set<string>();
  let top = start;
  for (const s of sections) {
    if (top > fold) below.add(s.key);
    if (s.height > 0) top += s.height + gap;
  }
  return below;
}

/**
 * The least height of a Home rail with cards `width` px wide at `aspect` (width / height): the
 * artwork plus what every rail has around it at the smallest density (the heading row, the
 * track's padding and two caption lines), rounded down.
 */
export function railLeastHeight(width: number, aspect: number): number {
  return Math.floor(width / aspect) + 80;
}

/** Tests: turn the deferral on or off, and start a fresh page load. */
export function setFirstScreenDeferral(on: boolean): void {
  detach?.();
  detach = null;
  settled = !on;
  scheduled = false;
  listeners.clear();
}
