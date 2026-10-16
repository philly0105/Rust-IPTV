/** My List routes (contract C3). Mount among the shell layout route's children; the page loads lazily. */

import type { RouteObject } from 'react-router';

import { MY_LIST_PATH } from './paths';

export const myListRoutes: RouteObject[] = [
  // Absolute, so it resolves to /my-list wherever it is mounted under `/`.
  { path: MY_LIST_PATH, lazy: async () => ({ Component: (await import('./pages/MyListPage')).MyListPage }) },
];
