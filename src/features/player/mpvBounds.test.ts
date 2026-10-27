import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  boundsClear,
  computeMpvBounds,
  computeMpvLayout,
  computeMpvOverlay,
  dimOverlayCommand,
  intersect,
  LAYOUT_WATCH_SELECTOR,
  measureMpvBounds,
  measureMpvLayout,
  measureScrim,
  modalCovers,
  parseRgb,
  rectOf,
  subtract,
  type Rect,
} from './mpvBounds';

const R = (left: number, top: number, width: number, height: number): Rect => rectOf({ left, top, width, height });

describe('computeMpvBounds', () => {
  it('passes a clean surface through unchanged', () => {
    expect(computeMpvBounds(R(100, 50, 640, 360))).toEqual({ x: 100, y: 50, width: 640, height: 360 });
  });

  it('cuts a full-width control bar that overlaps the bottom of the surface', () => {
    const surface = R(0, 0, 800, 500);
    const controls = R(0, 440, 800, 60);
    const b = computeMpvBounds(surface, { reserved: [controls] });
    expect(b).toEqual({ x: 0, y: 0, width: 800, height: 440 });
    expect(boundsClear(b!, [controls])).toBe(true);
  });

  it('cuts a bar above the surface (header strip) from the top', () => {
    const b = computeMpvBounds(R(0, 0, 800, 500), { reserved: [R(0, 0, 800, 40)] });
    expect(b).toEqual({ x: 0, y: 40, width: 800, height: 460 });
  });

  it('keeps the larger side next to a corner popover (option menu)', () => {
    const surface = R(0, 0, 1000, 560);
    const menu = R(740, 300, 256, 240); // bottom-right, above the bar
    const b = computeMpvBounds(surface, { reserved: [menu] })!;
    expect(boundsClear(b, [menu])).toBe(true);
    // Left of the menu (740 x 560) beats above it (1000 x 300).
    expect(b).toEqual({ x: 0, y: 0, width: 740, height: 560 });
  });

  it('applies several reserved strips and never overlaps any of them', () => {
    const surface = R(10, 10, 900, 600);
    const reserved = [R(10, 560, 900, 50), R(10, 520, 900, 40), R(0, 0, 920, 30)];
    const b = computeMpvBounds(surface, { reserved })!;
    expect(boundsClear(b, reserved)).toBe(true);
    expect(b).toEqual({ x: 10, y: 30, width: 900, height: 490 });
  });

  it('clips to the viewport and to overflow ancestors', () => {
    const viewport = R(0, 0, 1280, 720);
    const scroller = R(200, 100, 800, 400);
    const b = computeMpvBounds(R(150, 300, 900, 600), { clip: [viewport, scroller] });
    expect(b).toEqual({ x: 200, y: 300, width: 800, height: 200 });
  });

  it('rounds inward so a fractional edge never covers a pixel row of the bar', () => {
    const controls = R(0, 400.4, 640.5, 48);
    const b = computeMpvBounds(R(0.3, 0.6, 640.5, 448.6), { reserved: [controls] })!;
    expect(b).toEqual({ x: 1, y: 1, width: 639, height: 399 });
    expect(boundsClear(b, [controls])).toBe(true);
  });

  it('returns null when nothing is visible', () => {
    expect(computeMpvBounds(R(0, 900, 640, 360), { clip: [R(0, 0, 1280, 720)] })).toBeNull();
    expect(computeMpvBounds(R(0, 0, 640, 360), { reserved: [R(-10, -10, 700, 400)] })).toBeNull();
    expect(computeMpvBounds(R(0, 0, 640, 1.5))).toBeNull();
  });

  it('ignores reserved rects that do not touch the surface', () => {
    expect(computeMpvBounds(R(0, 0, 640, 360), { reserved: [R(0, 360, 640, 48)] })).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  });
});

describe('rect helpers', () => {
  it('intersect and subtract', () => {
    expect(intersect(R(0, 0, 10, 10), R(10, 0, 10, 10))).toBeNull();
    expect(intersect(R(0, 0, 10, 10), R(5, 5, 10, 10))).toEqual(R(5, 5, 5, 5));
    expect(subtract(R(0, 0, 10, 10), R(20, 20, 5, 5))).toEqual(R(0, 0, 10, 10));
    expect(subtract(R(0, 0, 10, 10), R(0, 0, 10, 10))).toBeNull();
  });
});

