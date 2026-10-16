import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DashboardRail } from '../DashboardRail';

// L2-sources-home-2: reading scrollLeft right after a rail's DOM went in forced a layout of the
// whole page per rail on a cold Home. A fresh track sits at 0, so mounting must not read it.
const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft')!;
let reads = 0;

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  Object.defineProperty(Element.prototype, 'scrollLeft', {
    configurable: true,
    get(this: Element) {
      reads += 1;
      return original.get!.call(this);
    },
    set(this: Element, v: number) {
      original.set!.call(this, v);
    },
  });
});
afterAll(() => {
  Object.defineProperty(Element.prototype, 'scrollLeft', original);
});
afterEach(() => {
  cleanup();
  reads = 0;
});

const rail = (items: string[] | undefined, loading = false) => (
  <DashboardRail<string>
    id="perf"
    title="Rail"
    items={items}
    loading={loading}
    getKey={(s) => s}
    cardWidth={168}
    skeletonAspect={2 / 3}
    renderCard={(s, p) => (
      <a href={`#${s}`} {...p}>
        {s}
      </a>
    )}
  />
);

describe('L2-sources-home-2: a rail mounts without a layout read', () => {
  it('does not read scrollLeft when it mounts with items', () => {
    render(rail(['a', 'b', 'c']));
    expect(reads).toBe(0);
  });

  it('does not read scrollLeft when its first items replace the skeleton', () => {
    const { rerender, container } = render(rail(undefined, true));
    expect(container.querySelector('ul')).toBeNull();
    rerender(rail(['a', 'b']));
    expect(container.querySelector('ul')).toBeTruthy();
    expect(reads).toBe(0);
  });

  it('still checks the position when the items reorder later', () => {
    const { rerender, container } = render(rail(['a', 'b', 'c']));
    const track = container.querySelector('ul')!;
    track.scrollLeft = 162;
    reads = 0;
    rerender(rail(['c', 'a', 'b']));
    expect(reads).toBe(1);
    expect(track.scrollLeft).toBe(0);
  });
});
