/**
 * P2-GRID-1: a grid's posters load at the column width VirtualGrid already knows, rounded like the
 * frame's clientWidth, instead of each reading its frame as it mounts (a forced layout per poster
 * in the commit). The cells mount only once the grid has read its own width, and a picture keeps
 * the width it mounted with, so a resize does not start the pictures on screen again, nor
 * re-render the posters.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Poster } from '@/ui/Poster';
import { VirtualGrid } from '@/ui/VirtualGrid';

type Cb = (entries: { target: Element; borderBoxSize: { inlineSize: number; blockSize: number }[] }[]) => void;

class FakeRO {
  static all: FakeRO[] = [];
  readonly targets = new Set<Element>();
  constructor(readonly cb: Cb) {
    FakeRO.all.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
}

/** Elements whose box was read; the listbox reports `gridWidth`, as a laid-out grid would. */
let reads: Element[] = [];
let gridWidth = 0;

beforeEach(() => {
  FakeRO.all = [];
  vi.stubGlobal('ResizeObserver', FakeRO);
  reads = [];
  const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!.get!;
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    reads.push(this);
    return this.getAttribute('role') === 'listbox' ? gridWidth : clientWidth.call(this);
  });
  // jsdom lays nothing out: the scroller reports a desktop-sized box, so the virtualizer renders rows.
  for (const [prop, px] of [
    ['offsetWidth', 1026],
    ['offsetHeight', 720],
  ] as const) {
    vi.spyOn(HTMLElement.prototype, prop, 'get').mockImplementation(function (this: HTMLElement) {
      reads.push(this);
      return px;
    });
  }
  const rect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    reads.push(this);
    return rect.call(this);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Poster commits after mounting, counted by a Profiler around each poster. */
let posterUpdates = 0;
const countUpdate = (_id: string, phase: string) => {
  if (phase !== 'mount') posterUpdates++;
};

const films = (prefix: string) => Array.from({ length: 12 }, (_, i) => ({ id: `${prefix}${i}`, src: `http://cdn.example/${prefix}${i}.jpg` }));

function Grid({ items }: { items: { id: string; src: string }[] }) {
  return (
    <VirtualGrid
      items={items}
      // 180 px columns and the 16 px gap: five columns of 192.4 px in a 1026 px grid.
      minColumnWidth={180}
      aspect="poster"
      label="Movies"
      postersFillCells
      getKey={(f) => f.id}
      initialRect={{ width: 960, height: 720 }}
      render={(f) => (
        <Profiler id={f.id} onRender={countUpdate}>
          <Poster src={f.src} alt="" label={f.id} aspect="poster" />
        </Profiler>
      )}
    />
  );
}

const imgs = () => [...screen.getByRole('listbox', { name: 'Movies' }).querySelectorAll('img')];
const widthOf = (img: HTMLImageElement) => /[?&]w=(\d+)/.exec(img.getAttribute('src') ?? '')?.[1];

describe('P2-GRID-1: grid posters take the column width', () => {
  it('load at the grid\'s measured column width, rounded, without reading any poster\'s box', () => {
    gridWidth = 1026;
    const { rerender } = render(<Grid items={films('a')} />);
    const shown = imgs();
    expect(shown.length).toBeGreaterThan(0);
    // No layout read on the pictures; the grid itself reads its width once.
    expect(reads.filter((el) => el instanceof HTMLImageElement)).toEqual([]);
    // 192.4 px rounds to 192, the bucket the frame's clientWidth gave: not 256 (unrounded), and not
    // the 228 px columns of the 960 px guess the cells would have mounted at.
    expect(shown.map(widthOf)).toEqual(shown.map(() => '192'));

    // A wider window: five columns of 207.2 px. The pictures on screen keep their copies, and the
    // new width re-renders none of the posters (the cells' memo holds)...
    gridWidth = 1100;
    posterUpdates = 0;
    const grid = screen.getByRole('listbox', { name: 'Movies' });
    act(() => {
      for (const ro of FakeRO.all) if (ro.targets.has(grid)) ro.cb([{ target: grid, borderBoxSize: [{ inlineSize: 1100, blockSize: 720 }] }]);
    });
    expect(grid.getAttribute('data-columns')).toBe('5');
    expect(posterUpdates).toBe(0);
    expect(imgs()).toEqual(shown);
    expect(shown.map(widthOf)).toEqual(shown.map(() => '192'));

    // ...and a picture that mounts now takes the new width.
    rerender(<Grid items={films('b')} />);
    const next = imgs();
    expect(next[0]).not.toBe(shown[0]);
    expect(next.map(widthOf)).toEqual(next.map(() => '256'));
    expect(reads.filter((el) => el instanceof HTMLImageElement)).toEqual([]);
  });
});
