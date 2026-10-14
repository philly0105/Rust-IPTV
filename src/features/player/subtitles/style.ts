/**
 * The user's subtitle look (settings.subtitle*) mapped once for both players (C6): CSS
 * variables for the built-in player's `video::cue`, and mpv properties for embedded mpv.
 */

import {
  SUBTITLE_POSITION_MAX,
  SUBTITLE_POSITION_MIN,
  type Settings,
  type SubtitleBackground,
  type SubtitleColor,
  type SubtitleSize,
} from '@/api/types';

export interface SubtitleStyle {
  size: SubtitleSize;
  color: SubtitleColor;
  background: SubtitleBackground;
  /** How far the text sits above its usual place, 0..=40 (percent of the picture height). */
  position: number;
}

/** Text size multiplier per setting (mpv `sub-scale`, the `::cue` font-size factor). */
export const SUBTITLE_SCALE: Record<SubtitleSize, number> = { small: 0.8, medium: 1, large: 1.25, xlarge: 1.5 };

/** Text colour per setting. */
export const SUBTITLE_HEX: Record<SubtitleColor, string> = { white: '#FFFFFF', yellow: '#FFE600', cyan: '#00E5FF', green: '#7CFF4F' };

/** The box behind the text: none (shadow only), translucent, opaque. */
const CUE_BG: Record<SubtitleBackground, string> = { shadow: 'transparent', box: 'rgb(0 0 0 / 0.72)', solid: 'rgb(0 0 0)' };

/** Shadow-only text needs a dark halo to stay readable on bright pictures. */
const CUE_SHADOW = '0 0 3px rgb(0 0 0), 0 1px 2px rgb(0 0 0 / 0.9), 1px 1px 1px rgb(0 0 0)';

/** mpv colours are `#AARRGGBB`: the shadow, the translucent box (0.72 alpha) and the opaque box. */
const MPV_BACK: Record<SubtitleBackground, string> = { shadow: '#C0000000', box: '#B8000000', solid: '#FF000000' };

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = { size: 'medium', color: 'white', background: 'box', position: 0 };

/** A whole number inside 0..=40 (anything else falls back to the nearest end, NaN to 0). */
export function clampSubtitlePosition(position: number): number {
  if (!Number.isFinite(position)) return SUBTITLE_POSITION_MIN;
  return Math.min(SUBTITLE_POSITION_MAX, Math.max(SUBTITLE_POSITION_MIN, Math.round(position)));
}

/** The style the settings ask for; unknown values (an older or newer core) fall back to the defaults. */
export function styleFromSettings(s: Settings): SubtitleStyle {
  const d = DEFAULT_SUBTITLE_STYLE;
  return {
    size: Object.hasOwn(SUBTITLE_SCALE, s.subtitleSize) ? s.subtitleSize : d.size,
    color: Object.hasOwn(SUBTITLE_HEX, s.subtitleColor) ? s.subtitleColor : d.color,
    background: Object.hasOwn(CUE_BG, s.subtitleBackground) ? s.subtitleBackground : d.background,
    position: clampSubtitlePosition(s.subtitlePosition ?? d.position),
  };
}

/** The variables `player.css` reads in `video::cue`, set on `[data-player-host]`. */
export function cueCssVars(st: SubtitleStyle): Record<'--sub-scale' | '--sub-color' | '--sub-bg' | '--sub-shadow', string> {
  return {
    '--sub-scale': String(SUBTITLE_SCALE[st.size]),
    '--sub-color': SUBTITLE_HEX[st.color],
    '--sub-bg': CUE_BG[st.background],
    '--sub-shadow': st.background === 'shadow' ? CUE_SHADOW : 'none',
  };
}

/**
 * The properties MpvSurface sets after each load and on every change. ASS files keep their own
 * styling except the size (`sub-ass-override=scale`); text formats take all of it.
 */
export function mpvSubtitleProperties(st: SubtitleStyle): { name: string; value: string | number }[] {
  const boxed = st.background !== 'shadow';
  return [
    { name: 'sub-ass-override', value: 'scale' },
    { name: 'sub-scale', value: SUBTITLE_SCALE[st.size] },
    { name: 'sub-color', value: SUBTITLE_HEX[st.color] },
    // A box spans the whole line (background-box); shadow-only keeps mpv's outline and adds a drop shadow.
    { name: 'sub-border-style', value: boxed ? 'background-box' : 'outline-and-shadow' },
    { name: 'sub-back-color', value: MPV_BACK[st.background] },
    { name: 'sub-border-size', value: boxed ? 3 : 2 },
    { name: 'sub-shadow-offset', value: boxed ? 0 : 1 },
    // mpv: 100 is the bottom of the picture, smaller is higher.
    { name: 'sub-pos', value: 100 - clampSubtitlePosition(st.position) },
  ];
}

/**
 * The `line` (percent of the picture height, `snapToLines = false`, `lineAlign = 'end'`) where a
 * cue's bottom edge sits: 90 % at position 0, one percent higher per step, as mpv's `sub-pos`.
 */
export function cueLine(position: number): number {
  return 90 - clampSubtitlePosition(position);
}
