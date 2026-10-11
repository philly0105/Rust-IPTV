import type { RouteObject } from 'react-router';

const livePage = (mode: 'live' | 'radio'): RouteObject['lazy'] => async () => {
  const { LivePage } = await import('./components/LivePage');
  return { element: <LivePage mode={mode} /> };
};

/** C7: live, radio and the multi-channel guide. Mounted as children of the shell layout route. Pages load lazily. */
export const liveRoutes: RouteObject[] = [
  { path: 's/:sourceId/live', lazy: livePage('live') },
  { path: 's/:sourceId/live/:categoryId', lazy: livePage('live') },
  { path: 's/:sourceId/radio', lazy: livePage('radio') },
  { path: 'epg', lazy: async () => ({ Component: (await import('./components/EpgGridPage')).EpgGridPage }) },
];
