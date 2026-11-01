// @vitest-environment node
/**
 * Bundle shape that vite.config.ts promises (L2-perf-ui-7 and the entry growth found with it).
 *
 * Rollup keeps any module whose top level calls a function it cannot prove pure, and a module kept
 * that way through a barrel (`@/ui`) is placed in the chunk of whoever imports the barrel: a
 * `const GridSlot = memo(...)` in VirtualGrid.tsx put all of VirtualGrid in the entry chunk
 * (162,736 bytes; 143,833 with memo and lazy marked pure). treeshake.manualPureFunctions names
 * React's component wrappers; every wrapper called at the top level of a source module must be
 * on it (or carry its own pure annotation).
 *
 * Tiny chunks are merged (experimentalMinChunkSize) and each language is one chunk, so a cold
 * start makes about half the JS requests and a foreign language loads in one.
 *
 * Performance audit: a production build resolves react-router's `dist/production` files
 * (BUNDLE-ROUTER), `vendor-ui` holds only what the shell needs at boot (SH-10), and the build
 * writes its asset list into the service worker (SH-11).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';

import type { Rollup } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import viteConfigFn, { VIRTUAL_LIST_BOUNDARY, virtualListBoundary, withAssetList, withLocaleMap } from '../../../vite.config';

const ROOT = join(__dirname, '..', '..', '..');
type ConfigEnv = Parameters<Extract<typeof viteConfigFn, (...args: never[]) => unknown>>[0];
const resolveConfig = (command: ConfigEnv['command']) =>
  (viteConfigFn as (env: ConfigEnv) => Record<string, unknown>)({ command, mode: command === 'build' ? 'production' : 'development' });
const viteConfig = resolveConfig('build');
const WRAPPERS = ['memo', 'lazy', 'forwardRef', 'createContext'];

interface Alias {
  find: string | RegExp;
  replacement: string;
}
const aliases = (config: Record<string, unknown>): Alias[] => ((config as { resolve?: { alias?: Alias[] } }).resolve?.alias ?? []);

interface RollupShape {
  treeshake?: { manualPureFunctions?: readonly string[] };
  output?: { experimentalMinChunkSize?: number; manualChunks?: (id: string) => string | undefined };
}
const rollup = (viteConfig as { build?: { rollupOptions?: RollupShape } }).build?.rollupOptions ?? {};
const ROUTER = (a: Alias) => a.find instanceof RegExp && a.find.test('react-router');
const pureList = (): readonly string[] => rollup.treeshake?.manualPureFunctions ?? [];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'test' ? [] : sources(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

describe('bundle shape', () => {
  it("marks React's memo and lazy pure, so a wrapped component reached through a barrel stays out of the entry", () => {
    expect(pureList()).toEqual(expect.arrayContaining(['memo', 'lazy']));
  });

  it('every component wrapper called at module top level is on the pure list', () => {
    const pure = new Set(pureList());
    const uncovered: string[] = [];
    const topLevel = new RegExp(`^(?:export )?(?:const|let) \\w+(?::[^=]+)? = (?!/\\* @__PURE__ \\*/)(${WRAPPERS.join('|')})\\(`, 'gm');
    for (const file of sources(join(ROOT, 'src'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(topLevel)) {
        if (!pure.has(m[1]!)) uncovered.push(`${file.slice(ROOT.length + 1).split(sep).join('/')}: ${m[1]}`);
      }
    }
    expect(uncovered).toEqual([]);
  });

  it('merges tiny chunks instead of a waterfall of sub-4 kB files', () => {
    expect(rollup.output?.experimentalMinChunkSize).toBeGreaterThanOrEqual(3_000);
  });

  // L3 "need XB2 vite": Rollup merges a small chunk shared by lazy pages into the always-loaded
  // entry; at 10 kB that added 19 kB of lazy-only code to it (162.0 kB against 143.0 kB at 4 kB).
  it('keeps the merge small enough that lazy-only code stays out of the entry', () => {
    expect(rollup.output?.experimentalMinChunkSize).toBeLessThanOrEqual(5_000);
  });

  it('puts each language in one chunk and keeps app modules out of the locale chunks', () => {
    const chunk = rollup.output?.manualChunks;
    expect(chunk).toBeTypeOf('function');
    expect(chunk!('C:/app/src/i18n/en/common.json')).toBe('locale-en');
    expect(chunk!('C:\\app\\src\\i18n\\de\\common.json')).toBe('locale-de');
    expect(chunk!('/app/src/i18n/de/settings.json')).toBe('locale-de');
    expect(chunk!('/app/src/i18n/zhtw/live.json')).toBe('locale-zhtw');
    // The folder's index.ts gathers its namespaces for loadLanguage and goes with them (SH-8).
    expect(chunk!('/app/src/i18n/de/index.ts')).toBe('locale-de');
    expect(chunk!('C:\\app\\src\\i18n\\ja\\index.ts')).toBe('locale-ja');
    expect(chunk!('/app/src/i18n/lazyLocales.ts')).toBeUndefined();
    expect(chunk!('/app/src/i18n/index.ts')).toBeUndefined();
    expect(chunk!('/app/src/ui/VirtualGrid.tsx')).toBeUndefined();
  });

  // P2-BOOT-2: every boot loads `locale-en`; a const per key made it 3,140 statements for V8 to
  // compile, where one string per file is only scanned.
  it('turns each locale JSON file into one JSON.parse, not a const per key', () => {
    expect((viteConfig as { json?: unknown }).json).toEqual({ namedExports: false, stringify: true });
  });

  it('builds against react-router\'s production files, not the dev build with ENABLE_DEV_WARNINGS', () => {
    const router = aliases(viteConfig).find(ROUTER);
    expect(router?.replacement.replace(/\\/g, '/')).toMatch(/node_modules\/react-router\/dist\/production\/index\.mjs$/);
    // Only the bare specifier: `react-router/dom` and the `@/` alias are left alone.
    expect((router!.find as RegExp).test('react-router/dom')).toBe(false);
    // Dev keeps the warnings.
    expect(aliases(resolveConfig('serve')).find(ROUTER)).toBeUndefined();
    expect(aliases(viteConfig).find((a) => a.find === '@')).toBeDefined();
  });

  it('keeps cmdk, its Radix dialog stack and the icons out of the boot-time vendor-ui chunk', () => {
    const chunk = rollup.output!.manualChunks!;
    expect(chunk('/app/node_modules/.pnpm/zustand@5/node_modules/zustand/esm/index.mjs')).toBe('vendor-ui');
    expect(chunk('/app/node_modules/.pnpm/cmdk@1/node_modules/cmdk/dist/index.mjs')).toBeUndefined();
    expect(chunk('/app/node_modules/.pnpm/x/node_modules/@radix-ui/react-dialog/dist/index.mjs')).toBeUndefined();
    expect(chunk('/app/node_modules/.pnpm/lucide-react@1/node_modules/lucide-react/dist/esm/icons/gift.mjs')).toBeUndefined();
    expect(chunk('/app/node_modules/.pnpm/lucide-react@1/node_modules/lucide-react/dist/esm/lucide-react.mjs')).toBeUndefined();
  });

  // An icon module counts as having a side effect, so the small-chunk merge could join a widely
  // shared icon only to app code every page of it loads, and that code came along: the
  // database-backup icon brought the virtual rows and TanStack Virtual to Settings.
  it('keeps the icons many pages share with the boot, joined to no page code', () => {
    const chunk = rollup.output!.manualChunks!;
    const icon = (name: string) => `C:\\app\\node_modules\\.pnpm\\lucide-react@1\\node_modules\\lucide-react\\dist\\esm\\icons\\${name}.mjs`;
    for (const name of ['play', 'database-backup', 'rotate-ccw', 'search-x']) expect(chunk(icon(name)), name).toBe('vendor-ui');
    expect(chunk(icon('play-circle'))).toBeUndefined();
    expect(chunk('/app/node_modules/.pnpm/lucide-react@1/node_modules/lucide-react/dist/esm/icons/play.mjs')).toBe('vendor-ui');
  });

  describe('the virtual-list boundary', () => {
    const plugin = virtualListBoundary();
    const transform = plugin.transform as (code: string, id: string) => { code: string; map: null; moduleSideEffects: boolean } | null;

    it('gives the virtualizer a side effect the merge can see, and nothing else', () => {
      expect(plugin.apply).toBe('build');
      expect((viteConfig as { plugins: { name: string }[] }).plugins.map((p) => p.name)).toContain(plugin.name);
      const out = transform('export const x = 1;', 'C:\\app\\src\\ui\\virtualizer.ts');
      expect(out?.code.startsWith('export const x = 1;\n')).toBe(true);
      expect(out?.code.trimEnd().endsWith(VIRTUAL_LIST_BOUNDARY)).toBe(true);
      // Still tree-shaken: a page that imports the `@/ui` barrel for a button does not load it.
      expect(out?.moduleSideEffects).toBe(false);
      expect(out?.map).toBeNull();
      expect(transform('export const x = 1;', '/app/src/ui/VirtualGrid.tsx')).toBeNull();
      expect(transform('export const x = 1;', '/app/src/ui/virtualizer.test.ts')).toBeNull();
    });

    it('Rollup counts the boundary statement as a side effect', async () => {
      // The Rollup that Vite builds with.
      const fromVite = createRequire(createRequire(import.meta.url).resolve('vite'));
      const { rollup: bundle } = (await import(fromVite.resolve('rollup'))) as { rollup: typeof Rollup.rollup };
      const entry = '\0entry';
      const build = await bundle({
        input: entry,
        plugins: [{ name: 'entry', resolveId: (id: string) => (id === entry ? id : null), load: (id: string) => (id === entry ? VIRTUAL_LIST_BOUNDARY : null) }],
      });
      const { output } = await build.generate({ format: 'es' });
      expect(output[0].code).toContain('WeakSet');
    });
  });

  // Every vendor chunk is preloaded by index.html on every boot and loads whole.
  it('keeps code only lazy pages use out of the boot-time vendor chunks', () => {
    const chunk = rollup.output!.manualChunks!;
    expect(chunk('/app/node_modules/.pnpm/@tanstack+query-core@5/node_modules/@tanstack/query-core/build/modern/index.js')).toBe('vendor-query');
    expect(chunk('/app/node_modules/.pnpm/@tanstack+react-query@5/node_modules/@tanstack/react-query/build/modern/index.js')).toBe('vendor-query');
    // TanStack Virtual: only the virtualized pages, all of them lazy. Its own chunk, not a
    // preloaded vendor one, and out of the small-chunk merge.
    expect(chunk('/app/node_modules/.pnpm/x/node_modules/@tanstack/react-virtual/dist/esm/index.js')).toBe('virtual');
    expect(chunk('/app/node_modules/.pnpm/x/node_modules/@tanstack/virtual-core/dist/esm/index.js')).toBe('virtual');
    // The Tauri plugins are reached only through import().
    for (const plugin of ['dialog', 'opener', 'updater']) {
      expect(chunk(`/app/node_modules/.pnpm/x/node_modules/@tauri-apps/plugin-${plugin}/dist-js/index.js`)).toBe('tauri-plugins');
    }
  });

  describe('the Tauri API', () => {
    const api = (file: string) => `C:\\app\\node_modules\\.pnpm\\@tauri-apps+api@2\\node_modules\\@tauri-apps\\api\\${file}`;
    afterEach(() => vi.unstubAllEnvs());

    it("web build: only the boot's files are in the preloaded chunk; the window API is lazy", () => {
      vi.stubEnv('TAURI_ENV_PLATFORM', '');
      const chunk = rollup.output!.manualChunks!;
      expect(chunk(api('core.js'))).toBe('vendor-tauri');
      expect(chunk(api('event.js'))).toBe('vendor-tauri');
      expect(chunk(api('external\\tslib\\tslib.es6.js'))).toBe('vendor-tauri');
      expect(chunk('/app/node_modules/@tauri-apps/api/core.js')).toBe('vendor-tauri');
      for (const file of ['window.js', 'dpi.js', 'image.js', 'webview.js']) expect(chunk(api(file)), file).toBeUndefined();
    });

    it('desktop build: the whole API, since the window API runs at every desktop boot', () => {
      vi.stubEnv('TAURI_ENV_PLATFORM', 'windows');
      const chunk = rollup.output!.manualChunks!;
      for (const file of ['core.js', 'event.js', 'window.js', 'dpi.js']) expect(chunk(api(file)), file).toBe('vendor-tauri');
      expect(chunk('/app/node_modules/.pnpm/x/node_modules/@tauri-apps/plugin-dialog/dist-js/index.js')).toBe('tauri-plugins');
    });
  });

  it("writes the build's language chunks, English left out, into theme-boot.js's placeholder", () => {
    const source = readFileSync(join(ROOT, 'public', 'theme-boot.js'), 'utf8');
    expect(source).toContain('var LOCALES = /* build:locales */ null;');
    const built = withLocaleMap(source, [
      { name: 'locale-en', fileName: 'assets/locale-en-a.js' },
      { name: 'locale-zhtw', fileName: 'assets/locale-zhtw-b.js' },
      { name: 'index', fileName: 'assets/index-c.js' },
      { name: 'locale-de', fileName: 'assets/locale-de-d.js' },
    ]);
    expect(built).toContain('var LOCALES = {"de":"/assets/locale-de-d.js","zhtw":"/assets/locale-zhtw-b.js"};');
    expect(built).not.toContain('build:locales');
  });

  it("writes the build's /assets/ URLs into the service worker's placeholder", () => {
    const source = readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8');
    expect(source).toContain('const ASSETS = /* build:assets */ null;');
    const built = withAssetList(source, ['assets/index-b.js', 'assets/a.css', 'index.html', 'assets/DashboardPage-c.js']);
    expect(built).toContain('const ASSETS = ["/assets/DashboardPage-c.js","/assets/a.css","/assets/index-b.js"];');
    expect(built).not.toContain('build:assets');
  });
});
