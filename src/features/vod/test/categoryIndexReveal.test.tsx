/**
 * Where "Browse all categories" leaves the landing when it opens.
 *
 * - IDX-2: opened from its heading at the bottom of the page, the index mounted under the fold;
 *   the heading now goes to the top the way the All categories chip takes it. Higher up the page
 *   stays where it is.
 * - IDX-3: the open index takes at least a screen, so a narrowing filter cannot shorten the page
 *   under the view (the browser clamped the scroll and the filter field dropped down the view).
 * - IDX-M1: All categories pressed while the categories load is not undone by the landing's
 *   scroll memory when they arrive, and the heading is taken to the top again once the rails they
 *   bring sit above it. The press belongs to its landing: the page stays mounted when another
 *   source's landing opens, and that one restores its own offset.
 *
 * jsdom has no layout: the tests place the heading with getBoundingClientRect and give the
 * scroller a height, and stand in for the scroll with the scrollIntoView calls.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useNavigate } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category } from '@/api/types';

import { forgetSpots, rememberSpot } from '../hooks/useScrollMemory';
import { CATEGORY_INDEX_KEY, VodLandingPage } from '../pages/VodLandingPage';
import { currentLocation, findIndexLink, i18n, installDomStubs, makeSource, renderAt, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const call = async (cmd: string, args?: unknown) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, call };
});

vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const cats: Category[] = Array.from({ length: 40 }, (_, i) => ({
  id: `c${i}`,
  sourceId: 'src1',
  contentType: 'movie',
  name: `Category ${i}`,
  hidden: false,
  itemCount: 10,
  position: i,
}));

/** The scroller's visible height and where the heading's button sits in the viewport. */
const VIEWPORT = 800;
let toggleTop = 0;

