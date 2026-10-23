/**
 * P2-RAILS-1: a poster rail reads no layout while it mounts. Its edges (whether it scrolls, and so
 * its step buttons) were read in a layout effect, which forced the new page's layout before the
 * browser's own (100 ms on a Movies landing at a 4x CPU slowdown). Now a rail whose cards are wider
 * together than the window scrolls, so it has its step buttons from its first commit; any other
 * rail waits for a ResizeObserver, whose callback comes after layout and puts its reading on screen
 * before paint (flushSync), so the buttons never flash in or out.
 *
 * jsdom has no layout: `layOut()` (fakeResizeObservers) stands in for the browser's.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PosterRail } from '../components/PosterRail';
import { fakeResizeObservers, i18n, installDomStubs, layOutBox, QueryWrapper, spyLayoutReads } from './harness';

/** Sets whether React treats this as a test's act() environment (off: updates schedule as in the app). */
function actEnvironment(on: boolean) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = on;
}

const next = () => screen.queryByRole('button', { name: 'Scroll forward' }) as HTMLButtonElement | null;
const back = () => screen.queryByRole('button', { name: 'Scroll back' }) as HTMLButtonElement | null;

function rail(count: number) {
  return (
    <I18nextProvider i18n={i18n}>
      <PosterRail title="Rail" items={Array.from({ length: count }, (_, i) => i)} cardWidth={150} render={(i) => <span>Card {i}</span>} />
    </I18nextProvider>
  );
}

let observers: ReturnType<typeof fakeResizeObservers>;
beforeAll(installDomStubs);
beforeEach(() => {
  observers = fakeResizeObservers();
});
afterEach(() => {
  actEnvironment(true);
  cleanup();
  observers.restore();
});

describe('P2-RAILS-1: rail edges without a layout read in the commit', () => {
  it('mounts without reading layout, and a row wider than the window has its step buttons at once', () => {
    const reads = spyLayoutReads();
    // 20 cards of 150 px are wider than jsdom's 1024 px window: the rail scrolls, from its start.
    render(rail(20), { wrapper: QueryWrapper });
    expect(reads.count()).toBe(0);
    expect(next()?.disabled).toBe(false);
    expect(back()?.disabled).toBe(true);
    // The observer, after layout, agrees: nothing changes.
    layOutBox(screen.getByRole('list'), { clientWidth: 900, scrollWidth: 3300 });
    act(() => observers.layOut());
    expect(next()?.disabled).toBe(false);
    expect(back()?.disabled).toBe(true);
  });

  it('a row that may fit waits for the observer, whose reading is on screen in the same frame', () => {
    render(rail(5), { wrapper: QueryWrapper });
    expect(next()).toBeNull();
    // 5 cards in a 500 px track: it scrolls after all. The callback runs after layout and before
    // paint; the buttons are in the DOM when it returns, not in a later render.
    layOutBox(screen.getByRole('list'), { clientWidth: 500, scrollWidth: 840 });
    actEnvironment(false);
    observers.layOut();
    expect(next()?.disabled).toBe(false);
    expect(back()?.disabled).toBe(true);
  });

  it('a long row whose track fits loses its step buttons in the same frame', () => {
    render(rail(20), { wrapper: QueryWrapper });
    expect(next()).not.toBeNull();
    layOutBox(screen.getByRole('list'), { clientWidth: 3400, scrollWidth: 3400 });
    actEnvironment(false);
    observers.layOut();
    expect(next()).toBeNull();
    expect(back()).toBeNull();
  });

  it('reads a new list again: a longer one that now scrolls gets its buttons', () => {
    const { rerender } = render(rail(4), { wrapper: QueryWrapper });
    layOutBox(screen.getByRole('list'), { clientWidth: 700, scrollWidth: 700 });
    act(() => observers.layOut());
    expect(next()).toBeNull();
    rerender(rail(6));
    layOutBox(screen.getByRole('list'), { clientWidth: 700, scrollWidth: 1004 });
    act(() => observers.layOut());
    expect(next()?.disabled).toBe(false);
  });
});
