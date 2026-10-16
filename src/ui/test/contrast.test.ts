/**
 * WCAG contrast computed straight from src/styles/tokens.css, for every
 * accent (C1) in the dark, light and OLED themes, plus the glass tokens (C8).
 * Text: 4.5:1 (1.4.3). Component boundaries, focus indicators, and state
 * indicators: 3:1 (1.4.11). Change a token and this fails before anyone sees it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ACCENTS } from '@/api/types';

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

const BASE = {
  dark: themeBlock(/:root,\s*:root\[data-theme='dark'\]\s*\{([^}]*)\}/),
  light: themeBlock(/:root\[data-theme='light'\]\s*\{([^}]*)\}/),
};
const OLED = themeBlock(/:root\[data-oled\]:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/);

/** The accent family override for one accent; amber is the base blocks themselves. */
function accentBlock(accent: string, theme: 'dark' | 'light'): Record<string, Rgb> {
  if (accent === 'amber') return {};
  const sel =
    theme === 'light'
      ? new RegExp(String.raw`:root\[data-theme='light'\]\[data-accent='${accent}'\]\s*\{([^}]*)\}`)
      : new RegExp(String.raw`:root\[data-accent='${accent}'\]\s*\{([^}]*)\}`);
  return themeBlock(sel);
}

const ACCENT_KEYS = ['accent', 'accent-hover', 'accent-pressed', 'accent-fg', 'focus'] as const;

/** Every theme the user can end up in: 7 accents x (dark, light, OLED). Amber dark/light keep their old names. */
const THEMES: Record<string, Record<string, Rgb>> = {};
for (const accent of ACCENTS) {
  const suffix = accent === 'amber' ? '' : ` + ${accent}`;
  THEMES[`dark${suffix}`] = { ...BASE.dark, ...accentBlock(accent, 'dark') };
  THEMES[`light${suffix}`] = { ...BASE.light, ...accentBlock(accent, 'light') };
  THEMES[`oled${suffix}`] = { ...BASE.dark, ...OLED, ...accentBlock(accent, 'dark') };
}

const SURFACES = ['bg', 'surface', 'surface-2', 'surface-3'] as const;

describe('accent and OLED blocks', () => {
  it('every non-amber accent defines its whole family for dark and for light', () => {
    for (const accent of ACCENTS.filter((a) => a !== 'amber')) {
      for (const theme of ['dark', 'light'] as const) {
        const block = accentBlock(accent, theme);
        for (const k of ACCENT_KEYS) expect(block[k], `${accent} ${theme}: --color-${k}`).toBeDefined();
      }
    }
  });

  it('OLED black puts the page and panels on true black and leaves the accent alone', () => {
    expect(OLED.bg).toEqual([0, 0, 0]);
    expect(OLED.surface).toEqual([0, 0, 0]);
    for (const k of ACCENT_KEYS) expect(OLED[k], `OLED must not set --color-${k}`).toBeUndefined();
  });

  it('covers 21 combinations', () => {
    expect(Object.keys(THEMES)).toHaveLength(ACCENTS.length * 3);
  });
});

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

