import { useScaledPx } from '@/ui';

import { NARROW_COVER_WIDTH, useCoverWidth } from './useCoverWidth';
import { useSettings } from './queries';

/**
 * Card width of a poster rail, in px at the current UI scale (VL-page-rhythm): the cover-size
 * setting drives rails as it drives the grids, so one setting sizes every poster. A rail card is
 * a little narrower than a grid column's minimum (164 -> 150 at medium), since a rail shows a
 * slice and a peek of the next card rather than filling a row. On a phone-width screen the rail
 * keeps about three cards and a peek (108 px) instead of the grid's 80 px columns.
 */
export function useRailCardWidth(): number {
  const cover = useCoverWidth(useSettings().coverSize);
  const base = cover <= NARROW_COVER_WIDTH ? 108 : Math.round(cover * 0.915);
  // Card widths count as spacing (the grid scales its columns the same way), so compact density narrows them too.
  return useScaledPx(base, true);
}
