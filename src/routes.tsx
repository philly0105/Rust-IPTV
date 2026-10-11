import { Compass } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createBrowserRouter, Link, Navigate, type RouteObject } from 'react-router';

import { libraryRoutes } from '@/features/library/routes';
import { liveRoutes } from '@/features/live/routes';
import { settingsRoutes } from '@/features/settings/routes';
import { sourcesRoutes } from '@/features/sources/routes';
import { vodRoutes } from '@/features/vod/routes';
import { ShellLayout, useShellHeader } from '@/shell';
import { shellRoutes } from '@/shell/routes';
import { buttonClass, EmptyState } from '@/ui';

/**
 * Unknown paths inside the shell: say so and offer the way home.
 *
 * C16: each page owns exactly one `<h1>`. The shell header renders the title
 * as a styled paragraph and `EmptyState` renders its (required) title as an
 * `<h2>`, so the page carries a screen-reader-only `<h1>` with the same text.
 * The visible title stays the EmptyState's, which keeps its centered layout.
 * The header keeps the short `errorTitleNotFound` ("Not found"), matching the
 * title ErrorState uses for `not_found`; the heading spells it out.
 */
export function NotFoundPage() {
  const { t } = useTranslation(['common', 'shell']);
  const title = t('common:pageNotFound');
  const headerTitle = t('common:errorTitleNotFound');
  useShellHeader({ title: headerTitle }, [headerTitle]);
  return (
    <>
      <h1 className="sr-only">{title}</h1>
      <EmptyState
        icon={<Compass size={28} aria-hidden />}
        title={title}
        description={t('common:pageNotFoundHint')}
        action={
          <Link to="/dashboard" className={buttonClass('primary')}>
            {t('shell:navDashboard')}
          </Link>
        }
      />
    </>
  );
}

/** C7: every source kind opens on its live view. */
const sourceRootRoutes: RouteObject[] = [{ path: 's/:sourceId', element: <Navigate to="live" replace /> }];

/** C7 route tree: the shell layout at `/` with every feature's relative routes. */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <ShellLayout />,
    children: [
      ...shellRoutes,
      ...sourcesRoutes,
      ...settingsRoutes,
      ...liveRoutes,
      ...vodRoutes,
      ...libraryRoutes,
      ...sourceRootRoutes,
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
