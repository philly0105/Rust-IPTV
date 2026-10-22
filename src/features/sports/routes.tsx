/** Sports routes. Mount among the shell layout route's children; the page loads lazily. */

import type { RouteObject } from 'react-router';

import { SPORTS_PATH } from './paths';

export const sportsRoutes: RouteObject[] = [
  // Absolute, so it resolves to /sports wherever it is mounted under `/`.
  { path: SPORTS_PATH, lazy: async () => ({ Component: (await import('./pages/SportsPage')).SportsPage }) },
];
