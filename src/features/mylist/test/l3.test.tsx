// Loop 3 fixes on My List.
// L3-vod-7: the page read the whole list again on every visit (staleTime 0) and re-rendered
// every row when the same list came back. It now keeps a long staleTime, goes stale whenever
// a playback row may have changed a Watched tick, and its memoized rows skip identical refetches.
// L2-checks-1: toasts named the provider's raw title while the rows showed the base title.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef } from '@/api/types';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
const posterRenders = vi.hoisted(() => ({ count: 0, byTitle: new Map<string, number>() }));
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
// Every row draws one poster: counting poster renders counts row renders.
vi.mock('../deps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../deps')>()),
  Poster: ({ label }: { label: string }) => {
    posterRenders.count += 1;
    posterRenders.byTitle.set(label, (posterRenders.byTitle.get(label) ?? 0) + 1);
    return <span data-testid="poster">{label}</span>;
  },
}));

const h = await import('./harness');
const rpc = h.createRpcMock();
rpcMock.current = rpc;
const { queryClient, invalidate, rpcKey } = await import('@/api/query');
const { MyListPage } = await import('../pages/MyListPage');
const { MyListButton } = await import('..');

const m = (id: string): ItemRef => ({ sourceId: 'src1', contentType: 'movie', itemId: id });
const LIST = [
  h.entry(m('m1'), 'EN - Arrival (2016) [4K]', { addedAt: '2026-10-01T10:00:00Z' }),
  h.entry(m('m2'), 'Heat (1995)', { addedAt: '2026-10-03T10:00:00Z' }),
  h.entry(m('m3'), 'Blade Runner', { addedAt: '2026-10-02T10:00:00Z' }),
];

const rowTitles = () => screen.getAllByTestId('mylist-title').map((t) => t.textContent);
const rowOf = (title: string) => screen.getAllByTestId('mylist-row').find((r) => r.querySelector('[data-testid="mylist-title"]')!.textContent === title)!;

function openPage() {
  return h.renderAt('/my-list', [{ path: '/my-list', element: <MyListPage /> }]);
}

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
  // These tests drive the list view; the poster grid (the default) has its own (saas2.test.tsx).
  localStorage.setItem('mylist.view', 'list');
  posterRenders.count = 0;
  posterRenders.byTitle.clear();
  rpc.handlers['positions.get'] = () => null;
});
afterEach(cleanup);

describe('My List reads (L3-vod-7)', () => {
  it('a second visit shows the cached list without reading it again', async () => {
    h.installCore(rpc, LIST);
    const first = openPage();
    await screen.findAllByTestId('mylist-row');
    expect(rpc.callsOf('watchlist.list')).toHaveLength(1);
    first.unmount();

    openPage();
    expect(rowTitles()).toEqual(['Arrival', 'Heat', 'Blade Runner']);
    await act(async () => undefined);
    expect(rpc.callsOf('watchlist.list')).toHaveLength(1);
  });

  it('a playback row going stale (Start over, Recent remove, a save) makes the next visit read it again', async () => {
    const core = h.installCore(rpc, LIST);
    const first = openPage();
    await screen.findAllByTestId('mylist-row');
    first.unmount();

    // Start over on a watched movie drops its row in the core and only invalidates positions.
    queryClient.setQueryData(rpcKey('positions.get', { ref: m('m2') }), null);
    core.entries = core.entries.map((e) => (e.ref.itemId === 'm2' ? { ...e, watched: true } : e));
    await act(() => invalidate('positions.'));
    expect(rpc.callsOf('watchlist.list')).toHaveLength(1);

    openPage();
    await waitFor(() => expect(rpc.callsOf('watchlist.list')).toHaveLength(2));
    await waitFor(() => expect(rowOf('Heat').dataset['watched']).toBe('true'));
  });

  it('a refetch that returns the same list re-renders no row', async () => {
    h.installCore(rpc, LIST);
    openPage();
    await screen.findAllByTestId('mylist-row');
    await act(async () => undefined);
    const before = posterRenders.count;
    expect(before).toBeGreaterThanOrEqual(LIST.length);

    await act(() => invalidate('watchlist.'));
    expect(rpc.callsOf('watchlist.list')).toHaveLength(2);
    await act(async () => undefined);
    expect(posterRenders.count).toBe(before);
  });

  it('marking one movie watched re-renders that row only', async () => {
    const core = h.installCore(rpc, LIST);
    rpc.handlers['userstate.setWatched'] = (raw) => {
      const a = raw as { ref: ItemRef; watched: boolean };
      core.entries = core.entries.map((e) => (e.ref.itemId === a.ref.itemId ? { ...e, watched: a.watched } : e));
      return null;
    };
    rpc.handlers['positions.forSeries'] = () => [];
    openPage();
    await screen.findAllByTestId('mylist-row');
    await act(async () => undefined);
    const before = new Map(posterRenders.byTitle);
    fireEvent.click(rowOf('Blade Runner').querySelector<HTMLElement>('[data-action="watched"]')!);
    await waitFor(() => expect(rowOf('Blade Runner').dataset['watched']).toBe('true'));
    await waitFor(() => expect(rowOf('Blade Runner').className).not.toContain('cursor-progress'));
    // The row redraws for its tick and its busy state; the others stay as they were.
    expect(posterRenders.byTitle.get('Blade Runner')).toBeGreaterThan(before.get('Blade Runner')!);
    expect(posterRenders.byTitle.get('Arrival')).toBe(before.get('Arrival'));
    expect(posterRenders.byTitle.get('Heat')).toBe(before.get('Heat'));
  });
});

describe('My List toasts name the title as the rows do (L2-checks-1)', () => {
  it('Remove on the page: "Removed Arrival", not the provider name', async () => {
    h.installCore(rpc, LIST);
    openPage();
    await screen.findAllByTestId('mylist-row');
    fireEvent.click(rowOf('Arrival').querySelector<HTMLElement>('[data-action="remove"]')!);
    await waitFor(() => expect(h.lastToast()?.title).toBe('Removed Arrival from My List'));
  });

  it('Mark watched on the page: "Marked Heat as watched"-style toast with the base title', async () => {
    h.installCore(rpc, LIST);
    rpc.handlers['userstate.setWatched'] = () => null;
    rpc.handlers['positions.forSeries'] = () => [];
    openPage();
    await screen.findAllByTestId('mylist-row');
    fireEvent.click(rowOf('Heat').querySelector<HTMLElement>('[data-action="watched"]')!);
    await waitFor(() => expect(h.lastToast()?.title).toMatch(/Heat/));
    expect(h.lastToast()?.title).not.toMatch(/1995/);
  });

  it('the toggle: "Added Arrival" and "Removed Arrival" for a raw provider snapshot', async () => {
    h.installCore(rpc, []);
    const ref = m('m1');
    const Wrap = ({ children }: { children: ReactNode }) => <h.Providers path="/movie/m1">{children}</h.Providers>;
    render(
      <Wrap>
        <MyListButton itemRef={ref} snapshot={{ title: 'EN - Arrival (2016) [4K]', contentType: 'movie' }} />
      </Wrap>,
    );
    const button = () => screen.getByTestId('mylist-button');
    await waitFor(() => expect(button().dataset['state']).toBe('ready'));
    fireEvent.click(button());
    await waitFor(() => expect(h.lastToast()?.title).toBe('Added Arrival to My List'));
    await waitFor(() => expect(button().hasAttribute('disabled')).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(h.lastToast()?.title).toBe('Removed Arrival from My List'));
  });
});
