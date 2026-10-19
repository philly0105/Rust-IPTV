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
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import viteConfigFn, { withAssetList } from '../../../vite.config';

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
    expect(chunk('/app/node_modules/.pnpm/lucide-react@1/node_modules/lucide-react/dist/esm/icons/play.mjs')).toBeUndefined();
  });

  it("writes the build's /assets/ URLs into the service worker's placeholder", () => {
    const source = readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8');
    expect(source).toContain('const ASSETS = /* build:assets */ null;');
    const built = withAssetList(source, ['assets/index-b.js', 'assets/a.css', 'index.html', 'assets/DashboardPage-c.js']);
    expect(built).toContain('const ASSETS = ["/assets/DashboardPage-c.js","/assets/a.css","/assets/index-b.js"];');
    expect(built).not.toContain('build:assets');
  });
});
