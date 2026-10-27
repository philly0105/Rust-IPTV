/**
 * WCAG contrast computed straight from src/styles/tokens.css, for every
 * accent (C1) in the dark, light and OLED themes, plus the glass tokens (C8).
 * Text: 4.5:1 (1.4.3). Control boundaries (--color-border), focus indicators,
 * and state indicators: 3:1 (1.4.11). Container edges (--color-edge) and the
 * divider are decorative and only have to stay quieter than the control border.
 * Change a token and this fails before anyone sees it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ACCENTS } from '@/api/types';

import { SWITCH_TONES } from '../Field';
import { GLASS_FOCUS } from '../focus';
import { MENU_DANGER } from '../Menu';
import { PROGRESS_TRACK } from '../Misc';
import { SEGMENT_TONES, segmentClass } from '../Segmented';

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

const ACCENT_KEYS = [
  'accent',
  'accent-hover',
  'accent-pressed',
  'accent-fg',
  'accent-mark',
  'accent-solid',
  'accent-solid-hover',
  'accent-solid-pressed',
  'accent-solid-fg',
  'focus',
] as const;

/** Every theme the user can end up in: 7 accents x (dark, light, OLED). Amber dark/light keep their old names. */
const THEMES: Record<string, Record<string, Rgb>> = {};
for (const accent of ACCENTS) {
  const suffix = accent === 'amber' ? '' : ` + ${accent}`;
  THEMES[`dark${suffix}`] = { ...BASE.dark, ...accentBlock(accent, 'dark') };
  THEMES[`light${suffix}`] = { ...BASE.light, ...accentBlock(accent, 'light') };
  THEMES[`oled${suffix}`] = { ...BASE.dark, ...OLED, ...accentBlock(accent, 'dark') };
}

const SURFACES = ['bg', 'surface', 'surface-2', 'surface-3'] as const;
const WHITE_TEXT: Rgb = [255, 255, 255];

/** The resting colour token of a class list (`bg-x`, `border-x`), ignoring variants such as `hover:`. */
function restingToken(classes: string, prefix: 'bg' | 'border'): string {
  const hit = classes.split(/\s+/).find((c) => c.startsWith(`${prefix}-`));
  if (!hit) throw new Error(`no resting ${prefix}- class in "${classes}"`);
  return hit.slice(prefix.length + 1);
}

/** The colour token of a `ring-x` class (not the width `ring-1` or `ring-inset`). */
function ringToken(classes: string): string {
  const hit = classes.split(/\s+/).find((c) => /^ring-(?!\d|inset\b|offset)/.test(c));
  if (!hit) throw new Error(`no ring colour in "${classes}"`);
  return hit.slice('ring-'.length);
}

