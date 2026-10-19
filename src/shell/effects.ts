/**
 * Shell-wide side effects: event-driven cache invalidation, import progress
 * toasts, settings.changed sync, deep links, lastRoute persistence, and the
 * desktop window-geometry mirror (the OS window itself is restored by
 * tauri-plugin-window-state).
 */

import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import { onAppEvent, onConnectionState } from '@/api/events';
import { bindEventInvalidation, invalidate, queryClient, rpcKey } from '@/api/query';
import { isDesktop, rpc } from '@/api/transport';
import type { ImportProgressEvent, Settings, Source, SourceKind, WindowState } from '@/api/types';
import { importErrorClaimed, importSummaryKey } from '@/features/sources/lib/errors';
import { addSourcePathFromDeepLink } from '@/features/sources/lib/links';
import { applyLanguage, languageUnresolved } from '@/i18n';
// Not sources/lib/files or format: those whole modules would land in the entry chunk.
import { formatCount, formatFileSize } from '@/lib/numbers';
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
  // No epg.changed entry: the api default refetches 'epg.', and only 'epg.sources' for a
  // status-only change (a refresh starting or a 304), which an extra 'epg.' here would undo.
  // No downloads.update entry: the api default refetches only downloads.list and myvideos.;
  // a 'downloads.' prefix here refetched downloads.dir on every progress burst too.
  // account: a new subscription check.
  'account.changed': ['account.'],
};

/**
 * Maps an `iptv://` URL to an in-app path, or null when unsupported. Add links
 * (`iptv://add?url=...&kind=...`, `iptv://add/<url>`) go through the Sources
 * feature's parser, which keeps the kind and allows http(s) targets only.
 */
export function deepLinkToPath(raw: string): string | null {
  const m = /^iptv:\/*([^/?#]+)\/?(\?[^#]*)?/i.exec(raw.trim());
  if (!m) return null;
  const action = m[1]!.toLowerCase();
  const params = new URLSearchParams(m[2] ?? '');
  if (action === 'add') return addSourcePathFromDeepLink(raw.trim());
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

/** A source from the cached list; undefined when not cached yet (a just-added source). */
function cachedSource(sourceId: string): Source | undefined {
  return queryClient.getQueryData<Source[]>(rpcKey('sources.list'))?.find((s) => s.id === sourceId);
}

/** How long the shell keeps import toasts back after a hold ends: the last events can trail the RPC's reply. */
export const IMPORT_TOAST_HOLD_GRACE_MS = 1000;

let importToastHolds = 0;

/**
 * Holds back the shell's per-source import toasts (progress, ready, failed,
 * cancelled) while a surface reports the whole run itself. Settings > Backup
 * holds them for a backup import: the core imports each restored source
 * inside `backup.import`, and the section's result card and toast already
 * cover them, so a toast per source would only stack over its controls
 * (with names the cached list has not caught up with yet). Returns the
 * release; it takes effect {@link IMPORT_TOAST_HOLD_GRACE_MS} later, since
 * events travel apart from the RPC reply and the last ones can trail it.
 */
export function holdImportToasts(): () => void {
  importToastHolds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    setTimeout(() => {
      importToastHolds -= 1;
    }, IMPORT_TOAST_HOLD_GRACE_MS);
  };
}

/** The saving step an import reports (an older core sends none). */
function importSaveStep(p: ImportProgressEvent): ImportProgressEvent['step'] {
  return p.phase === 'saving' ? p.step : undefined;
}

/**
 * The toast's label for an import's phase or saving step. An unknown phase or step (a newer
 * core) reads as a translated "Saving", never as a raw key.
 */
export function importPhaseLabel(p: ImportProgressEvent, t: (key: string, opts?: Record<string, string>) => string): string {
  if (p.phase === 'connecting') return t('sources:phaseStarting');
  const step = importSaveStep(p);
  const fallback = { defaultValue: t('importPhase_saving') };
  return step ? t(`importStep_${step}`, fallback) : t(`importPhase_${p.phase}`, fallback);
}

