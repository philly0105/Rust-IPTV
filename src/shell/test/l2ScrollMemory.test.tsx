import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { forgetShellScrollForTests, useOutletScrollMemory } from '../scrollMemory';

// XB2-25: a new page opens at the top without writing #main.scrollTop when it is already 0.
// The write forced a synchronous layout of the page that had just mounted (17 ms, series page).

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  forgetShellScrollForTests();
});

/** A #main stand-in whose scrollTop counts writes. */
function makeMain() {
  const main = document.createElement('main');
  let top = 0;
  const writes: number[] = [];
  Object.defineProperty(main, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      writes.push(v);
      top = v;
    },
  });
  Object.defineProperty(main, 'scrollHeight', { value: 5000, configurable: true });
  Object.defineProperty(main, 'clientHeight', { value: 500, configurable: true });
  document.body.appendChild(main);
  /** What a user scroll does: the offset changes and a scroll event follows. */
  const userScroll = (v: number) => {
    top = v;
    fireEvent.scroll(main);
  };
  return { main, writes, userScroll, top: () => top };
}

function setup() {
  const m = makeMain();
  function Layout() {
    useOutletScrollMemory(() => m.main);
    return <Outlet />;
  }
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <Layout />,
        children: [
          { path: 'a', element: <p>page a</p> },
          { path: 'b', element: <p>page b</p> },
          { path: 'c', element: <p>page c</p> },
        ],
      },
    ],
    { initialEntries: ['/a'] },
  );
  render(<RouterProvider router={router} />);
  return { ...m, router };
}

describe('outlet scroll memory without forced layout (XB2-25)', () => {
  it('does not write scrollTop on a new page when #main is already at the top', async () => {
    const { router, writes } = setup();
    await act(() => router.navigate('/b'));
    await act(() => router.navigate('/c'));
    expect(writes).toEqual([]);
  });

  it('still opens a new page at the top after a scroll, then skips the next reset', async () => {
    const { router, writes, userScroll, top } = setup();
    userScroll(800);
    await act(() => router.navigate('/b'));
    expect(top()).toBe(0);
    expect(writes).toEqual([0]);
    await act(() => router.navigate('/c'));
    expect(writes).toEqual([0]);
  });

  it('Back still restores the old offset, and Back to an unscrolled page resets from there', async () => {
    const { router, main, writes, userScroll, top } = setup();
    await act(() => router.navigate('/b'));
    userScroll(800);
    await act(() => router.navigate('/c'));
    expect(top()).toBe(0);
    await act(() => router.navigate(-1));
    expect(top()).toBe(800);
    // The restore's own write fires a scroll event in a browser; jsdom does not, so send it.
    fireEvent.scroll(main);
    writes.length = 0;
    // /a was never scrolled: Back to it resets to the top (one write, from 800).
    await act(() => router.navigate(-1));
    expect(writes).toEqual([0]);
  });
});
