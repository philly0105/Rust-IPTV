import type { RouteObject } from 'react-router';

const page = async () => ({ Component: (await import('./SettingsPage')).SettingsPage });

/**
 * SPEC C7: `/settings/:section`, and `/settings`, which is the list of sections on a phone and
 * goes on to `/settings/general` on a wider window (SettingsPage decides). The page loads lazily.
 */
export const settingsRoutes: RouteObject[] = [
  { path: 'settings', lazy: page },
  { path: 'settings/:section', lazy: page },
];