/** The token names one Switch state draws: track fill and outline, knob fill. */
function switchTokens(state: 'off' | 'on') {
  const { track, knob } = SWITCH_TONES[state];
  return { track: { bg: restingToken(track, 'bg'), border: restingToken(track, 'border') }, knob: { bg: restingToken(knob, 'bg') } };
}

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

  // Light theme review: amber, lime and coral filled in the bright tone with ink text while teal,
  // violet, rose and sky filled in their deep shade with white text, so the swatch row (and the
  // primary button) changed model with the accent. One model now: the bright fill in both themes.
  it('the solid fill family is the bright dial tone with ink text in light as in dark, for every accent', () => {
    const SOLID = ['accent-solid', 'accent-solid-hover', 'accent-solid-pressed', 'accent-solid-fg'] as const;
    for (const accent of ACCENTS) {
      const dark = { ...BASE.dark, ...accentBlock(accent, 'dark') };
      const light = { ...BASE.light, ...accentBlock(accent, 'light') };
      for (const k of SOLID) expect(light[k], `${accent} light --color-${k}`).toEqual(dark[k]);
      // The ink is the dark end: the fill is the light one, text on it is dark.
      expect(luminance(light['accent-solid-fg']!), `${accent} ink`).toBeLessThan(luminance(light['accent-solid']!));
    }
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
      for (const k of [
        'border',
        'edge',
        'divider',
        'focus',
        'accent',
        'accent-fg',
        'accent-solid',
        'accent-solid-fg',
        'danger-solid',
        'live-solid',
        'selected',
        'raised',
        'fg',
        'fg-muted',
        'fg-subtle',
        ...SURFACES,
      ])
        tok(k);
    });

    it('component borders reach 3:1 against bg and every surface (WCAG 1.4.11)', () => {
      for (const s of SURFACES) expect(contrast(tok('border'), tok(s)), `border on ${s}`).toBeGreaterThanOrEqual(3);
    });

    it('the focus ring reaches 3:1 against bg and every surface', () => {
      for (const s of SURFACES) expect(contrast(tok('focus'), tok(s)), `focus on ${s}`).toBeGreaterThanOrEqual(3);
    });

    it('state indicators reach 3:1: selected tab bar, tuning tick, progress fill', () => {
      for (const s of SURFACES) expect(contrast(tok('accent'), tok(s)), `accent on ${s}`).toBeGreaterThanOrEqual(3);
      expect(contrast(tok('accent'), tok('selected')), 'tick on selected').toBeGreaterThanOrEqual(3);
    });

    // Round 2 (light theme still brown): the tick, progress fills, tab underlines, the radio dot,
    // the on switch's outline and slider fills draw in the mark tone, not the text tone.
    it('the mark tone reaches 3:1 on bg, every surface and the selected fill (WCAG 1.4.11)', () => {
      for (const s of SURFACES) expect(contrast(tok('accent-mark'), tok(s)), `mark on ${s}`).toBeGreaterThanOrEqual(3);
      expect(contrast(tok('accent-mark'), tok('selected')), 'tick on selected').toBeGreaterThanOrEqual(3);
    });

    it(name.startsWith('light') ? 'the mark is brighter than the text tone, so a bar or tick reads as the hue' : 'the mark is the accent itself', () => {
      if (name.startsWith('light')) expect(luminance(tok('accent-mark'))).toBeGreaterThan(luminance(tok('accent')) * 1.5);
      else expect(tok('accent-mark')).toEqual(tok('accent'));
    });

    // Read from the classes Switch renders (SWITCH_TONES), so the guard cannot drift from the
    // component again: it once checked a fg-muted thumb while the switch drew a white one.
    it.each(['off', 'on'] as const)('the %s switch: knob 3:1 on its track, track outline 3:1 on every surface', (state) => {
      const { track, knob } = switchTokens(state);
      expect(contrast(tok(knob.bg), tok(track.bg)), `knob ${knob.bg} on track ${track.bg}`).toBeGreaterThanOrEqual(3);
      for (const s of SURFACES) expect(contrast(tok(track.border), tok(s)), `track edge ${track.border} on ${s}`).toBeGreaterThanOrEqual(3);
    });

    // segment-selection-contrast: the raised thumb alone was 1.24:1 (dark) and 1.09:1 (light) on
    // its track, so the chosen segment (SegmentedControl, pill Tabs) carries a ring, read from
    // SEGMENT_TONES, that keeps 3:1 against the track around it and the thumb inside it.
    it('the chosen segment: its ring reaches 3:1 on the track and on the thumb (WCAG 1.4.11)', () => {
      const { track, thumb } = SEGMENT_TONES.default;
      const ring = tok(ringToken(thumb));
      expect(contrast(ring, tok(restingToken(track, 'bg'))), `segment ring on track ${restingToken(track, 'bg')}`).toBeGreaterThanOrEqual(3);
      expect(contrast(ring, tok(restingToken(thumb, 'bg'))), `segment ring on thumb ${restingToken(thumb, 'bg')}`).toBeGreaterThanOrEqual(3);
      expect(segmentClass(true)).toContain(SEGMENT_TONES.default.thumb.split(' ').at(-1)!);
    });

    it('a progress fill reaches 3:1 on the track ProgressBar draws', () => {
      expect(contrast(tok('accent-mark'), tok(restingToken(PROGRESS_TRACK.theme, 'bg'))), 'mark on progress track').toBeGreaterThanOrEqual(3);
    });

    it('every text colour reaches 4.5:1 on bg and every surface', () => {
      for (const fg of ['fg', 'fg-muted', 'fg-subtle', 'accent', 'danger', 'success', 'warning', 'live']) {
        for (const s of SURFACES) expect(contrast(tok(fg), tok(s)), `${fg} on ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('text on filled controls reaches 4.5:1 (primary at rest, hover and pressed, danger button, live badge)', () => {
      expect(contrast(tok('accent-fg'), tok('accent'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tok('accent-fg'), tok('accent-hover'))).toBeGreaterThanOrEqual(4.5);
      for (const k of ['accent-solid', 'accent-solid-hover', 'accent-solid-pressed']) {
        expect(contrast(tok('accent-solid-fg'), tok(k)), `primary text on ${k}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const k of ['danger-solid', 'danger-solid-hover', 'danger-solid-pressed']) expect(contrast(WHITE_TEXT, tok(k)), `danger button (${k})`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(WHITE_TEXT, tok('live-solid')), 'live badge').toBeGreaterThanOrEqual(4.5);
    });

    it('text reaches 4.5:1 on the selected and raised fills', () => {
      for (const fg of ['fg', 'fg-muted', 'fg-subtle', 'accent']) {
        expect(contrast(tok(fg), tok('selected')), `${fg} on selected`).toBeGreaterThanOrEqual(4.5);
      }
      for (const fg of ['fg', 'fg-muted']) expect(contrast(tok(fg), tok('raised')), `${fg} on raised`).toBeGreaterThanOrEqual(4.5);
    });

    it('the selected fill stands apart from the page and the panels', () => {
      for (const s of ['bg', 'surface'] as const) {
        expect(contrast(tok('selected'), tok(s)), `selected on ${s}`).toBeGreaterThanOrEqual(1.08);
      }
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

    // DS-BORDER-WEIGHT: containers get the quiet edge, form controls keep the 3:1 border.
    it('the container edge sits between the divider and the control border, and still shows on a panel', () => {
      for (const s of ['bg', 'surface'] as const) {
        const edge = contrast(tok('edge'), tok(s));
        expect(edge, `edge on ${s}`).toBeGreaterThanOrEqual(contrast(tok('divider'), tok(s)));
        expect(edge, `edge on ${s}`).toBeLessThan(contrast(tok('border'), tok(s)));
      }
      expect(contrast(tok('edge'), tok('surface')), 'edge on surface').toBeGreaterThanOrEqual(1.2);
    });
  });
}

