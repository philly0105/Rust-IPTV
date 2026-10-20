// LG-13: lists grow by more than one right click at a time. A group's menu adds the whole group
// to a list (or to a new list named after it), and a list's page has "Add channels", which browses
// a source by group or view and adds or takes out a channel per press.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, PageQuery } from '@/api/types';

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
await Promise.all([import('../dialogs/AddGroupDialog'), import('../dialogs/AddChannelsDialog')]);
// The scope picker's popover list is its own chunk (SH-10): in before the tests open it.
await (await import('@/features/live/components/ScopePicker')).preloadScopePickerList();
const { openAddChannels, openAddGroupToList } = await import('../store');
const { loadGroupChannels } = await import('../dialogs/AddGroupDialog');

const SPORTS = Array.from({ length: 30 }, (_, i) => h.channel(`s${i}`, `Sports ${i}`, { categoryName: 'Sports' }));
const NEWS = [h.channel('n1', 'News One'), h.channel('n2', 'News Two')];

function serveChannels() {
  rpc.handlers['catalog.channels'] = (raw) => {
    const a = raw as { categoryId?: string; query: PageQuery };
    const all = a.categoryId === 'sports' ? SPORTS : [...NEWS, ...SPORTS];
    return { items: all.slice(a.query.offset, a.query.offset + a.query.limit), total: all.length, offset: a.query.offset, limit: a.query.limit };
  };
}

function renderHost() {
  render(
    <h.Providers>
      <ListsDialogHost />
    </h.Providers>,
  );
}

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
  serveChannels();
  rpc.handlers['settings.get'] = () => ({});
  rpc.handlers['sources.list'] = () => h.SOURCES;
  rpc.handlers['epg.nowNext'] = () => ({});
  rpc.handlers['favorites.list'] = () => [];
  rpc.handlers['recent.list'] = () => [];
  rpc.handlers['catalog.categories'] = (): Category[] => [
    { id: 'sports', sourceId: 'src1', contentType: 'live', name: 'Sports', hidden: false, itemCount: SPORTS.length, position: 0 } as Category,
  ];
});
afterEach(cleanup);

describe('a whole group into a list', () => {
  const group = { sourceId: 'src1', contentType: 'live' as const, categoryId: 'sports', name: 'Sports', count: SPORTS.length };

  it('loads the group in pages, up to what a list holds', async () => {
    const pages: PageQuery[] = [];
    rpc.handlers['catalog.channels'] = (raw) => {
      const q = (raw as { query: PageQuery }).query;
      pages.push(q);
      const total = 2600;
      const items = Array.from({ length: Math.max(0, Math.min(q.limit, total - q.offset)) }, (_, i) => h.channel(`x${q.offset + i}`, `X ${q.offset + i}`));
      return { items, total, offset: q.offset, limit: q.limit };
    };
    const all = await loadGroupChannels(group);
    expect(all).toHaveLength(2000);
    expect(pages.map((p) => [p.offset, p.limit])).toEqual([
      [0, 500],
      [500, 500],
      [1000, 500],
      [1500, 500],
    ]);
  });

  it('adds every channel of the group with one write, and says how many were new', async () => {
    const core = h.installCore(rpc, [h.coreList('L1', 'Weekend', [SPORTS[0]!]), h.coreList('L2', 'Kids', [])]);
    renderHost();
    act(() => openAddGroupToList(group));
    const dialog = await screen.findByTestId('group-to-list');
    expect(within(dialog).getByText('Sports')).toBeTruthy();
    const add = await within(dialog).findByRole('button', { name: 'Add the group to Weekend' });
    await waitFor(() => expect(add.hasAttribute('disabled')).toBe(false));
    fireEvent.click(add);
    await waitFor(() => expect(rpc.callsOf('lists.addItems')).toHaveLength(1));
    expect((rpc.callsOf('lists.addItems')[0] as { items: unknown[] }).items).toHaveLength(30);
    // One was there already: the row and the announcement count the new ones.
    expect(await within(dialog).findByText('29 added')).toBeTruthy();
    expect(within(dialog).getByText('Added 29 channels to Weekend')).toBeTruthy();
    expect(core.lists[0]!.items).toHaveLength(30);
  });

  it('starts a new list named after the group, holding the group', async () => {
    const core = h.installCore(rpc, []);
    renderHost();
    act(() => openAddGroupToList(group));
    const dialog = await screen.findByTestId('group-to-list');
    const name = within(dialog).getByRole('textbox', { name: 'New list name' }) as HTMLInputElement;
    expect(name.value).toBe('Sports');
    await waitFor(() => expect(rpc.callsOf('catalog.channels')).not.toHaveLength(0));
    await waitFor(() => expect(within(dialog).queryByRole('status', { busy: true })).toBeNull());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(core.lists).toHaveLength(1));
    expect(core.lists[0]!.name).toBe('Sports');
    expect(core.lists[0]!.items).toHaveLength(30);
  });
});

