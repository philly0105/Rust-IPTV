import type { RouteObject } from 'react-router';

import { EpgGridPage } from './components/EpgGridPage';
import { LivePage } from './components/LivePage';

/** C7: live, radio and the multi-channel guide. Mounted as children of the shell layout route. */
export const liveRoutes: RouteObject[] = [
  { path: 's/:sourceId/live', element: <LivePage mode="live" /> },
  { path: 's/:sourceId/live/:categoryId', element: <LivePage mode="live" /> },
  { path: 's/:sourceId/radio', element: <LivePage mode="radio" /> },
  { path: 'epg', element: <EpgGridPage /> },
];