describe('Tailwind theme mapping', () => {
  const globals = readFileSync(join(STYLES, 'globals.css'), 'utf8');
  const theme = globals.split('@layer base')[0]!;

  it('exposes the line, state and fill tokens as utility colours', () => {
    for (const k of ['divider', 'edge', 'border', 'selected', 'raised', 'accent-mark', 'accent-solid', 'accent-solid-fg', 'danger-solid', 'live-solid']) {
      expect(theme, `--color-${k}`).toMatch(new RegExp(String.raw`--color-${k}:\s*#[0-9a-f]{6}`, 'i'));
    }
    for (const k of ['hover', 'active']) expect(theme, `--color-${k}`).toMatch(new RegExp(String.raw`--color-${k}:\s*rgb\(`));
  });

  it('keeps the @theme defaults equal to the dark block, so a utility never shows a stale colour', () => {
    const dark = BASE.dark;
    for (const m of theme.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
      const k = m[1]!;
      if (dark[k]) expect(hex(m[2]!), `--color-${k}`).toEqual(dark[k]);
    }
  });

  // DS-ELEVATION-THEMES: Tailwind 4 inlines a literal @theme shadow into the utility, so the light
  // and OLED values in tokens.css never applied. The utilities must point at the theme variables.
  it('maps shadow-1 to shadow-3 onto the per-theme --elevation-N variables', () => {
    for (const n of [1, 2, 3]) expect(theme).toMatch(new RegExp(String.raw`--shadow-${n}:\s*var\(--elevation-${n}\)\s*;`));
    expect(theme).not.toMatch(/--shadow-\d+:(?!\s*var\(--elevation-)/);
    const blocks = [
      /:root,\s*:root\[data-theme='dark'\]\s*\{([^}]*)\}/,
      /:root\[data-theme='light'\]\s*\{([^}]*)\}/,
      /:root\[data-oled\]:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/,
    ];
    for (const re of blocks) {
      const body = re.exec(tokensCss)?.[1] ?? '';
      for (const n of [1, 2, 3]) expect(body, `${re} --elevation-${n}`).toMatch(new RegExp(String.raw`--elevation-${n}:\s*[^;]+;`));
    }
    // The old per-theme --shadow-N values were dead (nothing read them); none may come back.
    expect(tokensCss).not.toMatch(/--shadow-\d+\s*:/);
  });
});

