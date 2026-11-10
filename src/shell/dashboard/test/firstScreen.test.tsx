/**
 * Home's first screen first (firstScreen.ts): until Home has painted once, a rail draws the cards
 * that fit across the window, a rail below the window's foot its skeleton, and the rest mounts
 * right after that frame, on the first key or press, or at once for a rail's own arrow keys.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import '@/i18n';

import { installDomStubs } from '../../test/harness';
import { DashboardRail } from '../DashboardRail';
import { RailDeferContext, firstScreenCards, railLeastHeight, sectionsBelowFold, setFirstScreenDeferral } from '../firstScreen';

beforeAll(installDomStubs);
beforeEach(() => setFirstScreenDeferral(true));
afterEach(() => {
  cleanup();
  setFirstScreenDeferral(false);
});

const ITEMS = Array.from({ length: 20 }, (_, i) => `t${i}`);

function rail(id = 'r', items: readonly string[] = ITEMS) {
  return (
    <DashboardRail<string>
      id={id}
      title={`Rail ${id}`}
      items={items}
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
}

const cards = (id = 'r') => within(screen.getByRole('region', { name: `Rail ${id}` })).queryAllByRole('link');
/** Lets the frame the first commit paints go by (rAF, then a posted task). */
const afterPaint = () => act(() => new Promise<void>((r) => setTimeout(r, 50)));

describe('firstScreenCards', () => {
  it('is as many cards as fit across the window, and one more', () => {
    expect(firstScreenCards(168, 1440)).toBe(10);
    expect(firstScreenCards(280, 1440)).toBe(7);
    expect(firstScreenCards(240, 390)).toBe(3);
    // Nothing to go by: no cap.
    expect(firstScreenCards(0, 1440)).toBe(Number.POSITIVE_INFINITY);
    expect(firstScreenCards(168, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('sectionsBelowFold', () => {
  it('names the sections whose least top is past the fold, counting only sections that draw', () => {
    const sections = [
      { key: 'a', height: 300 },
      { key: 'empty', height: 0 },
      { key: 'b', height: 300 },
      { key: 'c', height: 300 },
      { key: 'd', height: 300 },
    ];
    // a at 400, b at 740, c at 1080, d at 1420 (gap 40).
    expect([...sectionsBelowFold(sections, 400, 40, 900)]).toEqual(['c', 'd']);
    // An empty section after the fold is "below" too, but adds no height.
    expect([...sectionsBelowFold(sections, 1000, 40, 900)]).toEqual(['a', 'empty', 'b', 'c', 'd']);
    expect(sectionsBelowFold(sections, 0, 40, 5000).size).toBe(0);
  });

  it('takes a rail at no more than its artwork and the least room around it', () => {
    expect(railLeastHeight(168, 2 / 3)).toBe(252 + 80);
    expect(railLeastHeight(280, 16 / 9)).toBe(157 + 80);
  });
});

describe('a Home rail before Home has painted', () => {
  it('draws the cards that fit across the window, then the whole row after the first frame', async () => {
    const fit = firstScreenCards(168, window.innerWidth);
    expect(fit).toBeLessThan(ITEMS.length);
    render(<MemoryRouter>{rail()}</MemoryRouter>);
    expect(cards()).toHaveLength(fit);
    await afterPaint();
    expect(cards()).toHaveLength(ITEMS.length);
  });

  it('mounts the whole row at once for End, so the key reaches the last card', () => {
    render(<MemoryRouter>{rail()}</MemoryRouter>);
    const first = cards()[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: 'End' });
    expect(cards()).toHaveLength(ITEMS.length);
    expect(document.activeElement?.textContent).toBe('t19');
  });

  it('mounts every rail on the first key or press anywhere', async () => {
    render(
      <MemoryRouter>
        {rail('one')}
        {rail('two')}
      </MemoryRouter>,
    );
    expect(cards('one').length).toBeLessThan(ITEMS.length);
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    await waitFor(() => expect(cards('two')).toHaveLength(ITEMS.length));
    expect(cards('one')).toHaveLength(ITEMS.length);
  });

  it('a rail below the fold shows its skeleton until then, with its heading', async () => {
    render(
      <MemoryRouter>
        {rail('top')}
        <RailDeferContext.Provider value>{rail('below')}</RailDeferContext.Provider>
      </MemoryRouter>,
    );
    const below = screen.getByRole('region', { name: 'Rail below' });
    expect(within(below).getByRole('heading', { name: 'Rail below' })).toBeTruthy();
    expect(cards('below')).toHaveLength(0);
    expect(below.querySelectorAll('[data-rail-skeleton-card]').length).toBeGreaterThan(0);
    await afterPaint();
    expect(cards('below')).toHaveLength(ITEMS.length);
    expect(below.querySelectorAll('[data-rail-skeleton-card]')).toHaveLength(0);
  });

  it('a short row is drawn whole, and once Home has painted every rail draws its whole row at once', async () => {
    render(<MemoryRouter>{rail('short', ['a', 'b', 'c'])}</MemoryRouter>);
    expect(cards('short')).toHaveLength(3);
    await afterPaint();
    cleanup();
    render(
      <MemoryRouter>
        <RailDeferContext.Provider value>{rail('later')}</RailDeferContext.Provider>
      </MemoryRouter>,
    );
    expect(cards('later')).toHaveLength(ITEMS.length);
  });
});

describe('without the deferral (unit tests, a later visit)', () => {
  it('draws every card in the first commit', () => {
    setFirstScreenDeferral(false);
    render(
      <MemoryRouter>
        <RailDeferContext.Provider value>{rail()}</RailDeferContext.Provider>
      </MemoryRouter>,
    );
    expect(cards()).toHaveLength(ITEMS.length);
  });
});
