// useListChannels (contract C3): a custom list as PagedChannels for the Live
// ChannelList. The whole list loads at once; now/next and favorite flags are
// asked only for the chunks on screen; dropped channels come back apart.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EpgNowNext, ItemRef } from '@/api/types';

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
const { useListChannels } = await import('../hooks/useListChannels');

const BBC = h.channel('1', 'BBC One');
const CNN = h.channel('2', 'CNN', { sourceId: 'src2' });
const ARTE = h.channel('3', 'Arte');
const JAZZ = h.channel('4', 'Jazz FM', { radio: true });
const GONE = h.channel('9', 'Old Sports');

const wrapper = ({ children }: { children: ReactNode }) => <h.Providers>{children}</h.Providers>;
const refsOf = (args: unknown) => ((args as { refs: ItemRef[] }).refs ?? []).map((r) => r.itemId);

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
});
afterEach(cleanup);

describe('useListChannels', () => {
  it('loads the whole list: available channels are the rows, dropped ones come back apart', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN, ARTE, JAZZ], { dropped: [GONE] })]);
    const { result } = renderHook(() => useListChannels('L1'), { wrapper });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.total).toBeUndefined();
    await waitFor(() => expect(result.current.total).toBe(4));
    expect(result.current.isLoading).toBe(false);
    expect([0, 1, 2, 3].map((i) => result.current.getChannel(i)?.name)).toEqual(['BBC One', 'CNN', 'Arte', 'Jazz FM']);
    expect(result.current.getChannel(4)).toBeUndefined();
    expect(result.current.unavailable.map((e) => e.snapshot.title)).toEqual(['Old Sports']);
    expect(result.current.loaded.map((l) => l.index)).toEqual([0, 1, 2, 3]);
    expect(rpc.callsOf('lists.items')).toEqual([{ id: 'L1' }]);
    expect(result.current.guideUnavailable).toBe(false);
  });

  it('fetches now/next and favorites for the visible chunk only, and reads them per row', async () => {
    const core = h.installCore(rpc, [h.coreList('L1', 'Mixed', [BBC, CNN, ARTE, JAZZ])]);
    core.favorites = [CNN.ref, JAZZ.ref];
    const now: EpgNowNext = { now: { channelId: 'x', title: 'Late news', start: '2026-10-13T09:00:00Z', end: '2099-01-01T00:00:00Z' } as EpgNowNext['now'] };
    rpc.handlers['epg.nowNext'] = (raw) => Object.fromEntries((raw as { refs: ItemRef[] }).refs.filter((r) => r.itemId === '3').map((r) => [`${r.sourceId}|${r.contentType}|${r.itemId}`, now]));
    const { result } = renderHook(() => useListChannels('L1', { pageSize: 2 }), { wrapper });
    await waitFor(() => expect(result.current.total).toBe(4));
    // First chunk (rows 0-1) only.
    await waitFor(() => expect(result.current.isFavorite(1)).toBe(true));
    expect(rpc.callsOf('epg.nowNext').map(refsOf)).toEqual([['1', '2']]);
    expect(rpc.callsOf('favorites.contains').map(refsOf)).toEqual([['1', '2']]);
    expect(result.current.isFavorite(3)).toBe(false);

    // Scroll to rows 2-3: the second chunk is asked, nothing else.
    act(() => result.current.setVisibleRange(2, 3));
    await waitFor(() => expect(result.current.getNowNext(2)?.now?.title).toBe('Late news'));
    await waitFor(() => expect(result.current.isFavorite(3)).toBe(true));
    expect(rpc.callsOf('epg.nowNext').map(refsOf)).toEqual([['1', '2'], ['3', '4']]);
    expect(result.current.getNowNext(0)).toBeUndefined();
    // The same range again asks nothing new.
    act(() => result.current.setVisibleRange(2, 3));
    expect(rpc.callsOf('epg.nowNext')).toHaveLength(2);
  });

  it('passes the guide offset through to now/next', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC])]);
    const { result } = renderHook(() => useListChannels('L1', { epgOffsetMinutes: 60 }), { wrapper });
    await waitFor(() => expect(result.current.total).toBe(1));
    await waitFor(() => expect(rpc.callsOf('epg.nowNext')).toEqual([{ refs: [BBC.ref], offsetMinutes: 60, withDescription: false }]));
  });

  it('L3-serve-ui-7: asks now/next without descriptions (the rows show titles and times)', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC])]);
    const { result } = renderHook(() => useListChannels('L1'), { wrapper });
    await waitFor(() => expect(result.current.total).toBe(1));
    await waitFor(() => expect(rpc.callsOf('epg.nowNext')).toEqual([{ refs: [BBC.ref], withDescription: false }]));
  });

  it('reports an empty list as total 0, and an error with a working retry', async () => {
    const core = h.installCore(rpc, [h.coreList('L1', 'Empty', [])]);
    const empty = renderHook(() => useListChannels('L1'), { wrapper });
    await waitFor(() => expect(empty.result.current.total).toBe(0));
    expect(rpc.callsOf('epg.nowNext')).toEqual([]);
    empty.unmount();

    h.resetShared();
    core.fail['lists.items'] = 'db';
    const broken = renderHook(() => useListChannels('L1'), { wrapper });
    await waitFor(() => expect(broken.result.current.error).toBeTruthy());
    expect(broken.result.current.isLoading).toBe(false);
    act(() => broken.result.current.retry());
    await waitFor(() => expect(broken.result.current.total).toBe(0));
    expect(broken.result.current.error).toBeNull();
  });

  it('switching lists keeps the old rows up, dimmed, until the new list lands', async () => {
    h.installCore(rpc, [h.coreList('L1', 'One', [BBC]), h.coreList('L2', 'Two', [CNN, ARTE])]);
    let release: () => void = () => undefined;
    const { result, rerender } = renderHook(({ id }: { id: string }) => useListChannels(id), { wrapper, initialProps: { id: 'L1' } });
    await waitFor(() => expect(result.current.total).toBe(1));
    const original = rpc.handlers['lists.items']!;
    rpc.handlers['lists.items'] = (raw) => new Promise((resolve) => (release = () => resolve(original(raw))));
    rerender({ id: 'L2' });
    expect(result.current.refreshing).toBe(true);
    expect(result.current.getChannel(0)?.name).toBe('BBC One');
    await act(async () => release());
    await waitFor(() => expect(result.current.total).toBe(2));
    expect(result.current.refreshing).toBe(false);
  });

  it('refreshes now/next once an airing programme has ended', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC])]);
    const ended: EpgNowNext = { now: { channelId: 'x', title: 'Old', start: '2026-10-13T08:00:00Z', end: '2026-10-13T09:00:00Z' } as EpgNowNext['now'] };
    rpc.handlers['epg.nowNext'] = () => ({ 'src1|live|1': ended });
    const nowMs = Date.parse('2026-10-13T09:30:00Z');
    const { result } = renderHook(() => useListChannels('L1', { now: nowMs }), { wrapper });
    await waitFor(() => expect(result.current.getNowNext(0)?.now?.title).toBe('Old'));
    await waitFor(() => expect(rpc.callsOf('epg.nowNext').length).toBeGreaterThanOrEqual(2));
    // Once per clock tick, not in a loop.
    await new Promise((r) => setTimeout(r, 30));
    expect(rpc.callsOf('epg.nowNext')).toHaveLength(2);
  });
});
