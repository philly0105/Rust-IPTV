/**
 * Loop 2 VOD fixes: lock marks in Ask mode (L2-settings-5), the phone Filters disclosure
 * (L2-vod-7), the landing's layout from the first frame (L2-vod-5), the grid's memoised cells
 * (L2-vod-1), scroll memory read once per frame (L2-perf-ui-9) and Shift+W keeping the page data
 * (L2-vod-8).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { rpcKey } from '@/api/query';
import type { Category, Page, PageQuery, ParentalLock, VodItem } from '@/api/types';
import { VirtualGrid } from '@/ui';

import { sameGridSlot, useSource } from '../hooks/queries';
import { forgetSpots, recallSpot, useScrollMemory } from '../hooks/useScrollMemory';
import { CategoryGridPage } from '../pages/CategoryGridPage';
import { CATEGORY_INDEX_KEY, VodLandingPage } from '../pages/VodLandingPage';
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

const film = (i: number): VodItem => ({
  ref: { sourceId: 'src1', contentType: 'movie', itemId: `f${i}` },
  title: `Film ${i}`,
  categoryId: 'c1',
});
const ALL = Array.from({ length: 12 }, (_, i) => film(i));
const cats: Category[] = [
  { id: 'c1', sourceId: 'src1', contentType: 'movie', name: 'Action', hidden: false, itemCount: 12, position: 0 },
  { id: 'c2', sourceId: 'src1', contentType: 'movie', name: 'Late night', hidden: false, itemCount: 3, position: 1 },
];
const lock = (kind: 'item' | 'category', targetId: string): ParentalLock => ({
  sourceId: 'src1',
  contentType: 'movie',
  kind,
  targetId,
  name: targetId,
  createdAt: '2026-10-15T00:00:00Z',
});
let mode: 'ask' | 'hide' = 'ask';

function handlers() {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  h['sources.get'] = () => makeSource('src1', 'xtream', 'Alpha IPTV');
  h['settings.get'] = () => settings({});
  h['parental.status'] = () => ({ enabled: true, mode, autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['parental.locks'] = () => [lock('item', 'f1'), lock('category', 'c2')];
  h['catalog.categories'] = () => cats;
  h['catalog.recentlyAdded'] = () => ALL.slice(0, 4);
  h['catalog.yearFacets'] = () => [];
  h['positions.continueWatching'] = () => [];
  h['watchlist.list'] = () => [];
  h['positions.watchedContains'] = () => [];
  h['catalog.movies'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    return { items: ALL.slice(q.offset, q.offset + q.limit), total: ALL.length, offset: q.offset, limit: q.limit } satisfies Page<VodItem>;
  };
}

const gridRoute = [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }];
const landingRoute = [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }];
const cellOf = (title: string) => screen.getByText(title).closest('[role="option"]') as HTMLElement;

beforeAll(installDomStubs);
beforeEach(() => {
  mode = 'ask';
  handlers();
  forgetSpots();
  localStorage.clear();
});
afterEach(() => cleanup());

describe('L2-settings-5: lock marks in Ask mode', () => {
  it('marks a locked title in the grid with the lock, and names it', async () => {
    renderAt('/s/src1/movies/c/c1', gridRoute);
    await screen.findByText('Film 0');
    await waitFor(() => expect(within(cellOf('Film 1')).queryByTestId('poster-locked')).not.toBeNull());
    expect(within(cellOf('Film 0')).queryByTestId('poster-locked')).toBeNull();
    expect(within(cellOf('Film 1')).getByRole('group').getAttribute('aria-label')).toContain(i18n.t('vod:locked'));
  });

  it('marks a locked category on the landing with the Live groups glyph', async () => {
    localStorage.setItem(CATEGORY_INDEX_KEY, '1');
    renderAt('/s/src1/movies', landingRoute);
    const locked = await findIndexLink(/Late night/);
    await waitFor(() => expect(within(locked).getByTestId('category-locked').getAttribute('aria-label')).toBe(i18n.t('vod:locked')));
    expect(within(await findIndexLink(/Action/)).queryByTestId('category-locked')).toBeNull();
  });

  it('marks nothing in Hide mode (locked things are left out there)', async () => {
    mode = 'hide';
    renderAt('/s/src1/movies/c/c1', gridRoute);
    await screen.findByText('Film 1');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryAllByTestId('poster-locked')).toHaveLength(0);
  });
});

describe('L2-vod-7: phone filters', () => {
  it('one Filters button opens the sort and the filter bar', async () => {
    renderAt('/s/src1/movies/c/c1', gridRoute);
    await screen.findByText('Film 0');
    const toggle = screen.getByTestId('vod-filters-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const panels = toggle.getAttribute('aria-controls')!.split(' ').map((id) => document.getElementById(id)!);
    expect(panels).toHaveLength(2);
    for (const p of panels) expect(p.className).toContain('max-sm:hidden');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    for (const p of panels) expect(p.className).not.toContain('max-sm:hidden');
  });
});

describe('L2-vod-5: the landing holds its layout from the first frame', () => {
  it('shows the rail placeholders while the source is still loading', async () => {
    rpcMock.handlers['sources.get'] = () => new Promise(() => undefined);
    renderAt('/s/src1/movies', landingRoute);
    expect(await screen.findByRole('heading', { name: i18n.t('vod:recentlyAdded') })).toBeTruthy();
  });

  it('reads the source from the sources list it already has, without waiting for sources.get', async () => {
    rpcMock.handlers['sources.get'] = () => new Promise(() => undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(rpcKey('sources.list', undefined), [makeSource('src1', 'xtream', 'Alpha IPTV')]);
    function Probe() {
      return <span>{useSource('src1').data?.name ?? 'pending'}</span>;
    }
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Alpha IPTV')).toBeTruthy();
  });
});

describe('L2-vod-8, L3-vod-3: a new filter keeps the page data meanwhile', () => {
  it('compares two page keys by command, source, category and page slot', () => {
    const key = (args: object) => ['catalog.movies', args] as const;
    const a = key({ sourceId: 's', categoryId: 'c', query: { offset: 0, limit: 120, sort: 'added' }, hideWatched: false });
    expect(sameGridSlot(a, key({ sourceId: 's', categoryId: 'c', query: { offset: 0, limit: 120, sort: 'added' }, hideWatched: true }))).toBe(true);
    // L3-vod-3: a sort, search, rating or year change refills the same slot (was a remount).
    expect(sameGridSlot(a, key({ sourceId: 's', categoryId: 'c', query: { offset: 0, limit: 120, sort: 'name', search: 'x' }, minRating: 7, yearFrom: 1990 }))).toBe(true);
    expect(sameGridSlot(a, key({ sourceId: 's', categoryId: 'c', query: { offset: 120, limit: 120, sort: 'added' } }))).toBe(false);
    expect(sameGridSlot(a, key({ sourceId: 's', categoryId: 'd', query: { offset: 0, limit: 120, sort: 'added' } }))).toBe(false);
    expect(sameGridSlot(a, key({ sourceId: 't', categoryId: 'c', query: { offset: 0, limit: 120, sort: 'added' } }))).toBe(false);
    expect(sameGridSlot(a, ['catalog.series', { sourceId: 's', categoryId: 'c', query: { offset: 0, limit: 120 } }])).toBe(false);
  });
});

describe('L2-vod-1: the grid re-renders only the cells that changed', () => {
  it('moving the cursor renders the two cells it touched, not the window', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: `i${i}` }));
    const renders: number[] = [];
    const renderCell = (item: { id: string }, index: number) => {
      renders.push(index);
      return <span>{item.id}</span>;
    };
    render(
      <VirtualGrid items={items} minColumnWidth={150} aspect="poster" label="Titles" getKey={(i) => i.id} initialRect={{ width: 960, height: 600 }} render={renderCell} />,
    );
    const grid = screen.getByRole('listbox', { name: 'Titles' });
    expect(renders.length).toBeGreaterThan(4);
    grid.focus();
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    renders.length = 0;
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    // The cell the cursor left and the one it reached; the other mounted cells keep their render.
    expect(renders).toHaveLength(2);
    expect(Math.abs(renders[0]! - renders[1]!)).toBe(1);
  });
});

describe('L2-perf-ui-9: scroll memory reads the offset once per frame', () => {
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((h) => {
      frames[h - 1] = () => undefined;
    });
  });
  const flush = () => {
    const run = frames;
    frames = [];
    for (const cb of run) cb(0);
  };

  function Scroller() {
    const ref = useRef<HTMLDivElement>(null);
    useScrollMemory({ key: '/grid', getScroller: () => ref.current, ready: true });
    return <div ref={ref} data-testid="scroller" />;
  }

  it('records a burst of scroll events once, at the next frame', () => {
    render(<Scroller />);
    const el = screen.getByTestId('scroller');
    for (const top of [100, 200, 300]) {
      el.scrollTop = top;
      fireEvent.scroll(el);
    }
    expect(frames).toHaveLength(1);
    expect(recallSpot('/grid')).toBeUndefined();
    act(flush);
    expect(recallSpot('/grid')?.scrollTop).toBe(300);
  });

  it('keeps the offset of a scroll still waiting for its frame when the page leaves', () => {
    const { unmount } = render(<Scroller />);
    const el = screen.getByTestId('scroller');
    el.scrollTop = 420;
    fireEvent.scroll(el);
    unmount();
    expect(recallSpot('/grid')?.scrollTop).toBe(420);
  });
});
