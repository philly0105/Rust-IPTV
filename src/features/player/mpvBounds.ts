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

/**
 * Chrome inside the player host that the native window must never cover. Docked, the window
 * shrinks around it; in fullscreen it is cut out. Menus are not chrome but overlays: one that
 * opens over the docked video (the playback options, the track and sleep views) is cut out as
 * a hole, so the picture keeps its size instead of shrinking while the menu is open.
 */
export const RESERVED_SELECTOR = '[data-player-controls], [data-mpv-reserved]';

/** The player's own popovers over the video: always holes, even inside reserved chrome. */
export const PLAYER_OVERLAY_SELECTOR = '[data-mpv-overlay]';

/**
 * App-level chrome outside the player host that the native window must not cover either:
 * the toast stack (bottom-right, where the mini dock also sits) and anything tagged
 * `data-mpv-reserved-global`.
 */
export const GLOBAL_RESERVED_SELECTOR = '[data-toast-viewport] [data-toast-id], [data-mpv-reserved-global]';

/**
 * Transient UI that floats over the video, anywhere in the document: the player's own popovers
 * (`data-mpv-overlay`: the video's context menu, the zap banner, stream info), every menu and
 * tooltip (most are portalled to the body), and dialogs (the command palette, the tour card).
 * They are cut out of the native window as holes, so the video keeps its size and place,
 * inside the player host too.
 */
export const OVERLAY_SELECTOR = `${PLAYER_OVERLAY_SELECTOR}, [role="menu"], [role="tooltip"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]`;

/** Modal dialogs: when they cover most of the video it is hidden instead of shown in slivers. */
export const MODAL_SELECTOR = '[aria-modal="true"], dialog[open]';

/** Share of the visible video a modal dialog may cover before the video is hidden. */
export const MODAL_HIDE_SHARE = 0.5;

/**
 * Full-window backdrops: a modal dialog's scrim (the command palette's), a drawer's or a sheet's.
 * The native video sits above the DOM, so a scrim cannot darken it; mpv dims itself to match
 * instead (`measureScrim`, `dimOverlayCommand`). Layers mark themselves with `data-scrim`; the
 * class match stays for a backdrop that does not carry the attribute yet.
 */
export const SCRIM_SELECTOR = '[data-scrim], .fixed.inset-0.bg-scrim';

/**
 * Anything whose arrival or removal can change the layout: the mutation filter in MpvSurface
 * re-measures only for these (simple selectors: they are matched against detached nodes too).
 */
export const LAYOUT_WATCH_SELECTOR = `${OVERLAY_SELECTOR}, ${RESERVED_SELECTOR}, ${SCRIM_SELECTOR}, [aria-modal], [data-toast-id], [data-mpv-reserved-global], [data-pip-layer]`;

/** A scrim colour: 0-255 channels and 0-1 alpha. */
export interface Dim {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `rgb()`/`rgba()` as computed styles report it (comma or space syntax), or null. */
export function parseRgb(css: string): Dim | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(css.trim());
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Math.min(1, Math.max(0, alpha)) };
}

/**
 * The colour of the scrim over the video, or null when none is up. In fullscreen or PiP only a
 * scrim inside that layer is seen. With several, the last (topmost) wins.
 */
export function measureScrim(surface: Element): Dim | null {
  const layer = topLayer();
  let dim: Dim | null = null;
  for (const node of Array.from(document.querySelectorAll(SCRIM_SELECTOR))) {
    if (node.contains(surface) || (layer && !layer.contains(node))) continue;
    const b = node.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) continue;
    const c = parseRgb(getComputedStyle(node).backgroundColor);
    if (c && c.a > 0) dim = c;
  }
  return dim;
}

/** The mpv OSD overlay id the dim uses (mpv allows 0-63; the core accepts only `osd-overlay` this narrow). */
export const DIM_OVERLAY_ID = 63;

