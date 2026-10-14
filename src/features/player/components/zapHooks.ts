import { useEffect, useRef } from 'react';

import { usePlayerStore } from '../store';
import { usePlayerSettings } from '../useSettings';
import { holdZapBanner, useZapBanner, zapBannerApplies } from '../zapBanner';

/*
 * The zap banner's hooks for the surfaces and the dock, kept apart from `ZapBanner.tsx` so the
 * banner itself can load outside the main chunk.
 */

/**
 * Pointer handlers that hold the banner up while the pointer rests on an element (the channel
 * title, the banner). An unmount while hovered releases its hold.
 */
export function useZapHover(): { onPointerEnter(): void; onPointerLeave(): void } {
  const inside = useRef(false);
  useEffect(
    () => () => {
      if (inside.current) {
        inside.current = false;
        holdZapBanner(false);
      }
    },
    [],
  );
  return {
    onPointerEnter: () => {
      if (inside.current) return;
      inside.current = true;
      holdZapBanner(true);
    },
    onPointerLeave: () => {
      if (!inside.current) return;
      inside.current = false;
      holdZapBanner(false);
    },
  };
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
