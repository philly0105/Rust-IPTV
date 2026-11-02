/**
 * F4-4: a new My List redraws only the poster cards whose title it saved or took off.
 *
 * GridMyListProvider used to put the list in its context value, so every list (an optimistic
 * toggle, the server's rows after it, a watched change, another window) re-rendered every card
 * body under it past the cards' memos. The list now lives in a store the leaves select from: a
 * linked card's saved chip and corner toggle, and a grid cell's "In My List" name.
 *
 * Counts card bodies through formatRating, which a body calls on every render.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient, rpcKey } from '@/api/query';
import type { VodItem, WatchlistEntry } from '@/api/types';

import { GridMyListProvider, PosterCard, myListTarget } from '../components/PosterCard';
import { i18n, installDomStubs } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const call = async (cmd: string, args?: unknown) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, call };
});
const counts = vi.hoisted(() => ({ bodies: 0 }));

vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('../lib/format', async (orig) => {
  const real = await orig<typeof import('../lib/format')>();
  return { ...real, formatRating: (...a: Parameters<typeof real.formatRating>) => (counts.bodies++, real.formatRating(...a)) };
});

const LIST_KEY = rpcKey('watchlist.list', {});
const N = 50;
const movie = (i: number, prefix: string): VodItem => ({ ref: { sourceId: 'src1', contentType: 'movie', itemId: `${prefix}${i}` }, title: `${prefix} ${i}`, categoryId: 'c1', year: 2020, rating: 7 });
const entry = (item: VodItem): WatchlistEntry => ({ ref: item.ref, snapshot: myListTarget(item).snapshot, addedAt: '2026-10-31T12:00:00Z', watched: false });
const grid = Array.from({ length: N }, (_, i) => movie(i, 'Grid'));
const linked = Array.from({ length: N }, (_, i) => movie(i, 'Linked'));

function Cards({ items, interactive }: { items: VodItem[]; interactive: boolean }) {
  return (
    <>
      {items.map((item, i) => (
        <PosterCard key={i} index={i} title={item.title} href={`/m/${item.ref.itemId}`} year={item.year} rating={item.rating} interactive={interactive} myList={myListTarget(item)} />
      ))}
    </>
  );
}

function mount(children: ReactNode) {
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>{children}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const gridCell = (name: RegExp) => screen.getByRole('group', { name });
/** A linked card's wrapper: its link and, beside it, the corner toggle. */
const linkedCard = (name: RegExp) => screen.getByRole('link', { name }).parentElement!;

beforeAll(installDomStubs);
beforeEach(() => {
  counts.bodies = 0;
  rpcMock.handlers['watchlist.list'] = () => [];
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('F4-4: My List changes and poster cards', () => {
  it('a grid of cells and a rail of linked cards redraw only the saved title’s cell', async () => {
    mount(
      <>
        <GridMyListProvider>
          <Cards items={grid} interactive={false} />
        </GridMyListProvider>
        <GridMyListProvider>
          <Cards items={linked} interactive />
        </GridMyListProvider>
      </>,
    );
    // The corners wait for the list, then take it.
    await waitFor(() => expect(screen.getAllByTestId('mylist-grid-toggle').every((el) => el.getAttribute('data-state') === 'ready')).toBe(true));
    await waitFor(() => expect(screen.getAllByTestId('mylist-button').every((el) => el.getAttribute('data-state') === 'ready')).toBe(true));
    const before = counts.bodies;

    await act(async () => {
      queryClient.setQueryData(LIST_KEY, [entry(grid[3]!), entry(linked[3]!)]);
    });
    // The cell's option name and marker, and the linked card's chip and pressed corner, in one go.
    await waitFor(() => expect(gridCell(/^Grid 3 \(2020\), .*In My List$/)).toBeTruthy());
    expect(gridCell(/^Grid 3 \(/).querySelector('[data-testid="mylist-grid-toggle"]')!.getAttribute('data-in-list')).toBe('true');
    expect(within(gridCell(/^Grid 3 \(/)).getByTestId('poster-saved')).toBeTruthy();
    expect(gridCell(/^Grid 4 \(/).getAttribute('aria-label')).not.toMatch(/In My List/);
    expect(within(linkedCard(/^Linked 3 \(/)).getByTestId('poster-saved')).toBeTruthy();
    expect(within(linkedCard(/^Linked 3 \(/)).getByTestId('mylist-button').getAttribute('aria-pressed')).toBe('true');
    expect(within(linkedCard(/^Linked 4 \(/)).queryByTestId('poster-saved')).toBeNull();
    expect(within(linkedCard(/^Linked 4 \(/)).getByTestId('mylist-button').getAttribute('aria-pressed')).toBe('false');
    const saved = counts.bodies - before;

    // Taken off again: the same one cell.
    await act(async () => {
      queryClient.setQueryData(LIST_KEY, []);
    });
    await waitFor(() => expect(gridCell(/^Grid 3 \(/).getAttribute('aria-label')).not.toMatch(/In My List/));
    expect(within(linkedCard(/^Linked 3 \(/)).queryByTestId('poster-saved')).toBeNull();
    const removed = counts.bodies - before - saved;
    console.info(`[F4-4] ${2 * N} cards: saving two titles drew ${saved} card bodies, taking them off ${removed}`);
    // The grid cell's name is on the cell itself, so that body redraws; the linked card's chip and
    // corner are leaves, so its body does not.
    expect(saved).toBe(1);
    expect(removed).toBe(1);
  });

  it('a grid cell outside a provider keeps following the list on its own', async () => {
    const lone = movie(0, 'Lone');
    mount(<PosterCard title={lone.title} href="/m/lone" year={2020} rating={7} interactive={false} myList={myListTarget(lone)} />);
    await waitFor(() => expect(screen.getByTestId('mylist-grid-toggle').getAttribute('data-state')).toBe('ready'));
    await act(async () => {
      queryClient.setQueryData(LIST_KEY, [entry(lone)]);
    });
    await waitFor(() => expect(gridCell(/^Lone 0 \(2020\), .*In My List$/)).toBeTruthy());
    expect(screen.getByTestId('mylist-grid-toggle').getAttribute('data-in-list')).toBe('true');
  });
});
