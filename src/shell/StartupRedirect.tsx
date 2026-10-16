import { useEffect } from 'react';
import { Navigate } from 'react-router';

import { queryClient, rpcKey, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import type { Settings, Source } from '@/api/types';
import { HeroSkeleton } from './dashboard/HeroSkeleton';
import { consumeStartupDeepLink, isRestorableRoute, useStartupDeepLink } from './effects';
import { useSettings } from './useSettings';

/** The source id of a `/s/:id/...` route, decoded; undefined for any other path. */
export function routeSourceId(path: string): string | undefined {
  const m = /^\/s\/([^/?#]+)/.exec(path);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1];
  }
}

/**
 * Where `/` goes on start (C7): lastRoute, /dashboard, or /sources. A saved screen of a source
 * that no longer exists (removed here or from another client) is not restored: `sources` is the
 * current list, when known.
 */
export function startupTarget(settings: Settings | undefined, sources?: readonly Pick<Source, 'id'>[]): string {
  if (!settings) return '/dashboard';
  const last = settings.lastRoute;
  if (settings.startupBehavior === 'restore-last-view' && last && isRestorableRoute(last)) {
    const sourceId = routeSourceId(last);
    if (sourceId === undefined || !sources || sources.some((s) => s.id === sourceId)) return last;
  }
  return settings.showDashboard ? '/dashboard' : '/sources';
}

/** Starts the dashboard chunk download; shared by the route and the startup prefetch. */
export const loadDashboard = () => import('./dashboard/DashboardPage');

/** The saved screen points at a source, so startup needs the source list to check it. */
function needsSources(settings: Settings | undefined): boolean {
  const last = settings?.lastRoute;
  return settings?.startupBehavior === 'restore-last-view' && !!last && routeSourceId(last) !== undefined;
}

/**
 * The index route. On desktop it first waits for the cold-start deep link
 * pull; a pending link wins over the startup target, so the app lands where
 * the link points even when its route is lazy or settings answer late.
 */
export function StartupRedirect() {
  const settings = useSettings();
  const link = useStartupDeepLink();
  const checkSource = needsSources(settings.data);
  const sources = useRpcQuery('sources.list', undefined, { enabled: checkSource });
  // Waits for the list only when the saved screen is a source's; a failed list restores it anyway.
  const sourcesPending = checkSource && sources.isPending;
  const target = startupTarget(settings.data, checkSource && sources.isSuccess ? sources.data : undefined);
  const stale = checkSource && sources.isSuccess && target !== settings.data?.lastRoute;
  // The dashboard's chunks download only when it is where startup goes (on desktop already
  // while the deep-link pull runs); restoring another screen no longer pays for them.
  const toDashboard = !link.path && !settings.isPending && !sourcesPending && target === '/dashboard';
  useEffect(() => {
    if (toDashboard) void loadDashboard().catch(() => undefined);
  }, [toDashboard]);
  useEffect(() => {
    if (link.path) consumeStartupDeepLink();
  }, [link.path]);
  useEffect(() => {
    // Forget the dead screen, so no later start tries it again. The reply goes into the cache:
    // a lastRoute-only update sends no settings.changed event.
    if (stale) {
      void rpc('settings.update', { patch: { lastRoute: target } })
        .then((s) => queryClient.setQueryData(rpcKey('settings.get'), s))
        .catch(() => undefined);
    }
  }, [stale, target]);
  if (link.path) return <Navigate to={link.path} replace />;
  if (settings.isPending || !link.settled || sourcesPending) {
    return (
      // Same frame as the dashboard's loading state, the most common landing page.
      <div className="flex flex-col gap-10 pt-8" aria-busy="true" data-testid="startup-pending">
        <HeroSkeleton />
      </div>
    );
  }
  // On error fall back to the dashboard; it shows its own error states.
  return <Navigate to={target} replace />;
}
