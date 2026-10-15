/**
 * Cheaper blur (Run 3 contract C5). Scans every non-test `.tsx`, `.ts` and
 * `.css` file under src/ for the rules below; comments are ignored.
 *
 * - poster-opacity-only: Poster's reveal animates opacity only. A blur or
 *   scale transition costs a filter pass per grid card per frame.
 * - blur-max: no filter blur over 12px (`blur-lg` and up, `blur-[13px]`,
 *   `blur(1rem)`, a `--blur-*` token over 12px). A soft background is a
 *   quarter-size copy scaled up 4x under at most 12px (`QUARTER_BLUR` in
 *   src/ui/image.ts), or a gradient.
 * - backdrop-outside-glass-blur: a backdrop filter only through the
 *   `.glass-blur` utility (src/styles/globals.css). No `backdrop-blur-*`
 *   class, no `backdropFilter` style, no `backdrop-filter` declaration
 *   anywhere else (`backdrop-filter: none` is fine).
 * - blur-glass-max: `--blur-glass` at most 10px, fallbacks included.
 * - chrome-opaque: the always-visible Header and Rail never blur; Header
 *   sits on `bg-bg/95`.
 * - glass-utilities: `.glass` has no blur, and `.glass-blur` turns into the
 *   strong glass with no blur under `prefers-reduced-transparency: reduce`.
 *
 * ALLOWLIST: one entry per file and rule. `pending` names the builder who
 * owns the file and is converting it; pending entries may go stale (the
 * owner fixed it) without failing, every other entry must still match, so a
 * fixed file drops off the list.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { Poster } from '@/ui/Poster';
import { QUARTER_BLUR } from '@/ui/image';

type Rule = 'poster-opacity-only' | 'blur-max' | 'backdrop-outside-glass-blur' | 'blur-glass-max' | 'chrome-opaque' | 'glass-utilities';

interface Allowed {
  /** Path from the repo root, forward slashes. */
  file: string;
  rule: Rule;
  reason: string;
  /** The builder converting the file in this run; the entry may already be stale. */
  pending?: string;
}

const ALLOWLIST: readonly Allowed[] = [];

const SRC = __dirname;
const ROOT = join(SRC, '..');

interface SourceFile {
  /** Repo-relative, forward slashes. */
  path: string;
  kind: 'css' | 'ts';
  /** Contents with comments blanked out (same length, newlines kept, so offsets map to lines). */
  code: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(tsx|ts|css)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const blank = (m: string) => m.replace(/[^\n]/g, ' ');

/** Blanks block comments, and for TS line comments (not the `//` of `http://` or inside a quote). */
function stripComments(text: string, kind: 'css' | 'ts'): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (kind === 'ts') out = out.replace(/(^|[^:\\'"`/])(\/\/[^\n]*)/gm, (_m, pre: string, c: string) => pre + blank(c));
  return out;
}

const FILES: SourceFile[] = walk(SRC).map((full) => {
  const kind = full.endsWith('.css') ? 'css' : 'ts';
  return { path: relative(ROOT, full).split(sep).join('/'), kind, code: stripComments(readFileSync(full, 'utf8'), kind) };
});

const file = (path: string): SourceFile => {
  const f = FILES.find((x) => x.path === path);
  if (!f) throw new Error(`${path} not found`);
  return f;
};

interface Violation {
  file: string;
  rule: Rule;
  line: number;
  text: string;
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split('\n').length;
}

function violation(f: SourceFile, rule: Rule, index: number, text: string): Violation {
  return { file: f.path, rule, line: lineOf(f.code, index), text: text.trim().slice(0, 120) };
}

/** A CSS length in px (`rem`/`em` at 16px); NaN when it is not a plain length. */
function toPx(value: string): number {
  const m = /^\s*(-?[\d.]+)\s*(px|rem|em)?\s*$/.exec(value);
  if (!m) return Number.NaN;
  const n = Number(m[1]);
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : n;
}

const BLUR_MAX_PX = 12;
const GLASS_MAX_PX = 10;
/** Tailwind 4's stock blur scale, in px. */
const STOCK_BLUR: Record<string, number> = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, '2xl': 40, '3xl': 64 };

/** The value inside `var(--name, fallback)`, or null when there is no fallback. */
function varFallback(value: string): { name: string; fallback: string | null } | null {
  const m = /^\s*var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)\s*$/.exec(value);
  return m ? { name: m[1]!, fallback: m[2]?.trim() ?? null } : null;
}

/** Theme tokens `--blur-<name>: <len>` from every CSS file (later wins). */
function blurTokens(): Map<string, number> {
  const tokens = new Map<string, number>();
  for (const f of FILES.filter((x) => x.kind === 'css')) {
    for (const m of f.code.matchAll(/--blur-([\w-]+)\s*:\s*([^;}\n]+)/g)) tokens.set(m[1]!, toPx(m[2]!));
  }
  return tokens;
}

