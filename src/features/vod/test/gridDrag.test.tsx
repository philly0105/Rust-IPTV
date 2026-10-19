/**
 * VD-2: the category grid fetches the pages it rests on, not every page a scrollbar drag passes.
 * The page gate itself (open pages, the settle timer), and the grid on a 200k-title category.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Page, PageQuery, VodItem } from '@/api/types';

import { PAGE_SETTLE_MS, PageGate } from '../hooks/pageGate';
import { CATALOG_PAGE_SIZE } from '../lib/paging';
import { CategoryGridPage } from '../pages/CategoryGridPage';
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

const TOTAL = 200_000;
const film = (i: number): VodItem => ({ ref: { sourceId: 'src1', contentType: 'movie', itemId: `f${i}` }, title: `Film ${i}`, categoryId: 'c1' });
const cats: Category[] = [{ id: 'c1', sourceId: 'src1', contentType: 'movie', name: 'Action', hidden: false, itemCount: TOTAL, position: 0 }];

function handlers() {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => makeSource('src1', 'xtream', 'Alpha IPTV');
  h['settings.get'] = () => settings({});
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['parental.locks'] = () => [];
  h['catalog.categories'] = () => cats;
  h['catalog.yearFacets'] = () => [];
  h['positions.continueWatching'] = () => [];
  h['watchlist.list'] = () => [];
  h['positions.watchedContains'] = () => [];
  h['catalog.movies'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    const items = Array.from({ length: Math.max(0, Math.min(q.limit, TOTAL - q.offset)) }, (_, i) => film(q.offset + i));
    return { items, total: TOTAL, offset: q.offset, limit: q.limit } satisfies Page<VodItem>;
  };
}

const pageReads = () => rpcMock.calls.filter((c) => c.cmd === 'catalog.movies').map((c) => (c.args as { query: PageQuery }).query.offset / CATALOG_PAGE_SIZE);

beforeAll(installDomStubs);
beforeEach(handlers);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PageGate (VD-2)', () => {
  it('opens the first page at once, the next page at once, and a jump only once it rests', () => {
    vi.useFakeTimers();
    const gate = new PageGate();
    gate.mount(0);
    expect(gate.isOpen(0)).toBe(true);
    // A normal scroll onto the next page.
    gate.mount(1);
    expect(gate.isOpen(1)).toBe(true);
    gate.unmount(0);
    gate.unmount(1);
    // A drag: pages far apart, one frame each.
    for (const page of [40, 80, 120]) {
      gate.mount(page);
      vi.advanceTimersByTime(16);
      expect(gate.isOpen(page)).toBe(false);
      gate.unmount(page);
    }
    gate.mount(160);
    gate.mount(161);
    vi.advanceTimersByTime(PAGE_SETTLE_MS - 1);
    expect(gate.isOpen(160)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(gate.isOpen(160)).toBe(true);
    expect(gate.isOpen(161)).toBe(true);
    // Only the pages it rested on: the ones passed stay shut.
    expect(gate.isOpen(120)).toBe(false);
    gate.dispose();
  });

  it('a step next to the open pages while a jump settles waits for that timer, without restarting it', () => {
    vi.useFakeTimers();
    const gate = new PageGate();
    gate.mount(0);
    gate.mount(50);
    vi.advanceTimersByTime(60);
    gate.mount(1);
    expect(gate.isOpen(1)).toBe(false);
    vi.advanceTimersByTime(PAGE_SETTLE_MS - 60);
    expect(gate.isOpen(1)).toBe(true);
    gate.dispose();
  });

  it('tells subscribers when pages open', () => {
    vi.useFakeTimers();
    const gate = new PageGate();
    const listener = vi.fn();
    gate.subscribe(listener);
    gate.mount(3);
    expect(listener).toHaveBeenCalledTimes(1);
    gate.mount(3);
    expect(listener).toHaveBeenCalledTimes(1);
    gate.dispose();
  });
});

describe('the category grid during a scrollbar drag (VD-2)', () => {
  it('asks for no page while the drag moves, then only the pages it stops on', async () => {
    renderAt('/s/src1/movies/c/c1', [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }]);
    await screen.findByText('Film 0');
    const grid = screen.getByTestId('vod-grid');
    await new Promise((r) => setTimeout(r, PAGE_SETTLE_MS + 50));
    rpcMock.calls.length = 0;
    // One scroll event per frame across most of the grid.
    for (let k = 1; k <= 20; k++) {
      grid.scrollTop = k * 400_000;
      fireEvent.scroll(grid);
    }
    expect(pageReads()).toEqual([]);
    await waitFor(() => expect(pageReads().length).toBeGreaterThan(0));
    await act(() => new Promise((r) => setTimeout(r, PAGE_SETTLE_MS + 50)));
    const reads = pageReads();
    // The window it rests on spans one or two pages; the 1,300 or so passed are never asked for.
    expect(reads.length).toBeLessThanOrEqual(2);
    expect(Math.min(...reads)).toBeGreaterThan(1000);
    const firstRow = Math.min(...reads) * CATALOG_PAGE_SIZE;
    await screen.findByText(new RegExp(`^Film ${firstRow + CATALOG_PAGE_SIZE - 1}$|^Film ${firstRow + 1}$`));
  });
});
