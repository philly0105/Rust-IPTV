import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';

import { initI18n } from '@/i18n';
import { prefetchScreenData } from '@/api/bootPrefetch';
import { imageBaseReady } from '@/api/images';
import { queryClient, rpcKey } from '@/api/query';
import { rpc, rpcRaw } from '@/api/transport';
import { bindWindowFullscreen } from '@/api/window';
import { startupTarget } from '@/shell/StartupRedirect';
import { App } from './App';
import { preloadRoute } from './routes';

// U1 owns src/styles/globals.css. Loaded via glob so the build passes before it exists.
import.meta.glob('./styles/globals.css', { eager: true });

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

// What every first screen reads (the startup redirect, the rail, the dashboard), asked for now
// instead of once the shell has rendered, into the same cache entries the pages' queries use,
// so they join this request rather than send their own. No abort signal: the answer is wanted
// whichever page mounts first.
for (const cmd of ['settings.get', 'sources.list'] as const) {
  void queryClient.prefetchQuery({ queryKey: rpcKey(cmd), queryFn: () => rpcRaw(cmd) });
}
// `/` redirects to the saved screen only after the first render; its page chunk starts as soon as
// settings arrive instead (L3-ui-data-x5), and so does that page's first data (L3-ui-data-x7). A
// deep link's chunks start with the router; its first data starts here, from the URL.
if (window.location.pathname === '/') {
  void queryClient
    .ensureQueryData({ queryKey: rpcKey('settings.get'), queryFn: () => rpc('settings.get') })
    .then((settings) => {
      const target = startupTarget(settings);
      preloadRoute(target);
      prefetchScreenData(target);
    }, () => undefined);
} else {
  prefetchScreenData(window.location.pathname + window.location.search);
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
      <App />
      <RevealWindow />
    </StrictMode>,
  );
});
