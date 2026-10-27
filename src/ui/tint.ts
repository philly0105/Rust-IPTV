import type { CSSProperties } from 'react';

/**
 * One tint per name, for every tile that has no artwork: posters, channel monograms, source
 * monograms, Home's channel glow and hero, a detail page's wash. Every one of them calls this, so a
 * title or a channel has the same colour on every page.
 *
 * The stops are set in OKLCH, where lightness is the same for every hue, and converted here to sRGB
 * hex, so no browser needs oklch() support. HSL with a fixed lightness made greens and olives glow
 * and blues and purples sink, and a grid of fallbacks read as blotches.
 */

/** Deterministic hash of a string to 0..359, so fallback tiles differ per title. */
export function hueOf(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** How many hues the tints use, evenly round the wheel: fewer would make neighbours match too often. */
const HUES = 12;

/** The OKLCH hue of a name's tint: one of {@link HUES}, 30 degrees apart. */
export function nameHue(name: string): number {
  return (hueOf(name) % HUES) * (360 / HUES) + 15;
}

const srgb = (v: number) => {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
};

/** OKLCH (lightness 0..1, chroma, hue in degrees) as `#rrggbb`, clipped into sRGB. */
export function oklchHex(l: number, c: number, h: number): string {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
  return `#${rgb.map((v) => Math.round(srgb(v) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** `#rrggbb` at an opacity, as `#rrggbbaa`. */
export function withAlpha(hex: string, alpha: number): string {
  return hex + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

/** The HSL hue of a `#rrggbb` colour, for the few glows still written in hsl() (the Live stage's). */
function hslHueOf(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const max = Math.max(r, g, b);
  const c = max - Math.min(r, g, b);
  if (c === 0) return 0;
  const h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
  return Math.round((h * 60 + 360) % 360);
}

export interface Tint {
  /** OKLCH hue. */
  hue: number;
  /** The HSL hue of the dark top stop, for a glow written in hsl(). */
  hslHue: number;
  /** For white initials: a top stop at L 0.42 and a bottom one at L 0.26, a little further round. */
  dark: readonly [string, string];
  /** The light theme's: pale (L 0.93 and 0.86) and low in chroma, so a grid of them stays quiet. */
  light: readonly [string, string];
  /** Initials on the light stops: the same hue, deep (L 0.36). */
  ink: string;
  /** Under the dark stops, for a large field (Home's hero): L 0.18. */
  deep: string;
}

const tints = new Map<number, Tint>();

/** The tint a name takes. Twelve of them exist, each worked out once. */
export function tintOf(name: string): Tint {
  const hue = nameHue(name);
  let tint = tints.get(hue);
  if (!tint) {
    const second = hue + 25;
    const dark = [oklchHex(0.42, 0.07, hue), oklchHex(0.26, 0.05, second)] as const;
    tint = {
      hue,
      hslHue: hslHueOf(dark[0]),
      dark,
      light: [oklchHex(0.93, 0.035, hue), oklchHex(0.86, 0.05, second)],
      ink: oklchHex(0.36, 0.09, hue),
      deep: oklchHex(0.18, 0.035, second),
    };
    tints.set(hue, tint);
  }
  return tint;
}

export type TintScheme = 'dark' | 'light';

/** A name's tint as a two-stop gradient. */
export function tintFill(name: string, scheme: TintScheme = 'dark'): string {
  const [a, b] = tintOf(name)[scheme];
  return `linear-gradient(160deg, ${a}, ${b})`;
}

/** The custom properties {@link TINT_THEME} and {@link TINT_DARK} read: both gradients and the light ink. */
export function tintVars(name: string): CSSProperties {
  return { '--tint-dark': tintFill(name, 'dark'), '--tint-light': tintFill(name, 'light'), '--tint-ink': tintOf(name).ink } as CSSProperties;
}

/**
 * A tile in the name's tint ({@link tintVars} on the same element) with its initials in the right
 * colour: white on the deep stops, and in the light theme the pale stops with the hue's own ink.
 * Deep slabs were the heaviest things on the light theme's pale page.
 */
export const TINT_THEME = '[background-image:var(--tint-dark)] text-white/90 light:[background-image:var(--tint-light)] light:[color:var(--tint-ink)]';

/** The deep stops in every theme, for a tile on glass or over video (Home's hero). */
export const TINT_DARK = '[background-image:var(--tint-dark)] text-white/90';
