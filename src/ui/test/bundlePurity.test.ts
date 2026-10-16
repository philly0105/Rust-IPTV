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
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import viteConfig from '../../../vite.config';

const ROOT = join(__dirname, '..', '..', '..');
const WRAPPERS = ['memo', 'lazy', 'forwardRef', 'createContext'];

interface RollupShape {
  treeshake?: { manualPureFunctions?: readonly string[] };
  output?: { experimentalMinChunkSize?: number; manualChunks?: (id: string) => string | undefined };
}
const rollup = (viteConfig as { build?: { rollupOptions?: RollupShape } }).build?.rollupOptions ?? {};
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
    expect(chunk!('/app/src/i18n/lazyLocales.ts')).toBeUndefined();
    expect(chunk!('/app/src/ui/VirtualGrid.tsx')).toBeUndefined();
  });
});
