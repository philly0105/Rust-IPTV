import { describe, expect, it } from 'vitest';

import {
  capacityOf,
  directionOf,
  fitLayout,
  isLayout,
  layoutFits,
  LAYOUTS,
  MAX_TILES,
  nextLayout,
  neighbour,
  slotClass,
  WALL_CLASSES,
  type Box,
} from '../layout';

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height });

describe('layouts', () => {
  it('has three layouts of two or four slots', () => {
    expect(LAYOUTS).toEqual(['1x2', '2x2', '1+3']);
    expect(LAYOUTS.map(capacityOf)).toEqual([2, 4, 4]);
    expect(MAX_TILES).toBe(4);
    expect(isLayout('2x2')).toBe(true);
    expect(isLayout('4x4')).toBe(false);
    expect(isLayout(undefined)).toBe(false);
  });

  it('fits a tile count, falling back to the grid', () => {
    expect(layoutFits('1x2', 2)).toBe(true);
    expect(layoutFits('1x2', 3)).toBe(false);
    expect(fitLayout('1x2', 3)).toBe('2x2');
    expect(fitLayout('1+3', 4)).toBe('1+3');
  });

  it('cycles only through layouts that hold the tiles', () => {
    expect(nextLayout('1x2', 2)).toBe('2x2');
    expect(nextLayout('2x2', 2)).toBe('1+3');
    expect(nextLayout('1+3', 2)).toBe('1x2');
    expect(nextLayout('1+3', 3)).toBe('2x2');
    expect(nextLayout('2x2', 4)).toBe('1+3');
  });

  it('gives every layout its wall classes and spans the large 1+3 slot', () => {
    for (const l of LAYOUTS) expect(WALL_CLASSES[l]).toContain('@2xl:');
    expect(slotClass('1+3', 0)).toContain('@5xl:row-span-3');
    expect(slotClass('1+3', 1)).not.toContain('span');
    // Stacked slots keep 16:9 below the container breakpoint.
    expect(slotClass('2x2', 2)).toContain('aspect-video');
  });
});

describe('arrow focus (neighbour)', () => {
  it('maps arrow keys to directions', () => {
    expect(directionOf('ArrowLeft')).toBe('left');
    expect(directionOf('ArrowDown')).toBe('down');
    expect(directionOf('Enter')).toBeNull();
  });

  // 2x2: 0 1 / 2 3
  const grid = [box(0, 0, 100, 56), box(104, 0, 100, 56), box(0, 60, 100, 56), box(104, 60, 100, 56)];

  it('moves within a 2x2 grid and stops at the edges', () => {
    expect(neighbour(grid, 0, 'right')).toBe(1);
    expect(neighbour(grid, 0, 'down')).toBe(2);
    expect(neighbour(grid, 3, 'left')).toBe(2);
    expect(neighbour(grid, 3, 'up')).toBe(1);
    expect(neighbour(grid, 0, 'left')).toBeNull();
    expect(neighbour(grid, 0, 'up')).toBeNull();
  });

  it('follows the screen in 1+3: right from the large tile goes to the small one level with its middle', () => {
    const wall = [box(0, 0, 300, 169), box(304, 0, 100, 56), box(304, 60, 100, 56), box(304, 120, 100, 56)];
    expect(neighbour(wall, 0, 'right')).toBe(2);
    expect(neighbour(wall, 1, 'left')).toBe(0);
    expect(neighbour(wall, 2, 'left')).toBe(0);
    expect(neighbour(wall, 1, 'down')).toBe(2);
    expect(neighbour(wall, 3, 'down')).toBeNull();
  });

  it('walks a stacked column on narrow screens', () => {
    const stack = [box(0, 0, 360, 202), box(0, 206, 360, 202), box(0, 412, 360, 202)];
    expect(neighbour(stack, 0, 'down')).toBe(1);
    expect(neighbour(stack, 2, 'up')).toBe(1);
    expect(neighbour(stack, 1, 'right')).toBeNull();
  });

  it('mirrors in right-to-left layouts because it reads the boxes, not the order', () => {
    // RTL 2x2: slot 0 sits on the right.
    const rtl = [box(104, 0, 100, 56), box(0, 0, 100, 56), box(104, 60, 100, 56), box(0, 60, 100, 56)];
    expect(neighbour(rtl, 0, 'left')).toBe(1);
    expect(neighbour(rtl, 0, 'right')).toBeNull();
  });

  it('skips slots that were not measured', () => {
    expect(neighbour([box(0, 0, 10, 10), null, box(40, 0, 10, 10)], 0, 'right')).toBe(2);
    expect(neighbour([null, box(0, 0, 10, 10)], 0, 'right')).toBeNull();
  });
});