beforeAll(installDomStubs);
beforeEach(() => {
  forgetSpots();
  localStorage.clear();
  toggleTop = 0;
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.hasAttribute('aria-controls') ? toggleTop : 0;
    return { top, bottom: top + 40, left: 0, right: 1200, width: 1200, height: 40, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  h['sources.get'] = () => makeSource('src1', 'xtream', 'Alpha IPTV');
  h['settings.get'] = () => settings({});
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['parental.locks'] = () => [];
  h['catalog.categories'] = () => cats;
  h['catalog.recentlyAdded'] = () => [];
  h['positions.continueWatching'] = () => [];
  h['positions.watchedContains'] = () => [];
  h['watchlist.list'] = () => [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const landing = () => renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);

/** The heading's disclosure, once the categories are in. */
async function heading(): Promise<HTMLElement> {
  await screen.findAllByTestId('vod-category-chip');
  return screen.getByRole('button', { name: i18n.t('vod:browseAllCategories') });
}

/** The elements scrollIntoView was called on. */
function revealed(spy: { mock: { contexts: unknown[] } }): unknown[] {
  return spy.mock.contexts;
}

describe('IDX-2: opening the index from its heading', () => {
  it('takes the heading to the top when it sits in the lower half of the view', async () => {
    landing();
    const toggle = await heading();
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
    toggleTop = VIEWPORT - 60;
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(revealed(spy)).toContain(toggle);
    expect(spy).toHaveBeenCalledWith({ block: 'start' });
    expect(document.activeElement).toBe(toggle);
    expect(await findIndexLink(/Category 3/)).toBeTruthy();
  });

  it('leaves the page still when the heading is in the upper half, and when it closes', async () => {
    landing();
    const toggle = await heading();
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
    toggleTop = 200;
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggleTop = VIEWPORT - 60;
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(revealed(spy)).toEqual([]);
  });
});

describe('IDX-3: the open index keeps a screen of height', () => {
  /** The index body the heading's disclosure controls. */
  const body = (toggle: HTMLElement) => document.getElementById(toggle.getAttribute('aria-controls')!)!;

  it('remembered open, it takes the height of the view as its minimum, filtered or not', async () => {
    localStorage.setItem(CATEGORY_INDEX_KEY, '1');
    landing();
    const toggle = await heading();
    await waitFor(() => expect(body(toggle).style.minHeight).toBe(`${VIEWPORT}px`));
    // A filter that leaves one category keeps the floor.
    fireEvent.change(screen.getByPlaceholderText(i18n.t('vod:filterCategories')), { target: { value: 'Category 39' } });
    expect(await findIndexLink(/Category 39/)).toBeTruthy();
    expect(body(toggle).style.minHeight).toBe(`${VIEWPORT}px`);
    fireEvent.click(toggle);
    expect(body(toggle).hidden).toBe(true);
    expect(body(toggle).style.minHeight).toBe('');
  });

  it('opened from the chip, it gets the same floor', async () => {
    landing();
    const toggle = await heading();
    expect(body(toggle).style.minHeight).toBe('');
    fireEvent.click(screen.getByTestId('vod-chip-all'));
    await waitFor(() => expect(body(toggle).style.minHeight).toBe(`${VIEWPORT}px`));
  });
});

describe('IDX-M1: All categories pressed while the categories load', () => {
  // jsdom has no scrolling: back scrollTop with a per-element store so offsets can be written and read.
  const scrollTops = new WeakMap<Element, number>();
  const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  beforeAll(() => {
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element) {
        return scrollTops.get(this) ?? 0;
      },
      set(this: Element, v: number) {
        scrollTops.set(this, v);
      },
    });
  });
  afterAll(() => {
    if (originalScrollTop) Object.defineProperty(Element.prototype, 'scrollTop', originalScrollTop);
  });

  /** Holds the categories answer until `release`. */
  function slowCategories() {
    let release: () => void = () => undefined;
    const answer = new Promise<Category[]>((resolve) => {
      release = () => resolve(cats);
    });
    rpcMock.handlers['catalog.categories'] = () => answer;
    return () => release();
  }
  const frames = () => new Promise((r) => setTimeout(r, 50));

  it('the remembered offset does not undo the press, and the heading goes to the top once they arrive', async () => {
    rememberSpot('/s/src1/movies', { scrollTop: 1500 });
    const release = slowCategories();
    landing();
    const scroller = await screen.findByTestId('vod-landing-movie');
    const toggle = screen.getByRole('button', { name: i18n.t('vod:browseAllCategories') });
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
    fireEvent.click(screen.getByTestId('vod-chip-all'));
    expect(revealed(spy)).toEqual([toggle]);

    release();
    expect(await findIndexLink(/Category 3/)).toBeTruthy();
    await frames();
    expect(scroller.scrollTop).not.toBe(1500);
    expect(revealed(spy)).toEqual([toggle, toggle]);
    expect(document.activeElement).toBe(toggle);
  });

  it('without a press, the remembered offset still comes back once they arrive', async () => {
    rememberSpot('/s/src1/movies', { scrollTop: 1500 });
    const release = slowCategories();
    landing();
    const scroller = await screen.findByTestId('vod-landing-movie');
    release();
    await screen.findAllByTestId('vod-category-chip');
    await waitFor(() => expect(scroller.scrollTop).toBe(1500));
  });

  it.each(['after', 'before'])("a press on one source's landing %s its categories came leaves the next source's landing alone", async (when) => {
    // One route for every source, so React Router keeps the page mounted from A's landing to B's.
    rpcMock.handlers['sources.get'] = (a) => makeSource((a as { id: string }).id, 'xtream', 'Alpha IPTV');
    if (when === 'before') {
      rpcMock.handlers['catalog.categories'] = (a) => ((a as { sourceId: string }).sourceId === 'src1' ? new Promise(() => undefined) : cats);
    }
    rememberSpot('/s/src2/movies', { scrollTop: 900 });
    let go: (to: string) => void = () => undefined;
    function NavProbe() {
      const navigate = useNavigate();
      go = (to) => void navigate(to);
      return null;
    }
    renderAt('/s/src1/movies', [
      {
        path: '/s/:sourceId/movies',
        element: (
          <>
            <NavProbe />
            <VodLandingPage kind="movie" />
          </>
        ),
      },
    ]);
    if (when === 'after') await heading();
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
    fireEvent.click(await screen.findByTestId('vod-chip-all'));
    expect(spy).toHaveBeenCalledTimes(1);
    const scroller = screen.getByTestId('vod-landing-movie');
    scroller.scrollTop = 300;
    act(() => go('/s/src2/movies'));
    await waitFor(() => expect(currentLocation).toBe('/s/src2/movies'));
    expect(screen.getByTestId('vod-landing-movie')).toBe(scroller);
    // B's remembered offset comes back, and A's pending reveal does not move B's page.
    await waitFor(() => expect(scroller.scrollTop).toBe(900));
    await frames();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
