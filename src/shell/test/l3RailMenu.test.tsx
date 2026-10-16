/**
 * L2-checks-2: the collapsed rail's source menu loads in its own chunk, off the entry. Until it
 * is in, each monogram is a look-alike trigger that keeps focus and a press for the real one.
 * Its own file: the first test needs a module registry where the menu has not loaded yet.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { queryClient, rpcKey } from '@/api/query';

import { installDomStubs, makeSource, Page, rpcMock, settings } from './harness';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));

const { Rail } = await import('../Rail');

const routes = [
  {
    path: '/',
    element: (
      <>
        <Rail collapsed autoCollapsed />
        <Outlet />
      </>
    ),
    children: [
      { path: 'dashboard', element: <Page>home</Page> },
      { path: 's/:sourceId/*', element: <Page>source page</Page> },
    ],
  },
];

/** Like the harness's renderRoutes, but with the sources already in the cache, so the entries render on the first pass. */
function renderWithSources() {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity, staleTime: Infinity } });
  queryClient.setQueryData(rpcKey('sources.list'), sources);
  const router = createMemoryRouter(routes, { initialEntries: ['/dashboard'] });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const sources = [makeSource('s1', { name: 'Night Portal', seriesCount: 5 }), makeSource('s2', { name: 'Backup 1', position: 2 })];

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  rpcMock.handlers['settings.get'] = () => settings();
  rpcMock.handlers['sources.list'] = () => sources;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('lazy collapsed-rail menu', () => {
  it('a press before the menu arrives opens it on arrival, with focus on the real trigger', async () => {
    // Sources already known: the entries render on the first pass, before the menu chunk is in.
    renderWithSources();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const early = within(nav).getByRole('button', { name: 'Night Portal' });
    expect(early.hasAttribute('data-rail-menu-pending')).toBe(true);
    // The same trigger as the menu's own, closed.
    expect(early.getAttribute('aria-haspopup')).toBe('menu');
    expect(early.getAttribute('aria-expanded')).toBe('false');
    act(() => early.focus());
    fireEvent.click(early);

    const menu = await screen.findByRole('menu', { name: 'Night Portal' });
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toContain('Series');
    expect(early.isConnected).toBe(false);
    const real = within(nav).getByRole('button', { name: 'Night Portal' });
    expect(real.hasAttribute('data-rail-menu-pending')).toBe(false);
    expect(real.getAttribute('aria-expanded')).toBe('true');
    // Escape returns focus to the trigger that is on the page.
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(real));
    // Closed, and no other entry opened anything.
    expect(screen.queryAllByRole('menu')).toHaveLength(0);
  });

  it('once loaded, a new rail renders the real menu at once', () => {
    renderWithSources();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    for (const name of ['Night Portal', 'Backup 1']) {
      expect(within(nav).getByRole('button', { name }).hasAttribute('data-rail-menu-pending'), name).toBe(false);
    }
  });

  it('Rail.tsx imports Menu only lazily, so it stays out of the entry chunk', () => {
    const src = readFileSync(join(__dirname, '..', 'Rail.tsx'), 'utf8');
    const staticImports = src.match(/^import[^;]*;/gms) ?? [];
    for (const line of staticImports) expect(line, line).not.toMatch(/\bMenu\b(?!Component)/);
    expect(src).toContain("import('@/ui/Menu')");
  });
});
