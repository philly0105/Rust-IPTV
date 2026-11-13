/**
 * NAV-3: a reader of `useTransitionQuery` (or `useRpcQuery` with `transition`) re-renders for its
 * query's answers inside `startTransition`, not through TanStack's `useSyncExternalStore`, whose
 * updates React renders synchronously in the notify timer.
 */
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TransitionReads, useRpcQuery, useTransitionQuery } from './query';
import { rpcRaw } from './transport';

const transitions = vi.hoisted(() => ({ count: 0 }));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    startTransition: (fn: () => void) => {
      transitions.count++;
      react.startTransition(fn);
    },
  };
});

vi.mock('./transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transport')>()),
  rpcRaw: vi.fn(async () => ({})),
}));

const raw = vi.mocked(rpcRaw);

afterEach(() => {
  cleanup();
  transitions.count = 0;
  raw.mockReset();
});

function withClient(client: QueryClient, children: ReactNode) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** A query whose answer the test hands over. */
function deferredAnswer() {
  let answer!: (value: string) => void;
  const promise = new Promise<string>((resolve) => (answer = resolve));
  return { queryFn: () => promise, answer };
}

describe('useTransitionQuery', () => {
  it('renders the answer from a transition, and plain readers of the same key still hear it', async () => {
    const client = newClient();
    const { queryFn, answer } = deferredAnswer();
    let renders = 0;
    function Reader() {
      renders++;
      const q = useTransitionQuery({ queryKey: ['k'], queryFn });
      return <p data-testid="t">{q.isPending ? 'loading' : q.data}</p>;
    }
    function Plain() {
      const q = useQuery({ queryKey: ['k'], queryFn });
      return <p data-testid="p">{q.data ?? 'none'}</p>;
    }
    render(withClient(client, <><Reader /><Plain /></>));
    expect(screen.getByTestId('t').textContent).toBe('loading');
    const before = transitions.count;
    await act(async () => answer('hello'));
    await waitFor(() => expect(screen.getByTestId('t').textContent).toBe('hello'));
    expect(screen.getByTestId('p').textContent).toBe('hello');
    expect(transitions.count).toBeGreaterThan(before);
    // One render per change the cache reported, not one per observer property.
    expect(renders).toBeLessThan(6);
  });

  it('shows an error as the plain hook does', async () => {
    const client = newClient();
    function Reader() {
      const q = useTransitionQuery<string, Error>({ queryKey: ['bad'], queryFn: async () => Promise.reject(new Error('nope')) });
      return <p data-testid="t">{q.isError ? q.error.message : 'waiting'}</p>;
    }
    render(withClient(client, <Reader />));
    await waitFor(() => expect(screen.getByTestId('t').textContent).toBe('nope'));
  });

  it('catches a change between its render and its subscription', async () => {
    const client = newClient();
    client.setQueryData(['k2'], 'first');
    function Writer() {
      // Child layout effects run before the reader's passive effect subscribes.
      useLayoutEffect(() => {
        client.setQueryData(['k2'], 'second');
      }, []);
      return null;
    }
    function Reader() {
      const q = useTransitionQuery({ queryKey: ['k2'], queryFn: async () => 'fetched', staleTime: Infinity });
      return (
        <>
          <p data-testid="t">{q.data}</p>
          <Writer />
        </>
      );
    }
    render(withClient(client, <Reader />));
    await waitFor(() => expect(screen.getByTestId('t').textContent).toBe('second'));
  });

  it('follows a key change at once, from the render that asks for it', async () => {
    const client = newClient();
    client.setQueryData(['a'], 'A');
    client.setQueryData(['b'], 'B');
    function Reader({ k }: { k: string }) {
      const q = useTransitionQuery({ queryKey: [k], queryFn: async () => k, staleTime: Infinity });
      return <p data-testid="t">{q.data}</p>;
    }
    const { rerender } = render(withClient(client, <Reader k="a" />));
    expect(screen.getByTestId('t').textContent).toBe('A');
    rerender(withClient(client, <Reader k="b" />));
    expect(screen.getByTestId('t').textContent).toBe('B');
  });
});

describe('useTransitionQuery renders', () => {
  it('re-renders for the result properties it reads, as useQuery does', async () => {
    const client = newClient();
    client.setQueryData(['t'], 'same');
    let calls = 0;
    const queryFn = async () => {
      calls++;
      return 'same';
    };
    let dataRenders = 0;
    let fetchingRenders = 0;
    function DataReader() {
      dataRenders++;
      const q = useTransitionQuery({ queryKey: ['t'], queryFn, staleTime: Infinity });
      return <p data-testid="d">{q.data}</p>;
    }
    function FetchingReader() {
      fetchingRenders++;
      const q = useTransitionQuery({ queryKey: ['t'], queryFn, staleTime: Infinity });
      return <p data-testid="f">{q.isFetching ? 'fetching' : 'idle'}</p>;
    }
    render(withClient(client, <><DataReader /><FetchingReader /></>));
    await waitFor(() => expect(screen.getByTestId('f').textContent).toBe('idle'));
    const data0 = dataRenders;
    const fetching0 = fetchingRenders;
    // A refetch whose answer is the same data: only the fetch state moves.
    await act(async () => client.invalidateQueries({ queryKey: ['t'] }));
    await waitFor(() => expect(calls).toBe(1));
    await waitFor(() => expect(screen.getByTestId('f').textContent).toBe('idle'));
    expect(fetchingRenders).toBeGreaterThan(fetching0);
    expect(dataRenders).toBe(data0);
  });
});

describe('TransitionReads', () => {
  it('turns useRpcQuery readers below it into transition readers, except those that opt out', async () => {
    raw.mockImplementation(async (cmd: string) => (cmd === 'sources.list' ? [{ id: 's1' }] : [{ id: 'l1' }]) as never);
    const client = newClient();
    function Scoped() {
      const q = useRpcQuery('sources.list', undefined);
      return <p data-testid="s">{q.data ? q.data.map((x) => x.id).join() : 'loading'}</p>;
    }
    function OptedOut() {
      const q = useRpcQuery('lists.list', undefined, { transition: false });
      return <p data-testid="o">{q.data ? q.data.map((x) => x.id).join() : 'loading'}</p>;
    }
    render(withClient(client, <TransitionReads><OptedOut /></TransitionReads>));
    await waitFor(() => expect(screen.getByTestId('o').textContent).toBe('l1'));
    expect(transitions.count).toBe(0);
    cleanup();
    render(withClient(client, <TransitionReads><Scoped /></TransitionReads>));
    await waitFor(() => expect(screen.getByTestId('s').textContent).toBe('s1'));
    expect(transitions.count).toBeGreaterThan(0);
  });
});

describe('useRpcQuery with transition', () => {
  it('fetches through the transport and renders the answer', async () => {
    raw.mockResolvedValue([{ id: 's1' }] as never);
    const client = newClient();
    function Reader() {
      const q = useRpcQuery('sources.list', undefined, { transition: true });
      return <p data-testid="t">{q.data ? q.data.map((s) => s.id).join() : 'loading'}</p>;
    }
    render(withClient(client, <Reader />));
    await waitFor(() => expect(screen.getByTestId('t').textContent).toBe('s1'));
    expect(raw).toHaveBeenCalledWith('sources.list', undefined, expect.objectContaining({ signal: expect.anything() }));
    expect(transitions.count).toBeGreaterThan(0);
  });
});
