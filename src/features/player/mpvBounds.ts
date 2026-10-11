/**
 * Where the embedded mpv child window may go.
 *
 * The native window paints above the webview, so no DOM chrome (control bar, notice strip,
 * option menus) may sit inside the rectangle sent to `mpv.attach` / `mpv.setBounds`.
 * The layout already reserves a strip below the surface; this module enforces it anyway:
 * the surface rect is clipped to every scroll/overflow ancestor and the viewport, then each
 * reserved rect that still overlaps is cut out. Pure functions, so it is unit tested.
 */

import type { Bounds } from '@/api/types';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Smallest window worth showing; anything thinner is hidden instead. */
export const MIN_MPV_SIZE = 2;

export function rectOf(r: { left: number; top: number; width: number; height: number }): Rect {
  return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
}

function area(r: Rect): number {
  return Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const r = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return r.right > r.left && r.bottom > r.top ? r : null;
}

/**
 * The largest axis-aligned piece of `base` that does not overlap `cut`.
 * A bar spanning the full width at the bottom trims the bottom; a popover in a corner
 * keeps whichever side of it leaves the most video.
 */
export function subtract(base: Rect, cut: Rect): Rect | null {
  if (!intersect(base, cut)) return base;
  const candidates: Rect[] = [
    { ...base, bottom: Math.min(base.bottom, cut.top) },
    { ...base, top: Math.max(base.top, cut.bottom) },
    { ...base, right: Math.min(base.right, cut.left) },
    { ...base, left: Math.max(base.left, cut.right) },
  ];
  let best: Rect | null = null;
  for (const c of candidates) {
    if (area(c) > 0 && (!best || area(c) > area(best))) best = c;
  }
  return best;
}

/**
 * Bounds for the native window, in CSS px, rounded inward so a fractional edge never
 * covers a pixel row of the controls. `null` means "nothing visible": hide the window.
 */
export function computeMpvBounds(surface: Rect, opts: { clip?: Rect[]; reserved?: Rect[] } = {}): Bounds | null {
  let r: Rect | null = surface;
  for (const c of opts.clip ?? []) {
    r = intersect(r, c);
    if (!r) return null;
  }
  for (const cut of opts.reserved ?? []) {
    r = subtract(r, cut);
    if (!r) return null;
  }
  const left = Math.ceil(r.left);
  const top = Math.ceil(r.top);
  const width = Math.floor(r.right) - left;
  const height = Math.floor(r.bottom) - top;
  if (width < MIN_MPV_SIZE || height < MIN_MPV_SIZE) return null;
  return { x: left, y: top, width, height };
}

/** True when no part of `b` overlaps any of the `reserved` rects. */
export function boundsClear(b: Bounds, reserved: Rect[]): boolean {
  const r = rectOf({ left: b.x, top: b.y, width: b.width, height: b.height });
  return reserved.every((x) => !intersect(r, x));
}

/** Elements the native window must never cover, inside the player host. */
export const RESERVED_SELECTOR = '[data-player-controls], [data-mpv-reserved], [role="menu"]';

/**
 * App-level chrome outside the player host that the native window must not cover either:
 * the toast stack (bottom-right, where the mini dock also sits) and anything tagged
 * `data-mpv-reserved-global`.
 */
export const GLOBAL_RESERVED_SELECTOR = '[data-toast-viewport] [data-toast-id], [data-mpv-reserved-global]';

/**
 * Measure the live DOM: the surface, every clipping ancestor up to the viewport, the
 * reserved chrome inside the player host, and app-level overlays (toasts) anywhere in the
 * document. Kept separate from the math so tests can stub rects.
 */
export function measureMpvBounds(surface: Element): Bounds | null {
  const clip: Rect[] = [{ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }];
  for (let el = surface.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') clip.push(rectOf(el.getBoundingClientRect()));
  }
  const host = surface.closest('[data-player-host]') ?? surface.parentElement ?? document.body;
  const reserved: Rect[] = [];
  const nodes = [...Array.from(host.querySelectorAll(RESERVED_SELECTOR)), ...Array.from(document.querySelectorAll(GLOBAL_RESERVED_SELECTOR))];
  for (const node of nodes) {
    if (node === surface || surface.contains(node)) continue;
    const b = node.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) reserved.push(rectOf(b));
  }
  return computeMpvBounds(rectOf(surface.getBoundingClientRect()), { clip, reserved });
}
