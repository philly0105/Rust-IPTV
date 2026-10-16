/** Lists routes (Run 2 C3). Mount among the shell layout route's children; both pages load lazily. */

import type { RouteObject } from 'react-router';

import { queryClient, rpcKey } from '@/api/query';
import { rpc } from '@/api/transport';

import { LISTS_PATH } from './paths';

export const listsRoutes: RouteObject[] = [
  // Absolute, so they resolve to /lists wherever they are mounted under `/`.
  { path: LISTS_PATH, lazy: async () => ({ Component: (await import('./pages/ListsIndexPage')).ListsIndexPage }) },
  {
    path: `${LISTS_PATH}/:listId`,
    lazy: async () => {
      // The lists' counts shape the page's first frame on a phone (an empty list has no stage), so they
      // load beside the page's chunk instead of after it (L3-visual-4). Same key and staleTime as useLists.
      void queryClient.prefetchQuery({ queryKey: rpcKey('lists.list'), queryFn: () => rpc('lists.list'), staleTime: 60_000 });
      return { Component: (await import('./pages/ListPage')).ListPage };
    },
  },
];
