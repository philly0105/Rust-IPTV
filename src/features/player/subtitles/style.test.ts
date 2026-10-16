import { describe, expect, it } from 'vitest';

import type { Settings } from '@/api/types';

import { clampSubtitlePosition, cueCssVars, cueLine, DEFAULT_SUBTITLE_STYLE, mpvSubtitleProperties, styleFromSettings, type SubtitleStyle } from './style';

const base: SubtitleStyle = DEFAULT_SUBTITLE_STYLE;
const props = (st: Partial<SubtitleStyle>): Record<string, string | number> =>
  Object.fromEntries(mpvSubtitleProperties({ ...base, ...st }).map((p) => [p.name, p.value]));

describe('cueCssVars', () => {
  it.each([
    ['small', '0.8'],
    ['medium', '1'],
    ['large', '1.25'],
    ['xlarge', '1.5'],
  ] as const)('size %s scales by %s', (size, scale) => {
    expect(cueCssVars({ ...base, size })['--sub-scale']).toBe(scale);
  });

  it.each([
    ['white', '#FFFFFF'],
    ['yellow', '#FFE600'],
    ['cyan', '#00E5FF'],
    ['green', '#7CFF4F'],
  ] as const)('colour %s is %s', (color, hex) => {
    expect(cueCssVars({ ...base, color })['--sub-color']).toBe(hex);
  });

  it('maps each background', () => {
    const shadow = cueCssVars({ ...base, background: 'shadow' });
    expect(shadow['--sub-bg']).toBe('transparent');
    expect(shadow['--sub-shadow']).toMatch(/rgb\(0 0 0/);
    expect(cueCssVars({ ...base, background: 'box' })).toMatchObject({ '--sub-bg': 'rgb(0 0 0 / 0.72)', '--sub-shadow': 'none' });
    expect(cueCssVars({ ...base, background: 'solid' })).toMatchObject({ '--sub-bg': 'rgb(0 0 0)', '--sub-shadow': 'none' });
  });
});

describe('mpvSubtitleProperties', () => {
  it('sends every property, size only overriding ASS styling', () => {
    expect(mpvSubtitleProperties(base)).toEqual([
      { name: 'sub-ass-override', value: 'scale' },
      { name: 'sub-scale', value: 1 },
      { name: 'sub-color', value: '#FFFFFF' },
      { name: 'sub-border-style', value: 'background-box' },
      { name: 'sub-back-color', value: '#B8000000' },
      { name: 'sub-border-size', value: 3 },
      { name: 'sub-shadow-offset', value: 0 },
      { name: 'sub-pos', value: 100 },
    ]);
  });

  it.each([
    ['small', 0.8],
    ['medium', 1],
    ['large', 1.25],
    ['xlarge', 1.5],
  ] as const)('size %s sets sub-scale %s', (size, scale) => {
    expect(props({ size })['sub-scale']).toBe(scale);
  });

  it.each([
    ['white', '#FFFFFF'],
    ['yellow', '#FFE600'],
    ['cyan', '#00E5FF'],
    ['green', '#7CFF4F'],
  ] as const)('colour %s sets sub-color %s', (color, hex) => {
    expect(props({ color })['sub-color']).toBe(hex);
  });

  it('maps each background to a border style and a box colour', () => {
    expect(props({ background: 'shadow' })).toMatchObject({
      'sub-border-style': 'outline-and-shadow',
      'sub-back-color': '#C0000000',
      'sub-border-size': 2,
      'sub-shadow-offset': 1,
    });
    expect(props({ background: 'box' })).toMatchObject({ 'sub-border-style': 'background-box', 'sub-back-color': '#B8000000', 'sub-shadow-offset': 0 });
    expect(props({ background: 'solid' })).toMatchObject({ 'sub-border-style': 'background-box', 'sub-back-color': '#FF000000', 'sub-shadow-offset': 0 });
  });

  it('turns the position into sub-pos = 100 - position, inside the allowed range', () => {
    expect(props({ position: 0 })['sub-pos']).toBe(100);
    expect(props({ position: 15 })['sub-pos']).toBe(85);
    expect(props({ position: 40 })['sub-pos']).toBe(60);
    expect(props({ position: 99 })['sub-pos']).toBe(60);
    expect(props({ position: -5 })['sub-pos']).toBe(100);
  });

  it('keeps every value inside what the core accepts', () => {
    for (const size of ['small', 'medium', 'large', 'xlarge'] as const) {
      for (const background of ['shadow', 'box', 'solid'] as const) {
        const p = props({ size, background, position: 40 });
        expect(p['sub-scale']).toBeGreaterThanOrEqual(0.5);
        expect(p['sub-scale']).toBeLessThanOrEqual(3);
        expect(String(p['sub-back-color'])).toMatch(/^#[0-9A-F]{8}$/);
        expect(Number.isInteger(p['sub-pos'])).toBe(true);
      }
    }
  });
});

describe('cueLine and positions', () => {
  it('puts the cue bottom at 90 % and raises it one percent per step', () => {
    expect(cueLine(0)).toBe(90);
    expect(cueLine(25)).toBe(65);
    expect(cueLine(40)).toBe(50);
    expect(cueLine(100)).toBe(50);
  });

  it('clamps and rounds positions', () => {
    expect(clampSubtitlePosition(12.6)).toBe(13);
    expect(clampSubtitlePosition(-1)).toBe(0);
    expect(clampSubtitlePosition(41)).toBe(40);
    expect(clampSubtitlePosition(Number.NaN)).toBe(0);
  });
});

describe('styleFromSettings', () => {
  it('reads the four settings and falls back for unknown values', () => {
    const s = { subtitleSize: 'large', subtitleColor: 'cyan', subtitleBackground: 'solid', subtitlePosition: 12 } as Settings;
    expect(styleFromSettings(s)).toEqual({ size: 'large', color: 'cyan', background: 'solid', position: 12 });
    const odd = { subtitleSize: 'huge', subtitleColor: 'pink', subtitleBackground: 'blur', subtitlePosition: 400 } as unknown as Settings;
    expect(styleFromSettings(odd)).toEqual({ size: 'medium', color: 'white', background: 'box', position: 40 });
    expect(styleFromSettings({} as Settings)).toEqual(DEFAULT_SUBTITLE_STYLE);
  });
});