/**
 * The progress line of a shell import toast, worded as the Sources page's
 * ImportProgressView counts: an M3U download reports bytes while it fetches,
 * shown as a size; every other count is grouped in the user's number format.
 * A source not cached yet counts as M3U when it fetches without a message
 * (Xtream and Stalker always name what they load). The two long saving steps
 * (`step`: replacing the old catalog, building the search index) show their
 * name alone: their counts said "Saving 88,000 of 88,000" for seconds on end.
 */
export function importProgressText(
  p: ImportProgressEvent,
  kind: SourceKind | undefined,
  phaseLabel: string,
  lang: string,
  t: (key: string, opts: Record<string, string>) => string,
): string {
  if (importSaveStep(p)) return phaseLabel;
  const bytes = p.phase === 'fetching' && (kind === 'm3u' || (kind === undefined && !p.message));
  const fmt = (n: number) => (bytes ? formatFileSize(n, lang) : formatCount(n, lang));
  if (p.total && p.total > 0) return t('importProgressOf', { phase: phaseLabel, done: fmt(p.done), total: fmt(p.total) });
  if (p.done > 0) return t('importProgressCount', { phase: phaseLabel, done: fmt(p.done) });
  return phaseLabel;
}

/**
 * What cached TMDB data depends on: null while TMDB is off, else the language the
 * core asks TMDB for (`tmdb.language`, falling back to the app language, as in
 * iptv-core tmdb/config.rs).
 */
export function tmdbCacheScope(s: Settings): string | null {
  return s.tmdb.enabled ? s.tmdb.language?.trim() || s.language || '' : null;
}

const isTmdbQuery = (q: { queryKey: readonly unknown[] }) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('tmdb.');

/**
 * Drops cached TMDB answers when they stop applying. A disabled query still
 * returns its cached data, so turning TMDB off removes every `tmdb.` query; a
 * new effective TMDB language (its own setting or the app language it follows)
 * resets them, so pages refetch instead of showing text in the old language.
 */
export function bindTmdbCacheSync(client: QueryClient): () => void {
  const read = () => {
    const s = client.getQueryData<Settings>(rpcKey('settings.get'));
    return s ? tmdbCacheScope(s) : undefined;
  };
  let scope = read();
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.query.queryKey[0] !== 'settings.get') return;
    const next = read();
    if (next === undefined || next === scope) return;
    const known = scope !== undefined;
    scope = next;
    if (!known) return;
    if (next === null) client.removeQueries({ predicate: isTmdbQuery });
    // The blank-key check does not depend on the language.
    else void client.resetQueries({ predicate: (q) => isTmdbQuery(q) && q.queryKey[0] !== 'tmdb.testKey' });
  });
}

