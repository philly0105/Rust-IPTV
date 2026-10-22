import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CategoryIndex } from '@/features/vod/components/CategoryIndex';

import { useListVirtualizer } from '..';

/**
 * A virtualized list that mounts inside a page that is already scrolled (the VOD landing's
 * category index opened from the bottom of the page) must not move the page. react-virtual
 * starts from `initialOffset`, 0 by default, and scrolls its element there on mount: opening
 * Browse all categories sent the user to the top of the page.
 *
 * A list that mounts in the same commit as its page (the landing opened with the categories
 * cached and the index remembered open, or Back from a category) must still learn how far down
 * the page it starts. Its layout effects run before React attaches the page's ref, and the
 * margin stayed 0: the index rendered rows thousands of pixels away from the ones on screen.
 */

let scrolls: { el: Element; top: number | undefined }[] = [];
const originalScrollTo = Element.prototype.scrollTo;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1280 });
});

beforeEach(() => {
  scrolls = [];
  // jsdom has no Element.scrollTo; this one moves the element the way a browser would.
  Element.prototype.scrollTo = function scrollTo(this: Element, arg?: ScrollToOptions | number) {
    const top = typeof arg === 'object' ? arg.top : undefined;
    scrolls.push({ el: this, top });
    if (top !== undefined) this.scrollTop = top;
  } as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollTo = originalScrollTo;
});

const SCROLLED = 3000;

function Rows({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const v = useListVirtualizer({ count: 500, getScrollElement: () => scrollRef.current, estimateSize: () => 48, scrollMargin: 2000 });
  return (
    <div data-testid="rows" data-first={v.getVirtualItems()[0]?.index}>
      {v.getVirtualItems().map((r) => (
        <div key={r.key}>row {r.index}</div>
      ))}
    </div>
  );
}

function Page({ children }: { children: (ref: RefObject<HTMLDivElement | null>) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div ref={ref} data-testid="scroller" style={{ height: 800, overflow: 'auto' }}>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open && children(ref)}
    </div>
  );
}

function openAt(ui: (ref: RefObject<HTMLDivElement | null>) => ReactNode) {
  const view = render(<MemoryRouter>{<Page>{ui}</Page>}</MemoryRouter>);
  const scroller = view.getByTestId('scroller');
  scroller.scrollTop = SCROLLED;
  act(() => view.getByRole('button', { name: 'open' }).click());
  return { view, scroller };
}

describe('useListVirtualizer on a scrolled page', () => {
  it('starts at the scroller offset and does not scroll it to the top', () => {
    const { view, scroller } = openAt((ref) => <Rows scrollRef={ref} />);
    expect(scroller.scrollTop).toBe(SCROLLED);
    expect(scrolls.filter((s) => s.el === scroller && s.top === 0)).toEqual([]);
    // Rows for offset 3000 under a 2000 px margin: around row 20, not row 0.
    expect(Number(view.getByTestId('rows').dataset['first'])).toBeGreaterThan(10);
  });

  it('keeps an explicit initialOffset', () => {
    function Explicit({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
      const v = useListVirtualizer({ count: 500, getScrollElement: () => scrollRef.current, estimateSize: () => 48, initialOffset: 480 });
      return <div data-testid="rows" data-first={v.getVirtualItems()[0]?.index} />;
    }
    const { view, scroller } = openAt((ref) => <Explicit scrollRef={ref} />);
    expect(scrolls.filter((s) => s.el === scroller).map((s) => s.top)).toContain(480);
    expect(Number(view.getByTestId('rows').dataset['first'])).toBeGreaterThan(0);
  });

  it('the category index opened at the bottom of the landing leaves the page where it was', () => {
    const entries = Array.from({ length: 444 }, (_, i) => ({ id: `c${i}`, name: `Category ${i}`, count: i + 1 }));
    const { view, scroller } = openAt((ref) => <CategoryIndex entries={entries} hrefFor={(id) => `/c/${id}`} scrollRef={ref} label="Categories" />);
    expect(scroller.scrollTop).toBe(SCROLLED);
    expect(scrolls.filter((s) => s.el === scroller && s.top === 0)).toEqual([]);
    expect(view.getAllByRole('listitem').length).toBeGreaterThan(0);
  });
});

describe('category index mounted with its page', () => {
  const LIST_TOP = 4980;

  it('measures its offset once the page ref is attached and renders the rows on screen', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.getAttribute('role') === 'list' ? LIST_TOP - (this.closest('[data-testid="scroller"]')?.scrollTop ?? 0) : 0;
      return { top, bottom: top + 800, left: 0, right: 1280, width: 1280, height: 800, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    const entries = Array.from({ length: 444 }, (_, i) => ({ id: `c${i}`, name: `Category ${i}`, count: i + 1 }));
    function Landing() {
      const ref = useRef<HTMLDivElement>(null);
      // The index is in the page's first commit, as on a cached revisit.
      return (
        <div ref={ref} data-testid="scroller" style={{ height: 800, overflow: 'auto' }}>
          <div>
            <CategoryIndex entries={entries} hrefFor={(id) => `/c/${id}`} scrollRef={ref} label="Categories" />
          </div>
        </div>
      );
    }
    const view = render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>,
    );
    await act(async () => {});
    const scroller = view.getByTestId('scroller');
    // Down to row 50 of the index.
    await act(async () => {
      scroller.scrollTop = LIST_TOP + 50 * 48;
      fireEvent.scroll(scroller);
    });
    const rows = [...view.container.querySelectorAll<HTMLElement>('[role="list"] > div')].map((r) => Math.round(parseFloat(r.style.top) / 48));
    expect(rows).toContain(50);
  });
});
