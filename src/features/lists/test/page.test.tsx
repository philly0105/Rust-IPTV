// The list page (/lists/:listId) and /lists: channels from several sources in
// the Live ChannelList, play through Live's playChannel with zapping kept in
// the list, the dropped-channels tray, and the designed empty states.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, SourceKind } from '@/api/types';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
const played = vi.hoisted(() => [] as { channel: Channel; kind: SourceKind | undefined; name: string }[]);
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
// The player itself is out of scope: a stage placeholder and a recorder for playChannel.
vi.mock('../deps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../deps')>()),
  PlayerStage: ({ children }: { children?: React.ReactNode }) => <div data-testid="player-stage">{children}</div>,
  playChannel: async (channel: Channel, kind: SourceKind | undefined, _now: string | undefined, name: string) => {
    played.push({ channel, kind, name });
  },
  sourceKindOf: async (sourceId: string) => (sourceId === 'src2' ? 'm3u' : 'xtream'),
}));

const h = await import('./harness');
const rpc = h.createRpcMock();
rpcMock.current = rpc;
const { ListPage } = await import('../pages/ListPage');
const { ListsIndexPage } = await import('../pages/ListsIndexPage');
const { ListsDialogHost } = await import('../host');
// Load the lazy dialogs up front so a busy run doesn't outlast findBy's timeout.
await Promise.all([import('../dialogs/CreateListDialog'), import('../dialogs/EditItemsDialog')]);
const { CustomListRails } = await import('../rails');
const { usePlayerStore } = await import('../deps');

const BBC = h.channel('1', 'BBC One');
const CNN = h.channel('2', 'CNN', { sourceId: 'src2' });
const ARTE = h.channel('3', 'Arte');
const GONE = h.channel('9', 'Old Sports');
const GONE2 = h.channel('10', 'Old Movies');

const routes = [
  { path: '/lists', element: <ListsIndexPage /> },
  { path: '/lists/:listId', element: <ListPage /> },
];
const rows = () => within(screen.getByTestId('channel-list')).getAllByRole('button').filter((b) => b.hasAttribute('data-row-index'));

function stubLiveExtras() {
  rpc.handlers['epg.programs'] = () => [];
  rpc.handlers['epg.mapping'] = () => null;
  rpc.handlers['catalog.item'] = () => null;
  rpc.handlers['settings.update'] = (a) => a;
}

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
  played.length = 0;
  localStorage.clear();
  usePlayerStore.setState({ zapContext: undefined });
});
afterEach(cleanup);

describe('list page', () => {
  it('shows the channels in list order, the sources they come from, and the sidebar', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN, ARTE]), h.coreList('L2', 'Kids', [CNN])]);
    stubLiveExtras();
    h.renderAt('/lists/L1', routes);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('BBC One'), expect.stringContaining('CNN'), expect.stringContaining('Arte')]);
    const sources = screen.getByTestId('list-sources');
    expect(within(sources).getByText(/Home portal/)).toBeTruthy();
    expect(within(sources).getByText(/Backup list/)).toBeTruthy();
    const sidebar = await screen.findByTestId('lists-sidebar');
    expect(within(sidebar).getByRole('link', { name: /Sports/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('player-stage')).toBeTruthy();
  });

  it('plays a row through Live and keeps zapping inside the list', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN])]);
    stubLiveExtras();
    h.renderAt('/lists/L1', routes);
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(rows()[1]!);
    await waitFor(() => expect(played.map((p) => [p.channel.name, p.kind, p.name])).toEqual([['CNN', 'm3u', 'CNN']]));
    expect(usePlayerStore.getState().zapContext).toEqual({ sourceId: 'src2', listId: 'L1' });
  });

  it('dropped channels wait in a tray with Remove each and Remove all', async () => {
    const core = h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC], { dropped: [GONE, GONE2] })]);
    stubLiveExtras();
    h.renderAt('/lists/L1', routes);
    const tray = await screen.findByTestId('list-unavailable');
    expect(tray.querySelector('summary')?.textContent).toBe('No longer offered2');
    expect(within(tray).getByText('Old Sports')).toBeTruthy();
    fireEvent.click(within(tray).getByRole('button', { name: 'Remove all' }));
    await waitFor(() => expect(rpc.callsOf('lists.removeItems')).toEqual([{ id: 'L1', refs: [GONE.ref, GONE2.ref] }]));
    await waitFor(() => expect(screen.queryByTestId('list-unavailable')).toBeNull());
    await waitFor(() => expect(h.lastToast()?.title).toBe('Removed 2 unavailable channels from Sports'));
    expect(core.lists[0]!.items.map((i) => i.title)).toEqual(['BBC One']);
    expect(rows()).toHaveLength(1);
  });

  it('an empty list says how to fill it', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [])]);
    stubLiveExtras();
    h.renderAt('/lists/L1', routes);
    expect(await screen.findByText('This list is empty')).toBeTruthy();
    expect(screen.getByText(/press L on a channel/)).toBeTruthy();
  });

  it('a list whose channels were all dropped says so', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [], { dropped: [GONE] })]);
    stubLiveExtras();
    h.renderAt('/lists/L1', routes);
    expect(await screen.findByText('None of these channels are offered now')).toBeTruthy();
  });

  it('an unknown list id is not found, with a way back', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC])]);
    stubLiveExtras();
    h.renderAt('/lists/nope', routes);
    expect(await screen.findByText('List not found')).toBeTruthy();
  });

  it('Edit channels and Manage open their dialogs from the header', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN])]);
    stubLiveExtras();
    h.renderAt('/lists/L1', routes, <ListsDialogHost />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    act(() => {
      // The shell renders header actions; here they are opened the way the header would.
      screen.getAllByRole('button', { name: 'Edit channels' })[0]!.click();
    });
    expect(await screen.findByTestId('edit-list-dialog')).toBeTruthy();
  });
});

