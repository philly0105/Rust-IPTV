/**
 * NAV-2: Back and Forward render outside the `popstate` event. React renders a transition that
 * starts inside `popstate` synchronously, so the router's update for Back rendered the whole page
 * in that one event; the app's own subscriber now gets it in the next task, in order.
 */
import { act, render, screen } from '@testing-library/react';
import { RouterProvider, createBrowserRouter, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deferPopstateUpdates } from './routes';

type Update = Parameters<Parameters<ReturnType<typeof createMemoryRouter>['subscribe']>[0]>;

const update = (n: number) => [{ n }, { deletedFetchers: [], newErrors: null, viewTransitionOpts: undefined, flushSync: false }] as unknown as Update;

/** Runs `fn` inside a dispatched `popstate` event, as the browser does for Back. */
function duringPopstate(fn: () => void): void {
  const listener = () => fn();
  window.addEventListener('popstate', listener);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.removeEventListener('popstate', listener);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('deferPopstateUpdates', () => {
  it('passes updates outside popstate straight through', () => {
    const seen: unknown[] = [];
    const wrapped = deferPopstateUpdates((state) => seen.push(state));
    wrapped(...update(1));
    expect(seen).toEqual([{ n: 1 }]);
  });

  it('hands popstate updates over in the next task, in order, with the updates queued behind them', () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    const wrapped = deferPopstateUpdates((state) => seen.push(state));
    duringPopstate(() => {
      wrapped(...update(1));
      wrapped(...update(2));
    });
    // An update after the event, while those still wait, must not overtake them.
    wrapped(...update(3));
    expect(seen).toEqual([]);
    vi.runAllTimers();
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    // Drained: the next ordinary update is synchronous again.
    wrapped(...update(4));
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  });

  it('passes the options of each update through unchanged', () => {
    const calls: Update[] = [];
    const run: (() => void)[] = [];
    const wrapped = deferPopstateUpdates((...args) => calls.push(args), (fn) => run.push(fn));
    const u = update(7);
    duringPopstate(() => wrapped(...u));
    run.forEach((fn) => fn());
    expect(calls).toEqual([u]);
    expect(calls[0]![1]).toBe(u[1]);
  });

  it('still shows the page Back and Forward go to', async () => {
    window.history.replaceState(null, '', '/a');
    const router = createBrowserRouter([
      { path: '/a', element: <h1>Page A</h1> },
      { path: '/b', element: <h1>Page B</h1> },
    ]);
    const subscribe = router.subscribe.bind(router);
    router.subscribe = (fn) => subscribe(deferPopstateUpdates(fn));
    render(<RouterProvider router={router} />);
    await act(async () => {
      await router.navigate('/b');
    });
    expect(screen.getByRole('heading').textContent).toBe('Page B');

    // The browser's own Back: a real popstate.
    await act(async () => {
      window.history.back();
    });
    expect(await screen.findByRole('heading', { name: 'Page A' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/a');
    await act(async () => {
      window.history.forward();
    });
    expect(await screen.findByRole('heading', { name: 'Page B' })).toBeTruthy();
    router.dispose();
  });
});
