import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { initI18n } from '@/i18n';
import { imageBaseReady } from '@/api/images';
import { queryClient, rpcKey } from '@/api/query';
import { rpcRaw } from '@/api/transport';
import { bindWindowFullscreen } from '@/api/window';
import { App } from './App';

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

bindWindowFullscreen();
if (!('__TAURI_INTERNALS__' in window) && import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);

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
    </StrictMode>,
  );
});
