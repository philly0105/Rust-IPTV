/**
 * Review round 3 (movies and series on a Stalker portal): the landing has no Top rated rail, since
 * a portal sorts by name or date added only; with Hide watched, the landing's and the detail
 * pages' category rails leave out watched titles themselves, as the grid does, because the portal
 * cannot filter them.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, ItemRef, Page, PageQuery, VodDetail, VodItem } from '@/api/types';

import { forgetSpots } from '../hooks/useScrollMemory';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { VodLandingPage } from '../pages/VodLandingPage';
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

/** An IntersectionObserver that reports every observed element as on screen at once. */
class EagerObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const OFF = { enabled: false, mode: 'hide', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 };
const cat = (id: string, name: string): Category => ({ id, sourceId: 'src1', contentType: 'movie', name, hidden: false, itemCount: 0, position: 0 });
const movie = (i: number): VodItem => ({ ref: { sourceId: 'src1', contentType: 'movie', itemId: `m${i}` }, title: `Movie ${i}`, categoryId: 'c1', year: 2020 });
const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
/** The portal's first page of a category: 30 titles, whatever was asked (it filters nothing). */
const PAGE = Array.from({ length: 30 }, (_, i) => movie(i));
let watchedIds = new Set<string>();
/** Holds the watched lookup until the test lets it answer. */
let lookupGate: Promise<void> | null = null;

const railOf = (name: RegExp) => screen.getByRole('heading', { name }).closest('section')!;
const titlesIn = (el: HTMLElement) => within(el).queryAllByRole('link', { name: /^Movie \d+/ }).map((a) => a.getAttribute('aria-label') ?? a.textContent);

beforeAll(installDomStubs);
beforeEach(() => {
  forgetSpots();
  localStorage.clear();
  watchedIds = new Set();
  lookupGate = null;
  rpcMock.calls.length = 0;
  vi.stubGlobal('IntersectionObserver', EagerObserver);
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  const src = makeSource('src1', 'stalker', 'Portal');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings({ vodHideWatched: true });
  h['parental.status'] = () => OFF;
  h['parental.locks'] = () => [];
  h['catalog.categories'] = () => [cat('c1', 'Action')];
  h['positions.continueWatching'] = () => [];
  h['watchlist.list'] = () => [];
  h['favorites.contains'] = () => [];
  h['downloads.list'] = () => [];
  h['positions.get'] = () => null;
  h['stalker.movies'] = (a) => {
    const q = (a as { query: PageQuery }).query;
    return { items: PAGE.slice(q.offset, q.offset + q.limit), total: PAGE.length, offset: q.offset, limit: q.limit } satisfies Page<VodItem>;
  };
  h['positions.watchedContains'] = async (a) => {
    if (lookupGate) await lookupGate;
    return (a as { refs: ItemRef[] }).refs.filter((r) => watchedIds.has(r.itemId));
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(() => localStorage.clear());

const landing = () => renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);

describe('the Stalker landing', () => {
  it('has no Top rated rail: the portal would answer the newest titles under that name', async () => {
    landing();
    await screen.findByRole('heading', { name: /^Action/ });
    expect(screen.queryByRole('heading', { name: /^Top rated/ })).toBeNull();
    await waitFor(() => expect(callsOf('stalker.movies').length).toBeGreaterThan(0));
    expect(callsOf('stalker.movies').every((a) => (a as { query: PageQuery }).query.sort !== 'rating')).toBe(true);
  });

  it('with Hide watched, a category rail leaves out watched titles before it takes its 20', async () => {
    watchedIds = new Set(['m0', 'm1', 'm5']);
    landing();
    await screen.findByRole('heading', { name: /^Action/ });
    await waitFor(() => expect(titlesIn(railOf(/^Action/)).length).toBe(20));
    const shown = titlesIn(railOf(/^Action/)).join(' | ');
    for (const id of ['Movie 0', 'Movie 1', 'Movie 5']) expect(shown).not.toMatch(new RegExp(`\\b${id}\\b`));
    // The slice is taken after the filter: the rail still fills up from the rest of the page.
    expect(shown).toMatch(/\bMovie 22\b/);
    // The portal was not asked to filter (it cannot).
    expect(callsOf('stalker.movies').every((a) => !('hideWatched' in (a as object)))).toBe(true);
  });

  it('shows no title before the watched lookup has answered', async () => {
    watchedIds = new Set(['m0']);
    let answer!: () => void;
    lookupGate = new Promise((resolve) => (answer = resolve));
    landing();
    await screen.findByRole('heading', { name: /^Action/ });
    await waitFor(() => expect(callsOf('stalker.movies').length).toBeGreaterThan(0));
    await waitFor(() => expect(callsOf('positions.watchedContains').length).toBeGreaterThan(0));
    expect(titlesIn(railOf(/^Action/))).toEqual([]);
    answer();
    await waitFor(() => expect(titlesIn(railOf(/^Action/)).length).toBe(20));
    expect(titlesIn(railOf(/^Action/)).join(' | ')).not.toMatch(/\bMovie 0\b/);
  });
});

describe('the Stalker movie page', () => {
  const mref: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm3' };
  const detail: VodDetail = { item: { ref: mref, title: 'Movie 3', categoryId: 'c1', categoryName: 'Action' }, cast: [], backdrops: [], providerDetailsUnavailable: false };

  it('with Hide watched, "More in" the category leaves out watched titles and the title itself', async () => {
    watchedIds = new Set(['m2', 'm4']);
    rpcMock.handlers['stalker.vodDetail'] = () => detail;
    renderAt('/s/src1/movie/m3', [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }]);
    await screen.findByRole('heading', { name: /More in Action/ });
    // The placeholder section gives way to the rail once it nears the view.
    await waitFor(() => expect(titlesIn(railOf(/More in Action/)).length).toBe(20));
    const shown = titlesIn(railOf(/More in Action/)).join(' | ');
    for (const id of ['Movie 2', 'Movie 3', 'Movie 4']) expect(shown).not.toMatch(new RegExp(`\\b${id}\\b`));
  });
});
