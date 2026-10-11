import type { RouteObject } from 'react-router';

import { DashboardPage } from './dashboard/DashboardPage';
import { StartupRedirect } from './StartupRedirect';

/**
 * Shell-owned child routes of the layout route (C7). The index route performs
 * the startup redirect (lastRoute | /dashboard | /sources).
 *
 * Wire as: `{ path: '/', element: <ShellLayout />, children: [...shellRoutes, ...featureRoutes] }`.
 */
export const shellRoutes: RouteObject[] = [
  { index: true, element: <StartupRedirect /> },
  { path: 'dashboard', element: <DashboardPage /> },
];
