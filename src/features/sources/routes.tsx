import type { RouteObject } from 'react-router';

/** SPEC C7: `/sources` (with `?add=<url>&kind=<kind>` opening the Add Source dialog). The page loads lazily. */
export const sourcesRoutes: RouteObject[] = [
  { path: 'sources', lazy: async () => ({ Component: (await import('./SourcesPage')).SourcesPage }) },
];
