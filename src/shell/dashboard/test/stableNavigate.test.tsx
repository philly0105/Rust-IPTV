/**
 * P3-HOME-NAV: a navigation that starts loading the next page re-renders every `useNavigate`
 * reader (React Router builds its route context anew on each router state change). Home's cards
 * read `useStableNavigate`, which does not re-render them, and still navigates.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useNavigate } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { StableNavigateProvider, useStableNavigate } from '../stableNavigate';

afterEach(cleanup);

describe('useStableNavigate', () => {
  it('leaves its readers alone when a navigation starts, and navigates', async () => {
    const renders = { stable: 0, plain: 0 };
    let finishLoad!: () => void;
    const loaded = new Promise<void>((resolve) => (finishLoad = resolve));
    function StableReader() {
      renders.stable++;
      const navigate = useStableNavigate();
      return (
        <button type="button" onClick={() => void navigate('/next')}>
          go
        </button>
      );
    }
    function PlainReader() {
      renders.plain++;
      useNavigate();
      return null;
    }
    function Home() {
      return (
        <StableNavigateProvider>
          <StableReader />
          <PlainReader />
        </StableNavigateProvider>
      );
    }
    const router = createMemoryRouter([
      { path: '/', element: <Home /> },
      {
        path: '/next',
        // The next page's code still loading: the router stays on Home with a navigation pending.
        lazy: async () => {
          await loaded;
          return { element: <p>next page</p> };
        },
      },
    ]);
    render(<RouterProvider router={router} />);
    const stable0 = renders.stable;
    const plain0 = renders.plain;
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(router.state.navigation.state).toBe('loading');
    // The plain reader shows the cost the stable one avoids.
    expect(renders.plain).toBeGreaterThan(plain0);
    expect(renders.stable).toBe(stable0);
    await act(async () => finishLoad());
    expect(await screen.findByText('next page')).toBeTruthy();
  });

  it('falls back to React Router outside the provider', async () => {
    function Lone() {
      const navigate = useStableNavigate();
      return (
        <button type="button" onClick={() => void navigate('/there')}>
          go
        </button>
      );
    }
    const router = createMemoryRouter([
      { path: '/', element: <Lone /> },
      { path: '/there', element: <p>there</p> },
    ]);
    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(await screen.findByText('there')).toBeTruthy();
  });
});