/** The hover and active layers: see-through, so they are checked composited over each surface. */
describe('state layers (DS-STATE-FILLS)', () => {
  const layerBlocks = {
    dark: blockBody(/:root,\s*:root\[data-theme='dark'\]\s*\{([^}]*)\}/),
    light: blockBody(/:root\[data-theme='light'\]\s*\{([^}]*)\}/),
    oled: blockBody(/:root\[data-oled\]:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/),
  };
  for (const [name, body] of Object.entries(layerBlocks)) {
    const c = THEMES[name]!;
    const hover = rgbaToken(body, 'hover');
    const active = rgbaToken(body, 'active');

    it(`${name}: hover is visible on the page and on panels, and active is stronger`, () => {
      for (const s of ['bg', 'surface', 'surface-2'] as const) {
        const rest = c[s]!;
        expect(contrast(over(hover.rgb, hover.alpha, rest), rest), `hover on ${s}`).toBeGreaterThanOrEqual(1.1);
        expect(active.alpha, 'active alpha').toBeGreaterThan(hover.alpha);
      }
    });

    it(`${name}: text stays readable on hovered and pressed rows`, () => {
      for (const s of SURFACES) {
        for (const layer of [hover, active]) {
          const fill = over(layer.rgb, layer.alpha, c[s]!);
          for (const fg of ['fg', 'fg-muted']) expect(contrast(c[fg]!, fill), `${fg} on ${s} + layer ${layer.alpha}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const s of ['bg', 'surface', 'surface-2'] as const) {
        expect(contrast(c['fg-subtle']!, over(hover.rgb, hover.alpha, c[s]!)), `fg-subtle on hovered ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    // The guide's and the ribbon's airing cell is the active layer over the page (guide) or a
    // panel (ribbon), and the red now line is drawn under it: seen through the layer it still
    // reaches 3:1 against the cell, and the cell still stands apart from a future cell.
    it(`${name}: the now line reads through the airing cell, which stands apart from the next one`, () => {
      for (const s of ['bg', 'surface'] as const) {
        const cell = over(active.rgb, active.alpha, c[s]!);
        const line = over(active.rgb, active.alpha, c.live!);
        expect(contrast(line, cell), `now line through the airing cell on ${s}`).toBeGreaterThanOrEqual(3);
        expect(contrast(cell, c['surface-2']!), `airing cell against a future cell on ${s}`).toBeGreaterThanOrEqual(1.08);
      }
    });
  }
});

describe('destructive menu items', () => {
  // The red text over the strongest of its red washes (pressed), on the menu's panel.
  const washes = [...MENU_DANGER.matchAll(/:bg-danger\/(\d+)/g)].map((m) => Number(m[1]) / 100);
  it('carry red washes for hover, focus and press', () => {
    expect(MENU_DANGER.split(' ')).toContain('text-danger');
    expect(washes.length).toBe(3);
  });
  for (const [name, c] of Object.entries(THEMES)) {
    it(`${name}: Remove stays readable on its strongest wash`, () => {
      const fill = over(c.danger!, Math.max(...washes), c.surface!);
      expect(contrast(c.danger!, fill)).toBeGreaterThanOrEqual(4.5);
    });
  }
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

  /** A see-through white layer as Tailwind writes it (`bg-white/6`). */
  const whiteLayer = (token: string): number => {
    const m = /^white\/(\d+)$/.exec(token);
    if (!m) throw new Error(`expected a white layer, got ${token}`);
    return Number(m[1]) / 100;
  };
  const glassAccent = (accent: string): Rgb => {
    const own = accent === 'amber' ? blocks.dark : blockBody(new RegExp(String.raw`:root\[data-accent='${accent}'\]\s*\{([^}]*)\}`));
    const fill = /--color-glass-accent:\s*(#[0-9a-f]{6})\s*;/i.exec(own)?.[1];
    if (!fill) throw new Error(`${accent}: --color-glass-accent missing`);
    return hex(fill);
  };
  /** Every glass panel a glass control can sit in, in every theme, over black and over white. */
  const panels = (): [string, Rgb][] =>
    Object.entries(blocks).flatMap(([name, body]) =>
      ['glass', 'glass-strong'].flatMap((surface) => {
        const { rgb, alpha } = rgbaToken(body, surface);
        return [
          [`${name} ${surface} over black`, over(rgb, alpha, BLACK)],
          [`${name} ${surface} over white`, over(rgb, alpha, WHITE)],
        ] as [string, Rgb][];
      }),
    );

  // segment-selection-contrast, glass tone: the chosen segment's ring against the glass track.
  it('a chosen glass segment: its ring reaches 3:1 on the track, on every glass panel', () => {
    const { track, thumb } = SEGMENT_TONES.glass;
    const layer = whiteLayer(restingToken(track, 'bg'));
    for (const [name, body] of Object.entries(blocks)) {
      const ringName = ringToken(thumb);
      const text = name === 'oled' ? THEMES['dark']! : THEMES[name]!;
      const ring = text[ringName];
      if (!ring) throw new Error(`${name}: --color-${ringName} missing`);
      for (const surface of ['glass', 'glass-strong']) {
        const { rgb, alpha } = rgbaToken(body, surface);
        for (const [under, label] of [
          [BLACK, 'black'],
          [WHITE, 'white'],
        ] as const) {
          const trackFill = over(WHITE, layer, over(rgb, alpha, under));
          expect(contrast(ring, trackFill), `${name} ${surface} over ${label}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  // glass-segment-focus: glass segments (and the glass BackButton) draw focus in the glass accent,
  // because the theme's focus is a deep shade in light (2.81:1 and 1.91:1 on glass).
  it('glass controls focus in the glass accent, which reaches 3:1 on the glass track and panel for every accent', () => {
    expect(GLASS_FOCUS).toContain('[--color-focus:var(--color-glass-accent)]');
    expect(GLASS_FOCUS).toMatch(/\[--color-glow:[^\]]*var\(--color-glass-accent\)/);
    for (const selected of [true, false]) expect(segmentClass(selected, 'glass')).toContain('[--color-focus:var(--color-glass-accent)]');
    expect(segmentClass(true, 'default')).not.toContain('--color-glass-accent');
    const layer = whiteLayer(restingToken(SEGMENT_TONES.glass.track, 'bg'));
    for (const accent of ACCENTS) {
      const focus = glassAccent(accent);
      for (const [label, panel] of panels()) {
        expect(contrast(focus, panel), `${accent} focus on ${label}`).toBeGreaterThanOrEqual(3);
        // Glass segments sit in strong glass: the player's menus and the wall's toolbar.
        if (label.includes('glass-strong')) {
          expect(contrast(focus, over(WHITE, layer, panel)), `${accent} focus on the segment track, ${label}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  // glass-progress-contrast: the glass bar's track was on-glass at 20 %, so on pale art the
  // fill stood at about 1.3:1 against it. The track ProgressBar draws is read from PROGRESS_TRACK.
  it('a glass progress fill reaches 3:1 on its track over black and over white, for every accent', () => {
    const track = restingToken(PROGRESS_TRACK.glass, 'bg');
    for (const accent of ACCENTS) {
      const fill = glassAccent(accent);
      for (const [name, body] of Object.entries(blocks)) {
        const { rgb, alpha } = rgbaToken(body, track);
        expect(alpha, `${name} ${track} alpha`).toBeGreaterThanOrEqual(0.85);
        for (const [under, label] of [
          [BLACK, 'black'],
          [WHITE, 'white'],
        ] as const) {
          expect(contrast(fill, over(rgb, alpha, under)), `${accent} fill on ${name} ${track} over ${label}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

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

// ==== Guide genre colours (CB-GUIDE-GENRE) ==== begin
// The block at the end of tokens.css: stripes and chip dots are marks (WCAG 1.4.11), so each
// keeps 3:1 against every surface, the selected fill and the airing cell (the active layer over
// the page), in every theme. Dark blocks also serve OLED, which only darkens the surfaces.
describe('guide genre stripes (CB-GUIDE-GENRE)', () => {
  const section = /==== Guide genre colours \(CB-GUIDE-GENRE\) ==== begin([\s\S]*?)==== Guide genre colours ==== end/.exec(tokensCss)?.[1] ?? '';
  const genreBlock = (sel: RegExp) => {
    const body = sel.exec(section)?.[1] ?? '';
    const out: Record<string, Rgb> = {};
    for (const m of body.matchAll(/--color-genre-([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]!] = hex(m[2]!);
    return out;
  };
  const GENRE_NAMES = ['movie', 'sports', 'news', 'kids', 'series'];
  const genres = {
    dark: genreBlock(/:root,\s*:root\[data-theme='dark'\]\s*\{([^}]*)\}/),
    light: genreBlock(/:root\[data-theme='light'\]\s*\{([^}]*)\}/),
  };
  const activeOf = {
    dark: blockBody(/:root,\s*:root\[data-theme='dark'\]\s*\{([^}]*)\}/),
    light: blockBody(/:root\[data-theme='light'\]\s*\{([^}]*)\}/),
    oled: blockBody(/:root\[data-oled\]:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/),
  };

  it('defines every bucket for dark and light, and nothing else in the block', () => {
    expect(section).not.toBe('');
    for (const theme of ['dark', 'light'] as const) expect(Object.keys(genres[theme]).sort()).toEqual([...GENRE_NAMES].sort());
    expect(section).not.toMatch(/--color-(?!genre-)[\w-]+:/);
  });

  for (const [name, c] of Object.entries(THEMES)) {
    it(`${name}: every genre mark reaches 3:1 on the guide's fills`, () => {
      const g = name.startsWith('light') ? genres.light : genres.dark;
      const layer = rgbaToken(activeOf[name.startsWith('light') ? 'light' : name.startsWith('oled') ? 'oled' : 'dark'], 'active');
      const fills: [string, Rgb][] = [
        ...SURFACES.map((s) => [s, c[s]!] as [string, Rgb]),
        ['selected', c.selected!],
        ['airing cell', over(layer.rgb, layer.alpha, c.bg!)],
      ];
      for (const genre of GENRE_NAMES) {
        for (const [fill, rgb] of fills) expect(contrast(g[genre]!, rgb), `${genre} on ${fill}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
// ==== Guide genre colours ==== end
