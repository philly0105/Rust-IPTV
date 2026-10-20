/**
 * The control bar lies on an edge-to-edge scrim instead of a glass pane (PL-BAR-HIERARCHY). Its
 * text (times, the live badge, the volume level) still has to read over the brightest frame: the
 * scrim's floor, black at `--player-scrim-floor` over white, keeps on-glass and on-glass-muted at
 * 4.5:1 (WCAG 1.4.3). The glass tokens themselves are checked in src/ui/test/contrast.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type Rgb = [number, number, number];

const css = fs.readFileSync(path.join(__dirname, 'player.css'), 'utf8');
const tokens = fs.readFileSync(path.join(__dirname, '../../styles/tokens.css'), 'utf8');

function hex(h: string): Rgb {
  const n = Number.parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance([r, g, b]: Rgb): number {
  const c = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** Black at `alpha` over white. */
function blackOverWhite(alpha: number): Rgb {
  const v = Math.round(255 * (1 - alpha));
  return [v, v, v];
}

describe('the control bar scrim', () => {
  const floor = Number(/--player-scrim-floor:\s*([\d.]+)/.exec(css)?.[1]);

  it('declares its floor, and the gradient holds it up to the top fade', () => {
    expect(floor).toBeGreaterThan(0);
    expect(css).toMatch(/rgb\(0 0 0 \/ var\(--player-scrim-floor\)\) calc\(100% - var\(--player-scrim-fade\)\)/);
  });

  it('keeps on-glass and on-glass-muted at 4.5:1 over a white frame', () => {
    const fg = /--color-on-glass:\s*(#[0-9a-f]{6})/i.exec(tokens)?.[1];
    const muted = /--color-on-glass-muted:\s*(#[0-9a-f]{6})/i.exec(tokens)?.[1];
    if (!fg || !muted) throw new Error('on-glass tokens missing from tokens.css');
    const under = blackOverWhite(floor);
    expect(contrast(hex(fg), under)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex(muted), under)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the level sliders (.player-range)', () => {
  /** The declarations of the first rule whose selector is exactly `selector`. */
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`);
    if (at < 0) throw new Error(`no rule for ${selector}`);
    return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  };

  it('fill from the minimum the browser puts the thumb against: the left, or the right in RTL', () => {
    // A native range in an RTL page has its minimum on the right; a fill drawn from the left there
    // never met the thumb (the Arabic radio volume at 30 %: thumb 30 % from the right, fill on the left).
    expect(rule('.player-range')).toMatch(/--player-range-to:\s*right/);
    expect(rule('.player-range:dir(rtl)')).toMatch(/--player-range-to:\s*left/);
    for (const track of ['.player-range::-webkit-slider-runnable-track', '.player-range::-moz-range-track']) {
      expect(rule(track)).toMatch(/linear-gradient\(to var\(--player-range-to\), [^;]* var\(--fill, 0%\), [^;]* var\(--fill, 0%\)\)/);
    }
    expect(css).not.toMatch(/linear-gradient\(to right, var\(--color-on-glass/);
  });
});
