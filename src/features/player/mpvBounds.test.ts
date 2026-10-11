import { describe, expect, it } from 'vitest';

import { boundsClear, computeMpvBounds, intersect, rectOf, subtract, type Rect } from './mpvBounds';

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
