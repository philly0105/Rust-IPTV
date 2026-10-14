import { Compass } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createBrowserRouter, isRouteErrorResponse, Link, Navigate, useRouteError, type RouteObject } from 'react-router';

import { RpcError } from '@/api/transport';
import { libraryRoutes } from '@/features/library/routes';
import { listsRoutes } from '@/features/lists/routes';
import { liveRoutes } from '@/features/live/routes';
import { multiviewRoutes } from '@/features/multiview/routes';
import { myListRoutes } from '@/features/mylist/routes';
import { settingsRoutes } from '@/features/settings/routes';
import { sourcesRoutes } from '@/features/sources/routes';
import { statsRoutes } from '@/features/stats/routes';
import { vodRoutes } from '@/features/vod/routes';
import { ShellLayout, useShellHeader, useShellStore } from '@/shell';
import { StartupRedirect } from '@/shell/StartupRedirect';
import { useMediaQuery } from '@/shell/useMediaQuery';
import { buttonClass, cn, EmptyState, ErrorState, Skeleton } from '@/ui';

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

/**
 * Text-free first frame while the router loads the lazy page chunks a deep
 * link needs (initial hydration). Same geometry as the shell's own language
 * skeleton, so nothing jumps when the real shell replaces it.
 */
export function AppLoading() {
  const railPref = useShellStore((s) => s.railCollapsed);
  const narrow = useMediaQuery('(max-width: 1023px)');
  const collapsed = railPref || narrow;
  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-bg text-fg" data-testid="app-loading" aria-busy="true">
      <div
        aria-hidden
        className={cn(
          'flex h-full shrink-0 flex-col gap-3 border-e border-divider bg-surface px-3 pt-5',
          collapsed ? 'w-(--rail-width-collapsed)' : 'w-(--rail-width)',
        )}
      >
        <Skeleton className="mb-4 h-8 w-8 rounded-md" />
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className={cn('h-8 rounded-md', collapsed ? 'w-10' : 'w-4/5')} />
        ))}
      </div>
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <div aria-hidden className="flex h-(--header-height) shrink-0 items-center gap-4 border-b border-divider px-5">
          <Skeleton className="h-6 w-40" />
          <div className="flex-1" />
          <Skeleton className="h-8 w-[clamp(160px,22vw,300px)] rounded-md" />
        </div>
        <div aria-hidden className="flex flex-col gap-6 p-8">
          <Skeleton className="h-48 w-full rounded-lg" />
          <Skeleton className="h-5 w-48" />
        </div>
      </div>
    </div>
  );
}

/** A lazy page chunk that failed to download (offline, or a stale build after an update). */
function isChunkLoadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|Failed to fetch/i.test(message);
}

/** The route error as an RpcError so ErrorState can title it by code. */
function routeErrorAsRpc(err: unknown): RpcError {
  if (err instanceof RpcError) return err;
  if (isRouteErrorResponse(err)) {
    return new RpcError(err.status === 404 ? 'not_found' : 'internal', err.statusText || String(err.status), false);
  }
  if (isChunkLoadError(err)) return new RpcError('network', err instanceof Error ? err.message : String(err), true);
  return new RpcError('internal', err instanceof Error ? err.message : String(err), false);
}

/**
 * Error boundary for every page (a render crash, a failed lazy chunk, a
 * loader error). It renders inside the shell, so the rail and the player
 * stay usable; Try again reloads the page, which refetches the chunk.
 */
export function RouteErrorPage() {
  const { t } = useTranslation('common');
  const error = routeErrorAsRpc(useRouteError());
  const title = t(error.code === 'not_found' ? 'pageNotFound' : 'errorTitleInternal');
  return (
    <>
      <h1 className="sr-only">{title}</h1>
      <ErrorState error={error} onRetry={() => window.location.reload()} />
    </>
  );
}

/** Starts the dashboard chunk download; shared by the route and the startup prefetch. */
const loadDashboard = () => import('@/shell/dashboard/DashboardPage');

/**
 * Shell-owned child routes (C7), wired here instead of `@/shell/routes` so the
 * dashboard is a lazy chunk: the index route performs the startup redirect
 * and, on its way, prefetches the dashboard (the most common landing page).
 */
const shellChildRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => {
      void loadDashboard().catch(() => undefined);
      return { element: <StartupRedirect /> };
    },
  },
  { path: 'dashboard', lazy: async () => ({ Component: (await loadDashboard()).DashboardPage }) },
];

/** C7: every source kind opens on its live view. */
const sourceRootRoutes: RouteObject[] = [{ path: 's/:sourceId', element: <Navigate to="live" replace /> }];

/** C7 route tree: the shell layout at `/` with every feature's relative routes. */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <ShellLayout />,
    HydrateFallback: AppLoading,
    // A crash in the shell itself: the whole window shows the error and a reload.
    errorElement: <RouteErrorPage />,
    children: [
      {
        // Pathless boundary: a page error renders inside the shell's outlet.
        errorElement: <RouteErrorPage />,
        children: [
          ...shellChildRoutes,
          ...sourcesRoutes,
          ...settingsRoutes,
          ...liveRoutes,
          ...vodRoutes,
          ...libraryRoutes,
          ...multiviewRoutes,
          ...myListRoutes,
          ...listsRoutes,
          ...statsRoutes,
          ...sourceRootRoutes,
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
