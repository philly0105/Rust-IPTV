import { useEffect } from 'react';
import { Navigate } from 'react-router';

import { queryClient, rpcKey, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import type { CustomList, Settings, Source } from '@/api/types';
import { Skeleton } from '@/ui';

import { consumeStartupDeepLink, isRestorableRoute, pendingStartupDeepLink, pullStartupDeepLink, useStartupDeepLink } from './effects';
import { routeSourceId } from './railLinks';
import { useSettings } from './useSettings';

/** The list id of a `/lists/:id` route, decoded; undefined for any other path. */
export function routeListId(path: string): string | undefined {
  const m = /^\/lists\/([^/?#]+)/.exec(path);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1];
  }
}

/** What startup knows to check the saved screen against. A missing piece is not checked. */
export interface StartupChecks {
  /** The current source list. */
  sources?: readonly Pick<Source, 'id'>[];
  /** The current custom lists. */
  lists?: readonly Pick<CustomList, 'id'>[];
  /** False for a path no route renders (the app's 404 page). */
  isKnownPath?: (pathname: string) => boolean;
}

/** The screen `/` restores, before any check: lastRoute in restore-last-view mode. */
function savedRoute(settings: Settings | undefined): string | undefined {
  const last = settings?.lastRoute;
  return settings?.startupBehavior === 'restore-last-view' && last && isRestorableRoute(last) ? last : undefined;
}

/**
 * Where `/` goes on start (C7): lastRoute, /dashboard, or /sources. A saved screen that no
 * longer exists is not restored: a path no route knows, a screen of a source that was removed
 * (here or from another client; the catch-up archive included), or a deleted custom list.
 */
export function startupTarget(settings: Settings | undefined, checks: StartupChecks = {}): string {
  if (!settings) return '/dashboard';
  const last = savedRoute(settings);
  if (last) {
    const pathname = last.replace(/[?#].*$/, '');
    const sourceId = routeSourceId(pathname);
    const listId = routeListId(pathname);
    const dead =
      (checks.isKnownPath && !checks.isKnownPath(pathname)) ||
      (sourceId !== undefined && !!checks.sources && !checks.sources.some((s) => s.id === sourceId)) ||
      (listId !== undefined && !!checks.lists && !checks.lists.some((l) => l.id === listId));
    if (!dead) return last;
  }
  return settings.showDashboard ? '/dashboard' : '/sources';
}

/**
 * Forgets a saved screen that no longer exists, so no later start tries it again. The reply goes
 * into the cache: a lastRoute-only update sends no settings.changed event.
 */
function forgetDeadScreen(target: string): void {
  void rpc('settings.update', { patch: { lastRoute: target } })
    .then((s) => queryClient.setQueryData(rpcKey('settings.get'), s))
    .catch(() => undefined);
}

/** Where a cold start at `/` goes, worked out before the router exists (`resolveStartup`). */
export interface StartupDecision {
  /** The path the router starts at instead of `/`. */
  path: string;
  /**
   * Does what StartupRedirect does once it navigates there: marks the startup deep link handled,
   * or writes the default target back as lastRoute when the saved screen is dead. Call it only
   * when the router does start at `path`; otherwise StartupRedirect decides as before.
   */
  commit: () => void;
}

/**
 * The startup target of a cold start at `/` (C7), worked out as StartupRedirect does, from the
 * boot's `settings.get` and, when the saved screen needs them, `sources.list` or `lists.list`; on
 * desktop after the one `app.pendingDeepLinks` pull, whose link wins. main.tsx starts the router
 * at it, so the first render is the page itself: no redirect step from `/` and no shell render of
 * the index route before it. Null when settings fail: the router then starts at `/` and
 * StartupRedirect shows its fallback. A list that fails restores the screen anyway, as there.
 */
export async function resolveStartup(isKnownPath?: (pathname: string) => boolean): Promise<StartupDecision | null> {
  let settings: Settings;
  try {
    [settings] = await Promise.all([queryClient.ensureQueryData({ queryKey: rpcKey('settings.get'), queryFn: () => rpc('settings.get') }), pullStartupDeepLink()]);
  } catch {
    return null;
  }
  const link = pendingStartupDeepLink();
  if (link) return { path: link, commit: consumeStartupDeepLink };
  const saved = savedRoute(settings);
  const [sources, lists] = await Promise.all([
    saved !== undefined && routeSourceId(saved) !== undefined
      ? queryClient.ensureQueryData({ queryKey: rpcKey('sources.list'), queryFn: () => rpc('sources.list') }).catch(() => undefined)
      : undefined,
    saved !== undefined && routeListId(saved) !== undefined
      ? queryClient.ensureQueryData({ queryKey: rpcKey('lists.list'), queryFn: () => rpc('lists.list') }).catch(() => undefined)
      : undefined,
  ]);
  const path = startupTarget(settings, { sources, lists, isKnownPath });
  const stale = saved !== undefined && path !== saved;
  return {
    path,
    commit: () => {
      if (stale) forgetDeadScreen(path);
    },
  };
}

/** Starts the dashboard chunk download; shared by the route and the startup prefetch. */
export const loadDashboard = () => import('./dashboard/DashboardPage');

/**
 * The index route. On desktop it first waits for the cold-start deep link
 * pull; a pending link wins over the startup target, so the app lands where
 * the link points even when its route is lazy or settings answer late.
 * `isKnownPath` (from the app's route tree) lets it drop a saved path no route renders.
 */
export function StartupRedirect({ isKnownPath }: { isKnownPath?: (pathname: string) => boolean } = {}) {
  const settings = useSettings();
  const link = useStartupDeepLink();
  // The saved screen points at a source or a list, so startup needs that list to check it.
  const saved = savedRoute(settings.data);
  const checkSource = saved !== undefined && routeSourceId(saved) !== undefined;
  const checkList = saved !== undefined && routeListId(saved) !== undefined;
  const sources = useRpcQuery('sources.list', undefined, { enabled: checkSource });
  const lists = useRpcQuery('lists.list', undefined, { enabled: checkList });
  // Waits for a list only when the saved screen needs it; a failed list restores the screen anyway.
  const checksPending = (checkSource && sources.isPending) || (checkList && lists.isPending);
  const target = startupTarget(settings.data, {
    sources: checkSource && sources.isSuccess ? sources.data : undefined,
    lists: checkList && lists.isSuccess ? lists.data : undefined,
    isKnownPath,
  });
  const stale = saved !== undefined && !checksPending && target !== saved;
  // The dashboard's chunks download only when it is where startup goes (on desktop already
  // while the deep-link pull runs); restoring another screen no longer pays for them.
  const toDashboard = !link.path && !settings.isPending && !checksPending && target === '/dashboard';
  useEffect(() => {
    if (toDashboard) void loadDashboard().catch(() => undefined);
  }, [toDashboard]);
  useEffect(() => {
    if (link.path) consumeStartupDeepLink();
  }, [link.path]);
  useEffect(() => {
    if (stale) forgetDeadScreen(target);
  }, [stale, target]);
  if (link.path) return <Navigate to={link.path} replace />;
  if (settings.isPending || !link.settled || checksPending) {
    return (
      // A neutral frame, not the hero's (SH-hero-skeleton-flash): restoring the last screen, the
      // default, often lands somewhere else, and a new user's Home has no hero at all, so a
      // 22rem placeholder showed and then collapsed. One faint line where every page starts.
      <div className="px-(--page-gutter) py-6" aria-busy="true" data-testid="startup-pending">
        <Skeleton className="h-5 w-48 opacity-60" />
      </div>
    );
  }
  // On error fall back to the dashboard; it shows its own error states.
  return <Navigate to={target} replace />;
}
