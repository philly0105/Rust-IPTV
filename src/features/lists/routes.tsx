/** Lists routes (Run 2 C3). Mount among the shell layout route's children; both pages load lazily. */

import type { RouteObject } from 'react-router';

import { LISTS_PATH } from './paths';

export const listsRoutes: RouteObject[] = [
  // Absolute, so they resolve to /lists wherever they are mounted under `/`.
  { path: LISTS_PATH, lazy: async () => ({ Component: (await import('./pages/ListsIndexPage')).ListsIndexPage }) },
  { path: `${LISTS_PATH}/:listId`, lazy: async () => ({ Component: (await import('./pages/ListPage')).ListPage }) },
];
