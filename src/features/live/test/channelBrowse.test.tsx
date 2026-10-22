/**
 * Review round 3: the channel pickers' browse hook (the multi-view picker and a list's "Add
 * channels"). A query searches inside the scope picked (a group, Favorites, Recent or a list)
 * and loads, fails and retries with that scope; "Show more" reads the next page at its offset,
 * past the core's 1000 rows a read, and asks the guide about the rows it adds only.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, CustomListEntry, FavoriteEntry, ItemRef, Page, PageQuery } from '@/api/types';

import { BROWSE_PAGE, SCOPE_ALL, SCOPE_FAVORITES, SCOPE_RECENT, scopeOfList, useChannelBrowse, type ChannelBrowseArgs } from '../hooks/useChannelBrowse';
import { i18n, makeChannel } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, calls, call };
});

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

/** Channel i: "Sports i" in g-sports for even i, "News i" in g-news for odd i. */
function channel(i: number): Channel {
  const sports = i % 2 === 0;
  return { ...makeChannel(i), name: `${sports ? 'Sports' : 'News'} ${i}`, categoryId: sports ? 'g-sports' : 'g-news', categoryName: sports ? 'Sports' : 'News' };
}
const ALL = Array.from({ length: 2500 }, (_, i) => channel(i));
/** The core's `catalog.channels`: a group, a name search inside it, at most 1000 rows a read. */
function channelsPage(raw: unknown): Page<Channel> {
  const a = raw as { categoryId?: string; query: PageQuery };
  const q = a.query.search?.toLowerCase();
  const rows = ALL.filter((c) => (!a.categoryId || c.categoryId === a.categoryId) && (!q || c.name.toLowerCase().includes(q)));
  const limit = Math.min(a.query.limit, 1000);
  return { items: rows.slice(a.query.offset, a.query.offset + limit), total: rows.length, offset: a.query.offset, limit };
}
const favorite = (c: Channel, i: number): FavoriteEntry => ({ ref: c.ref, position: i, addedAt: '', snapshot: { title: c.name, contentType: 'live' } });

function renderBrowse(initial: ChannelBrowseArgs) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </QueryClientProvider>
  );
  return renderHook((args: ChannelBrowseArgs) => useChannelBrowse(args), { wrapper, initialProps: initial });
}

const base: ChannelBrowseArgs = { enabled: true, sourceId: 'src1', scope: SCOPE_ALL, query: '', limit: BROWSE_PAGE };

beforeEach(() => {
  for (const k of Object.keys(rpcMock.handlers)) delete rpcMock.handlers[k];
  rpcMock.calls.length = 0;
  rpcMock.handlers['catalog.channels'] = channelsPage;
  rpcMock.handlers['catalog.search'] = () => ({ live: ALL.slice(0, 5), movies: [], series: [] });
  rpcMock.handlers['catalog.item'] = (a) => ALL[Number((a as { ref: ItemRef }).ref.itemId.slice(1))];
  rpcMock.handlers['catalog.items'] = (a) => (a as { refs: ItemRef[] }).refs.map((r) => ({ item: ALL[Number(r.itemId.slice(1))] }));
  rpcMock.handlers['epg.nowNext'] = () => ({});
});
afterEach(cleanup);

