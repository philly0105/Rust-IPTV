// The dashboard's My List rail (contract C3).
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type ItemRef } from '@/api/types';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const h = await import('./harness');
const rpc = h.createRpcMock();
rpcMock.current = rpc;
const { MyListRail, MY_LIST_RAIL_LIMIT } = await import('..');
const { usePendingRemovals } = await import('@/features/sources/lib/pendingRemoval');

const m = (id: string, sourceId = 'src1'): ItemRef => ({ sourceId, contentType: 'movie', itemId: id });
const s = (id: string): ItemRef => ({ sourceId: 'src1', contentType: 'series', itemId: id });

function renderRail(props: Parameters<typeof MyListRail>[0] = {}) {
  return render(
    <h.Providers>
      <MyListRail {...props} />
    </h.Providers>,
  );
}

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
  localStorage.clear();
  usePendingRemovals.setState({ ids: new Set() } as never);
});
afterEach(cleanup);

describe('MyListRail', () => {
  it('shows saved titles in the user order with a count, watched tags and See all', async () => {
    h.installCore(rpc, [h.entry(m('m1'), 'Arrival', { watched: true }), h.entry(s('s1'), 'Dark'), h.entry(m('m2'), 'Heat', { subtitle: '1995' })]);
    renderRail();
    await screen.findByTestId('mylist-rail-count');
    const rail = screen.getByTestId('dashboard-rail-my-list');
    expect(within(rail).getByRole('heading', { level: 2 }).textContent).toBe('My List');
    expect(within(rail).getByTestId('mylist-rail-count').textContent).toBe('3 titles');
    const links = within(rail)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(links).toContain('/my-list');
    expect(within(rail).getByRole('link', { name: 'See all' }).getAttribute('href')).toBe('/my-list');
    expect(within(rail).getAllByTestId('mylist-watched-tag')).toHaveLength(1);
    // Cards name the title, its kind (or subtitle) and the watched state (joinList isolates each part).
    const names = within(rail)
      .getAllByRole('link')
      .map((a) => a.getAttribute('aria-label')?.replace(/[⁨⁩]/g, ''))
      .filter(Boolean);
    expect(names).toEqual(['Arrival, Movie, Watched', 'Dark, Series', 'Heat, 1995']);
  });

  it('renders nothing when the list is empty', async () => {
    h.installCore(rpc, []);
    const { container } = renderRail();
    await waitFor(() => expect(rpc.callsOf('watchlist.list')).toHaveLength(1));
    await waitFor(() => expect(container.querySelector('[data-testid="dashboard-rail-my-list"]')).toBeNull());
  });

  it('renders nothing when switched off in Settings', async () => {
    h.installCore(rpc, [h.entry(m('m1'), 'Arrival')], { dashboardRails: { ...DEFAULT_SETTINGS.dashboardRails, myList: false } });
    const { container } = renderRail();
    await waitFor(() => expect(rpc.callsOf('settings.get')).toHaveLength(1));
    await waitFor(() => expect(rpc.callsOf('watchlist.list')).toHaveLength(1));
    expect(container.querySelector('[data-testid="dashboard-rail-my-list"]')).toBeNull();
  });

  it('stops at the rail cap; the count still says how many there are', async () => {
    const many = Array.from({ length: MY_LIST_RAIL_LIMIT + 6 }, (_, i) => h.entry(m(`m${i}`), `Film ${i}`));
    h.installCore(rpc, many);
    renderRail();
    await screen.findByTestId('mylist-rail-count');
    const rail = screen.getByTestId('dashboard-rail-my-list');
    expect(within(rail).getByTestId('mylist-rail-count').textContent).toBe(`${MY_LIST_RAIL_LIMIT + 6} titles`);
    const cards = within(rail)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href') !== '/my-list');
    expect(cards.length).toBeLessThanOrEqual(MY_LIST_RAIL_LIMIT);
  });

  it('leaves out a source waiting out its removal undo', async () => {
    h.installCore(rpc, [h.entry(m('m1'), 'Arrival'), h.entry(m('m2', 'src2'), 'Heat')]);
    usePendingRemovals.setState({ ids: new Set(['src2']) } as never);
    renderRail();
    await screen.findByTestId('mylist-rail-count');
    const rail = screen.getByTestId('dashboard-rail-my-list');
    expect(within(rail).getByTestId('mylist-rail-count').textContent).toBe('1 title');
    expect(within(rail).queryByText('Heat')).toBeNull();
  });

  it('a second dashboard visit reads the cached list instead of refetching it (L1-perf-9)', async () => {
    h.installCore(rpc, [h.entry(m('m1'), 'Arrival')]);
    renderRail();
    await screen.findByTestId('mylist-rail-count');
    expect(rpc.callsOf('watchlist.list')).toHaveLength(1);
    cleanup();

    renderRail();
    await screen.findByTestId('mylist-rail-count');
    // Watched changes invalidate the key themselves (watchlist.changed, invalidateWatched).
    expect(rpc.callsOf('watchlist.list')).toHaveLength(1);
  });

  it('shows its own error with Retry, unless the dashboard already shows one', async () => {
    const core = h.installCore(rpc, [h.entry(m('m1'), 'Arrival')]);
    core.fail['watchlist.list'] = 'db';
    renderRail();
    const error = await screen.findByTestId('dashboard-rail-error');
    expect(screen.getByTestId('dashboard-rail-my-list').contains(error)).toBe(true);
    expect(within(error).getByRole('button', { name: 'Try again' })).toBeTruthy();
    cleanup();

    h.resetShared();
    core.fail['watchlist.list'] = 'db';
    const { container } = renderRail({ hideError: true });
    await waitFor(() => expect(rpc.callsOf('watchlist.list').length).toBeGreaterThan(1));
    expect(container.querySelector('[data-testid="dashboard-rail-error"]')).toBeNull();
  });
});
