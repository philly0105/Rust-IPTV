import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useListVirtualizer } from '..';

/**
 * P2-LIVE-1: a virtualized list mounts without reading layout. react-virtual read its scroller's
 * offsetWidth and offsetHeight as it attached, in the layout effects of the commit that mounted
 * the page, and scrolled the scroller to its start offset there: either forces the new page's
 * layout (78 ms of Live's cold open at a 4x CPU slowdown). The size now comes from the
 * ResizeObserver's first callback, which a browser runs after its own layout.
 */

type Callback = (entries: { borderBoxSize: { inlineSize: number; blockSize: number }[] }[]) => void;
let observers: { cb: Callback; targets: Element[] }[] = [];
let scrolls: (number | undefined)[] = [];
const originalScrollTo = Element.prototype.scrollTo;

beforeEach(() => {
  observers = [];
  scrolls = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private entry: { cb: Callback; targets: Element[] };
      constructor(cb: Callback) {
        this.entry = { cb, targets: [] };
        observers.push(this.entry);
      }
      observe(el: Element) {
        this.entry.targets.push(el);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollTo = function scrollTo(arg?: ScrollToOptions | number) {
    scrolls.push(typeof arg === 'object' ? arg.top : undefined);
  } as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Element.prototype.scrollTo = originalScrollTo;
});

/** Spies on every layout read and scroll write a mount could make. */
function spyOnLayout() {
  const getters = [
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get'),
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get'),
    vi.spyOn(Element.prototype, 'clientWidth', 'get'),
    vi.spyOn(Element.prototype, 'clientHeight', 'get'),
    vi.spyOn(Element.prototype, 'scrollHeight', 'get'),
    vi.spyOn(Element.prototype, 'scrollTop', 'get'),
    vi.spyOn(Element.prototype, 'scrollTop', 'set'),
    vi.spyOn(Element.prototype, 'scrollLeft', 'get'),
  ];
  const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect');
  return () => getters.reduce((n, s) => n + s.mock.calls.length, 0) + rect.mock.calls.length + scrolls.length;
}

const ROW = 48;

function List({ initialRect, initialOffset }: { initialRect?: { width: number; height: number }; initialOffset?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const v = useListVirtualizer({ count: 1000, getScrollElement: () => ref.current, estimateSize: () => ROW, overscan: 2, initialRect, initialOffset });
  return (
    <div ref={ref} data-testid="scroller" style={{ height: 300, overflow: 'auto' }}>
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((r) => (
          <div key={r.key} data-row={r.index} style={{ position: 'absolute', top: r.start, height: ROW }} />
        ))}
      </div>
    </div>
  );
}

const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-row]')].map((r) => Number(r.dataset['row']));

/** The scroller's ResizeObserver reports `height`, as a browser does after laying it out. */
function report(scroller: Element, height: number) {
  const o = observers.find((x) => x.targets.includes(scroller));
  if (!o) throw new Error('the scroller is not observed');
  o.cb([{ borderBoxSize: [{ inlineSize: 320, blockSize: height }] }]);
}

describe('useListVirtualizer mounting', () => {
  it('reads no layout and writes no scroll offset while the list mounts', () => {
    const touched = spyOnLayout();
    const view = render(<List />);
    expect(touched()).toBe(0);
    // Until the scroller's size is in, the window's stands in: every row a window can show is there.
    const last = Math.max(...rows(view.container));
    expect((last + 1) * ROW).toBeGreaterThanOrEqual(window.innerHeight);
  });

  it('takes the size from the first ResizeObserver callback', () => {
    const view = render(<List />);
    const before = rows(view.container).length;
    act(() => report(view.getByTestId('scroller'), 240));
    // 240 px: rows 0 to 4 on screen and the overscan after them.
    expect(rows(view.container)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(before).toBeGreaterThan(7);
  });

  it('renders the rows a larger first size shows before the callback returns', () => {
    const view = render(<List initialRect={{ width: 320, height: 96 }} />);
    expect(Math.max(...rows(view.container))).toBeLessThan(10);
    // Outside act, as in a browser: the callback runs between layout and paint, so the rows
    // that size adds must be in the DOM when it returns, not a render later.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const was = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      report(view.getByTestId('scroller'), 960);
      expect(Math.max(...rows(view.container))).toBe(21);
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = was;
    }
  });

  it('still scrolls to an initialOffset the scroller is not at', () => {
    const view = render(<List initialOffset={480} />);
    expect(scrolls).toEqual([480]);
    expect(Math.min(...rows(view.container))).toBe(8);
  });
});
