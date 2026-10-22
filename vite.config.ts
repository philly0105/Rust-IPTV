import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlib, gzip } from 'node:zlib';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Tauri dev on a device sets TAURI_DEV_HOST; desktop dev uses localhost.
const host = process.env['TAURI_DEV_HOST'];
// Web-mode dev: `/api` is proxied to a running iptv-server (default 7180).
const apiTarget = process.env['IPTV_API'] ?? 'http://127.0.0.1:7180';
// WebKit keeps Vite's optimized dependencies across desktop dev relaunches. Change the
// optimization cache key whenever our committed mpegts patch changes, so the player cannot
// silently run an older bundle after node_modules has been updated.
const mpegtsPatchHash = createHash('sha256')
  .update(readFileSync(fileURLToPath(new URL('./patches/mpegts.js@1.8.2.patch', import.meta.url))))
  .digest('hex');

/** node_modules package -> vendor chunk name (first match wins). */
const VENDOR_CHUNKS: ReadonlyArray<readonly [chunk: string, packages: readonly string[]]> = [
  ['vendor-react', ['react', 'react-dom', 'scheduler', 'react-router']],
  ['vendor-query', ['@tanstack/query-core', '@tanstack/react-query', '@tanstack/virtual-core', '@tanstack/react-virtual']],
  ['vendor-i18n', ['i18next', 'react-i18next']],
  // cmdk, its Radix dialog stack and lucide-react are left out (performance audit SH-10): cmdk is
  // used only by the lazy command palette and most icons only by lazy pages, so Rollup places them
  // with their users instead of in a chunk that index.html preloads on every boot.
  ['vendor-ui', ['tailwind-merge', 'clsx', 'zustand']],
  ['vendor-tauri', ['@tauri-apps/api', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-opener', '@tauri-apps/plugin-updater']],
];

/**
 * `src/i18n/<folder>/*.json` and the folder's `index.ts`, which gathers them for `loadLanguage`;
 * group 1 is the language folder.
 */
const LOCALE = /[\\/]src[\\/]i18n[\\/]([^\\/]+)[\\/](?:[^\\/]+\.json|index\.ts)$/;

/**
 * `src/lib/duration.ts` gets a chunk of its own, out of the experimentalMinChunkSize merge. It is
 * 1.4 kB shared by the VOD and library formatters and the player's subtitle loader, and the merge
 * put it in the subtitle chunk, whose imports reach the player's controls and zap banner. Settings
 * then waited for the player's controls before its first render: its trash icon sat in the chunk
 * of `features/library/lib/format.ts`, which imports `formatDurationParts` (pnpm size:check).
 */
const OWN_CHUNK = /[\\/]src[\\/]lib[\\/]duration\.ts$/;

function vendorChunk(id: string): string | undefined {
  // English strings change on every copy edit; their own chunk keeps the app
  // code cache warm and loads in parallel with the entry. Every other language
  // gets one chunk too (`locale-de`): `loadLanguage` fetches all of a folder's
  // namespaces at once, and a manual chunk stays out of the
  // experimentalMinChunkSize merge, so no foreign strings end up in app chunks.
  const locale = LOCALE.exec(id);
  if (locale) return `locale-${locale[1]}`;
  if (OWN_CHUNK.test(id)) return 'duration';
  const at = id.lastIndexOf('node_modules');
  if (at < 0) return undefined;
  const parts = id.slice(at + 'node_modules'.length + 1).split(/[\\/]/);
  const pkg = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  if (!pkg) return undefined;
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

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);
/** Text assets worth compressing; the small ones cost more in headers than they save. */
const COMPRESSIBLE = /\.(?:js|css|html|svg|json|webmanifest|txt|xml)$/;
const COMPRESS_MIN_BYTES = 1024;

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])));
  return nested.flat();
}

/**
 * Server mode (L3-serve-ui-3): writes `.br` (quality 11) and `.gz` (level 9) next to every text
 * asset of a web build. The server's file service sends them instead of compressing each response
 * itself, which saved about 25 ms of CPU per cold UI load on loopback, and quality 11 is about 25 %
 * smaller than the on-the-fly level. A desktop build (`TAURI_ENV_PLATFORM`, set by `tauri build`)
 * skips it: Tauri embeds the dist folder and compresses it itself.
 */
