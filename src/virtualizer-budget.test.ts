/**
 * One virtualizer hook (SH-5). react-virtual renders every range change
 * inside the scroll event through `flushSync` unless `useFlushSync: false`.
 * `useListVirtualizer` (src/ui/virtualizer.ts) turns it off; every list and
 * grid goes through it, so no module but the wrapper may import
 * `useVirtualizer` or `useWindowVirtualizer` from `@tanstack/react-virtual`.
 * Scans every non-test `.ts` and `.tsx` file under src/.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = __dirname;
const ROOT = join(SRC, '..');
const WRAPPER = 'src/ui/virtualizer.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every import or re-export of the react-virtual hooks; `import type` is fine. */
const DIRECT = /(?:import|export)\s+(?!type\b)\{[^}]*\b(?:useVirtualizer|useWindowVirtualizer)\b[^}]*\}\s*from\s*['"]@tanstack\/react-virtual['"]/;
const NAMESPACE = /import\s+\*\s+as\s+\w+\s+from\s*['"]@tanstack\/react-virtual['"]/;

describe('virtualizer budget', () => {
  const files = walk(SRC).map((full) => ({ path: relative(ROOT, full).split(sep).join('/'), code: readFileSync(full, 'utf8') }));

  it('finds the wrapper', () => {
    const wrapper = files.find((f) => f.path === WRAPPER);
    expect(wrapper, WRAPPER).toBeDefined();
    expect(wrapper!.code).toMatch(DIRECT);
    expect(wrapper!.code).toMatch(/useFlushSync:\s*false/);
  });

  it('imports useVirtualizer only in the wrapper', () => {
    const offenders = files.filter((f) => f.path !== WRAPPER && (DIRECT.test(f.code) || NAMESPACE.test(f.code))).map((f) => f.path);
    expect(offenders, 'use useListVirtualizer from @/ui instead').toEqual([]);
  });

  it('detects a direct import', () => {
    expect(DIRECT.test("import { useVirtualizer } from '@tanstack/react-virtual';")).toBe(true);
    expect(DIRECT.test("import { type VirtualItem, useWindowVirtualizer } from '@tanstack/react-virtual';")).toBe(true);
    expect(DIRECT.test("import type { VirtualItem } from '@tanstack/react-virtual';")).toBe(false);
    expect(NAMESPACE.test("import * as rv from '@tanstack/react-virtual';")).toBe(true);
  });
});
