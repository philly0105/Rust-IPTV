import { useEffect } from 'react';
import { Navigate } from 'react-router';

import type { Settings } from '@/api/types';
import { Skeleton } from '@/ui';

import { consumeStartupDeepLink, isRestorableRoute, useStartupDeepLink } from './effects';
import { useSettings } from './useSettings';

/** Where `/` goes on start (C7): lastRoute, /dashboard, or /sources. */
export function startupTarget(settings: Settings | undefined): string {
  if (!settings) return '/dashboard';
  if (settings.startupBehavior === 'restore-last-view' && settings.lastRoute && isRestorableRoute(settings.lastRoute)) {
    return settings.lastRoute;
  }
  return settings.showDashboard ? '/dashboard' : '/sources';
}

/**
 * The index route. On desktop it first waits for the cold-start deep link
 * pull; a pending link wins over the startup target, so the app lands where
 * the link points even when its route is lazy or settings answer late.
 */
export function StartupRedirect() {
  const settings = useSettings();
  const link = useStartupDeepLink();
  useEffect(() => {
    if (link.path) consumeStartupDeepLink();
  }, [link.path]);
  if (link.path) return <Navigate to={link.path} replace />;
  if (settings.isPending || !link.settled) {
    return (
      <div className="flex flex-col gap-4 p-8" aria-busy="true">
        <Skeleton className="h-56 w-full rounded-lg" />
        <Skeleton className="h-5 w-48" />
      </div>
    );
  }
  // On error fall back to the dashboard; it shows its own error states.
  return <Navigate to={startupTarget(settings.data)} replace />;
}
