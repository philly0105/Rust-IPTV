/**
 * Desktop mode: every RPC is IPC to the local core, which needs no network, so the app's query
 * client runs queries and mutations whatever the OS reports about connectivity. TanStack's default
 * paused them all while the webview was offline (My videos showed an empty library until the
 * network came back).
 */
import { QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./events', () => ({ onAnyAppEvent: () => () => undefined }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (p: string) => p }));
vi.mock('./transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transport')>()),
  rpcRaw: vi.fn(async () => ({})),
}));

// Desktop mode is read from the Tauri global when the modules load; the query client is built then.
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

const { queryClient, useRpcMutation, useRpcQuery } = await import('./query');
const { RpcError, isDesktop, rpcRaw } = await import('./transport');

const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);

afterEach(() => {
  onlineManager.setOnline(true);
  queryClient.clear();
  vi.mocked(rpcRaw).mockReset();
  vi.mocked(rpcRaw).mockImplementation(async () => ({}));
});

describe('desktop query client offline', () => {
  it('loads local data while the OS reports offline', async () => {
    onlineManager.setOnline(false);
    vi.mocked(rpcRaw).mockResolvedValue([{ id: 1 }]);
    const { result } = renderHook(() => useRpcQuery('myvideos.list', null as never), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: 1 }]);
    expect(rpcRaw).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryCache().findAll({ fetchStatus: 'paused' })).toHaveLength(0);
  });

  it('sends a mutation at once instead of queueing it until the network returns', async () => {
    onlineManager.setOnline(false);
    const { result } = renderHook(() => useRpcMutation('favorites.toggle'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ ref: { sourceId: 's1', contentType: 'live', itemId: '1' } } as never);
    });
    expect(rpcRaw).toHaveBeenCalledWith('favorites.toggle', expect.anything());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('refetches a provider query that failed offline once the network returns', async () => {
    onlineManager.setOnline(false);
    vi.mocked(rpcRaw).mockRejectedValueOnce(new RpcError('network', 'portal unreachable', true));
    const { result } = renderHook(() => useRpcQuery('stalker.movies', { sourceId: 's1', page: 1 } as never), { wrapper });
    // The core already retried the portal: the error shows without further rounds here.
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(rpcRaw).toHaveBeenCalledTimes(1);
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rpcRaw).toHaveBeenCalledTimes(2);
  });

  it('keeps the reconnect refetch that networkMode always would turn off', () => {
    expect(isDesktop).toBe(true);
    const o = queryClient.defaultQueryOptions({ queryKey: ['catalog.channels', null] });
    expect(o.networkMode).toBe('always');
    expect(o.refetchOnReconnect).toBe(true);
  });
});
