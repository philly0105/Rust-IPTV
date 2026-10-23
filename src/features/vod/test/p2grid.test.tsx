/**
 * Second performance pass, grid lane. P2-GRID-1: the movie grid's posters load at the grid's
 * column width without reading their frames as they mount. P2-GRID-2: so do the channel logos of
 * a search. P2-GRID-6: the grid's cells share one page request and its key's hash.
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Channel, ItemRef, Page, PageQuery, VodItem } from '@/api/types';

import { forgetSpots } from '../hooks/useScrollMemory';
import { CategoryGridPage } from '../pages/CategoryGridPage';
import { SearchPage } from '../pages/SearchPage';
import { installDomStubs, makeSource, renderAt, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, calls, call };
});

vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  return {
    ...actual,
    rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);
/** Counts the page requests the grid builds. */
const paging = vi.hoisted(() => ({ built: 0 }));
vi.mock('../lib/paging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/paging')>();
  return {
    ...actual,
    buildPageRequest: (...args: Parameters<typeof actual.buildPageRequest>) => {
      paging.built++;
      return actual.buildPageRequest(...args);
    },
  };
});

const film = (i: number): VodItem => ({
  ref: { sourceId: 'src1', contentType: 'movie', itemId: `f${i}` },
  title: `Film ${i}`,
  categoryId: 'c1',
  posterUrl: `http://cdn.example/f${i}.jpg`,
});
const ALL = Array.from({ length: 30 }, (_, i) => film(i));
const cats: Category[] = [{ id: 'c1', sourceId: 'src1', contentType: 'movie', name: 'Action', hidden: false, itemCount: ALL.length, position: 0 }];

/** Pictures whose box was read (clientWidth and the like, getBoundingClientRect). */
let pictureReads: Element[] = [];

beforeAll(installDomStubs);
beforeEach(() => {
  forgetSpots();
  localStorage.clear();
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  paging.built = 0;
  h['sources.get'] = () => makeSource('src1', 'xtream', 'Alpha IPTV');
  h['sources.list'] = () => [makeSource('src1', 'xtream', 'Alpha IPTV')];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => cats;
  h['catalog.yearFacets'] = () => [];
  h['watchlist.list'] = () => [];
  h['positions.watchedContains'] = () => [] as ItemRef[];
  h['catalog.movies'] = (a) => {
    const q = (a as { query: PageQuery }).query;
    return { items: ALL.slice(q.offset, q.offset + q.limit), total: ALL.length, offset: q.offset, limit: q.limit } satisfies Page<VodItem>;
  };
  h['stalker.search'] = () => ({ items: [], total: 0, offset: 0, limit: 14 });

  pictureReads = [];
  const onPicture = (el: Element) => {
    if (el instanceof HTMLImageElement) pictureReads.push(el);
  };
  for (const prop of ['clientWidth', 'clientHeight'] as const) {
    const get = Object.getOwnPropertyDescriptor(Element.prototype, prop)!.get!;
    vi.spyOn(Element.prototype, prop, 'get').mockImplementation(function (this: Element) {
      onPicture(this);
      return get.call(this) as number;
    });
  }
  for (const prop of ['offsetWidth', 'offsetHeight'] as const) {
    const get = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)!.get!;
    vi.spyOn(HTMLElement.prototype, prop, 'get').mockImplementation(function (this: HTMLElement) {
      onPicture(this);
      return get.call(this) as number;
    });
  }
  const rect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    onPicture(this);
    return rect.call(this);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const sizeOf = (img: HTMLImageElement) => /[?&]w=(\d+)/.exec(img.getAttribute('src') ?? '')?.[1];

describe('P2-GRID-1: the movie grid', () => {
  it("loads its posters at the column width, rounded, and never reads a poster's box", async () => {
    renderAt('/s/src1/movies/c/c1', [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }]);
    await screen.findByText('Film 0');
    const grid = screen.getByTestId('vod-grid');
    await waitFor(() => expect(grid.querySelectorAll('img').length).toBeGreaterThan(0));
    const imgs = [...grid.querySelectorAll('img')];
    // jsdom lays nothing out, so the grid keeps its 960 px guess: five 164 px (medium) columns
    // with 16 px gaps are 179.2 px wide, which the cache serves from its 192 px copy.
    expect(imgs.map(sizeOf)).toEqual(imgs.map(() => '192'));
    expect(pictureReads).toEqual([]);
  });

  it("P2-GRID-6: builds a page's request once, not on every cell's render", async () => {
    renderAt('/s/src1/movies/c/c1', [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }]);
    await screen.findByText('Film 0');
    const cells = screen.getByTestId('vod-grid').querySelectorAll('[role="option"]').length;
    expect(cells).toBeGreaterThan(10);
    // One page per grid input (a source arriving late can make a second input): every cell and the
    // page's own count read the same request. It was built again on every cell's render.
    expect(paging.built).toBeLessThanOrEqual(2);
  });
});

describe('P2-GRID-2: search', () => {
  it("loads the channel logos at the logo's width without reading their boxes", async () => {
    const channel = { ref: { sourceId: 'src1', contentType: 'live', itemId: 'c1' }, name: 'Film News', categoryId: 'g', isRadio: false, logoUrl: 'http://cdn.example/news.png' } as Channel;
    rpcMock.handlers['catalog.search'] = () => ({ live: [channel], movies: [film(0)], series: [] });
    renderAt('/search?q=film', [{ path: '/search', element: <SearchPage /> }]);
    const logo = await screen.findByRole('img', { name: 'Film News' });
    // w-12 is 45 px at 100 %: the 64 px copy, as the measured frame asked for.
    expect(sizeOf(logo as HTMLImageElement)).toBe('64');
    expect(pictureReads).toEqual([]);
  });
});