describe('Add channels on a list', () => {
  it('browses a group and adds or takes out a channel per press', { timeout: 20_000 }, async () => {
    const core = h.installCore(rpc, [h.coreList('L1', 'Weekend', [NEWS[0]!])]);
    renderHost();
    act(() => openAddChannels('L1'));
    const dialog = await screen.findByTestId('add-channels');
    expect(await within(dialog).findByRole('heading', { name: 'Add channels to Weekend' })).toBeTruthy();
    // All channels first: News One is in the list already.
    const one = await within(dialog).findByRole('button', { name: /^News One,/ });
    expect(one.getAttribute('aria-pressed')).toBe('true');
    // Pick the Sports group in the scope picker.
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Show' }));
    fireEvent.click(screen.getByRole('option', { name: /^Sports/ }));
    await waitFor(() => expect(rpc.callsOf('catalog.channels').some((a) => (a as { categoryId?: string }).categoryId === 'sports')).toBe(true));
    const s3 = await within(dialog).findByRole('button', { name: /^Sports 3,/ });
    expect(s3.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(s3);
    await waitFor(() => expect(core.lists[0]!.items.map((i) => i.ref.itemId)).toEqual(['n1', 's3']));
    expect(await within(dialog).findByText('Added Sports 3 to Weekend')).toBeTruthy();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^Sports 3,/ }).getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Sports 3,/ }));
    await waitFor(() => expect(core.lists[0]!.items.map((i) => i.ref.itemId)).toEqual(['n1']));
  });

  it('searches inside the group picked, and "Show more" pages its matches', { timeout: 20_000 }, async () => {
    const many = Array.from({ length: 150 }, (_, i) => h.channel(`m${i}`, `Match ${i}`, { categoryName: 'Sports' }));
    rpc.handlers['catalog.channels'] = (raw) => {
      const a = raw as { categoryId?: string; query: PageQuery };
      const q = a.query.search?.toLowerCase();
      const rows = (a.categoryId === 'sports' ? many : [...NEWS, ...many]).filter((c) => !q || c.name.toLowerCase().includes(q));
      return { items: rows.slice(a.query.offset, a.query.offset + a.query.limit), total: rows.length, offset: a.query.offset, limit: a.query.limit };
    };
    rpc.handlers['catalog.search'] = () => ({ live: [NEWS[0]!], movies: [], series: [] });
    h.installCore(rpc, [h.coreList('L1', 'Weekend', [])]);
    renderHost();
    act(() => openAddChannels('L1'));
    const dialog = await screen.findByTestId('add-channels');
    await within(dialog).findByRole('button', { name: /^News One,/ });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Show' }));
    fireEvent.click(await screen.findByRole('option', { name: /^Sports/ }));
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Search channels' }), { target: { value: 'match' } });
    await waitFor(() =>
      expect(rpc.callsOf('catalog.channels')).toContainEqual({ sourceId: 'src1', categoryId: 'sports', query: { offset: 0, limit: 60, search: 'match' } }),
    );
    // The group's matches, not the catalog search's News One.
    await within(dialog).findByRole('button', { name: /^Match 59,/ });
    expect(within(dialog).queryByRole('button', { name: /^News One,/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show more' }));
    await within(dialog).findByRole('button', { name: /^Match 119,/ });
    expect(rpc.callsOf('catalog.channels')).toContainEqual({ sourceId: 'src1', categoryId: 'sports', query: { offset: 60, limit: 60, search: 'match' } });
    expect(rpc.callsOf('catalog.search')).toHaveLength(0);
  });
});
