import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri dev on a device sets TAURI_DEV_HOST; desktop dev uses localhost.
const host = process.env['TAURI_DEV_HOST'];
// Web-mode dev: `/api` is proxied to a running iptv-server (default 7180).
const apiTarget = process.env['IPTV_API'] ?? 'http://127.0.0.1:7180';

/** node_modules package -> vendor chunk name (first match wins). */
const VENDOR_CHUNKS: ReadonlyArray<readonly [chunk: string, packages: readonly string[]]> = [
  ['vendor-react', ['react', 'react-dom', 'scheduler', 'react-router']],
  ['vendor-query', ['@tanstack/query-core', '@tanstack/react-query', '@tanstack/virtual-core', '@tanstack/react-virtual']],
  ['vendor-i18n', ['i18next', 'react-i18next']],
  [
    'vendor-ui',
    ['cmdk', 'lucide-react', 'tailwind-merge', 'clsx', 'zustand', 'aria-hidden', 'react-remove-scroll', 'react-remove-scroll-bar', 'react-style-singleton', 'use-callback-ref', 'use-sidecar', 'tslib', 'get-nonce'],
  ],
  ['vendor-tauri', ['@tauri-apps/api', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-opener', '@tauri-apps/plugin-updater']],
];

/** `src/i18n/<folder>/*.json`; group 1 is the language folder. */
const LOCALE = /[\\/]src[\\/]i18n[\\/]([^\\/]+)[\\/][^\\/]+\.json$/;

function vendorChunk(id: string): string | undefined {
  // English strings change on every copy edit; their own chunk keeps the app
  // code cache warm and loads in parallel with the entry. Every other language
  // gets one chunk too (`locale-de`): `loadLanguage` fetches all of a folder's
  // namespaces at once, and a manual chunk stays out of the
  // experimentalMinChunkSize merge, so no foreign strings end up in app chunks.
  const locale = LOCALE.exec(id);
  if (locale) return `locale-${locale[1]}`;
  const at = id.lastIndexOf('node_modules');
  if (at < 0) return undefined;
  const parts = id.slice(at + 'node_modules'.length + 1).split(/[\\/]/);
  const pkg = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  if (!pkg) return undefined;
  if (pkg.startsWith('@radix-ui/')) return 'vendor-ui';
  return VENDOR_CHUNKS.find(([, pkgs]) => pkgs.includes(pkg))?.[0];
}

/**
 * Lazy chunks are named after their first module, so a feature barrel loaded with
 * `import('@/features/player')` would also come out as `index-*.js`, next to the entry.
 * Prefix those with their folder instead (`player-index-*.js`), so `dist/assets/index-*.js` is
 * only the entry chunk that `pnpm size:check` budgets (C4, docs/architecture/performance.md).
 */
function chunkFileName(chunk: { name: string; facadeModuleId: string | null; moduleIds: readonly string[] }): string {
  if (chunk.name !== 'index') return 'assets/[name]-[hash].js';
  const id = chunk.facadeModuleId ?? chunk.moduleIds.at(-1) ?? '';
  const dir = id.split(/[\\/]/).at(-2);
  return `assets/${dir && dir !== 'src' ? dir : 'chunk'}-index-[hash].js`;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false, ws: true },
    },
    watch: { ignored: ['**/crates/**', '**/target/**', '**/.data/**', '**/.e2e-data/**'] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // React's component wrappers have no side effects, but Rollup cannot prove it, so a module
      // with a top-level `memo(...)` reached through a barrel (`@/ui`) was kept whole in the
      // importer's chunk: VirtualGrid landed in the entry. With both marked pure the entry went
      // from 162.7 kB to 143.8 kB (src/ui/test/bundlePurity.test.ts keeps this list complete).
      treeshake: { manualPureFunctions: ['memo', 'lazy'] },
      output: {
        // SC8: split the always-needed vendors out of the entry chunk so the
        // app code changes without busting the vendor cache, and the browser
        // fetches several medium files in parallel instead of one 800 kB one.
        // Player engines (hls.js, mpegts.js, shaka) are already dynamic
        // imports and keep their own lazy chunks, so they are not listed.
        manualChunks: vendorChunk,
        chunkFileNames: chunkFileName,
        // Merge app chunks under 10 kB into a neighbour (L2-perf-ui-7). Measured in
        // server mode, cold dashboard: 68 JS requests (39 under 4 kB), 1,270 kB before;
        // 33 requests (4 under 4 kB), 1,313 kB (+3 %) after; all routes in one session
        // 97 -> 49 requests; entry 139 kB -> 163 kB, 144 kB with the pure wrappers above (budget 268 kB). 12 kB gained nothing
        // more; without per-language locale chunks 10 kB cost +11 % bytes.
        experimentalMinChunkSize: 10_000,
      },
    },
  },
});
