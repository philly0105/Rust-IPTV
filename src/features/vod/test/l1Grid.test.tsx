/**
 * L1 grid fixes: the search empty state wins over filter states (L1-vod-7), Escape steps back
 * instead of stacking grid/landing pairs (L1-vod-10), Shift+W keeps focus in the grid
 * (L1-vod-15), and a removed source or category gets its own page body (L1-vod-13).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType, type InitialEntry } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RpcError } from '@/api/transport';
import type { Category, ItemRef, Page, PageQuery, Settings, VodItem } from '@/api/types';

import { forgetSpots, rememberSpot } from '../hooks/useScrollMemory';
import { CategoryGridPage } from '../pages/CategoryGridPage';
import { CATEGORY_INDEX_KEY, VodLandingPage } from '../pages/VodLandingPage';
import { currentLocation, i18n, installDomStubs, makeSource, renderAt, settings } from './harness';

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

const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);
const GRID_PATH = '/s/:sourceId/movies/c/:categoryId';
const gridRoute = [{ path: GRID_PATH, element: <CategoryGridPage kind="movie" /> }];

const TOTAL = 30;
const film = (i: number): VodItem => ({
  ref: { sourceId: 'src1', contentType: 'movie', itemId: `f${i}` },
  title: `Film ${i}`,
  categoryId: 'c1',
  year: 1990 + (i % 20),
});
const ALL = Array.from({ length: TOTAL }, (_, i) => film(i));
const cats: Category[] = [{ id: 'c1', sourceId: 'src1', contentType: 'movie', name: 'Action', hidden: false, itemCount: TOTAL, position: 0 }];
let watchedIds = new Set<string>();
let patch: Partial<Settings> = {};

function handlers() {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => makeSource('src1', 'xtream', 'Alpha IPTV');
  h['settings.get'] = () => settings(patch);
  h['settings.update'] = (a) => {
    patch = { ...patch, ...(a as { patch: Partial<Settings> }).patch };
    return settings(patch);
  };
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => cats;
  h['catalog.recentlyAdded'] = () => [];
  h['catalog.yearFacets'] = () => [];
  h['positions.continueWatching'] = () => [];
  h['watchlist.list'] = () => [];
  h['positions.watchedContains'] = (a) => (a as { refs: ItemRef[] }).refs.filter((r) => watchedIds.has(r.itemId));
  // Like the core: search, year bounds and hideWatched filter, and `total` counts the filtered set.
  h['catalog.movies'] = (a) => {
    const { query: q, yearFrom, yearTo, hideWatched } = a as { query: PageQuery; yearFrom?: number; yearTo?: number; hideWatched?: boolean };
    const all = ALL.filter(
      (f) =>
        (!q.search || f.title.toLowerCase().includes(q.search.toLowerCase())) &&
        (yearFrom === undefined || f.year! >= yearFrom) &&
        (yearTo === undefined || f.year! <= yearTo) &&
        !(hideWatched && watchedIds.has(f.ref.itemId)),
    );
    return { items: all.slice(q.offset, q.offset + q.limit), total: all.length, offset: q.offset, limit: q.limit } satisfies Page<VodItem>;
  };
}

/** Records how the router reached the current entry (POP for navigate(-1), REPLACE, PUSH). */
let navType = '';
let locState: unknown;
function NavProbe() {
  navType = useNavigationType();
  locState = useLocation().state;
  return null;
}

function Landing() {
  return (
    <div data-testid="landing">
      <VodLandingPage kind="movie" />
    </div>
  );
}