/**
 * The `mpv.command` that dims the video like `dim` (an ASS rectangle over the whole window,
 * letterbox included), or removes the dim when null.
 */
export function dimOverlayCommand(dim: Dim | null): (string | number)[] {
  if (!dim) return ['osd-overlay', DIM_OVERLAY_ID, 'none', ''];
  const hex = (n: number): string =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  // ASS colours are &HBBGGRR&, and its alpha counts transparency (00 is opaque).
  const color = `&H${hex(dim.b)}${hex(dim.g)}${hex(dim.r)}&`;
  const alpha = `&H${hex(255 * (1 - dim.a))}&`;
  const rect = 'm -10 -10 l 10000 -10 10000 10000 -10 10000';
  return ['osd-overlay', DIM_OVERLAY_ID, 'ass-events', `{\\an7\\pos(0,0)\\bord0\\shad0\\1c${color}\\1a${alpha}\\p1}${rect}{\\p0}`, 0, 720, 0];
}

/**
 * Measure the live DOM: the surface, every clipping ancestor up to the viewport, the
 * reserved chrome inside the player host, and app-level chrome (toasts) anywhere in the
 * document. Floating overlays are left out (they become holes, see `measureMpvLayout`).
 * Kept separate from the math so tests can stub rects.
 */
export function measureMpvBounds(surface: Element): Bounds | null {
  const { surfaceRect, clip, reserved } = measureParts(surface);
  return computeMpvBounds(surfaceRect, { clip, reserved });
}

/**
 * The window rectangle plus its holes. Docked, reserved chrome shrinks the video and floating
 * overlays (menus, tooltips, dialogs) are holes in what is left. In fullscreen and PiP the
 * video keeps the whole surface and all chrome over it is holes. A modal dialog that covers
 * most of the video hides it (`bounds: null`).
 */
export function measureMpvLayout(surface: Element): MpvLayout {
  const { surfaceRect, clip, reserved, overlays, modals } = measureParts(surface);
  const layer = topLayer();
  return computeMpvLayout(surfaceRect, { clip, reserved, overlays, modals, float: !!layer && layer.contains(surface) });
}

/**
 * The layer the player fills the screen or window from: the fullscreen element, or the
 * picture-in-picture layer (`data-pip-layer`) that covers the whole shrunken window.
 */
function topLayer(): Element | null {
  return document.fullscreenElement ?? document.querySelector('[data-pip-layer]:not([hidden])');
}

interface Parts {
  surfaceRect: Rect;
  clip: Rect[];
  reserved: Rect[];
  /** Floating overlays over the video (holes). */
  overlays: Rect[];
  /** The modal dialogs among `overlays`. */
  modals: Rect[];
}

function measureParts(surface: Element): Parts {
  const clip: Rect[] = [{ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }];
  const layer = topLayer();
  for (let el = surface.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') clip.push(rectOf(el.getBoundingClientRect()));
    // A fullscreen element sits in the top layer: the ancestors it left behind (the docked
    // stage, the page scroller) no longer clip it, so their rects would pin the video to the
    // old docked rectangle.
    if (el === layer) break;
  }
  /** The on-screen rect of chrome that may overlap the surface, or null when it cannot. */
  const visible = (node: Element): Rect | null => {
    // The surface's own content, or a container the player itself sits in.
    if (node === surface || surface.contains(node) || node.contains(surface)) return null;
    // In fullscreen only the top layer is visible: chrome left outside it (the docked page's
    // strips) is hidden underneath, and cutting it out would leave a black band where nothing
    // shows. Toasts, dialogs and menus portal into the fullscreen element (`ui/portal.ts`), so
    // they are inside it and cut out like any other overlay.
    if (layer && !layer.contains(node)) return null;
    const b = node.getBoundingClientRect();
    return b.width > 0 && b.height > 0 ? rectOf(b) : null;
  };
  const host = surface.closest('[data-player-host]') ?? surface.parentElement ?? document.body;
  /** The player's own popovers are holes; other host chrome (the control bar) is reserved. */
  const reservedInHost = (node: Element): boolean =>
    host.contains(node) && node.matches(RESERVED_SELECTOR) && !node.matches(PLAYER_OVERLAY_SELECTOR);
  const overlays: Rect[] = [];
  const modals: Rect[] = [];
  for (const node of Array.from(document.querySelectorAll(OVERLAY_SELECTOR))) {
    if (reservedInHost(node)) continue;
    const r = visible(node);
    // A menu is laid out hidden for one pass before it is placed.
    if (!r || getComputedStyle(node).visibility === 'hidden') continue;
    overlays.push(r);
    if (node.matches(MODAL_SELECTOR)) modals.push(r);
  }
  const reserved: Rect[] = [];
  for (const node of Array.from(host.querySelectorAll(RESERVED_SELECTOR))) {
    if (!reservedInHost(node)) continue;
    const r = visible(node);
    if (r) reserved.push(r);
  }
  for (const node of Array.from(document.querySelectorAll(GLOBAL_RESERVED_SELECTOR))) {
    const r = visible(node);
    if (r) reserved.push(r);
  }
  return { surfaceRect: rectOf(surface.getBoundingClientRect()), clip, reserved, overlays, modals };
}