/** Wires app events to the query cache, toasts, and navigation. Mount once. */
export function useShellEvents(): void {
  const { t, i18n } = useTranslation('shell');
  const langRef = useRef(i18n.language);
  langRef.current = i18n.language;
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
    offs.push(bindTmdbCacheSync(queryClient));

    // englishOnly filters in the core, so catalog lists refetch when it flips; the
    // refresh interval moves every next-refresh time on the Sources page. Both are
    // tracked here, not read from the cache: the settings cache is updated
    // optimistically, and bindEventInvalidation writes each settings.changed payload
    // into it before this handler runs.
    // Unknown until settings first load (the cache is usually still empty at mount):
    // the first value seen is the baseline, never a change, so the first settings write
    // after a cold start (lastRoute, 1.2 s in) does not refetch every catalog query.
    const cached = queryClient.getQueryData<Settings>(rpcKey('settings.get'));
    let englishOnly = cached?.englishOnly;
    let refreshHours = cached?.sourceRefreshIntervalHours;
    offs.push(
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.query.queryKey[0] !== 'settings.get') return;
        const data = event.query.state.data as Settings | undefined;
        englishOnly ??= data?.englishOnly;
        refreshHours ??= data?.sourceRefreshIntervalHours;
      }),
    );
    offs.push(
      onAppEvent('settings.changed', (s: Settings) => {
        if (refreshHours !== undefined && s.sourceRefreshIntervalHours !== refreshHours) void invalidate('sources.schedule');
        refreshHours = s.sourceRefreshIntervalHours;
        if (englishOnly === undefined) {
          englishOnly = s.englishOnly;
          return;
        }
        if (s.englishOnly !== englishOnly) {
          englishOnly = s.englishOnly;
          void invalidate('catalog.');
        }
      }),
    );

    // Sources with a sticky "didn't import" toast. It stays until the user dismisses it, a later
    // import of the same source replaces it, or the source is gone from the list (removed, or
    // removed and added again under a new id): a toast about a source that no longer exists
    // stayed on screen across every page (L3-desktop-9).
    const failedImports = new Set<string>();
    offs.push(
      queryClient.getQueryCache().subscribe((event) => {
        if (failedImports.size === 0 || event.type !== 'updated' || event.query.queryKey[0] !== 'sources.list') return;
        const list = event.query.state.data as Source[] | undefined;
        if (!Array.isArray(list)) return;
        const present = new Set(list.map((s) => s.id));
        for (const sourceId of failedImports) {
          if (present.has(sourceId)) continue;
          failedImports.delete(sourceId);
          dismissToast(`import-${sourceId}`);
        }
      }),
    );
    offs.push(
      onAppEvent('import.progress', (p: ImportProgressEvent) => {
        const tr = tRef.current;
        const id = `import-${p.sourceId}`;
        // Any newer event for the source replaces or dismisses its error toast; an error adds it back below.
        failedImports.delete(p.sourceId);
        const onSources = isSourcesRoute(pathRef.current);
        // A finished import's catalog and source queries are invalidated by bindEventInvalidation
        // (DEFAULT_EVENT_INVALIDATION in api/query.ts); doing it here too refetched them twice.
        // A backup import reports its sources itself (holdImportToasts).
        if (importToastHolds > 0 || importToastPolicy(p.phase, onSources) === 'dismiss') {
          dismissToast(id);
          if (p.phase === 'cancelled' || p.phase === 'error') void invalidate('sources.');
          return;
        }
        const source = cachedSource(p.sourceId);
        const name = source?.name.trim() || tr('thisSource');
        if (p.phase === 'done') {
          toast({
            id,
            variant: 'success',
            title: tr('importDone', { name }),
            description: tr('importDoneDetail', { count: p.done }),
            duration: 4000,
          });
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
          failedImports.add(p.sourceId);
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
        const phaseLabel = importPhaseLabel(p, tr);
        toast({
          id,
          variant: 'info',
          title: tr('importing', { name }),
          description: importProgressText(p, source?.kind, phaseLabel, langRef.current, tr),
          // A saving step is a wait with no meaningful count: the bar runs indeterminate.
          progress: p.total && p.total > 0 && !importSaveStep(p) ? { value: p.done, max: p.total } : {},
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

    // Web mode: tell the user, once per outage, when the live event stream is down for
    // 3 s: after a drop, and also when the page never connected (server down at load).
    if (!isDesktop) {
      let shown = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      offs.push(
        onConnectionState((s) => {
          if (s === 'open') {
            if (timer) clearTimeout(timer);
            timer = null;
            if (shown) dismissToast('connection');
            shown = false;
            return;
          }
          if (s === 'closed' && !shown && !timer) {
            timer = setTimeout(() => {
              timer = null;
              shown = true;
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

/** The pathname of a stored route (its query dropped). */
function routePathname(route: string | undefined): string | undefined {
  return route?.replace(/[?#].*$/, '');
}

/**
 * Persists the current route, query included, as settings.lastRoute.
 *
 * A new screen (pathname) is saved after a debounce. A query-only change on
 * the same screen (typing a search's ?q=, a filter) is not timed at all: each
 * write costs a settings.update and a core settings rebuild, so it waits for
 * the window to hide or close (a move to another screen saves that one instead).
 */
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
    const sameScreen = routePathname(saved.current) === location.pathname;
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
    const timer = sameScreen ? undefined : setTimeout(save, LAST_ROUTE_DEBOUNCE_MS);
    // Closing or hiding the window inside the debounce (or after a query-only
    // change) would lose the last screen; save it right away instead.
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