function renderWithHistory(entries: InitialEntry[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
          <NavProbe />
          <Routes>
            <Route path="/s/:sourceId/movies" element={<Landing />} />
            <Route path={GRID_PATH} element={<CategoryGridPage kind="movie" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeAll(installDomStubs);
beforeEach(() => {
  watchedIds = new Set();
  patch = {};
  handlers();
  forgetSpots();
  localStorage.clear();
});
afterEach(() => cleanup());

describe('L1-vod-7: empty states name the search first', () => {
  it('a query with no match inside a year range shows the search state, and clearing it shows the year state', async () => {
    renderAt('/s/src1/movies/c/c1?q=zzz&yf=1990&yt=1991', gridRoute);
    await screen.findByText(i18n.t('vod:noSearchMatchTitle', { query: 'zzz' }));
    expect(screen.queryByText(i18n.t('vod:yearEmptyTitle'))).toBeNull();
    // The empty state's button (the search box has its own, icon-only clear button).
    const clear = screen.getAllByRole('button', { name: i18n.t('vod:clearSearch') }).find((b) => !b.hasAttribute('aria-label'));
    fireEvent.click(clear!);
    // The range 1990..1991 still holds titles, so the grid comes back.
    await screen.findByText('Film 0');
    expect(currentLocation).not.toContain('q=');
  });

  it('a query with no match while Hide watched is on shows the search state', async () => {
    patch = { vodHideWatched: true };
    renderAt('/s/src1/movies/c/c1?q=zzz', gridRoute);
    await screen.findByText(i18n.t('vod:noSearchMatchTitle', { query: 'zzz' }));
    expect(screen.queryByText(i18n.t('vod:watchedEmptyTitle'))).toBeNull();
  });

  it('L3-cross-XB-4: a long query is echoed to 60 characters with an ellipsis, the full text on hover', async () => {
    const long = `zz${'q'.repeat(98)}`;
    renderAt(`/s/src1/movies/c/c1?q=${long}`, gridRoute);
    const title = await screen.findByText(i18n.t('vod:noSearchMatchTitle', { query: `${long.slice(0, 59)}…` }));
    expect(title.getAttribute('title')).toBe(long);
  });

  it('L3-cross-XB-4: a short query is echoed whole, with no tooltip', async () => {
    const short = `zz${'q'.repeat(58)}`; // exactly 60
    renderAt(`/s/src1/movies/c/c1?q=${short}`, gridRoute);
    const title = await screen.findByText(i18n.t('vod:noSearchMatchTitle', { query: short }));
    expect(title.hasAttribute('title')).toBe(false);
  });
});

describe('L1-vod-10: Escape on a grid', () => {
  it('opened from the landing, Escape steps back through history (POP)', async () => {
    localStorage.setItem(CATEGORY_INDEX_KEY, '1');
    renderWithHistory(['/s/src1/movies']);
    fireEvent.click(await screen.findByRole('link', { name: /Action/ }));
    await screen.findByText('Film 0');
    expect(locState).toEqual({ fromLanding: true });
    fireEvent.keyDown(screen.getByTestId('vod-grid'), { key: 'Escape' });
    await screen.findByTestId('landing');
    expect(navType).toBe('POP');
  });

  it('opened cold, Escape replaces the grid with the landing instead of pushing', async () => {
    renderWithHistory(['/s/src1/movies/c/c1']);
    await screen.findByText('Film 0');
    fireEvent.keyDown(screen.getByTestId('vod-grid'), { key: 'Escape' });
    await screen.findByTestId('landing');
    expect(navType).toBe('REPLACE');
  });
});

describe('L1-vod-15: Shift+W keeps focus in the grid', () => {
  it('after Shift+W the grid keeps focus and its cursor, and the arrow keys still move it', async () => {
    watchedIds = new Set(['f0']);
    renderAt('/s/src1/movies/c/c1', gridRoute);
    await screen.findByText('Film 0');
    const before = screen.getByTestId('vod-grid');
    before.focus();
    fireEvent.keyDown(before, { key: 'ArrowRight' });
    fireEvent.keyDown(before, { key: 'ArrowRight' });
    const cursor = before.getAttribute('aria-activedescendant');
    expect(cursor).toBeTruthy();
    fireEvent.keyDown(before, { key: 'W', shiftKey: true });
    await waitFor(() => expect(callsOf('catalog.movies').some((c) => (c.args as { hideWatched?: boolean }).hideWatched)).toBe(true));
    await waitFor(() => expect(screen.queryByText('Film 0')).toBeNull());
    // L2-vod-8: the same grid stays (the toggle is not part of its key), so the cursor is not
    // thrown back to the start; loop 1 pinned a remount here.
    const after = screen.getByTestId('vod-grid');
    expect(after).toBe(before);
    expect(document.activeElement).toBe(after);
    expect(after.getAttribute('aria-activedescendant')).toBe(cursor);
    fireEvent.keyDown(after, { key: 'ArrowRight' });
    await waitFor(() => expect(after.getAttribute('aria-activedescendant')).not.toBe(cursor));
  });

  it('does not pull focus back when Shift+W was pressed outside the grid', async () => {
    watchedIds = new Set(['f0']);
    renderAt('/s/src1/movies/c/c1', gridRoute);
    await screen.findByText('Film 0');
    fireEvent.keyDown(document.body, { key: 'W', shiftKey: true });
    await waitFor(() => expect(screen.queryByText('Film 0')).toBeNull());
    await screen.findByText('Film 1');
    expect(document.activeElement).not.toBe(screen.getByTestId('vod-grid'));
  });
});

describe('L1-vod-13: removed source or category', () => {
  it('a removed source shows the source-missing state without Retry', async () => {
    rpcMock.handlers['sources.get'] = () => {
      throw new RpcError('not_found', 'source src1 not found');
    };
    renderAt('/s/src1/movies/c/c1', gridRoute);
    await screen.findByText(i18n.t('vod:sourceMissingTitle'));
    expect(screen.queryByRole('button', { name: i18n.t('common:retry') })).toBeNull();
    expect(screen.getByRole('link', { name: i18n.t('vod:openSources') }).getAttribute('href')).toBe('/sources');
  });

  it('a category the source does not have says so, with a link back to the categories', async () => {
    renderAt('/s/src1/movies/c/gone', gridRoute);
    await screen.findByText(i18n.t('vod:categoryMissingTitle'));
    expect(screen.queryByText(i18n.t('vod:emptyCategoryTitle'))).toBeNull();
    expect(screen.getByRole('link', { name: i18n.t('vod:backToCategories') }).getAttribute('href')).toBe('/s/src1/movies');
  });

  it('does not flash the missing state while the categories load', async () => {
    let resolve: (v: Category[]) => void = () => undefined;
    rpcMock.handlers['catalog.categories'] = () => new Promise<Category[]>((r) => (resolve = r));
    renderAt('/s/src1/movies/c/c1', gridRoute);
    await screen.findByText('Film 0');
    expect(screen.queryByText(i18n.t('vod:categoryMissingTitle'))).toBeNull();
    resolve(cats);
    await waitFor(() => expect(callsOf('catalog.categories')).toHaveLength(1));
    expect(screen.queryByText(i18n.t('vod:categoryMissingTitle'))).toBeNull();
  });

  it('the all-titles grid is never a missing category', async () => {
    rpcMock.handlers['catalog.categories'] = () => [];
    renderAt('/s/src1/movies/c/all', gridRoute);
    await screen.findByText('Film 0');
    expect(screen.queryByText(i18n.t('vod:categoryMissingTitle'))).toBeNull();
  });
});

describe('L1-vod-9: the grid comes back to its spot only on a return', () => {
  const optionAt = (i: number) => screen.getByTestId('vod-grid').querySelector<HTMLElement>(`[role="option"][data-index="${i}"]`);

  it('opened from a link (PUSH), the grid starts fresh: no remembered cursor', async () => {
    rememberSpot('/s/src1/movies/c/c1', { scrollTop: 0, index: 3 });
    localStorage.setItem(CATEGORY_INDEX_KEY, '1');
    renderWithHistory(['/s/src1/movies']);
    fireEvent.click(await screen.findByRole('link', { name: /Action/ }));
    await screen.findByText('Film 3');
    expect(navType).toBe('PUSH');
    expect(optionAt(3)?.getAttribute('data-active')).not.toBe('true');
    expect(document.activeElement).not.toBe(screen.getByTestId('vod-grid'));
  });

  it('reopened on start or by Back (POP), the cursor comes back to the remembered title', async () => {
    rememberSpot('/s/src1/movies/c/c1', { scrollTop: 0, index: 3 });
    renderWithHistory(['/s/src1/movies/c/c1']);
    await screen.findByText('Film 3');
    await waitFor(() => expect(optionAt(3)?.getAttribute('data-active')).toBe('true'));
  });
});
