import { Navigate } from 'react-router';

import type { Settings } from '@/api/types';
import { Skeleton } from '@/ui';

import { isRestorableRoute } from './effects';
import { useSettings } from './useSettings';

/** Where `/` goes on start (C7): lastRoute, /dashboard, or /sources. */
export function startupTarget(settings: Settings | undefined): string {
  if (!settings) return '/dashboard';
  if (settings.startupBehavior === 'restore-last-view' && settings.lastRoute && isRestorableRoute(settings.lastRoute)) {
    return settings.lastRoute;
  }
  return settings.showDashboard ? '/dashboard' : '/sources';
}

export function StartupRedirect() {
  const settings = useSettings();
  if (settings.isPending) {
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
