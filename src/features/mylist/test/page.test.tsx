// The /my-list page (contract C3): filter, sort, search and Hide watched in
// the URL; reorder by keyboard, buttons and drag; remove with Undo; the
// watched tick; and every designed state.
import { act, cleanup, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KeyboardEvent } from 'react';

import type { ItemRef, WatchlistEntry } from '@/api/types';

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
const { useShellStore } = await import('@/shell/store');
const { shortcutRegistry } = await import('@/shell/shortcuts');

const m = (id: string, sourceId = 'src1'): ItemRef => ({ sourceId, contentType: 'movie', itemId: id });
const s = (id: string): ItemRef => ({ sourceId: 'src1', contentType: 'series', itemId: id });

const ARRIVAL = h.entry(m('m1'), 'Arrival', { addedAt: '2026-10-01T10:00:00Z' });
const DARK = h.entry(s('s1'), 'Dark', { addedAt: '2026-10-05T10:00:00Z', subtitle: '2017' });
const HEAT = h.entry(m('m2'), 'Heat', { addedAt: '2026-10-03T10:00:00Z', watched: true });
const BLADE = h.entry(m('m3'), 'Blade Runner', { addedAt: '2026-10-02T10:00:00Z' });
const LIST = [ARRIVAL, DARK, HEAT, BLADE];

function open(path = '/my-list') {
  return h.renderAt(path, [{ path: '/my-list', element: <MyListPage /> }]);
}

const shownTitles = () =>
  screen.getAllByTestId('mylist-row').map((r) => r.querySelector('[data-action="open"] span')!.textContent);
const rowOf = (title: string) => screen.getAllByTestId('mylist-row').find((r) => r.querySelector('[data-action="open"] span')!.textContent === title)!;
const itemOf = (title: string) => rowOf(title).closest<HTMLElement>('[role="listitem"]')!;
const press = (el: HTMLElement, key: string, opts: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(el, { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ...opts });
const header = () => useShellStore.getState().header;

async function loaded(entries: WatchlistEntry[] = LIST, path?: string) {
  const core = h.installCore(rpc, entries);
  open(path);
  await screen.findAllByTestId('mylist-row');
  return core;
}

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
  // These tests drive the list view; the poster grid (the default) has its own (saas2.test.tsx).
  localStorage.setItem('mylist.view', 'list');
  rpc.handlers['positions.get'] = () => null;
  rpc.handlers['positions.forSeries'] = () => [];
});
afterEach(() => {
  cleanup();
  shortcutRegistry.reset();
});

