/**
 * Shell-wide side effects: event-driven cache invalidation, import progress
 * toasts, settings.changed sync, deep links, lastRoute persistence, and the
 * desktop window-geometry mirror (the OS window itself is restored by
 * tauri-plugin-window-state).
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import { onAppEvent, onConnectionState } from '@/api/events';
import { bindEventInvalidation, invalidate, queryClient, rpcKey } from '@/api/query';
import { isDesktop, rpc } from '@/api/transport';
import type { ImportProgressEvent, Settings, Source, WindowState } from '@/api/types';
import { importErrorClaimed, importSummaryKey } from '@/features/sources/lib/errors';
import { applyLanguage, languageUnresolved } from '@/i18n';
import { dismissToast, toast } from '@/ui';

import { bindRailEmptySync } from './dashboard/railEmpty';

/** Query prefixes invalidated per event type. */
export const EVENT_INVALIDATION: Record<string, string[]> = {
  // watchlist.: removing a source drops its My List rows. Run 2: and its channel edits and watch log.
  'sources.changed': [
    'sources.',
    'catalog.',
    'favorites.',
    'recent.',
    'positions.',
    'xtream.',
    'stalker.',
    'watchlist.',
    'channels.',
    'stats.',
  ],
  'epg.changed': ['epg.'],
  'downloads.update': ['downloads.', 'myvideos.'],
  // account: a new subscription check; the refresh interval moves every next-refresh time.
  'account.changed': ['account.'],
  'settings.changed': ['sources.schedule'],
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

/** The first supported in-app path among `urls`, or null. */
function firstDeepLinkPath(urls: readonly string[]): string | null {
  for (const u of urls) {
    const path = deepLinkToPath(u);
    if (path) return path;
  }
  return null;
}

/** The cold-start deep link: `settled` once the pull answered; `path` until consumed. */
export interface StartupDeepLink {
  settled: boolean;
  path: string | null;
}

let startupLink: StartupDeepLink | null = null;
let startupPull: Promise<void> | null = null;

/**
 * Pulls `app.pendingDeepLinks` once per app run (desktop only; the web build
 * has no queue). A link that launched the app is queued by the Tauri shell
 * before the webview listens. The index route's StartupRedirect waits for
 * this pull and redirects straight to the link, so the link is one
 * navigation that neither a lazy route chunk nor late settings can override.
 */
export function pullStartupDeepLink(): Promise<void> {
  startupPull ??= (isDesktop ? rpc('app.pendingDeepLinks').then(firstDeepLinkPath) : Promise.resolve(null))
    .catch(() => null)
    .then((path) => {
      startupLink = { settled: true, path };
    });
  return startupPull;
}

/** Marks the startup deep link as handled so a later visit to `/` uses the normal target. */
export function consumeStartupDeepLink(): void {
  if (startupLink) startupLink = { settled: true, path: null };
}

/** Test hook: forget the pulled link so the next pull asks the core again. */
export function resetStartupDeepLinkForTests(): void {
  startupLink = null;
  startupPull = null;
}

/** The startup deep link for StartupRedirect; settled immediately on the web. */
export function useStartupDeepLink(): StartupDeepLink {
  const [link, setLink] = useState<StartupDeepLink>(() =>
    isDesktop ? (startupLink ?? { settled: false, path: null }) : { settled: true, path: null },
  );
  useEffect(() => {
    if (link.settled) return;
    let live = true;
    void pullStartupDeepLink().then(() => {
      if (live && startupLink) setLink(startupLink);
    });
    return () => {
      live = false;
    };
  }, [link.settled]);
  return link;
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
 * before the user arrived). Errors toast there too, because a refresh that
 * returns `lastError` gets no toast from the page, unless the open Add Source
 * dialog already shows that error (`importErrorClaimed`). Everywhere else (auto
 * refresh, deep links, imports still running after the user left the page)
 * the shell toasts every phase.
 */
export type ImportToastPolicy = 'toast' | 'dismiss';

export function importToastPolicy(phase: ImportProgressEvent['phase'], onSourcesRoute: boolean): ImportToastPolicy {
  if (phase === 'error') return 'toast';
  return onSourcesRoute ? 'dismiss' : 'toast';
}

/** The cached name of a source; undefined when unknown or blank (a just-added source is not cached yet). */
function sourceName(sourceId: string): string | undefined {
  const name = queryClient.getQueryData<Source[]>(rpcKey('sources.list'))?.find((s) => s.id === sourceId)?.name;
  return name?.trim() || undefined;
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
    // A dashboard rail that was empty and gains content (first favorite, a resume
    // position, a recent channel) drops its "skip the skeleton" flag right away.
    offs.push(bindRailEmptySync(queryClient));

    // englishOnly filters in the core, so catalog lists refetch when it flips.
    // Tracked here because the settings cache is already updated optimistically.
    let englishOnly = queryClient.getQueryData<Settings>(rpcKey('settings.get'))?.englishOnly;
    offs.push(
      onAppEvent('settings.changed', (s: Settings) => {
        queryClient.setQueryData(rpcKey('settings.get'), s);
        if (s.englishOnly !== englishOnly) {
          englishOnly = s.englishOnly;
          void invalidate('catalog.');
        }
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
          if (p.phase === 'cancelled') void invalidate('sources.');
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
        // Cancelled is final like done and error: replace the progress toast,
        // which has no timeout of its own, with a short notice that does.
        if (p.phase === 'cancelled') {
          void invalidate('sources.');
          toast({ id, variant: 'info', title: tr('importCancelled', { name }), duration: 4000 });
          return;
        }
        if (p.phase === 'error') {
          void invalidate('sources.');
          if (importErrorClaimed(p.sourceId)) {
            dismissToast(id);
            return;
          }
          // A translated summary; the raw core text stays on the source card as technical detail.
          toast({
            id,
            variant: 'error',
            title: tr('importFailed', { name }),
            description: p.message ? `${tr(`sources:${importSummaryKey(p.message, p.code)}`)} ${tr('importFailedHint')}` : tr('importFailedHint'),
            duration: 0,
            action: onSources ? undefined : { label: tr('openSources'), onClick: () => navRef.current('/sources') },
          });
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
        const path = firstDeepLinkPath(urls);
        if (path) navRef.current(path);
      }),
    );
    // Cold start through a link: the desktop shell queued it before this
    // listener existed; later links arrive as events. At the index route
    // StartupRedirect redirects to the pulled link itself (navigating here as
    // well would race its redirect). Elsewhere (a webview reload on another
    // page) the shell navigates.
    if (isDesktop) {
      let live = true;
      offs.push(() => {
        live = false;
      });
      void pullStartupDeepLink().then(() => {
        const path = startupLink?.path;
        if (!live || !path || pathRef.current === '/') return;
        consumeStartupDeepLink();
        navRef.current(path);
      });
    }

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

/** Longest the shell waits for the server's language before showing English anyway. */
export const LANGUAGE_HOLD_MAX_MS = 4000;

/**
 * Applies settings.language whenever settings load or change.
 *
 * Returns whether the UI language is settled. It starts false only on a fresh
 * profile (nothing remembered in localStorage), and turns true once the
 * server's language is loaded and active, once the settings fetch fails
 * (`settingsFailed`), or after LANGUAGE_HOLD_MAX_MS, so a hung request never
 * leaves the shell blank. It never goes back to false.
 */
export function useLanguageSync(language: string | undefined, settingsFailed = false): boolean {
  const [settled, setSettled] = useState(() => !languageUnresolved());

  useEffect(() => {
    if (!language) return;
    let live = true;
    void applyLanguage(language).then(() => {
      if (live) setSettled(true);
    });
    return () => {
      live = false;
    };
  }, [language]);

  useEffect(() => {
    if (settingsFailed) setSettled(true);
  }, [settingsFailed]);

  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(() => setSettled(true), LANGUAGE_HOLD_MAX_MS);
    return () => clearTimeout(timer);
  }, [settled]);

  return settled;
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
    let pending = true;
    const save = () => {
      if (!pending) return;
      pending = false;
      saved.current = path;
      rpc('settings.update', { patch: { lastRoute: path } })
        .then((s) => queryClient.setQueryData(rpcKey('settings.get'), s))
        .catch(() => {
          saved.current = undefined; // retry on the next navigation
        });
    };
    const timer = setTimeout(save, LAST_ROUTE_DEBOUNCE_MS);
    // Closing or hiding the window inside the debounce would lose the last
    // screen; save it right away instead.
    const flush = () => {
      if (document.visibilityState === 'hidden') save();
    };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', flush);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', flush);
    };
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
        // pip pulls in the player store and engines; loading it here keeps them out of the
        // main chunk (C4 entry budget). It is desktop-only, like the rest of this effect.
        const { usePipStore } = await import('@/features/player/pip');
        const win = getCurrentWindow();
        let lastNormal: WindowState | null = await rpc('window.getState').catch(() => null);
        if (disposed) return;

        // The small always-on-top PiP window is not a geometry to come back to:
        // while PiP is on nothing is recorded, so lastNormal keeps the size from
        // before PiP and a quit-in-PiP relaunches at the normal size.
        const inPip = () => usePipStore.getState().active;
        const save = () => {
          if (timer) clearTimeout(timer);
          if (inPip()) return;
          timer = setTimeout(async () => {
            try {
              if (inPip() || (await win.isMinimized())) return;
              const maximized = await win.isMaximized();
              if (!maximized && !(await win.isFullscreen())) {
                const pos = await win.outerPosition();
                const size = await win.innerSize();
                // PiP may have started while the window was being measured.
                if (inPip()) return;
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
