/**
 * L3-ui-data-x5: preloadRoute starts a route's lazy page chunk without rendering, so main.tsx can
 * fetch the saved screen's chunk while `/` is still waiting to redirect there.
 */

import { matchRoutes, type RouteObject } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { preloadRoute, routes } from '@/routes';

const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
});

/** Swaps the lazy loader of every route `path` matches for a spy. */
function spyLazy(path: string, impl: () => Promise<Record<string, never>>) {
  const lazyRoutes = (matchRoutes(routes, path) ?? []).map((m) => m.route).filter((r) => typeof r.lazy === 'function');
  const spies = lazyRoutes.map((route) => {
    const original = route.lazy;
    const spy = vi.fn(impl);
    route.lazy = spy as unknown as RouteObject['lazy'];
    restore.push(() => {
      route.lazy = original;
    });
    return spy;
  });
  return spies;
}

describe('preloadRoute (L3-ui-data-x5)', () => {
  it.each(['/s/x/live', '/s/x/movies?sort=added', '/dashboard', '/s/x/movies/c/1'])('starts the lazy chunk of %s once', (path) => {
    const spies = spyLazy(path, async () => ({}));
    expect(spies.length).toBeGreaterThan(0);
    preloadRoute(path);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a path with no lazy page or no match', () => {
    expect(() => preloadRoute('/')).not.toThrow();
    expect(() => preloadRoute('/s/x')).not.toThrow();
    expect(() => preloadRoute('/no/such/page')).not.toThrow();
  });

  it('leaves a failed download to the route, without an unhandled rejection', async () => {
    const [spy] = spyLazy('/s/x/live', () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')));
    preloadRoute('/s/x/live');
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
