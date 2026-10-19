/**
 * The guide's time scale (IPTVnator parity): steps of px per 30-minute slot, picked with the
 * toolbar's zoom buttons or Ctrl+scroll over the grid, and kept in localStorage.
 */

/** Px per 30-minute slot at each step; the middle one is the guide's default (GRID_SLOT_PX). */
export const GUIDE_ZOOM_SLOT_PX = [75, 110, 150, 225, 300] as const;
export const GUIDE_ZOOM_DEFAULT = 2;

const ZOOM_KEY = 'tsrust.guideZoom';

/** A step index kept inside the scale. */
export function clampGuideZoom(step: number): number {
  return Math.max(0, Math.min(GUIDE_ZOOM_SLOT_PX.length - 1, Math.round(step)));
}

/** The step saved last, else the default. */
export function storedGuideZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_KEY);
    const step = raw === null ? NaN : Number(raw);
    return Number.isFinite(step) ? clampGuideZoom(step) : GUIDE_ZOOM_DEFAULT;
  } catch {
    return GUIDE_ZOOM_DEFAULT;
  }
}

export function storeGuideZoom(step: number): void {
  try {
    localStorage.setItem(ZOOM_KEY, String(clampGuideZoom(step)));
  } catch {
    // storage blocked: the step lasts for this visit
  }
}
