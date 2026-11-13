import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';

import { initI18n } from '@/i18n';
import { prefetchScreenData } from '@/api/bootPrefetch';
import { imageBaseReady } from '@/api/images';
import { queryClient, rpcKey } from '@/api/query';
import { rpcRaw } from '@/api/transport';
import { bindWindowFullscreen } from '@/api/window';
import { resolveStartup, type StartupDecision } from '@/shell/StartupRedirect';
import { captureMpegtsArchiveTrace } from '@/features/player/timeshiftDiagnostics';
import { App, appRouter, appRouterReady } from './App';
import { isKnownPath, preloadRoute } from './routes';

// U1 owns src/styles/globals.css. Loaded via glob so the build passes before it exists.
import.meta.glob('./styles/globals.css', { eager: true });
captureMpegtsArchiveTrace();

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

// What every first screen reads (the startup redirect, the rail, the dashboard), asked for now
// instead of once the shell has rendered, into the same cache entries the pages' queries use,
// so they join this request rather than send their own. No abort signal: the answer is wanted
// whichever page mounts first.
for (const cmd of ['settings.get', 'sources.list'] as const) {
  void queryClient.prefetchQuery({ queryKey: rpcKey(cmd), queryFn: () => rpcRaw(cmd) });
}
/**
 * The first render waits up to this long after the language for the startup target (BOOT-1). On
 * the web the settings come with the first requests (public/boot-rpc.js), on desktop over IPC, so
 * they are normally in before the language is. Past it, the router starts at `/` and
 * StartupRedirect goes on from there, as before.
 */
const STARTUP_WAIT_MS = 400;

/**
 * Then up to this long for the first page's code (the router's lazy route modules), so the shell
 * and the page commit together instead of the router's skeleton (`AppLoading`) first.
 */
const ROUTE_WAIT_MS = 400;

let routerStarted = false;

/**
 * Creates the router (BOOT-1), at the startup target when there is one: it goes in the address
 * bar first, replacing the `/` entry as StartupRedirect's `<Navigate replace>` did, so history
 * keeps the same entries. The router reads its first location from there and starts loading that
 * page's lazy modules at once, so the shell and the page render in one go, with no `/` index
 * render and redirect step between them. Once only.
 */
function startRouter(decision: StartupDecision | null): void {
  if (routerStarted) return;
  routerStarted = true;
  if (decision && window.location.pathname === '/') {
    decision.commit();
    window.history.replaceState(window.history.state, '', decision.path);
  }
  appRouter();
}

// A cold start at `/` opens the startup target (the saved screen, Home or Sources; on desktop a
// link that launched the app), worked out from the early settings; its first data starts then
// too (L3-ui-data-x7). A typed URL is never replaced: the router starts there now, and its first
// data from the URL.
const startup = window.location.pathname === '/' ? resolveStartup(isKnownPath) : null;
if (startup) {
  void startup.then((decision) => {
    const late = routerStarted;
    startRouter(decision);
    if (!decision) return;
    // Too late for the first render (STARTUP_WAIT_MS): StartupRedirect goes there instead, so the
    // page's chunk starts now (L3-ui-data-x5).
    if (late) preloadRoute(decision.path);
    prefetchScreenData(decision.path);
  });
} else {
  startRouter(null);
  prefetchScreenData(window.location.pathname + window.location.search);
}

/**
 * What the first render waits for, if anything: the startup target (at most STARTUP_WAIT_MS),
 * then the first page's code (at most ROUTE_WAIT_MS).
 */
function firstRenderReady(): Promise<void> | undefined {
  if (routerStarted || !startup) return appRouterReady(ROUTE_WAIT_MS);
  return new Promise<void>((resolve) => {
    let gone = false;
    const go = () => {
      if (gone) return;
      gone = true;
      startRouter(null);
      void Promise.resolve(appRouterReady(ROUTE_WAIT_MS)).then(resolve);
    };
    const timer = setTimeout(go, STARTUP_WAIT_MS);
    // After the callback above, which starts the router at the target.
    void startup.then(() => {
      clearTimeout(timer);
      go();
    });
  });
}

bindWindowFullscreen();
if (!('__TAURI_INTERNALS__' in window) && import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);

/**
 * Shows the desktop window once the first frame is committed (Rust `reveal_window`): it opens on
 * the painted shell, and the show no longer holds up the first IPC calls the render waits for.
 */
function RevealWindow() {
  useEffect(() => {
    if ('__TAURI_INTERNALS__' in window) void invoke('reveal_window').catch(() => undefined);
  }, []);
  return null;
}

// Render only once the remembered language is loaded and active, so a
// non-English user never sees an English first frame. initI18n never rejects:
// a failed locale load falls back to English. In parallel, desktop waits for
// the image cache base (at most 1.5 s, docs/architecture/performance.md), so
// the first artwork on screen already loads through the cache; on the web it
// is settled at once.
void Promise.all([initI18n(), imageBaseReady()]).then(() => {
  createRoot(root).render(
    <StrictMode>
      <App start={firstRenderReady()} />
      <RevealWindow />
    </StrictMode>,
  );
});
