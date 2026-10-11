import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryRouter, matchRoutes, RouterProvider } from 'react-router';

import i18n from '@/i18n';
import { useShellStore } from '@/shell';

import { NotFoundPage, routes } from './routes';

/** Every C7 path; each must resolve to a real page, never the `*` fallback. */
const C7_PATHS = [
  '/',
  '/dashboard',
  '/sources',
  '/settings',
  '/settings/general',
  '/favorites',
  '/recent',
  '/downloads',
  '/my-videos',
  '/my-videos/abc',
  '/search',
  '/epg',
  '/s/x',
  '/s/x/live',
  '/s/x/live/cat',
  '/s/x/radio',
  '/s/x/favorites',
  '/s/x/recent',
  '/s/x/movies',
  '/s/x/movies/c/1',
  '/s/x/series',
  '/s/x/series/c/1',
  '/s/x/movie/1',
  '/s/x/series/1',
  '/s/x/actor/1',
  '/s/x/search',
];

function leafPath(pathname: string): string | undefined {
  const matches = matchRoutes(routes, pathname);
  const leaf = matches?.[matches.length - 1];
  return leaf?.route.index ? '(index)' : leaf?.route.path;
}

describe('route tree (C7)', () => {
  it.each(C7_PATHS)('%s resolves to a page', (path) => {
    const leaf = leafPath(path);
    expect(leaf).toBeDefined();
    expect(leaf).not.toBe('*');
  });

  it('keeps params for nested source routes', () => {
    const m = matchRoutes(routes, '/s/abc/movies/c/42');
    expect(m?.at(-1)?.params).toMatchObject({ sourceId: 'abc', categoryId: '42' });
  });

  it('sends unknown paths to the not-found page inside the shell', () => {
    const m = matchRoutes(routes, '/no/such/page');
    expect(m?.[0]?.route.path).toBe('/');
    expect(m?.at(-1)?.route.path).toBe('*');
  });
});

describe('not-found page', () => {
  afterEach(cleanup);

  function renderNotFound(path = '/definitely-missing') {
    const router = createMemoryRouter([{ path: '*', element: <NotFoundPage /> }], { initialEntries: [path] });
    return render(<RouterProvider router={router} />);
  }

  it('has exactly one h1, carrying the translated title', () => {
    renderNotFound();
    const title = i18n.t('common:pageNotFound');
    expect(title).toBe('Page not found');
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe(title);
  });

  it('keeps the visible hint, the way home, and the shell header title', () => {
    renderNotFound();
    expect(screen.getByText(i18n.t('common:pageNotFoundHint'))).toBeTruthy();
    expect(screen.getByRole('link', { name: i18n.t('shell:navDashboard') }).getAttribute('href')).toBe('/dashboard');
    expect(useShellStore.getState().header?.title).toBe(i18n.t('common:errorTitleNotFound'));
  });
});