/** `rgb(r g b / a)` from a token in one block. */
function rgbaToken(block: string, name: string): { rgb: Rgb; alpha: number } {
  const m = new RegExp(String.raw`--color-${name}:\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)\s*;`).exec(block);
  if (!m) throw new Error(`--color-${name} missing or not rgb(r g b / a)`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
}

function blockBody(selector: RegExp): string {
  const body = selector.exec(tokensCss)?.[1];
  if (body === undefined) throw new Error(`block ${selector} missing from tokens.css`);
  return body;
}

describe('glass tokens (C8)', () => {
  const blocks = {
    dark: blockBody(/:root,\s*:root\[data-theme='dark'\]\s*\{([^}]*)\}/),
    light: blockBody(/:root\[data-theme='light'\]\s*\{([^}]*)\}/),
    oled: blockBody(/:root\[data-oled\]:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/),
  };
  const BLACK: Rgb = [0, 0, 0];
  const WHITE: Rgb = [255, 255, 255];

  for (const [name, body] of Object.entries(blocks)) {
    // OLED inherits the text colours from the dark block.
    const text = name === 'oled' ? THEMES['dark']! : THEMES[name]!;
    it(`${name}: on-glass text reaches 4.5:1 on glass composited over black and over white`, () => {
      for (const surface of ['glass', 'glass-strong']) {
        const { rgb, alpha } = rgbaToken(body, surface);
        expect(alpha, `${surface} alpha`).toBeGreaterThan(0);
        expect(alpha, `${surface} alpha`).toBeLessThanOrEqual(1);
        for (const [under, label] of [
          [BLACK, 'black'],
          [WHITE, 'white'],
        ] as const) {
          const fill = over(rgb, alpha, under);
          for (const fg of ['on-glass', 'on-glass-muted']) {
            const c = text[fg];
            if (!c) throw new Error(`${name}: --color-${fg} missing`);
            expect(contrast(c, fill), `${fg} on ${surface} over ${label}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    });

    it(`${name}: defines a glass border`, () => {
      expect(rgbaToken(body, 'glass-border').alpha).toBeGreaterThan(0);
    });
  }

  // The glass accent is the dial tone on glass in every theme: the base block sets amber,
  // each accent block (dark selector, so it also holds under the light theme) its own.
  for (const accent of ACCENTS) {
    it(`${accent}: the glass accent reads on glass, and text on it reaches 4.5:1`, () => {
      const own = accent === 'amber' ? blocks.dark : blockBody(new RegExp(String.raw`:root\[data-accent='${accent}'\]\s*\{([^}]*)\}`));
      const fill = /--color-glass-accent:\s*(#[0-9a-f]{6})\s*;/i.exec(own)?.[1];
      const ink = /--color-glass-accent-fg:\s*(#[0-9a-f]{6})\s*;/i.exec(own)?.[1];
      if (!fill || !ink) throw new Error(`${accent}: --color-glass-accent or -fg missing`);
      expect(contrast(hex(ink), hex(fill)), 'glass-accent-fg on glass-accent').toBeGreaterThanOrEqual(4.5);
      for (const [name, body] of Object.entries(blocks)) {
        for (const surface of ['glass', 'glass-strong']) {
          const { rgb, alpha } = rgbaToken(body, surface);
          for (const [under, label] of [
            [BLACK, 'black'],
            [WHITE, 'white'],
          ] as const) {
            // 3:1 for the dial, tuning tick and star (WCAG 1.4.11).
            expect(contrast(hex(fill), over(rgb, alpha, under)), `${name} ${surface} over ${label}`).toBeGreaterThanOrEqual(3);
          }
        }
      }
    });
  }

  it('the light theme keeps the bright glass accent: no light block overrides it', () => {
    expect(blocks.light).not.toMatch(/--color-glass-accent/);
    for (const accent of ACCENTS.filter((a) => a !== 'amber')) {
      expect(blockBody(new RegExp(String.raw`:root\[data-theme='light'\]\[data-accent='${accent}'\]\s*\{([^}]*)\}`))).not.toMatch(/--color-glass-accent/);
    }
  });

  it('the strong variant is at least as opaque as the plain one', () => {
    for (const body of Object.values(blocks)) {
      expect(rgbaToken(body, 'glass-strong').alpha).toBeGreaterThanOrEqual(rgbaToken(body, 'glass').alpha);
    }
  });

  it('sets a blur length and maps the glass colours as utilities', () => {
    expect(tokensCss).toMatch(/--blur-glass:\s*\d+px/);
    const theme = readFileSync(join(STYLES, 'globals.css'), 'utf8').split('@layer base')[0]!;
    for (const k of ['glass', 'glass-strong', 'glass-border', 'on-glass', 'on-glass-muted', 'glass-accent', 'glass-accent-fg']) expect(theme).toContain(`--color-${k}:`);
    expect(theme).toMatch(/--blur-glass:/);
  });
});
