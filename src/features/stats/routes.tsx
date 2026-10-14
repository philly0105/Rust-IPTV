/** Stats routes (contract C7). Mount among the shell layout route's children; the page loads lazily. */

import type { RouteObject } from 'react-router';

import { STATS_PATH } from './paths';

export const statsRoutes: RouteObject[] = [
  // Absolute, so it resolves to /stats wherever it is mounted under `/`.
  { path: STATS_PATH, lazy: async () => ({ Component: (await import('./pages/StatsPage')).StatsPage }) },
];
