/**
 * Shell-wide side effects: event-driven cache invalidation, import progress
 * toasts, settings.changed sync, deep links, lastRoute persistence, and the
 * desktop window-geometry mirror (the OS window itself is restored by
 * tauri-plugin-window-state).
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import { onAppEvent, onConnectionState } from '@/api/events';
import { bindEventInvalidation, invalidate, queryClient, rpcKey } from '@/api/query';
import { isDesktop, rpc } from '@/api/transport';
import type { ImportProgressEvent, Settings, Source, WindowState } from '@/api/types';
import { applyLanguage } from '@/i18n';
import { dismissToast, toast } from '@/ui';

/** Query prefixes invalidated per event type. */
export const EVENT_INVALIDATION: Record<string, string[]> = {
  'sources.changed': ['sources.', 'catalog.', 'favorites.', 'recent.', 'positions.', 'xtream.', 'stalker.'],
  'epg.changed': ['epg.'],
  'downloads.update': ['downloads.', 'myvideos.'],
};

/** Maps an `iptv://` URL to an in-app path, or null when unsupported. */
export function deepLinkToPath(raw: string): string | null {
  const m = /^iptv:\/*([^/?#]+)\/?(\?[^#]*)?/i.exec(raw.trim());
  if (!m) return null;
  const action = m[1]!.toLowerCase();
  const params = new URLSearchParams(m[2] ?? '');
  if (action === 'add') {
    const url = params.get('url');
    if (!url) return '/sources?add=1';
    return `/sources?add=${encodeURIComponent(url)}`;
  }
  if (action === 'search') {
    const q = params.get('q');
    return q ? `/search?q=${encodeURIComponent(q)}` : '/search';
  }
  return null;
}

/** True when the Sources page is the active route (`/sources`, any query). */
export function isSourcesRoute(pathname: string): boolean {
  return /^\/sources\/?$/.test(pathname);
}

/**
 * What the shell does with an `import.progress` event.
 *
 * The Sources page shows per-card import progress, and its add dialog and
 * refresh flow toast their own success, so while it is the active route the
 * shell stays quiet for progress and `done` (and clears any toast it showed
 * before the user arrived). Errors always toast, because a refresh that
 * returns `lastError` gets no toast from the page. Everywhere else (auto
 * refresh, deep links, imports still running after the user left the page)
 * the shell toasts every phase.
 */
export type ImportToastPolicy = 'toast' | 'dismiss';

export function importToastPolicy(phase: ImportProgressEvent['phase'], onSourcesRoute: boolean): ImportToastPolicy {
  if (phase === 'error') return 'toast';
  return onSourcesRoute ? 'dismiss' : 'toast';
}

function sourceName(sourceId: string): string | undefined {
  return queryClient.getQueryData<Source[]>(rpcKey('sources.list'))?.find((s) => s.id === sourceId)?.name;
}

/** Wires app events to the query cache, toasts, and navigation. Mount once. */
export function useShellEvents(): void {
  const { t } = useTranslation('shell');
  const navigate = useNavigate();
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const { pathname } = useLocation();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const offs: (() => void)[] = [];
    offs.push(bindEventInvalidation(EVENT_INVALIDATION));

    offs.push(
      onAppEvent('settings.changed', (s: Settings) => {
        queryClient.setQueryData(rpcKey('settings.get'), s);
      }),
    );

    offs.push(
      onAppEvent('import.progress', (p: ImportProgressEvent) => {
        const tr = tRef.current;
        const id = `import-${p.sourceId}`;
        const onSources = isSourcesRoute(pathRef.current);
        if (importToastPolicy(p.phase, onSources) === 'dismiss') {
          dismissToast(id);
          if (p.phase === 'done') {
            void invalidate('sources.');
            void invalidate('catalog.');
          }
          return;
        }
        const name = sourceName(p.sourceId) ?? tr('thisSource');
        if (p.phase === 'done') {
          toast({
            id,
            variant: 'success',
            title: tr('importDone', { name }),
            description: tr('importDoneDetail', { count: p.done }),
            duration: 4000,
          });
          void invalidate('sources.');
          void invalidate('catalog.');
          return;
        }
        if (p.phase === 'error') {
          toast({
            id,
            variant: 'error',
            title: tr('importFailed', { name }),
            description: p.message ?? tr('importFailedHint'),
            duration: 0,
            action: onSources ? undefined : { label: tr('openSources'), onClick: () => navRef.current('/sources') },
          });
          void invalidate('sources.');
          return;
        }
        const phaseLabel = tr(`importPhase_${p.phase}`);
        toast({
          id,
          variant: 'info',
          title: tr('importing', { name }),
          description:
            p.total && p.total > 0
              ? tr('importProgressOf', { phase: phaseLabel, done: p.done, total: p.total })
              : p.done > 0
                ? tr('importProgressCount', { phase: phaseLabel, done: p.done })
                : phaseLabel,
          progress: p.total && p.total > 0 ? { value: p.done, max: p.total } : {},
        });
      }),
    );

    offs.push(
      onAppEvent('deeplink.open', ({ urls }) => {
        for (const u of urls) {
          const path = deepLinkToPath(u);
          if (path) {
            navRef.current(path);
            break;
          }
        }
      }),
    );

    // Web mode: tell the user when the live event stream drops, once.
    if (!isDesktop) {
      let wasOpen = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      offs.push(
        onConnectionState((s) => {
          if (s === 'open') {
            if (timer) clearTimeout(timer);
            timer = null;
            if (wasOpen) dismissToast('connection');
            wasOpen = true;
            return;
          }
          if (s === 'closed' && wasOpen && !timer) {
            timer = setTimeout(() => {
              timer = null;
              toast({ id: 'connection', variant: 'error', title: tRef.current('connectionLost'), description: tRef.current('connectionLostHint'), duration: 0 });
            }, 3000);
          }
        }),
      );
      offs.push(() => timer && clearTimeout(timer));
    }

    return () => offs.forEach((f) => f());
  }, []);
}

