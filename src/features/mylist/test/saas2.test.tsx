// Product redesign, stage 2: My List opens as a poster grid (a UI preference, kept in this
// browser), with the list one switch away. The keys work on a focused card as on a row.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef, PlaybackPosition } from '@/api/types';

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
const { MyListPage } = await import('../pages/MyListPage');
const { VIEW_KEY } = await import('../lib/view');
const { shortcutRegistry } = await import('@/shell/shortcuts');

const m = (id: string): ItemRef => ({ sourceId: 'src1', contentType: 'movie', itemId: id });
const s = (id: string): ItemRef => ({ sourceId: 'src1', contentType: 'series', itemId: id });
const ARRIVAL = h.entry(m('m1'), 'Arrival', { addedAt: '2026-10-01T10:00:00Z' });
const DARK = h.entry(s('s1'), 'Dark', { addedAt: '2026-10-05T10:00:00Z' });
const HEAT = h.entry(m('m2'), 'Heat', { addedAt: '2026-10-03T10:00:00Z', watched: true });

const cardOf = (title: string) => screen.getAllByTestId('mylist-card').find((c) => within(c).getByTestId('mylist-title').textContent === title)!;
const itemOf = (title: string) => cardOf(title).closest<HTMLElement>('[role="listitem"]')!;
const press = (el: HTMLElement, key: string) => fireEvent.keyDown(el, { key, code: key });

function open() {
  return h.renderAt('/my-list', [
    { path: '/my-list', element: <MyListPage /> },
    { path: '/s/:sourceId/movie/:id', element: <p>movie page</p> },
  ]);
}

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
  localStorage.removeItem(VIEW_KEY);
  rpc.handlers['positions.get'] = () => null;
  rpc.handlers['positions.forSeries'] = () => [];
});
afterEach(() => {
  cleanup();
  shortcutRegistry.reset();
});

