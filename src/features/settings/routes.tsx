import { Navigate, type RouteObject } from 'react-router';

/** SPEC C7: `/settings` -> `/settings/general`; `/settings/:section`. The page loads lazily. */
export const settingsRoutes: RouteObject[] = [
  { path: 'settings', element: <Navigate to="/settings/general" replace /> },
  { path: 'settings/:section', lazy: async () => ({ Component: (await import('./SettingsPage')).SettingsPage }) },
];
