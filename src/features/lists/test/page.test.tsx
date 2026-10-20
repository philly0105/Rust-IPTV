// The list page (/lists/:listId) and /lists: channels from several sources in
// the Live ChannelList, play through Live's playChannel with zapping kept in
// the list, the dropped-channels tray, and the designed empty states.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { itemKey, type Channel, type ParentalLock, type SourceKind } from '@/api/types';

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
const { ChannelMenuHost } = await import('@/shell/dashboard/ChannelCardMenu');
const { usePlayerStore } = await import('../deps');
const { useShellStore } = await import('@/shell/store');
const { resetPendingRemovalsForTests, usePendingRemovals } = await import('@/features/sources/lib/pendingRemoval');

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
  usePlayerStore.setState({ zapContext: undefined, source: undefined });
  resetPendingRemovalsForTests();
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

  describe('switching lists while a channel plays', () => {
    /** Holds `lists.items` of `id` until `release()`, so the page sits on the previous list's rows. */
    function holdItems(id: string) {
      const real = rpc.handlers['lists.items']!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      rpc.handlers['lists.items'] = async (args) => {
        if ((args as { id: string }).id === id) await gate;
        return real(args);
      };
      return () => act(() => release());
    }
    const playing = (ref: Channel['ref']) =>
      usePlayerStore.setState({
        source: { url: 'http://x/1.ts', kind: 'direct', title: 'BBC One', ref, isLive: true, isRadio: false },
        zapContext: { sourceId: ref.sourceId, listId: 'L2' },
      });

    it('keeps zapping in the old list when the new one does not hold the channel', async () => {
      h.installCore(rpc, [h.coreList('L1', 'Zap one', [CNN]), h.coreList('L2', 'Zap two', [BBC, ARTE])]);
      stubLiveExtras();
      h.renderAt('/lists/L2', routes);
      await waitFor(() => expect(rows()).toHaveLength(2));
      playing(BBC.ref);
      const release = holdItems('L1');
      const sidebar = await screen.findByTestId('lists-sidebar');
      fireEvent.click(within(sidebar).getByRole('link', { name: /Zap one/ }));
      await waitFor(() => expect(h.location.current).toBe('/lists/L1'));
      // The previous list's rows are still up (they hold BBC One): no switch.
      await waitFor(() => expect(rpc.callsOf('lists.items')).toContainEqual({ id: 'L1' }));
      expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('BBC One'), expect.stringContaining('Arte')]);
      expect(usePlayerStore.getState().zapContext).toEqual({ sourceId: 'src1', listId: 'L2' });
      release();
      await waitFor(() => expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('CNN')]));
      expect(usePlayerStore.getState().zapContext).toEqual({ sourceId: 'src1', listId: 'L2' });
    });

    it('moves zapping to the new list once its own rows show the channel', async () => {
      h.installCore(rpc, [h.coreList('L1', 'Zap one', [CNN, BBC]), h.coreList('L2', 'Zap two', [BBC, ARTE])]);
      stubLiveExtras();
      h.renderAt('/lists/L2', routes);
      await waitFor(() => expect(rows()).toHaveLength(2));
      playing(BBC.ref);
      const release = holdItems('L1');
      fireEvent.click(within(await screen.findByTestId('lists-sidebar')).getByRole('link', { name: /Zap one/ }));
      await waitFor(() => expect(rpc.callsOf('lists.items')).toContainEqual({ id: 'L1' }));
      expect(usePlayerStore.getState().zapContext?.listId).toBe('L2');
      release();
      await waitFor(() => expect(usePlayerStore.getState().zapContext).toEqual({ sourceId: 'src1', listId: 'L1' }));
    });
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
    expect(screen.getByText(/choose Add to list\. With a keyboard, press L/)).toBeTruthy();
    // Browse channels opens Live TV, not `/` (which restores the saved screen: this one).
    await waitFor(() => expect(screen.getByTestId('list-browse-channels').getAttribute('href')).toBe('/s/src1/live'));
  });

  it('a list whose channels were all dropped says so', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [], { dropped: [GONE] })]);
    stubLiveExtras();
    h.renderAt('/lists/L1', routes);
    expect(await screen.findByText('None of these channels are offered now')).toBeTruthy();
    // No channel for the guide ribbon: below md its empty state gives the room to the list.
    expect(screen.getByTestId('list-ribbon').className).toContain('max-md:hidden');
  });

  // L3-visual-4 changed this test: it pinned a ribbon held in place on a phone while the channels
  // load with nothing playing, which then hid itself on an empty list (CLS 0.15). The phone ribbon
  // now comes with playback only, as on Live; the hold stays for a channel playing.
  it('keeps the ribbon in place while the channels load and something plays (L2-vod-5: no shift when they arrive)', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC])]);
    stubLiveExtras();
    rpc.handlers['lists.items'] = () => new Promise(() => undefined);
    usePlayerStore.setState({ source: { url: 'http://x/1.ts', kind: 'direct', title: 'BBC One', ref: BBC.ref, isLive: true, isRadio: false } });
    h.renderAt('/lists/L1', routes);
    const ribbon = await screen.findByTestId('list-ribbon');
    expect(ribbon.className).not.toContain('max-md:hidden');
    expect(screen.getByTestId('list-stage').hasAttribute('data-idle')).toBe(false);
  });

  describe('on a phone with nothing playing (L3-visual-4, L3-visual-5)', () => {
    const phoneHidden = (id: string) => screen.getByTestId(id).className.split(' ').includes('max-md:hidden');

    it('a list with channels opens with a slim idle prompt and no ribbon, from the first frame', async () => {
      h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN])]);
      stubLiveExtras();
      rpc.handlers['lists.items'] = () => new Promise(() => undefined);
      h.renderAt('/lists/L1', routes);
      const stage = await screen.findByTestId('list-stage');
      // The phone prompt is a 56 px bar, not a black 16:9 box; md and up keep the stage, a 16:9
      // screen as on Live, not the tall black box around a letterboxed picture (LG-07).
      expect(stage.hasAttribute('data-idle')).toBe(true);
      expect(stage.className.split(' ')).toEqual(expect.arrayContaining(['max-md:h-14', 'md:aspect-video']));
      expect(stage.className.split(' ')).not.toContain('md:flex-1');
      expect(stage.className.split(' ')).not.toContain('aspect-video');
      expect(within(stage).getByText('Pick a channel from the list.')).toBeTruthy();
      expect(phoneHidden('list-ribbon')).toBe(true);
      expect(phoneHidden('list-stage-section')).toBe(false);
      await waitFor(() => expect(screen.getByTestId('channel-list-loading')).toBeTruthy());
    });

    it('an empty list drops the stage and the ribbon as soon as the lists say it is empty, before its rows load', async () => {
      h.installCore(rpc, [h.coreList('L1', 'Sports', [])]);
      stubLiveExtras();
      rpc.handlers['lists.items'] = () => new Promise(() => undefined);
      h.renderAt('/lists/L1', routes);
      await waitFor(() => expect(phoneHidden('list-stage-section')).toBe(true));
      expect(phoneHidden('list-ribbon')).toBe(true);
      expect(screen.getByTestId('channel-list-loading')).toBeTruthy();
    });

    it('an empty list shows its empty state without a stage above it; playback brings the 16:9 stage back', async () => {
      h.installCore(rpc, [h.coreList('L1', 'Sports', [])]);
      stubLiveExtras();
      h.renderAt('/lists/L1', routes);
      expect(await screen.findByText('This list is empty')).toBeTruthy();
      expect(phoneHidden('list-stage-section')).toBe(true);
      act(() =>
        usePlayerStore.setState({ source: { url: 'http://x/1.ts', kind: 'direct', title: 'BBC One', ref: BBC.ref, isLive: true, isRadio: false } }),
      );
      await waitFor(() => expect(phoneHidden('list-stage-section')).toBe(false));
      expect(screen.getByTestId('list-stage').className.split(' ')).toContain('aspect-video');
      // No channel of this list to show: the ribbon's empty state stays off the phone.
      expect(phoneHidden('list-ribbon')).toBe(true);
    });
  });

  it('the header count adds up to the sidebar one, naming the dropped channels', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC], { dropped: [GONE, GONE2] }), h.coreList('L2', 'Kids', [], { dropped: [GONE] })]);
    stubLiveExtras();
    h.renderAt('/lists/L1', routes);
    const sidebar = await screen.findByTestId('lists-sidebar');
    await waitFor(() => expect(within(sidebar).getByRole('link', { name: /Sports/ }).textContent).toContain('3'));
    await waitFor(() => expect(useShellStore.getState().header?.subtitle).toBe('1 channel, 2 unavailable channels'));
    fireEvent.click(within(sidebar).getByRole('link', { name: /Kids/ }));
    await waitFor(() => expect(useShellStore.getState().header?.subtitle).toBe('0 channels, 1 unavailable channel'));
  });

  it('a list without dropped channels counts them plainly; a channel to show brings the ribbon back on a phone', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN])]);
    stubLiveExtras();
    h.renderAt('/lists/L1', routes);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(useShellStore.getState().header?.subtitle).toBe('2 channels'));
    act(() =>
      usePlayerStore.setState({ source: { url: 'http://x/1.ts', kind: 'direct', title: 'BBC One', ref: BBC.ref, isLive: true, isRadio: false } }),
    );
    await waitFor(() => expect(screen.getByTestId('list-ribbon').className).not.toContain('max-md:hidden'));
  });

  describe('parental controls', () => {
    const status = (mode: 'ask' | 'hide', autoAdult = false) => {
      rpc.handlers['parental.status'] = () => ({ enabled: true, mode, autoAdult, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
    };
    const lock = (sourceId: string, targetId: string): ParentalLock => ({
      sourceId,
      contentType: 'live',
      kind: 'item',
      targetId,
      name: targetId,
      createdAt: '2026-10-15T00:00:00Z',
    });
    const onAir = (...channels: Channel[]) => {
      const start = new Date(Date.now() - 10 * 60_000).toISOString();
      const end = new Date(Date.now() + 20 * 60_000).toISOString();
      rpc.handlers['epg.nowNext'] = () =>
        Object.fromEntries(channels.map((c) => [itemKey(c.ref), { now: { channelId: c.ref.itemId, start, end, title: `${c.name} Tonight` } }]));
    };
    const locked = (row: HTMLElement) => within(row).queryByTestId('row-locked') !== null;

    it('Ask mode marks locked channels by their own source and keeps their programme titles back', async () => {
      h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN, ARTE])]);
      stubLiveExtras();
      onAir(BBC, CNN, ARTE);
      status('ask');
      // CNN is item 2 of src2. The src2 lock on item 1 must not catch src1's BBC One (also item 1).
      rpc.handlers['parental.locks'] = () => [lock('src2', '2'), lock('src2', '1')];
      h.renderAt('/lists/L1', routes);
      await waitFor(() => expect(rows()).toHaveLength(3));
      await waitFor(() => expect(locked(rows()[1]!)).toBe(true));
      expect(rows()[1]!.getAttribute('aria-label')).toContain('Locked');
      expect(rows()[1]!.textContent).not.toContain('CNN Tonight');
      expect(rows().map(locked)).toEqual([false, true, false]);
      expect(rows()[0]!.textContent).toContain('BBC One Tonight');
      // One lock list covers every source in the list.
      expect(rpc.callsOf('parental.locks')).toContainEqual({});
    });

    it("Ask mode keeps a locked channel's programme off the idle card, as off its row (review round 3)", async () => {
      h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN, ARTE])]);
      stubLiveExtras();
      onAir(BBC, CNN, ARTE);
      status('ask');
      rpc.handlers['parental.locks'] = () => [lock('src2', '2')];
      // CNN was watched last: the idle card offers it.
      rpc.handlers['recent.list'] = () => [{ ref: CNN.ref, snapshot: { title: 'CNN', contentType: 'live' }, viewedAt: new Date().toISOString() }];
      rpc.handlers['catalog.item'] = () => CNN;
      h.renderAt('/lists/L1', routes);
      const card = await screen.findByTestId('stage-idle');
      await waitFor(() => expect(within(card).getByTestId('stage-resume').textContent).toContain('CNN'));
      await waitFor(() => expect(within(card).queryByTestId('stage-idle-locked')).toBeTruthy());
      expect(card.textContent).not.toContain('CNN Tonight');
    });

    it('Ask mode reads the adult groups of each source in the list', async () => {
      h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN])]);
      stubLiveExtras();
      status('ask', true);
      rpc.handlers['parental.locks'] = () => [];
      rpc.handlers['parental.adultCategories'] = (a) => ((a as { sourceId: string }).sourceId === 'src2' ? ['cat1'] : []);
      h.renderAt('/lists/L1', routes);
      await waitFor(() => expect(rows()).toHaveLength(2));
      await waitFor(() => expect(rows().map(locked)).toEqual([false, true]));
      expect(rpc.callsOf('parental.adultCategories')).toEqual(
        expect.arrayContaining([
          { sourceId: 'src1', contentType: 'live' },
          { sourceId: 'src2', contentType: 'live' },
        ]),
      );
    });

    it('Hide mode marks nothing (the core leaves locked channels out)', async () => {
      h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN])]);
      stubLiveExtras();
      onAir(BBC, CNN);
      status('hide');
      rpc.handlers['parental.locks'] = () => [lock('src2', '2')];
      h.renderAt('/lists/L1', routes);
      await waitFor(() => expect(rows()).toHaveLength(2));
      await waitFor(() => expect(rpc.callsOf('parental.status').length).toBeGreaterThan(0));
      await waitFor(() => expect(rows()[1]!.textContent).toContain('CNN Tonight'));
      expect(rows().map(locked)).toEqual([false, false]);
      expect(rpc.callsOf('parental.locks')).toEqual([]);
    });
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

  it('L3-app-pages-x1: on a phone the header leaves the room to the list name', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Weekend picks', [BBC])]);
    stubLiveExtras();
    h.renderAt('/lists/L1', routes);
    await waitFor(() => expect(rows()).toHaveLength(1));
    const bar = screen.getByRole('button', { name: 'Edit channels' });
    await waitFor(() => expect(useShellStore.getState().header?.actions).toBeTruthy());
    const header = render(<>{useShellStore.getState().header!.actions}</>).container;
    // Edit channels stays in the channels bar right under the header; the header's copy is wide-only.
    const edit = within(header).getByRole('button', { name: 'Edit channels' });
    expect(edit.className).toContain('max-sm:hidden');
    expect(bar.className).not.toContain('max-sm:hidden');
    // Manage lists shrinks to its icon there, keeping its name for screen readers and the tooltip.
    const manage = within(header).getByRole('button', { name: 'Manage lists' });
    expect(manage.getAttribute('title')).toBe('Manage lists');
    expect(manage.className).toContain('max-sm:w-8');
    expect(within(manage).getByText('Manage lists').className).toContain('max-sm:sr-only');
  });

  it('L3-live-ch-x2: PageUp/PageDown on a list row are left to channel up/down while a live channel plays', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN])]);
    stubLiveExtras();
    h.renderAt('/lists/L1', routes);
    await waitFor(() => expect(rows()).toHaveLength(2));
    // Nothing plays: the list pages.
    expect(fireEvent.keyDown(rows()[0]!, { key: 'PageDown' })).toBe(false);
    act(() => usePlayerStore.setState({ source: { url: 'http://x/1.ts', kind: 'direct', title: 'BBC One', ref: BBC.ref, isLive: true, isRadio: false } }));
    // A live channel plays: the key goes through to the playback shortcuts; Shift still pages.
    expect(fireEvent.keyDown(rows()[0]!, { key: 'PageDown' })).toBe(true);
    expect(fireEvent.keyDown(rows()[0]!, { key: 'PageUp' })).toBe(true);
    expect(fireEvent.keyDown(rows()[0]!, { key: 'PageDown', shiftKey: true })).toBe(false);
    // Played outside the app (MPV, VLC), there is nothing to zap here.
    act(() => usePlayerStore.setState({ mode: 'external' }));
    expect(fireEvent.keyDown(rows()[0]!, { key: 'PageDown' })).toBe(false);
    usePlayerStore.setState({ mode: 'inline' });
  });

  it('F2 renames the row that has focus, read when the key is pressed, not tracked per focus move (LV-5)', async () => {
    const { registerRenameHost, useRenameStore } = await import('@/features/channeledit/store');
    const unregister = registerRenameHost();
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN])]);
    stubLiveExtras();
    h.renderAt('/lists/L1', routes);
    await waitFor(() => expect(rows()).toHaveLength(2));
    act(() => rows()[1]!.focus());
    fireEvent.keyDown(rows()[1]!, { key: 'F2', code: 'F2' });
    expect(useRenameStore.getState().request?.channel.ref).toEqual(CNN.ref);
    unregister();
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

  it("a card's right click opens Home's channel menu, whose Play still zaps within the list", async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN], { onDashboard: true })]);
    rpc.handlers['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
    rpc.handlers['channels.edits'] = () => [];
    h.renderAt('/dashboard', [
      {
        path: '/dashboard',
        element: (
          <ChannelMenuHost>
            <CustomListRails />
          </ChannelMenuHost>
        ),
      },
    ]);
    const sports = await screen.findByTestId('dashboard-rail-list-L1');
    fireEvent.contextMenu(await within(sports).findByRole('button', { name: /CNN/ }), { clientX: 40, clientY: 40 });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Add to list/ })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Play/ }));
    await waitFor(() => expect(played.map((p) => p.channel.name)).toEqual(['CNN']));
    expect(usePlayerStore.getState().zapContext).toEqual({ sourceId: 'src2', listId: 'L1' });
  });

  it('leaves out the channels of a source in its delete-undo window, and brings them back on Undo', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN, ARTE], { onDashboard: true })]);
    usePendingRemovals.setState({ ids: new Set(['src2']) });
    h.renderAt('/dashboard', [{ path: '/dashboard', element: <CustomListRails /> }]);
    const sports = await screen.findByTestId('dashboard-rail-list-L1');
    expect(await within(sports).findByRole('button', { name: /BBC One/ })).toBeTruthy();
    expect(within(sports).getByRole('button', { name: /Arte/ })).toBeTruthy();
    expect(within(sports).queryByRole('button', { name: /CNN/ })).toBeNull();
    expect(within(sports).getByText('2 channels')).toBeTruthy();
    // The rail asks the guide only for the channels it shows, without descriptions (L3-serve-ui-7).
    await waitFor(() => expect(rpc.callsOf('epg.nowNext').at(-1)).toEqual({ refs: [BBC.ref, ARTE.ref], withDescription: false }));
    act(() => usePendingRemovals.setState({ ids: new Set() }));
    expect(await within(sports).findByRole('button', { name: /CNN/ })).toBeTruthy();
    expect(within(sports).getByText('3 channels')).toBeTruthy();
  });

  // L3-vod-x4: an empty list's rail showed a skeleton row while its channels loaded, then
  // collapsed, shifting the rest of Home.
  it('while channels load, a list with channels shows its skeleton and an empty list shows nothing', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC], { onDashboard: true }), h.coreList('L2', 'Empty', [], { onDashboard: true })]);
    // The channels never arrive, so both rails stay loading.
    rpc.handlers['lists.items'] = () => new Promise(() => {});
    h.renderAt('/dashboard', [{ path: '/dashboard', element: <CustomListRails /> }]);
    const sports = await screen.findByTestId('dashboard-rail-list-L1');
    expect(within(sports).getByLabelText('Loading Sports').getAttribute('aria-busy')).toBe('true');
    await waitFor(() => expect(rpc.callsOf('lists.items')).toHaveLength(2));
    expect(screen.queryByTestId('dashboard-rail-list-L2')).toBeNull();
    expect(screen.queryByLabelText('Loading Empty')).toBeNull();
  });

  it('renders nothing when no list is on Home', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC])]);
    const { container } = h.renderAt('/dashboard', [{ path: '/dashboard', element: <CustomListRails /> }]);
    await waitFor(() => expect(rpc.callsOf('lists.list')).toHaveLength(1));
    expect(container.querySelector('[data-testid^="dashboard-rail"]')).toBeNull();
  });
});