describe('My List grid view', () => {
  it('opens as a poster grid in the user order, with progress and the watched chip on the art', async () => {
    const positions: PlaybackPosition[] = [
      { ref: m('m1'), positionSeconds: 1800, durationSeconds: 7200, updatedAt: '2026-10-12T00:00:00Z', watched: false, snapshot: { title: 'Arrival', contentType: 'movie' } },
    ];
    rpc.handlers['positions.continueWatching'] = () => positions;
    h.installCore(rpc, [ARRIVAL, DARK, HEAT]);
    open();
    const grid = await screen.findByTestId('mylist-list');
    await waitFor(() => expect(within(grid).getAllByTestId('mylist-card').map((c) => within(c).getByTestId('mylist-title').textContent)).toEqual(['Arrival', 'Dark', 'Heat']));
    expect(screen.getByTestId('mylist-page').dataset['view']).toBe('grid');
    await waitFor(() => expect(within(cardOf('Arrival')).getByRole('progressbar')).toBeTruthy());
    expect(within(cardOf('Arrival')).getByText(/Movie.+90 minutes left/)).toBeTruthy();
    expect(within(cardOf('Heat')).getByTestId('mylist-watched')).toBeTruthy();
    expect(itemOf('Heat').getAttribute('aria-label')).toBe('Heat, Watched');
  });

  it('opens a title with Enter or a click, and removes the focused card with Delete', async () => {
    const core = h.installCore(rpc, [ARRIVAL, DARK, HEAT]);
    open();
    await screen.findAllByTestId('mylist-card');
    itemOf('Heat').focus();
    press(itemOf('Heat'), 'Delete');
    await waitFor(() => expect(h.lastToast()?.title).toBe('Removed Heat from My List'));
    expect(h.titles(core.entries)).toEqual(['Arrival', 'Dark']);

    press(itemOf('Arrival'), 'Enter');
    expect(await screen.findByText('movie page')).toBeTruthy();
  });

  it('after Delete, focus moves to the card in its place (or the one before), so the keys keep working', async () => {
    const core = h.installCore(rpc, [ARRIVAL, DARK, HEAT]);
    open();
    await screen.findAllByTestId('mylist-card');
    itemOf('Dark').focus();
    press(itemOf('Dark'), 'Delete');
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Arrival', 'Heat']));
    // Heat took Dark's place.
    await waitFor(() => expect(document.activeElement).toBe(itemOf('Heat')));
    press(document.activeElement as HTMLElement, 'Delete');
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Arrival']));
    // The last card went: the one before it.
    await waitFor(() => expect(document.activeElement).toBe(itemOf('Arrival')));
    expect(itemOf('Arrival').tabIndex).toBe(0);
  });

  it('after the remove button, focus stays in the grid on the next card', async () => {
    const core = h.installCore(rpc, [ARRIVAL, DARK, HEAT]);
    open();
    await screen.findAllByTestId('mylist-card');
    const button = cardOf('Arrival').querySelector<HTMLButtonElement>('[data-action="remove"]')!;
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Dark', 'Heat']));
    await waitFor(() => expect(document.activeElement).toBe(itemOf('Dark')));
  });

  it('moves the focused card with Alt+ArrowDown / Alt+ArrowUp and keeps focus on it', async () => {
    const core = h.installCore(rpc, [ARRIVAL, DARK, HEAT]);
    open();
    await screen.findAllByTestId('mylist-card');
    itemOf('Arrival').focus();
    fireEvent.keyDown(itemOf('Arrival'), { key: 'ArrowDown', code: 'ArrowDown', altKey: true });
    await waitFor(() => expect(rpc.callsOf('watchlist.reorder')).toHaveLength(1));
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Dark', 'Arrival', 'Heat']));
    // The card moved, and focus went with it rather than to the card now in its old place.
    await waitFor(() => expect(document.activeElement).toBe(itemOf('Arrival')));
    fireEvent.keyDown(itemOf('Arrival'), { key: 'ArrowUp', code: 'ArrowUp', altKey: true });
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Arrival', 'Dark', 'Heat']));
    // A plain arrow still only moves focus.
    press(itemOf('Arrival'), 'ArrowRight');
    expect(rpc.callsOf('watchlist.reorder')).toHaveLength(2);
  });

  it('removes with the card button without opening the title', async () => {
    const core = h.installCore(rpc, [ARRIVAL, DARK]);
    open();
    await screen.findAllByTestId('mylist-card');
    fireEvent.click(cardOf('Arrival').querySelector<HTMLButtonElement>('[data-action="remove"]')!);
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Dark']));
    expect(screen.queryByText('movie page')).toBeNull();
    // On touch the button is left out: it would sit on every poster.
    expect(cardOf('Dark').querySelector('[data-action="remove"]')!.className).toContain('pointer-coarse:hidden');
  });

  it('switches to the list and remembers the choice', async () => {
    h.installCore(rpc, [ARRIVAL, DARK]);
    open();
    await screen.findAllByTestId('mylist-card');
    const views = screen.getByRole('radiogroup', { name: 'View' });
    fireEvent.click(within(views).getByRole('radio', { name: 'List' }));
    expect(await screen.findAllByTestId('mylist-row')).toHaveLength(2);
    expect(localStorage.getItem(VIEW_KEY)).toBe('list');
    cleanup();

    h.installCore(rpc, [ARRIVAL, DARK]);
    open();
    expect(await screen.findAllByTestId('mylist-row')).toHaveLength(2);
    expect(screen.queryAllByTestId('mylist-card')).toHaveLength(0);
    act(() => fireEvent.click(within(screen.getByRole('radiogroup', { name: 'View' })).getByRole('radio', { name: 'Grid' })));
    expect(await screen.findAllByTestId('mylist-card')).toHaveLength(2);
    expect(localStorage.getItem(VIEW_KEY)).toBeNull();
  });
});
