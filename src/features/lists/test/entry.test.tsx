// The ways in to custom lists: the L key on a Live channel row, the
// "Add to list…" menu action, the sidebar section, and "New list".
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel } from '@/api/types';

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
const { ListsDialogHost } = await import('../host');
// Load the lazy dialogs up front so a busy run doesn't outlast findBy's timeout.
await Promise.all([import('../dialogs/CreateListDialog')]);
const { useListsDialogs, openCreateList } = await import('../store');
const { useAddToListMenuItem, useAddToListShortcut } = await import('../hooks/useAddToList');
const { ListsSidebarSection } = await import('../components/ListsSidebarSection');

const BBC = h.channel('1', 'BBC One');
const CNN = h.channel('2', 'CNN');
const JAZZ = h.channel('4', 'Jazz FM', { radio: true });
const MOVIE: Channel = { ...h.channel('7', 'A film'), ref: { sourceId: 'src1', contentType: 'movie', itemId: '7' } };

function FakeLive({ channels, focused }: { channels: Channel[]; focused?: Channel }) {
  useAddToListShortcut(focused, (i) => channels[i]);
  return (
    <>
      <div data-testid="channel-list">
        {channels.map((c, i) => (
          <button key={c.ref.itemId} type="button" data-row-index={i}>
            {c.name}
          </button>
        ))}
      </div>
      <button type="button">elsewhere</button>
    </>
  );
}
const dialog = () => useListsDialogs.getState().dialog;

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
  localStorage.clear();
});
afterEach(cleanup);

describe('L on a channel row', () => {
  it('opens the picker for the row under focus and claims the key', () => {
    render(<FakeLive channels={[BBC, CNN, JAZZ]} focused={BBC} />);
    const row = screen.getByRole('button', { name: 'CNN' });
    row.focus();
    const event = new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', bubbles: true, cancelable: true });
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    row.dispatchEvent(event);
    window.removeEventListener('keydown', seen);
    expect(dialog()).toEqual({ kind: 'picker', channel: CNN });
    expect(event.defaultPrevented).toBe(true);
    // The player's "seek forward" on window never sees it.
    expect(seen).not.toHaveBeenCalled();
  });

  it('works for radio, and with Caps Lock (L)', () => {
    render(<FakeLive channels={[BBC, CNN, JAZZ]} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Jazz FM' }), { key: 'L', code: 'KeyL' });
    expect(dialog()).toEqual({ kind: 'picker', channel: JAZZ });
  });

  it('leaves the key alone off a row, with modifiers, on repeat, or under a dialog', () => {
    render(<FakeLive channels={[BBC, CNN]} focused={BBC} />);
    const row = screen.getByRole('button', { name: 'BBC One' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'elsewhere' }), { key: 'l' });
    fireEvent.keyDown(row, { key: 'l', ctrlKey: true });
    fireEvent.keyDown(row, { key: 'l', shiftKey: true });
    fireEvent.keyDown(row, { key: 'l', repeat: true });
    fireEvent.keyDown(row, { key: 'k' });
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    fireEvent.keyDown(row, { key: 'l' });
    modal.remove();
    expect(dialog()).toBeNull();
  });

  it('ignores rows that are not channels', () => {
    render(<FakeLive channels={[MOVIE]} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'A film' }), { key: 'l' });
    expect(dialog()).toBeNull();
  });
});

describe('Add to list menu action', () => {
  it('opens the picker for live channels and radio, and is absent otherwise', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => <h.Providers>{children}</h.Providers>;
    const live = renderHook(() => useAddToListMenuItem(BBC), { wrapper });
    expect(live.result.current?.label).toBe('Add to list…');
    act(() => live.result.current!.onSelect?.());
    expect(dialog()).toEqual({ kind: 'picker', channel: BBC });
    expect(renderHook(() => useAddToListMenuItem(JAZZ), { wrapper }).result.current).not.toBeNull();
    expect(renderHook(() => useAddToListMenuItem(MOVIE), { wrapper }).result.current).toBeNull();
    expect(renderHook(() => useAddToListMenuItem(null), { wrapper }).result.current).toBeNull();
  });
});

