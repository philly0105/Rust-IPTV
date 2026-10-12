/**
 * WCAG contrast computed straight from src/styles/tokens.css, for both themes.
 * Text: 4.5:1 (1.4.3). Component boundaries, focus indicators, and state
 * indicators: 3:1 (1.4.11). Change a token and this fails before anyone sees it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const STYLES = join(__dirname, '..', '..', 'styles');
const tokensCss = readFileSync(join(STYLES, 'tokens.css'), 'utf8');

type Rgb = readonly [number, number, number];

function hex(h: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two opaque colours. */
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` at `alpha` composited over the opaque `bg` (Tailwind's `bg-x/15`). */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => Math.round(fg[i]! * alpha + bg[i]! * (1 - alpha))) as unknown as Rgb;
}

function themeBlock(selector: RegExp): Record<string, Rgb> {
  const body = selector.exec(tokensCss)?.[1] ?? '';
  const out: Record<string, Rgb> = {};
  for (const m of body.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]!] = hex(m[2]!);
  return out;
}

const THEMES = {
  dark: themeBlock(/:root,\s*:root\[data-theme='dark'\]\s*\{([^}]*)\}/),
  light: themeBlock(/:root\[data-theme='light'\]\s*\{([^}]*)\}/),
};

const SURFACES = ['bg', 'surface', 'surface-2', 'surface-3'] as const;

describe('contrast helper', () => {
  it('matches the WCAG reference values', () => {
    expect(contrast(hex('#000000'), hex('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrast(hex('#777777'), hex('#ffffff'))).toBeCloseTo(4.48, 2);
  });
});

for (const [name, c] of Object.entries(THEMES)) {
  const tok = (k: string): Rgb => {
    const v = c[k];
    if (!v) throw new Error(`${name}: --color-${k} missing from tokens.css`);
    return v;
  };

  describe(`${name} theme`, () => {
    it('parses every colour token', () => {
      for (const k of ['border', 'divider', 'focus', 'accent', 'accent-fg', 'fg', 'fg-muted', 'fg-subtle', ...SURFACES]) tok(k);
    });

    it('component borders reach 3:1 against bg and every surface (WCAG 1.4.11)', () => {
      for (const s of SURFACES) expect(contrast(tok('border'), tok(s)), `border on ${s}`).toBeGreaterThanOrEqual(3);
    });

    it('the focus ring reaches 3:1 against bg and every surface', () => {
      for (const s of SURFACES) expect(contrast(tok('focus'), tok(s)), `focus on ${s}`).toBeGreaterThanOrEqual(3);
    });

    it('state indicators reach 3:1: selected tab bar, switch on, switch thumb, progress fill', () => {
      for (const s of SURFACES) expect(contrast(tok('accent'), tok(s)), `accent on ${s}`).toBeGreaterThanOrEqual(3);
      // Switch off: thumb (fg-muted) on its track (surface-3); on: thumb (accent-fg) on accent.
      expect(contrast(tok('fg-muted'), tok('surface-3'))).toBeGreaterThanOrEqual(3);
      expect(contrast(tok('accent-fg'), tok('accent'))).toBeGreaterThanOrEqual(3);
    });

    it('every text colour reaches 4.5:1 on bg and every surface', () => {
      for (const fg of ['fg', 'fg-muted', 'fg-subtle', 'accent', 'danger', 'success', 'warning', 'live']) {
        for (const s of SURFACES) expect(contrast(tok(fg), tok(s)), `${fg} on ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('text on filled controls reaches 4.5:1 (primary, hover, danger button, live badge)', () => {
      expect(contrast(tok('accent-fg'), tok('accent'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tok('accent-fg'), tok('accent-hover'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tok('bg'), tok('danger')), 'danger button').toBeGreaterThanOrEqual(4.5);
      expect(contrast(tok('bg'), tok('live')), 'live badge').toBeGreaterThanOrEqual(4.5);
    });

    it('tinted badges keep 4.5:1 text on their 15 % wash over each surface', () => {
      for (const tone of ['success', 'warning', 'danger']) {
        for (const s of ['bg', 'surface', 'surface-2'] as const) {
          const wash = over(tok(tone), 0.15, tok(s));
          expect(contrast(tok(tone), wash), `${tone} badge on ${s}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it('the divider stays a quiet hairline, below the component border', () => {
      for (const s of ['bg', 'surface'] as const) {
        expect(contrast(tok('divider'), tok(s))).toBeLessThan(contrast(tok('border'), tok(s)));
      }
    });
  });
}

describe('Tailwind theme mapping', () => {
  it('exposes the divider token as a utility colour', () => {
    const globals = readFileSync(join(STYLES, 'globals.css'), 'utf8');
    const theme = globals.split('@layer base')[0]!;
    expect(theme).toMatch(/--color-divider:\s*#[0-9a-f]{6}/i);
    expect(theme).toMatch(/--color-border:\s*#[0-9a-f]{6}/i);
  });
});

describe('pressed fills (review round 1)', () => {
  for (const [name, c] of Object.entries(THEMES)) {
    it(`${name}: text stays readable on pressed fills`, () => {
      expect(contrast(c['accent-fg']!, c['accent-pressed']!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.fg!, c.pressed!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c['fg-muted']!, c.pressed!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
