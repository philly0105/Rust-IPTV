// My List toggle (contract C3): MyListButton in both variants, useInMyList,
// the menu item, and the toggle's optimistic patch, rollback and Undo.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef, ItemSnapshot } from '@/api/types';

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
const { queryClient } = await import('@/api/query');
const { MyListButton, useInMyList, useMyListMenuItem } = await import('..');
const { LIST_KEY } = await import('../lib/cache');

const arrival: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm1' };
const dark: ItemRef = { sourceId: 'src1', contentType: 'series', itemId: 's1' };
const severance: ItemRef = { sourceId: 'src1', contentType: 'series', itemId: 's2' };
const channel: ItemRef = { sourceId: 'src1', contentType: 'live', itemId: 'c1' };
const snap = (title: string, ref: ItemRef): ItemSnapshot => ({ title, contentType: ref.contentType, posterUrl: `https://img/${ref.itemId}.jpg` });

function Wrap({ children }: { children: ReactNode }) {
  return <h.Providers path="/movie/m1">{children}</h.Providers>;
}

const button = () => screen.getByTestId('mylist-button');

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
});
afterEach(cleanup);

describe('MyListButton', () => {
  it('adds a title: aria-pressed flips at once, the core gets the snapshot, the toast opens My List', async () => {
    const core = h.installCore(rpc, [h.entry(dark, 'Dark')]);
    render(
      <Wrap>
        <MyListButton itemRef={arrival} snapshot={snap('Arrival', arrival)} />
      </Wrap>,
    );
    await waitFor(() => expect(rpc.callsOf('watchlist.list')).toHaveLength(1));
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(button().textContent).toBe('My List');
    expect(button().dataset['variant']).toBe('button');

    fireEvent.click(button());
    // Optimistic: pressed before the core answers.
    expect(button().getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(h.lastToast()?.title).toBe('Added Arrival to My List'));
    expect(rpc.callsOf('watchlist.toggle')).toEqual([{ ref: arrival, snapshot: snap('Arrival', arrival) }]);
    expect(h.titles(core.entries)).toEqual(['Arrival', 'Dark']);

    act(() => h.lastToast()!.action!.onClick());
    await waitFor(() => expect(h.location.current).toBe('/my-list'));
  });

  it('removes a title and Undo puts it back in its old place', async () => {
    const core = h.installCore(rpc, [h.entry(dark, 'Dark'), h.entry(arrival, 'Arrival'), h.entry(severance, 'Severance')]);
    render(
      <Wrap>
        <MyListButton itemRef={arrival} snapshot={snap('Arrival', arrival)} variant="icon" />
      </Wrap>,
    );
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'));
    expect(button().getAttribute('aria-label')).toBe('Save Arrival to My List');
    expect(button().dataset['inList']).toBe('true');

    fireEvent.click(button());
    expect(button().getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => expect(h.lastToast()?.title).toBe('Removed Arrival from My List'));
    expect(h.titles(core.entries)).toEqual(['Dark', 'Severance']);
    expect(h.lastToast()?.action?.label).toBe('Undo');

    act(() => h.lastToast()!.action!.onClick());
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Dark', 'Arrival', 'Severance']));
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'));
  });

  it('Undo after the title was saved again elsewhere only moves it back', async () => {
    const core = h.installCore(rpc, [h.entry(dark, 'Dark'), h.entry(arrival, 'Arrival')]);
    render(
      <Wrap>
        <MyListButton itemRef={arrival} snapshot={snap('Arrival', arrival)} />
      </Wrap>,
    );
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(button());
    await waitFor(() => expect(h.lastToast()?.action?.label).toBe('Undo'));
    // Another window saves it again before Undo.
    core.entries = [h.entry(arrival, 'Arrival'), h.entry(dark, 'Dark')];
    const toggles = rpc.callsOf('watchlist.toggle').length;

    act(() => h.lastToast()!.action!.onClick());
    await waitFor(() => expect(h.titles(core.entries)).toEqual(['Dark', 'Arrival']));
    expect(rpc.callsOf('watchlist.toggle')).toHaveLength(toggles);
  });

  it('rolls back and says why when the core refuses (full list)', async () => {
    const core = h.installCore(rpc, []);
    core.fail['watchlist.toggle'] = 'conflict';
    render(
      <Wrap>
        <MyListButton itemRef={arrival} snapshot={snap('Arrival', arrival)} />
      </Wrap>,
    );
    await waitFor(() => expect(rpc.callsOf('watchlist.list')).toHaveLength(1));
    fireEvent.click(button());
    expect(button().getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(h.lastToast()?.variant).toBe('error'));
    expect(h.lastToast()).toMatchObject({
      title: "Couldn't update My List for Arrival",
      description: 'My List is full. Remove some titles to make room.',
    });
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(core.entries).toEqual([]);
  });

  it('ignores a second press while the first is in flight', async () => {
    h.installCore(rpc, []);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const toggle = rpc.handlers['watchlist.toggle']!;
    rpc.handlers['watchlist.toggle'] = async (a) => {
      await gate;
      return toggle(a);
    };
    render(
      <Wrap>
        <MyListButton itemRef={arrival} snapshot={snap('Arrival', arrival)} variant="icon" />
        <MyListButton itemRef={arrival} snapshot={snap('Arrival', arrival)} />
      </Wrap>,
    );
    await waitFor(() => expect(rpc.callsOf('watchlist.list')).toHaveLength(1));
    const [icon, labelled] = screen.getAllByTestId('mylist-button');
    fireEvent.click(icon!);
    fireEvent.click(icon!);
    fireEvent.click(labelled!);
    expect(icon!.getAttribute('aria-busy')).toBe('true');
    release();
    await waitFor(() => expect(h.lastToast()?.title).toBe('Added Arrival to My List'));
    expect(rpc.callsOf('watchlist.toggle')).toHaveLength(1);
    expect(labelled!.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the click from reaching a surrounding link or card', async () => {
    h.installCore(rpc, []);
    const outer = vi.fn();
    render(
      <Wrap>
        <div onClick={outer}>
          <MyListButton itemRef={arrival} snapshot={snap('Arrival', arrival)} variant="icon" />
        </div>
      </Wrap>,
    );
    await waitFor(() => expect(rpc.callsOf('watchlist.list')).toHaveLength(1));
    fireEvent.click(button());
    expect(outer).not.toHaveBeenCalled();
    await waitFor(() => expect(h.lastToast()).toBeDefined());
  });

  it('renders nothing for live and radio refs', async () => {
    h.installCore(rpc, []);
    const { container } = render(
      <Wrap>
        <MyListButton itemRef={channel} snapshot={{ title: 'News 24', contentType: 'live' }} />
        <MyListButton itemRef={{ ...channel, contentType: 'radio' }} snapshot={{ title: 'Jazz FM', contentType: 'radio' }} variant="icon" />
      </Wrap>,
    );
    expect(container.querySelector('[data-testid="mylist-button"]')).toBeNull();
  });

  it('follows changes made elsewhere through the shared query', async () => {
    const core = h.installCore(rpc, []);
    render(
      <Wrap>
        <MyListButton itemRef={dark} snapshot={snap('Dark', dark)} />
      </Wrap>,
    );
    await waitFor(() => expect(rpc.callsOf('watchlist.list')).toHaveLength(1));
    expect(button().getAttribute('aria-pressed')).toBe('false');
    core.entries = [h.entry(dark, 'Dark')];
    await act(() => queryClient.invalidateQueries({ queryKey: LIST_KEY }));
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'));
  });
});

describe('useInMyList', () => {
  it('answers which refs are saved, keyed sourceId|contentType|itemId, from one query', async () => {
    h.installCore(rpc, [h.entry(arrival, 'Arrival'), h.entry(severance, 'Severance')]);
    const { result } = renderHook(() => ({ a: useInMyList([arrival, dark, severance]), b: useInMyList([dark]) }), { wrapper: Wrap });
    await waitFor(() => expect([...result.current.a]).toEqual(['src1|movie|m1', 'src1|series|s2']));
    expect(result.current.b.size).toBe(0);
    expect(rpc.callsOf('watchlist.list')).toHaveLength(1);
  });

  it('is empty before the list loads and for an empty ref list', () => {
    h.installCore(rpc, [h.entry(arrival, 'Arrival')]);
    rpc.handlers['watchlist.list'] = () => new Promise(() => undefined);
    const { result } = renderHook(() => ({ some: useInMyList([arrival]), none: useInMyList([]) }), { wrapper: Wrap });
    expect(result.current.some.size).toBe(0);
    expect(result.current.none.size).toBe(0);
  });
});

describe('useMyListMenuItem', () => {
  it('offers add or remove and toggles like the button', async () => {
    const core = h.installCore(rpc, []);
    const { result } = renderHook(() => useMyListMenuItem({ ref: arrival, snapshot: snap('Arrival', arrival) }), { wrapper: Wrap });
    await waitFor(() => expect(rpc.callsOf('watchlist.list')).toHaveLength(1));
    expect(result.current).toMatchObject({ id: 'mylist', label: 'Add to My List' });
    act(() => result.current!.onSelect());
    await waitFor(() => expect(result.current?.label).toBe('Remove from My List'));
    expect(h.titles(core.entries)).toEqual(['Arrival']);
  });

  it('is null for no target and for live refs', () => {
    h.installCore(rpc, []);
    const { result } = renderHook(
      () => [useMyListMenuItem(null), useMyListMenuItem({ ref: channel, snapshot: { title: 'News', contentType: 'live' } })],
      { wrapper: Wrap },
    );
    expect(result.current).toEqual([null, null]);
  });
});