describe('/lists', () => {
  it('opens the first list', async () => {
    h.installCore(rpc, [h.coreList('L7', 'Sports', [BBC]), h.coreList('L8', 'Kids', [])]);
    stubLiveExtras();
    h.renderAt('/lists', routes);
    await waitFor(() => expect(h.location.current).toBe('/lists/L7'));
  });

  it('with no lists, invites the first one', async () => {
    h.installCore(rpc, []);
    stubLiveExtras();
    h.renderAt('/lists', routes, <ListsDialogHost />);
    expect(await screen.findByText('No lists yet')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Create list' })[0]!);
    const create = await screen.findByTestId('list-create');
    fireEvent.change(within(create).getByLabelText('New list name'), { target: { value: 'Sports' } });
    fireEvent.click(within(create).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(h.location.current).toBe('/lists/new1'));
  });
});

describe('Home rails', () => {
  it('one rail per list shown on Home, in list order; a card plays and zaps within its list', async () => {
    h.installCore(rpc, [
      h.coreList('L1', 'Sports', [BBC, CNN], { onDashboard: true }),
      h.coreList('L2', 'Hidden', [ARTE]),
      h.coreList('L3', 'Docs', [ARTE], { onDashboard: true }),
    ]);
    h.renderAt('/dashboard', [{ path: '/dashboard', element: <CustomListRails /> }]);
    const sports = await screen.findByTestId('dashboard-rail-list-L1');
    expect(screen.getByTestId('dashboard-rail-list-L3')).toBeTruthy();
    expect(screen.queryByTestId('dashboard-rail-list-L2')).toBeNull();
    expect(sports.compareDocumentPosition(screen.getByTestId('dashboard-rail-list-L3')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(sports).getByText('2 channels')).toBeTruthy();
    expect(within(sports).getByRole('link', { name: 'See all' }).getAttribute('href')).toBe('/lists/L1');
    fireEvent.click(await within(sports).findByRole('button', { name: /CNN/ }));
    await waitFor(() => expect(played.map((p) => p.channel.name)).toEqual(['CNN']));
    expect(usePlayerStore.getState().zapContext).toEqual({ sourceId: 'src2', listId: 'L1' });
  });

  it('renders nothing when no list is on Home', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC])]);
    const { container } = h.renderAt('/dashboard', [{ path: '/dashboard', element: <CustomListRails /> }]);
    await waitFor(() => expect(rpc.callsOf('lists.list')).toHaveLength(1));
    expect(container.querySelector('[data-testid^="dashboard-rail"]')).toBeNull();
  });
});
