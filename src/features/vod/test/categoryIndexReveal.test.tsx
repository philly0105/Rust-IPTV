/**
 * Where "Browse all categories" leaves the landing when it opens.
 *
 * - IDX-2: opened from its heading at the bottom of the page, the index mounted under the fold;
 *   the heading now goes to the top the way the All categories chip takes it. Higher up the page
 *   stays where it is.
 *
 * jsdom has no layout: the tests place the heading with getBoundingClientRect and give the
 * scroller a height, and stand in for the scroll with the scrollIntoView calls.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category } from '@/api/types';

import { forgetSpots } from '../hooks/useScrollMemory';
import { VodLandingPage } from '../pages/VodLandingPage';
import { findIndexLink, i18n, installDomStubs, makeSource, renderAt, settings } from './harness';

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
