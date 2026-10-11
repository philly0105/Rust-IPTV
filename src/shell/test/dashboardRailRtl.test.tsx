import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DashboardRail, dashRailButtons } from '../dashboard/DashboardRail';

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});
afterEach(cleanup);

describe('R6-r3 F2: dashboard rail step buttons follow the inline direction', () => {
  // scrollWidth 1280, clientWidth 1118: 162 px of travel (the reviewer's "Your sources" rail).
  it('offers only Forward at the start, in LTR and RTL alike', () => {
    expect(dashRailButtons(0, 1280, 1118)).toEqual({ canPrev: false, canNext: true });
  });

  it('offers only Back at the end: +162 in LTR, -162 in RTL', () => {
    expect(dashRailButtons(162, 1280, 1118)).toEqual({ canPrev: true, canNext: false });
    expect(dashRailButtons(-162, 1280, 1118)).toEqual({ canPrev: true, canNext: false });
  });

  it('offers both in the middle and neither when nothing overflows', () => {
    expect(dashRailButtons(-80, 1280, 1118)).toEqual({ canPrev: true, canNext: true });
    expect(dashRailButtons(0, 900, 1118)).toEqual({ canPrev: false, canNext: false });
  });
});

describe('R6-r3 F9: a rail at its start stays there when its items reorder', () => {
  const rail = (items: string[]) => (
    <DashboardRail<string>
      id="t"
      title="Your sources"
      items={items}
      getKey={(s) => s}
      cardWidth={232}
      skeletonAspect={16 / 9}
      renderCard={(s, p) => (
        <a href={`#${s}`} {...p}>
          {s}
        </a>
      )}
    />
  );

  it('resets scrollLeft to 0 after the order changes (scroll snapping followed the old first card)', () => {
    const { container, rerender } = render(rail(['a', 'b', 'c']));
    const track = container.querySelector('ul')!;
    // The browser re-snaps to the previously snapped card once it moves; simulate that jump.
    track.scrollLeft = 162;
    rerender(rail(['c', 'a', 'b']));
    expect(track.scrollLeft).toBe(0);
  });

  it('leaves the position alone when only the data refreshes in the same order', () => {
    const { container, rerender } = render(rail(['a', 'b', 'c']));
    const track = container.querySelector('ul')!;
    track.scrollLeft = 40;
    rerender(rail(['a', 'b', 'c']));
    expect(track.scrollLeft).toBe(40);
  });
});