describe('measureMpvBounds with app-level overlays', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  /** Mini dock bottom-right of a 1280x720 window; a toast stack anchored bottom-right too. */
  function layout(rects: Record<string, { left: number; top: number; width: number; height: number }>): Element {
    document.body.innerHTML = `
      <div data-player-host="" id="host">
        <div data-mpv-surface="" id="surface"></div>
        <div data-player-controls="" id="controls"></div>
      </div>
      <section data-toast-viewport="" id="viewport"><ol><li data-toast-id="t1" id="toast"></li></ol></section>`;
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(720);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      // Ancestors (which jsdom reports as clipping) span the window.
      const r = rects[this.id] ?? { left: 0, top: 0, width: 1280, height: 720 };
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
    });
    return document.getElementById('surface')!;
  }

  it('keeps the native window clear of a toast that overlaps the mini dock', () => {
    const toast = { left: 884, top: 560, width: 380, height: 80 };
    const surface = layout({
      surface: { left: 856, top: 440, width: 400, height: 225 },
      controls: { left: 856, top: 665, width: 400, height: 40 },
      toast,
    });
    const b = measureMpvBounds(surface)!;
    expect(b).not.toBeNull();
    expect(boundsClear(b, [rectOf(toast)])).toBe(true);
    // The larger free piece (above the toast) is kept.
    expect(b).toEqual({ x: 856, y: 440, width: 400, height: 120 });
  });

  it('ignores toasts elsewhere and an empty toast stack', () => {
    const surface = layout({
      surface: { left: 0, top: 0, width: 800, height: 450 },
      controls: { left: 0, top: 450, width: 800, height: 40 },
      toast: { left: 884, top: 620, width: 380, height: 80 },
    });
    expect(measureMpvBounds(surface)).toEqual({ x: 0, y: 0, width: 800, height: 450 });
    document.getElementById('toast')!.remove();
    expect(measureMpvBounds(surface)).toEqual({ x: 0, y: 0, width: 800, height: 450 });
  });
});

describe('measureMpvBounds in fullscreen', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('ignores the clipping ancestors the fullscreen host left behind', () => {
    // The docked stage (right half, overflow hidden) still holds the host in the DOM, but the
    // host is in the top layer and fills the 1920x1080 screen.
    document.body.innerHTML = `
      <div id="stage" style="overflow: hidden">
        <div data-player-host="" id="host" style="overflow: hidden">
          <div data-mpv-surface="" id="surface"></div>
          <div data-player-controls="" id="controls"></div>
        </div>
      </div>`;
    const rects: Record<string, { left: number; top: number; width: number; height: number }> = {
      stage: { left: 873, top: 83, width: 1047, height: 670 },
      host: { left: 0, top: 0, width: 1920, height: 1080 },
      surface: { left: 0, top: 0, width: 1920, height: 1030 },
      controls: { left: 0, top: 1030, width: 1920, height: 50 },
    };
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1080);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const r = rects[this.id] ?? { left: 0, top: 0, width: 1920, height: 1080 };
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
    });
    const host = document.getElementById('host')!;
    const surface = document.getElementById('surface')!;
    const setFullscreen = (el: Element | null) => Object.defineProperty(document, 'fullscreenElement', { value: el, configurable: true });
    setFullscreen(host);
    expect(measureMpvBounds(surface)).toEqual({ x: 0, y: 0, width: 1920, height: 1030 });
    // Out of fullscreen, the stage clips it again.
    setFullscreen(null);
    expect(measureMpvBounds(surface)).toEqual({ x: 873, y: 83, width: 1047, height: 670 });
  });

  it('does not cut out toasts hidden under the fullscreen layer', () => {
    document.body.innerHTML = `
      <div data-player-host="" id="host">
        <div data-mpv-surface="" id="surface"></div>
        <div data-player-controls="" id="controls"></div>
      </div>
      <section data-toast-viewport=""><ol><li data-toast-id="t1" id="toast"></li></ol></section>`;
    const rects: Record<string, { left: number; top: number; width: number; height: number }> = {
      host: { left: 0, top: 0, width: 1920, height: 1080 },
      surface: { left: 0, top: 0, width: 1920, height: 1030 },
      controls: { left: 0, top: 1030, width: 1920, height: 50 },
      toast: { left: 1520, top: 800, width: 380, height: 200 },
    };
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1080);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const r = rects[this.id] ?? { left: 0, top: 0, width: 1920, height: 1080 };
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
    });
    const surface = document.getElementById('surface')!;
    Object.defineProperty(document, 'fullscreenElement', { value: document.getElementById('host'), configurable: true });
    expect(measureMpvBounds(surface)).toEqual({ x: 0, y: 0, width: 1920, height: 1030 });
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
    expect(measureMpvBounds(surface)).toEqual({ x: 0, y: 0, width: 1520, height: 1030 });
  });
});