describe('a query searches the scope picked', () => {
  it('in a group: the core searches the group, with its count, and "Show more" pages the matches', async () => {
    const { result, rerender } = renderBrowse({ ...base, scope: 'g-sports', query: 'sports 1' });
    await waitFor(() => expect(result.current.channels).toHaveLength(BROWSE_PAGE));
    expect(callsOf('catalog.search')).toHaveLength(0);
    expect(callsOf('catalog.channels')).toContainEqual({ sourceId: 'src1', categoryId: 'g-sports', query: { offset: 0, limit: BROWSE_PAGE, search: 'sports 1' } });
    expect(result.current.channels.every((c) => c.categoryId === 'g-sports' && c.name.startsWith('Sports 1'))).toBe(true);
    // Sports 10, 12 … 18, 100 … 198, 1000 … 1998: more than one page.
    const matches = ALL.filter((c) => c.categoryId === 'g-sports' && c.name.toLowerCase().includes('sports 1')).length;
    expect(result.current.total).toBe(matches);
    rerender({ ...base, scope: 'g-sports', query: 'sports 1', limit: 2 * BROWSE_PAGE });
    await waitFor(() => expect(result.current.channels).toHaveLength(2 * BROWSE_PAGE));
    expect(callsOf('catalog.channels')).toContainEqual({ sourceId: 'src1', categoryId: 'g-sports', query: { offset: BROWSE_PAGE, limit: BROWSE_PAGE, search: 'sports 1' } });
  });

  it('in all channels it is the catalog search', async () => {
    const { result } = renderBrowse({ ...base, query: 'news' });
    await waitFor(() => expect(result.current.channels).toHaveLength(5));
    expect(callsOf('catalog.search')).toEqual([{ query: 'news', contentTypes: ['live'], limit: BROWSE_PAGE, sourceId: 'src1' }]);
    expect(callsOf('catalog.channels')).toHaveLength(0);
  });

  it('in Favorites: only the favorites whose name has it, and the guide asked about those', async () => {
    rpcMock.handlers['favorites.list'] = () => [channel(1), channel(2), channel(3), channel(4)].map(favorite);
    const { result } = renderBrowse({ ...base, scope: SCOPE_FAVORITES, query: 'sports' });
    await waitFor(() => expect(result.current.channels.map((c) => c.name)).toEqual(['Sports 2', 'Sports 4']));
    expect(result.current.total).toBe(2);
    expect(callsOf('catalog.search')).toHaveLength(0);
    // The two rows' channels in one call.
    expect(callsOf('catalog.items')).toEqual([{ refs: [channel(2).ref, channel(4).ref] }]);
    expect(callsOf('catalog.item')).toHaveLength(0);
    expect((callsOf('epg.nowNext').at(-1) as { refs: ItemRef[] }).refs).toEqual([channel(2).ref, channel(4).ref]);
  });

  it('in Recent: loads, fails and retries with the history, not with a search', async () => {
    let fail = true;
    rpcMock.handlers['recent.list'] = () => {
      if (fail) throw new Error('history is down');
      return [channel(1), channel(2), channel(3)].map((c) => ({ ref: c.ref, viewedAt: '', snapshot: { title: c.name, contentType: 'live' } }));
    };
    const { result } = renderBrowse({ ...base, scope: SCOPE_RECENT, query: 'news' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isPending).toBe(false);
    fail = false;
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.channels.map((c) => c.name)).toEqual(['News 1', 'News 3']));
    expect(result.current.isError).toBe(false);
    expect(callsOf('catalog.search')).toHaveLength(0);
  });

  it('in a list: only its channels whose name has it', async () => {
    const entry = (c: Channel, i: number): CustomListEntry => ({ ref: c.ref, channel: c, available: true, position: i, addedAt: '', snapshot: { title: c.name, contentType: 'live' } });
    rpcMock.handlers['lists.items'] = () => [channel(5), channel(6), channel(7), channel(8)].map(entry);
    const { result } = renderBrowse({ ...base, scope: scopeOfList('L1'), query: 'NEWS' });
    await waitFor(() => expect(result.current.channels.map((c) => c.name)).toEqual(['News 5', 'News 7']));
    expect(result.current.total).toBe(2);
    expect(callsOf('catalog.search')).toHaveLength(0);
  });
});

describe('"Show more" reads the next page', () => {
  it('goes on past the core’s 1000 rows a read', async () => {
    const { result, rerender } = renderBrowse(base);
    await waitFor(() => expect(result.current.channels).toHaveLength(BROWSE_PAGE));
    expect(result.current.total).toBe(2500);
    for (let limit = 2 * BROWSE_PAGE; limit <= 1080; limit += BROWSE_PAGE) rerender({ ...base, limit });
    await waitFor(() => expect(result.current.channels).toHaveLength(1080));
    expect(result.current.channels.map((c) => c.ref.itemId)).toEqual(ALL.slice(0, 1080).map((c) => c.ref.itemId));
    const reads = callsOf('catalog.channels') as { query: PageQuery }[];
    // One read per page, each at its own offset and within what the core answers.
    expect(reads.every((r) => r.query.limit <= BROWSE_PAGE)).toBe(true);
    expect(new Set(reads.map((r) => r.query.offset)).size).toBe(reads.length);
    expect(reads).toHaveLength(1080 / BROWSE_PAGE);
  });

  it('asks the guide about the rows it adds only', async () => {
    const { result, rerender } = renderBrowse(base);
    await waitFor(() => expect(callsOf('epg.nowNext')).toHaveLength(1));
    rerender({ ...base, limit: 2 * BROWSE_PAGE });
    await waitFor(() => expect(result.current.channels).toHaveLength(2 * BROWSE_PAGE));
    await waitFor(() => expect(callsOf('epg.nowNext')).toHaveLength(2));
    const asked = callsOf('epg.nowNext') as { refs: ItemRef[] }[];
    expect(asked[1]!.refs).toEqual(ALL.slice(BROWSE_PAGE, 2 * BROWSE_PAGE).map((c) => c.ref));
  });

  it('a page that fails stops the rows there, and a retry asks for it again', async () => {
    let fail = true;
    rpcMock.handlers['catalog.channels'] = (raw) => {
      if (fail && (raw as { query: PageQuery }).query.offset === BROWSE_PAGE) throw new Error('timed out');
      return channelsPage(raw);
    };
    const { result, rerender } = renderBrowse(base);
    await waitFor(() => expect(result.current.channels).toHaveLength(BROWSE_PAGE));
    rerender({ ...base, limit: 3 * BROWSE_PAGE });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.channels).toHaveLength(BROWSE_PAGE);
    fail = false;
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.channels).toHaveLength(3 * BROWSE_PAGE));
    expect(result.current.isError).toBe(false);
  });
});
