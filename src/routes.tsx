import { Compass } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { createBrowserRouter, isRouteErrorResponse, Link, matchRoutes, Navigate, useParams, useRouteError, type RouteObject } from 'react-router';

import { getConnectionState, onConnectionState } from '@/api/events';
import { useRpcQuery } from '@/api/query';
import { isDesktop, RpcError } from '@/api/transport';
import { libraryRoutes } from '@/features/library/routes';
import { listsRoutes } from '@/features/lists/routes';
import { liveRoutes } from '@/features/live/routes';
import { multiviewRoutes } from '@/features/multiview/routes';
import { myListRoutes } from '@/features/mylist/routes';
import { settingsRoutes } from '@/features/settings/routes';
import { sourcesRoutes } from '@/features/sources/routes';
import { statsRoutes } from '@/features/stats/routes';
import { vodRoutes } from '@/features/vod/routes';
import { ShellLayout, sourceHomePath, useShellHeader, useShellStore } from '@/shell';
import { PHONE_QUERY } from '@/shell/navigation';
import { ShellSkeleton } from '@/shell/ShellLayout';
import { loadDashboard, StartupRedirect } from '@/shell/StartupRedirect';
import { useMediaQuery } from '@/shell/useMediaQuery';
import { buttonClass, EmptyState, ERROR_TITLE_KEYS, ErrorState } from '@/ui';

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
 * Text-free first frame while the router loads the lazy page chunks a deep link needs (initial
 * hydration). The shell's own skeleton (SH-boot-skeletons), so the frame, the shell's language
 * wait and the real shell all share one geometry and nothing jumps between them.
 */
export function AppLoading() {
  const railPref = useShellStore((s) => s.railCollapsed);
  const railHiddenPref = useShellStore((s) => s.railHidden);
  const narrow = useMediaQuery('(max-width: 1023px)');
  const phone = useMediaQuery(PHONE_QUERY);
  return <ShellSkeleton collapsed={railPref || narrow} railHidden={railHiddenPref && narrow && !phone} phone={phone} testId="app-loading" />;
}

/** A lazy page chunk that failed to download (offline, or a stale build after an update). */
function isChunkLoadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|Failed to fetch/i.test(message);
}

/**
 * The route error as an RpcError so ErrorState can title it by code. A page chunk that failed
 * to download in server mode means the app's own server did not answer: it is marked like
 * transport.ts marks an unreachable server, so the page says so in plain words (the raw browser
 * text moves into the technical details) instead of blaming the provider.
 */
export function routeErrorAsRpc(err: unknown): RpcError {
  if (err instanceof RpcError) return err;
  if (isRouteErrorResponse(err)) {
    return new RpcError(err.status === 404 ? 'not_found' : 'internal', err.statusText || String(err.status), false);
  }
  if (isChunkLoadError(err)) {
    const raw = err instanceof Error ? err.message : String(err);
    return isDesktop ? new RpcError('network', raw, true) : new RpcError('network', raw, true, { transport: 'unreachable' });
  }
  return new RpcError('internal', err instanceof Error ? err.message : String(err), false);
}

/**
 * Set once a page chunk failed to load. The browser keeps a failed module import failed for the
 * life of the document, so the next in-app navigation loads the app afresh (createAppRouter)
 * once the server answers again.
 */
let chunkFailedAt: string | null = null;

/** Test hook. */
export function resetChunkFailureForTests(): void {
  chunkFailedAt = null;
}

/**
 * Error boundary for every page (a render crash, a failed lazy chunk, a
 * loader error). It renders inside the shell, so the rail and the player
 * stay usable; Try again reloads the page, which refetches the chunk.
 */
export function RouteErrorPage() {
  const { t } = useTranslation('common');
  const raw = useRouteError();
  const error = routeErrorAsRpc(raw);
  const chunk = isChunkLoadError(raw);
  const title = t(error.code === 'not_found' ? 'pageNotFound' : (ERROR_TITLE_KEYS[error.code] ?? 'errorTitleInternal'));
  // The header names the failure too, instead of keeping a blank (or the last page's) title.
  useShellHeader({ title }, [title]);

  useEffect(() => {
    if (!chunk || isDesktop) return;
    chunkFailedAt = window.location.href;
    // The server came back: load the page again by itself once the events connection reopens.
    let down = false;
    return onConnectionState((s) => {
      if (s !== 'open') down = true;
      else if (down) window.location.reload();
    });
  }, [chunk]);

  return (
    <>
      <h1 className="sr-only">{title}</h1>
      <ErrorState error={error} onRetry={() => window.location.reload()} />
    </>
  );
}

/**
 * Shell-owned child routes (C7), wired here instead of `@/shell/routes` so the
 * dashboard is a lazy chunk: the index route performs the startup redirect,
 * and prefetches the dashboard only when that is where it goes.
 */
const shellChildRoutes: RouteObject[] = [
  { index: true, element: <StartupRedirect isKnownPath={isKnownPath} /> },
  { path: 'dashboard', lazy: async () => ({ Component: (await loadDashboard()).DashboardPage }) },
];

/**
 * C7: a source opens on its live view, or on its first section with anything in it when it has
 * no live channels (a VOD-only Xtream account opens on Movies, not an empty channel list).
 */
export function SourceIndexRedirect() {
  const { sourceId = '' } = useParams();
  const sources = useRpcQuery('sources.list', undefined);
  // The list is prefetched at boot, so this rarely waits; a failed list opens Live as before.
  if (sources.isPending) return null;
  const source = sources.data?.find((s) => s.id === sourceId);
  return <Navigate to={source ? sourceHomePath(source) : 'live'} replace />;
}

const sourceRootRoutes: RouteObject[] = [{ path: 's/:sourceId', element: <SourceIndexRedirect /> }];

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

/**
 * True when a route other than the not-found page renders `pathname`. Startup uses it to drop a
 * saved screen whose path no longer exists.
 */
export function isKnownPath(pathname: string): boolean {
  const matched = matchRoutes(routes, pathname);
  const leaf = matched?.[matched.length - 1]?.route;
  return !!leaf && leaf.path !== '*';
}

/**
 * Starts downloading the lazy page chunks of `path` without rendering anything (L3-ui-data-x5).
 * The router starts a deep link's chunks itself as it is created, but `/` only redirects to the
 * saved screen once settings are in and the shell has rendered, so main.tsx calls this as soon as
 * settings arrive: the page chunk then downloads alongside the language and the first render. A
 * failed download is left to the route, which tries again and shows the error.
 */
export function preloadRoute(path: string): void {
  for (const { route } of matchRoutes(routes, path) ?? []) {
    if (typeof route.lazy === 'function') void route.lazy().catch(() => undefined);
  }
}

export function createAppRouter() {
  const router = createBrowserRouter(routes);
  // After a failed page chunk, the next navigation (to anywhere else) is a full load, so every
  // chunk downloads afresh, but only while the server answers: offline it would leave the app.
  router.subscribe((state) => {
    if (chunkFailedAt === null || getConnectionState() !== 'open') return;
    const target = state.navigation.location ?? state.location;
    const href = new URL(router.createHref(target), window.location.href).href;
    if (href === chunkFailedAt) return;
    chunkFailedAt = null;
    window.location.assign(href);
  });
  return router;
}