describe('computeMpvOverlay', () => {
  it('keeps the whole surface and cuts the bar out as a hole relative to the window', () => {
    const surface = { left: 0, top: 0, right: 1920, bottom: 1080 };
    const bar = { left: 0, top: 1030.4, right: 1920, bottom: 1080 };
    expect(computeMpvOverlay(surface, { reserved: [bar] })).toEqual({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      // Rounded outward: the hole covers the bar's fractional top row.
      holes: [{ x: 0, y: 1030, width: 1920, height: 50 }],
    });
  });

  it('skips chrome outside the window and clips holes to it', () => {
    const surface = { left: 100, top: 50, right: 1100, bottom: 650 };
    const menu = { left: 900, top: 400, right: 1300, bottom: 700 };
    const away = { left: 0, top: 700, right: 50, bottom: 760 };
    expect(computeMpvOverlay(surface, { reserved: [menu, away] })).toEqual({
      bounds: { x: 100, y: 50, width: 1000, height: 600 },
      holes: [{ x: 800, y: 350, width: 200, height: 250 }],
    });
  });
});

describe('measureMpvLayout in picture-in-picture', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('floats the chrome over the video as holes while the PiP layer is shown', () => {
    document.body.innerHTML = `
      <div data-pip-layer="" id="layer">
        <div data-player-host="" id="host">
          <div data-mpv-surface="" id="surface"></div>
          <div data-player-controls="" id="controls"></div>
        </div>
      </div>`;
    const rects: Record<string, { left: number; top: number; width: number; height: number }> = {
      surface: { left: 0, top: 0, width: 480, height: 270 },
      controls: { left: 0, top: 220, width: 480, height: 50 },
    };
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(480);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(270);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const r = rects[this.id] ?? { left: 0, top: 0, width: 480, height: 270 };
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
    });
    const surface = document.getElementById('surface')!;
    expect(measureMpvLayout(surface)).toEqual({
      bounds: { x: 0, y: 0, width: 480, height: 270 },
      holes: [{ x: 0, y: 220, width: 480, height: 50 }],
    });
    // A hidden layer (PiP off) is ignored: the bar is subtracted as when docked.
    document.getElementById('layer')!.hidden = true;
    expect(measureMpvLayout(surface)).toEqual({ bounds: { x: 0, y: 0, width: 480, height: 220 }, holes: [] });
  });
});

describe('computeMpvLayout: overlays over the docked video (L2-desktop-3, L2-desktop-7)', () => {
  const surface = { left: 0, top: 0, right: 1000, bottom: 600 };
  const bar = { left: 0, top: 560, right: 1000, bottom: 600 };

  it('shrinks by reserved chrome and cuts floating overlays out as holes', () => {
    const tooltip = { left: 400.5, top: 100, right: 520, bottom: 130.2 };
    expect(computeMpvLayout(surface, { reserved: [bar], overlays: [tooltip] })).toEqual({
      bounds: { x: 0, y: 0, width: 1000, height: 560 },
      holes: [{ x: 400, y: 100, width: 120, height: 31 }],
    });
  });

  it('keeps the video around a small dialog and hides it under one that covers most of it', () => {
    const small = { left: 300, top: 150, right: 700, bottom: 400 };
    expect(computeMpvLayout(surface, { overlays: [small], modals: [small] })).toEqual({
      bounds: { x: 0, y: 0, width: 1000, height: 600 },
      holes: [{ x: 300, y: 150, width: 400, height: 250 }],
    });
    const big = { left: -50, top: -50, right: 900, bottom: 700 };
    expect(computeMpvLayout(surface, { overlays: [big], modals: [big] })).toEqual({ bounds: null, holes: [] });
  });

  it('measures the share a modal covers against the visible video only', () => {
    const b = { x: 0, y: 0, width: 100, height: 100 };
    expect(modalCovers(b, [])).toBe(false);
    expect(modalCovers(b, [R(0, 0, 49, 100)])).toBe(false);
    expect(modalCovers(b, [R(0, 0, 50, 100)])).toBe(true);
    // Most of this dialog lies outside the video.
    expect(modalCovers(b, [R(80, 0, 900, 900)])).toBe(false);
  });
});

