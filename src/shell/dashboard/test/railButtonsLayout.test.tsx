/**
 * P2-HOME-1 and P2-HOME-2: a Home rail mounts without reading layout and without rendering its
 * cards twice. Its step buttons were set from the track's ResizeObserver in a later render, which
 * rendered all 24 cards of a rail that scrolls a second time and laid the page out again. Now a
 * rail whose cards are wider together than the window has its Forward button from its first
 * commit; any other rail waits for the observer, whose callback comes after layout and puts a
 * reading that differs on screen before paint (flushSync). The rail's own state (its buttons, its
 * Tab stop) no longer re-renders the cards it does not change.
 *
 * jsdom has no layout: `layOut()` (fakeResizeObservers) stands in for the browser's.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { actEnvironment, fakeResizeObservers, installDomStubs, layOutBox, spyLayoutReads } from '../../test/harness';
import { DashboardRail } from '../DashboardRail';

const forward = () => screen.queryByRole('button', { name: i18next.t('shell:scrollForward') });
const back = () => screen.queryByRole('button', { name: i18next.t('shell:scrollBack') });
const track = () => screen.getByRole('list');

const names = (n: number) => Array.from({ length: n }, (_, i) => `card-${i}`);

/** A rail of `items`; `renders` counts each card's renders. */
function rail(items: string[], renders: (name: string) => void) {
  return (
    <DashboardRail<string>
      id="perf"
      title="Rail"
      items={items}
      getKey={(s) => s}
      cardWidth={168}
      skeletonAspect={2 / 3}
      renderCard={(s, p) => {
        renders(s);
        return (
          <a href={`#${s}`} {...p}>
            {s}
          </a>
        );
      }}
    />
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

describe('P2-HOME-1: rail step buttons without a second render', () => {
  it('mounts without reading layout, and a row wider than the window has Forward at once', () => {
    const reads = spyLayoutReads();
    const renders = vi.fn();
    // 24 cards of 168 px are wider than jsdom's 1024 px window: the rail scrolls, from its start.
    render(rail(names(24), renders));
    expect(reads.count()).toBe(0);
    expect(forward()).not.toBeNull();
    expect(back()).toBeNull();
    expect(renders).toHaveBeenCalledTimes(24);
    // The observer, after layout, agrees: nothing renders again.
    layOutBox(track(), { clientWidth: 1000, scrollWidth: 4400 });
    act(() => observers.layOut());
    expect(forward()).not.toBeNull();
    expect(back()).toBeNull();
    expect(renders).toHaveBeenCalledTimes(24);
  });

  it('a short row that overflows after all gets Forward in the same frame', () => {
    render(rail(names(3), () => undefined));
    expect(forward()).toBeNull();
    // The callback runs after layout and before paint: the button is in the DOM when it returns.
    layOutBox(track(), { clientWidth: 400, scrollWidth: 600 });
    actEnvironment(false);
    observers.layOut();
    expect(forward()).not.toBeNull();
    expect(back()).toBeNull();
  });

  it('a long row whose track fits loses Forward in the same frame', () => {
    render(rail(names(24), () => undefined));
    expect(forward()).not.toBeNull();
    layOutBox(track(), { clientWidth: 4400, scrollWidth: 4400 });
    actEnvironment(false);
    observers.layOut();
    expect(forward()).toBeNull();
  });
});

describe('P2-HOME-2: the rail re-renders only the cards that change', () => {
  it('a scroll that brings Back, and a move of the Tab stop, leave the other cards alone', () => {
    const renders = vi.fn();
    render(rail(names(24), renders));
    act(() => observers.layOut());
    renders.mockClear();

    layOutBox(track(), { clientWidth: 1000, scrollWidth: 4400, scrollLeft: 300 });
    act(() => void fireEvent.scroll(track()));
    expect(back()).not.toBeNull();
    expect(renders).not.toHaveBeenCalled();

    // The Tab stop moves from the first card to the fourth: those two render again.
    act(() => screen.getByText('card-3').focus());
    expect(screen.getByText('card-3').tabIndex).toBe(0);
    expect(screen.getByText('card-0').tabIndex).toBe(-1);
    expect(renders.mock.calls.map(([name]) => name).sort()).toEqual(['card-0', 'card-3']);
  });
});
