import type { RouteObject } from 'react-router';

import { SourcesPage } from './SourcesPage';

/** SPEC C7: `/sources` (with `?add=<url>&kind=<kind>` opening the Add Source dialog). */
export const sourcesRoutes: RouteObject[] = [{ path: 'sources', element: <SourcesPage /> }];
