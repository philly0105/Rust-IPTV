/**
 * Picture controls of the player menu: aspect ratio, zoom or crop, and deinterlacing.
 *
 * The choice is global, not per channel: it is a property of the screen and of how the person
 * likes to watch, so it carries from channel to channel and across restarts (localStorage),
 * until Original / None set it back. The built-in player applies it with CSS (`pictureStyle`);
 * embedded mpv gets the matching properties (`mpvPictureProperties`, sent by `mpvExtras.ts`).
 * Deinterlacing exists only in mpv: browsers decide that themselves.
 */

import type { CSSProperties } from 'react';
import { create } from 'zustand';

export type PictureAspect = 'auto' | '16:9' | '4:3' | 'fill';
/** `crop` fills the frame and cuts the edges; the numbers are zoom percentages. */
export type PictureZoom = 'none' | 'crop' | '110' | '125' | '150';

export const ASPECTS: readonly PictureAspect[] = ['auto', '16:9', '4:3', 'fill'];
export const ZOOMS: readonly PictureZoom[] = ['none', 'crop', '110', '125', '150'];

export interface PictureState {
  aspect: PictureAspect;
  zoom: PictureZoom;
  deinterlace: boolean;
}

export const PICTURE_KEY = 'player.picture';
export const DEFAULT_PICTURE: PictureState = { aspect: 'auto', zoom: 'none', deinterlace: false };

function readStored(): PictureState {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PICTURE_KEY) : null;
    const v = raw ? (JSON.parse(raw) as Partial<PictureState>) : {};
    return {
      aspect: ASPECTS.includes(v.aspect as PictureAspect) ? (v.aspect as PictureAspect) : DEFAULT_PICTURE.aspect,
      zoom: ZOOMS.includes(v.zoom as PictureZoom) ? (v.zoom as PictureZoom) : DEFAULT_PICTURE.zoom,
      deinterlace: v.deinterlace === true,
    };
  } catch {
    return { ...DEFAULT_PICTURE };
  }
}

export const usePictureStore = create<PictureState>()(() => readStored());

export function setPicture(patch: Partial<PictureState>): void {
  usePictureStore.setState(patch);
  try {
    localStorage.setItem(PICTURE_KEY, JSON.stringify(usePictureStore.getState()));
  } catch {
    // storage unavailable: the choice lasts for this session
  }
}

/** Width over height of a forced aspect, or null. */
function forcedRatio(aspect: PictureAspect): [number, number] | null {
  if (aspect === '16:9') return [16, 9];
  if (aspect === '4:3') return [4, 3];
  return null;
}

/** Zoom factor of a preset (1 for none and crop). */
export function zoomScale(zoom: PictureZoom): number {
  return zoom === 'none' || zoom === 'crop' ? 1 : Number(zoom) / 100;
}

/**
 * True when the built-in player's frame must be a size container: a forced aspect sizes the
 * video from the frame's `cqw`/`cqh`.
 */
export function needsSizeContainer(p: PictureState): boolean {
  return forcedRatio(p.aspect) !== null;
}

/**
 * Inline style of the built-in player's `<video>` (undefined for the defaults, which the
 * element's own `object-contain` covers). A forced aspect is the largest box of that shape in the
 * frame, the picture stretched into it (with crop, the smallest box that covers the frame);
 * Stretch fills the frame; crop alone is `object-fit: cover`; zoom scales from the centre. The
 * frame clips what goes past its edges.
 */
export function pictureStyle(p: PictureState): CSSProperties | undefined {
  const ratio = forcedRatio(p.aspect);
  const scale = zoomScale(p.zoom);
  const style: CSSProperties = {};
  if (ratio) {
    const [w, h] = ratio;
    const fit = p.zoom === 'crop' ? 'max' : 'min';
    Object.assign(style, {
      position: 'absolute',
      inset: 0,
      margin: 'auto',
      width: `${fit}(100cqw, 100cqh * ${w} / ${h})`,
      height: `${fit}(100cqh, 100cqw * ${h} / ${w})`,
      maxWidth: 'none',
      maxHeight: 'none',
      objectFit: 'fill',
    });
  } else if (p.aspect === 'fill') {
    style.objectFit = 'fill';
  } else if (p.zoom === 'crop') {
    style.objectFit = 'cover';
  }
  if (scale !== 1) style.transform = `scale(${scale})`;
  return Object.keys(style).length > 0 ? style : undefined;
}

/**
 * The mpv properties for a picture state, all of them, so a change back to the defaults resets
 * mpv too: `video-aspect-override` (-1 is the stream's own), `keepaspect` (off stretches to the
 * window), `panscan` (1 crops to fill), `video-zoom` (log2 of the factor) and `deinterlace`.
 */
export function mpvPictureProperties(p: PictureState): { name: string; value: string | number }[] {
  const ratio = forcedRatio(p.aspect);
  return [
    { name: 'video-aspect-override', value: ratio ? `${ratio[0]}:${ratio[1]}` : '-1' },
    { name: 'keepaspect', value: p.aspect === 'fill' ? 'no' : 'yes' },
    { name: 'panscan', value: p.zoom === 'crop' ? 1 : 0 },
    { name: 'video-zoom', value: Math.log2(zoomScale(p.zoom)) },
    { name: 'deinterlace', value: p.deinterlace ? 'yes' : 'no' },
  ];
}