describe('MyListPage: list and header', () => {
  it('lists every title in the user order with ranks, and sets the header with a count, a purpose and the search', async () => {
    await loaded();
    expect(shownTitles()).toEqual(['Arrival', 'Dark', 'Heat', 'Blade Runner']);
    expect(screen.getAllByTestId('mylist-rank').map((r) => r.textContent)).toEqual(['1', '2', '3', '4']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('My List');
    expect(header()).toMatchObject({ title: 'My List', subtitle: '4 titles · Movies and series to watch later, in your order' });
    // The search is in the shell header, as on Favorites and Recently watched (library-06).
    expect(header()?.search).toMatchObject({ value: '', placeholder: 'Search My List' });
    expect(within(screen.getByTestId('mylist-toolbar')).queryByRole('searchbox')).toBeNull();
    expect(within(rowOf('Heat')).getByTestId('mylist-watched').textContent).toBe('Watched');
    expect(screen.getByRole('list', { name: 'My List' })).toBeTruthy();
    // Series carry no watched tick (they are marked episode by episode).
    expect(rowOf('Dark').querySelector('[data-action="watched"]')).toBeNull();
    expect(rowOf('Arrival').querySelector('[data-action="watched"]')).not.toBeNull();
  });

  it('gives the title the width below sm: rank on the poster, no grip, actions on their own visible line', async () => {
    // jsdom has no layout, so this pins the responsive classes behind the 390 px fix (R1-craft).
    await loaded();
    const row = rowOf('Arrival');
    const rank = within(row).getByTestId('mylist-rank');
    expect(rank.className).toMatch(/(^|\s)absolute(\s|$)/);
    expect(rank.className).toContain('sm:static');
    // The grip shows only from sm up, on a fine pointer.
    const grip = within(row).getByTestId('mylist-drag');
    expect(grip.className).toContain('sm:pointer-fine:flex');
    expect(grip.className).not.toMatch(/(^|\s)pointer-fine:flex/);
    // Actions: their own grid line under the title; the move buttons hide on hover only from sm up.
    expect(within(row).getByTestId('mylist-actions').className).toContain('row-start-2');
    const moves = within(row).getByTestId('mylist-move').className;
    expect(moves).toContain('sm:pointer-fine:opacity-0');
    expect(moves).not.toMatch(/(^|\s)pointer-fine:opacity-0/);
    // Two lines before the ellipsis, and the full title on hover.
    const title = within(row).getByTestId('mylist-title');
    expect(title.className).toContain('line-clamp-2');
    expect(title.getAttribute('title')).toBe('Arrival');
  });

  it('on touch puts the ⋮ beside the title and lets a tap anywhere on the row open it (v-phone-07)', async () => {
    await loaded();
    const row = rowOf('Arrival');
    expect(row.className).toContain('pointer-coarse:grid-cols-[3rem_minmax(0,1fr)_auto]');
    const actions = within(row).getByTestId('mylist-actions').className;
    expect(actions).toContain('pointer-coarse:col-start-3');
    expect(actions).toContain('pointer-coarse:row-start-1');
    // Above the title's stretched target, so the ⋮ and Play still get their own taps.
    expect(actions).toMatch(/(^|\s)relative(\s|$)/);
    expect(actions).toContain('z-[1]');
    const open = within(row).getByTestId('mylist-open').className;
    expect(open).toContain('pointer-coarse:after:absolute');
    expect(open).toContain('pointer-coarse:after:inset-0');
  });

  it('shows the source on each row only when the list spans several', async () => {
    await loaded();
    expect(screen.queryAllByTestId('mylist-source')).toHaveLength(0);
    cleanup();
    h.resetShared();
    await loaded([ARRIVAL, h.entry(m('x1', 'src2'), 'Ronin')]);
    expect(screen.getAllByTestId('mylist-source').map((e) => e.textContent)).toEqual(['Home portal', 'Backup list']);
  });

  it('opens a title with Enter or a click on its name', async () => {
    await loaded();
    itemOf('Dark').focus();
    press(itemOf('Dark'), 'Enter');
    await waitFor(() => expect(h.location.current).toBe('/s/src1/series/s1'));
  });
});

describe('MyListPage: designed states', () => {
  it('shows a skeleton while the list loads', async () => {
    h.installCore(rpc, LIST);
    rpc.handlers['watchlist.list'] = () => new Promise(() => undefined);
    open();
    const loading = await screen.findByTestId('mylist-loading');
    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.textContent).toContain('Loading My List');
    expect(screen.queryByTestId('mylist-toolbar')).toBeNull();
  });

  it('shows the error with a hint, and Retry loads the list', async () => {
    const core = h.installCore(rpc, LIST);
    core.fail['watchlist.list'] = 'db';
    open();
    await screen.findByText(/stored by the app, not your provider/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findAllByTestId('mylist-row');
    expect(shownTitles()).toHaveLength(4);
  });

  it('invites saving when empty, with a way to browse', async () => {
    h.installCore(rpc, []);
    open();
    const empty = await screen.findByTestId('mylist-empty');
    expect(within(empty).getByText('Nothing saved yet')).toBeTruthy();
    await waitFor(() => expect(within(empty).getByTestId('mylist-empty-browse').getAttribute('href')).toBe('/s/src1/movies'));
    expect(within(empty).getByTestId('mylist-empty-browse-series').getAttribute('href')).toBe('/s/src1/series');
    expect(screen.queryByTestId('mylist-toolbar')).toBeNull();
  });

  it('asks for a source first when there is none', async () => {
    // The dialog is a lazy chunk: loaded ahead, so a slow transform under load does not outlast findBy.
    await import('@/features/sources/components/AddSourceDialog');
    h.installCore(rpc, []);
    rpc.handlers['sources.list'] = () => [];
    open();
    // The state every page shows without a source: Add a source opens the dialog right here.
    const add = await screen.findByTestId('mylist-empty-add-source');
    expect(add.tagName).toBe('BUTTON');
    expect(screen.getByText(/Add a source first/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Import a backup' }).getAttribute('href')).toBe('/settings/backup');
    fireEvent.click(add);
    expect(await screen.findByTestId('add-source-dialog')).toBeTruthy();
  });

  it('says when a type filter empties the list, and Show all clears it', async () => {
    h.installCore(rpc, [ARRIVAL, HEAT]);
    open('/my-list?type=series');
    await screen.findByText('No series in My List');
    fireEvent.click(screen.getByTestId('mylist-show-all'));
    await screen.findAllByTestId('mylist-row');
    expect(h.location.current).toBe('/my-list');
  });

  it('says when everything here is watched, and Show watched brings it back', async () => {
    h.installCore(rpc, [HEAT]);
    open('/my-list?watched=hide');
    await screen.findByText('All watched');
    expect(screen.getByText('The one title here is watched. Show watched titles to see it again.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mylist-show-watched'));
    await screen.findAllByTestId('mylist-row');
    expect(h.location.current).toBe('/my-list');
  });

  it('says when the search matches nothing, and Clear search resets it', async () => {
    h.installCore(rpc, LIST);
    open('/my-list?q=zzz');
    await screen.findByText('Nothing in My List matches “zzz”.');
    fireEvent.click(screen.getByTestId('mylist-clear-search'));
    await screen.findAllByTestId('mylist-row');
    expect(h.location.current).toBe('/my-list');
  });
});

describe('MyListPage: filter, sort, search, Hide watched', () => {
  it('filters by type with counts on the tabs, mirrored in the URL', async () => {
    await loaded();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['All4', 'Movies3', 'Series1']);
    fireEvent.click(screen.getByRole('tab', { name: /Movies/ }));
    await waitFor(() => expect(shownTitles()).toEqual(['Arrival', 'Heat', 'Blade Runner']));
    expect(h.location.current).toBe('/my-list?type=movie');
    expect(screen.getByRole('tab', { name: /Movies/ }).getAttribute('aria-selected')).toBe('true');
    // Ranks stay the place in the whole list.
    expect(screen.getAllByTestId('mylist-rank').map((r) => r.textContent)).toEqual(['1', '3', '4']);
  });

  it('sorts by newest add or title; ranks and move controls show only in the user order', async () => {
    await loaded();
    const sort = screen.getByTestId('mylist-sort') as HTMLSelectElement;
    fireEvent.change(sort, { target: { value: 'added' } });
    await waitFor(() => expect(shownTitles()).toEqual(['Dark', 'Heat', 'Blade Runner', 'Arrival']));
    expect(h.location.current).toBe('/my-list?sort=added');
    expect(screen.queryAllByTestId('mylist-rank')).toHaveLength(0);
    expect(document.querySelector('[data-action="move-up"]')).toBeNull();
    expect(screen.queryAllByTestId('mylist-drag')).toHaveLength(0);

    fireEvent.change(sort, { target: { value: 'title' } });
    await waitFor(() => expect(shownTitles()).toEqual(['Arrival', 'Blade Runner', 'Dark', 'Heat']));
    expect(h.location.current).toBe('/my-list?sort=title');
  });

  it('hides watched titles with the switch', async () => {
    await loaded();
    fireEvent.click(screen.getByRole('switch', { name: 'Hide watched' }));
    await waitFor(() => expect(shownTitles()).toEqual(['Arrival', 'Dark', 'Blade Runner']));
    expect(h.location.current).toBe('/my-list?watched=hide');
  });

  it('hides the switch when nothing in view is watched', async () => {
    await loaded([ARRIVAL, DARK]);
    expect(screen.queryByRole('switch', { name: 'Hide watched' })).toBeNull();
  });

  it('searches from the header, accent-blind, mirrored in the URL', async () => {
    await loaded([...LIST, h.entry(m('m9'), 'Amélie')]);
    act(() => header()!.search!.onChange('amelie'));
    await waitFor(() => expect(shownTitles()).toEqual(['Amélie']));
    expect(h.location.current).toBe('/my-list?q=amelie');
    await waitFor(() => expect(header()?.search?.value).toBe('amelie'));
  });

  it('keeps the search box when it matches nothing, and ArrowDown moves on to the list', async () => {
    h.installCore(rpc, LIST);
    open('/my-list?q=zzz');
    await screen.findByText('Nothing in My List matches “zzz”.');
    expect(header()?.search?.value).toBe('zzz');
    act(() => header()!.search!.onChange('dar'));
    await waitFor(() => expect(shownTitles()).toEqual(['Dark']));
    const preventDefault = vi.fn();
    act(() => header()!.search!.onKeyDown!({ key: 'ArrowDown', preventDefault } as unknown as KeyboardEvent<HTMLInputElement>));
    expect(preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(itemOf('Dark'));
  });

  it('restores filter, sort and Hide watched from the URL', async () => {
    await loaded(LIST, '/my-list?type=movie&sort=title&watched=hide');
    expect(shownTitles()).toEqual(['Arrival', 'Blade Runner']);
    expect(screen.getByRole('switch', { name: 'Hide watched' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('MyListPage: the title menu (library-05)', () => {
  it('opens on a right click with play, details, the watched mark, the moves and remove', async () => {
    await loaded();
    fireEvent.contextMenu(rowOf('Arrival'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Play',
      'Open details',
      'Mark as watched',
      'Move up',
      'Move down',
      'Remove from My List',
    ]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from My List' }));
    await waitFor(() => expect(rpc.callsOf('watchlist.remove')).toHaveLength(1));
  });

  it('opens from Shift+F10 on the focused title, without the moves in another sort', async () => {
    await loaded(LIST, '/my-list?sort=title');
    itemOf('Dark').focus();
    press(itemOf('Dark'), 'F10', { shiftKey: true });
    const menu = await screen.findByRole('menu');
    // A series with nothing started has no one episode to play, and no watched mark here.
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Open details', 'Remove from My List']);
  });
});

describe('MyListPage: reorder', () => {
  it('moves the focused title with Alt+ArrowDown / Alt+ArrowUp and keeps focus on it', async () => {
    const core = await loaded();
    itemOf('Arrival').focus();
    press(itemOf('Arrival'), 'ArrowDown', { altKey: true });
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Dark', 'Arrival', 'Heat', 'Blade Runner']));
    expect(shownTitles()).toEqual(['Dark', 'Arrival', 'Heat', 'Blade Runner']);
    await waitFor(() => expect(document.activeElement).toBe(itemOf('Arrival')));

    press(itemOf('Arrival'), 'ArrowUp', { altKey: true });
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Arrival', 'Dark', 'Heat', 'Blade Runner']));
    expect(rpc.callsOf('watchlist.reorder')).toHaveLength(2);
  });

  it('does nothing past the ends', async () => {
    await loaded();
    itemOf('Arrival').focus();
    press(itemOf('Arrival'), 'ArrowUp', { altKey: true });
    itemOf('Blade Runner').focus();
    press(itemOf('Blade Runner'), 'ArrowDown', { altKey: true });
    await act(async () => undefined);
    expect(rpc.callsOf('watchlist.reorder')).toHaveLength(0);
  });

  it('in a filtered view moves among the rows on screen; the others keep their slots', async () => {
    const core = await loaded(LIST, '/my-list?type=movie');
    // Movies: Arrival, Heat, Blade Runner. Blade Runner up past Heat.
    itemOf('Blade Runner').focus();
    press(itemOf('Blade Runner'), 'ArrowUp', { altKey: true });
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Arrival', 'Dark', 'Blade Runner', 'Heat']));
  });

  it('moves with the row buttons', async () => {
    const core = await loaded();
    const up = rowOf('Heat').querySelector<HTMLButtonElement>('[data-action="move-up"]')!;
    expect(up.getAttribute('aria-label')).toBe('Move Heat up');
    fireEvent.click(up);
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Arrival', 'Heat', 'Dark', 'Blade Runner']));
    expect(rowOf('Arrival').querySelector<HTMLButtonElement>('[data-action="move-up"]')!.disabled).toBe(true);
    expect(rowOf('Blade Runner').querySelector<HTMLButtonElement>('[data-action="move-down"]')!.disabled).toBe(true);
  });

  it('moves by drag and drop: the upper half of a row drops before it, the lower half after', async () => {
    const core = await loaded();
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? '',
      effectAllowed: 'all',
      dropEffect: 'none',
    };
    // jsdom has no DragEvent, so clientY has to be put on the event by hand.
    const at = (kind: 'dragOver' | 'drop', el: HTMLElement, clientY: number) => {
      const ev = createEvent[kind](el, { dataTransfer });
      Object.defineProperty(ev, 'clientY', { value: clientY });
      fireEvent(el, ev);
    };
    const drag = async (from: string, onto: string, clientY: number) => {
      fireEvent.dragStart(within(rowOf(from)).getByTestId('mylist-drag'), { dataTransfer });
      const target = rowOf(onto);
      target.getBoundingClientRect = () => ({ top: 0, height: 88, bottom: 88, left: 0, right: 600, width: 600, x: 0, y: 0, toJSON: () => ({}) });
      at('dragOver', target, clientY);
      await waitFor(() => expect(rowOf(onto).querySelector('.bg-accent-mark')).not.toBeNull());
      at('drop', rowOf(onto), clientY);
    };

    await drag('Blade Runner', 'Arrival', 10);
    expect(data.get('text/plain')).toBe('Blade Runner');
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Blade Runner', 'Arrival', 'Dark', 'Heat']));
    await waitFor(() => expect(shownTitles()).toEqual(['Blade Runner', 'Arrival', 'Dark', 'Heat']));
    expect(document.querySelector('.bg-accent-mark')).toBeNull();

    await drag('Blade Runner', 'Dark', 70);
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Arrival', 'Dark', 'Blade Runner', 'Heat']));
  });

  it('puts the old order back and says so when the core refuses', async () => {
    const core = await loaded();
    core.fail['watchlist.reorder'] = 'db';
    itemOf('Arrival').focus();
    press(itemOf('Arrival'), 'ArrowDown', { altKey: true });
    await waitFor(() => expect(h.lastToast()?.title).toBe("Couldn't save the new order"));
    await waitFor(() => expect(shownTitles()).toEqual(['Arrival', 'Dark', 'Heat', 'Blade Runner']));
  });

  it('sends a burst of moves to the core one at a time, in press order', async () => {
    const core = await loaded();
    // Hold the core so all three presses queue up behind the first.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reorder = rpc.handlers['watchlist.reorder']!;
    rpc.handlers['watchlist.reorder'] = async (a) => {
      await gate;
      return reorder(a);
    };
    itemOf('Arrival').focus();
    // Back to back, before React re-renders: each press still moves one further.
    for (let i = 0; i < 3; i += 1) press(document.activeElement as HTMLElement, 'ArrowDown', { altKey: true });
    // The page shows the final order while the core is still held, and focus stays on the moved row.
    await waitFor(() => expect(shownTitles()).toEqual(['Dark', 'Heat', 'Blade Runner', 'Arrival']));
    expect(document.activeElement).toBe(itemOf('Arrival'));
    expect(rpc.callsOf('watchlist.reorder')).toHaveLength(1);
    const lists = rpc.callsOf('watchlist.list').length;
    release();
    await waitFor(() => expect(rpc.callsOf('watchlist.reorder')).toHaveLength(3));
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Dark', 'Heat', 'Blade Runner', 'Arrival']));
    // One refetch after the last move, not one per move.
    await waitFor(() => expect(rpc.callsOf('watchlist.list')).toHaveLength(lists + 1));
    await act(async () => undefined);
    expect(rpc.callsOf('watchlist.list')).toHaveLength(lists + 1);
    expect(shownTitles()).toEqual(['Dark', 'Heat', 'Blade Runner', 'Arrival']);
  });
});

describe('MyListPage: remove and watched', () => {
  it('removes the focused title with Delete; Undo puts it back in its place', async () => {
    const core = await loaded();
    itemOf('Heat').focus();
    press(itemOf('Heat'), 'Delete');
    await waitFor(() => expect(h.lastToast()?.title).toBe('Removed Heat from My List'));
    expect(h.titles(core.entries)).toEqual(['Arrival', 'Dark', 'Blade Runner']);
    await waitFor(() => expect(shownTitles()).toEqual(['Arrival', 'Dark', 'Blade Runner']));
    expect(header()?.subtitle).toBe('3 titles · Movies and series to watch later, in your order');

    act(() => h.lastToast()!.action!.onClick());
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Arrival', 'Dark', 'Heat', 'Blade Runner']));
    await waitFor(() => expect(shownTitles()).toEqual(['Arrival', 'Dark', 'Heat', 'Blade Runner']));
  });

  it('removes with the row button and restores the row when the core refuses', async () => {
    const core = await loaded();
    core.fail['watchlist.remove'] = 'not_found';
    fireEvent.click(rowOf('Dark').querySelector<HTMLButtonElement>('[data-action="remove"]')!);
    await waitFor(() => expect(h.lastToast()?.variant).toBe('error'));
    expect(h.lastToast()).toMatchObject({ title: "Couldn't remove Dark from My List", description: "This title's source was removed." });
    await waitFor(() => expect(shownTitles()).toContain('Dark'));
  });

  it('marks the focused movie watched with W, with Undo; W on a series does nothing', async () => {
    const core = await loaded();
    rpc.handlers['userstate.setWatched'] = (raw) => {
      const a = raw as { ref: ItemRef; watched: boolean };
      core.entries = core.entries.map((e) => (e.ref.itemId === a.ref.itemId ? { ...e, watched: a.watched } : e));
    };
    rpc.handlers['positions.remove'] = () => undefined;
    rpc.handlers['positions.set'] = () => undefined;

    itemOf('Dark').focus();
    press(itemOf('Dark'), 'w');
    await act(async () => undefined);
    expect(rpc.callsOf('userstate.setWatched')).toHaveLength(0);

    itemOf('Arrival').focus();
    press(itemOf('Arrival'), 'w');
    await waitFor(() => expect(h.lastToast()?.title).toBe('Marked Arrival as watched'));
    expect(rpc.callsOf('userstate.setWatched')).toEqual([{ ref: m('m1'), watched: true }]);
    await waitFor(() => expect(within(rowOf('Arrival')).getByTestId('mylist-watched')).toBeTruthy());
    expect(h.lastToast()?.action?.label).toBe('Undo');
  });

  it('the watched tick is a toggle button that says its state', async () => {
    const core = await loaded();
    rpc.handlers['userstate.setWatched'] = (raw) => {
      const a = raw as { ref: ItemRef; watched: boolean };
      core.entries = core.entries.map((e) => (e.ref.itemId === a.ref.itemId ? { ...e, watched: a.watched } : e));
    };
    const tick = rowOf('Heat').querySelector<HTMLButtonElement>('[data-action="watched"]')!;
    expect(tick.getAttribute('aria-pressed')).toBe('true');
    expect(tick.getAttribute('aria-label')).toBe('Mark Heat as watched');
    fireEvent.click(tick);
    await waitFor(() => expect(h.lastToast()?.title).toBe('Marked Heat as unwatched'));
    await waitFor(() => expect(rowOf('Heat').querySelector('[data-action="watched"]')!.getAttribute('aria-pressed')).toBe('false'));
  });

  it('a watched change and its Undo refresh the VOD grid pages Hide watched filters', async () => {
    const { queryClient } = await import('@/api/query');
    const core = await loaded();
    rpc.handlers['userstate.setWatched'] = (raw) => {
      const a = raw as { ref: ItemRef; watched: boolean };
      core.entries = core.entries.map((e) => (e.ref.itemId === a.ref.itemId ? { ...e, watched: a.watched } : e));
    };
    rpc.handlers['positions.remove'] = () => undefined;
    rpc.handlers['positions.set'] = () => undefined;
    const grid = ['catalog.movies', { sourceId: 'src1', query: { offset: 0, limit: 60 }, hideWatched: true }] as const;
    const stale = () => queryClient.getQueryState(grid)?.isInvalidated ?? false;

    queryClient.setQueryData(grid, []);
    fireEvent.click(rowOf('Arrival').querySelector<HTMLButtonElement>('[data-action="watched"]')!);
    await waitFor(() => expect(h.lastToast()?.action?.label).toBe('Undo'));
    await waitFor(() => expect(stale()).toBe(true));

    queryClient.setQueryData(grid, []);
    act(() => h.lastToast()!.action!.onClick());
    await waitFor(() => expect(stale()).toBe(true));
  });

  it('ignores page keys typed into a search box', async () => {
    await loaded();
    // The header's field, which this test does not draw.
    const input = document.body.appendChild(Object.assign(document.createElement('input'), { type: 'search' }));
    input.focus();
    press(input, 'Delete');
    press(input, 'w');
    await act(async () => undefined);
    expect(rpc.callsOf('watchlist.remove')).toHaveLength(0);
    expect(rpc.callsOf('userstate.setWatched')).toHaveLength(0);    input.remove();
  });

  it('registers its keys for the ? overlay under My List; the move keys only in the user order', async () => {
    await loaded();
    const mine = () =>
      shortcutRegistry
        .list()
        .filter((x) => x.area === 'My List')
        .map((x) => [x.combo, x.description]);
    expect(mine()).toEqual([
      ['alt+arrowup', 'Move the focused title up'],
      ['alt+arrowdown', 'Move the focused title down'],
      ['delete', 'Remove the focused title'],
      ['w', 'Mark the focused movie watched or unwatched'],
      ['shift+f10', 'Open the menu for the title under the cursor'],
      ['contextmenu', 'Open the menu for the title under the cursor'],
    ]);
    fireEvent.change(screen.getByTestId('mylist-sort'), { target: { value: 'title' } });
    await waitFor(() => expect(mine().map(([combo]) => combo)).toEqual(['delete', 'w', 'shift+f10', 'contextmenu']));
  });
});
