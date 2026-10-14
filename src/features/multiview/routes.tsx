/** Multi-view routes (contract C4). Mount among the shell layout route's children; the page loads lazily. */

import type { RouteObject } from 'react-router';

import { MULTIVIEW_PATH } from './paths';

export const multiviewRoutes: RouteObject[] = [
  // Absolute, so it resolves to /multiview wherever it is mounted under `/`.
  { path: MULTIVIEW_PATH, lazy: async () => ({ Component: (await import('./components/MultiviewPage')).MultiviewPage }) },
];
