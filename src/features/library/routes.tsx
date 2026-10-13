/** Library routes (SPEC C7). Children of the shell layout route `/`. Pages load lazily. */

import type { RouteObject } from 'react-router';

export const libraryRoutes: RouteObject[] = [
  { path: 'downloads', lazy: async () => ({ Component: (await import('./pages/DownloadsPage')).DownloadsPage }) },
  { path: 'my-videos', lazy: async () => ({ Component: (await import('./pages/MyVideosPage')).MyVideosPage }) },
  { path: 'my-videos/:id', lazy: async () => ({ Component: (await import('./pages/MyVideoDetailPage')).MyVideoDetailPage }) },
  { path: 'favorites', lazy: async () => ({ Component: (await import('./pages/FavoritesPage')).FavoritesPage }) },
  // recording:
  { path: 'scheduled', lazy: async () => ({ Component: (await import('./pages/ScheduledPage')).ScheduledPage }) },
  { path: 'recent', lazy: async () => ({ Component: (await import('./pages/RecentPage')).RecentPage }) },
  { path: 's/:sourceId/favorites', lazy: async () => ({ Component: (await import('./pages/FavoritesPage')).FavoritesPage }) },
  { path: 's/:sourceId/recent', lazy: async () => ({ Component: (await import('./pages/RecentPage')).RecentPage }) },
];
