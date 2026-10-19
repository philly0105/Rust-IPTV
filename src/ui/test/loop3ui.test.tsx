/**
 * Loop 3 UI fixes (L3-fix-ui-data): toasts keep clear of the mini player (L3-desktop-4), focus
 * restored by a closing dialog reaches React (L3-live-2), a press moves the grid cursor
 * (L3-visual-1), a fitted select holds its longest label (L1-visual-20), a long empty-state
 * title wraps (L3-vod-6), the artwork fetch gate (L3-live-1) and resized artwork (L3-serve-ui-1).
 * Follow-ups: a mounted grid resets its cursor (L3-ui-data-x1), media key caps (-x2), a live dot
 * that stops pulsing (-x3), F8's way back surviving a toast hand-off (-x4) and the marked scrim (-x6).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { IMAGE_WIDTH_BUCKETS, imageUrl, imageWidthBucket, sizedImageUrl, WEB_IMAGE_ROUTE } from '@/api/images';

import { Dialog } from '../Dialog';
import { Select } from '../Field';
import { gateImage, imageGateStats, MAX_ACTIVE, noteImageLoaded, pageIsScrolling, resetImageGate, SETTLE_MS } from '../imageGate';
import { comboKeys, Kbd, LiveBadge } from '../Misc';
import { Poster, PosterWidthContext } from '../Poster';
import { EmptyState } from '../States';
import { dismissToast, focusToasts, toast, TOAST_AVOID_GAP, toastClearanceFor, ToastViewport, useToastStore } from '../Toast';
import { VirtualGrid } from '../VirtualGrid';

afterEach(() => {
  cleanup();
  act(() => useToastStore.setState({ toasts: [] }));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetImageGate();
});

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

describe('toasts and the mini player (L3-desktop-4)', () => {
  const column = { left: 880, right: 1264 };

  it('lifts the stack above an obstacle in its column, in the lower half', () => {
    expect(toastClearanceFor(column, [rect(1000, 500, 260, 200)], 720)).toBe(720 - 500 + TOAST_AVOID_GAP);
  });

  it('ignores obstacles beside the column, in the upper half, or with no size', () => {
    expect(toastClearanceFor(column, [rect(100, 500, 260, 200)], 720)).toBe(0);
    expect(toastClearanceFor(column, [rect(1000, 40, 260, 200)], 720)).toBe(0);
    expect(toastClearanceFor(column, [rect(1000, 500, 0, 0)], 720)).toBe(0);
  });

  it('stays at the bottom when lifting would leave too little room', () => {
    expect(toastClearanceFor(column, [rect(1000, 100, 260, 600)], 720)).toBe(0);
  });

  it('the viewport measures a [data-toast-avoid] element and keeps clear of it', () => {
    const dock = document.createElement('div');
    dock.setAttribute('data-toast-avoid', '');
    document.body.append(dock);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this === dock) return rect(1000, 520, 260, 200);
      if (this.tagName === 'SECTION') return rect(880, 600, 384, 120);
      return rect(0, 0, 0, 0);
    });
    try {
      render(<ToastViewport />);
      act(() => void toast({ title: 'Added to My List' }));
      const section = document.querySelector<HTMLElement>('section[data-clearing]');
      expect(section).not.toBeNull();
      expect(section!.style.getPropertyValue('--toast-clear')).toBe(`${window.innerHeight - 520 + TOAST_AVOID_GAP}px`);
    } finally {
      dock.remove();
    }
  });
});

describe('focus restored by a closing dialog reaches React (L3-live-2)', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const [focusedName, setFocusedName] = useState('');
    return (
      <div onFocus={(e) => setFocusedName((e.target as HTMLElement).getAttribute('data-name') ?? '')}>
        <button type="button" data-name="row" onClick={() => setOpen(true)}>
          BBC One
        </button>
        <output data-testid="focused">{focusedName}</output>
        <Dialog open={open} onClose={() => setOpen(false)} title="Rename channel">
          <input aria-label="Name" data-name="input" />
        </Dialog>
      </div>
    );
  }

  it("the opener's onFocus runs again after Escape, so its shortcuts work", async () => {
    render(<Harness />);
    const row = screen.getByRole('button', { name: 'BBC One' });
    act(() => row.focus());
    expect(screen.getByTestId('focused').textContent).toBe('row');
    fireEvent.click(row);
    expect(screen.getByRole('dialog', { name: 'Rename channel' })).toBeTruthy();
    act(() => screen.getByLabelText('Name').focus());
    expect(screen.getByTestId('focused').textContent).toBe('input');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(row);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('focused').textContent).toBe('row');
  });
});

describe('grid cursor follows a press (L3-visual-1)', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, name: `Movie ${i}` }));
  const grid = () => (
    <VirtualGrid
      items={items}
      minColumnWidth={150}
      aspect="poster"
      label="Movies"
      getKey={(c) => c.id}
      initialRect={{ width: 960, height: 720 }}
      render={(c) => <span>{c.name}</span>}
    />
  );

  it('a pointer press or a right-click puts the cursor on that title, not the first', () => {
    if (typeof ResizeObserver === 'undefined') {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
    }
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(960);
    render(grid());
    const list = screen.getByLabelText('Movies');
    fireEvent.pointerDown(screen.getByText('Movie 5'));
    act(() => list.focus());
    expect(list.getAttribute('aria-activedescendant')).toMatch(/5$/);
    fireEvent.contextMenu(screen.getByText('Movie 7'));
    expect(list.getAttribute('aria-activedescendant')).toMatch(/7$/);
  });
});

describe('a mounted grid whose items are replaced resets its cursor (L3-ui-data-x1)', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, name: `Movie ${i}` }));
  const grid = (list: typeof items, resetKey: string) => (
    <VirtualGrid
      items={list}
      minColumnWidth={150}
      aspect="poster"
      label="Movies"
      getKey={(c) => c.id}
      initialRect={{ width: 960, height: 720 }}
      render={(c) => <span>{c.name}</span>}
      resetKey={resetKey}
    />
  );
  const activeName = (list: HTMLElement) => {
    const id = list.getAttribute('aria-activedescendant');
    return id ? document.getElementById(id)?.textContent : null;
  };

  beforeEach(() => {
    if (typeof ResizeObserver === 'undefined') {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
    }
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(960);
  });

  it('with keyboard focus the cursor goes to the first title of the new order; the same key keeps it', () => {
    const { rerender } = render(grid(items, 'title|asc'));
    const list = screen.getByLabelText('Movies');
    act(() => list.focus());
    fireEvent.keyDown(list, { key: 'End' });
    expect(activeName(list)).toBe('Movie 11');
    // A re-render with the same key (new titles arriving for the same sort) leaves the cursor alone.
    rerender(grid(items, 'title|asc'));
    expect(activeName(list)).toBe('Movie 11');
    const reversed = [...items].reverse();
    rerender(grid(reversed, 'title|desc'));
    expect(document.activeElement).toBe(list);
    expect(activeName(list)).toBe('Movie 11');
    expect(list.getAttribute('aria-activedescendant')).toMatch(/-0$/);
  });

  it('without focus the cursor clears, so no ring shows on the title that took the old index', () => {
    const { rerender } = render(grid(items, 'added|desc'));
    const list = screen.getByLabelText('Movies');
    act(() => list.focus());
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(list.getAttribute('aria-activedescendant')).not.toBeNull();
    act(() => list.blur());
    rerender(grid([...items].reverse(), 'rating|desc'));
    expect(list.getAttribute('aria-activedescendant')).toBeNull();
    expect(document.querySelector('[data-active]')).toBeNull();
  });
});

describe('fitted select (L1-visual-20)', () => {
  const options = [
    { value: 'added', label: 'Recently added' },
    { value: 'name', label: 'Name' },
  ];

  it('a w-auto select sizes from a hidden copy of every label', () => {
    const { container } = render(<Select aria-label="Sort" className="h-8 w-auto min-w-36" options={options} />);
    const sizer = container.querySelector<HTMLElement>('[data-select-sizer]');
    expect(sizer).not.toBeNull();
    expect(sizer!.getAttribute('aria-hidden')).toBe('true');
    expect(sizer!.className).toContain('invisible');
    expect([...sizer!.children].map((c) => c.textContent)).toEqual(['Recently added', 'Name']);
    // The select fills the same grid cell.
    expect(screen.getByRole('combobox', { name: 'Sort' }).className).toContain('col-start-1');
  });

  it('a full-width select has no sizer', () => {
    const { container } = render(<Select aria-label="Sort" options={options} />);
    expect(container.querySelector('[data-select-sizer]')).toBeNull();
  });
});

describe('empty state title (L3-vod-6)', () => {
  it('breaks a long unbroken query inside the column', () => {
    const query = 'x'.repeat(300);
    render(<EmptyState title={`No results for "${query}"`} />);
    const title = screen.getByText(`No results for "${query}"`);
    expect(title.closest('[class*="overflow-wrap:anywhere"]')).not.toBeNull();
  });
});

describe('resized artwork (L3-serve-ui-1)', () => {
  it('rounds the drawn width up to a cache bucket', () => {
    expect(IMAGE_WIDTH_BUCKETS).toEqual([64, 96, 128, 192, 256, 384, 512, 768, 1024]);
    expect(imageWidthBucket(36, 1)).toBe(64);
    expect(imageWidthBucket(36, 2)).toBe(96);
    expect(imageWidthBucket(180, 1)).toBe(192);
    expect(imageWidthBucket(180, 2)).toBe(384);
    expect(imageWidthBucket(1024, 1)).toBe(1024);
    expect(imageWidthBucket(600, 2)).toBeUndefined();
    expect(imageWidthBucket(0, 1)).toBeUndefined();
    expect(imageWidthBucket(undefined)).toBeUndefined();
  });

  it('adds w= to cache URLs only, the same way at render and after measuring', () => {
    const src = 'http://cdn.example/poster.jpg';
    const sized = imageUrl(src, 's1', 180)!;
    expect(sized).toBe(`${WEB_IMAGE_ROUTE}?${new URLSearchParams({ url: src, sourceId: 's1' })}&w=192`);
    expect(sizedImageUrl(imageUrl(src, 's1')!, 180)).toBe(sized);
    expect(sizedImageUrl(sized, 400)).toBe(sized);
    expect(sizedImageUrl(src, 180)).toBe(src);
    expect(imageUrl(src, 's1')).not.toContain('w=');
  });

  it('a poster asks for the size of its frame; a priority poster loads full size', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(180);
    const card = render(<Poster src="http://cdn.example/card.jpg" alt="Card" />);
    expect(card.container.querySelector('img')!.getAttribute('src')).toMatch(/&w=192$/);
    card.unmount();
    const hero = render(<Poster src="http://cdn.example/hero.jpg" alt="Hero" priority />);
    expect(hero.container.querySelector('img')!.getAttribute('src')).not.toContain('w=');
  });

  it("takes a rail's card width instead of measuring its frame (performance audit SH-6)", () => {
    const measured = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
    const card = render(
      <PosterWidthContext.Provider value={168}>
        <Poster src="http://cdn.example/rail.jpg" alt="Rail card" />
        <Poster src="http://cdn.example/rail-hero.jpg" alt="Rail hero" priority />
      </PosterWidthContext.Provider>,
    );
    const [railCard, railHero] = Array.from(card.container.querySelectorAll('img'));
    expect(railCard!.getAttribute('src')).toMatch(/&w=192$/);
    expect(measured).not.toHaveBeenCalled();
    // A priority picture still loads full size.
    expect(railHero!.getAttribute('src')).not.toContain('w=');
  });
});

describe('artwork fetch gate (L3-live-1)', () => {
  class FakeIO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  let now = 1000;
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', FakeIO);
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    resetImageGate();
  });

  const cacheUrl = (n: number) => `${WEB_IMAGE_ROUTE}?url=${encodeURIComponent(`http://cdn.example/${n}.jpg`)}`;
  const imgs = (n: number) => Array.from({ length: n }, () => document.createElement('img'));

  it(`keeps at most ${MAX_ACTIVE} cache fetches in flight and starts the next one when a slot frees`, () => {
    const els = imgs(6);
    els.forEach((el, i) => gateImage(el, cacheUrl(i)));
    expect(els.map((el) => el.hasAttribute('src'))).toEqual([true, true, true, true, false, false]);
    expect(imageGateStats()).toEqual({ active: 4, pending: 2 });
    fireEvent.load(els[0]!);
    expect(els[4]!.getAttribute('src')).toBe(cacheUrl(4));
    expect(imageGateStats()).toEqual({ active: 4, pending: 1 });
  });

  it('cancelling a running picture drops its request and frees its slot', () => {
    const els = imgs(5);
    const cancels = els.map((el, i) => gateImage(el, cacheUrl(i)));
    cancels[1]!();
    expect(els[1]!.hasAttribute('src')).toBe(false);
    expect(els[4]!.hasAttribute('src')).toBe(true);
  });

  it('newer pictures (what the user scrolled to) go first', async () => {
    const old = imgs(6);
    old.forEach((el, i) => gateImage(el, cacheUrl(i)));
    await Promise.resolve();
    const fresh = imgs(2);
    fresh.forEach((el, i) => gateImage(el, cacheUrl(100 + i)));
    fireEvent.load(old[0]!);
    expect(fresh[0]!.hasAttribute('src')).toBe(true);
    expect(old[4]!.hasAttribute('src')).toBe(false);
  });

  it('a picture loaded before, an original URL and a priority picture start at once without a slot', () => {
    for (let i = 0; i < 4; i++) gateImage(document.createElement('img'), cacheUrl(i));
    const [seen, direct, urgent] = imgs(3);
    noteImageLoaded(cacheUrl(50));
    gateImage(seen!, cacheUrl(50));
    gateImage(direct!, 'http://cdn.example/direct.jpg');
    gateImage(urgent!, cacheUrl(51), true);
    expect([seen, direct, urgent].map((el) => el!.hasAttribute('src'))).toEqual([true, true, true]);
    expect(imageGateStats().active).toBe(4);
  });

  it('holds new pictures while the page scrolls and starts them once it settles', () => {
    vi.useFakeTimers();
    expect(pageIsScrolling()).toBe(false);
    document.dispatchEvent(new Event('scroll'));
    expect(pageIsScrolling()).toBe(true);
    const [el] = imgs(1);
    gateImage(el!, cacheUrl(7));
    expect(el!.hasAttribute('src')).toBe(false);
    now += SETTLE_MS + 10;
    vi.advanceTimersByTime(SETTLE_MS + 10);
    expect(el!.getAttribute('src')).toBe(cacheUrl(7));
  });
});

describe('media key caps (L3-ui-data-x2)', () => {
  const MEDIA = [
    ['mediaplaypause', '⏯︎', 'Play/Pause'],
    ['mediastop', '⏹︎', 'Stop'],
    ['mediatracknext', '⏭︎', 'Next track'],
    ['mediatrackprevious', '⏮︎', 'Previous track'],
  ] as const;

  it.each(MEDIA)('%s shows its key symbol as text and is spoken by name', (combo, symbol, name) => {
    expect(comboKeys(combo)).toEqual([symbol]);
    const { container } = render(<Kbd combo={combo} />);
    const cap = container.querySelector('kbd')!;
    expect(cap.textContent).toBe(symbol);
    expect(cap.getAttribute('aria-hidden')).not.toBeNull();
    expect(cap.title).toBe(name);
    expect(container.querySelector('.sr-only')!.textContent).toBe(name);
  });

  it('other keys keep their label and get no tooltip', () => {
    const { container } = render(<Kbd combo="shift+arrowleft" />);
    expect(container.querySelector('.sr-only')!.textContent).toBe('Shift + ←');
    expect([...container.querySelectorAll('kbd')].map((k) => k.title)).toEqual(['', '']);
  });
});

describe('the live dot stops pulsing (L3-ui-data-x3)', () => {
  const globals = readFileSync(join(__dirname, '..', '..', 'styles', 'globals.css'), 'utf8');

  it('the pulse token plays a few times, never forever', () => {
    const token = /--animate-live-pulse:\s*([^;]+);/.exec(globals)?.[1] ?? '';
    expect(token).toMatch(/^live-pulse\s/);
    expect(token).not.toMatch(/infinite/);
    const count = Number(/\s(\d+)\s*$/.exec(token)?.[1]);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(3);
  });

  it('the LIVE badge dot animates only without reduced motion', () => {
    const { container } = render(<LiveBadge />);
    const dot = container.querySelector('[class*="animate-live-pulse"]')!;
    expect(dot.className.split(/\s+/)).toContain('motion-safe:animate-live-pulse');
    expect(dot.className).not.toMatch(/(^|\s)animate-live-pulse/);
  });
});

describe("F8's way back survives a toast handing focus on (L3-ui-data-x4)", () => {
  it('dismissing the focused toast moves to its neighbour, and leaving the last returns to the origin', async () => {
    render(
      <>
        <button type="button">Origin</button>
        <ToastViewport />
      </>,
    );
    const origin = screen.getByRole('button', { name: 'Origin' });
    act(() => origin.focus());
    act(() => {
      toast({ id: 'x4-a', title: 'First', duration: 0 });
      toast({ id: 'x4-b', title: 'Second', duration: 0 });
    });
    act(() => void focusToasts());
    expect(document.activeElement?.closest('[data-toast-id]')?.getAttribute('data-toast-id')).toBe('x4-b');
    act(() => dismissToast('x4-b'));
    // The hand-off focuses the neighbour inside React's commit and re-sends the focusin a
    // microtask later, with no related target.
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement?.closest('[data-toast-id]')?.getAttribute('data-toast-id')).toBe('x4-a');
    act(() => dismissToast('x4-a'));
    expect(document.activeElement).toBe(origin);
  });
});

describe('the dialog backdrop is marked as a scrim (L3-ui-data-x6)', () => {
  it('carries data-scrim, stays hidden from assistive tech and still closes on a press', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Rename channel">
        <input aria-label="Name" />
      </Dialog>,
    );
    const scrims = document.querySelectorAll('[data-dialog-layer] > [data-scrim]');
    expect(scrims).toHaveLength(1);
    expect(scrims[0]!.getAttribute('aria-hidden')).not.toBeNull();
    fireEvent.mouseDown(scrims[0]!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a drawer uses the same marked scrim', () => {
    render(
      <Dialog open onClose={() => {}} title="Filters" placement="end">
        <p>Body</p>
      </Dialog>,
    );
    expect(document.querySelectorAll('[data-dialog-layer] > [data-scrim]')).toHaveLength(1);
  });
});
