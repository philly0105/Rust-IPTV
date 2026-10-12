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

function vendorChunk(id: string): string | undefined {
  const at = id.lastIndexOf('node_modules');
  if (at < 0) return undefined;
  const parts = id.slice(at + 'node_modules'.length + 1).split(/[\\/]/);
  const pkg = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  if (!pkg) return undefined;
  if (pkg.startsWith('@radix-ui/')) return 'vendor-ui';
  return VENDOR_CHUNKS.find(([, pkgs]) => pkgs.includes(pkg))?.[0];
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
      output: {
        // SC8: split the always-needed vendors out of the entry chunk so the
        // app code changes without busting the vendor cache, and the browser
        // fetches several medium files in parallel instead of one 800 kB one.
        // Player engines (hls.js, mpegts.js, shaka) are already dynamic
        // imports and keep their own lazy chunks, so they are not listed.
        manualChunks: vendorChunk,
      },
    },
  },
});
