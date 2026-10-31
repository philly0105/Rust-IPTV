// F1-6: useVisibleSources hands back TanStack's tracked result instead of a spread copy, so a
// reader re-renders only for the fields it reads. A `sources.list` refetch that returns the same
// list (every sources.changed, import outcome and reconnect sends one) re-rendered every reader
// twice, at the fetch's start and end; a reader of `data` alone now does not re-render at all.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSource, rpcMock } from './harness';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));

const { useVisibleSources } = await import('../useVisibleSources');
const { usePendingRemovals } = await import('@/features/sources/lib/pendingRemoval');

let renders = 0;
function DataReader() {
  renders += 1;
  const sources = useVisibleSources().data;
  return <div data-testid="names">{sources ? sources.map((s) => s.id).join(',') : 'pending'}</div>;
}

let client: QueryClient;
function mount() {
  return render(
    <QueryClientProvider client={client}>
      <DataReader />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rpcMock.reset();
  renders = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  usePendingRemovals.setState({ ids: new Set() });
  // A real refetch takes a while, so its start and its end reach the readers separately.
  rpcMock.handlers['sources.list'] = async () => {
    await new Promise((r) => setTimeout(r, 15));
    return [makeSource('a'), makeSource('b')];
  };
});

/** Invalidates `sources.list` and waits out the refetch and TanStack's batched notifications. */
async function refetchSources() {
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['sources.list'] });
    await new Promise((r) => setTimeout(r, 20));
  });
}
afterEach(() => {
  cleanup();
  client.clear();
  usePendingRemovals.setState({ ids: new Set() });
});

describe('useVisibleSources', () => {
  it('does not re-render a data reader when a refetch returns the same list', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('names').textContent).toBe('a,b'));
    const settled = renders;

    await refetchSources();
    expect(rpcMock.calls.filter((c) => c.cmd === 'sources.list')).toHaveLength(2);
    // The spread copy re-rendered at the refetch's start (isFetching) and end (dataUpdatedAt).
    expect(renders - settled).toBe(0);
  });

  it('leaves out sources waiting out their undo window and puts them back on Undo', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('names').textContent).toBe('a,b'));

    act(() => usePendingRemovals.setState({ ids: new Set(['a']) }));
    expect(screen.getByTestId('names').textContent).toBe('b');
    // A refetch while one is hidden keeps it hidden, and the reader still skips the fetch states.
    const settled = renders;
    await refetchSources();
    expect(screen.getByTestId('names').textContent).toBe('b');
    expect(renders - settled).toBe(0);

    act(() => usePendingRemovals.setState({ ids: new Set() }));
    expect(screen.getByTestId('names').textContent).toBe('a,b');
  });
});
