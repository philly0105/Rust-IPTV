// @vitest-environment node
/**
 * What a page's static imports reach in the source. A lazy route renders only once its static
 * imports have run, so whatever they reach is fetched, compiled and run before its first render;
 * `pnpm size:check` measures the same thing in the built chunks, and this checks the cause without
 * a build.
 *
 * Pages that draw the stage import the `@/features/player` barrel for the stage and the store. The
 * dock and the controls come from the shell (`@/features/player/dock`) after the first route, so
 * the barrel must not export anything that reaches them: when it exported PlayerDock, Live and the
 * guide waited for the controls chunk (77 kB) before their first render. The VOD pages label
 * titles with the player's resume rules without loading its store, the media store keeps its track
 * lists without the engines, and the shell reads the PiP flag without loading pip.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SRC = join(ROOT, 'src');

/**
 * Static `import ... from` / `export ... from` and bare `import '...'` statements. `import type`
 * and `export type` are erased; `import { type X }` is kept, since verbatimModuleSyntax leaves
 * such an import in the output. `import()` is not matched: it loads later, on demand.
 */
const STATIC_IMPORT = /^[ \t]*(?:import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/gm;

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  for (const file of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

const importsOf = new Map<string, string[]>();
function staticImports(file: string): string[] {
  let out = importsOf.get(file);
  if (!out) {
    out = [];
    if (/\.tsx?$/.test(file)) {
      for (const m of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
        const target = m[1] ? null : resolveImport(file, m[2]!);
        if (target) out.push(target);
      }
    }
    importsOf.set(file, out);
  }
  return out;
}

const rel = (file: string) => relative(ROOT, file).split(sep).join('/');

/** The chain of static imports from `from` to `to`, or null when `to` is out of reach. */
function importChain(from: string, to: string): string[] | null {
  const start = join(ROOT, from);
  const goal = join(ROOT, to);
  const previous = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (file === goal) {
      const chain: string[] = [];
      for (let at: string | null | undefined = file; at; at = previous.get(at)) chain.unshift(rel(at));
      return chain;
    }
    for (const next of staticImports(file)) {
      if (!previous.has(next)) {
        previous.set(next, file);
        queue.push(next);
      }
    }
  }
  return null;
}

/** Every `page -> module` pair where the page reaches the module, with the chain that does it. */
function reached(pages: readonly string[], modules: readonly string[]): string[] {
  const found: string[] = [];
  for (const page of pages) {
    expect(existsSync(join(ROOT, page)), page).toBe(true);
    for (const module of modules) {
      expect(existsSync(join(ROOT, module)), module).toBe(true);
      const chain = importChain(page, module);
      if (chain) found.push(chain.join(' > '));
    }
  }
  return found;
}

const CONTROLS = 'src/features/player/components/Controls.tsx';
const DOCK = 'src/features/player/components/PlayerDock.tsx';
const STORE = 'src/features/player/store.ts';
const ENGINES = 'src/features/player/engines.ts';
const PIP = 'src/features/player/pip.ts';
const CARDS = 'src/shell/dashboard/cards.tsx';

const LIVE = 'src/features/live/components/LivePage.tsx';
const GUIDE = 'src/features/live/components/EpgGridPage.tsx';
/** Pages that draw the stage, or play from a row, with the barrel's stage and store. */
const STAGE_PAGES = [
  LIVE,
  GUIDE,
  'src/features/live/components/ArchivePage.tsx',
  'src/features/multiview/components/MultiviewPage.tsx',
  'src/features/lists/pages/ListPage.tsx',
  'src/features/vod/pages/MovieDetailPage.tsx',
  'src/features/vod/pages/SeriesDetailPage.tsx',
  'src/features/library/pages/FavoritesPage.tsx',
  'src/features/library/pages/RecentPage.tsx',
  'src/features/library/pages/DownloadsPage.tsx',
  'src/features/library/pages/ScheduledPage.tsx',
  'src/features/library/pages/MyVideosPage.tsx',
  'src/features/library/pages/MyVideoDetailPage.tsx',
];
/** VOD pages that only label titles and play behind import(). */
const VOD_PAGES = [
  'src/features/vod/pages/SearchPage.tsx',
  'src/features/vod/pages/CategoryGridPage.tsx',
  'src/features/vod/pages/VodLandingPage.tsx',
  'src/features/vod/pages/ActorPage.tsx',
];

describe('what a page reaches before its first render', () => {
  it('the pages that draw the stage reach neither the dock nor the controls', () => {
    expect(reached(STAGE_PAGES, [DOCK, CONTROLS])).toEqual([]);
  });

  it("Live and the guide reach neither Home's cards (joinList is in @/lib/intl) nor the engines", () => {
    expect(reached([LIVE, GUIDE], [CARDS, ENGINES])).toEqual([]);
  });

  it('the VOD browsing pages reach neither the player store nor the engines', () => {
    expect(reached(VOD_PAGES, [STORE, ENGINES])).toEqual([]);
  });

  it('the player store keeps its track lists without the engines', () => {
    expect(reached([STORE, 'src/features/player/media.ts'], [ENGINES])).toEqual([]);
  });

  it("the shell's first render (window-state effect included) loads neither pip nor the player store", () => {
    expect(reached(['src/main.tsx', 'src/shell/ShellLayout.tsx', 'src/shell/effects.ts'], [PIP, STORE, DOCK])).toEqual([]);
  });

  it('the walk follows the imports that do exist', () => {
    // A guard that never finds anything proves nothing: these chains are expected.
    expect(importChain(LIVE, STORE)).not.toBeNull();
    expect(importChain('src/features/player/dock.ts', CONTROLS)).not.toBeNull();
    expect(importChain('src/shell/dashboard/DashboardPage.tsx', CARDS)).not.toBeNull();
  });

  it('the shell loads the dock from its own module, and the barrel does not export it', () => {
    const barrel = readFileSync(join(SRC, 'features/player/index.ts'), 'utf8');
    for (const name of ['PlayerDock', 'ExternalPlaybackFooter', 'RadioPlayer']) expect(barrel).not.toMatch(new RegExp(`\\b${name}\\b`));
    const shell = readFileSync(join(SRC, 'shell/ShellLayout.tsx'), 'utf8');
    expect(shell).toContain("import('@/features/player/dock')");
    expect(shell).not.toContain("import('@/features/player')");
  });

  it("the stage brings the player's stylesheet, so its light-theme accent is there before the dock", () => {
    expect(readFileSync(join(SRC, 'features/player/components/PlayerStage.tsx'), 'utf8')).toMatch(/^import '\.\.\/player\.css';$/m);
  });
});