/** Native window rectangle plus the rects cut out of it (relative to its top-left). */
export interface MpvLayout {
  bounds: Bounds | null;
  holes: Bounds[];
}

/** `cuts` that overlap `bounds`, relative to its top-left, rounded outward so no pixel row of the chrome is covered. */
function holesIn(bounds: Bounds, cuts: Rect[]): Bounds[] {
  const frame = rectOf({ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height });
  const holes: Bounds[] = [];
  for (const cut of cuts) {
    const r = intersect(frame, cut);
    if (!r) continue;
    const left = Math.floor(r.left);
    const top = Math.floor(r.top);
    holes.push({ x: left - bounds.x, y: top - bounds.y, width: Math.ceil(r.right) - left, height: Math.ceil(r.bottom) - top });
  }
  return holes;
}

/** True when the modal dialogs cover at least `MODAL_HIDE_SHARE` of the video. */
export function modalCovers(bounds: Bounds, modals: Rect[]): boolean {
  if (modals.length === 0) return false;
  const frame = rectOf({ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height });
  let covered = 0;
  for (const m of modals) {
    const r = intersect(frame, m);
    if (r) covered += area(r);
  }
  return covered >= MODAL_HIDE_SHARE * area(frame);
}

/**
 * The native window's layout from measured rects. Docked (`float` false), `reserved` chrome
 * shrinks the video and `overlays` are holes in what is left. Floating (fullscreen, PiP), the
 * video keeps the whole surface and every piece of chrome over it is a hole. Modal dialogs
 * that cover most of the video hide it.
 */
export function computeMpvLayout(
  surface: Rect,
  opts: { clip?: Rect[]; reserved?: Rect[]; overlays?: Rect[]; modals?: Rect[]; float?: boolean } = {},
): MpvLayout {
  const reserved = opts.reserved ?? [];
  const overlays = opts.overlays ?? [];
  const bounds = computeMpvBounds(surface, { clip: opts.clip ?? [], reserved: opts.float ? [] : reserved });
  if (!bounds || modalCovers(bounds, opts.modals ?? [])) return { bounds: null, holes: [] };
  return { bounds, holes: holesIn(bounds, opts.float ? [...reserved, ...overlays] : overlays) };
}

/**
 * Fullscreen overlay mode: the video keeps the whole surface and the chrome over it is
 * cut out of the native window as holes, so the controls show over the picture without
 * shrinking or moving it. Rects are rounded outward so no pixel row of the bar is covered.
 */
export function computeMpvOverlay(surface: Rect, opts: { clip?: Rect[]; reserved?: Rect[] } = {}): MpvLayout {
  return computeMpvLayout(surface, { ...opts, float: true });
}