describe('sidebar section', () => {
  const routes = [
    { path: '/live', element: <ListsSidebarSection /> },
    { path: '/lists/:listId', element: <ListsSidebarSection activeListId="L2" /> },
  ];

  it('links each list with its count, marks the open one, and moves with arrow keys', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN]), h.coreList('L2', 'Kids', [CNN]), h.coreList('L3', 'Radio', [JAZZ])]);
    h.renderAt('/lists/L2', routes);
    const list = await screen.findByTestId('lists-sidebar');
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Sports2', 'Kids1', 'Radio1']);
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/lists/L1', '/lists/L2', '/lists/L3']);
    expect(links[1]!.getAttribute('aria-current')).toBe('page');
    // One tab stop, on the open list.
    expect(links.map((l) => l.tabIndex)).toEqual([-1, 0, -1]);
    links[1]!.focus();
    fireEvent.keyDown(links[1]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(links[2]);
    fireEvent.keyDown(links[2]!, { key: 'Home' });
    expect(document.activeElement).toBe(links[0]);
    fireEvent.keyDown(links[0]!, { key: 'End' });
    expect(document.activeElement).toBe(links[2]);
    fireEvent.click(links[0]!);
    await waitFor(() => expect(h.location.current).toBe('/lists/L1'));
  });

  it('folds, and remembers it', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC])]);
    const first = h.renderAt('/live', routes);
    await screen.findByTestId('lists-sidebar');
    const fold = screen.getByRole('button', { name: 'Lists' });
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('lists-sidebar').closest('[hidden]')).not.toBeNull();
    first.unmount();
    h.renderAt('/live', routes);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Lists/ }).getAttribute('aria-expanded')).toBe('false'));
  });

  it('empty: invites a new list; New list and Manage open their dialogs', async () => {
    h.installCore(rpc, []);
    h.renderAt('/live', routes);
    await screen.findByText('Group channels from any source.');
    fireEvent.click(within(screen.getByTestId('lists-section')).getAllByRole('button', { name: 'New list' }).at(-1)!);
    expect(dialog()).toEqual({ kind: 'create', channel: undefined, openAfter: true });
    fireEvent.click(screen.getByRole('button', { name: 'Manage lists' }));
    expect(dialog()).toEqual({ kind: 'manage', focusId: undefined });
  });

  it('a load failure says so and retries', async () => {
    const core = h.installCore(rpc, [h.coreList('L1', 'Sports', [])]);
    core.fail['lists.list'] = 'db';
    h.renderAt('/live', routes);
    await screen.findByText("Couldn't load your lists");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('lists-sidebar');
  });
});

describe('New list dialog', () => {
  it('creates the list and opens it when asked to', async () => {
    h.installCore(rpc, []);
    h.renderAt('/live', [{ path: '/live', element: <p /> }], <ListsDialogHost />);
    act(() => openCreateList({ openAfter: true }));
    const create = await screen.findByTestId('list-create');
    expect(within(create).getByText('Up to 60 characters.')).toBeTruthy();
    fireEvent.change(within(create).getByLabelText('New list name'), { target: { value: 'Sports' } });
    fireEvent.click(within(create).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(h.location.current).toBe('/lists/new1'));
    await waitFor(() => expect(screen.queryByTestId('list-create')).toBeNull());
  });

  it('started from a channel, stays put and offers to open the list', async () => {
    h.installCore(rpc, []);
    h.renderAt('/live', [{ path: '/live', element: <p /> }], <ListsDialogHost />);
    act(() => openCreateList({ channel: BBC }));
    const create = await screen.findByTestId('list-create');
    expect(within(create).getByText('It starts with BBC One.')).toBeTruthy();
    fireEvent.change(within(create).getByLabelText('New list name'), { target: { value: 'Mornings' } });
    fireEvent.click(within(create).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(h.lastToast()?.title).toBe('Created Mornings'));
    expect(h.location.current).toBe('/live');
    expect(rpc.callsOf('lists.create')).toEqual([{ name: 'Mornings', items: [{ ref: BBC.ref, snapshot: { title: 'BBC One', subtitle: 'News', contentType: 'live' } }] }]);
    act(() => h.lastToast()!.action!.onClick());
    await waitFor(() => expect(h.location.current).toBe('/lists/new1'));
  });
});