describe('measureMpvLayout: menus, tooltips and dialogs anywhere in the document', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function layout(extra: string, rects: Record<string, { left: number; top: number; width: number; height: number }>): Element {
    document.body.innerHTML = `
      <div data-player-host="" id="host">
        <div data-mpv-surface="" id="surface"></div>
        <div data-player-controls="" id="controls"></div>
      </div>${extra}`;
    const all = {
      surface: { left: 0, top: 0, width: 1000, height: 560 },
      controls: { left: 0, top: 560, width: 1000, height: 40 },
      ...rects,
    };
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const r = all[this.id as keyof typeof all] ?? { left: 0, top: 0, width: 1280, height: 800 };
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
    });
    return document.getElementById('surface')!;
  }

  it('cuts holes for a body-portalled menu and tooltip instead of covering them', () => {
    const surface = layout('<div role="menu" id="menu"></div><div role="tooltip" id="tip"></div>', {
      menu: { left: 600, top: 300, width: 225, height: 283 },
      tip: { left: 100, top: 20, width: 80, height: 24 },
    });
    expect(measureMpvLayout(surface)).toEqual({
      bounds: { x: 0, y: 0, width: 1000, height: 560 },
      holes: [
        { x: 600, y: 300, width: 225, height: 260 },
        { x: 100, y: 20, width: 80, height: 24 },
      ],
    });
  });

  // L3-desktop-8: this pinned the bug. The playback options menu (and its track and sleep
  // views) shrank the docked video from 396 to 222 px; it is cut out as a hole now.
  it('cuts a menu inside the player host out as a hole and keeps the video its size', () => {
    const surface = layout('', { menu: { left: 700, top: 360, width: 300, height: 200 } });
    document.getElementById('host')!.insertAdjacentHTML('beforeend', '<div role="menu" id="menu"></div>');
    expect(measureMpvLayout(surface)).toEqual({
      bounds: { x: 0, y: 0, width: 1000, height: 560 },
      holes: [{ x: 700, y: 360, width: 300, height: 200 }],
    });
  });

  it('a menu that pops up from the docked control bar is a hole, while the bar stays reserved', () => {
    const surface = layout('', { menu: { left: 700, top: 320, width: 300, height: 236 } });
    document.getElementById('controls')!.insertAdjacentHTML('beforeend', '<div role="menu" id="menu"></div>');
    expect(measureMpvLayout(surface)).toEqual({
      bounds: { x: 0, y: 0, width: 1000, height: 560 },
      holes: [{ x: 700, y: 320, width: 300, height: 236 }],
    });
  });

  it("treats the player's own popover (data-mpv-overlay) as a hole even inside the host", () => {
    const surface = layout('', { ctx: { left: 400, top: 380, width: 225, height: 283 } });
    document.getElementById('host')!.insertAdjacentHTML('beforeend', '<div role="menu" data-mpv-overlay="" id="ctx"></div>');
    expect(measureMpvLayout(surface)).toEqual({
      bounds: { x: 0, y: 0, width: 1000, height: 560 },
      holes: [{ x: 400, y: 380, width: 225, height: 180 }],
    });
  });

  it('keeps the video around a small modal and hides it under a large one', () => {
    const surface = layout('<div role="dialog" aria-modal="true" id="dlg"></div>', {
      dlg: { left: 350, top: 150, width: 300, height: 200 },
    });
    expect(measureMpvLayout(surface)).toEqual({
      bounds: { x: 0, y: 0, width: 1000, height: 560 },
      holes: [{ x: 350, y: 150, width: 300, height: 200 }],
    });
    vi.restoreAllMocks();
    const covered = layout('<div role="dialog" aria-modal="true" id="dlg"></div>', {
      dlg: { left: 0, top: 0, width: 1280, height: 800 },
    });
    expect(measureMpvLayout(covered)).toEqual({ bounds: null, holes: [] });
  });

  it('skips an overlay that is laid out hidden before it is placed', () => {
    const surface = layout('<div role="menu" id="menu" style="visibility: hidden"></div>', {
      menu: { left: 600, top: 300, width: 225, height: 283 },
    });
    expect(measureMpvLayout(surface).holes).toEqual([]);
  });

  it('ignores covered app chrome in window fill but cuts out a body-portalled menu', () => {
    document.body.innerHTML = `
      <div data-mpv-reserved-global="" id="header"></div>
      <div data-player-window-layer=""><div data-player-host=""><div data-mpv-surface="" id="surface"></div></div></div>
      <div role="menu" id="menu" style="z-index: 60"></div>`;
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const rect = this.id === 'header'
        ? { left: 0, top: 0, width: 1000, height: 50 }
        : this.id === 'menu'
          ? { left: 700, top: 100, width: 200, height: 150 }
          : { left: 0, top: 0, width: 1000, height: 600 };
      return { ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect } as DOMRect;
    });
    expect(measureMpvLayout(document.getElementById('surface')!)).toEqual({
      bounds: { x: 0, y: 0, width: 1000, height: 600 },
      holes: [{ x: 700, y: 100, width: 200, height: 150 }],
    });
  });

  it('cuts the control bar out of the native video in window fill', () => {
    document.body.innerHTML = `
      <div data-player-window-layer=""><div data-player-host="">
        <div data-mpv-surface="" id="surface"></div>
        <div data-player-controls="" id="controls"></div>
      </div></div>`;
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const rect = this.id === 'controls'
        ? { left: 0, top: 500, width: 1000, height: 100 }
        : { left: 0, top: 0, width: 1000, height: 600 };
      return { ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect } as DOMRect;
    });
    expect(measureMpvLayout(document.getElementById('surface')!)).toEqual({
      bounds: { x: 0, y: 0, width: 1000, height: 600 },
      holes: [{ x: 0, y: 500, width: 1000, height: 100 }],
    });
  });
});

