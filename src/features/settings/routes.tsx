import { Navigate, type RouteObject } from 'react-router';

import { SettingsPage } from './SettingsPage';

/** SPEC C7: `/settings` -> `/settings/general`; `/settings/:section`. */
export const settingsRoutes: RouteObject[] = [
  { path: 'settings', element: <Navigate to="/settings/general" replace /> },
  { path: 'settings/:section', element: <SettingsPage /> },
];