/** A blur amount as written in a class or a `blur()`: px when known, else null (cannot tell). */
function blurPx(value: string, tokens: Map<string, number>): number | null {
  const v = varFallback(value);
  if (v) {
    if (v.name === '--blur-glass') return tokens.get('glass') ?? null;
    return v.fallback !== null ? toPx(v.fallback) : null;
  }
  const px = toPx(value);
  return Number.isNaN(px) ? null : px;
}

function blurMaxViolations(): Violation[] {
  const tokens = blurTokens();
  const out: Violation[] = [];
  for (const f of FILES) {
    // Named classes: blur-lg and up (stock scale), or a custom token over the cap. `backdrop-blur-*` is its own rule.
    for (const m of f.code.matchAll(/(?<![\w-])blur-([a-z0-9]+)(?![\w-]|\/|\[)/g)) {
      const name = m[1]!;
      const px = tokens.get(name) ?? STOCK_BLUR[name];
      if (px !== undefined && px > BLUR_MAX_PX) out.push(violation(f, 'blur-max', m.index, m[0]));
    }
    // Arbitrary classes: blur-[20px], blur-[var(--x,20px)], blur-(--x).
    for (const m of f.code.matchAll(/(?<![\w-])blur-\[([^\]\s]+)\]|(?<![\w-])blur-\((--[\w-]+)\)/g)) {
      const value = (m[1] ?? `var(${m[2]})`).replace(/_/g, ' ');
      const px = blurPx(value, tokens);
      if (px === null || px > BLUR_MAX_PX) out.push(violation(f, 'blur-max', m.index, m[0]));
    }
    // blur() in CSS, inline styles and [filter:...] classes; backdrop-filter's own blur is checked by the glass rules.
    for (const m of f.code.matchAll(/(backdrop-filter\s*:\s*|backdropFilter\s*:\s*['"`]|supports-\[backdrop-filter:)?(?<![\w.$])blur\(\s*((?:var\([^)]*\)|[^)])*)\)/g)) {
      // m[1]: a backdrop filter or a supports query; an empty value: a call such as `blur()`.
      if (m[1] || !m[2]!.trim()) continue;
      const px = blurPx(m[2]!.replace(/_/g, ' '), tokens);
      if (px === null || px > BLUR_MAX_PX) out.push(violation(f, 'blur-max', m.index, m[0]));
    }
    if (f.kind === 'css') {
      for (const m of f.code.matchAll(/--blur-([\w-]+)\s*:\s*([^;}\n]+)/g)) {
        const px = toPx(m[2]!);
        if (!(px <= BLUR_MAX_PX)) out.push(violation(f, 'blur-max', m.index, m[0]));
      }
    }
  }
  return out;
}

/** The text of `@utility <name> { ... }` (braces matched), or null. */
function utilityBlock(code: string, name: string): { start: number; end: number; body: string } | null {
  const m = new RegExp(`@utility\\s+${name}\\s*\\{`).exec(code);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return { start: m.index, end: i + 1, body: code.slice(m.index, i + 1) };
  }
  return null;
}

function backdropViolations(): Violation[] {
  const out: Violation[] = [];
  for (const f of FILES) {
    if (f.kind === 'ts') {
      for (const m of f.code.matchAll(/(?<![\w-])backdrop-blur(?:-[^\s'"`]*)?|\b(?:Webkit)?[Bb]ackdropFilter\b|(?<!supports-)\[(?:-webkit-)?backdrop-filter:[^\]]*\]/g)) {
        out.push(violation(f, 'backdrop-outside-glass-blur', m.index, m[0]));
      }
      continue;
    }
    const block = utilityBlock(f.code, 'glass-blur');
    for (const m of f.code.matchAll(/(?<=[;{\s])(?:-webkit-)?backdrop-filter\s*:\s*([^;}]+)/g)) {
      if (block && m.index >= block.start && m.index < block.end) continue;
      if (/^none\b/.test(m[1]!.trim())) continue;
      out.push(violation(f, 'backdrop-outside-glass-blur', m.index, m[0]));
    }
    // @apply of a backdrop blur class from CSS.
    for (const m of f.code.matchAll(/@apply[^;]*\bbackdrop-blur[^;]*/g)) out.push(violation(f, 'backdrop-outside-glass-blur', m.index, m[0]));
  }
  return out;
}

function glassMaxViolations(): Violation[] {
  const out: Violation[] = [];
  for (const f of FILES) {
    for (const m of f.code.matchAll(/--blur-glass\s*:\s*([^;}\n]+)/g)) {
      if (!(toPx(m[1]!) <= GLASS_MAX_PX)) out.push(violation(f, 'blur-glass-max', m.index, m[0]));
    }
    for (const m of f.code.matchAll(/var\(\s*--blur-glass\s*,\s*([^)]*)\)/g)) {
      if (!(toPx(m[1]!.replace(/_/g, ' ')) <= GLASS_MAX_PX)) out.push(violation(f, 'blur-glass-max', m.index, m[0]));
    }
  }
  return out;
}

function chromeViolations(): Violation[] {
  const out: Violation[] = [];
  for (const path of ['src/shell/Header.tsx', 'src/shell/Rail.tsx']) {
    const f = file(path);
    for (const m of f.code.matchAll(/(?<![\w-])glass-blur\b|backdrop-blur|backdropFilter/g)) out.push(violation(f, 'chrome-opaque', m.index, m[0]));
  }
  const header = file('src/shell/Header.tsx');
  if (!/(?<![\w-])bg-bg\/95(?![\w/])/.test(header.code)) out.push({ file: header.path, rule: 'chrome-opaque', line: 0, text: 'Header has no bg-bg/95 surface' });
  return out;
}

function glassUtilityViolations(): Violation[] {
  const out: Violation[] = [];
  const globals = file('src/styles/globals.css');
  const glass = utilityBlock(globals.code, 'glass');
  if (!glass) out.push({ file: globals.path, rule: 'glass-utilities', line: 0, text: '@utility glass is missing' });
  else if (/blur|backdrop-filter/.test(glass.body)) out.push(violation(globals, 'glass-utilities', glass.start, '@utility glass blurs'));
  const blurU = utilityBlock(globals.code, 'glass-blur');
  if (!blurU) {
    out.push({ file: globals.path, rule: 'glass-utilities', line: 0, text: '@utility glass-blur is missing' });
    return out;
  }
  const body = blurU.body.replace(/\s+/g, ' ');
  if (!/backdrop-filter: blur\(var\(--blur-glass\)\)/.test(body)) out.push(violation(globals, 'glass-utilities', blurU.start, 'glass-blur does not use blur(var(--blur-glass))'));
  const reduced = /@media \(prefers-reduced-transparency: reduce\) \{([^}]*)\}/.exec(body)?.[1] ?? '';
  if (!/background-color: var\(--color-glass-strong\)/.test(reduced) || !/backdrop-filter: none/.test(reduced)) {
    out.push(violation(globals, 'glass-utilities', blurU.start, 'glass-blur keeps its blur under prefers-reduced-transparency'));
  }
  return out;
}

const allowed = (v: Violation) => ALLOWLIST.some((a) => a.file === v.file && a.rule === v.rule);
const show = (vs: Violation[]) => vs.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`);

afterEach(cleanup);

describe('C5 cheaper blur', () => {
  it('scans the source tree', () => {
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES.some((f) => f.path === 'src/styles/globals.css')).toBe(true);
    expect(FILES.some((f) => f.path.includes('/test/') || /\.test\.tsx?$/.test(f.path))).toBe(false);
  });

  it('Poster reveals with opacity only (source)', () => {
    const poster = file('src/ui/Poster.tsx').code;
    expect(poster).toContain('motion-safe:transition-opacity');
    expect(poster).not.toMatch(/(?<![\w-])(?:blur|scale-|transition-(?!opacity)|transition(?=['"\s]))|transform/);
  });

  it('Poster reveals with opacity only (rendered)', () => {
    const { container } = render(createElement(Poster, { src: 'http://cdn.example/p.jpg', alt: 'P' }));
    const img = container.querySelector('img')!;
    fireEvent.load(img);
    const classes = img.className.split(/\s+/);
    expect(classes).toContain('opacity-100');
    expect(classes.filter((c) => /transition|blur|scale|transform|duration|ease/.test(c))).toEqual([
      'motion-safe:transition-opacity',
      'motion-safe:duration-300',
      'motion-safe:ease-out',
    ]);
  });

  it('QUARTER_BLUR is a quarter-size copy scaled up under at most 12px', () => {
    const classes = QUARTER_BLUR.split(' ');
    expect(classes).toEqual(expect.arrayContaining(['h-1/4', 'w-1/4', 'max-w-none']));
    const scale = Number(/^scale-\[([\d.]+)\]$/.exec(classes.find((c) => c.startsWith('scale-')) ?? '')?.[1]);
    expect(scale).toBeGreaterThanOrEqual(4);
    const blur = classes.find((c) => c.startsWith('blur-'))!;
    expect(STOCK_BLUR[blur.slice('blur-'.length)]).toBeLessThanOrEqual(BLUR_MAX_PX);
  });

  it('no filter blur over 12px', () => {
    expect(show(blurMaxViolations().filter((v) => !allowed(v)))).toEqual([]);
  });

  it('backdrop-filter only through .glass-blur', () => {
    expect(show(backdropViolations().filter((v) => !allowed(v)))).toEqual([]);
  });

  it('--blur-glass is at most 10px', () => {
    const tokens = blurTokens();
    expect(tokens.get('glass')).toBeLessThanOrEqual(GLASS_MAX_PX);
    expect(show(glassMaxViolations().filter((v) => !allowed(v)))).toEqual([]);
  });

  it('Header and Rail never blur; Header is opaque', () => {
    expect(show(chromeViolations().filter((v) => !allowed(v)))).toEqual([]);
  });

  it('.glass has no blur and .glass-blur drops it for reduced transparency', () => {
    expect(show(glassUtilityViolations().filter((v) => !allowed(v)))).toEqual([]);
  });

  it('every allowlist entry names a real file and still matches, unless its owner is converting it', () => {
    const all = [...blurMaxViolations(), ...backdropViolations(), ...glassMaxViolations(), ...chromeViolations(), ...glassUtilityViolations()];
    for (const a of ALLOWLIST) {
      expect(FILES.some((f) => f.path === a.file), a.file).toBe(true);
      expect(a.reason.length, `${a.file} needs a reason`).toBeGreaterThan(0);
    }
    const stale = ALLOWLIST.filter((a) => !a.pending && !all.some((v) => v.file === a.file && v.rule === a.rule));
    expect(stale.map((a) => `${a.file} [${a.rule}]`)).toEqual([]);
  });
});

describe('C5 rule matchers', () => {
  const fake = (code: string, kind: 'css' | 'ts' = 'ts'): SourceFile => ({ path: 'fake', kind, code: stripComments(code, kind) });

  it('strips comments but keeps URLs and offsets', () => {
    const src = "const a = 'http://x/y'; // blur-3xl\n/* backdrop-blur */ const b = 1;";
    const out = stripComments(src, 'ts');
    expect(out).toHaveLength(src.length);
    expect(out).toContain("'http://x/y'");
    expect(out).not.toMatch(/blur/);
  });

  it('flags what C5 forbids and passes what it allows', () => {
    const run = (code: string, kind: 'css' | 'ts' = 'ts') => {
      FILES.push(fake(code, kind));
      try {
        return [...blurMaxViolations(), ...backdropViolations(), ...glassMaxViolations()].filter((v) => v.file === 'fake').map((v) => v.rule);
      } finally {
        FILES.pop();
      }
    };
    expect(run("cn('blur-2xl')")).toEqual(['blur-max']);
    expect(run("'md:blur-lg'")).toEqual(['blur-max']);
    expect(run("'blur-[20px]'")).toEqual(['blur-max']);
    expect(run("'[filter:blur(1rem)]'")).toEqual(['blur-max']);
    expect(run("style={{ filter: 'blur(30px)' }}")).toEqual(['blur-max']);
    expect(run('.x { filter: blur(40px); }', 'css')).toEqual(['blur-max']);
    expect(run("'backdrop-blur-sm'")).toEqual(['backdrop-outside-glass-blur']);
    expect(run("'backdrop-blur-glass'")).toEqual(['backdrop-outside-glass-blur']);
    expect(run("style={{ backdropFilter: 'blur(4px)' }}")).toEqual(['backdrop-outside-glass-blur']);
    expect(run('.x { backdrop-filter: blur(4px); }', 'css')).toEqual(['backdrop-outside-glass-blur']);
    expect(run("'supports-[backdrop-filter:blur(1px)]:backdrop-blur-[var(--blur-glass,14px)]'").sort()).toEqual(['backdrop-outside-glass-blur', 'blur-glass-max']);
    expect(run('.x { --blur-glass: 16px; }', 'css').sort()).toEqual(['blur-glass-max', 'blur-max']);

    expect(run(`cn(${JSON.stringify(QUARTER_BLUR)}, 'blur-sm', 'blur-[8px]', 'glass-blur bg-glass')`)).toEqual([]);
    expect(run("'supports-[backdrop-filter:blur(1px)]:bg-glass'")).toEqual([]);
    expect(run('.x { backdrop-filter: none; filter: blur(12px); }', 'css')).toEqual([]);
    expect(run('@supports (backdrop-filter: blur(1px)) { .x { color: red; } }', 'css')).toEqual([]);
    expect(run('@utility glass-blur { @supports (backdrop-filter: blur(1px)) { backdrop-filter: blur(var(--blur-glass)); } }', 'css')).toEqual([]);
  });
});