// L3-desktop-10: a dialog's backdrop cannot cover the native video, so mpv dims itself to match.
describe('scrim dim', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('reads computed rgb colours in both syntaxes', () => {
    expect(parseRgb('rgba(4, 8, 16, 0.72)')).toEqual({ r: 4, g: 8, b: 16, a: 0.72 });
    expect(parseRgb('rgb(18 26 42 / 0.45)')).toEqual({ r: 18, g: 26, b: 42, a: 0.45 });
    expect(parseRgb('rgb(0 0 0 / 78%)')).toEqual({ r: 0, g: 0, b: 0, a: 0.78 });
    expect(parseRgb('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseRgb('transparent')).toBeNull();
  });

  it("finds an open dialog's scrim over the video, and nothing once it closes", () => {
    document.body.innerHTML = `
      <div data-player-host=""><div data-mpv-surface="" id="surface"></div></div>
      <div data-dialog-layer=""><div aria-hidden="true" class="fixed inset-0 bg-scrim" style="background-color: rgba(4, 8, 16, 0.72)"></div><div role="dialog" aria-modal="true"></div></div>`;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 600, x: 0, y: 0, right: 800, bottom: 600, toJSON: () => ({}) } as DOMRect);
    const surface = document.getElementById('surface')!;
    expect(measureScrim(surface)).toEqual({ r: 4, g: 8, b: 16, a: 0.72 });
    document.querySelector('[data-dialog-layer]')!.remove();
    expect(measureScrim(surface)).toBeNull();
  });

  it('finds a scrim marked data-scrim whatever its classes (L3-cross-XB-6)', () => {
    document.body.innerHTML = `
      <div data-player-host=""><div data-mpv-surface="" id="surface"></div></div>
      <div data-dialog-layer=""><div aria-hidden="true" data-scrim="" class="absolute bg-black/50" style="background-color: rgba(0, 0, 0, 0.5)"></div><div role="dialog" aria-modal="true"></div></div>`;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 600, x: 0, y: 0, right: 800, bottom: 600, toJSON: () => ({}) } as DOMRect);
    const surface = document.getElementById('surface')!;
    expect(measureScrim(surface)).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    // Its arrival re-measures the layout too.
    expect(document.querySelector('[data-scrim]')!.matches(LAYOUT_WATCH_SELECTOR)).toBe(true);
  });

  it('draws the scrim colour over the whole mpv window as an ASS rectangle, and removes it', () => {
    const [name, id, format, data, ...sizes] = dimOverlayCommand({ r: 4, g: 8, b: 16, a: 0.72 });
    expect([name, id, format, sizes]).toEqual(['osd-overlay', 63, 'ass-events', [0, 720, 0]]);
    // BGR colour; ASS alpha counts transparency: 0.72 opaque is 0x47.
    expect(data).toContain('\\1c&H100804&');
    expect(data).toContain('\\1a&H47&');
    expect(data).toMatch(/^\{\\an7\\pos\(0,0\)[^}]*\\p1\}m -10 -10 l 10000 -10 10000 10000 -10 10000\{\\p0\}$/);
    expect(dimOverlayCommand(null)).toEqual(['osd-overlay', 63, 'none', '']);
  });
});
