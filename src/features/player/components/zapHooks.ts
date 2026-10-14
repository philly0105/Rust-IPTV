import { useEffect, useRef } from 'react';

import { usePlayerStore } from '../store';
import { usePlayerSettings } from '../useSettings';
import { holdZapBanner, useZapBanner, zapBannerApplies, zapHoldGeneration } from '../zapBanner';

/*
 * The zap banner's hooks for the surfaces and the dock, kept apart from `ZapBanner.tsx` so the
 * banner itself can load outside the main chunk.
 */

/**
 * Pointer handlers that hold the banner up while the pointer rests on an element (the channel
 * title, the banner). `active` says whether the element can be hovered at all (drawn, and taking
 * pointer events): no pointerleave comes once it is not, so turning false releases the hold, as
 * does an unmount. A hold dropped by `zapBanner.ts` (hidden, or held too long) is stale, and the
 * next enter holds again.
 */
export function useZapHover(active = true): { onPointerEnter(): void; onPointerLeave(): void } {
  /** The hold generation this element's hold was taken in; null while it holds nothing. */
  const held = useRef<number | null>(null);
  useEffect(() => {
    if (!active) releaseHold(held);
  }, [active]);
  useEffect(() => () => releaseHold(held), []);
  return {
    onPointerEnter: () => {
      if (!active || held.current === zapHoldGeneration()) return;
      held.current = holdZapBanner(true);
    },
    onPointerLeave: () => releaseHold(held),
  };
}

function releaseHold(held: { current: number | null }): void {
  const gen = held.current;
  held.current = null;
  if (gen !== null) holdZapBanner(false, gen);
}

/** The banner is up for what plays now (the surfaces dim the title bar under it). */
export function useZapBannerShown(): boolean {
  const visible = useZapBanner((s) => s.visible);
  const status = usePlayerStore((s) => s.status);
  usePlayerStore((s) => s.source);
  usePlayerStore((s) => s.mode);
  usePlayerSettings();
  return visible && status !== 'error' && zapBannerApplies();
}
