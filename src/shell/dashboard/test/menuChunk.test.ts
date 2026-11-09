/**
 * Home's card menus load in their own chunk (`ChannelMenuBody.tsx`, through `import()` in
 * `ChannelCardMenu.tsx`). A static import of the code they draw from any other dashboard module
 * would put it back in front of Home's first render: on a cold start that was 13 more chunks and
 * about 46 kB of the 168 kB Home loaded beyond the boot chunks (`pnpm size:check`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..');

/** Modules only an open menu needs. */
const MENU_ONLY = [
  '@/features/channeledit',
  '@/features/lists/hooks/useAddToList',
  '@/features/live/components/ContextMenu',
  '@/features/multiview/addChannel',
  '@/features/multiview/useMultiviewMenuItem',
  '@/features/parental/lockMenu',
  './ChannelMenuBody',
];

/** `import … from '<spec>'` and `export … from '<spec>'`, not `import('<spec>')` or `import type`. */
function staticImports(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'"();]*?from\s*['"]([^'"]+)['"]/gm)) specs.push(m[1]!);
  for (const m of source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specs.push(m[1]!);
  return specs;
}

describe("Home's card menus", () => {
  it('finds static imports and skips dynamic and type-only ones', () => {
    const src = [
      "import { a } from '@/features/parental/lockMenu';",
      "import type { B } from '@/features/channeledit';",
      "const C = () => import('./ChannelMenuBody');",
      "export { d } from './x';",
    ].join('\n');
    expect(staticImports(src)).toEqual(['@/features/parental/lockMenu', './x']);
  });

  it('no dashboard module but the menu body statically imports what only an open menu needs', () => {
    const files = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f) && f !== 'ChannelMenuBody.tsx');
    expect(files).toContain('ChannelCardMenu.tsx');
    const offenders: string[] = [];
    for (const file of files) {
      const specs = staticImports(readFileSync(join(DIR, file), 'utf8'));
      for (const spec of specs) if (MENU_ONLY.includes(spec)) offenders.push(`${file}: ${spec}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the menu body is loaded through import()', () => {
    const host = readFileSync(join(DIR, 'ChannelCardMenu.tsx'), 'utf8');
    expect(host).toMatch(/import\(\s*['"]\.\/ChannelMenuBody['"]\s*\)/);
  });
});
