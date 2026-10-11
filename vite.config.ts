import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri dev on a device sets TAURI_DEV_HOST; desktop dev uses localhost.
const host = process.env['TAURI_DEV_HOST'];
// Web-mode dev: `/api` is proxied to a running iptv-server (default 7180).
const apiTarget = process.env['IPTV_API'] ?? 'http://127.0.0.1:7180';

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
  },
});
