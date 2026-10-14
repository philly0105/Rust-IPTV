/**
 * UI scale and density as seen by components (C1). The shell's theme provider
 * writes here whenever it applies html[data-density] and --ui-scale, so
 * components that size things in JS (virtualised rows, measured grids) can
 * follow the same scale the stylesheet uses. Everything rem-based or built on
 * the Tailwind spacing scale follows on its own; only px literals need this.
 */

import { create } from 'zustand';

import type { Density } from '@/api/types';

/** Tailwind spacing multiplier per density; mirrors `--spacing` in tokens.css. */
export const DENSITY_FACTOR: Record<Density, number> = {
  comfortable: 1,
  compact: 0.875,
};

export const UI_SCALE_DEFAULT = 1;

interface ScaleState {
  uiScale: number;
  density: Density;
}

export const useScaleStore = create<ScaleState>(() => ({ uiScale: UI_SCALE_DEFAULT, density: 'comfortable' }));

/** Called by the theme provider; components read through the hooks below. */
export function setUiScaleState(uiScale: number, density: Density): void {
  const s = useScaleStore.getState();
  if (s.uiScale === uiScale && s.density === density) return;
  useScaleStore.setState({ uiScale, density });
}

/** The active UI scale (1 = 100 %). */
export function useUiScale(): number {
  return useScaleStore((s) => s.uiScale);
}

/** The active density. */
export function useDensity(): Density {
  return useScaleStore((s) => s.density);
}

/**
 * A px length as the stylesheet renders it now. `spacing: true` also applies
 * the density factor, for lengths that stand in for Tailwind spacing (gaps,
 * padding, card widths); leave it off for lengths that hold text.
 */
export function scalePx(px: number, uiScale: number, density: Density, spacing = false): number {
  const factor = spacing ? DENSITY_FACTOR[density] : 1;
  return Math.round(px * uiScale * factor);
}

/** Hook form of {@link scalePx}. */
export function useScaledPx(px: number, spacing = false): number {
  const uiScale = useUiScale();
  const density = useDensity();
  return scalePx(px, uiScale, density, spacing);
}