/** Applies settings.language whenever settings load or change. */
export function useLanguageSync(language: string | undefined): void {
  useEffect(() => {
    if (language) void applyLanguage(language);
  }, [language]);
}

const LAST_ROUTE_DEBOUNCE_MS = 1200;

/** True for routes worth restoring on next start. */
export function isRestorableRoute(path: string): boolean {
  if (path === '/' || path === '') return false;
  if (/[?&]add=/.test(path)) return false;
  return path.startsWith('/');
}

/** Persists the current route as settings.lastRoute (debounced). */
export function useLastRoutePersistence(enabled: boolean, initial: string | undefined): void {
  const location = useLocation();
  const saved = useRef<string | undefined>(initial);
  useEffect(() => {
    saved.current = initial;
  }, [initial]);
  useEffect(() => {
    if (!enabled) return;
    const path = `${location.pathname}${location.search}`;
    if (!isRestorableRoute(path) || path === saved.current) return;
    const timer = setTimeout(() => {
      saved.current = path;
      rpc('settings.update', { patch: { lastRoute: path } })
        .then((s) => queryClient.setQueryData(rpcKey('settings.get'), s))
        .catch(() => {
          saved.current = undefined; // retry on the next navigation
        });
    }, LAST_ROUTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, location.pathname, location.search]);
}

export const WINDOW_SAVE_DEBOUNCE_MS = 800;

/**
 * Desktop only: mirrors the main window geometry into the core
 * (`window.setState`, C4) on move/resize, debounced.
 *
 * It never restores. `tauri-plugin-window-state` (registered in
 * iptv-tauri/src/lib.rs) already restores size, position, maximized, and
 * fullscreen before the window is shown; a second restore from the webview
 * would run after first paint and make the window jump. The core copy is a
 * mirror: it seeds the last normal (unmaximized) geometry so a window that
 * starts maximized still saves a sensible restore size, and it keeps
 * `window.getState` truthful for diagnostics and backups. Rail collapse lives
 * in localStorage and the last route in `settings.lastRoute`; the plugin
 * handles neither.
 */
export function useWindowStatePersistence(): void {
  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false;
    const offs: (() => void)[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        let lastNormal: WindowState | null = await rpc('window.getState').catch(() => null);
        if (disposed) return;

        const save = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(async () => {
            try {
              if (await win.isMinimized()) return;
              const maximized = await win.isMaximized();
              if (!maximized && !(await win.isFullscreen())) {
                const pos = await win.outerPosition();
                const size = await win.innerSize();
                lastNormal = { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized: false };
              }
              if (!lastNormal) return;
              await rpc('window.setState', { state: { ...lastNormal, maximized } });
            } catch {
              // window closing; nothing to save
            }
          }, WINDOW_SAVE_DEBOUNCE_MS);
        };
        offs.push(await win.onResized(save));
        offs.push(await win.onMoved(save));
        if (disposed) offs.forEach((f) => f());
        else save(); // record the geometry the plugin restored
      } catch {
        // Not running inside Tauri after all.
      }
    })();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      offs.forEach((f) => f());
    };
  }, []);
}