function precompress(): Plugin {
  let outDir = 'dist';
  return {
    name: 'tsrust-precompress',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      if (process.env['TAURI_ENV_PLATFORM']) return;
      const files = (await filesUnder(outDir)).filter((f) => COMPRESSIBLE.test(f));
      await Promise.all(
        files.map(async (file) => {
          const data = await readFile(file);
          if (data.length < COMPRESS_MIN_BYTES) return;
          const [br, gzipped] = await Promise.all([
            brotli(data, {
              params: {
                [zlib.BROTLI_PARAM_QUALITY]: 11,
                [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
                [zlib.BROTLI_PARAM_SIZE_HINT]: data.length,
              },
            }),
            gz(data, { level: 9 }),
          ]);
          await Promise.all([writeFile(`${file}.br`, br), writeFile(`${file}.gz`, gzipped)]);
        }),
      );
    },
  };
}

/**
 * react-router 7.18's exports map has no `production` condition, so every build resolved
 * `dist/development`, which ships with `ENABLE_DEV_WARNINGS = true` (performance audit
 * BUNDLE-ROUTER). A production build points the bare specifier at `dist/production`; dev keeps the
 * warnings, and vitest (vitest.config.ts) and the typecheck resolve the package normally.
 */
const ROUTER_PRODUCTION = fileURLToPath(new URL('./node_modules/react-router/dist/production/index.mjs', import.meta.url));

/** The placeholder in `public/sw.js` that a build replaces with its asset list. */
const SW_ASSETS = '/* build:assets */ null';

/** `public/sw.js` with this build's `/assets/*` URLs in place of its placeholder (sorted). */
export function withAssetList(source: string, fileNames: readonly string[]): string {
  const assets = fileNames
    .filter((f) => f.startsWith('assets/'))
    .map((f) => `/${f}`)
    .sort();
  return source.replace(SW_ASSETS, JSON.stringify(assets));
}

/**
 * Web build (performance audit SH-11): writes the build's asset list into `dist/sw.js`. The file
 * then differs per build, so the browser installs the new worker, and its activate handler deletes
 * cached assets from earlier builds instead of keeping every deploy's chunks. Runs in writeBundle,
 * after Vite copied `public/` and before `precompress` compresses the result.
 */
function serviceWorkerAssets(): Plugin {
  let outDir = 'dist';
  return {
    name: 'tsrust-sw-assets',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async writeBundle(_options, bundle) {
      const file = join(outDir, 'sw.js');
      let source: string;
      try {
        source = await readFile(file, 'utf8');
      } catch {
        return;
      }
      if (!source.includes(SW_ASSETS)) this.error(`${file} has no ${SW_ASSETS} placeholder for the asset list.`);
      await writeFile(file, withAssetList(source, Object.keys(bundle)));
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), serviceWorkerAssets(), precompress()],
  optimizeDeps: {
    esbuildOptions: { banner: { js: `/* mpegts patch ${mpegtsPatchHash} */` } },
  },
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      ...(command === 'build' ? [{ find: /^react-router$/, replacement: ROUTER_PRODUCTION }] : []),
    ],
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // P2-BOOT-2: each JSON module (the locale strings; nothing else in the app is JSON) becomes one
  // `JSON.parse("…")`. Vite's default gave every key its own `export const` and every file an
  // object literal over them, so `locale-en`, which every boot loads before the first render, was
  // 3,140 statements for V8 to compile: 217,950 bytes and 18.8 ms to load in a fresh Node 24,
  // against 150,775 bytes and 6.6 ms now. Every import of the strings takes the default export
  // (`src/i18n/index.ts`, the `locale-<lang>` index files).
  json: { namedExports: false, stringify: true },
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
        // Merge app chunks under 4 kB into a neighbour (L2-perf-ui-7: 68 JS requests on a cold
        // dashboard, 39 of them under 4 kB). Rollup merges a small chunk shared by several lazy
        // pages into the entry, because the entry is always loaded: at 10 kB that put 40 kB of
        // lazy-only code (subtitle style fields, Tabs, VirtualRows, the file pickers) in the
        // entry. Measured on the loop 3 tree (L3 "need XB2 vite"): entry 162.0 kB at 10 kB,
        // 143.0 kB at 4 kB, 141.0 kB with no merging; 84 / 117 / 160 JS chunks (1 / 22 / 75
        // under 4 kB); every route visited in one session 59 / 88 requests; cold first paint on
        // loopback the same within noise. Without per-language locale chunks merging cost +11 %
        // bytes.
        experimentalMinChunkSize: 4_000,
      },
    },
  },
}));
